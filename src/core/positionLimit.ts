/** What CrossEx lets one position in a symbol use: `leverage`, at any size up
 * to `maxUsd`. */
export interface PositionLimit {
  leverage: number;
  maxUsd: number;
}

interface RiskLimitTierRow {
  maxRiskLimitValue?: string;
  leverageMax?: string;
}

/**
 * A symbol's position limit, read from its risk-limit tiers: the top leverage,
 * up to the cap of the last tier that still allows it. CrossEx refuses an
 * order past that cap with RISK_LIMIT_EXCEEDED at any leverage, and has no
 * call to raise it, so the lower-leverage tiers past it are never reached.
 * The check counts resting orders and prices the position at mark.
 *
 * Null when any tier is unreadable: a table with a hole would let a large
 * position borrow a small tier's cap.
 */
export function positionLimitOf(rows: readonly RiskLimitTierRow[] | undefined): PositionLimit | null {
  const tiers = (rows ?? []).map((t) => ({ maxUsd: Number(t.maxRiskLimitValue), leverage: Number(t.leverageMax) }));
  if (tiers.length === 0 || tiers.some((t) => !(t.maxUsd > 0) || !(t.leverage > 0))) return null;
  const leverage = Math.max(...tiers.map((t) => t.leverage));
  const maxUsd = Math.max(...tiers.filter((t) => t.leverage === leverage).map((t) => t.maxUsd));
  return { leverage, maxUsd };
}
