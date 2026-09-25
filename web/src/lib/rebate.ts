/**
 * The ONE place the CrossEx settlement-fee rebate turns its config into forward
 * math. The backend owns every REALIZED amount, so the only client-side rate
 * arithmetic is the FORWARD discount on the settlement fee (opportunity APR,
 * current fixed APR). Two modes:
 *   relative — the account pays `settlementFeePercentage` of the fee;
 *   absolute — the fee is capped at `settlementFeePercentage` (an APR on notional).
 * A rebate applies to a market only while it is `active` and the market is in its
 * `marketIds` (null = all markets).
 */
import type { Rebate } from '../api/types';

/** Does this rebate discount `marketId` right now? Active window + market filter. */
export function rebateAppliesTo(rebate: Rebate | null | undefined, marketId: number): boolean {
  if (!rebate || !rebate.active) return false;
  if (rebate.marketIds && !rebate.marketIds.includes(marketId)) return false;
  return true;
}

/** The settlement-fee APR the account effectively pays on `marketId` after its
 * rebate: relative → `settleFeeApr × pct`; absolute → `min(settleFeeApr, pct)`.
 * Unchanged when the rebate is inactive or the market is out of scope. */
export function rebatedSettleApr(
  settleFeeApr: number,
  rebate: Rebate | null | undefined,
  marketId: number,
): number {
  if (!rebateAppliesTo(rebate, marketId)) return settleFeeApr;
  const r = rebate as Rebate;
  return r.mode === 'absolute'
    ? Math.min(settleFeeApr, r.settlementFeePercentage)
    : settleFeeApr * r.settlementFeePercentage;
}

/** Renders a fraction as a "N%" label (drops a trailing ".0"), rounding away
 * floating-point noise like 0.19999999 before deciding on decimals. */
function pctLabel(fraction: number): string {
  const pct = Math.round(fraction * 1e6) / 1e4;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** The chip label for the opportunity card: relative → "20% fee rebate";
 * absolute → "Fee capped at 5%". */
export function rebateChipLabel(rebate: Rebate): string {
  if (rebate.mode === 'absolute') return `Fee capped at ${pctLabel(rebate.settlementFeePercentage)}`;
  const rebated = rebate.rebateBps != null ? rebate.rebateBps / 1e4 : 1 - rebate.settlementFeePercentage;
  return `${pctLabel(rebated)} fee rebate`;
}
