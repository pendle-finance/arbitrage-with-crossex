import { describe, expect, it } from 'vitest';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { averagedRealize, minQtyOf, planRealize, type RealizeInput, realizedNetUsd, twapEstimateOf, type RealizePlan } from '../../src/core/rebalance/realize';
import { impactOf, twapQtysFor } from '../../src/core/rebalance/slices';
import { splitFixOf, type SplitLeg, splitPlans, splitSlices, type TwapLegRule } from '../../src/core/twap';
import { FEE_ROWS, perp, PERP_RULES } from './fixtures/realize-books';
import type { PairRow } from '../../src/engine/types';
import type { Job, Step } from '../../src/server/rebalanceJob';
import { unwindTargetOf } from '../../src/server/twapRun';

describe('splitSlices', () => {
  it.each([
    [12, [9_000, 3_000], [9, 3]],
    [5, [3_000, 9_000], [1, 4]],
    [2, [6_000_000, 50], [1, 1]],
    [100, [6_000_000, 50], [99, 1]],
    [3, [0, 0], [2, 1]],
    [7, [1], [7]],
  ])('splits %d slices across notionals %j as %j', (total, weights, counts) => {
    expect(splitSlices(total, weights)).toEqual(counts);
  });

  it('gives each leg at least one slice and keeps the total when it can', () => {
    for (const total of [2, 3, 10, 57, 100]) {
      const counts = splitSlices(total, [120_000, 4_000_000, 75]);
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(Math.max(total, 3));
    }
  });
});

describe('twapEstimateOf', () => {
  const book: NormalizedBook = {
    bids: Array.from({ length: 200 }, (_, i): [number, number] => [2999.9 - i, 50]),
    asks: Array.from({ length: 200 }, (_, i): [number, number] => [3000.1 + i, 50]),
    ts: 0,
  };
  const planOf = (qty: number) => {
    const close = impactOf(book, 'BUY', 3000, qty)!.usd;
    const reopen = impactOf(book, 'SELL', 3000, qty)!.usd;
    const leg = { symbol: 'S', side: 'SHORT' as const, closeImpactUsd: close, reopenImpactUsd: reopen };
    const estimate = (impactUsd: number) => ({ feeUsd: 7, impactUsd, totalUsd: 7 + impactUsd });
    return { legs: [leg], estimates: { maker: estimate(reopen), market: estimate(close + reopen) } } as unknown as Pick<RealizePlan, 'legs' | 'estimates'>;
  };

  it.each([
    [50, 1],
    [6_000_000, 100],
  ])('prices %d USD in %d TWAP slices from the same book walk, fees kept', (usd, slices) => {
    const qty = usd / 3000;
    const plan = planOf(qty);
    const qtys = Array.from({ length: slices }, () => qty / slices);
    const walked = (side: 'BUY' | 'SELL') => qtys.reduce((sum, part) => sum + impactOf(book, side, 3000, part)!.usd, 0);
    const market = twapEstimateOf(plan, 'market', { S: book }, { S: qtys });
    const maker = twapEstimateOf(plan, 'maker', { S: book }, { S: qtys });
    expect(market.feeUsd).toBe(7);
    expect(market.impactUsd).toBeCloseTo(walked('BUY') + walked('SELL'), 6);
    expect(maker.impactUsd).toBeCloseTo(walked('SELL'), 6);
    expect(market.totalUsd).toBeCloseTo(7 + market.impactUsd, 9);
    expect(market.impactUsd).toBeLessThanOrEqual(plan.estimates.market.impactUsd + 1e-9);
  });

  it('keeps the plan figure for a leg with no book or no slices', () => {
    const plan = planOf(10);
    expect(twapEstimateOf(plan, 'market', {}, { S: [5, 5] })).toEqual(plan.estimates.market);
    expect(twapEstimateOf(plan, 'market', { S: book }, {})).toEqual(plan.estimates.market);
  });
});

describe('splitSlices ties', () => {
  it('keeps the same split when two legs differ by a dollar', () => {
    expect(splitSlices(3, [50_000, 50_001])).toEqual(splitSlices(3, [50_000, 50_000]));
    expect(splitSlices(3, [50_000, 50_000])).toEqual([2, 1]);
  });
});

describe('unwindTargetOf for a delever', () => {
  const child = { a: { contract: 'GATE_ETH_USDT', side: 'BUY', reduceOnly: true } } as unknown as PairRow;
  const job = { kind: 'delever' } as unknown as Job;
  it.each([0.001, 2_000])('reopens the closed lead at its gap (%d ETH)', (qty) => {
    expect(unwindTargetOf(job, {} as Step, child, qty)).toEqual({ symbol: 'GATE_ETH_USDT', exchange: 'GATE', side: 'SELL', qty, reduceOnly: false });
  });
});

describe('entry averaging across realize slices', () => {
  const ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
  const deep: NormalizedBook = { bids: [[2999.95, 1e7]], asks: [[3000.05, 1e7]], ts: 0 };
  const minQty = minQtyOf(PERP_RULES[ETH], '0.0001', 3000);
  const feePerCoin = 2 * 3000 * 0.00042;
  const shortOf = (qty: number, entry: number, moveUsd: number, over: Partial<RealizeInput> = {}): RealizeInput => ({
    pool: 'HYPERLIQUID',
    moveUsd,
    cashUsd: 0,
    borrowUsd: 1e9,
    availableMargin: 1e9,
    perps: [{ ...perp(ETH, -qty, entry, 3000), maxLeverage: '25' }],
    books: { [ETH]: deep },
    feeRows: FEE_ROWS,
    rules: PERP_RULES,
    ...over,
  });
  const legOf = (input: RealizeInput) => {
    const leg = planRealize(input)?.legs[0];
    if (!leg) throw new Error('no realize leg');
    return leg;
  };

  it('100 slices of 10 ETH from 2,000 ETH at $300 a coin free about $236.5k, not $300k', () => {
    const run = averagedRealize(300, 2_000, Array.from({ length: 100 }, () => 10), 0);
    expect(run.qty).toBe(1_000);
    expect(run.realizedUsd).toBeCloseTo(2_000 * 300 * (1 - 0.995 ** 100), 6);
    expect(Math.round(run.realizedUsd / 100) * 100).toBe(236_500);
  });

  it.each([{ twapSlices: 1 }, {}])('$50 in one slice frees qty times profit (%j)', (over) => {
    const leg = legOf(shortOf(1, 3_300, 50, over));
    expect(leg.qty).toBeLessThan(1);
    expect(leg.realizedUsd).toBeCloseTo(leg.qty * 300, 9);
    expect(realizedNetUsd(leg)).toBeGreaterThanOrEqual(50 - 0.02);
  });

  it('$6M ETH in 100 TWAP slices sizes the close up so a $300k debt is still cleared', () => {
    const flat = legOf(shortOf(2_000, 3_300, 300_000, {}));
    const twap = legOf(shortOf(2_000, 3_300, 300_000, { twapSlices: 100 }));
    expect(flat.qty).toBeGreaterThan(1_000);
    expect(flat.qty).toBeLessThan(1_010);
    const flatInSlices = averagedRealize(300, 2_000, twapQtysFor(flat.qty, 100, '0.0001', minQty, Infinity), feePerCoin);
    expect(flatInSlices.realizedUsd).toBeLessThan(240_000);
    expect(twap.qty).toBeGreaterThan(1_300);
    expect(realizedNetUsd(twap)).toBeGreaterThanOrEqual(300_000 - 0.02);
    const slices = twapQtysFor(twap.qty, 100, '0.0001', minQty, Infinity);
    expect(slices).toHaveLength(100);
    expect(twap.realizedUsd).toBeCloseTo(averagedRealize(300, 2_000, slices, feePerCoin).realizedUsd, 6);
  });

  it('a default split of a $6M close also counts the averaging', () => {
    const leg = legOf(shortOf(2_000, 3_300, 300_000));
    expect(leg.qty).toBeGreaterThan(1_000);
    expect(realizedNetUsd(leg)).toBeGreaterThanOrEqual(300_000 - 0.02);
  });

  it('stops counting slices once the next one frees no cash after fees', () => {
    const leg = legOf(shortOf(100, 3_003, Infinity, { twapSlices: 100 }));
    expect(leg.qty).toBeGreaterThan(10);
    expect(leg.qty).toBeLessThan(25);
    expect(leg.closeFeeUsd).toBeCloseTo(leg.qty * 3_000 * 0.00042, 9);
  });
});

describe('a two-leg TWAP refusal', () => {
  const rule = (coin: string, lot: string, minSize: string): TwapLegRule => ({ venue: 'Hyperliquid', coin, lot, minSize, minNotional: '10', maxMarketSize: null, maxLimitSize: null });
  const eth: SplitLeg = { qty: '1', rules: [rule('ETH', '0.0001', '0.001')], mark: 3_000, bookQty: null };
  const btc: SplitLeg = { qty: '0.005', rules: [rule('BTC', '0.00001', '0.002')], mark: 100_000, bookQty: null };
  const weights = [3_000, 500];

  it('names the small leg and offers a total that fits every leg', () => {
    const counts = splitSlices(21, weights);
    expect(counts).toEqual([18, 3]);
    const rows = splitPlans(Math.floor(3_600 / 21), counts, [eth, btc]);
    expect(rows[0].refusal).toBeNull();
    expect(rows[1].refusal).toMatchObject({ field: 'sliceSize', fix: null });
    expect(rows[1].refusal?.text).toContain('BTC');
    const fix = splitFixOf({ durationSec: 3_600, slices: 21 }, eth, [eth, btc], weights);
    expect(fix).toEqual({ label: 'Use 17 slices', patch: { durationSec: 3_600, slices: 17 } });
    const fixed = splitPlans(Math.floor(3_600 / 17), splitSlices(17, weights), [eth, btc]);
    expect(fixed.every((row) => row.plan && !row.refusal)).toBe(true);
  });

  it('holds only the whole job to the 5 minute minimum, not each leg', () => {
    const counts = splitSlices(3, weights);
    expect(counts).toEqual([2, 1]);
    const rows = splitPlans(100, counts, [eth, btc]);
    expect(rows.map((row) => row.refusal)).toEqual([null, null]);
    expect(rows.map((row) => row.plan?.durationSec)).toEqual([200, 100]);
  });

  it('offers no fix when no total fits', () => {
    const tiny: SplitLeg = { ...btc, qty: '0.003' };
    expect(splitFixOf({ durationSec: 3_600, slices: 2 }, { ...eth, qty: '0.002' }, [{ ...eth, qty: '0.002' }, tiny], [6, 300])).toBeNull();
  });
});
