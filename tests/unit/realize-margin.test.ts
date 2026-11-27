import { describe, expect, it } from 'vitest';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { ceilCents, CONVERT_RATE } from '../../src/core/rebalance/plan';
import { takerAfterCapSec } from '../../src/core/twap';
import { closeSecondsOf, convertMinOf, DRIFT_DEFAULT_SEC, nakedSecondsOf, driftShareOf, MIN_CONVERT_RATIO, exposureUsdOf, GAP_CONVERT_SEC, PLAN_CASH_HEADROOM, PLAN_CONVERT_RATIO, planRealize, realizePlanOf, sliceReserveUsd, twapEstimateOf, type RealizeInput } from '../../src/core/rebalance/realize';
import { impactOf } from '../../src/core/rebalance/slices';
import { newJob } from '../../src/server/rebalanceJob';
import { FEE_ROWS, PERP_RULES } from './fixtures/realize-books';

const BTC = 'HYPERLIQUID_FUTURE_BTC_USDC';
const GATE_BTC = 'GATE_FUTURE_BTC_USDT';
const MARK = 95_000;
const LOT = 0.00001;
const TAKER = 0.00042;
const LIFT = 0.2 * (1 - 0.0023) - 0.0023;
const DEEP: NormalizedBook = { bids: [[MARK - 0.5, 1e6]], asks: [[MARK + 0.5, 1e6]], ts: 0 };
const RUNGS = [
  { usd: 50, slices: 1 },
  { usd: 5_000, slices: 1 },
  { usd: 100_000, slices: 2 },
  { usd: 1_000_000, slices: 20 },
  { usd: 6_000_000, slices: 100 },
];

interface Case {
  usd: number;
  slices: number;
  free?: number;
  ratio?: number;
  entry?: number;
  cash?: number;
  equity?: number;
  leverage?: number;
  sliceSec?: number;
  exec?: 'maker' | 'market';
}

function caseOf(c: Case) {
  const qty = Number((c.usd / MARK).toFixed(5));
  const profit = (c.entry ?? 98_000) - MARK;
  const perCoin = MARK / (c.leverage ?? 10);
  const im = 2 * qty * perCoin + 0.2 * qty * profit;
  const marginBalance = c.ratio !== undefined ? c.ratio * im : im + (c.free ?? 0);
  const free = marginBalance - im;
  const cash = c.cash ?? 0;
  const input: RealizeInput = {
    pool: 'HYPERLIQUID',
    moveUsd: 1e12,
    cashUsd: cash,
    borrowUsd: qty * profit,
    availableMargin: free,
    equityUsd: c.equity ?? cash + qty * profit,
    marginBalance,
    initialMargin: im,
    borrowImRate: 0.2,
    perps: [
      { symbol: BTC, positionQty: String(-qty), entryPrice: String(c.entry ?? 98_000), markPrice: String(MARK), initialMargin: String(qty * perCoin) },
      { symbol: GATE_BTC, positionQty: String(qty), entryPrice: String(c.entry ?? 98_000), markPrice: String(MARK), initialMargin: String(qty * perCoin) },
    ],
    books: { [BTC]: DEEP },
    feeRows: FEE_ROWS,
    rules: PERP_RULES,
    twapSlices: c.slices,
    ...(c.sliceSec !== undefined ? { twapSliceSec: c.sliceSec } : {}),
    ...(c.exec ? { exec: c.exec } : {}),
  };
  const exposureUsd = exposureUsdOf({ legImUsd: qty * perCoin, hedgeImUsd: qty * perCoin, notionalUsd: qty * MARK, debtRate: 0.2 });
  const closeOf = (q: number) => q * MARK * TAKER + q * 0.5;
  const reserveOf = (q: number, gap = true) =>
    sliceReserveUsd({ qty: q, price: MARK, marginPerCoin: perCoin, impactUsd: q * 0.5, seconds: c.sliceSec ?? DRIFT_DEFAULT_SEC, exposureUsd, nakedUsd: gap ? q * MARK : 0 });
  const convertOf = (q: number, gap = true) => Math.max(11, ceilCents((reserveOf(q, gap) + closeOf(q) - free) / LIFT));
  const ratioAfter = (q: number) => (marginBalance - closeOf(q)) / (im - q * perCoin);
  const cashAfter = (q: number) => Math.min(cash + q * profit - closeOf(q), (c.equity ?? cash + qty * profit) - closeOf(q), (qty * profit) / 0.998);
  return { qty, profit, perCoin, im, marginBalance, free, exposureUsd, input, closeOf, reserveOf, convertOf, ratioAfter, cashAfter, plan: planRealize(input) };
}

describe('the shared slice reserve', () => {
  it('is the preflight fee and margin buffer, plus impact, plus a 3-sigma drift at 1% an hour on the whole book, plus the naked slice over the close and the Convert', () => {
    expect(driftShareOf(3_600)).toBeCloseTo(0.03, 12);
    const exposureUsd = exposureUsdOf({ legImUsd: 30_000, hedgeImUsd: 20_000, notionalUsd: 600_000, debtRate: 0.2 });
    expect(exposureUsd).toBe(170_000);
    expect(sliceReserveUsd({ qty: 2, price: 3_000, marginPerCoin: 150, impactUsd: 4, seconds: 3_600, exposureUsd, nakedUsd: 6_000 })).toBeCloseTo(
      2 * 3_000 * 0.002 + 2 * 150 * 0.05 + 4 + 170_000 * 0.03 + 6_000 * driftShareOf(3_600 + GAP_CONVERT_SEC),
      9,
    );
    expect(sliceReserveUsd({ qty: 2, price: 3_000, marginPerCoin: 150, impactUsd: 4, seconds: 3_600, exposureUsd, nakedUsd: 6_000, nakedSec: GAP_CONVERT_SEC })).toBeCloseTo(
      2 * 3_000 * 0.002 + 2 * 150 * 0.05 + 4 + 170_000 * 0.03 + 6_000 * driftShareOf(GAP_CONVERT_SEC),
      9,
    );
  });

  it.each([
    [1_000_000, 20, 50_000, 866],
    [6_000_000, 100, 60_000, 5_196],
    [6_000_000, 20, 300_000, 5_196],
  ])('a $%d book at 20x in %d maker slices of $%d reserves the $%d 3-sigma book drift over 300 s, not one slice of it', (book, _slices, slice, drift) => {
    const exposureUsd = exposureUsdOf({ legImUsd: book / 20, hedgeImUsd: book / 20, notionalUsd: book, debtRate: 0 });
    const reserve = sliceReserveUsd({ qty: slice / 100_000, price: 100_000, marginPerCoin: 5_000, impactUsd: 0, seconds: 300, exposureUsd });
    expect(reserve - slice * 0.002 - slice * 0.05 * 0.05).toBeCloseTo(drift, -1);
  });
});

describe('Realize margin at slice 1, by rung', () => {
  it.each(RUNGS)('free margin at +1.2%% of the run needs no Convert ($usd)', ({ usd, slices }) => {
    const { plan } = caseOf({ usd, slices, free: 0.012 * usd });
    expect(plan?.refused).toBeNull();
    expect(plan?.legs[0].convert).toBeNull();
    expect(plan?.legs[0].margin ?? null).toBeNull();
  });

  it.each(RUNGS.slice(1))('at -0.2%% free margin slice 1 is the smallest size whose close leaves 105%% and whose cash lifts the reopen with 10%% to spare ($usd)', ({ usd, slices }) => {
    const c = caseOf({ usd, slices, free: -0.002 * usd, entry: 110_000 });
    const leg = c.plan?.legs[0];
    expect(c.plan?.refused).toBeNull();
    expect(leg?.margin?.at).toBe('gap');
    const q1 = leg?.margin?.firstQty ?? 0;
    expect(q1).toBeGreaterThan(0);
    expect(q1).toBeLessThanOrEqual(c.qty);
    expect(c.ratioAfter(q1)).toBeGreaterThanOrEqual(PLAN_CONVERT_RATIO);
    const under = Number((q1 - LOT).toFixed(5));
    const twapFirst = Number((c.qty / slices).toFixed(5));
    if (q1 > twapFirst + LOT / 2 && q1 < c.qty) expect(c.ratioAfter(under) < PLAN_CONVERT_RATIO || PLAN_CASH_HEADROOM * c.convertOf(under) > c.cashAfter(under)).toBe(true);
    const convert = leg?.margin?.amount ?? 0;
    expect(Math.abs(convert - c.convertOf(q1))).toBeLessThanOrEqual(0.02);
    expect(c.free + LIFT * convert - c.closeOf(q1)).toBeGreaterThanOrEqual(c.reserveOf(q1) - 0.01);
    expect(PLAN_CASH_HEADROOM * convert).toBeLessThanOrEqual(c.cashAfter(q1) + 0.01);
    expect(leg?.convert?.amount).toBe(convert);
    expect(leg?.margin?.impactUsd).toBeCloseTo(q1, 6);
  });

  it('at $50 and -0.2% free margin the 11 USDC minimum is more than the whole leg frees, so it refuses', () => {
    const { plan } = caseOf({ usd: 50, slices: 1, free: -0.1, entry: 110_000 });
    expect(plan?.refused).toEqual({ reason: 'no-margin', bp: null });
  });

  it.each(RUNGS)('a $3,000-a-coin profit at -0.2%% free margin cannot fund any slice 1, so it refuses at the start ($usd)', ({ usd, slices }) => {
    const { plan } = caseOf({ usd, slices, free: -0.002 * usd });
    expect(plan?.refused).toEqual({ reason: 'no-margin', bp: null });
  });

  it.each(RUNGS.slice(1))('a losing perp in the paying wallet caps the Convert at that wallet equity and refuses ($usd)', ({ usd, slices }) => {
    const qty = Number((usd / MARK).toFixed(5));
    const { plan } = caseOf({ usd, slices, free: -0.002 * usd, entry: 110_000, equity: 0.01 * qty * 15_000 });
    expect(plan?.refused).toEqual({ reason: 'no-margin', bp: null });
  });
});

describe('Realize margin: the 103% ratio rule for a Convert, by rung', () => {
  it.each(RUNGS.slice(1))('cash that covers the Convert at a 106%% ratio converts before slice 1, hedged, sized for slice 1 only ($usd)', ({ usd }) => {
    const slices = 1;
    const c = caseOf({ usd, slices, ratio: 1.06, cash: 2 * usd, leverage: 40 });
    const leg = c.plan?.legs[0];
    expect(c.plan?.refused).toBeNull();
    expect(leg?.margin?.at).toBe('before');
    const first = leg?.margin?.firstQty ?? 0;
    expect(Math.abs(first - c.qty / slices)).toBeLessThanOrEqual(LOT);
    expect(Math.abs((leg?.margin?.amount ?? 0) - c.convertOf(first, false))).toBeLessThanOrEqual(0.02);
    const job = newJob({ route: 'convert', steps: [], amount: 0, costUsd: 0, target: [], userId: null, realize: c.plan }, 0);
    expect(job.steps.at(-1)?.name).toBe('Slices');
    expect(job.steps[0]).toMatchObject({ name: 'Convert', from: 'HYPERLIQUID', to: 'CROSSEX', leg: BTC });
  });

  it.each(RUNGS.slice(1))('at a ratio of exactly 103%% the Convert still runs before slice 1, and just under it goes inside slice 1 ($usd)', ({ usd }) => {
    const at = caseOf({ usd, slices: 1, ratio: 1.03, cash: 2 * usd, leverage: 40, entry: 110_000 });
    const under = caseOf({ usd, slices: 1, ratio: 1.0299, cash: 2 * usd, leverage: 40, entry: 110_000 });
    expect(at.plan?.legs[0].margin?.at).toBe('before');
    expect(under.plan?.legs[0].margin?.at).toBe('gap');
    const job = newJob({ route: 'convert', steps: [], amount: 0, costUsd: 0, target: [], userId: null, realize: under.plan }, 0);
    expect(job.steps[0].name).toBe('Slices');
    expect(job.realize?.legs[0].margin).toEqual(under.plan?.legs[0].margin);
  });

  it.each(RUNGS.slice(1))('at a 100%% ratio and 100 TWAP slices, slice 1 grows to the first lot whose close leaves 105%% and 10%% spare cash ($usd)', ({ usd }) => {
    const c = caseOf({ usd, slices: 100, ratio: 1, entry: 110_000 });
    const q1 = c.plan?.legs[0].margin?.firstQty ?? 0;
    expect(c.plan?.refused).toBeNull();
    expect(c.plan?.legs[0].margin?.at).toBe('gap');
    expect(c.ratioAfter(q1)).toBeGreaterThanOrEqual(PLAN_CONVERT_RATIO);
    const under = Number((q1 - LOT).toFixed(5));
    expect(c.ratioAfter(under) < PLAN_CONVERT_RATIO || PLAN_CASH_HEADROOM * c.convertOf(under) > c.cashAfter(under)).toBe(true);
  });

  it.each(RUNGS.slice(1))('a 24-hour TWAP of 2-hour slices reserves more drift than a 5-minute one, so its Convert is larger ($usd)', ({ usd }) => {
    const short = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40, entry: 110_000, sliceSec: 300, exec: 'market' });
    const long = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40, entry: 110_000, sliceSec: 7_200, exec: 'market' });
    const shortAmount = short.plan?.legs[0].margin?.amount ?? 0;
    const longAmount = long.plan?.legs[0].margin?.amount ?? 0;
    expect(Math.abs(longAmount - long.convertOf(long.qty, false))).toBeLessThanOrEqual(0.02);
    expect(longAmount - shortAmount).toBeCloseTo((long.exposureUsd * (driftShareOf(7_200) - driftShareOf(300))) / LIFT, -1);
  });

  it.each(RUNGS.slice(1))('cash the Convert cannot reach does not make the plan Convert before slice 1 ($usd)', ({ usd }) => {
    const c = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40 });
    expect(c.plan?.legs[0].margin?.at).toBe('before');
    const unreachable = planRealize({ ...c.input, convertCashUsd: 0 });
    expect(unreachable?.legs[0].margin?.at ?? null).not.toBe('before');
  });

  it.each(RUNGS)('at an 83%% ratio no slice 1 can bring free margin back, because the debt caps the Convert, so it refuses ($usd)', ({ usd, slices }) => {
    const c = caseOf({ usd, slices, ratio: 0.83, cash: 2 * usd, entry: 110_000 });
    expect(c.plan?.refused).toEqual({ reason: 'no-margin', bp: null });
    expect(c.convertOf(c.qty)).toBeGreaterThan((c.qty * c.profit) / 0.998);
  });

  it.each(RUNGS.slice(1))('the Convert never pays more than the debt, so a tiny debt blocks the pre-Convert ($usd)', ({ usd }) => {
    const c = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40 });
    expect(c.plan?.legs[0].margin?.at).toBe('before');
    const tiny = planRealize({ ...c.input, borrowUsd: 1 });
    expect(tiny?.legs[0].margin?.at ?? 'gap').not.toBe('before');
  });
});

describe('Realize margin: the slice-1 search never skips a size that fits', () => {
  const QTY = 10.52632;
  const PER_COIN = MARK / 20;
  const inputOf = (twapSlices: number): RealizeInput => ({
    pool: 'HYPERLIQUID',
    moveUsd: 1e12,
    cashUsd: 30_000,
    borrowUsd: 30_000,
    availableMargin: 100,
    equityUsd: 30_000 + QTY * 500,
    marginBalance: 100_100,
    initialMargin: 100_000,
    borrowImRate: 0.2,
    perps: [{ symbol: BTC, positionQty: String(-QTY), entryPrice: '95500', markPrice: String(MARK), initialMargin: String(QTY * PER_COIN) }],
    books: { [BTC]: DEEP },
    feeRows: FEE_ROWS,
    rules: PERP_RULES,
    twapSlices,
  });

  const exposureUsd = exposureUsdOf({ legImUsd: QTY * PER_COIN, hedgeImUsd: 0, notionalUsd: QTY * MARK, debtRate: 0.2 });
  const closeOf = (q: number) => q * MARK * TAKER + q * 0.5;
  const convertOf = (q: number) =>
    Math.max(11, ceilCents((sliceReserveUsd({ qty: q, price: MARK, marginPerCoin: PER_COIN, impactUsd: q * 0.5, seconds: DRIFT_DEFAULT_SEC, exposureUsd, nakedUsd: q * MARK }) + closeOf(q) - 100) / LIFT));
  const ratioOf = (q: number) => (100_100 - closeOf(q)) / (100_000 - q * PER_COIN);
  const cashOf = (q: number) => Math.min(30_000 + q * 500 - closeOf(q), 30_000 + QTY * 500 - closeOf(q), 30_000 / 0.998);
  const fits = (q: number) => ratioOf(q) >= PLAN_CONVERT_RATIO && PLAN_CASH_HEADROOM * convertOf(q) <= cashOf(q);

  it.each([3, 6, 20])('a 1M USD book at 100.1%% with 30,000 USD of cash and debt, at %d TWAP slices, takes the TWAP slice when it fits, else the first lot above it that fits, else a smaller one', (slices) => {
    const plan = planRealize(inputOf(slices));
    expect(plan?.refused).toBeNull();
    expect(plan?.legs[0].margin?.at).toBe('gap');
    const q1 = plan?.legs[0].margin?.firstQty ?? 0;
    const twapFirst = Number((QTY / slices).toFixed(5));
    expect(fits(q1)).toBe(true);
    const fitAbove = Array.from({ length: Math.floor((QTY - twapFirst) / (LOT * 50)) + 1 }, (_, i) => Number((twapFirst + i * LOT * 50).toFixed(5))).some(fits);
    if (!fitAbove) expect(q1).toBeLessThan(twapFirst);
    else expect(q1).toBeGreaterThanOrEqual(twapFirst - LOT - 1e-9);
    if (q1 > twapFirst + LOT) expect(fits(Number((q1 - LOT).toFixed(5)))).toBe(false);
    expect(plan?.legs[0].margin?.amount ?? Infinity).toBeLessThanOrEqual(30_000 / 0.998);
  });

  it.each([
    ['Market', { exec: 'market' as const }, DRIFT_DEFAULT_SEC, GAP_CONVERT_SEC, false],
    ['Limit + hedge with a 600 s taker-after', { exec: 'maker' as const, takerAfterSec: 600 }, 600, 630, true],
    ['no execution given', {}, DRIFT_DEFAULT_SEC, DRIFT_DEFAULT_SEC + GAP_CONVERT_SEC, false],
    ['Limit + hedge with taker-after Never', { exec: 'maker' as const, takerAfterSec: null }, DRIFT_DEFAULT_SEC, DRIFT_DEFAULT_SEC + GAP_CONVERT_SEC, true],
  ])('the gap Convert reserves the close time of the order setting, and prices the slice 1 close by it: %s', (_label, close, seconds, nakedSec, maker) => {
    expect(closeSecondsOf(close)).toBe(seconds);
    expect(nakedSecondsOf(close)).toBe(nakedSec);
    const plan = planRealize({ ...inputOf(6), ...close });
    const q1 = plan?.legs[0].margin?.firstQty ?? 0;
    const reserve = sliceReserveUsd({ qty: q1, price: MARK, marginPerCoin: PER_COIN, impactUsd: q1 * 0.5, seconds, exposureUsd, nakedUsd: q1 * MARK, nakedSec });
    const closeUsd = maker ? q1 * MARK * 0.00018 : closeOf(q1);
    expect(plan?.legs[0].margin).toMatchObject({ at: 'gap', amount: Math.max(11, ceilCents((reserve + closeUsd - 100) / LIFT)) });
    expect(plan?.legs[0].margin?.impactUsd).toBeCloseTo(maker ? q1 * 0.5 : q1, 6);
    expect(plan?.legs[0].margin).toMatchObject({ closeWalkUsd: expect.closeTo(q1 * 0.5, 6), reopenWalkUsd: expect.closeTo(q1 * 0.5, 6) });
    expect(plan?.legs[0].margin?.impactBp).toBeCloseTo(((maker ? 0.5 : 1) / MARK) * 10_000, 6);
  });

  it('a TWAP slice closes by the taker-after cap in Limit + hedge and by the interval in Market', () => {
    expect(closeSecondsOf({ exec: 'maker', twapIntervalSec: 600 })).toBe(takerAfterCapSec(600));
    expect(nakedSecondsOf({ exec: 'maker', twapIntervalSec: 600 })).toBe(takerAfterCapSec(600) + GAP_CONVERT_SEC);
    expect(closeSecondsOf({ exec: 'market', twapIntervalSec: 600 })).toBe(600);
    expect(nakedSecondsOf({ exec: 'market', twapIntervalSec: 600 })).toBe(GAP_CONVERT_SEC);
  });

  it('with taker-after Never, a TWAP slice 1 close reserves one TWAP interval, not the taker-after cap', () => {
    expect(closeSecondsOf({ exec: 'maker', takerAfterSec: null, twapIntervalSec: 600 })).toBe(600);
    expect(nakedSecondsOf({ exec: 'maker', takerAfterSec: null, twapIntervalSec: 600 })).toBe(600 + GAP_CONVERT_SEC);
    expect(takerAfterCapSec(600)).toBeLessThan(600);
  });
});

describe('Realize margin: Convert floors', () => {
  it('a Convert from USDT · CrossEx needs 11.04 USDT, so 11 USDC arrives; from USDC wallets it needs 11 USDC', () => {
    expect(convertMinOf('CROSSEX')).toBe(11.04);
    expect(convertMinOf('HYPERLIQUID')).toBe(11);
    expect(convertMinOf('LIGHTER')).toBe(11);
  });

  it('the run Converts only at a margin ratio of 103% or more, the lowest ratio Gate has filled a Convert at', () => {
    expect(MIN_CONVERT_RATIO).toBe(1.03);
  });
});

describe('Realize margin: a hedged slice 1 must fund slice 2', () => {
  const ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
  const ETH_MARK = 3_000;
  const ETH_PROFIT = 300;

  function ethCase(scale: number, leverage: number, ratio: number | null, moveUsd: number) {
    const qty = 10 * scale;
    const perCoin = ETH_MARK / leverage;
    const im = 2 * qty * perCoin + 0.2 * qty * ETH_PROFIT;
    const marginBalance = ratio === null ? im + 110 * scale : ratio * im;
    const free = marginBalance - im;
    const plan = planRealize({
      pool: 'HYPERLIQUID',
      moveUsd,
      cashUsd: 0,
      borrowUsd: qty * ETH_PROFIT,
      availableMargin: free,
      equityUsd: qty * ETH_PROFIT,
      marginBalance,
      initialMargin: im,
      borrowImRate: 0.2,
      perps: [
        { symbol: ETH, positionQty: String(-qty), entryPrice: String(ETH_MARK + ETH_PROFIT), markPrice: String(ETH_MARK), initialMargin: String(qty * perCoin) },
        { symbol: 'GATE_FUTURE_ETH_USDT', positionQty: String(qty), entryPrice: String(ETH_MARK + ETH_PROFIT), markPrice: String(ETH_MARK), initialMargin: String(qty * perCoin) },
      ],
      books: { [ETH]: { bids: [[ETH_MARK - 0.05, 1e7]], asks: [[ETH_MARK + 0.05, 1e7]], ts: 0 } },
      feeRows: FEE_ROWS,
      rules: PERP_RULES,
      twapSlices: 10,
    });
    const exposureUsd = exposureUsdOf({ legImUsd: qty * perCoin, hedgeImUsd: qty * perCoin, notionalUsd: qty * ETH_MARK, debtRate: 0.2 });
    const hedgedConvertOf = (q: number) =>
      (sliceReserveUsd({ qty: q, price: ETH_MARK, marginPerCoin: perCoin, impactUsd: q * 0.05, seconds: DRIFT_DEFAULT_SEC, exposureUsd, nakedUsd: 0 }) + q * ETH_MARK * TAKER + q * 0.05 - free) / LIFT;
    return { plan, ratio: marginBalance / im, hedgedConvertOf };
  }

  it.each([
    [1, 1_500, 6.8104, 0.7014, 145.61],
    [200, 300_000, 1362.0738, 140.2659, 29_117.02],
  ])('10 ETH a leg at 3,000 USD, 10x, no cash, 110 USD free margin, times %d: a 101.7 percent ratio cannot Convert for slice 2, so slice 1 is the gap', (scale, moveUsd, qty, firstQty, convert) => {
    const c = ethCase(scale, 10, null, moveUsd);
    const leg = c.plan?.legs[0];
    expect(c.ratio).toBeCloseTo(671 / 660, 9);
    expect(c.ratio).toBeLessThan(MIN_CONVERT_RATIO);
    expect(c.plan?.refused).toBeNull();
    expect(leg?.hedgedFirstQty).toBeUndefined();
    expect(leg?.qty).toBe(qty);
    expect(leg?.margin).toMatchObject({ at: 'gap', firstQty, amount: convert });
    expect(leg?.convert?.amount).toBe(convert);
  });

  it.each([
    [1, 0.0623, 8.8948, 8.9383, 0.8938, 167.15],
    [200, 12.4743, 1778.9611, 1787.6543, 178.7654, 33_430.99],
  ])('50x, a 103.5 percent ratio, times %d: a hedged slice 1 of %s ETH frees less cash than slice 2 must Convert, so slice 1 is the gap', (scale, hedged, hedgedRun, qty, firstQty, convert) => {
    const c = ethCase(scale, 50, 1.035, 0.6 * 10 * scale * ETH_PROFIT);
    const leg = c.plan?.legs[0];
    const secondSlice = (hedgedRun - hedged) / 9;
    expect(c.hedgedConvertOf(hedged)).toBeLessThanOrEqual(0);
    expect(c.hedgedConvertOf(secondSlice)).toBeGreaterThan(hedged * ETH_PROFIT);
    expect(c.plan?.refused).toBeNull();
    expect(leg?.hedgedFirstQty).toBeUndefined();
    expect(leg?.qty).toBe(qty);
    expect(leg?.margin).toMatchObject({ at: 'gap', firstQty, amount: convert });
  });

  it('at $6M, 50x, a 103.55 percent ratio: slice 2 priced on the free margin left after slice 1 fees needs more than a 29.8488 ETH hedged slice 1 frees, so slice 1 is the gap', () => {
    const c = ethCase(200, 50, 1.0355, 0.6 * 2000 * ETH_PROFIT);
    const leg = c.plan?.legs[0];
    expect(c.plan?.refused).toBeNull();
    expect(leg?.hedgedFirstQty).toBeUndefined();
    expect(leg?.margin?.at).toBe('gap');
  });

  it('at $50, a 102% ratio, 5x and 2 TWAP slices, slice 2 would need a Convert Gate refuses under 103%, so it refuses', () => {
    const c = caseOf({ usd: 50, slices: 2, ratio: 1.02, leverage: 5 });
    expect(c.plan?.refused).toEqual({ reason: 'no-margin', bp: null });
    expect(c.plan?.legs[0].hedgedFirstQty).toBeUndefined();
    expect(c.convertOf(Number((c.qty / 2).toFixed(5)), false)).toBeGreaterThan(0);
  });
});

describe('Realize margin: a Convert before slice 1 is only the margin part', () => {
  it.each(RUNGS.slice(1))('cash that covers the Convert but not with 10%% to spare plans the gap path, so the plan shows the gap ($usd)', ({ usd }) => {
    const c = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40 });
    const need = c.plan?.legs[0].margin?.amount ?? 0;
    expect(c.plan?.legs[0].margin?.at).toBe('before');
    expect(planRealize({ ...c.input, convertCashUsd: PLAN_CASH_HEADROOM * need + 0.01 })?.legs[0].margin?.at).toBe('before');
    expect(planRealize({ ...c.input, convertCashUsd: 1.05 * need })?.legs[0].margin?.at ?? null).not.toBe('before');
  });

  it.each(RUNGS.slice(1))('a wallet balance of -2,000 USD counts as negative cash, so slice 1 is sized from cash minus 2,000 ($usd)', ({ usd }) => {
    const c = caseOf({ usd, slices: 100, ratio: 1, entry: 110_000 });
    const plan = planRealize({ ...c.input, convertCashUsd: -2_000, equityUsd: 1e12 });
    const margin = plan?.legs[0].margin;
    if (plan?.refused) return expect(plan.refused.reason).toBe('no-margin');
    expect(margin?.at).toBe('gap');
    const q1 = margin?.firstQty ?? 0;
    expect(PLAN_CASH_HEADROOM * c.convertOf(q1)).toBeLessThanOrEqual(Math.min(q1 * c.profit - c.closeOf(q1) - 2_000, (c.qty * c.profit) / 0.998) + 0.02);
  });

  it.each([
    [5_000, 1_500, 9_500],
    [5_000, 300, 4_450],
    [6_000_000, 1_500, 9_500],
    [6_000_000, 300, 4_450],
  ])('at $%d a $%d margin Convert with a $%d leg Convert runs the margin part before slice 1 and the rest after it', (usd, marginUsd, total) => {
    const c = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40 });
    const leg = c.plan!.legs[0];
    const plan = { ...c.plan!, legs: [{ ...leg, margin: { at: 'before' as const, amount: marginUsd, firstQty: leg.qty }, convert: { amount: total, count: 1, feeUsd: 1 } }] };
    const job = newJob({ route: 'convert', steps: [], amount: 0, costUsd: 0, target: [], userId: null, realize: plan }, 0);
    const slice = job.steps.findIndex((step) => step.name === 'Slices');
    const sum = (steps: typeof job.steps) => Math.round(steps.reduce((total, step) => total + (step.planned ?? 0), 0) * 100) / 100;
    expect(sum(job.steps.slice(0, slice))).toBe(marginUsd);
    expect(sum(job.steps.slice(slice + 1))).toBe(total - marginUsd);
  });
});

describe('Realize margin: the 10% headroom is on cash, not on the debt', () => {
  it.each(RUNGS.slice(1))('a debt 5%% above the margin Convert still plans the Convert before slice 1; a debt under it does not ($usd)', ({ usd }) => {
    const c = caseOf({ usd, slices: 1, ratio: 1.06, cash: 2 * usd, leverage: 40 });
    const need = c.plan?.legs[0].margin?.amount ?? 0;
    expect(c.plan?.legs[0].margin?.at).toBe('before');
    const near = planRealize({ ...c.input, borrowUsd: 1.05 * need * (1 - CONVERT_RATE) });
    expect(near?.legs[0].margin).toMatchObject({ at: 'before', amount: need });
    const under = planRealize({ ...c.input, borrowUsd: 0.99 * need * (1 - CONVERT_RATE) });
    expect(under?.legs[0].margin?.at ?? null).not.toBe('before');
  });
});

describe('the TWAP cost with a gap slice 1', () => {
  const THIN: NormalizedBook = {
    bids: Array.from({ length: 200 }, (_, i): [number, number] => [MARK - 5 - 10 * i, 0.05]),
    asks: Array.from({ length: 200 }, (_, i): [number, number] => [MARK + 5 + 10 * i, 0.05]),
    ts: 0,
  };
  const walkOf = (qty: number): number => impactOf(THIN, 'BUY', MARK, qty)?.usd ?? NaN;
  const twapQtys = [...Array.from({ length: 8 }, () => 0.2785), 0.172];

  it.each([
    ['maker', 1],
    ['market', 2],
  ] as const)('a 2.4 BTC short with no cash and $300 free, %s: slice 1 of 0.4976 BTC walks the book at its own size, so the cost rises by the extra walk on %d sides', (exec, sides) => {
    const base = planRealize(caseOf({ usd: 2.4 * MARK, slices: 9, free: 1e6 }).input)?.legs[0];
    expect(base).toBeDefined();
    const leg = { ...base!, qty: 2.4, margin: null };
    const gapLeg = { ...leg, margin: { at: 'gap' as const, amount: 1_500, firstQty: 0.4976 } };
    expect(walkOf(0.4976)).toBeCloseTo(24.772, 9);
    expect(walkOf(0.2378)).toBeCloseTo(5.701, 9);
    expect(walkOf(0.2785)).toBeCloseTo(7.8175, 9);
    expect(walkOf(0.172)).toBeCloseTo(3.02, 9);
    const plain = twapEstimateOf(realizePlanOf([leg], null), exec, { [BTC]: THIN }, { [BTC]: twapQtys });
    const gap = twapEstimateOf(realizePlanOf([gapLeg], null), exec, { [BTC]: THIN }, { [BTC]: twapQtys });
    expect(gap.feeUsd).toBe(plain.feeUsd);
    expect(gap.impactUsd - plain.impactUsd).toBeCloseTo(sides * (24.772 + 8 * 5.701 - (8 * 7.8175 + 3.02)), 6);
    expect(gap.totalUsd - plain.totalUsd).toBeCloseTo(sides * 4.82, 6);
  });
});
