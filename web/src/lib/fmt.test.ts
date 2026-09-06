import { describe, expect, it } from 'vitest';
import {
  bps,
  feePct,
  fieldValue,
  fmtPct,
  fmtTokenQty,
  fmtUsd,
  num,
  parseSymbol,
  sig,
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
