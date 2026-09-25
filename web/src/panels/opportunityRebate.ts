/**
 * The opportunity, repriced with the account's settlement-fee rebate credited
 * back — a client-side overlay, the same shape as `repriceHeld` so the two
 * compose (both are pure `OpportunityPair → OpportunityPair`). Apply repriceHeld
 * first, then this.
 *
 * Only the FORWARD settlement fee is discounted, PER LEG (the pair has two Boros
 * markets, and the rebate can be scoped to a market set): each leg's credit is
 * `(settleFeeApr − rebatedSettleApr) × N × T`, summed. The credit lowers the cost
 * total and lifts the net fixed APR / profit / APR-on-capital through the server's
 * own identities. `borosSettleRebateUsd` is recorded so the details waterfall can
 * draw the favorable bar and still close.
 */
import type { OpportunityPair, Rebate } from '../api/types';
import { rebatedSettleApr } from '../lib/rebate';

/** Mirrors the server's SECONDS_IN_YEAR (src/core/boros/venue.ts). */
const SECONDS_IN_YEAR = 365 * 24 * 3600;

export function applyRebate(
  pair: OpportunityPair,
  rebate: Rebate | null | undefined,
  notionalUsd: number,
): OpportunityPair {
  const c = pair.costs;
  const years = pair.secondsToMaturity / SECONDS_IN_YEAR;
  const notionalYears = notionalUsd * years;
  if (!rebate || !rebate.active || c.totalUsd === null || !(notionalYears > 0)) return pair;
  // Per-leg: the fee saved on each market, only where the rebate reaches it.
  const legCredit = (leg: OpportunityPair['shortLeg']): number =>
    Math.max(0, leg.settleFeeApr - rebatedSettleApr(leg.settleFeeApr, rebate, leg.marketId)) *
    notionalYears;
  const credit = legCredit(pair.shortLeg) + legCredit(pair.longLeg);
  if (!(credit > 0)) return pair;
  const totalUsd = c.totalUsd - credit;
  const annualizedApr = totalUsd / notionalYears;
  const netFixedApr = pair.execSpreadApr === null ? null : pair.execSpreadApr - annualizedApr;
  const estProfitUsd = netFixedApr === null ? null : netFixedApr * notionalYears;
  const capital = pair.capitalUsd !== null && pair.capitalUsd > 0 ? pair.capitalUsd : null;
  return {
    ...pair,
    costs: { ...c, borosSettleRebateUsd: credit, totalUsd, annualizedApr },
    netFixedApr,
    estProfitUsd,
    netFixedAprOnCapital:
      capital === null || estProfitUsd === null || !(years > 0)
        ? null
        : estProfitUsd / (capital * years),
  };
}
