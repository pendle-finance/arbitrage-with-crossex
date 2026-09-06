import { describe, it, expect } from 'vitest';
import {
  direction,
  resolveQty,
  isMultipleOf,
  marketableClosePrice,
  type QtyLeg,
} from '../../src/core/orders';

describe('direction', () => {
  it.each<[string | undefined, number | string, 'LONG' | 'SHORT']>([
    ['LONG', '-5', 'LONG'], // explicit side wins over qty sign
    [undefined, '-0.5', 'SHORT'],
    ['', '0', 'LONG'], // 0 is >= 0
    ['short', 1, 'SHORT'], // side is uppercased before matching, so 'short' counts as explicit
    [undefined, 2, 'LONG'],
    ['garbage', '-1', 'SHORT'], // unrecognized side falls back to qty sign
  ])('(%j, %j) -> %s', (side, qty, want) => {
    expect(direction(side, qty)).toBe(want);
  });
});

const leg = (lotSize: string, minSize = 0, minNotional = 0): QtyLeg => ({ lotSize, minSize, minNotional });

describe('resolveQty', () => {
  it('notional path: floors to the coarsest lot across legs', () => {
    const r = resolveQty({
      notional: '500',
      refPrice: 65000,
      legs: [leg('0.001', 0.001, 5), leg('0.0001', 0.0001, 5)],
    });
    expect(r.qtyStr).toBe('0.007'); // 500/65000 = 0.00769.. floored to lot 0.001
    expect(r.qty).toBe(0.007);
    expect(r.estNotional).toBe(455); // 0.007*65000 rounds to exactly 455 in doubles
  });

  it('qty path passes through when already on the lot', () => {
    const r = resolveQty({ qty: '0.5', refPrice: 100, legs: [leg('0.1', 0.1, 0)] });
    expect(r.qtyStr).toBe('0.5');
    expect(r.qty).toBe(0.5);
    expect(r.estNotional).toBe(50);
  });

  it.each<[Parameters<typeof resolveQty>[0], RegExp]>([
    [{ notional: '500', qty: '1', refPrice: 100, legs: [leg('0.1')] }, /in coins or in dollars, not both/],
    [{ refPrice: 100, legs: [leg('0.1')] }, /enter a size/],
    [{ qty: 'abc', refPrice: 100, legs: [leg('0.1')] }, /size must be a positive number/],
    [{ notional: '-5', refPrice: 100, legs: [leg('0.1')] }, /dollar size must be a positive number/],
    // 5/65000 = 7.7e-5 floors to 0 at lot 0.001
    [{ notional: '5', refPrice: 65000, legs: [leg('0.001', 0.001, 5)] }, /rounds down to zero/],
    // 0.9 is a multiple of the coarser 0.3 but not of 0.2
    [{ qty: '0.9', refPrice: 100, legs: [leg('0.3', 0.1, 0), leg('0.2', 0.1, 0)] }, /lot sizes do not fit together/],
    [{ qty: '0.5', refPrice: 100, legs: [leg('0.1', 1, 0)] }, /below a leg's minimum size of 1/],
    [{ qty: '0.5', refPrice: 100, legs: [leg('0.1', 0.1, 100)] }, /below a leg's minimum order value of 100/],
  ])('throws %j', (opts, err) => {
    expect(() => resolveQty(opts)).toThrow(err);
  });

  /** These strings are rendered verbatim in the browser's violation list. There is
   * no CLI any more, so a `--flag` in one is a dead instruction to a trader — the
   * bug this guards against was `increase --notional` reaching the order ticket. */
  it('names the venue at fault and never tells a trader to pass a flag', () => {
    const gate = (min: number, minNotional = 0): QtyLeg => ({
      symbol: 'GATE:BTC_USDT',
      lotSize: '0.1',
      minSize: min,
      minNotional,
    });
    const thrown = [
      () => resolveQty({ qty: '0.5', refPrice: 100, legs: [gate(1)] }),
      () => resolveQty({ qty: '0.5', refPrice: 100, legs: [gate(0.1, 100)] }),
      () => resolveQty({ notional: '500', qty: '1', refPrice: 100, legs: [gate(0)] }),
      () => resolveQty({ refPrice: 100, legs: [gate(0)] }),
      () => resolveQty({ qty: 'abc', refPrice: 100, legs: [gate(0)] }),
      () => resolveQty({ notional: '-5', refPrice: 100, legs: [gate(0)] }),
      () => resolveQty({ notional: '0.01', refPrice: 1, legs: [gate(0)] }), // floors to 0 at lot 0.1
    ].map((f) => {
      try {
        f();
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    });

    expect(thrown.every((m) => m !== '')).toBe(true);
    for (const m of thrown) expect(m).not.toMatch(/--\w/);
    // The two that blame one leg say which leg it is.
    expect(thrown[0]).toBe("size 0.5 is below GATE:BTC_USDT's minimum size of 1");
    expect(thrown[1]).toBe(
      "this size is worth 50.00, below GATE:BTC_USDT's minimum order value of 100 — increase it",
    );
  });

  it('minNotional of 0 is skipped', () => {
    expect(() => resolveQty({ qty: '0.1', refPrice: 1, legs: [leg('0.1', 0.1, 0)] })).not.toThrow();
  });
});

describe('isMultipleOf', () => {
  it.each<[number, string, boolean]>([
    [0.30000000000000004, '0.1', true], // float noise within the 1e-9 tolerance
    [0.9, '0.2', false],
    [1.23, '0', true], // non-positive step -> vacuously true
    [1.23, '', true], // Number('') === 0 -> vacuously true
    [0.007, '0.0001', true],
  ])('(%d, %j) -> %s', (qty, step, want) => {
    expect(isMultipleOf(qty, step)).toBe(want);
  });
});

describe('marketableClosePrice', () => {
  it('crosses the spread by slippagePct and snaps to tick', () => {
    expect(marketableClosePrice(65000, 'SELL', 0.5, 'GATE_FUTURE_BTC_USDT', '0.1')).toBe('64675');
    expect(marketableClosePrice(65000, 'BUY', 0.5, 'GATE_FUTURE_BTC_USDT', '0.1')).toBe('65325');
  });

  // Rounding directionally (away from mark) keeps the price marketable even
  // on COARSE ticks — where nearest-rounding used to snap back onto/across the mark.
  it.each<[number, string]>([
    [0.05, '0.00001'],
    [1.2345, '0.0001'],
    [65000, '0.1'],
    [2.0, '0.05'], // the previously-failing coarse case
    [1.2345, '0.1'], // coarse tick relative to mark
  ])('SELL < mark %d < BUY for every slippage (tick %s)', (mark, tick) => {
    for (const slip of [0.1, 0.5, 2]) {
      const sell = Number(marketableClosePrice(mark, 'SELL', slip, 'GATE_FUTURE_X_USDT', tick));
      const buy = Number(marketableClosePrice(mark, 'BUY', slip, 'GATE_FUTURE_X_USDT', tick));
      expect(sell).toBeLessThan(mark);
      expect(buy).toBeGreaterThan(mark);
    }
  });

  it('the exact coarse-tick case that used to no-fill: mark 2.00, tick 0.05, 0.5%', () => {
    // Old nearest-rounding: SELL 2.01→2.00=mark, BUY 2.01→2.00=mark (IOC would not cross).
    expect(marketableClosePrice(2.0, 'SELL', 0.5, 'GATE_FUTURE_X_USDT', '0.05')).toBe('1.95');
    expect(marketableClosePrice(2.0, 'BUY', 0.5, 'GATE_FUTURE_X_USDT', '0.05')).toBe('2.05');
  });

  it('caps HYPERLIQUID symbols to 5 significant figures (still marketable-side)', () => {
    const sell = marketableClosePrice(65432.1, 'SELL', 0.5, 'HYPERLIQUID_FUTURE_BTC_USDT', '0.1');
    const buy = marketableClosePrice(65432.1, 'BUY', 0.5, 'HYPERLIQUID_FUTURE_BTC_USDT', '0.1');
    expect(Number(sell)).toBeLessThan(65432.1);
    expect(Number(buy)).toBeGreaterThan(65432.1);
    for (const p of [sell, buy]) expect(p.replace(/[.-]/g, '').replace(/^0+/, '').length).toBeLessThanOrEqual(5);
  });
});

