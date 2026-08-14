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
    // "Limit + hedge": one leg rests as a maker order, the other hedges into
    // it. Cheaper than crossing both spreads, and it is how a visitor would
    // actually open this in the terminal — pricing the landing off two market
    // orders quoted a worse number than the tool itself produces.
    entryMode: 'maker-hedge',
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
 * OR negative. Groups arrive pre-ranked (net fixed APR on capital desc) — this
 * only drops pairs that price nothing at all and keeps server order.
 *
 * The HERO reads this unfiltered, so on a bad day it still tells the truth.
 * The list uses `positiveOnly` below. */
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

/** The shop-window filter: only spreads that actually pay after costs.
 *
 * ⚠️ A negative here is NOT a wrong-way-round trade that flipping would fix.
 * `src/core/boros/opportunities.ts` enumerates BOTH orientations of every venue
 * pair and emits only the one whose receive-rate exceeds its pay-rate, so every
 * pair that reaches us already has a positive GROSS spread. A negative
 * `netFixedAprOnCapital` means execution cost ate more than the spread — and
 * reversing the legs would give a negative gross spread AND still pay those
 * costs, i.e. strictly worse. So these are dropped, never swapped. */
export function positiveOnly(ranked: RankedOpportunity[]): RankedOpportunity[] {
  return ranked.filter((r) => r.aprOnCapital > 0);
}
