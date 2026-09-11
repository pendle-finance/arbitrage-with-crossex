/**
 * Run configuration for the GATED LIVE TRADE SUITE (tests/live).
 *
 * ⚠️ Everything in this directory places REAL orders with REAL money when run via
 * `yarn test:live`. This module holds the per-run identity (runId/TAG), the sizing
 * knobs, the HARD notional ceiling, and the cumulative budget tracker that every
 * order placement must pass through.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACK_SENTENCE = 'I understand real orders will be placed with real money';

/** Absolute paths (tests may run from any cwd; tsx/vitest both support import.meta.url). */
export const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(LIVE_DIR, '..', '..');
export const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'gate');

/** One identity per process: order texts, basket ids, journal dir and the state file
 * are all derived from it so a leftover order is attributable to exactly one run. */
export const runId = Date.now().toString(36);

/** Order-text/tag prefix. MUST fit the execute route's tag regex [a-z0-9-_]{1,16}:
 * 'lt' + base36 ms timestamp = 10 chars of [a-z0-9]. */
export const TAG = `lt${runId}`;
if (!/^[a-z0-9\-_]{1,16}$/.test(TAG)) {
  throw new Error(`internal error: TAG "${TAG}" does not fit the execute tag regex`);
}

/** Per-order target notional in USDT. */
export const NOTIONAL = Number(process.env.LIVE_TRADE_NOTIONAL ?? '20');

/** HARD ceiling — never trade if the configured notional exceeds this. Constant on
 * purpose: no env var can raise it. */
export const HARD_NOTIONAL_CEILING_USDT = 100;


/** Raw-payload recording default ON; set LIVE_TRADE_RECORD_FIXTURES=0 to disable. */
export const RECORD_FIXTURES = process.env.LIVE_TRADE_RECORD_FIXTURES !== '0';

/**
 * Cumulative budget: Σ exposure-opening notional over the whole run must stay
 * ≤ 5×NOTIONAL, asserted BEFORE every order leaves. Reduce-only closes charge 0
 * (they shrink exposure). Far post-only limits also charge 0 — by construction they
 * are 20% away from the market, post-only, and canceled within their own scenario —
 * but they still pass through this gate (and the per-order ceiling) before sending.
 */
class BudgetTracker {
  private opened = 0;

  get openedNotional(): number {
    return this.opened;
  }

  /** Call before EVERY order/basket send. `chargeUsd` = Σ est. notional of the
   * exposure-opening actions about to be sent (0 for closes / far-POC probes). */
  beforeOrder(chargeUsd: number, label: string): void {
    if (!Number.isFinite(chargeUsd) || chargeUsd < 0) {
      throw new Error(`[budget] non-finite charge for ${label}: ${chargeUsd}`);
    }
    if (chargeUsd > HARD_NOTIONAL_CEILING_USDT) {
      throw new Error(
        `[budget] single order ${label} (~$${chargeUsd.toFixed(2)}) exceeds the hard $${HARD_NOTIONAL_CEILING_USDT} ceiling — aborting`,
      );
    }
    const projected = this.opened + chargeUsd;
    const cap = 5 * NOTIONAL;
    if (projected > cap + 1e-9) {
      throw new Error(
        `[budget] ${label} would take cumulative opened notional to $${projected.toFixed(2)} > 5×notional ($${cap.toFixed(2)}) — aborting before the order is sent`,
      );
    }
    this.opened = projected;
  }
}

export const budget = new BudgetTracker();
