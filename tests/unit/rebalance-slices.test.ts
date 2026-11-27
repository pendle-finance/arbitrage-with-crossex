import { describe, expect, it } from 'vitest';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { decimalsOf, floorToStep } from '../../src/core/numbers';
import {
  DEFAULT_SLICE_CHOICES_USD,
  MAKER_SLICE_SECONDS,
  MARKET_SLICE_SECONDS,
  needsTwap,
  ONE_ORDER_USD,
  pairTwapDefaultOf,
  SLICE_IMPACT_BP,
  sliceOptions,
  sliceQtys,
  twapDefaultOf,
  twapQtysFor,
  twapSliceQty,
  twapSlicesOf,
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
    expect(sliceSizeOf({ book: eightBp, side: 'BUY', mid: MID, totalUsd })).toBe(100_000);
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
    expect(sliceQtys(50.005, 25, 0.01, '0.001')).toEqual([25, 25.005]);
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
        for (const sizeUsd of [25_000, 50_000, 100_000, 250_000]) {
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
  it('returns only the one order row, with count, impact, not hedged and seconds', () => {
    const options = sliceOptions({ book: flat(4), side: 'SELL', mid: MID, totalQty: 1000, minQty: 0.01, lot: '0.001' });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ sizeUsd: ONE_ORDER_USD, whole: true, custom: false, count: 1, notHedgedMaxQty: 1000, notHedgedMaxUsd: 1_000_000 });
    expect(options[0].impactBp).toBeCloseTo(4, 9);
    expect(options[0].impactUsd).toBeCloseTo(400, 6);
    expect(options[0].seconds).toEqual({ maker: MAKER_SLICE_SECONDS, market: MARKET_SLICE_SECONDS });
  });

  it('prices the one order by walking the book', () => {
    const stepped = book(
      [
        [1000.3, 25],
        [1002, DEEP],
      ],
      [[999.7, DEEP]],
    );
    const [full] = sliceOptions({ book: stepped, side: 'BUY', mid: MID, totalQty: 100, minQty: 0.01, lot: '0.001' });
    expect(full.count).toBe(1);
    expect(full.impactUsd).toBeCloseTo(25 * 0.3 + 75 * 2, 6);
  });

  it('walks the reopen side and marks the row past the book on either side', () => {
    const lopsided = book(
      [
        [1000.3, 25],
        [1002, DEEP],
      ],
      [[999.9, 60]],
    );
    const both = sliceOptions({ book: lopsided, side: 'BUY', mid: MID, totalQty: 100, minQty: 0.01, lot: '0.001', reopenSide: 'SELL' });
    expect(both).toHaveLength(1);
    expect(both[0].pastBook).toBe(true);
    expect(both[0].impactUsd).toBeCloseTo(25 * 0.3 + 75 * 2, 6);
    const [closeOnly] = sliceOptions({ book: lopsided, side: 'BUY', mid: MID, totalQty: 100, minQty: 0.01, lot: '0.001' });
    expect(closeOnly.reopenImpactUsd).toBe(0);
    expect(closeOnly.pastBook).toBe(false);
  });

  it('splits the one order at the venue max order size', () => {
    const input = { book: flat(4), side: 'BUY' as const, mid: MID, totalQty: 6_000, minQty: 0.011, lot: '0.001', maxUsd: 40_000 };
    expect(sliceOptions(input)).toEqual([expect.objectContaining({ sizeUsd: 40_000, whole: true, count: 150, notHedgedMaxQty: 40 })]);
    expect(sliceOptions({ ...input, maxUsd: undefined })).toEqual([expect.objectContaining({ sizeUsd: ONE_ORDER_USD, count: 1, notHedgedMaxQty: 6_000 })]);
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

describe('sliceQtys at the venue cap', () => {
  it('splits a rest below the minimum off the last slice instead of passing the cap', () => {
    expect(sliceQtys(100.002, 100, 0.003, '0.001', 100)).toEqual([99.999, 0.003]);
    expect(sliceQtys(300.002, 100, 0.003, '0.001', 100)).toEqual([100, 100, 99.999, 0.003]);
    expect(sliceQtys(100.002, 100, 0.003, '0.001')).toEqual([100.002]);
    expect(sliceQtys(100.002, 50, 0.003, '0.001', 100)).toEqual([50, 50.002]);
  });

  it('keeps the last TWAP slice under the cap', () => {
    expect(twapSliceQty(100.002, 1, 1, '0.001', 0.003, 100)).toBe(99.999);
    expect(twapQtysFor(100.002, 1, '0.001', 0.003, 100)).toEqual([99.999, 0.003]);
    expect(twapQtysFor(1, 3, '0.0001', 0.0001, Infinity)).toEqual([0.3333, 0.3333, 0.3334]);
  });
});

describe('TWAP default from the book', () => {
  const order = (bookAt: NormalizedBook | null, totalUsd: number, side: 'BUY' | 'SELL' = 'BUY') => ({ book: bookAt, side, mid: MID, qty: totalUsd / MID });
  const thin = book([[1000.1, 100]], [[999.9, 100]]);
  const ladder = book(
    [
      [1000.3, 25],
      [1002, DEEP],
    ],
    [[999.7, DEEP]],
  );

  it('turns on when one order costs more than 5 bp and slices cost less, or one order runs past the book', () => {
    expect(needsTwap(order(flat(4), 1_000_000))).toBe(false);
    expect(needsTwap(order(ladder, 1_000_000))).toBe(true);
    expect(needsTwap(order(ladder, 1_000_000, 'SELL'))).toBe(false);
    expect(needsTwap(order(thin, 1_000_000))).toBe(true);
    expect(needsTwap(order(thin, 50))).toBe(false);
    expect(needsTwap(order(null, 1_000_000))).toBe(false);
    expect(needsTwap({ ...order(ladder, 1_000_000), mid: null })).toBe(false);
  });

  it('stays off when slicing cannot lower the cost: a wide spread costs the same in every slice', () => {
    expect(needsTwap(order(flat(8), 50))).toBe(false);
    expect(needsTwap(order(flat(8), 6_000_000))).toBe(false);
  });

  it('stays off when slices save less than 1 bp', () => {
    const shallowStep = book(
      [
        [1000.5, 25],
        [1000.6, DEEP],
      ],
      [[999.5, DEEP]],
    );
    expect(needsTwap(order(shallowStep, 1_000_000))).toBe(false);
  });

  it('with no size within 5 bp, takes the largest size that costs no more than 1 bp over the cheapest', () => {
    expect(twapSlicesOf(order(flat(8), 2_000_000))).toBe(20);
  });

  it('with every size past the book, sizes the slice to half the visible depth', () => {
    const tiny = book([[1000.1, 10]], [[999.9, 10]]);
    expect(needsTwap(order(tiny, 500_000))).toBe(true);
    expect(twapSlicesOf(order(tiny, 500_000))).toBe(100);
  });

  it('counts slices at the largest of $25k, $50k or $100k that stays within 5 bp', () => {
    expect(twapSlicesOf(order(flat(4), 1_000_000))).toBe(10);
    expect(twapSlicesOf(order(ladder, 1_000_000))).toBe(40);
    expect(twapSlicesOf(order(flat(4), 50))).toBe(1);
    expect(twapSlicesOf(order(null, 1_000_000))).toBe(1);
  });

  it('spans 5 min per slice on Limit + hedge and 1 min on Market, within 2 to 100 slices and 5 min to 24 h', () => {
    expect(twapDefaultOf(true, 10)).toEqual({ on: true, maker: { durationSec: 3_000, intervalSec: 300 }, market: { durationSec: 600, intervalSec: 60 } });
    expect(twapDefaultOf(false, 1)).toEqual({ on: false, maker: { durationSec: 600, intervalSec: 300 }, market: { durationSec: 300, intervalSec: 150 } });
    expect(twapDefaultOf(true, 240)).toEqual({ on: true, maker: { durationSec: 30_000, intervalSec: 300 }, market: { durationSec: 6_000, intervalSec: 60 } });
  });

  it('a $50 order stays one order, and a $6M order runs 100 slices over 8 h 20 min', () => {
    expect(pairTwapDefaultOf([order(ladder, 50)]).on).toBe(false);
    const whale = pairTwapDefaultOf([order(ladder, 6_000_000)]);
    expect(whale.on).toBe(true);
    expect(whale.maker).toEqual({ durationSec: 30_000, intervalSec: 300 });
  });

  it('a pair takes the leg with more slices, and turns on when either leg needs it', () => {
    const pair = pairTwapDefaultOf([order(flat(4), 1_000_000, 'SELL'), order(ladder, 1_000_000)]);
    expect(pair.on).toBe(true);
    expect(pair.maker).toEqual({ durationSec: 12_000, intervalSec: 300 });
    expect(pairTwapDefaultOf([order(flat(4), 1_000_000), order(flat(4), 1_000_000, 'SELL')]).on).toBe(false);
  });
});
