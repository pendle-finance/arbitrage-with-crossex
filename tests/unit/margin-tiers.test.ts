import { describe, expect, it } from 'vitest';
import { marginTiersOf } from '../../src/core/marginTiers';

const row = (from: string, rate: string, deduction: string) => ({
  minRiskLimitValue: from,
  maintenanceRate: rate,
  quickCalAmount: deduction,
});

const hype = [row('0', '0.015', '0'), row('200000', '0.018', '600'), row('500000', '0.025', '3700')];

describe('marginTiersOf', () => {
  it('keeps a symbol whose every tier parses and whose first tier starts at zero', () => {
    expect(marginTiersOf([{ symbol: 'GATE_FUTURE_HYPE_USDT', tiers: hype }])).toEqual({
      GATE_FUTURE_HYPE_USDT: [
        { from: 0, rate: 0.015, deduction: 0 },
        { from: 200_000, rate: 0.018, deduction: 600 },
        { from: 500_000, rate: 0.025, deduction: 3_700 },
      ],
    });
  });

  it('omits the symbol whole when one tier row does not parse, rather than serving a table with a hole', () => {
    const bad = [
      { ...row('300000', '0.02', '1200'), quickCalAmount: 'n/a' },
      { ...row('n/a', '0.02', '1200') },
      { ...row('300000', '0', '1200') },
    ];
    for (const b of bad) {
      expect(marginTiersOf([{ symbol: 'GATE_FUTURE_HYPE_USDT', tiers: [...hype, b] }])).toEqual({});
    }
  });

  it('omits the symbol when its lowest tier does not start at zero', () => {
    expect(marginTiersOf([{ symbol: 'GATE_FUTURE_HYPE_USDT', tiers: hype.slice(1) }])).toEqual({});
  });
});
