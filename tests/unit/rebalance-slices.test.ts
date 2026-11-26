import { describe, expect, it } from 'vitest';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { decimalsOf, floorToStep } from '../../src/core/numbers';
import {
  DEFAULT_SLICE_CHOICES_USD,
  MAKER_SLICE_SECONDS,
  MARKET_SLICE_SECONDS,
  ONE_ORDER_USD,
  SLICE_IMPACT_BP,
  SLICE_SIZES_USD,
  sliceOptions,
  sliceQtys,
  sliceSizeOf,
} from '../../src/core/rebalance/slices';

const MID = 1000;
const DEEP = 1_000_000;
const LADDER = [50, 5_000, 100_000, 1_000_000, 6_000_000];

function book(asks: Array<[number, number]>, bids: Array<[number, number]>): NormalizedBook {
  return { asks, bids, ts: 0 };
}

const flat = (bp: number): NormalizedBook =>
  book([[MID * (1 + bp / 10_000), DEEP]], [[MID * (1 - bp / 10_000), DEEP]]);

describe('slice constants', () => {
  it('match the decided rows and figures', () => {
    expect(SLICE_SIZES_USD).toEqual([25_000, 50_000, 100_000, 250_000]);
    expect(DEFAULT_SLICE_CHOICES_USD).toEqual([25_000, 50_000, 100_000]);
    expect(SLICE_IMPACT_BP).toBe(5);
    expect(MAKER_SLICE_SECONDS).toBe(300);
    expect(MARKET_SLICE_SECONDS).toBe(2);
  });
});

describe('sliceSizeOf', () => {
  it('default slice by 5 bp rule', () => {
    const fourBp = flat(4);
    const onlySmall = book(
      [
        [1000.3, 25],
        [1002, DEEP],
      ],
      [[999.7, DEEP]],
    );
    const eightBp = flat(8);
    const totalUsd = 1_000_000;
    expect(sliceSizeOf({ book: fourBp, side: 'BUY', mid: MID, totalUsd })).toBe(100_000);
    expect(sliceSizeOf({ book: onlySmall, side: 'BUY', mid: MID, totalUsd })).toBe(25_000);
    expect(sliceSizeOf({ book: eightBp, side: 'BUY', mid: MID, totalUsd })).toBe(25_000);
    expect(sliceSizeOf({ book: fourBp, side: 'SELL', mid: MID, totalUsd })).toBe(100_000);
  });

  it('picks $50k when $100k costs more than 5 bp', () => {
    const middle = book(
      [
        [1000.3, 50],
        [1002, DEEP],
      ],
      [[999.7, DEEP]],
    );
    expect(sliceSizeOf({ book: middle, side: 'BUY', mid: MID, totalUsd: 1_000_000 })).toBe(50_000);
  });

  it('walks the bids for a sell', () => {
    const thinBids = book(
      [[1000.1, DEEP]],
      [
        [999.9, 25],
        [990, DEEP],
      ],
    );
    expect(sliceSizeOf({ book: thinBids, side: 'BUY', mid: MID, totalUsd: 1_000_000 })).toBe(100_000);
    expect(sliceSizeOf({ book: thinBids, side: 'SELL', mid: MID, totalUsd: 1_000_000 })).toBe(25_000);
  });

  it('passes a book at exactly 5 bp', () => {
    expect(sliceSizeOf({ book: flat(5), side: 'BUY', mid: MID, totalUsd: 6_000_000 })).toBe(100_000);
  });

  it('never returns more than the total', () => {
    expect(sliceSizeOf({ book: flat(4), side: 'BUY', mid: MID, totalUsd: 60_000 })).toBe(60_000);
    expect(sliceSizeOf({ book: flat(8), side: 'BUY', mid: MID, totalUsd: 10_000 })).toBe(10_000);
    expect(sliceSizeOf({ book: null, side: 'BUY', mid: MID, totalUsd: 50 })).toBe(50);
    expect(sliceSizeOf({ book: flat(4), side: 'BUY', mid: MID, totalUsd: 0 })).toBe(0);
  });

  it('counts a walk past the book as over the rule, and a missing book as $25k', () => {
    const shallow = book([[1000.1, 30]], [[999.9, DEEP]]);
    expect(sliceSizeOf({ book: shallow, side: 'BUY', mid: MID, totalUsd: 1_000_000 })).toBe(25_000);
    expect(sliceSizeOf({ book: null, side: 'BUY', mid: MID, totalUsd: 1_000_000 })).toBe(25_000);
  });
});

describe('sliceQtys', () => {
  it('dust joins the last slice', () => {
    expect(sliceQtys(2.00005, 1, 0.0001, '0.00001')).toEqual([1, 1.00005]);
    expect(sliceQtys(2.5, 1, 0.0001, '0.00001')).toEqual([1, 1, 0.5]);
    expect(sliceQtys(3, 1, 0.0001, '0.00001')).toEqual([1, 1, 1]);
    const options = sliceOptions({ book: flat(4), side: 'BUY', mid: MID, totalQty: 50.005, minQty: 0.01, lot: '0.001' });
    const row = options.find((option) => option.sizeUsd === 25_000);
    expect(row?.count).toBe(2);
    expect(row?.notHedgedMaxQty).toBe(25.005);
  });

  it('sends a total below the minimum as one slice, and nothing for zero', () => {
    expect(sliceQtys(0.00005, 1, 0.0001, '0.00001')).toEqual([0.00005]);
    expect(sliceQtys(0, 1, 0.0001, '0.00001')).toEqual([]);
  });

  it('raises a slice below the venue minimum to the minimum', () => {
    expect(sliceQtys(0.05, 0.001, 0.02, '0.001')).toEqual([0.02, 0.03]);
  });

  it('rounding holds at every rung', () => {
    const markets = [
      { mid: 97_123.45, lot: '0.00001', minQty: 0.0002 },
      { mid: 3_012.7, lot: '0.001', minQty: 0.004 },
      { mid: 0.0000123, lot: '1', minQty: 813_009 },
    ];
    for (const { mid, lot, minQty } of markets) {
      const step = Number(lot);
      const decimals = decimalsOf(lot);
      for (const rung of LADDER) {
        const baseLots = Math.round(Number(floorToStep(rung / mid, lot)) / step);
        const totalQty = (baseLots + 0.99) * step;
        const minLots = Math.ceil(minQty / step - 1e-9);
        for (const sizeUsd of SLICE_SIZES_USD) {
          const qtys = sliceQtys(totalQty, sizeUsd / mid, minQty, lot);
          const lots = qtys.map((qty) => Math.round(qty / step));
          for (const qty of qtys) expect(Number(qty.toFixed(decimals))).toBe(qty);
          expect(lots.reduce((total, n) => total + n, 0)).toBe(baseLots);
          const sliceLots = Math.min(baseLots, Math.max(1, minLots, Math.round(Number(floorToStep(sizeUsd / mid, lot)) / step)));
          for (const n of lots.slice(0, -1)) expect(n).toBe(sliceLots);
          const last = lots[lots.length - 1];
          expect(last).toBeLessThan(sliceLots + Math.max(1, minLots));
          if (lots.length > 1) expect(last).toBeGreaterThanOrEqual(minLots);
        }
      }
    }
  });
});

describe('sliceOptions', () => {
  it('returns the four rows and one order, with count, impact, not hedged and seconds', () => {
    const options = sliceOptions({ book: flat(4), side: 'SELL', mid: MID, totalQty: 1000, minQty: 0.01, lot: '0.001' });
    expect(options.map((option) => option.sizeUsd)).toEqual([25_000, 50_000, 100_000, 250_000, ONE_ORDER_USD]);
    expect(options.map((option) => option.whole)).toEqual([false, false, false, false, true]);
    expect(options.every((option) => !option.custom)).toBe(true);
    expect(options[4]).toMatchObject({ count: 1, notHedgedMaxQty: 1000, notHedgedMaxUsd: 1_000_000 });
    const [small, , , large] = options;
    expect(small.count).toBe(40);
    expect(small.impactBp).toBeCloseTo(4, 9);
    expect(small.impactUsd).toBeCloseTo(400, 6);
    expect(small.notHedgedMaxQty).toBe(25);
    expect(small.notHedgedMaxUsd).toBe(25_000);
    expect(small.seconds).toEqual({ maker: 40 * MAKER_SLICE_SECONDS, market: 40 * MARKET_SLICE_SECONDS });
    expect(large.count).toBe(4);
    expect(large.seconds).toEqual({ maker: 1200, market: 8 });
  });

  it('prices impact per slice on a fresh book, and the job impact over every slice', () => {
    const stepped = book(
      [
        [1000.3, 25],
        [1002, DEEP],
      ],
      [[999.7, DEEP]],
    );
    const options = sliceOptions({ book: stepped, side: 'BUY', mid: MID, totalQty: 100, minQty: 0.01, lot: '0.001' });
    const [small, mid50, full] = options;
    expect(small.impactBp).toBeCloseTo(3, 9);
    expect(small.impactUsd).toBeCloseTo(30, 6);
    expect(mid50.impactBp).toBeCloseTo(11.5, 9);
    expect(full.count).toBe(1);
    expect(full.impactUsd).toBeCloseTo(25 * 0.3 + 75 * 2, 6);
  });

  it('walks the reopen side per slice and marks a row past the book on either side', () => {
    const lopsided = book(
      [
        [1000.3, 25],
        [1002, DEEP],
      ],
      [[999.9, 60]],
    );
    const both = sliceOptions({ book: lopsided, side: 'BUY', mid: MID, totalQty: 100, minQty: 0.01, lot: '0.001', reopenSide: 'SELL' });
    const [small, half, full] = both;
    expect(small.reopenImpactUsd).toBeCloseTo(4 * 25 * 0.1, 6);
    expect(half.reopenImpactUsd).toBeCloseTo(2 * 50 * 0.1, 6);
    expect(both.map((option) => option.pastBook)).toEqual([false, false, true, true, true]);
    expect(full.impactUsd).toBeCloseTo(25 * 0.3 + 75 * 2, 6);
    const closeOnly = sliceOptions({ book: lopsided, side: 'BUY', mid: MID, totalQty: 100, minQty: 0.01, lot: '0.001' });
    expect(closeOnly.map((option) => option.reopenImpactUsd)).toEqual([0, 0, 0, 0, 0]);
    expect(closeOnly.map((option) => option.pastBook)).toEqual([false, false, false, false, false]);
  });

  it('caps every row at the total', () => {
    const options = sliceOptions({ book: flat(4), side: 'BUY', mid: MID, totalQty: 30, minQty: 0.01, lot: '0.001' });
    expect(options.map((option) => option.count)).toEqual([2, 1, 1, 1, 1]);
    expect(options[3].notHedgedMaxQty).toBe(30);
    expect(options[3].notHedgedMaxUsd).toBe(30_000);
  });

  it('custom slice clamps to min and total', () => {
    const input = { book: flat(4), side: 'BUY' as const, mid: MID, totalQty: 300, minQty: 0.011, lot: '0.001' };
    const low = sliceOptions({ ...input, customUsd: 1 });
    expect(low).toHaveLength(6);
    const lowRow = low[4];
    expect(lowRow.custom).toBe(true);
    expect(lowRow.sizeUsd).toBeCloseTo(11, 9);
    expect(lowRow.notHedgedMaxQty).toBeGreaterThanOrEqual(0.011);
    expect(lowRow.count).toBe(27_272);
    const high = sliceOptions({ ...input, customUsd: 1e9 })[4];
    expect(high.sizeUsd).toBe(300_000);
    expect(high.count).toBe(1);
    expect(high.notHedgedMaxQty).toBe(300);
    const inside = sliceOptions({ ...input, customUsd: 75_000 })[4];
    expect(inside.sizeUsd).toBe(75_000);
    expect(inside.count).toBe(4);
    expect(inside.notHedgedMaxQty).toBe(75);
    expect(sliceOptions(input)).toHaveLength(5);
    expect(sliceOptions({ ...input, customUsd: Number.NaN })).toHaveLength(5);
  });

  it('no slice is bigger than the venue max order size', () => {
    const input = { book: flat(4), side: 'BUY' as const, mid: MID, totalQty: 6_000, minQty: 0.011, lot: '0.001', maxUsd: 40_000 };
    const options = sliceOptions({ ...input, customUsd: 6_000_000 });
    expect(options.map((option) => option.sizeUsd)).toEqual([25_000, 50_000, 100_000, 250_000, 40_000, 40_000]);
    expect(options.map((option) => option.notHedgedMaxQty)).toEqual([25, 40, 40, 40, 40, 40]);
    expect(options[4].count).toBe(150);
    expect(options[5]).toMatchObject({ whole: true, count: 150 });
    const free = sliceOptions({ ...input, maxUsd: undefined, customUsd: 6_000_000 })[4];
    expect(free.sizeUsd).toBe(6_000_000);
    expect(free.count).toBe(1);
  });

  it('returns no rows without a book, a mid or a total', () => {
    const base = { side: 'BUY' as const, mid: MID, totalQty: 10, minQty: 0.01, lot: '0.001' };
    expect(sliceOptions({ ...base, book: null })).toEqual([]);
    expect(sliceOptions({ ...base, book: book([], []) })).toEqual([]);
    expect(sliceOptions({ ...base, book: flat(4), mid: 0 })).toEqual([]);
    expect(sliceOptions({ ...base, book: flat(4), totalQty: 0 })).toEqual([]);
  });

  it('holds at every rung of the size ladder', () => {
    for (const rung of LADDER) {
      const totalQty = rung / MID;
      const options = sliceOptions({ book: flat(4), side: 'BUY', mid: MID, totalQty, minQty: 0.011, lot: '0.001' });
      for (const option of options) {
        expect(option.notHedgedMaxUsd).toBeLessThanOrEqual(Math.max(option.sizeUsd, 11) + 11 + 1e-6);
        expect(option.impactUsd).toBeCloseTo(Number(floorToStep(totalQty, '0.001')) * MID * 0.0004, 4);
      }
    }
  });
});
