import { describe, expect, it } from 'vitest';
import { excludedFraction } from './assetModel';
import { exclusionAfter } from './excludeLeg';

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
