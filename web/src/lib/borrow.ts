import type { RebalanceBucket } from '../api/types';
import { floorCents } from './ticks';

/** Under this a borrow is noise: unrealised PnL flips it across zero by a
 * few cents on every poll. The header pill and the section share it. */
export const MIN_BORROW = 1;

/** The two wallets a rebalance moves cash between. Either can be borrowed. */
export const isRebalanceWallet = (b: { coin: string; venue: string }): boolean =>
  (b.coin === 'USDC' && b.venue === 'HYPERLIQUID') || (b.coin === 'USDT' && b.venue === 'CROSSEX');

/** The wallet Gate has lent to, the larger borrow when both. Null under 1. */
export function borrowedBucket(buckets: RebalanceBucket[] | undefined): RebalanceBucket | null {
  const candidates = (buckets ?? []).filter((b) => isRebalanceWallet(b) && floorCents(b.borrow) >= MIN_BORROW);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.borrow > a.borrow ? b : a));
}
