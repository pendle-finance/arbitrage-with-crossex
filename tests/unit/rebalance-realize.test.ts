import { describe, expect, it } from 'vitest';
import { deepenBook, type NormalizedBook, sigFigsWidth, touchOf } from '../../src/core/estimate/books';
import { walkBook } from '../../src/core/estimate/fill';
import { floorToStep } from '../../src/core/numbers';
import {
  BORROW_INITIAL_MARGIN,
  bucketsFrom,
  CONVERT_MAX,
  CONVERT_RATE,
  fullPlanOf,
  planFor,
  REPAY_GOAL,
  realizeTabEstimateOf,
  realizeTabOf,
} from '../../src/core/rebalance/plan';
import {
  convertFor,
  marginPerConvertUsdc,
  planRealize,
  type RealizeInput,
  type RealizeLeg,
  type RealizePlan,
  realizedNetUsd,
  realizeEstimateOf,
  slicedEstimateOf,
} from '../../src/core/rebalance/realize';
import { costOf, sliceOf } from '../../web/src/panels/realizeTabCost';
import { newJob } from '../../src/server/rebalanceJob';
import {
  bookBb43,
  bookC0df,
  ETH_MARK,
  ethUp,
  FEE_ROWS,
  HL_ETH,
  ownerBook,
  OWNER_HL_ETH,
  perp,
  PERP_RULES,
  type RealizeBook,
  realizeBook,
  twoLegs,
} from './fixtures/realize-books';

const tabOf = (book: RealizeBook) => realizeTabOf(book.buckets, book.account, book.inputs, null);

const fullOf = (book: RealizeBook) => fullPlanOf(book.buckets, book.account, book.inputs);

const clearDebtOf = (book: RealizeBook): RealizePlan => {
  const realize = tabOf(book)?.clearDebt;
  if (!realize) throw new Error('no clear debt realize');
  return realize;
};

const OWNER_EVEN_MOVE = 45_314 - (45_314 - 29_812) / 2;

const bookInput = (book: RealizeBook, pool: 'HYPERLIQUID' | 'CROSSEX', moveUsd: number, over: Partial<RealizeInput> = {}): RealizeInput => {
  const payer = pool === 'HYPERLIQUID' ? book.spec.usdc : book.spec.usdt;
  const receiver = pool === 'HYPERLIQUID' ? book.spec.usdt : book.spec.usdc;
  return {
    pool,
    moveUsd,
    cashUsd: Math.max(0, payer.cash),
    borrowUsd: Math.max(0, -receiver.cash),
    availableMargin: book.spec.availableMargin,
    perps: book.spec.perps,
    books: book.spec.books,
    feeRows: FEE_ROWS,
    rules: PERP_RULES,
    ...over,
  };
};

const ownerRealize = (over: Partial<RealizeInput> = {}): RealizePlan => {
  const realize = planRealize(bookInput(ownerBook(), 'HYPERLIQUID', OWNER_EVEN_MOVE, over));
  if (!realize) throw new Error('no realize');
  return realize;
};

const costsOf = (legs: RealizeLeg[]): number => legs.reduce((total, leg) => total + leg.realizedUsd - realizedNetUsd(leg), 0);

const OWNER_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';

function input(over: Partial<RealizeInput>): RealizeInput {
  return {
    pool: 'HYPERLIQUID',
    moveUsd: 10_000,
    cashUsd: 0,
    borrowUsd: 1_000_000,
    availableMargin: 1_000_000,
    perps: [perp(OWNER_ETH, -66, 2_460, 1_821)],
    books: { [OWNER_ETH]: OWNER_HL_ETH },
    feeRows: FEE_ROWS,
    rules: PERP_RULES,
    ...over,
  };
}

const flatBook = (mid: number, half: number, size: number): NormalizedBook => ({
  bids: [[mid - half, size]],
  asks: [[mid + half, size]],
  ts: 0,
});

describe('planRealize on the owner book', () => {
  it('sizes one order to the need', () => {
    const realize = ownerRealize();
    expect(realize.legs).toHaveLength(1);
    expect(realize.legs[0]).toMatchObject({ exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', positionQty: 66 });
    expect(Math.abs(realize.legs[0].qty - 54.0615)).toBeLessThanOrEqual(0.0001);
    expect(realize.refused).toBeNull();
  });

  it('no realize when cash covers', () => {
    const owner = ownerBook();
    expect(planRealize(bookInput(owner, 'HYPERLIQUID', 3_000))).toBeNull();
    const plan = planFor(owner.buckets, owner.account, owner.inputs, { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 3_000 });
    expect(plan.realize).toBeNull();
    const steps = plan.routes[plan.recommended ?? 'convert']?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.kind === 'round' || step.kind === 'convert')).toBe(true);
  });

  it('one order realizes qty times the move', () => {
    const leg = ownerRealize().legs[0];
    expect(Math.abs(leg.realizedUsd - leg.qty * (2_460 - 1_821))).toBeLessThanOrEqual(0.01);
  });

  it('converts just enough for the reopen', () => {
    const leg = ownerRealize().legs[0];
    const amount = leg.convert?.amount ?? 0;
    const reopenMargin = (leg.qty * 66 * 1_821 * 0.05) / 66;
    const passes = (converted: number) => -1_284 + converted * marginPerConvertUsdc >= 0.15 * reopenMargin + 20;
    expect(marginPerConvertUsdc).toBeCloseTo(BORROW_INITIAL_MARGIN * (1 - CONVERT_RATE), 12);
    expect(amount).toBeGreaterThan(0);
    expect(passes(amount)).toBe(true);
    expect(passes(amount - 1)).toBe(false);
    expect(passes(amount - 0.01)).toBe(false);
  });

  it('fees at the account\'s taker rate', () => {
    const leg = ownerRealize().legs[0];
    expect(Math.abs(leg.closeFeeUsd - leg.qty * 1_821 * 0.00042)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(leg.reopenFeeUsd - leg.qty * 1_821 * 0.00042)).toBeLessThanOrEqual(0.01);
  });

  it('impact walks both sides', () => {
    const leg = ownerRealize().legs[0];
    const mid = touchOf(OWNER_HL_ETH)?.mid ?? 0;
    const close = walkBook(OWNER_HL_ETH.asks, leg.qty);
    const reopen = walkBook(OWNER_HL_ETH.bids, leg.qty);
    expect(close && reopen).toBeTruthy();
    expect(leg.closeImpactUsd).toBeCloseTo(((close?.avgPrice ?? 0) - mid) * leg.qty, 6);
    expect(leg.reopenImpactUsd).toBeCloseTo((mid - (reopen?.avgPrice ?? 0)) * leg.qty, 6);
    expect(leg.impactBp).toBeCloseTo(((leg.closeImpactUsd + leg.reopenImpactUsd) / (leg.qty * mid)) * 10_000, 9);
  });

  it('realized cash covers the move and the fees', () => {
    const legs = ownerRealize().legs;
    const move = 45_314 - (45_314 - 29_812) / 2;
    const realized = legs.reduce((total, leg) => total + leg.realizedUsd, 0);
    expect(realized + 3_140).toBeGreaterThanOrEqual(move + costsOf(legs) - 1);
  });

  it('rounds the order up to the venue minimum', () => {
    const owner = ownerBook();
    const roomy = realizeBook({ ...owner.spec, availableMargin: 50_000 });
    const realize = planRealize(bookInput(roomy, 'HYPERLIQUID', 3_141));
    if (!realize) throw new Error('no realize');
    const leg = realize.legs[0];
    expect(realize.refused).toBeNull();
    expect(leg.convert).toBeNull();
    const lots = leg.qty / 0.0001;
    expect(Math.abs(lots - Math.round(lots))).toBeLessThan(1e-6);
    expect(leg.qty).toBeGreaterThanOrEqual(0.0001);
    expect(leg.qty * 1_821).toBeGreaterThanOrEqual(10);
    expect((leg.qty - 0.0001) * 1_821).toBeLessThan(10);
  });

  it('a small realize with no margin refuses', () => {
    const realize = ownerRealize({ moveUsd: 3_141 });
    expect(realize.refused).toEqual({ reason: 'no-margin', bp: null });
  });

  it('parses the signed gate position strings', () => {
    const realize = planRealize(
      input({ perps: [{ symbol: OWNER_ETH, positionQty: '-66.0', entryPrice: '2460', markPrice: '1821', initialMargin: '6009.3' }] }),
    );
    expect(realize?.legs[0]).toMatchObject({ side: 'SHORT', positionQty: 66 });
    expect(realize?.legs[0].realizedUsd).toBeCloseTo((realize?.legs[0].qty ?? 0) * 639, 6);
  });
});

describe('planRealize leg order', () => {
  it('most-moved leg pays first, then the next', () => {
    const realize = clearDebtOf(twoLegs());
    expect(realize.legs.map((leg) => leg.base)).toEqual(['ETH', 'BTC']);
    expect(realize.legs[0].qty).toBe(20);
    expect(realize.legs[1].qty).toBeLessThan(2);
  });

  it('two legs clear the debt', () => {
    expect(fullOf(twoLegs())).toMatchObject({ clearsBorrow: true, needsRealize: true, refused: null });
  });

  it('switches leg when the first cannot fund its convert', () => {
    const realize = clearDebtOf(bookBb43());
    expect(realize.legs[0].base).toBe('BTC');
    expect(realize.legs[0].positionQty).toBeCloseTo(92.7, 1);
    expect(Math.abs(realize.legs[0].qty - 59.07153)).toBeLessThanOrEqual(0.00001);
    expect(realize.legs.some((leg) => leg.base === 'ETH')).toBe(false);
    expect(realize.refused).toBeNull();
  });

  it('splits a convert above 500,000', () => {
    const convert = clearDebtOf(bookBb43()).legs[0].convert;
    expect(convert?.amount).toBeGreaterThan(CONVERT_MAX);
    expect(convert?.count).toBe(2);
  });

  it('gate long pays when eth rises', () => {
    const up = ethUp();
    const leg = planRealize(bookInput(up, 'CROSSEX', 42_900 - (42_900 - 18_400) / 2))?.legs[0];
    expect(leg).toMatchObject({ exchange: 'GATE', base: 'ETH', side: 'LONG', pool: 'CROSSEX' });
    expect(Math.abs((leg?.qty ?? 0) - 47.369)).toBeLessThanOrEqual(0.001);
    expect(clearDebtOf(up).legs[0]).toMatchObject({ exchange: 'GATE', base: 'ETH', side: 'LONG', pool: 'CROSSEX' });
    expect(fullOf(up)?.clearsBorrow).toBe(true);
  });
});

describe('planRealize sizes and refusals', () => {
  it('one order per leg, no cap', () => {
    const realize = planRealize(
      input({
        moveUsd: 1_917_000,
        perps: [perp(OWNER_ETH, -3_300, ETH_MARK + 639, ETH_MARK)],
        books: { [OWNER_ETH]: HL_ETH },
      }),
    );
    expect(realize?.legs).toHaveLength(1);
    expect(realize?.legs[0].qty).toBeGreaterThanOrEqual(3_000);
    expect(realize?.legs[0].qty).toBeLessThan(3_100);
    expect(realize?.refused).toBeNull();
  });

  it('no bp limit in refusals', () => {
    const realize = clearDebtOf(bookC0df());
    expect(realize.legs[0]).toMatchObject({ exchange: 'GATE', base: 'ETH' });
    expect(Math.abs(realize.legs[0].impactBp - 52.3)).toBeLessThanOrEqual(0.1);
    expect(realize.refused).toBeNull();
    const at = (half: number) =>
      planRealize(input({ moveUsd: 1_000, perps: [perp(OWNER_ETH, -10, 1_200, 1_000)], books: { [OWNER_ETH]: flatBook(1_000, half, 100) } }));
    const wide = at(1.255);
    expect(wide?.legs[0].impactBp).toBeCloseTo(25.1, 9);
    expect(wide?.refused).toBeNull();
    const refusals = [
      planRealize(input({ books: { [OWNER_ETH]: null } }))?.refused,
      planRealize(input({ availableMargin: -1_000_000 }))?.refused,
      planRealize(input({ feeRows: [] }))?.refused,
      planRealize(hlShortInput(1_000_000, { rules: { HYPERLIQUID_FUTURE_ETH_USDC: { lotSize: '0.0001', minSize: '1', maxMarketSize: '0.5' } } }))
        ?.refused,
    ];
    expect(refusals.map((refused) => refused?.reason)).toEqual(['past-book', 'no-margin', 'no-fee-rate', 'over-cap']);
    for (const refused of refusals) expect(Object.keys(refused ?? {})).not.toContain('maxBp');
  });

  it('refuses an order past the fetched book', () => {
    const thin = planRealize(input({ books: { [OWNER_ETH]: flatBook(1_821, 0.5, 1) } }));
    expect(thin?.refused).toEqual({ reason: 'past-book', bp: null });
    const unread = planRealize(input({ books: { [OWNER_ETH]: null } }));
    expect(unread?.refused).toEqual({ reason: 'past-book', bp: null });
  });

  it('refuses when no leg can fund its convert', () => {
    const realize = planRealize(input({ availableMargin: -1_000_000 }));
    expect(realize?.legs[0].convert?.amount).toBeGreaterThan(10_000);
    expect(realize?.refused).toEqual({ reason: 'no-margin', bp: null });
  });

  it('no realize when closing loses money even with no Convert', () => {
    // 0.08% profit against a 0.084% Hyperliquid round-trip fee, with margin to spare.
    const thin = planRealize(input({ perps: [perp(OWNER_ETH, -66, 1_821 * 1.0008, 1_821)] }));
    expect(thin).toBeNull();
  });

  it('never realizes a lighter or binance leg', () => {
    const owner = ownerBook();
    const perps = [
      perp('LIGHTER_FUTURE_ETH_USDC', -66, 2_460, 1_821),
      perp('BINANCE_FUTURE_ETH_USDT', 66, 1_000, 1_821),
    ];
    const book = { ...owner, inputs: { ...owner.inputs, perps } };
    expect(tabOf(book)).toBeNull();
    expect(fullOf(book)?.needsRealize).toBe(false);
    expect(planRealize(input({ pool: 'LIGHTER', perps }))).toBeNull();
    expect(planRealize(input({ pool: 'CROSSEX', perps }))).toBeNull();
  });
});

describe('planRealize and the free Hyperliquid borrow', () => {
  it('no realize under the free hyperliquid borrow', () => {
    expect(fullOf(ethUp(9_000))).toBeNull();
    expect(tabOf(ethUp(9_000))?.clearDebt).toBeNull();
  });

  it('the realize tab offers all uPnL without a charged borrow', () => {
    expect(tabOf(ethUp(9_000))?.all?.legs[0]).toMatchObject({ exchange: 'GATE', side: 'LONG' });
  });
});

describe('planRealize at size', () => {
  const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];

  it('realize at every rung of the size ladder', () => {
    for (const rung of RUNGS) {
      const positionQty = Number((rung / ETH_MARK).toFixed(4));
      const cashUsd = 0.25 * rung;
      const moveUsd = cashUsd + 0.3189 * rung;
      const realize = planRealize(
        input({
          moveUsd,
          cashUsd,
          borrowUsd: rung,
          availableMargin: 25 - 0.1 * rung,
          perps: [perp(OWNER_ETH, -positionQty, ETH_MARK + 639, ETH_MARK)],
          books: { [OWNER_ETH]: HL_ETH },
        }),
      );
      expect(realize?.refused, `rung ${rung}`).toBeNull();
      expect(realize?.legs, `rung ${rung}`).toHaveLength(1);
      const leg = realize?.legs[0];
      if (!leg) throw new Error(`no leg at rung ${rung}`);
      const lots = leg.qty / 0.0001;
      expect(Math.abs(lots - Math.round(lots)), `rung ${rung}`).toBeLessThan(1e-6);
      expect(leg.qty, `rung ${rung}`).toBeLessThanOrEqual(positionQty);
      expect(cashUsd + realizedNetUsd(leg), `rung ${rung}`).toBeGreaterThanOrEqual(moveUsd - 0.01);
      const amount = leg.convert?.amount ?? 0;
      expect(leg.convert?.count ?? 0, `rung ${rung}`).toBe(Math.ceil(amount / CONVERT_MAX));
      if (rung === 6_000_000) {
        expect(leg.qty).toBeGreaterThan(1_000);
        expect(leg.convert?.count).toBeGreaterThan(1);
      }
    }
  });
});

describe('scale ladder: planRealize', () => {
  it.each([50, 5_000, 100_000, 1_000_000, 6_000_000])('a $%d realize writes a job whose Converts and close qty match the plan', (rung) => {
    const positionQty = Number((rung / ETH_MARK).toFixed(4));
    const cashUsd = 0.25 * rung;
    const realize = planRealize(
      input({
        moveUsd: cashUsd + 0.3189 * rung,
        cashUsd,
        borrowUsd: rung,
        availableMargin: 25 - 0.1 * rung,
        perps: [perp(OWNER_ETH, -positionQty, ETH_MARK + 639, ETH_MARK)],
        books: { [OWNER_ETH]: HL_ETH },
      }),
    );
    if (!realize) throw new Error(`no realize at rung ${rung}`);
    const leg = realize.legs[0];
    const job = newJob({ route: 'convert', steps: [], amount: 0, costUsd: 0, target: [], userId: null, realize }, 0);
    const converts = job.steps.filter((step) => step.name === 'Convert');
    const amount = leg.convert?.amount ?? 0;
    expect(Math.round(amount * 100) / 100).toBe(amount);
    expect(converts).toHaveLength(leg.convert?.count ?? 0);
    expect(converts.every((step) => (step.planned ?? 0) <= CONVERT_MAX)).toBe(true);
    expect(converts.reduce((total, step) => total + Math.round((step.planned ?? 0) * 100), 0)).toBe(Math.round(amount * 100));
    expect(job.steps.map((step) => step.name)).toEqual(['Slices', ...converts.map(() => 'Convert')]);
    expect(floorToStep(job.steps[0].planned ?? 0, '0.0001')).toBe(leg.qty.toFixed(4));
    expect(job.realize?.legs[0].qty).toBe(leg.qty);
  });
});

const LADDER = [50, 5_000, 100_000, 1_000_000, 6_000_000];

const evenBook = (mid: number, levels: number, size: number): NormalizedBook => ({
  bids: Array.from({ length: levels }, (_, i): [number, number] => [mid - 0.05 - i * 0.1, size]),
  asks: Array.from({ length: levels }, (_, i): [number, number] => [mid + 0.05 + i * 0.1, size]),
  ts: 0,
});

const hlShortInput = (need: number, extra: Partial<RealizeInput> = {}, maxLeverage?: string): RealizeInput => {
  const positionQty = Math.max(1, (need / 200) * 1.5);
  return {
    pool: 'HYPERLIQUID',
    moveUsd: need + 100,
    cashUsd: 100,
    borrowUsd: need * 2,
    availableMargin: 1e9,
    perps: [
      {
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        positionQty: String(-positionQty),
        entryPrice: '3000',
        markPrice: '2800',
        initialMargin: String((positionQty * 2800) / 25),
        maxLeverage,
      },
    ],
    books: { HYPERLIQUID_FUTURE_ETH_USDC: evenBook(2800, 2000, 500) },
    feeRows: FEE_ROWS,
    rules: { HYPERLIQUID_FUTURE_ETH_USDC: { lotSize: '0.0001', minSize: '0.0001' } },
    ...extra,
  };
};

describe('realize fix round', () => {
  it('the market cap judges one slice, not the whole order', () => {
    const caps = [
      ['5', 500_000],
      ['10', 2_000_000],
      ['20', 5_000_000],
      ['25', 30_000_000],
    ] as const;
    let overCapOrders = 0;
    for (const need of LADDER) {
      for (const [leverage, capUsd] of caps) {
        const plan = planRealize(hlShortInput(need, {}, leverage));
        if ((plan?.legs[0].qty ?? 0) * 2800 > capUsd) overCapOrders += 1;
        expect(plan?.refused).toBeNull();
        expect(planRealize(hlShortInput(need, { sliceUsd: 50_000_000 }, leverage))?.refused).toBeNull();
      }
    }
    expect(overCapOrders).toBeGreaterThan(4);
    const minOverCap = { HYPERLIQUID_FUTURE_ETH_USDC: { lotSize: '0.0001', minSize: '1', maxMarketSize: '0.5' } };
    expect(planRealize(hlShortInput(5_000, { rules: minOverCap }))?.refused).toEqual({ reason: 'over-cap', bp: null, capUsd: 1_400 });
    const gate = (maxMarketSize: string): RealizeInput => ({
      ...hlShortInput(1_000_000),
      pool: 'CROSSEX',
      perps: [perp('GATE_FUTURE_ETH_USDT', -7_500, 3_000, 2_800)],
      books: { GATE_FUTURE_ETH_USDT: evenBook(2800, 2000, 500) },
      rules: { GATE_FUTURE_ETH_USDT: { lotSize: '0.001', minSize: '0.001', maxMarketSize } },
    });
    expect(planRealize(gate('100'))?.refused).toBeNull();
    expect(planRealize(gate('100000'))?.refused).toBeNull();
  });

  it('past-book judges one slice: a $1M order on a 30 ETH book is fine in 50k slices, refused in 100k ones', () => {
    const thin = { books: { HYPERLIQUID_FUTURE_ETH_USDC: evenBook(2800, 3, 10) } };
    const plan = planRealize(hlShortInput(1_000_000, thin));
    expect((plan?.legs[0].qty ?? 0) * 2800).toBeGreaterThan(1_000_000);
    expect(plan?.refused).toBeNull();
    expect(planRealize(hlShortInput(1_000_000, { ...thin, sliceUsd: 50_000 }))?.refused).toBeNull();
    expect(planRealize(hlShortInput(1_000_000, { ...thin, sliceUsd: 100_000 }))?.refused).toEqual({ reason: 'past-book', bp: null });
    expect(planRealize(hlShortInput(50, thin))?.refused).toBeNull();
  });

  it('caps the custom slice row at the venue max order size', () => {
    const book = realizeBookOf(1_000_000, 7_500);
    const capped = { ...book.inputs, perps: book.inputs.perps?.map((row) => ({ ...row, maxLeverage: '5' })) };
    const tab = realizeTabOf(book.buckets, book.account, capped, null, 6_000_000);
    const custom = tab?.sliceOptions.find((option) => option.custom);
    expect(custom?.sizeUsd).toBe(500_000);
    expect(custom?.notHedgedMaxUsd).toBeLessThanOrEqual(500_000 * 1.0001);
  });

  it('a refused realize still carries the plain cash move', () => {
    const book = ownerBook();
    const refused = { ...book.inputs, books: {} };
    const full = fullPlanOf(book.buckets, book.account, refused);
    expect(full).toMatchObject({ clearsBorrow: false, needsRealize: true, realizeCostUsd: 0, refused: { reason: 'past-book' } });
    expect(full?.moveCostUsd).toBeGreaterThan(0);
    expect(full?.costUsd).toBe(full?.moveCostUsd);
    const plan = planFor(book.buckets, book.account, refused, REPAY_GOAL);
    expect(plan.realize).toBeNull();
    expect(plan.balanced).toBe(false);
    expect(plan.moves).toBeGreaterThan(3_000);
    expect(plan.moves).toBeLessThanOrEqual(3_140);
  });

  it('a missing fee rate refuses the realize', () => {
    for (const need of LADDER) {
      const nothing = { feeUsd: 0, impactUsd: 0, totalUsd: 0 };
      expect(planRealize(hlShortInput(need, { feeRows: [] }))).toEqual({
        legs: [],
        refused: { reason: 'no-fee-rate', bp: null },
        estimates: { maker: nothing, market: nothing },
      });
    }
    const book = ownerBook();
    const noFee = { ...book.inputs, feeRows: [FEE_ROWS[1]] };
    const full = fullPlanOf(book.buckets, book.account, noFee);
    expect(full).toMatchObject({ clearsBorrow: false, realizeCostUsd: 0, refused: { reason: 'no-fee-rate' } });
    expect(full?.costUsd).toBe(full?.moveCostUsd);
    const tab = realizeTabOf(book.buckets, book.account, noFee, null);
    expect(tab?.clearDebt).toMatchObject({ legs: [], refused: { reason: 'no-fee-rate' } });
    const plan = planFor(book.buckets, book.account, noFee, REPAY_GOAL);
    expect(plan.realize).toBeNull();
    expect(plan.balanced).toBe(false);
    expect(plan.moves).toBeGreaterThan(3_000);
    expect(plan.moves).toBeLessThanOrEqual(3_140);
  });

  it('a plan convert under 11 USDC is raised to 11 and still passes the margin test', () => {
    for (const need of LADDER) {
      const margin = need / 20;
      const edge = 0.15 * margin + 20;
      const convert = convertFor(margin, edge - 0.01);
      expect(convert).toBe(11);
      expect(edge - 0.01 + convert * marginPerConvertUsdc).toBeGreaterThanOrEqual(edge);
      expect(convertFor(margin, edge)).toBe(0);
      const big = convertFor(margin, 0);
      expect(big).toBeGreaterThanOrEqual(11);
      expect(big * marginPerConvertUsdc).toBeGreaterThanOrEqual(edge);
    }
  });

  it('clear debt realizes when the paying wallet holds no cash', () => {
    const gateRealize = clearDebtOf(ethUp());
    expect(gateRealize.refused).toBeNull();
    expect(gateRealize.legs[0].pool).toBe('CROSSEX');
    const owner = ownerBook();
    const assets = (owner.account.assets ?? []).map((asset) =>
      asset.coin === 'USDC' && asset.exchangeType === 'HYPERLIQUID'
        ? { ...asset, balance: '0', availableBalance: '0', equity: asset.upnl }
        : asset,
    );
    const account = { ...owner.account, assets };
    const buckets = bucketsFrom(account, [{ coin: 'USDT', exchangeType: 'CROSSEX', hourInterestRate: '0.000006' }], {});
    const noCash = { ...owner, account, buckets };
    const realize = clearDebtOf(noCash);
    expect(realize.refused).toBeNull();
    expect(realize.legs[0].pool).toBe('HYPERLIQUID');
    expect(sumNet(realize.legs)).toBeGreaterThan(29_000);
    expect(fullOf(noCash)?.clearsBorrow).toBe(true);
  });

  it('clear debt realizes at every rung when the paying wallet holds no cash', () => {
    for (const debt of LADDER) {
      const qty = Math.max(1, (debt / 200) * 1.5);
      const realize = clearDebtOf(realizeBookOf(debt, qty));
      expect(realize.refused, `rung ${debt}`).toBeNull();
      expect(sumNet(realize.legs), `rung ${debt}`).toBeGreaterThanOrEqual(debt - 0.02);
    }
  });

  it('a Lighter wallet with more equity keeps the Hyperliquid realize', () => {
    const owner = realizeBookOf(60_000, 66, 3_140);
    const lighter = {
      coin: 'USDC',
      exchangeType: 'LIGHTER',
      balance: '0',
      availableBalance: '0',
      upnl: '80000',
      equity: '80000',
      liability: '0',
      borrowingInitialMargin: '0',
      borrowingMaintenanceMargin: '0',
    };
    const account = { ...owner.account, assets: [...(owner.account.assets ?? []), lighter] };
    const buckets = bucketsFrom(account, [{ coin: 'USDT', exchangeType: 'CROSSEX', hourInterestRate: '0.000006' }], {});
    const inputs = {
      ...owner.inputs,
      notional: { 'USDT/CROSSEX': 120_000, 'USDC/HYPERLIQUID': 120_000, 'USDC/LIGHTER': 120_000 },
    };
    const tab = realizeTabOf(buckets, account, inputs, null);
    expect(tab?.pool).toBe('HYPERLIQUID');
    expect(tab?.clearDebt?.refused).toBeNull();
    expect(tab?.clearDebt?.legs[0].pool).toBe('HYPERLIQUID');
  });
});

function sumNet(legs: RealizeLeg[]): number {
  return legs.reduce((total, leg) => total + realizedNetUsd(leg), 0);
}

function realizeBookOf(debt: number, qty: number, cash = 0): RealizeBook {
  const upnl = qty * 200;
  const owner = ownerBook();
  const asset = (coin: string, venue: string, balance: number, profit: number) => ({
    coin,
    exchangeType: venue,
    balance: String(balance),
    availableBalance: String(Math.max(0, balance)),
    upnl: String(profit),
    equity: String(balance + profit),
    liability: String(Math.max(0, -balance)),
    borrowingInitialMargin: String(Math.max(0, -balance) * BORROW_INITIAL_MARGIN),
    borrowingMaintenanceMargin: String(Math.max(0, -balance) * 0.1),
  });
  const account = {
    availableMargin: '1000000000',
    marginBalance: String(cash + upnl - debt + 1e9),
    initialMargin: '0',
    assets: [asset('USDT', 'CROSSEX', -debt, 0), asset('USDC', 'HYPERLIQUID', cash, upnl)],
  };
  return {
    spec: owner.spec,
    account,
    buckets: bucketsFrom(account, [{ coin: 'USDT', exchangeType: 'CROSSEX', hourInterestRate: '0.000006' }], {}),
    inputs: {
      ...owner.inputs,
      notional: { 'USDT/CROSSEX': qty * 2_800, 'USDC/HYPERLIQUID': qty * 2_800 },
      perps: [perp('HYPERLIQUID_FUTURE_ETH_USDC', -qty, 3_000, 2_800), perp('GATE_FUTURE_ETH_USDT', qty, 2_800, 2_800)],
      books: { HYPERLIQUID_FUTURE_ETH_USDC: evenBook(2800, 2000, 500), GATE_FUTURE_ETH_USDT: evenBook(2800, 2000, 500) },
      availableMargin: 1e9,
    },
  };
}

function lopsidedOf(book: RealizeBook): RealizeBook {
  const thin = (mid: number): NormalizedBook => ({ ...evenBook(mid, 2000, 500), bids: evenBook(mid, 2000, 5).bids });
  return { ...book, inputs: { ...book.inputs, books: { HYPERLIQUID_FUTURE_ETH_USDC: thin(2800), GATE_FUTURE_ETH_USDT: thin(2800) } } };
}

describe('realize cost per slice, the same figure as the dialog', () => {
  const books = [
    ['owner book', ownerBook()],
    ['$1M debt', realizeBookOf(1_000_000, 7_500)],
    ['$6M debt', realizeBookOf(6_000_000, 45_000)],
    ['$50 debt', realizeBookOf(50, 1)],
    ['$1M debt on a book with thin bids', lopsidedOf(realizeBookOf(1_000_000, 7_500))],
  ] as const;

  it.each(books)('server and web price every slice row alike on the %s', (_, book) => {
    const tab = tabOf(book);
    const priced = tab?.clearDebt?.legs.length ? tab.clearDebt : tab?.all;
    if (!tab || !priced) throw new Error('no realize tab');
    expect(tab.sliceOptions.length).toBeGreaterThan(0);
    for (const exec of ['maker', 'market'] as const) {
      for (const option of tab.sliceOptions) {
        const web = costOf(priced, exec, sliceOf(tab.sliceOptions, option.sizeUsd, priced.legs[0], true));
        expect(realizeTabEstimateOf(tab, priced, exec, option.sizeUsd).totalUsd).toBeCloseTo(web.totalUsd, 9);
        if (_.includes('thin bids')) expect(option.reopenImpactUsd).not.toBeCloseTo(option.impactUsd, 2);
      }
      expect(realizeTabEstimateOf(tab, priced, exec, 12_345).totalUsd).toBeCloseTo(priced.estimates[exec].totalUsd, 9);
    }
  });

  it('a slice prices the close walk only at market and the reopen walk always', () => {
    const plan = {
      legs: [{ closeImpactUsd: 10, reopenImpactUsd: 4 }],
      estimates: { maker: { feeUsd: 1, impactUsd: 4, totalUsd: 5 }, market: { feeUsd: 2, impactUsd: 14, totalUsd: 16 } },
    } as unknown as RealizePlan;
    const slice = { impactUsd: 3, reopenImpactUsd: 7 };
    expect(slicedEstimateOf(plan, 'maker', slice)).toEqual({ feeUsd: 1, impactUsd: 7, totalUsd: 8 });
    expect(slicedEstimateOf(plan, 'market', slice)).toEqual({ feeUsd: 2, impactUsd: 10, totalUsd: 12 });
  });

  it('a plan the slices do not price keeps its whole estimate, as the dialog does', () => {
    const tab = tabOf(ownerBook());
    if (!tab?.all || !tab.clearDebt?.legs.length) throw new Error('needs both plans');
    const other = { ...tab.all };
    expect(realizeTabEstimateOf(tab, other, 'market', tab.defaultSliceUsd)).toEqual(tab.all.estimates.market);
    expect(slicedEstimateOf(tab.all, 'maker', null)).toEqual(tab.all.estimates.maker);
  });

  it.each(books)('the Borrow card realize cost equals the dialog default on the %s', (_, book) => {
    const tab = tabOf(book);
    const full = fullOf(book);
    if (!tab?.clearDebt?.legs.length || !full) throw new Error('no clear debt plan');
    const dialog = realizeTabEstimateOf(tab, tab.clearDebt, 'maker', tab.defaultSliceUsd).totalUsd;
    expect(full.realizeCostUsd).toBeCloseTo(dialog, 2);
  });
});

describe('realize estimate per order mode', () => {
  const R1_FEES = [{ exchangeType: 'HYPERLIQUID', futureMakerFee: '0.0002', futureTakerFee: '0.0005' }];
  const r1 = (): RealizePlan | null =>
    planRealize(
      input({
        moveUsd: 1_000_000,
        perps: [perp(OWNER_ETH, -10, 3_900, 3_390)],
        books: { [OWNER_ETH]: flatBook(3_390, 0.5, 100) },
        feeRows: R1_FEES,
      }),
    );

  it('limit + hedge estimate', () => {
    const plan = r1();
    const leg = plan?.legs[0];
    if (!plan || !leg) throw new Error('no realize');
    expect(plan.refused).toBeNull();
    expect(leg.qty * 3_390).toBeCloseTo(33_900, 6);
    expect(leg.convert).toBeNull();
    expect(plan.estimates.maker.feeUsd).toBeCloseTo(23.73, 9);
    expect(plan.estimates.maker.impactUsd).toBeCloseTo(leg.reopenImpactUsd, 9);
    expect(plan.estimates.maker.impactUsd).toBeCloseTo(5, 9);
    expect(plan.estimates.maker.totalUsd).toBeCloseTo(28.73, 9);
    expect(realizeEstimateOf(plan, 'maker')).toEqual(plan.estimates.maker);
  });

  it('market estimate', () => {
    const plan = r1();
    const leg = plan?.legs[0];
    if (!plan || !leg) throw new Error('no realize');
    expect(plan.estimates.market.feeUsd).toBeCloseTo(33.9, 9);
    expect(plan.estimates.market.impactUsd).toBeCloseTo(leg.closeImpactUsd + leg.reopenImpactUsd, 9);
    expect(plan.estimates.market.impactUsd).toBeCloseTo(10, 9);
    expect(plan.estimates.market.totalUsd).toBeCloseTo(43.9, 9);
    expect(realizeEstimateOf(plan, 'market')).toEqual(plan.estimates.market);
  });

  it('a Convert fee counts in both estimates', () => {
    const plan = ownerRealize();
    const leg = plan.legs[0];
    const convertFee = leg.convert?.feeUsd ?? 0;
    expect(convertFee).toBeGreaterThan(0);
    expect(plan.estimates.maker.feeUsd).toBeCloseTo(leg.closeMakerFeeUsd + leg.reopenFeeUsd + convertFee, 9);
    expect(plan.estimates.market.feeUsd).toBeCloseTo(leg.closeFeeUsd + leg.reopenFeeUsd + convertFee, 9);
    expect(plan.estimates.maker.totalUsd).toBeLessThan(plan.estimates.market.totalUsd);
  });

  it.each(LADDER)('a $%d realize prices the maker close below the market close', (need) => {
    const plan = planRealize(hlShortInput(need));
    if (!plan) throw new Error(`no realize at ${need}`);
    expect(plan.refused).toBeNull();
    const { maker, market } = plan.estimates;
    expect(market.totalUsd - maker.totalUsd).toBeCloseTo(
      plan.legs.reduce((total, leg) => total + leg.closeFeeUsd - leg.closeMakerFeeUsd + leg.closeImpactUsd, 0),
      6,
    );
    expect(maker.totalUsd).toBeLessThan(market.totalUsd);
  });
});

const DEPTH_MID = 2800;

const depthSide = (sigFigs?: number): NormalizedBook => {
  const at = (step: number, size: number, edge: number): NormalizedBook => ({
    bids: Array.from({ length: 20 }, (_, i): [number, number] => [DEPTH_MID - edge - i * step, size]),
    asks: Array.from({ length: 20 }, (_, i): [number, number] => [DEPTH_MID + edge + i * step, size]),
    ts: 0,
  });
  if (sigFigs === undefined) return at(0.1, 15, 0.05);
  const step = sigFigsWidth(sigFigs)(DEPTH_MID);
  return at(step, 15 * step * 10, step);
};

describe('realize without a price impact cap', () => {
  it('no price impact refusal', () => {
    const deep = [4, 3].reduce((book, sigFigs) => deepenBook(book, depthSide(sigFigs), sigFigsWidth(sigFigs)), depthSide());
    const plan = planRealize(hlShortInput(1_000_000, { books: { HYPERLIQUID_FUTURE_ETH_USDC: deep } }));
    expect(plan?.refused).toBeNull();
    expect(plan?.legs).toHaveLength(1);
    expect(Math.round((plan?.legs[0].impactBp ?? 0) * 10) / 10).toBe(187.5);
    expect(plan?.estimates.market.impactUsd).toBeGreaterThan(plan?.estimates.maker.impactUsd ?? Infinity);
  });
});
