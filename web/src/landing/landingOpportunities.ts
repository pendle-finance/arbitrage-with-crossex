import { useOpportunities } from '../api/queries';
import type { OpportunityGroup, OpportunityPair } from '../api/types';

/** The one notional every landing surface prices at. $100k is big enough that
 * Boros books aren't dominated by a single maker quote (a $1k card would look
 * amazing and be unrepeatable at real size) and small enough that the "3
 * things you need" pitch stays believable for a first-time visitor. The
 * unconfigured view has no live fee schedule to read from, so a mid VIP tier
 * (vip0 = no volume yet) prices the honest, unfavourable case rather than
 * flattering the headline with a whale's fee tier. */
export const LANDING_NOTIONAL_USD = 100_000;

/** Shared query: the hero number and the opportunities strip below it must
 * always show the SAME ranking, so both read from one hook call (React Query
 * dedupes identical keys — this just keeps the params identical by
 * construction rather than by convention). */
export function useLandingOpportunities() {
  return useOpportunities({
    notionalUsd: LANDING_NOTIONAL_USD,
    borosEntry: 'market',
    entryMode: 'both-market',
    exitMode: 'close',
    feeTier: 'vip0',
  });
}

export interface RankedOpportunity {
  group: OpportunityGroup;
  pair: OpportunityPair;
  aprOnCapital: number;
}

/** Every group whose best pair actually prices a net APR on capital — positive
 * OR negative. Unlike OpportunitiesPanel (a trading tool that only lists
 * things worth executing), the landing page's job is to show the real market:
 * spreads flip negative when the fixed rate you'd pay exceeds the one you'd
 * receive, and hiding that would make the hero lie by omission on a bad day.
 * Groups arrive pre-ranked (net fixed APR on capital desc) — this only drops
 * pairs that price nothing at all and keeps server order. */
export function rankOpportunities(groups: OpportunityGroup[] | undefined): RankedOpportunity[] {
  if (!groups) return [];
  const out: RankedOpportunity[] = [];
  for (const group of groups) {
    const pair = group.bestPair ?? group.pairs[0] ?? null;
    const apr = pair?.netFixedAprOnCapital ?? null;
    if (pair && apr !== null && Number.isFinite(apr)) {
      out.push({ group, pair, aprOnCapital: apr });
    }
  }
  return out;
}
