/**
 * LTP VIP fee-tier module (src/core/ltp/feeTiers.ts): tolerant ladder parsing
 * (both accepted JSON shapes, junk dropped, fractions only), tier parsing, and
 * the file-over-default merge precedence.
 */
import { describe, expect, it } from 'vitest';
import {
  LTP_DEFAULT_LADDER,
  LTP_FEE_TIERS,
  ltpFeeRatesForTier,
  ltpFeeTierLabel,
  parseLtpFeeTier,
  parseLtpLadder,
} from '../../src/core/ltp/feeTiers';

describe('parseLtpFeeTier', () => {
  it('accepts exactly vip1..vip5', () => {
    for (const tier of LTP_FEE_TIERS) expect(parseLtpFeeTier(tier)).toBe(tier);
    for (const junk of ['vip0', 'vip6', 'VIP1', 'vip', '', undefined]) {
      expect(parseLtpFeeTier(junk as string | undefined)).toBeUndefined();
    }
  });

  it('labels tiers for prose', () => {
    expect(ltpFeeTierLabel('vip1')).toBe('VIP 1');
    expect(ltpFeeTierLabel('vip5')).toBe('VIP 5');
  });
});

describe('parseLtpLadder', () => {
  it('accepts the object shape with numbers or numeric strings', () => {
    const ladder = parseLtpLadder({
      vip2: { makerRate: 0.00005, takerRate: '0.00025' },
    });
    expect(ladder.vip2).toEqual({ makerRate: 0.00005, takerRate: 0.00025 });
  });

  it('accepts the [maker, taker] tuple shape', () => {
    const ladder = parseLtpLadder({ vip4: [-0.00001, 0.0002] });
    expect(ladder.vip4).toEqual({ makerRate: -0.00001, takerRate: 0.0002 });
  });

  it('drops junk entries instead of defaulting them', () => {
    const ladder = parseLtpLadder({
      _comment: 'ignored',
      vip1: [0.0001, 0.00035],
      vip2: { makerRate: 'abc', takerRate: 0.00025 }, // NaN maker → dropped
      vip3: [0.000225], // missing taker → dropped
      vip4: 'nope', // wrong shape → dropped
      vip5: [0.05, 0.5], // 50% taker is a percent pasted as a fraction → dropped
      vip9: [0, 0], // unknown tier key → ignored
    });
    expect(Object.keys(ladder)).toEqual(['vip1']);
  });

  it('returns an empty ladder on a non-object root', () => {
    expect(parseLtpLadder(null)).toEqual({});
    expect(parseLtpLadder([1, 2])).toEqual({});
    expect(parseLtpLadder('vip1')).toEqual({});
  });
});

describe('ltpFeeRatesForTier', () => {
  it('file entries win over the committed default', () => {
    const ladder = parseLtpLadder({ vip1: [0.00008, 0.0003] });
    expect(ltpFeeRatesForTier(ladder, 'vip1')).toEqual({ makerRate: 0.00008, takerRate: 0.0003 });
  });

  it('falls back to the committed default (VIP1 only), null past it', () => {
    expect(ltpFeeRatesForTier({}, 'vip1')).toEqual(LTP_DEFAULT_LADDER.vip1);
    expect(ltpFeeRatesForTier({}, 'vip2')).toBeNull();
    expect(ltpFeeRatesForTier({}, 'vip5')).toBeNull();
  });
});
