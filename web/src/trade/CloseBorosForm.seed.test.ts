import { describe, expect, it } from 'vitest';
import { seedBorosSlipPct } from './CloseBorosForm';

describe('seedBorosSlipPct', () => {
  it('seeds from the tightest cap, not the mean', () => {
    expect(seedBorosSlipPct([0.02, 0.006])).toBe(0.3);
  });

  it('floors to one significant figure so the seed stays inside the cap', () => {
    expect(seedBorosSlipPct([0.016416])).toBe(0.8);
  });

  it('skips a market with no usable cap', () => {
    expect(seedBorosSlipPct([undefined, null, 0, -0.01, 0.04])).toBe(2);
  });

  it('falls back to 1% when no market has a usable cap', () => {
    expect(seedBorosSlipPct([])).toBe(1);
    expect(seedBorosSlipPct([undefined, 0])).toBe(1);
  });
});
