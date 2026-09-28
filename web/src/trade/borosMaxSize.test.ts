import { describe, expect, it } from 'vitest';
import { maxOpenSize } from './borosMaxSize';

const leg = (bucket: string, available: number | null, costPerSize: number | null, reducible = 0) => ({
  bucket,
  available,
  costPerSize,
  reducible,
});

describe('maxOpenSize', () => {
  it('turns the collateral a single leg has into the size it funds', () => {
    // His screenshot: 5.1128 ETH available read as a 5.11 ETH position. At
    // ~2.7% of size per unit (IM + fee) that collateral funds ~189 ETH.
    expect(maxOpenSize([leg('cross:2', 5.1128, 0.027)])).toBeCloseTo(5.1128 / 0.027, 9);
  });

  it('charges BOTH legs of a cross pair to the one bucket they share, at one size', () => {
    expect(maxOpenSize([leg('cross:2', 10, 0.02), leg('cross:2', 10, 0.03)])).toBeCloseTo(10 / 0.05, 9);
  });

  it('caps a pair on two isolated buckets by the tighter one, so the legs still match', () => {
    // A funds 500 on its own, B funds 200 on its own: the pair is 200 each.
    expect(maxOpenSize([leg('iso:1', 10, 0.02), leg('iso:2', 10, 0.05)])).toBeCloseTo(200, 9);
  });

  it('lets the part that reduces an opposing position trade without new margin', () => {
    // 30 of the order closes an opposing position; the bucket funds 100 more.
    expect(maxOpenSize([leg('cross:2', 2, 0.02, 30)])).toBeCloseTo(130, 9);
    // Two legs in one bucket, one of them reducing 50 first: up to S = 50 only
    // leg B pays (50 × 0.02 = 1 spent); the last 1 is split across both.
    expect(maxOpenSize([leg('cross:2', 2, 0.03, 50), leg('cross:2', 2, 0.02, 0)])).toBeCloseTo(50 + 1 / 0.05, 9);
  });

  it('still allows the reducing part when no collateral is free', () => {
    expect(maxOpenSize([leg('cross:2', 0, 0.02, 12)])).toBe(12);
    expect(maxOpenSize([leg('cross:2', -3, 0.02, 0)])).toBe(0);
  });

  it('says nothing rather than guessing when an input is missing', () => {
    expect(maxOpenSize([leg('cross:2', null, 0.02)])).toBeNull();
    expect(maxOpenSize([leg('cross:2', 10, null)])).toBeNull();
    expect(maxOpenSize([leg('cross:2', 10, 0)])).toBeNull();
    expect(maxOpenSize([])).toBeNull();
  });
});
