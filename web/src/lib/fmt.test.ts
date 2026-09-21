import { describe, expect, it } from 'vitest';
import {
  bps,
  feePct,
  fieldValue,
  fmtAbout,
  fmtAge,
  fmtClock,
  fmtDateLocal,
  fmtDateShort,
  fmtPct,
  fmtSyncAge,
  fmtTokenQty,
  fmtUsd,
  fmtUsdCompact,
  num,
  parseDateLocal,
  parseSymbol,
  prettyVenue,
  sig,
  sigGrouped,
  toDate,
} from './fmt';

// num/sig expectations are copied from tests/unit/format.test.ts in the repo
// root — the web port must behave identically to src/core/numbers.ts.

describe('num (port of core numbers.num)', () => {
  it('formats with fixed decimals and thousands separators', () => {
    expect(num(1234.5, 2)).toBe('1,234.50');
  });
});

describe('sig (port of core numbers.sig)', () => {
  it.each([
    [0, '0'],
    [65432.1, '65432.1'], // toFixed(2) then trailing zeros stripped
    [1234.5678, '1234.57'], // abs >= 1000 -> only 2 dp, so it rounds
    [1.23456789, '1.2346'], // 1 <= abs < 1000 -> 4 dp
    // double nearest to 0.000012345 is just under, so toFixed(8) rounds DOWN
    [0.000012345, '0.00001234'],
  ])('sig(%f) -> %s', (value, expected) => {
    expect(sig(value)).toBe(expected);
  });
});

describe('sigGrouped', () => {
  it.each([
    // The account-scale magnitudes this exists for.
    [577491.04, '577,491.04'],
    [1019333.92, '1,019,333.92'],
    // Negatives keep their sign on both sides of the grouping.
    [-1041360.1, '-1,041,360.1'],
    [-22026.18, '-22,026.18'],
    // Below the grouping threshold it is exactly sig().
    [0, '0'],
    [999, '999'],
    [1.23456789, '1.2346'],
    [-0.000012345, '-0.00001234'],
  ])('sigGrouped(%f) -> %s', (value, expected) => {
    expect(sigGrouped(value)).toBe(expected);
  });
});

describe('parseSymbol (port of core numbers.parseSymbol)', () => {
  it('parses EXCHANGE_BUSINESS_BASE_QUOTE', () => {
    expect(parseSymbol('BINANCE_FUTURE_BTC_USDT')).toEqual({
      exchange: 'BINANCE',
      business: 'FUTURE',
      base: 'BTC',
      quote: 'USDT',
      pair: 'BTC_USDT',
    });
  });

  it('joins multi-token bases', () => {
    expect(parseSymbol('GATE_FUTURE_1000_PEPE_USDT')).toMatchObject({
      base: '1000_PEPE',
      pair: '1000_PEPE_USDT',
    });
  });
});

describe('fmtTokenQty', () => {
  it.each([
    [2.6316, 'ETH', '2.63 ETH'],
    [5, 'ETH', '5 ETH'], // trailing zeros dropped
    [142.71, 'ETH', '142.7 ETH'],
    [1234, 'HYPE', '1.2k HYPE'],
    [250_000, 'HYPE', '250k HYPE'],
    [1_500_000, 'HYPE', '1.5M HYPE'],
    [12_000_000, 'HYPE', '12M HYPE'],
    [0.0847, 'BTC', '0.0847 BTC'],
    [0, 'ETH', '0 ETH'],
    // Rounding that carries into the next tier promotes with it.
    [999.96, 'ETH', '1k ETH'],
    [999_950, 'HYPE', '1M HYPE'],
    [99.996, 'ETH', '100 ETH'],
    [0.9996, 'ETH', '1 ETH'],
  ])('fmtTokenQty(%f, %s) -> %s', (amount, symbol, expected) => {
    expect(fmtTokenQty(amount, symbol)).toBe(expected);
  });

  it('degrades non-finite amounts to a dash', () => {
    expect(fmtTokenQty(NaN, 'ETH')).toBe('—');
  });

  it('floors dust instead of leaking exponential notation', () => {
    expect(fmtTokenQty(1e-7, 'BTC')).toBe('<0.000001 BTC');
    expect(fmtTokenQty(1e-12, 'BTC')).toBe('<0.000001 BTC');
  });
});

describe('web additions', () => {
  it('fmtUsd renders signed dollars', () => {
    expect(fmtUsd(9387.2, 0)).toBe('$9,387');
    expect(fmtUsd('-1234.5')).toBe('-$1,234.50');
  });

  it('fmtUsd never prints a negative zero, and a non-number is a dash', () => {
    // A value that rounds away at the shown precision has no sign to print.
    expect(fmtUsd(-0.004)).toBe('$0.00');
    expect(fmtUsd(-0)).toBe('$0.00');
    expect(fmtUsd(-0.004, 0)).toBe('$0.00');
    // Not "NaN"/"Infinity": a feed hiccup must read as unknown, not as money.
    expect(fmtUsd(NaN)).toBe('—');
    expect(fmtUsd(Infinity)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
    expect(bps(Infinity)).toBe('—');
  });

  it('fmtPct treats input as a ratio', () => {
    expect(fmtPct('0.1234')).toBe('12.34%');
  });

  it('bps and feePct render fee fractions', () => {
    expect(bps('0.0002')).toBe('2.0 bps');
    expect(bps(-0.00005)).toBe('-0.5 bps');
    expect(feePct('0.0002')).toBe('0.0200%');
  });

  it('toDate handles seconds AND milliseconds epochs', () => {
    const fromSeconds = toDate(1_735_689_600); // < 1e12 ⇒ seconds
    const fromMillis = toDate(1_735_689_600_000);
    expect(fromSeconds?.getTime()).toBe(1_735_689_600_000);
    expect(fromMillis?.getTime()).toBe(1_735_689_600_000);
    expect(toDate('1735689600')).toEqual(fromSeconds);
    expect(toDate(undefined)).toBeNull();
    expect(toDate('nope')).toBeNull();
  });
});

describe('fmtAbout', () => {
  it.each([
    [3, 'about 3s'],
    [120, 'about 2 min'],
    [130, 'about 2 min'],
    [400, 'about 6.5 min'],
    [650, 'about 11 min'],
    [780, 'about 13 min'],
    [1430, 'about 24 min'],
    [3570, 'about 1 h'],
    [3600, 'about 1 h'],
    [3601, 'about 1 h'],
    [62520, 'about 17 h 22 m'],
  ])('fmtAbout(%i) -> %s', (seconds, expected) => {
    expect(fmtAbout(seconds)).toBe(expected);
  });
});

describe('fieldValue — the string an editable quantity field holds', () => {
  it('drops the float noise a real USD-to-token conversion leaves', () => {
    expect(fieldValue(2.5296100000000002)).toBe('2.52961');
  });

  it('keeps a large quantity intact, where sig() would change the order', () => {
    expect(fieldValue(12345.6789)).toBe('12345.679');
    expect(sig(12345.6789)).toBe('12345.68');
  });

  it('keeps a small lot-sized quantity whole', () => {
    expect(fieldValue(0.0001234)).toBe('0.0001234');
    expect(fieldValue(2.5296)).toBe('2.5296');
  });

  it('takes more figures for a price, which is rounded against ticks not lots', () => {
    expect(fieldValue(1234.5678901234, 10)).toBe('1234.56789');
    expect(fieldValue(1234.5678901234)).toBe('1234.5679');
  });

  it('answers empty for a value that is not a number', () => {
    expect(fieldValue(Number.NaN)).toBe('');
    expect(fieldValue(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('local dates', () => {
  it('reads a date input as local midnight', () => {
    expect(parseDateLocal('2026-06-23')).toBe(new Date(2026, 5, 23).getTime() / 1000);
    expect(fmtDateLocal(parseDateLocal('2026-06-23'))).toBe('2026-06-23');
  });

  it('answers NaN for an input that is not a date', () => {
    expect(parseDateLocal('')).toBeNaN();
  });

  it('writes a short date with the year only when asked', () => {
    const sec = new Date(2026, 5, 23, 10, 51).getTime() / 1000;
    expect(fmtDateShort(sec, { year: 'numeric' })).toBe('23 Jun 2026');
    expect(fmtDateShort(new Date(2026, 2, 1).getTime() / 1000)).toBe('1 Mar');
  });

  it('writes a local clock time as HH:MM', () => {
    expect(fmtClock(new Date(2026, 8, 18, 9, 5, 59).getTime())).toBe('09:05');
  });
});

describe('fmtSyncAge', () => {
  it.each([
    [-5_000, '0 s ago'],
    [59_999, '59 s ago'],
    [60_000, '1 min ago'],
    [3_599_000, '59 min ago'],
    [3_600_000, '1 h ago'],
    [86_399_000, '23 h ago'],
    [2 * 86_400_000, '2 d ago'],
  ])('%d ms reads %s', (ms, text) => {
    expect(fmtSyncAge(ms)).toBe(text);
  });
});

describe('prettyVenue', () => {
  it.each([
    ['GATE', 'Gate'],
    ['HYPERLIQUID', 'Hyperliquid'],
    ['LIGHTER', 'Lighter'],
    ['lighter', 'Lighter'],
    ['OKX', 'OKX'],
  ])('prettyVenue(%s) -> %s', (v, expected) => {
    expect(prettyVenue(v)).toBe(expected);
  });
});

describe('fmtUsdCompact', () => {
  it.each([
    [999_949.99, '$999.9k'],
    [999_950, '$1.00M'],
    [999_999.995, '$1.00M'],
    [1_000_000, '$1.00M'],
  ])('fmtUsdCompact(%f) -> %s', (n, expected) => {
    expect(fmtUsdCompact(n)).toBe(expected);
  });
});

describe('fmtAge', () => {
  it.each([
    [Number.NaN, '—'],
    [-5_000, '0s'],
    [59_999, '59s'],
    [252_000, '4m 12s'],
    [3_599_000, '59m 59s'],
    [7_500_000, '2h 5m'],
    [86_399_000, '23h 59m'],
    [3 * 86_400_000, '3d'],
  ])('%d ms reads %s', (ms, text) => {
    expect(fmtAge(ms)).toBe(text);
  });
});
