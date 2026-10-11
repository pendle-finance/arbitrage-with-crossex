import { describe, expect, it } from 'vitest';
import { nativeRateDeviationApr, borosRateBand } from '../../src/core/boros/rateBounds';

describe('native Boros rate band', () => {
  const binance = { markApr: 0.017755345, iTickThresh: 583, tickStep: 2, factorBase1e4: 2500 };
  it('uses the IM floor on the low-mark Binance market, admitting the observed 2.42% fill', () => {
    const cap = nativeRateDeviationApr(binance);
    expect(cap).toBeCloseTo(0.0150078533, 9);
    const band = borosRateBand({ markApr: binance.markApr, maxRateDeviationApr: cap });
    expect(band!.high).toBeGreaterThan(0.0242);
    expect(band!.low).toBeCloseTo(0.0027474917, 9);
  });
  it('takes absolute mark for negative rates and preserves genuine zero values', () => {
    expect(nativeRateDeviationApr({ ...binance, markApr: -0.1 })).toBeCloseTo(0.025, 12);
    expect(nativeRateDeviationApr({ ...binance, markApr: 0 })).toBeCloseTo(0.0150078533, 9);
    expect(nativeRateDeviationApr({ ...binance, factorBase1e4: 0 })).toBe(0);
    expect(borosRateBand({ markApr: 0.02, maxRateDeviationApr: 0 })).toEqual({ low: 0.02, high: 0.02 });
  });
  it.each(['markApr', 'iTickThresh', 'tickStep', 'factorBase1e4'] as const)('keeps missing/invalid %s unknown', (key) => {
    for (const value of [undefined, null, '', NaN, Infinity, false]) {
      expect(nativeRateDeviationApr({ ...binance, [key]: value })).toBeNull();
    }
  });
  it('rejects malformed threshold, step and factor', () => {
    expect(nativeRateDeviationApr({ ...binance, iTickThresh: -1 })).toBeNull();
    expect(nativeRateDeviationApr({ ...binance, tickStep: 0.5 })).toBeNull();
    expect(nativeRateDeviationApr({ ...binance, factorBase1e4: -1 })).toBeNull();
    expect(borosRateBand({ markApr: 0.02, maxRateDeviationApr: null })).toBeNull();
  });
});
