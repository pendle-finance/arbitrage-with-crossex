import { describe, expect, it } from 'vitest';
import { pickMakerLeg, type MakerLegInput } from '../../src/core/estimate/makerLeg';

const leg = (makerRate: number | null, takerRate: number | null, slippagePct: number | null): MakerLegInput => ({
  makerRate,
  takerRate,
  slippagePct,
});

describe('pickMakerLeg', () => {
  it('fees decide first', () => {
    expect(pickMakerLeg(leg(0.0002, 0.0005, 0.1), leg(0.00015, 0.0005, 0.9))).toEqual({ leg: 'b', why: 'fees' });
    expect(pickMakerLeg(leg(0.00015, 0.0005, 0.9), leg(0.0002, 0.0005, 0.1))).toEqual({ leg: 'a', why: 'fees' });
  });

  it('weighs the taker fee of the hedge leg too', () => {
    expect(pickMakerLeg(leg(0.0005, 0.0002, 0), leg(0.0002, 0.0005, 0))).toEqual({ leg: 'b', why: 'fees' });
  });

  it('fee tie rests on the thinner book at full size', () => {
    expect(pickMakerLeg(leg(0.0002, 0.0005, 5.05), leg(0.0002, 0.0005, 1.55))).toEqual({ leg: 'a', why: 'book' });
    expect(pickMakerLeg(leg(0.0002, 0.0005, 1.55), leg(0.0002, 0.0005, 5.05))).toEqual({ leg: 'b', why: 'book' });
  });

  it('falls to the book when a fee is missing', () => {
    expect(pickMakerLeg(leg(null, null, 0.1), leg(0.0002, 0.0005, 0.4))).toEqual({ leg: 'b', why: 'book' });
    expect(pickMakerLeg(leg(null, null, null), leg(null, null, null))).toEqual({ leg: 'a', why: 'book' });
  });

  it('picks the first leg when everything ties', () => {
    expect(pickMakerLeg(leg(0.0002, 0.0005, 0.2), leg(0.0002, 0.0005, 0.2))).toEqual({ leg: 'a', why: 'book' });
  });

  it('a fee tie rests on the leg whose book cannot fill the full size, at 0.0166 and 2,000 ETH', () => {
    for (const size of [0.0166, 2_000]) {
      const short = { ...leg(0.0002, 0.0005, 0.01), pastBookDepth: size / 2 };
      const deep = leg(0.0002, 0.0005, 0.4);
      expect(pickMakerLeg(short, deep)).toEqual({ leg: 'a', why: 'book' });
      expect(pickMakerLeg(deep, short)).toEqual({ leg: 'b', why: 'book' });
    }
  });

  it('when both books run out the one with less depth rests, a depth tie keeps the first leg', () => {
    for (const size of [0.0166, 2_000]) {
      const less = { ...leg(0.0002, 0.0005, 0.5), pastBookDepth: size / 4 };
      const more = { ...leg(0.0002, 0.0005, 0.01), pastBookDepth: size / 2 };
      expect(pickMakerLeg(more, less)).toEqual({ leg: 'b', why: 'book' });
      expect(pickMakerLeg(less, more)).toEqual({ leg: 'a', why: 'book' });
      expect(pickMakerLeg(more, { ...more })).toEqual({ leg: 'a', why: 'book' });
    }
  });

  it('fees still win over a book that runs out', () => {
    const short = { ...leg(0.0002, 0.0005, 0.01), pastBookDepth: 1 };
    expect(pickMakerLeg(short, leg(0.00015, 0.0005, 0.4))).toEqual({ leg: 'b', why: 'fees' });
  });

  it('picks the same leg at $50 and at $6M of slippage', () => {
    expect(pickMakerLeg(leg(0.0002, 0.0005, 0.0001), leg(0.0002, 0.0005, 0.0002))).toEqual({ leg: 'b', why: 'book' });
    expect(pickMakerLeg(leg(0.0002, 0.0005, 12), leg(0.0002, 0.0005, 31))).toEqual({ leg: 'b', why: 'book' });
  });
});
