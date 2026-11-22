import { describe, expect, it } from 'vitest';
import type { BorosMarket } from '../../src/core/boros/client';
import { sigFigsDirectional } from '../../src/core/numbers';
import { halfCapSeedPct, ROLL_FALLBACK_SLIP_APR, seedSlippageApr } from '../../src/core/boros/rollProbe';

const market = (marketId: number, maxRateDeviationApr: number): BorosMarket => ({ marketId, maxRateDeviationApr }) as BorosMarket;

describe('halfCapSeedPct', () => {
  it.each([
    [[0.15], 7],
    [[0.2], 10],
    [[0.05], 2],
    [[0.012], 0.6],
    [[0.0014], 0.07],
    [[0.003], 0.1],
    [[0.1, 0.2], 7],
    [[0.15, 0, Number.NaN], 7],
  ])('half the mean of %j, floored to one figure, is %d percent', (caps, pct) => {
    expect(halfCapSeedPct(caps)).toBe(pct);
  });

  it.each([[[]], [[0]], [[-0.1]], [[Number.NaN]], [[Number.POSITIVE_INFINITY]]])('gives null for %j', (caps) => {
    expect(halfCapSeedPct(caps)).toBeNull();
  });

  it('matches the route rule for one market at every cap from 0.01% to 20%', () => {
    for (let i = 1; i <= 2000; i += 1) {
      const cap = i / 10_000;
      expect(halfCapSeedPct([cap])).toBe(sigFigsDirectional((cap / 2) * 100, 1, 'down'));
    }
  });
});

describe('seedSlippageApr', () => {
  const markets = [market(1, 0.15), market(2, 0.2), market(3, 0)];

  it('is the half-cap seed as an APR', () => {
    expect(seedSlippageApr(markets, [1])).toBe(0.07);
    expect(seedSlippageApr(markets, [1, 2])).toBe(0.08);
    expect(seedSlippageApr(markets, [1, 3])).toBe(0.07);
  });

  it('falls back when no market has a cap', () => {
    expect(seedSlippageApr(markets, [3])).toBe(ROLL_FALLBACK_SLIP_APR);
    expect(seedSlippageApr(markets, [9])).toBe(ROLL_FALLBACK_SLIP_APR);
    expect(seedSlippageApr(markets, [])).toBe(ROLL_FALLBACK_SLIP_APR);
  });
});
