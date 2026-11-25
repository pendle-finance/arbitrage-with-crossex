import { describe, expect, it } from 'vitest';
import { restPlan, type TwapLegRule } from '../../src/core/twap';
import { fx, fxStr } from '../../src/engine/fx';

const ETH_RULES: TwapLegRule[] = [
  { venue: 'GATE', coin: 'ETH', lot: '0.001', minSize: '0.001', minNotional: '0', maxMarketSize: '100000', maxLimitSize: '100000' },
  { venue: 'BINANCE', coin: 'ETH', lot: '0.001', minSize: '0.001', minNotional: '20', maxMarketSize: '2000', maxLimitSize: '10000' },
];

const sizesOf = (plan: { slices: number; sliceQty: string; lastQty: string }): string[] => [
  ...Array.from({ length: plan.slices - 1 }, () => plan.sliceQty),
  plan.lastQty,
];

const sumOf = (sizes: string[]): string => fxStr(sizes.reduce((sum, qty) => sum + fx(qty), fx('0')));

describe('restPlan', () => {
  it('keeps the slice count when every slice fits', () => {
    const plan = restPlan('547.52', 9, 300, ETH_RULES, 3000)!;
    expect(plan).toMatchObject({ slices: 9, sliceQty: '60.835', lastQty: '60.84', intervalSec: 300 });
  });

  it('a last slice over the venue max at $6M splits under the max', () => {
    const plan = restPlan('2033.333', 1, 300, ETH_RULES, 3000)!;
    expect(plan.slices).toBe(2);
    const sizes = sizesOf(plan);
    expect(sizes.every((qty) => Number(qty) <= 2000)).toBe(true);
    expect(sumOf(sizes)).toBe('2033.333');
  });

  it('a rest far over the max adds enough slices that the last one fits too', () => {
    const plan = restPlan('6000.004', 2, 300, ETH_RULES, 3000)!;
    const sizes = sizesOf(plan);
    expect(plan.slices).toBe(4);
    expect(sizes.every((qty) => Number(qty) <= 2000)).toBe(true);
    expect(sumOf(sizes)).toBe('6000.004');
  });

  it('a rest under the venue min at $50 joins one slice', () => {
    const plan = restPlan('0.007', 3, 300, ETH_RULES, 3000)!;
    expect(plan).toMatchObject({ slices: 1, sliceQty: '0.007', lastQty: '0.007' });
  });

  it('fewer slices when each would fall under the min', () => {
    const plan = restPlan('0.03', 10, 300, ETH_RULES, 3000)!;
    expect(plan.slices).toBe(4);
    expect(sizesOf(plan).every((qty) => Number(qty) * 3000 >= 20)).toBe(true);
    expect(sumOf(sizesOf(plan))).toBe('0.03');
  });

  it('a rest under one lot plans nothing', () => {
    expect(restPlan('0.0004', 3, 300, ETH_RULES, 3000)).toBeNull();
  });
});
