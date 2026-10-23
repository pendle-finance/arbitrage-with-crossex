import { describe, expect, it } from 'vitest';
import { fmtDateShort } from '../../lib/fmt';
import { excludedFraction } from './assetModel';
import { exclusionAfter, excludeToastText } from './excludeLeg';

const MATURITY = Date.UTC(2026, 10, 27) / 1000;
const leg = { venue: 'GATE', side: 'LONG' as const, spreadVenues: null, maturity: MATURITY };

describe('excludeToastText', () => {
  const rungs: Array<[number, string]> = [
    [50, '50'],
    [5_000, '5,000'],
    [100_000, '100,000'],
    [1_000_000, '1,000,000'],
    [6_000_000, '6,000,000'],
  ];

  it.each(rungs)('S-SCREEN-02 whole exclude names the exact size at $%d', (usd, text) => {
    expect(excludeToastText(leg, usd, usd, 'USD')).toBe(`Gate LONG ${text} USD · ${fmtDateShort(MATURITY)} excluded.`);
  });

  it.each(rungs)('S-SCREEN-02 part exclude names both exact sizes at $%d', (usd, text) => {
    const whole = usd * 2.5;
    const wholeText = whole.toLocaleString('en-US', { maximumFractionDigits: 2 });
    expect(excludeToastText(leg, usd, whole, 'USD')).toBe(
      `Gate LONG ${text} of ${wholeText} USD · ${fmtDateShort(MATURITY)} excluded.`,
    );
  });

  it('S-SCREEN-02 a 1,680 of 4,200 ETH part keeps its separators', () => {
    expect(excludeToastText(leg, 1680, 4200, 'ETH')).toBe(`Gate LONG 1,680 of 4,200 ETH · ${fmtDateShort(MATURITY)} excluded.`);
  });

  it('a 1,499.4 ETH row is not rounded to 1.5k', () => {
    expect(excludeToastText(leg, 1499.4, 4200, 'ETH')).toContain('1,499.4 of 4,200 ETH');
  });

  it('the date is local, as on the cards', () => {
    expect(excludeToastText(leg, 1, 1, 'ETH')).toContain(` · ${fmtDateShort(MATURITY)} excluded.`);
  });
});

describe('#74 every exclude saves a size', () => {
  it.each([50, 5_000, 100_000, 1_000_000, 6_000_000])('#74 a whole-leg exclude saves the leg size at $%d', (size) => {
    expect(exclusionAfter(undefined, size, size, 0.05)).toEqual({ qty: size });
  });

  it('#74 a whole-leg exclude saves the leg size when the rows add up to it', () => {
    expect(exclusionAfter({ qty: 4 }, 6, 10, null)).toEqual({ qty: 10 });
    expect(exclusionAfter({ qty: 4 }, 6.000000001, 10, null)).toEqual({ qty: 10 });
  });

  it('#74 a whole-leg exclude keeps at as a part exclude does', () => {
    expect(exclusionAfter({ qty: 4, at: 0.02 }, 6, 10, 0.07)).toEqual({ qty: 10, at: (4 * 0.02 + 6 * 0.07) / 10 });
    expect(exclusionAfter({ qty: 4, at: 0.02 }, 6, 10, null)).toEqual({ qty: 10, at: 0.02 });
  });

  it('#74 a 1.7.7 all entry stays all', () => {
    expect(exclusionAfter('all', 3, 10, 0.05)).toBe('all');
  });

  it.each([50, 5_000, 100_000, 1_000_000, 6_000_000])('#74 a later open on the market stays on its card at $%d', (size) => {
    const saved = exclusionAfter(undefined, size, size, null);
    expect(excludedFraction({ 'boros:1': saved }, 'boros:1', size * 1.5)).toBe(size / (size * 1.5));
  });
});
