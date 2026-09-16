import type { RebalanceBucket } from '../api/types';
import { floorCents } from './ticks';

/** Under this a borrow is unrealised PnL noise, so the step list and its hover skip it. */
export const MIN_BORROW = 1;

export const isRebalanceWallet = (b: { coin: string; venue: string }): boolean =>
  (b.coin === 'USDC' && (b.venue === 'HYPERLIQUID' || b.venue === 'LIGHTER')) || (b.coin === 'USDT' && b.venue === 'CROSSEX');

export function borrowingBuckets(buckets: RebalanceBucket[] | undefined): RebalanceBucket[] {
  return (buckets ?? [])
    .filter((b) => isRebalanceWallet(b) && floorCents(b.borrow) > 0)
    .sort((a, b) => b.borrow - a.borrow);
}

export function borrowTotalUsd(buckets: RebalanceBucket[] | undefined): number {
  return borrowingBuckets(buckets).reduce((sum, b) => sum + floorCents(b.borrow), 0);
}
