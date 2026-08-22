# The Maker+Hedge Execution Flow — one loop, one ledger, one writer

Every trade the app makes is a **deal**: converge leg A (the acquire leg) to a target quantity while
keeping leg B (the hedge) matched to A's fills. The maker+hedge pair (rest a post-only maker, auto-hedge
each fill at market) is the headline shape; both-market pairs, single opens, and reduce-only closes are
the same machine with some legs disabled.

The design goal is that correctness is *straightforward to reason about*: **level-triggered convergence
over durable state**, so crash recovery, user commands, venue weirdness, and normal operation are all the
same code path, and every money invariant is an assertion over one table. It draws on a few well-worn
ideas: the single-writer principle (races impossible by construction, not by care), the transactional
outbox (intent committed before the wire call), event-sourced ledgers, Kubernetes-style level-triggering
(correctness never depends on catching an event), SQLite WAL as a durable substrate, and deterministic
simulation as the verification method.

## Thesis

One SQLite file holds the **intent** (what the user wants), the **order registry** (every order we ever
asked for, written *before* the wire call), and observed venue facts. One single-writer reconcile loop —
the only code allowed to mutate state or call venue-mutating endpoints — reads intent + registry + venue
each tick, computes **the single next action**, performs it idempotently, commits, sleeps, repeats. Wire
ambiguity is resolved by probing (never by resending), and **nothing is ever placed while anything is
unresolved**.

## Storage — the SQLite file IS the system of record

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;   -- fsync per commit: power-loss safe
PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
PRAGMA locking_mode=EXCLUSIVE;                       -- a second process cannot open for write
-- all write txns: BEGIN IMMEDIATE

CREATE TABLE pair (            -- THE intent. User commands edit THIS ROW only.
  id TEXT PRIMARY KEY,                    -- short id, minted once
  mode TEXT CHECK (mode IN ('OPENING','CONVERTING','STOPPING','HALTED','DONE')),
  a_contract TEXT, a_side TEXT,           -- leg A = maker / acquire leg
  b_contract TEXT, b_side TEXT,           -- leg B = hedge leg (null for single-leg deals)
  target_qty TEXT,                        -- decimal strings everywhere; never float
  limit_price TEXT, price_policy TEXT,    -- re-peg = UPDATE limit_price
  deadline_at INTEGER,                    -- maker timeout: level check now() >= deadline_at
  maker_not_before INTEGER, hedge_not_before INTEGER,   -- anti-flap backoff
  poc_rejects INTEGER, hedge_reject_streak INTEGER,
  hedge_band_bp INTEGER,                 -- normal hedge LIMIT-IOC cap; null = 50bp default
  halt_reason TEXT, report_json TEXT,     -- honest terminal report (pure projection)
  created_at INTEGER
);

CREATE TABLE orders (          -- write-ahead registry: row EXISTS BEFORE the wire call
  pair_id TEXT REFERENCES pair(id), leg TEXT CHECK (leg IN ('A','B')),
  seq INTEGER,                            -- per (pair,leg) monotone; NEVER reused
  client_id TEXT UNIQUE,                  -- deterministic 't'||hash(pair)||LEG||seq (alphanumeric, ≤28B)
  kind TEXT, side TEXT, qty TEXT, price TEXT, tif TEXT,  -- tif 'poc' | 'ioc'
  state TEXT CHECK (state IN ('PENDING','OPEN','CLOSED','DEAD')),
  venue_order_id TEXT,                    -- persisted the INSTANT any response reveals it
  cum_qty TEXT DEFAULT '0',               -- venue cumulative fill; monotone (guard + alert on shrink)
  avg_fill_price TEXT DEFAULT '0',        -- venue avg execution price (executed_avg_price)
  close_reason TEXT, cancel_requested INTEGER,   -- OUR cancel vs the user's venue-cancel
  quarantined_status TEXT,                -- unknown raw status string (open-world decoder)
  created_at INTEGER, resolved_at INTEGER,
  PRIMARY KEY (pair_id, leg, seq)
);

CREATE TABLE alerts (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, pair_id TEXT,
                     message TEXT, ack INTEGER DEFAULT 0);   -- alerts are STATE (levels), re-rendered
```

**Source-of-truth split:** the venue is truth for *what happened on the venue* (statuses, cumulative
fills, average fill prices); the DB is truth for *intent* and for *which orders we ever asked for*.
Everything else — unhedged, remaining, dust, progress, the terminal report — is a **projection**: a pure
fold recomputed from scratch every tick, never stored authoritatively, so it can never go stale or be
double-counted.

## Concurrency — races impossible by construction

1. **One process.** `locking_mode=EXCLUSIVE` — a second (or dev) process fails at open, before it can
   touch the venue. This doubles as the single-instance guard.
2. **One writer.** The reconcile loop is a single async function on a `setTimeout` *chain* (the next tick
   is scheduled only after the current one completes — overlap is impossible, not just avoided). It is the
   only code in the program that calls venue-mutating endpoints.
3. **Commands mutate only the `pair` intent row** (tiny UPDATE transactions); they never touch the venue
   or `orders`. Commands are **levels, not events**: pressing convert twice = pressing it once; "re-peg
   while a fill lands while a cancel is in flight" is not an interleaving to enumerate — it is just the
   state the next tick reads.
4. **At most ONE wire mutation per tick** (one create or one cancel, program-wide), and **nothing is
   placed while ANY order of the pair is PENDING or quarantined** (the freeze rule). So only one in-flight
   submission ever exists, and a reviewer reasons about exactly one outstanding side effect at all times.

## State machines

**Pair modes:**

```
OPENING ──deadline / convert-now──► CONVERTING ──residual done──► DONE
OPENING ──user stop / venue-cancel-not-ours──► STOPPING ──settled──► DONE
OPENING|CONVERTING ──hedge_reject_streak ≥ N──► HALTED ──user stop/resume──► STOPPING
OPENING ──target filled & hedged──► DONE
```

- **OPENING** — one live POC maker for `(target − A_reserved)` at `limit_price`; hedge fills with a
  marketable LIMIT IOC capped at the configured fresh-book band.
- **CONVERTING** — maker canceled; A residual completed via taker IOC clips; hedge everything A filled.
  (Timeout and manual convert are the same mode — one code path.)
- **STOPPING** — maker canceled; no new A exposure; drain what filled, widening the hedge band
  deterministically; finish honestly partial.
- **HALTED** — hedge hit a persistent wall; maker canceled, A never auto-completes, but risk-reducing hedge
  retries continue through the same drain ladder. Terminal-until-human after the exposure is neutralized.
- **DONE** — terminal; `report_json` is a pure projection {aFilled, bFilled, unhedged dust, per-leg
  average fill price, reason}.

**Order states:** `PENDING → OPEN → CLOSED`, and `PENDING → DEAD` (definite reject / proven-never-existed).
Deliberately absent: PENDING_CANCEL, SUBMITTING, RETRYING. **Cancel needs no state:** it is fired
idempotently ("not found / finished" = success), flagged (`cancel_requested`), and its *effect* is
observed — the loop keeps reading until the venue reports terminal with a final `cum_qty`, and fills that
raced the cancel are captured automatically (hedge to final CumQty). An unknown status string never gets a
state: the order keeps its state, `quarantined_status` records the raw string, an alert is raised, and the
freeze rule stops all new risk — never guess terminal/non-terminal.

## Order-submission protocol (the heart)

**Deterministic client IDs** `t<hash(pairId)><LEG><seq>` — allocated by the registry INSERT itself,
derivable from durable state alone, never reused, alphanumeric-only (Gate enforces no text uniqueness and
accepts only letters/digits; reuse would destroy resolvability).

**Placement = write-ahead intent:**

```
BEGIN IMMEDIATE: INSERT orders(state='PENDING', qty, client_id...); COMMIT   -- fsynced reservation
wire: createOrder(text=client_id)                                            -- strictly AFTER commit
outcome (three-way, never two-way):
  definite success         → OPEN (persist venue_order_id IMMEDIATELY)
  definite business reject  → DEAD  (ALLOWLISTED venue labels only: post-only-would-cross,
                             insufficient margin, bad size, …; anything else is NOT definite)
  anything else (timeout, conn reset, ANY 5xx, unmatched label) → stays PENDING = in doubt
```

Unknown-shaped errors default to *in doubt*, not *rejected* (the venue's own doctrine: an HTTP 5xx status
is UNKNOWN and could have been a success) — and the freeze rule means an in-doubt order blocks all new
placement on the pair.

**Resolution ladder** (top of every tick, for every PENDING order):

1. GET by `venue_order_id` if known, else GET by client text (must be prompt — Gate's text lookup dies
   ~60s post-terminal; the ~1s tick satisfies this in normal operation).
2. A failed read resolves nothing → stay PENDING.
3. Found → adopt `venue_order_id` + state (unknown status string → quarantine + alert).
4. Authoritative not-found → if young, stay PENDING (the create may be in flight); else sweep
   **symbol-filtered, time-bounded (`from = created_at`), paginated** history until the window is
   *provably covered*: covered-and-absent → DEAD; coverage exhausted → stay PENDING + alert, human
   resolves. **Absence of evidence ≠ evidence of absence.**

**Crash windows** are exhaustive: before COMMIT → no row, nothing sent (wire is strictly after commit);
after COMMIT, anywhere → a PENDING row exists and the ladder settles it. There is no third case. There is
no dead-man's switch (Gate CrossEx has none); the unhedged-during-downtime window is bounded by the
service's auto-restart and reconciled by the same first tick.

## The reconcile loop

**Quantity accounting is cumulative, not event-based.** Hedging is driven by per-order `cum_qty` from
venue reads (monotone; a shrink alerts as corruption). Re-reading after a crash yields the same number —
replay-proof by construction.

**Reservation accounting (the no-double-spend spine):**

```
reserved(o) = qty      if state ∈ {PENDING, OPEN}    -- in-doubt counts FULL (pessimism → under-hedge only)
            = cum_qty  if CLOSED                       -- final CumQty
            = 0        if DEAD
A_reserved, A_filled, B_reserved, B_filled = folds over orders
unhedged  = A_filled − B_reserved                      -- what we may still hedge
residualA = target   − A_reserved                      -- what we may still acquire
```

Every new order's size is computed from these projections and committed as a PENDING reservation *before*
the wire call, atomically, by the single writer. That sentence is the whole no-double-hedge /
no-double-buy argument.

**The tick (~1s):**

```
OBSERVE: resolve all PENDING (ladder) → re-read OPEN orders (cum_qty monotone merge, capture avg fill)
PROJECT: pure fold → {A_filled, A_reserved, B_filled, B_reserved, unhedged, residualA, dust,
                      makerOrder, anyPending, anyQuarantined}
DECIDE (pure function → ONE action):
  if mode=DONE → idle;  if anyPending or anyQuarantined → idle (FREEZE)
  level mode-edits: deadline passed → CONVERTING;  maker CLOSED+cancelled+!cancel_requested → STOPPING
    (venue cancel = user STOP); acquiring mode + hedge_reject_streak ≥ N → HALTED (cancel maker)
  PRIORITY 1 in every mode: unhedged ≥ lotB && past backoff:
    fresh sane book midpoint → place hedge LIMIT IOC floorLot(unhedged) @ midpoint ± hedge_band_bp
    OPENING/CONVERTING: missing/crossed/>5%-wide book or whiff/reject → wall; never place blind
    STOPPING/HALTED: band = min(base·2^max(0, streak−3), 300bp);
                     at streak 6 lift the cap with a persistent error alert and MARKET only already-naked qty
  OPENING:    maker not OPEN → place POC (target − A_reserved) @ touch (after poc backoff);
              maker price ≠ intent → cancel (re-peg = intent edit + converge)
  CONVERTING: maker OPEN → cancel; else residualA ≥ lotA && unhedged < lotB
              → taker IOC min(residualA, MAX_CLIP)     -- hedge-first gating + clip caps exposure
  STOPPING:   maker OPEN → cancel; else finishIfSettled
  HALTED:     idle after the priority hedge branch (never acquire)
ACT: perform the one action (place = write-ahead protocol; cancel = idempotent + observed)
schedule next tick (setTimeout chain)
```

Post-only rejects (create-time or accept-then-insta-cancel) need no special path: they collapse to "maker
not OPEN" next tick → requote at the fresh touch after backoff, bounded by a `poc_rejects` budget →
STOPPING. Convert idempotency needs no memory: taker size is recomputed each tick as `target − A_reserved`,
gated on the maker being CLOSED; a committed PENDING clip reserves its full size, so replay cannot buy
twice.

## User commands (all = one-row intent UPDATEs; levels)

| Command | Effect | Loop behavior |
|---|---|---|
| Convert now | `mode='CONVERTING'` | cancel maker → final cum → clips + hedges → DONE |
| Re-peg | `limit_price = fresh touch` | live maker price ≠ intent → cancel → re-place remainder (fresh seq/ID) |
| Stop | `mode='STOPPING'` | cancel maker, hedge fills, honest partial DONE |
| Venue-UI cancel *(observation)* | none | maker CLOSED+cancelled without `cancel_requested` → STOPPING (never requote) |
| Resume after HALT | `mode='STOPPING'` | drain hedge backlog, finish honestly |

There is no re-peg protocol to be "mid-way through": a user's venue cancel while a re-peg converges is just
"maker CLOSED, not by us" → STOPPING wins, because re-placement only happens in OPENING and the STOP
mode-edit is checked first.

## Recovery = the loop (no recovery module)

Startup: open the DB (exclusive lock or exit) → `tick()`. The first tick after a crash is
indistinguishable from any tick: PENDING rows resolve via the ladder; OPEN orders' cum catches up (missed
increments were never "events" to lose); a deadline passed during downtime fires as a level check; a maker
canceled during downtime is observed as CLOSED. Nothing is replayed, no journal folded — no decision ever
depended on witnessing an event, only on current durable state + current venue state.

## Hazard → mechanism

| Hazard | Mechanism |
|---|---|
| Wire ambiguity | Write-ahead PENDING + deterministic ID; three-way classification (allowlist-only definite rejects); probe ladder, never resend; freeze while in doubt |
| Crash anywhere | Decisions read only committed state; reservations commit before the wire; `synchronous=FULL`; first tick = any tick |
| Incremental fills / bounded unhedged time | `unhedged` recomputed each tick from monotone cum; hedge = priority 1 in every mode; bound ≈ tick + one resolution |
| POC reject / insta-cancel | Both collapse to "maker not OPEN" → requote after backoff; `poc_rejects` budget |
| Read failures / finite listings | Failed read resolves nothing; declare-dead needs authoritative not-found ∧ window expiry ∧ **provable listing coverage** |
| User actions | Intent levels; venue cancel detected by `cancel_requested=0` → STOPPING |
| Hedge slippage / broken books | Normal catches are marketable LIMIT IOC at a validated/default 50bp band around a fresh sane midpoint; one-sided, crossed, or >5%-wide books are unavailable |
| Hedge walls | Missing reference, reject, or whiff streak → HALTED in acquiring modes and maker cancel; STOPPING/HALTED widen 50→100→200→300bp, then lift the cap at streak 6 with a persistent error only to flatten already-naked exposure |
| Lots / dust | Floor-only sizing (no round-up path exists); dust = permanent projection + report line |
| Convert idempotency / margin races | Sizes from reservations (replay-safe); taker gated on maker CLOSED; one wire mutation program-wide + hedge-first ⇒ serial margin |
| Double process / power loss | EXCLUSIVE lock; WAL + FULL fsync |
| Unknown status strings | Open-world decoder: quarantine + freeze + alert; never guessed |

## Correctness argument

- **I1 — Never over-hedge (`B_filled ≤ A_filled`), never over-acquire (`A_filled ≤ target`).**
  `B_reserved ≤ A_filled` is inductive: it changes only at single-writer commits — inserting a hedge
  PENDING sized `floorLot(A_filled − B_reserved)` preserves it, and resolutions only *decrease* reserved
  (cum ≤ qty; DEAD → 0); A_filled is monotone. And `B_filled ≤ B_reserved` because the venue cannot fill
  beyond submitted size and every size was reserved pre-wire. The same argument with `(A, target)` gives
  never-buy-twice, under crash, replay, convert, and re-peg alike.
- **I2 — Under-hedge is visible and bounded.** `unhedged` / `dust` are pure projections rendered
  continuously and embedded in the terminal report; alerts are unacked rows, not fire-once events. Healthy
  bound: one tick. A wall halts A-side acquisition, capping exposure at what already filled.
- **I3 — Honest terminals.** DONE requires zero PENDING/quarantined, venue-confirmed final cums, and
  `unhedged < 1 lot`; `report_json` is a fold over the reconciled ledger — it cannot claim more hedged than
  observed or hide dust. HALTED may still name live exposure, and its drain ladder keeps reducing it.

## Verification

Deterministic simulation, FoundationDB/TigerBeetle-style — the design is shaped to make it cheap (clock,
venue, and DB behind interfaces):

1. **Fake venue** with an adversarial script: UNKNOWN outcomes (deliver-but-timeout, timeout-but-deliver),
   POC rejects + accept-then-insta-cancel, partial fills during pending cancel, unknown status strings,
   margin walls, listing truncation.
2. **Crash harness:** abort/restart the loop after *every* commit boundary (the enumerable crash points).
3. **Invariant assertions** run continuously across thousands of seeded episodes: `B_filled ≤ A_filled`
   always; `A_filled ≤ target`; no client_id ever submitted twice; every episode terminates in DONE/HALTED
   with report = venue truth; unhedged age never exceeds bound while healthy. A failing seed reproduces the
   exact run.

Plus unit tests for the pure functions (`decide`, projections, sizing), and a gated live smoke test against
Gate that verifies the venue-behavior assumptions (text-as-orderId GET on CrossEx; POC reject labels).

## Deliberately out of scope / accepted risks

- WebSocket feeds — they would only pre-fill OBSERVE; polling is correctness-complete.
- No dead-man's switch on CrossEx: exposure during downtime is bounded by restart speed, reconciled on the
  first tick.
- Listing-coverage exhaustion after extreme downtime → freeze + human; the honest floor of the
  absence-of-evidence problem.
- A venue that lies (shrinking cum) → the monotonicity guard alerts + freezes; not defended in depth.
- Fees / funding PnL attribution; multi-pair margin optimization (pairs share the one loop, serializing
  margin naturally).
