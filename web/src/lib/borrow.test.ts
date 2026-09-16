import { describe, expect, it } from 'vitest';
import type { RebalanceBucket } from '../api/types';
import { MIN_BORROW, borrowTotalUsd, borrowingBuckets, isRebalanceWallet } from './borrow';

function bucket(overrides: Partial<RebalanceBucket>): RebalanceBucket {
  return {
    coin: 'USDT',
    venue: 'CROSSEX',
    cash: 0,
    upnl: 0,
    equity: 0,
    borrow: 0,
    imHeldUsd: 0,
    mmHeldUsd: 0,
    interestPaidUsd: 0,
    interestPerDayUsd: 0,
    ...overrides,
  };
}

describe('borrowingBuckets', () => {
  it('returns every borrowing wallet', () => {
    const usdt = bucket({ coin: 'USDT', venue: 'CROSSEX', borrow: 250 });
    const usdc = bucket({ coin: 'USDC', venue: 'HYPERLIQUID', borrow: 500 });
    expect(borrowingBuckets([usdt, usdc])).toEqual([usdc, usdt]);
  });

  it('sorts by borrow descending', () => {
    const small = bucket({ coin: 'USDC', venue: 'LIGHTER', borrow: 10 });
    const big = bucket({ coin: 'USDT', venue: 'CROSSEX', borrow: 900 });
    expect(borrowingBuckets([small, big])).toEqual([big, small]);
  });

  it('includes a wallet whose borrow is $0.40', () => {
    const dust = bucket({ coin: 'USDC', venue: 'LIGHTER', borrow: 0.4 });
    expect(0.4).toBeLessThan(MIN_BORROW);
    expect(borrowingBuckets([dust])).toEqual([dust]);
  });

  it('drops a wallet with no borrow', () => {
    const clean = bucket({ coin: 'USDC', venue: 'HYPERLIQUID', borrow: 0 });
    expect(borrowingBuckets([clean])).toEqual([]);
  });

  it('drops a wallet that is not a rebalance wallet', () => {
    const other = bucket({ coin: 'USDT', venue: 'GATE', borrow: 500 });
    expect(borrowingBuckets([other])).toEqual([]);
  });

  it('returns an empty array when buckets is undefined', () => {
    expect(borrowingBuckets(undefined)).toEqual([]);
  });
});

describe('borrowTotalUsd', () => {
  it('sums every borrowing wallet', () => {
    const usdt = bucket({ coin: 'USDT', venue: 'CROSSEX', borrow: 250.126 });
    const usdc = bucket({ coin: 'USDC', venue: 'HYPERLIQUID', borrow: 500.004 });
    expect(borrowTotalUsd([usdt, usdc])).toBeCloseTo(750.12, 2);
  });

  it('returns 0 when nothing borrows', () => {
    expect(borrowTotalUsd([])).toBe(0);
  });

  it('returns 0 when buckets is undefined', () => {
    expect(borrowTotalUsd(undefined)).toBe(0);
  });
});

describe('isRebalanceWallet', () => {
  it('accepts USDC on Hyperliquid and Lighter, and USDT on CrossEx', () => {
    expect(isRebalanceWallet({ coin: 'USDC', venue: 'HYPERLIQUID' })).toBe(true);
    expect(isRebalanceWallet({ coin: 'USDC', venue: 'LIGHTER' })).toBe(true);
    expect(isRebalanceWallet({ coin: 'USDT', venue: 'CROSSEX' })).toBe(true);
  });

  it('rejects other coin and venue pairs', () => {
    expect(isRebalanceWallet({ coin: 'USDT', venue: 'GATE' })).toBe(false);
    expect(isRebalanceWallet({ coin: 'USDC', venue: 'CROSSEX' })).toBe(false);
  });
});
