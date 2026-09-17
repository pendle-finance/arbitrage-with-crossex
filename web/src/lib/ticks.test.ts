import { describe, expect, it } from 'vitest';
import { decimalsOf, floorCents, formatLimitPrice, formatRestPrice, roundToStep } from './ticks';

const RUNGS = [
  { usd: '$50', x: 50 },
  { usd: '$5,000', x: 5_000 },
  { usd: '$100,000', x: 100_000 },
  { usd: '$1,000,000', x: 1_000_000 },
  { usd: '$6,000,000', x: 6_000_000 },
] as const;

const hairsUnderCent = (x: number): number[] => [
  x - 0.004,
  x - 0.000001,
  x - 0.0000001,
  Number(`${x - 1}.996`),
  Number(`${x - 1}.99999999`),
];

describe('roundToStep at every rung', () => {
  it.each(RUNGS)('$usd: a value a hair under a cent rounds down, never up', ({ x }) => {
    for (const value of hairsUnderCent(x)) {
      expect(roundToStep(value, '0.01', 'down')).toBe(`${x - 1}.99`);
      expect(floorCents(value)).toBe(Number(`${x - 1}.99`));
      expect(roundToStep(floorCents(value), '0.01', 'down')).toBe(`${x - 1}.99`);
    }
  });

  it.each(RUNGS)('$usd: an 8-decimal balance under a 0.00001 step rounds down, never up', ({ x }) => {
    for (const value of [x - 0.0000001, x - 0.00000001, Number(`${x - 1}.99999999`)]) {
      expect(roundToStep(value, '0.00001', 'down')).toBe(`${x - 1}.99999`);
    }
    expect(roundToStep(Number(`${x - 1}.99999999`), '0.0001', 'down')).toBe(`${x - 1}.9999`);
    expect(roundToStep(Number(`${x - 1}.99999999`), '0.1', 'down')).toBe(`${x - 1}.9`);
    expect(roundToStep(Number(`${x - 1}.99999999`), '1', 'down')).toBe(`${x - 1}`);
  });

  it.each(RUNGS)('$usd: a value a hair over the rung rounds up, never down', ({ x }) => {
    for (const value of [x + 0.004, x + 0.000001, Number(`${x}.00000001`)]) {
      expect(roundToStep(value, '0.01', 'up')).toBe(`${x}.01`);
    }
    expect(roundToStep(Number(`${x}.00000001`), '0.00001', 'up')).toBe(`${x}.00001`);
  });

  it.each(RUNGS)('$usd: exact values and one-step float results keep their step', ({ x }) => {
    for (const dir of ['down', 'up', 'nearest'] as const) {
      expect(roundToStep(x, '0.01', dir)).toBe(`${x}.00`);
      expect(roundToStep(Number(`${x}.29`), '0.01', dir)).toBe(`${x}.29`);
    }
    expect(roundToStep(x + 0.3 - 0.1, '0.1', 'down')).toBe(`${x}.2`);
    expect(roundToStep(x + 0.1 + 0.2, '0.1', 'up')).toBe(`${x}.3`);
    expect(roundToStep(Number(`${x}.01`) - 1, '0.00001', 'down')).toBe(`${x - 1}.01000`);
  });

  it.each(RUNGS)('$usd: 500 cents values up to the rung come back unchanged', ({ x }) => {
    for (let i = 0; i < 500; i++) {
      const c = Number(`${Math.floor((x * (i + 1)) / 500)}.${String((i * 37) % 100).padStart(2, '0')}`);
      expect(floorCents(c)).toBe(c);
      expect(Number(roundToStep(c, '0.01', 'up'))).toBe(c);
    }
  });

  it('keeps nearest as before', () => {
    expect(roundToStep(123.46, '0.5', 'nearest')).toBe('123.5');
    expect(roundToStep(5999999.994, '0.01', 'nearest')).toBe('5999999.99');
    expect(roundToStep(5999999.996, '0.01', 'nearest')).toBe('6000000.00');
  });

  it('never passes an 8-decimal value on a step above 1', () => {
    expect(roundToStep(99.99999999, '10', 'down')).toBe('90');
    expect(roundToStep(100.00000001, '10', 'up')).toBe('110');
  });
});

// These helpers are a port of src/core/numbers.ts, and the port had drifted: the
// sci-notation branch was missing here, so a CrossEx tick like "1e-4" counted 0
// decimals and toFixed(0) rewrote the user's typed limit price as an integer.
// The value still parsed as positive, so the ticket stayed armed and the server
// faithfully re-snapped the already-wrong price — no warning anywhere.
describe('decimalsOf', () => {
  it.each([
    ['0.001', 3],
    ['0.0001', 4],
    ['1', 0],
    ['10', 0],
    ['0.10', 1],
  ])('counts %s as %i decimals', (step, want) => {
    expect(decimalsOf(step)).toBe(want);
  });

  it.each([
    ['1e-5', 5],
    ['1e-4', 4],
    ['1E-3', 3],
    ['2.5e-4', 5],
    ['1e-2', 2],
    ['1e2', 0],
  ])('reads sci-notation %s as %i decimals', (step, want) => {
    expect(decimalsOf(step)).toBe(want);
  });
});

describe('formatLimitPrice', () => {
  it('does not collapse a sci-notation tick to an integer', () => {
    // Mirrors tests/unit/format.test.ts so the web port and core cannot drift apart.
    expect(formatLimitPrice(0.00234, 'GATE_FUTURE_X_USDT', '1e-5')).toBe('0.00234');
  });

  it.each([
    [1.2345, '1e-4', '1.2345'],
    [65432.123, '1e-2', '65432.12'],
    [2.5, '1e-3', '2.5'],
    [0.35, '1e-4', '0.35'],
  ])('snaps %f on tick %s to %s', (price, tick, want) => {
    expect(formatLimitPrice(price, 'GATE_FUTURE_X_USDT', tick)).toBe(want);
  });

  it('still snaps plain decimal ticks', () => {
    expect(formatLimitPrice(1.23456, 'GATE_FUTURE_X_USDT', '0.001')).toBe('1.235');
  });

  it('keeps the Hyperliquid 5-significant-figure cap', () => {
    // NEAREST-mode rounding — still correct for non-resting uses, but note this
    // is exactly the round-up that crosses a resting BUY onto the ask; RESTING
    // (post-only) callers must use formatRestPrice instead (tested below).
    expect(formatLimitPrice(61717.6, 'HYPERLIQUID_FUTURE_BTC_USDT', '0.1')).toBe('61718');
  });
});

// Mirrors tests/unit/format.test.ts (formatRestPrice) so the web port and core
// cannot drift apart — SingleTicket's limits always rest post-only (tif POC),
// and a client-side NEAREST snap produces a valid tick multiple the server's
// own formatRestPrice can no longer fix (its snap is a no-op on it).
describe('formatRestPrice', () => {
  it('rounds AWAY from crossing so a post-only snap cannot become a taker reject', () => {
    // Tick 0.05: a BUY must stay at/below what it asked for, a SELL at/above.
    expect(formatRestPrice(2.01, 'BUY', 'GATE_FUTURE_X_USDT', '0.05')).toBe('2');
    expect(formatRestPrice(1.99, 'SELL', 'GATE_FUTURE_X_USDT', '0.05')).toBe('2');
  });

  it('does not snap a Hyperliquid BUY up onto the ask', () => {
    // The reported case: HL BTC bid 61717 / ask 61718, tick 0.1. The web ticket
    // used formatLimitPrice on blur, whose NEAREST 5-sig-fig cap turned a
    // 61717.6 resting BUY into 61718 — exactly the ask — so the venue
    // insta-rejected the POC order, and no "price adjusted" warning fired
    // because the server saw price === input.price.
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

  it('handles sci-notation ticks (decimalsOf already parses them)', () => {
    // CrossEx rule feeds really do return ticks like "1e-4"/"1e-5".
    expect(formatRestPrice(0.00234, 'BUY', 'GATE_FUTURE_X_USDT', '1e-5')).toBe('0.00234');
    expect(formatRestPrice(0.23457, 'BUY', 'GATE_FUTURE_X_USDT', '1e-4')).toBe('0.2345');
    expect(formatRestPrice(0.23451, 'SELL', 'GATE_FUTURE_X_USDT', '1e-4')).toBe('0.2346');
  });
});
