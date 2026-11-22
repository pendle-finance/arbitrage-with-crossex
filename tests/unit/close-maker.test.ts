import { describe, expect, it } from 'vitest';
import { pickCloseMakerLeg, type MakerLegInput } from '../../src/core/estimate/closeMaker.js';

const leg = (
  makerRate: number | null,
  takerRate: number | null,
  slippagePct: number | null,
): MakerLegInput => ({ makerRate, takerRate, slippagePct });

describe('pickCloseMakerLeg', () => {
  it('picks the cheaper maker plus taker fee sum', () => {
    expect(pickCloseMakerLeg(leg(0.0005, 0.0002, 0), leg(0.0002, 0.0005, 0))).toBe(1);
    expect(pickCloseMakerLeg(leg(0.0002, 0.0005, 0), leg(0.0005, 0.0002, 0))).toBe(0);
  });

  it('rests the leg with larger slippage when fees tie', () => {
    expect(pickCloseMakerLeg(leg(0.0002, 0.0005, 0.1), leg(0.0002, 0.0005, 0.4))).toBe(1);
    expect(pickCloseMakerLeg(leg(0.0002, 0.0005, 0.4), leg(0.0002, 0.0005, 0.1))).toBe(0);
  });

  it('falls to slippage when a fee is missing', () => {
    expect(pickCloseMakerLeg(leg(null, null, 0.1), leg(0.0002, 0.0005, 0.4))).toBe(1);
    expect(pickCloseMakerLeg(leg(0.0002, 0.0005, 0.1), leg(null, 0.0005, 0.4))).toBe(1);
    expect(pickCloseMakerLeg(leg(null, null, null), leg(null, null, null))).toBe(0);
  });

  it('picks leg 0 when everything is equal', () => {
    expect(pickCloseMakerLeg(leg(0.0002, 0.0005, 0.2), leg(0.0002, 0.0005, 0.2))).toBe(0);
  });
});
