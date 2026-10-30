/** What the terminal lets one position in a symbol use: `leverage`, at any
 * size up to `maxUsd`. */
export interface PositionLimit {
  leverage: number;
  maxUsd: number;
}

/** The share of the venue's cap the terminal fills. The terminal prices a
 * position at mid or at the order price; the venue checks it at mark, and an
 * order sized at the exact cap can land over it. */
const CAP_HEADROOM = 0.98;

/** How the copy names `maxUsd`. Only Gate is proven to refuse past the cap;
 * the other venues keep it because no test has shown they do not. */
export const LIMIT_NOTE = '2% under the CrossEx risk-limit cap';

interface RiskLimitTierRow {
  maxRiskLimitValue?: string;
  leverageMax?: string;
}

/**
 * A symbol's position limit, read from its risk-limit tiers: the top leverage,
 * up to the cap of the last tier that still allows it. On Gate symbols,
 * CrossEx refuses an order past that cap with RISK_LIMIT_EXCEEDED at any
 * leverage, and has no call to raise it, so the lower-leverage tiers past it
 * are never reached. The check counts resting orders and prices the position
 * at mark. `maxUsd` keeps CAP_HEADROOM under that cap.
 *
 * Null when any tier is unreadable: a table with a hole would let a large
 * position borrow a small tier's cap.
 */
export function positionLimitOf(rows: readonly RiskLimitTierRow[] | undefined): PositionLimit | null {
  const tiers = (rows ?? []).map((t) => ({ maxUsd: Number(t.maxRiskLimitValue), leverage: Number(t.leverageMax) }));
  if (tiers.length === 0 || tiers.some((t) => !(t.maxUsd > 0) || !(t.leverage > 0))) return null;
  const leverage = Math.max(...tiers.map((t) => t.leverage));
  const cap = Math.max(...tiers.filter((t) => t.leverage === leverage).map((t) => t.maxUsd));
  return { leverage, maxUsd: cap * CAP_HEADROOM };
}

/**
 * True when an order takes a position past `maxUsd` and makes it larger. A
 * reduce is never refused: it lowers what the venue checks, even when the
 * position already sits above the cap.
 */
export function breaksLimit(beforeUsd: number, afterUsd: number, limit: PositionLimit): boolean {
  return afterUsd > limit.maxUsd && afterUsd > beforeUsd;
}
