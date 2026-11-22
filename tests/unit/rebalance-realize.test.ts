import { describe, expect, it } from 'vitest';
import { type NormalizedBook, touchOf } from '../../src/core/estimate/books';
import { walkBook } from '../../src/core/estimate/fill';
import { floorToStep } from '../../src/core/numbers';
import {
  BORROW_INITIAL_MARGIN,
  bucketsFrom,
  CONVERT_MAX,
  CONVERT_RATE,
  EVEN_GOAL,
  type Goal,
  planFor,
  REPAY_GOAL,
  type WalletAfter,
} from '../../src/core/rebalance/plan';
import {
  convertFor,
  marginPerConvertUsdc,
  planRealize,
  type RealizeInput,
  type RealizeLeg,
  type RealizePlan,
  realizedNetUsd,
} from '../../src/core/rebalance/realize';
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

const planOf = (book: RealizeBook, goal: Goal = EVEN_GOAL) => planFor(book.buckets, book.account, book.inputs, goal);

const realizeOf = (book: RealizeBook, goal: Goal = EVEN_GOAL): RealizePlan => {
  const realize = planOf(book, goal).realize;
  if (!realize) throw new Error('no realize');
  return realize;
};

const walletIn = (after: WalletAfter[], coin: string, venue: string): WalletAfter => {
  const found = after.find((w) => w.coin === coin && w.venue === venue);
  if (!found) throw new Error(`no ${coin}/${venue}`);
  return found;
};

const pickedAfter = (book: RealizeBook, goal: Goal): WalletAfter[] => {
  const plan = planOf(book, goal);
  const route = plan.routes[plan.recommended ?? 'convert'];
  if (!route) throw new Error('no route');
  return route.after;
};

const costsOf = (legs: RealizeLeg[]): number => legs.reduce((total, leg) => total + leg.realizedUsd - realizedNetUsd(leg), 0);

const OWNER_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';

function input(over: Partial<RealizeInput>): RealizeInput {
  return {
    pool: 'HYPERLIQUID',
    moveUsd: 10_000,
    cashUsd: 0,
    borrowUsd: 1_000_000,
    convertCounts: true,
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
    const realize = realizeOf(ownerBook());
    expect(realize.legs).toHaveLength(1);
    expect(realize.legs[0]).toMatchObject({ exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', positionQty: 66 });
    expect(Math.abs(realize.legs[0].qty - 54.0615)).toBeLessThanOrEqual(0.0001);
    expect(realize.refused).toBeNull();
  });

  it('no realize when cash covers', () => {
    const plan = planOf(ownerBook(), { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 3_000 });
    expect(plan.realize).toBeNull();
    const steps = plan.routes[plan.recommended ?? 'convert']?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.kind === 'round' || step.kind === 'convert')).toBe(true);
  });

  it('one order realizes qty times the move', () => {
    const leg = realizeOf(ownerBook()).legs[0];
    expect(Math.abs(leg.realizedUsd - leg.qty * (2_460 - 1_821))).toBeLessThanOrEqual(0.01);
  });

  it('converts just enough for the reopen', () => {
    const leg = realizeOf(ownerBook()).legs[0];
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
    const leg = realizeOf(ownerBook()).legs[0];
    expect(Math.abs(leg.closeFeeUsd - leg.qty * 1_821 * 0.00042)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(leg.reopenFeeUsd - leg.qty * 1_821 * 0.00042)).toBeLessThanOrEqual(0.01);
  });

  it('impact walks both sides', () => {
    const leg = realizeOf(ownerBook()).legs[0];
    const mid = touchOf(OWNER_HL_ETH)?.mid ?? 0;
    const close = walkBook(OWNER_HL_ETH.asks, leg.qty);
    const reopen = walkBook(OWNER_HL_ETH.bids, leg.qty);
    expect(close && reopen).toBeTruthy();
    expect(leg.closeImpactUsd).toBeCloseTo(((close?.avgPrice ?? 0) - mid) * leg.qty, 6);
    expect(leg.reopenImpactUsd).toBeCloseTo((mid - (reopen?.avgPrice ?? 0)) * leg.qty, 6);
    expect(leg.impactBp).toBeCloseTo(((leg.closeImpactUsd + leg.reopenImpactUsd) / (leg.qty * mid)) * 10_000, 9);
  });

  it('realized cash covers the move and the fees', () => {
    const legs = realizeOf(ownerBook()).legs;
    const move = 45_314 - (45_314 - 29_812) / 2;
    const realized = legs.reduce((total, leg) => total + leg.realizedUsd, 0);
    expect(realized + 3_140).toBeGreaterThanOrEqual(move + costsOf(legs) - 1);
  });

  it('rounds the order up to the venue minimum', () => {
    const owner = ownerBook();
    const roomy = realizeBook({ ...owner.spec, availableMargin: 50_000 });
    const realize = realizeOf(roomy, { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 3_141 });
    const leg = realize.legs[0];
    expect(realize.refused).toBeNull();
    expect(leg.convert).toBeNull();
    const lots = leg.qty / 0.0001;
    expect(Math.abs(lots - Math.round(lots))).toBeLessThan(1e-6);
    expect(leg.qty).toBeGreaterThanOrEqual(0.0001);
    expect(leg.qty * 1_821).toBeGreaterThanOrEqual(10);
    expect((leg.qty - 0.0001) * 1_821).toBeLessThan(10);
  });

  it('a small custom with no margin refuses', () => {
    const realize = realizeOf(ownerBook(), { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 3_141 });
    expect(realize.refused).toEqual({ reason: 'no-margin', bp: null, maxBp: 25 });
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
    const realize = realizeOf(twoLegs(), REPAY_GOAL);
    expect(realize.legs.map((leg) => leg.base)).toEqual(['ETH', 'BTC']);
    expect(realize.legs[0].qty).toBe(20);
    expect(realize.legs[1].qty).toBeLessThan(2);
  });

  it('two legs clear the debt', () => {
    expect(walletIn(pickedAfter(twoLegs(), REPAY_GOAL), 'USDT', 'CROSSEX').cash).toBeGreaterThanOrEqual(-1);
  });

  it('switches leg when the first cannot fund its convert', () => {
    const realize = realizeOf(bookBb43(), REPAY_GOAL);
    expect(realize.legs[0].base).toBe('BTC');
    expect(realize.legs[0].positionQty).toBeCloseTo(92.7, 1);
    expect(Math.abs(realize.legs[0].qty - 59.07153)).toBeLessThanOrEqual(0.00001);
    expect(realize.legs.some((leg) => leg.base === 'ETH')).toBe(false);
    expect(realize.refused).toBeNull();
  });

  it('splits a convert above 500,000', () => {
    const convert = realizeOf(bookBb43(), REPAY_GOAL).legs[0].convert;
    expect(convert?.amount).toBeGreaterThan(CONVERT_MAX);
    expect(convert?.count).toBe(2);
  });

  it('gate long pays when eth rises', () => {
    const leg = realizeOf(ethUp()).legs[0];
    expect(leg).toMatchObject({ exchange: 'GATE', base: 'ETH', side: 'LONG', pool: 'CROSSEX' });
    expect(Math.abs(leg.qty - 47.369)).toBeLessThanOrEqual(0.001);
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

  it('refuses above 25 bp', () => {
    const realize = realizeOf(bookC0df(), REPAY_GOAL);
    expect(realize.legs[0]).toMatchObject({ exchange: 'GATE', base: 'ETH' });
    expect(realize.refused?.reason).toBe('too-thin');
    expect(Math.abs((realize.refused?.bp ?? 0) - 52.3)).toBeLessThanOrEqual(0.1);
  });

  it('runs at 25 bp or less', () => {
    const at = (half: number) =>
      planRealize(input({ moveUsd: 1_000, perps: [perp(OWNER_ETH, -10, 1_200, 1_000)], books: { [OWNER_ETH]: flatBook(1_000, half, 100) } }));
    const runs = at(1.245);
    expect(runs?.legs[0].impactBp).toBeCloseTo(24.9, 9);
    expect(runs?.refused).toBeNull();
    expect(at(1.255)?.refused).toEqual({ reason: 'too-thin', bp: 25.1, maxBp: 25 });
  });

  it('refuses an order past the fetched book', () => {
    const thin = planRealize(input({ books: { [OWNER_ETH]: flatBook(1_821, 0.5, 1) } }));
    expect(thin?.refused).toEqual({ reason: 'past-book', bp: null, maxBp: 25 });
    const unread = planRealize(input({ books: { [OWNER_ETH]: null } }));
    expect(unread?.refused).toEqual({ reason: 'past-book', bp: null, maxBp: 25 });
  });

  it('refuses when no leg can fund its convert', () => {
    const realize = planRealize(input({ availableMargin: -1_000_000 }));
    expect(realize?.legs[0].convert?.amount).toBeGreaterThan(10_000);
    expect(realize?.refused).toEqual({ reason: 'no-margin', bp: null, maxBp: 25 });
  });

  it('no realize when closing loses money even with no Convert', () => {
    // 0.08% profit against a 0.084% Hyperliquid round-trip fee, with margin to spare.
    const thin = planRealize(input({ perps: [perp(OWNER_ETH, -66, 1_821 * 1.0008, 1_821)] }));
    expect(thin).toBeNull();
  });

  it('a close that loses money only because of its Convert refuses as no margin', () => {
    const realize = planRealize(
      input({ perps: [perp(OWNER_ETH, -66, 1_821 * 1.01, 1_821)], availableMargin: 0, convertCounts: false }),
    );
    expect(realize?.legs[0].convert?.amount).toBeGreaterThan(0);
    expect(realize?.refused).toEqual({ reason: 'no-margin', bp: null, maxBp: 25 });
  });

  it('never realizes a lighter or binance leg', () => {
    const owner = ownerBook();
    const perps = [
      perp('LIGHTER_FUTURE_ETH_USDC', -66, 2_460, 1_821),
      perp('BINANCE_FUTURE_ETH_USDT', 66, 1_000, 1_821),
    ];
    const book = { ...owner, inputs: { ...owner.inputs, perps } };
    expect(planOf(book).realize).toBeNull();
    expect(planOf(book, REPAY_GOAL).realize).toBeNull();
    expect(planRealize(input({ pool: 'LIGHTER', perps }))).toBeNull();
    expect(planRealize(input({ pool: 'CROSSEX', perps }))).toBeNull();
  });
});

describe('planRealize and the free Hyperliquid borrow', () => {
  it('no realize under the free hyperliquid borrow', () => {
    expect(planOf(ethUp(9_000)).realize).toBeNull();
    expect(planOf(ethUp(9_000), REPAY_GOAL).realize).toBeNull();
  });

  it('custom realizes without a charged borrow', () => {
    const plan = planOf(ethUp(9_000), { kind: 'custom', from: 'CROSSEX', to: 'HYPERLIQUID', amount: 20_000 });
    expect(plan.realize?.legs[0]).toMatchObject({ exchange: 'GATE', side: 'LONG' });
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
    expect(job.steps.map((step) => step.name)).toEqual(['Close', ...converts.map(() => 'Convert'), 'Reopen']);
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
    convertCounts: true,
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
  it('an order over the market cap is refused', () => {
    const caps = [
      ['5', 500_000],
      ['10', 2_000_000],
      ['20', 5_000_000],
      ['25', 30_000_000],
    ] as const;
    let refusedCount = 0;
    for (const need of LADDER) {
      for (const [leverage, capUsd] of caps) {
        const plan = planRealize(hlShortInput(need, {}, leverage));
        const orderUsd = (plan?.legs[0].qty ?? 0) * 2800;
        if (orderUsd > capUsd) {
          refusedCount += 1;
          expect(plan?.refused).toEqual({ reason: 'over-cap', bp: null, maxBp: 25, capUsd });
        } else expect(plan?.refused?.reason).not.toBe('over-cap');
      }
    }
    expect(refusedCount).toBeGreaterThan(4);
    expect(planRealize(hlShortInput(5_000, {}, '5'))?.refused).toBeNull();
    const gate = (maxMarketSize: string): RealizeInput => ({
      ...hlShortInput(1_000_000),
      pool: 'CROSSEX',
      perps: [perp('GATE_FUTURE_ETH_USDT', -7_500, 3_000, 2_800)],
      books: { GATE_FUTURE_ETH_USDT: evenBook(2800, 2000, 500) },
      rules: { GATE_FUTURE_ETH_USDT: { lotSize: '0.001', minSize: '0.001', maxMarketSize } },
    });
    expect(planRealize(gate('100'))?.refused).toEqual({ reason: 'over-cap', bp: null, maxBp: 25, capUsd: 280_000 });
    expect(planRealize(gate('100000'))?.refused).toBeNull();
  });

  it('a refused realize still carries the plain cash move', () => {
    const book = ownerBook();
    const refused = { ...book.inputs, books: {} };
    for (const goal of [EVEN_GOAL, REPAY_GOAL]) {
      const plan = planFor(book.buckets, book.account, refused, goal);
      expect(plan.realize?.refused?.reason).toBe('past-book');
      expect(plan.balanced).toBe(false);
      expect(plan.moves).toBeGreaterThan(3_000);
      expect(plan.moves).toBeLessThanOrEqual(3_140);
    }
  });

  it('a missing fee rate refuses the realize', () => {
    for (const need of LADDER) {
      expect(planRealize(hlShortInput(need, { feeRows: [] }))).toEqual({
        legs: [],
        refused: { reason: 'no-fee-rate', bp: null, maxBp: 25 },
      });
    }
    const book = ownerBook();
    for (const goal of [EVEN_GOAL, REPAY_GOAL]) {
      const plan = planFor(book.buckets, book.account, { ...book.inputs, feeRows: [FEE_ROWS[1]] }, goal);
      expect(plan.realize?.refused?.reason).toBe('no-fee-rate');
      expect(plan.realize?.legs).toEqual([]);
      expect(plan.balanced).toBe(false);
      expect(plan.moves).toBeGreaterThan(3_000);
      expect(plan.moves).toBeLessThanOrEqual(3_140);
    }
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
    const gateRealize = planOf(ethUp(), REPAY_GOAL).realize;
    expect(gateRealize?.refused).toBeNull();
    expect(gateRealize?.legs[0].pool).toBe('CROSSEX');
    const owner = ownerBook();
    const assets = (owner.account.assets ?? []).map((asset) =>
      asset.coin === 'USDC' && asset.exchangeType === 'HYPERLIQUID'
        ? { ...asset, balance: '0', availableBalance: '0', equity: asset.upnl }
        : asset,
    );
    const account = { ...owner.account, assets };
    const buckets = bucketsFrom(account, [{ coin: 'USDT', exchangeType: 'CROSSEX', hourInterestRate: '0.000006' }], {});
    const plan = planFor(buckets, account, owner.inputs, REPAY_GOAL);
    expect(plan.realize?.refused).toBeNull();
    expect(plan.realize?.legs[0].pool).toBe('HYPERLIQUID');
    expect(sumNet(plan.realize?.legs ?? [])).toBeGreaterThan(29_000);
    expect(walletIn(pickedAfter({ ...owner, account, buckets }, REPAY_GOAL), 'USDT', 'CROSSEX').cash).toBeGreaterThan(-1);
  });

  it('clear debt realizes at every rung when the paying wallet holds no cash', () => {
    for (const debt of LADDER) {
      const qty = Math.max(1, (debt / 200) * 1.5);
      const owner = realizeBookOf(debt, qty);
      const plan = planFor(owner.buckets, owner.account, owner.inputs, REPAY_GOAL);
      expect(plan.realize?.refused).toBeNull();
      expect(sumNet(plan.realize?.legs ?? [])).toBeGreaterThanOrEqual(debt - 0.02);
    }
  });

  it('a wider Lighter gap keeps the Hyperliquid realize', () => {
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
    const plan = planFor(buckets, account, inputs, EVEN_GOAL);
    expect(plan.realize?.refused).toBeNull();
    expect(plan.realize?.legs[0].pool).toBe('HYPERLIQUID');
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
