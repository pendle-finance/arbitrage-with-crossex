import type { Pool, RebalanceBucket, RoutePlan } from '../api/types';
import { borrowingBuckets } from '../lib/borrow';
import { poolKey } from './rebalanceCopy';
import { borrowLeftOf, keyOf, sharedCoin } from './RebalanceHovers';

export const bucketOf = (buckets: RebalanceBucket[], pool: Pool) => buckets.find((b) => keyOf(b) === poolKey(pool));
const afterOf = (route: RoutePlan, pool: Pool) => route.after.find((w) => keyOf(w) === poolKey(pool));
export const unique = (pools: Pool[]): Pool[] => [...new Set(pools)];

export function flowOf(buckets: RebalanceBucket[], route: RoutePlan, from: Pool[], to: Pool[]) {
  const delta = (pool: Pool, sign: 1 | -1): number => {
    const bucket = bucketOf(buckets, pool);
    const after = afterOf(route, pool);
    return bucket && after ? Math.max(0, sign * (after.equity - bucket.equity)) : 0;
  };
  const borrowing = borrowingBuckets(buckets).filter((b) => to.some((pool) => keyOf(b) === poolKey(pool)));
  const left = borrowing.reduce((total, b) => {
    const after = route.after.find((w) => keyOf(w) === keyOf(b));
    return total + (after ? borrowLeftOf(b, after) : b.borrow);
  }, 0);
  return {
    sent: from.map((pool) => ({ pool, amount: delta(pool, -1) })),
    arrives: to.map((pool) => ({ pool, amount: delta(pool, 1) })),
    borrowCoin: sharedCoin(borrowing),
    hasBorrow: borrowing.length > 0,
    left,
    repaid: borrowing.reduce((total, b) => total + b.borrow, 0) - left,
  };
}

export type MoveFlow = ReturnType<typeof flowOf>;
