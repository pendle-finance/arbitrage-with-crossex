import { describe, it, expect } from 'vitest';
import {
  decimalsOf,
  roundToStep,
  roundSigFigs,
  formatLimitPrice,
  formatCrossPrice,
  formatRestPrice,
  parseSymbol,
} from '../../src/core/numbers';

describe('decimalsOf', () => {
  it.each([
    ['0.001', 3],
    ['1', 0],
    ['0.0100', 2], // trailing zeros trimmed
    ['10', 0],
    ['0.5', 1],
    // scientific notation must not collapse to 0 (would produce a '0' price)
    ['1e-5', 5],
    ['1e-7', 7],
    ['2.5e-4', 5],
    ['1e2', 0],
  ])('%s -> %i', (step, dp) => {
    expect(decimalsOf(step)).toBe(dp);
  });

  it('formatLimitPrice does not collapse a sci-notation tick to an integer', () => {
    expect(formatLimitPrice(0.00234, 'GATE_FUTURE_X_USDT', '1e-5')).toBe('0.00234');
  });
});

describe('roundToStep', () => {
  it.each([
    [0.0076923, '0.001', 'down', '0.007'],
    [123.46, '0.5', 'nearest', '123.5'],
    [0.0999, '0.1', 'down', '0.0'],
    [1.23456, '0.010', 'down', '1.23'], // precision from step "0.010" is 2, not 3
  ] as const)('(%f, %s, %s) -> %s', (value, step, dir, expected) => {
    expect(roundToStep(value, step, dir)).toBe(expected);
  });

  it('passes value through when step is unusable', () => {
    expect(roundToStep(1.5, '0')).toBe('1.5');
    expect(roundToStep(1.5, 'abc')).toBe('1.5');
  });

  // Float regression: 0.3/0.1 === 2.9999999999999996, so a bare floor would drop a
  // whole step. Ratios within tolerance of an integer must snap before flooring...
  it('snaps near-integer ratios instead of flooring a whole step away', () => {
    expect(roundToStep(0.3, '0.1', 'down')).toBe('0.3');
    expect(roundToStep(2.0000000000000004, '0.001', 'down')).toBe('2.000');
  });

  it('still floors values genuinely below a step boundary', () => {
    expect(roundToStep(0.29999999, '0.1', 'down')).toBe('0.2');
  });

  it('keeps the step of a one-step float result and never passes an 8-decimal value', () => {
    expect(roundToStep(0.3 - 0.1, '0.1', 'down')).toBe('0.2');
    expect(roundToStep(0.1 + 0.2, '0.1', 'down')).toBe('0.3');
    expect(roundToStep(0.1 + 0.2, '0.1', 'up')).toBe('0.3');
    expect(roundToStep(99.99999999, '10', 'down')).toBe('90');
    expect(roundToStep(100.00000001, '10', 'up')).toBe('110');
    expect(roundToStep(6000000.01 - 1, '0.00001', 'down')).toBe('5999999.01000');
    expect(roundToStep(5999999.99999999, '0.00001', 'down')).toBe('5999999.99999');
  });
});

describe('roundSigFigs', () => {
  it.each([
    [65432.123, 5, 65432],
    [0.00123456, 5, 0.0012346],
    [0, 5, 0],
    [999.995, 5, 1000], // rounds up across a magnitude boundary
    [-0.00123456, 5, -0.0012346], // negative input keeps sign
    [-65432.123, 5, -65432],
  ])('(%f, %i) -> %f', (n, figs, expected) => {
    expect(roundSigFigs(n, figs)).toBe(expected);
  });
});

describe('roundToStep up', () => {
  it('ceils to the step (with the same integer-snap guard as down/nearest)', () => {
    expect(roundToStep(2.01, '0.05', 'up')).toBe('2.05');
    expect(roundToStep(1.999, '0.1', 'up')).toBe('2.0');
    expect(roundToStep(2.0, '0.1', 'up')).toBe('2.0'); // exact multiple → snap, not 2.1
    expect(roundToStep(2.0000000001, '0.1', 'up')).toBe('2.1');
  });
});

describe('formatCrossPrice', () => {
  it('rounds AWAY from mark so it stays marketable on coarse ticks', () => {
    // 2.00 crossed +/-0.5% then tick 0.05: SELL floors below, BUY ceils above.
    expect(formatCrossPrice(1.99, 'SELL', 'GATE_FUTURE_X_USDT', '0.05')).toBe('1.95');
    expect(formatCrossPrice(2.01, 'BUY', 'GATE_FUTURE_X_USDT', '0.05')).toBe('2.05');
  });

  it('keeps Hyperliquid within 5 sig figs', () => {
    // At high prices the sig-fig grid (~$1 at $65k) is far finer than the slippage
    // band (~$327), so the cap can nudge sub-tick but never crosses mark in practice.
    const sell = formatCrossPrice(65104.9, 'SELL', 'HYPERLIQUID_FUTURE_BTC_USDT', '0.1');
    expect(sell.replace(/[.-]/g, '').replace(/^0+/, '').length).toBeLessThanOrEqual(5);
  });

  it('rounds a low-priced HL symbol directionally (sig-fig cap inactive)', () => {
    expect(Number(formatCrossPrice(2.4321, 'SELL', 'HYPERLIQUID_FUTURE_X_USDC', '0.001'))).toBeLessThanOrEqual(2.4321);
    expect(Number(formatCrossPrice(2.4321, 'BUY', 'HYPERLIQUID_FUTURE_X_USDC', '0.001'))).toBeGreaterThanOrEqual(2.4321);
  });
});

describe('formatLimitPrice', () => {
  it('snaps to tick and strips trailing zeros', () => {
    expect(formatLimitPrice(65432.123, 'GATE_FUTURE_BTC_USDT', '0.1')).toBe('65432.1');
    expect(formatLimitPrice(65000, 'GATE_FUTURE_BTC_USDT', '0.1')).toBe('65000');
  });

  it('caps Hyperliquid prices at 5 significant figures', () => {
    expect(formatLimitPrice(65432.123, 'HYPERLIQUID_FUTURE_BTC_USDC', '0.1')).toBe('65432');
    // 6 decimals is fine — the cap is significant figures, not decimal places
    expect(formatLimitPrice(0.0123456, 'HYPERLIQUID_FUTURE_HYPE_USDC', '0.000001')).toBe(
      '0.012346',
    );
  });

  it('does not cap non-Hyperliquid venues', () => {
    // 8 significant figures survive intact
    expect(formatLimitPrice(65432.123, 'GATE_FUTURE_BTC_USDT', '0.001')).toBe('65432.123');
  });
});

describe('formatRestPrice', () => {
  it('rounds AWAY from crossing so a post-only snap cannot become a taker reject', () => {
    // Tick 0.05: a BUY must stay at/below what it asked for, a SELL at/above.
    expect(formatRestPrice(2.01, 'BUY', 'GATE_FUTURE_X_USDT', '0.05')).toBe('2');
    expect(formatRestPrice(1.99, 'SELL', 'GATE_FUTURE_X_USDT', '0.05')).toBe('2');
  });

  it('does not snap a Hyperliquid BUY up onto the ask', () => {
    // The reported case: HL BTC bid 61717 / ask 61718, tick 0.1. formatLimitPrice's
    // NEAREST 5-sig-fig cap turns a 61717.6 resting BUY into 61718 — exactly the ask,
    // so the venue insta-rejects it as would-cross; with pricePolicy 'fixed' the same
    // price is re-placed every retry until MAX_POC_REJECTS kills the deal, and the
    // recorded cause ("market moving too fast") is wrong.
    expect(formatLimitPrice(61717.6, 'HYPERLIQUID_FUTURE_BTC_USDC', '0.1')).toBe('61718');
    expect(formatRestPrice(61717.6, 'BUY', 'HYPERLIQUID_FUTURE_BTC_USDC', '0.1')).toBe('61717');
    // Mirror side: a resting SELL must never be dragged down onto the bid.
    expect(formatRestPrice(61717.4, 'SELL', 'HYPERLIQUID_FUTURE_BTC_USDC', '0.1')).toBe('61718');
  });

  it('never moves the price in the crossing direction, on either side', () => {
    for (const px of [2.4321, 0.00234, 65432.123, 61717.6]) {
      for (const sym of ['GATE_FUTURE_X_USDT', 'HYPERLIQUID_FUTURE_X_USDC']) {
        expect(Number(formatRestPrice(px, 'BUY', sym, '0.001'))).toBeLessThanOrEqual(px);
        expect(Number(formatRestPrice(px, 'SELL', sym, '0.001'))).toBeGreaterThanOrEqual(px);
      }
    }
  });
});

describe('parseSymbol', () => {
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

  it.each([
    ['KRAKEN_FUTURE_BTC_USD', 'USD'],
    ['HYPERLIQUID_FUTURE_HYPE_USDC', 'USDC'],
  ])('%s has quote %s', (symbol, quote) => {
    expect(parseSymbol(symbol).quote).toBe(quote);
  });

  it('does not throw on a degenerate symbol', () => {
    // Single token: it doubles as exchange and quote; base/business are empty.
    expect(parseSymbol('BTC')).toEqual({
      exchange: 'BTC',
      business: '',
      base: '',
      quote: 'BTC',
      pair: '_BTC',
    });
  });
});

