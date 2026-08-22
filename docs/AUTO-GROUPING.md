# Auto-grouping algorithm

**Status.** Steps 2 and 3 — scoring candidate pairings and binding them into
executions — are implemented in `src/core/boros/grouping.ts` and are always on.
Step 1's replay already existed; its *prior block* is not built. Steps 4
(evidence-first seeding) and 8 (hysteresis) are not built.

**One known narrowing.** The never-divide constraint is applied per LEG, but an
execution binds INCREMENTS, and the two coincide only when a leg has exactly one
increment. A leg grown over several days belongs to several executions with
several counterparties, so constraining it at the leg level would force two
strategies onto one card — the netting mistake this exists to undo. Legs with
more than one increment are therefore left alone. Lifting that needs the
constraint pushed down into the allocator.

Three terms are used throughout:

- **Atom** — one trade, or the smallest indivisible remnant of one: a leg
  reference, a size, a rate or price, and a time (which may be a *bound* —
  "at or before" — rather than an instant).
- **Execution** — a set of atoms placed together. Never divided between
  positions.
- **Group** — a set of atoms that becomes one card.

---

## Step 0 — Assertions bind first

The user's membership rows draw against a ledger of how much of each leg is
still unclaimed. Rows carrying an explicit size bind before rows that say "all
of it", so a number the user typed always outranks a blanket claim. Anything
drawn leaves the pool and no later step can reach it.

*Already implemented.*

---

## Step 1 — Break each position into the trades that built it

### Boros, per market

Walk that market's transactions in chain order, maintaining a running position
and a running weighted-average rate, and apply the first rule that matches:

1. **The venue disagrees** — the transaction states an `entryApr` (the average
   entry of the position being reduced), the running position is non-zero, and
   our average differs by more than 1e-6. The history is not the one that built
   this position. Abandon this market.
2. **Position went flat** — discard every open so far and reset. What came
   before is closed history.
3. **Position flipped side** — discard every open and start one new open at the
   whole new size, at this transaction's rate.
4. **Position grew** — record an open for the increase, at this transaction's
   rate, and fold it into the running average.
5. **Position shrank** — reduce the running size. Leave the average alone; the
   venue does not re-average on a reduce.

Finally scale every surviving open by *live size ÷ total opens*.

Scale rather than drop-oldest, deliberately. A reduce does not re-average the
venue's rate, so the surviving position still carries the blend of all its
opens. Open 100 at 9%, add 200 at 5%, reduce to 200: the venue says 6.33%.
Dropping oldest-first would claim 5%. Scaling leaves the weighted average intact.

**The prior block.** If the chain does not reach back to flat, do not abandon the
market. Treat the position that existed before the oldest visible transaction as
a single atom: its size is that transaction's prior position, and its rate is the
`entryApr` that transaction states — the venue's own blend of everything earlier.
Its time is a bound, not an instant: at or before that transaction. This is only
possible when the oldest visible transaction is a *reduce*, since that is the only
kind that carries `entryApr`; otherwise abandon the market.

### Perp, per symbol

Each fill is an atom. Where fills cannot be read, the whole venue position is one
atom timed at its open — coarse, but honest.

### On abandoning a market or symbol

It contributes exactly one atom, for the whole position, at the blended rate. The
failure is contained: one unexplainable market must never cost us the
decomposition of another.

---

## Step 2 — Score every candidate pairing

Two atoms on the same coin are candidates when their floating exposures oppose
(a Boros long and a perp long cancel), they are different legs, and they are not
already in one execution.

The score is a sum of four penalties, lowest is best:

| Term | Measures | Normalised by |
|---|---|---|
| time | gap between the two times | `TIME_SCALE_SEC` |
| size | relative size difference | the larger of the two |
| rate | relative rate or price difference | the larger magnitude |
| venue | the leg sits at a venue this position has no exposure at | flat penalty |

A time bound ("at or before") makes the time term infinite — a bound is not a
measurement, and must not masquerade as proximity.

**Identity zeroes the score.** Three signals qualify: the two Boros atoms came
from the same on-chain transaction; the two fills carry the same engine order
tag; or both belong to one journal deal. Identity is not a separate mechanism —
it is simply the most improbable coincidence there is.

---

## Step 3 — Bind atoms into executions

Each candidate pair falls into a band by how tight the coincidence is:

| Band | Condition | Reads as |
|---|---|---|
| Certain | identity match | proven |
| Tight | within 5s, sizes within 0.1% | as good as proven |
| Strong | within 60s, sizes within 1% | evidence |
| Weak | within 15 minutes | a guess |
| — | anything looser | not a pairing |

These signals are independent, so they compound. Two unrelated trades landing on
opposite sides of the same coin, at two venues, at matching size, within five
seconds does not happen by accident on a real book — that is what a
cross-exchange hedge *is*.

Take pairs in ascending score. A pair at Strong or better binds: if both atoms
are free, they form a new execution; if one is already in an execution, it joins
that execution provided doing so still reduces net exposure. Weak pairs do not
bind here — they fall through to Step 5.

**An execution is never divided between groups.** This single constraint fixes
today's tearing, where two Boros legs bought in one transaction end up on two
different cards.

**The absence rule.** A band is a claim about what *else* was or was not placed
nearby, so it may only be assigned when the relevant history was fetched
completely — the whole transaction list for a Boros atom, an uncapped fill fetch
for a perp one. Where history is truncated, no pairing may exceed Weak.
Truncation answers a question about absence wrongly, and confidently.

---

## Step 4 — Seed groups from the strongest evidence

Take executions in ascending score. Each becomes a group. Then, still in score
order, absorb any other execution on the same coin when merging the two reduces
the total net floating exposure across venues.

Not perp-first. Today perps always anchor, reasoning that a Boros leg might be a
standalone directional trade. That is a prior, and a sound one where nothing else
is known — but where the Boros pair is evidenced and the perp pairing is only
proximity, it has things backwards.

**Priors decide only where evidence is silent.**

---

## Step 5 — Fit the remainder

Atoms that never bound, and the Weak pairs deferred from Step 3, are assigned to
existing groups greedily by lowest score.

Each group is capped at the exposure it actually has left to hedge at that venue.
An atom is assigned up to that cap and any surplus stays in the pool for the next
group. The cap exists to stop one group taking what another needs — not to
disown size nobody is competing for, so anything left over is carried to Step 6
rather than dropped. A book deliberately holding more Boros than perp must still
report that.

---

## Step 6 — Residuals

Every atom still unassigned becomes a group of one leg, reported unhedged.

Conservation is asserted here: for each venue leg, the sizes across all groups
must sum to what the venue reports.

---

## Step 7 — Label

A group's confidence is the weakest band used to build it. Certain and Tight
read as *measured*; Strong and Weak read as *unconfirmed*. One guess anywhere in
a group's construction and the whole card says so.

---

## Step 8 — Do not reshuffle on a close call

When the new grouping and the previous one score within `SCORE_TIE_BAND` of each
other, keep the previous one. The previous solution is stored per book.

Without this, cards silently rearrange on a 30-second poll whenever two answers
score alike — and every step above can produce ties.

---

## Constants

| Name | Today | Proposed |
|---|---|---|
| `TIME_SCALE_SEC` | 900 | unchanged — the time normaliser |
| `PERP_ENTRY_SYNC_MAX_SEC` | 900 | split into the 5s / 60s / 900s bands |
| `SCORE_TIE_BAND` | 0.15 | unchanged; now also drives Step 8 |
| `QTY_BAND` | 1e-6 | unchanged |
| `HEDGE_BAND` | 0.02 | unchanged |
| time and rate weights | 1, 1 | unchanged |
| size and venue weights | — | new |

---

## Invariants

1. For every venue leg, the sizes across all groups sum to the venue's own — no
   invention, no loss.
2. The same inputs produce the same output.
3. Ids are unique; every size is finite and non-negative.
4. A group's stated confidence never exceeds the weakest band used to build it.
5. A small change in the input does not regroup unrelated positions.

The first three are already covered by the 3,000-case fuzz suite over a
two-maturity book. The last two are new.

---

## Unresolvable by design

Two strategies opened in the same second, in the same venue pair, with no
identity signal on either. There is nothing left to separate them by. The honest
output is one group marked unconfirmed — not an invented split.
