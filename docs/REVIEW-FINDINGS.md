# Open review findings (known issues)

An independent multi-agent review of this codebase (2026-07-29) — each finding adversarially
verified by tracing its failure scenario end-to-end through the code — surfaced 27 defects.
The 8 high-severity ones (1 critical, 7 major) were fixed before publication, each with a
regression test pinning its failure scenario. The minor findings below remain open and are
tracked here for follow-up.

A later external audit (2026-07-30) re-confirmed four of them plus one finding this file did
not have — an unauthenticated local API. All five are now **fixed**, and are listed at the
bottom rather than deleted, so the record of what was wrong survives.

None of these is a money-loss path: they are edge-case hardening gaps, misleading operator
messages, over-strict validations, and test-coverage holes. File pointers are given per item;
line numbers are omitted deliberately (they drift).

## Engine & server

- **OPENING's hedge-first gating is weaker than CONVERTING's** (`src/engine/decide.ts`): during
  the backoff after a failed hedge attempt, a resting maker keeps filling (and can be re-placed)
  in OPENING, while CONVERTING in the identical state pauses with "hedge owed first". Bounded by
  the hedge wall (~3 backoff windows before HALT), but strictly weaker than the rule it mirrors.
- **Persistent read errors on a PENDING order never alert** (`src/engine/loop.ts`): the
  read-failure streak/alert covers OPEN orders only. A PENDING order whose venue reads keep
  erroring (revoked key, 5xx storm) freezes its pair silently, with no operator signal — even
  though the order may be live and filling.
- **Leg-A max-market-size check ignores `maxClip`** (`src/engine/create.ts`): the cap compares
  the FULL deal qty, but leg-A convert clips are split to at most `maxClip` — a deliberately
  clipped deal that could never send an over-cap order is rejected at creation. Fail-safe
  direction, but over-strict.
- **Banded clips price off book mid, not the venue reference** (`src/engine/decide.ts`): the
  comment claims the slippage band stays inside the venue's price-limit band, but `refPrice()` is
  (bid+ask)/2 of the public book. When mid dislocates from the venue's mark by more than the
  band, every clip draws a hard price-limit reject and the close stops at the reject budget —
  exactly during the volatile conditions the band exists for. Honest stop + alert, no silent loss.
- **A sub-tick explicit re-peg BUY snaps to the string `"0"`** (`src/server/routes/deals.ts`):
  the raw input is validated `> 0`, then the directional snap floors it to `"0"`, which is truthy
  and gets pinned as the fixed intent price — burning the reject budget with a wrong recorded
  cause. The snapped output should be re-validated.
- **The finish reason always blames "below B's lot"** (`src/engine/decide.ts`): an unhedged
  terminal residual is attributed to the lot even when it is whole lots blocked by
  minSize/minNotional — misleading in the post-mortem report.

## Installers

- **`Protect-Directory`'s graceful fallback is unreachable** (`install.ps1`): under PS 5.1 with
  `$ErrorActionPreference='Stop'`, the `2>&1` on icacls turns stderr into a terminating error
  before the exit-code check that was meant to degrade gracefully.
- **`Install-Node` deletes the in-use runtime before the service is stopped** (`install.ps1`):
  on an update, the old `node/` folder is removed while the previous server may still be running
  from it — violating the stop-before-delete ordering the script itself documents. Windows file
  locking makes this fail loudly rather than dangerously, but the ordering should match the docs.
- **The keepalive repetition may never tick** (`install.ps1`): the every-minute repetition is
  grafted onto an `-AtLogOn` trigger with no `StartBoundary`; when the task is registered after
  logon and started by hand, the repetition window never opens, leaving only the in-task
  supervisor loop as keepalive.

## Web & test coverage

- **The deal-view re-peg snap is nearest and side-unaware** (`web/src/trade/DealModal.tsx`):
  `snapToTick` can round a re-peg price onto the touch; the engine then pins that price
  (`pricePolicy 'fixed'`) into a post-only reject loop. Should use the directional
  `formatRestPrice` like the tickets do.
- **The server-side resting-price wiring is unpinned** (`tests/unit/format.test.ts` et al.):
  the directional-snap helper is tested, but reverting its three call sites (actions, engine
  create, venue gate) back to the nearest snap still passes the full suite — no test drives the
  wiring end-to-end.
- **The slippage band has no close-pair test** (`tests/unit/engine-loop.test.ts`): the banded
  clip is pinned for single-leg closes only; the close-PAIR path is untested, and one older test
  comment still describes the pre-fix (unpriced clip) semantics.
- **The hand-placed-cancel test proves nothing** (`tests/server/orders.test.ts`): "still cancels
  a hand-placed order while a deal is running" runs with no deal present, so it cannot detect a
  guard that wrongly blocks hand-placed orders during a live deal.
- **The Windows ACL branch has zero coverage** (`tests/unit/secret-file.test.ts`): the tests
  exercise only the POSIX chmod path; the icacls branch — the actual substance of the Windows
  hardening — is untested on every platform.

---

## Fixed since (2026-07-30 security pass)

- **Hand-cancel could permanently abandon a live deal** — the guard matched only the venue
  order id, so cancelling by the engine's client text (which the venue accepts, and which
  rides in `/api/deals`) or during the window where our row's venue id is still NULL landed
  a CANCELLED the engine read as a deliberate user STOP. The lookup now matches either
  identifier, and while any live order awaits confirmation the route asks the venue whose
  order an id is before letting a cancel through.
- **The local API had no authentication** — any process, under any account on the machine,
  could POST a deal. Every `/api` route except health now requires a per-install token
  stored 0600 beside the `.env`; the server injects it into the page it serves, so the
  bookmarked URL still just works.
- **The Windows ACL probe was vacuous and destructive** — `fs.accessSync` never evaluates
  the DACL, while any read-only file in the config dir triggered a recursive `icacls /reset`
  that reverted the protection on every boot. It now probes by really opening files, skips
  read-only-attributed entries, resets scoped to the target, and reports.
- **A source checkout got chmod 0700'ed on every boot** — the `.env`'s parent is the repo
  root in a checkout. The parent is now hardened only when an installer chose that directory.
- **The bash installers killed by argv match alone** — an editor or `tail` holding the server
  path was SIGKILLed, and a relative-args server was missed. They now confirm by the
  process's executable and sweep the private runtime, mirroring the Windows scripts.
- **Leverage upper bounds failed open on an empty risk-limits reply** — tierless
  data was converted to 0 and cached for 10 minutes, and both leverage write
  paths treated that 0 as permission to skip the maximum. Unknown caps now stay
  absent and block writes before deal preflight; reads still report an honest
  unknown maximum, and venue-clamped confirmations abort and roll back.
