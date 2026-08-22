import { describe, it, expect } from 'vitest';
import {
  direction,
  getLeverageMax,
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
    [{ notional: '500', qty: '1', refPrice: 100, legs: [leg('0.1')] }, /only one of/],
    [{ refPrice: 100, legs: [leg('0.1')] }, /provide --notional/],
    [{ qty: 'abc', refPrice: 100, legs: [leg('0.1')] }, /--qty must be a positive number/],
    [{ notional: '-5', refPrice: 100, legs: [leg('0.1')] }, /--notional must be a positive number/],
    // 5/65000 = 7.7e-5 floors to 0 at lot 0.001
    [{ notional: '5', refPrice: 65000, legs: [leg('0.001', 0.001, 5)] }, /resolved qty is 0/],
    // 0.9 is a multiple of the coarser 0.3 but not of 0.2
    [{ qty: '0.9', refPrice: 100, legs: [leg('0.3', 0.1, 0), leg('0.2', 0.1, 0)] }, /lot sizes incompatible/],
    [{ qty: '0.5', refPrice: 100, legs: [leg('0.1', 1, 0)] }, /below a leg min size/],
    [{ qty: '0.5', refPrice: 100, legs: [leg('0.1', 0.1, 100)] }, /below a leg min notional/],
  ])('throws %j', (opts, err) => {
    expect(() => resolveQty(opts)).toThrow(err);
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

describe('getLeverageMax', () => {
  const read = async (body: unknown[]) => {
    const crossEx = {
      listCrossexRuleRiskLimits: async () => ({ body }),
    } as unknown as Parameters<typeof getLeverageMax>[0];
    return getLeverageMax(crossEx, ['A', 'B']);
  };

  it.each([
    ['empty reply', []],
    ['tierless row', [{ symbol: 'A', tiers: [] }]],
    ['row with no tiers field', [{ symbol: 'A' }]],
    ['row with no positive finite tier', [{ symbol: 'A', tiers: [{ leverageMax: '0' }, { leverageMax: 'bad' }] }]],
  ])('keeps %s absent instead of manufacturing a 0x cap', async (_name, body) => {
    const max = await read(body as unknown[]);
    expect(max.has('A')).toBe(false);
  });

  it('keeps the valid symbol in a mixed batch and omits the tierless symbol', async () => {
    const max = await read([
      { symbol: 'A', tiers: [{ leverageMax: '10' }, { leverageMax: '25' }] },
      { symbol: 'B', tiers: [] },
    ]);
    expect([...max.entries()]).toEqual([['A', 25]]);
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

