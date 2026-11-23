import { describe, expect, it } from 'vitest';
import type { BorosOrderBook } from '../../src/core/boros/client';
import { walkBorosBook } from '../../src/core/boros/opportunities';
import { type NormalizedBook, touchOf } from '../../src/core/estimate/books';
import { pickCloseMakerLeg } from '../../src/core/estimate/closeMaker';
import { floorToStep } from '../../src/core/numbers';
import { type AccountLike, imUsedOf } from '../../src/core/rebalance/plan';
import { type DeleverInput, type DeleverRequest, planDelever } from '../../src/core/rebalance/delever';
import { minQtyOf } from '../../src/core/rebalance/realize';
import { sliceQtys } from '../../src/core/rebalance/slices';
import { BTC_MARK, FEE_ROWS, GATE_BTC, HL_BTC, PERP_RULES } from './fixtures/realize-books';

const HL = 'HYPERLIQUID_FUTURE_BTC_USDC';
const GATE = 'GATE_FUTURE_BTC_USDT';
const LOT = '0.0001';
const YEARS = 30 / 365;
const BOROS_FEE = 0.001;
const LADDER = [50, 5_000, 100_000, 1_000_000, 6_000_000];

const BOROS_BOOK: BorosOrderBook = {
  marketId: 155,
  bids: [
    [0.0922, 100],
    [0.09, 120],
    [0.085, 280],
  ],
  asks: [
    [0.0923, 60],
    [0.094, 160],
    [0.1, 360],
  ],
};

type BorosRow = DeleverInput['boros'][number];

const borosLeg = (marketId: number, size: number, book: BorosOrderBook | null = BOROS_BOOK): BorosRow => ({
  marketId,
  size,
  book,
  collateralPriceUsd: BTC_MARK,
  feeRate: BOROS_FEE,
  yearsToMaturity: YEARS,
});

interface Setup {
  held?: number;
  perps?: DeleverRequest['perps'];
  boros?: BorosRow[];
  borosAsk?: DeleverRequest['boros'];
  books?: Record<string, NormalizedBook | null>;
  sliceUsd?: number;
  order?: 'hl-first' | 'gate-first';
  short?: { symbol: string; exchange: string };
}

const accountOf = (held: number): AccountLike => ({
  marginBalance: String((held * BTC_MARK) / 4),
  initialMargin: String((held * BTC_MARK) / 40 + (held * BTC_MARK) / 25),
  availableMargin: String((held * BTC_MARK) / 4 - (held * BTC_MARK) / 40 - (held * BTC_MARK) / 25),
});

function inputOf(setup: Setup = {}): DeleverInput {
  const held = setup.held ?? 900;
  const boros = setup.boros ?? [borosLeg(155, held)];
  const short = setup.short ?? { symbol: HL, exchange: 'HYPERLIQUID' };
  const symbols = setup.order === 'gate-first' ? [GATE, short.symbol] : [short.symbol, GATE];
  return {
    request: {
      perps: setup.perps ?? symbols.map((symbol) => ({ symbol, qty: held * 0.2 })),
      boros: setup.borosAsk ?? boros.map((leg) => ({ marketId: leg.marketId, size: Math.abs(leg.size) * 0.2 })),
      exec: 'maker',
      ...(setup.sliceUsd !== undefined ? { sliceUsd: setup.sliceUsd } : {}),
    },
    positions: [
      { ...short, base: 'BTC', side: 'SHORT', qty: held, markPrice: BTC_MARK, initialMargin: (held * BTC_MARK) / 40 },
      { symbol: GATE, exchange: 'GATE', base: 'BTC', side: 'LONG', qty: held, markPrice: BTC_MARK, initialMargin: (held * BTC_MARK) / 25 },
    ],
    boros,
    books: setup.books ?? { [short.symbol]: HL_BTC, [GATE]: GATE_BTC },
    feeRows: FEE_ROWS,
    rules: PERP_RULES,
    account: accountOf(held),
  };
}

describe('planDelever', () => {
  it('same coin size on both perps', () => {
    const plan = planDelever(inputOf());
    expect(plan.legs.map(({ symbol, side, before, after, closeQty }) => ({ symbol, side, before, after, closeQty }))).toEqual([
      { symbol: HL, side: 'SHORT', before: 900, after: 720, closeQty: 180 },
      { symbol: GATE, side: 'LONG', before: 900, after: 720, closeQty: 180 },
    ]);
    expect(plan.boros).toEqual([{ marketId: 155, before: 900, after: 720, closeSize: 180 }]);
    expect(plan.refused).toBeNull();
  });

  it('every boros leg same share', () => {
    const plan = planDelever(inputOf({ boros: [borosLeg(155, 900), borosLeg(156, -450)] }));
    expect(plan.boros).toEqual([
      { marketId: 155, before: 900, after: 720, closeSize: 180 },
      { marketId: 156, before: -450, after: -360, closeSize: 90 },
    ]);
    for (const leg of plan.boros) expect(leg.closeSize / Math.abs(leg.before)).toBeCloseTo(0.2, 12);
  });

  it('clamps every leg to the live position', () => {
    const over = planDelever(
      inputOf({
        perps: [
          { symbol: HL, qty: 1_000 },
          { symbol: GATE, qty: 1_200 },
        ],
        borosAsk: [{ marketId: 155, size: 1_000 }],
      }),
    );
    expect(over.legs.map((leg) => [leg.closeQty, leg.after])).toEqual([
      [900, 0],
      [900, 0],
    ]);
    expect(over.boros[0]).toEqual({ marketId: 155, before: 900, after: 0, closeSize: 900 });
    const uneven = planDelever(
      inputOf({
        perps: [
          { symbol: HL, qty: 180 },
          { symbol: GATE, qty: 200 },
        ],
      }),
    );
    expect(uneven.legs.map((leg) => leg.closeQty)).toEqual([180, 180]);
  });

  it('delever qty floors to the lot at every rung', () => {
    const helds = [...LADDER.map((usd) => Number(floorToStep(usd / BTC_MARK, LOT))), 60, 900];
    for (const held of helds) {
      const step = Number(floorToStep(held / 2, LOT));
      const ask = (qty: number): number =>
        planDelever(
          inputOf({
            held,
            perps: [
              { symbol: HL, qty },
              { symbol: GATE, qty },
            ],
          }),
        ).legs[0].closeQty;
      expect(ask(step + 1e-9)).toBe(step);
      expect(ask(step + Number(LOT) - 1e-9)).toBe(step);
      expect(ask(held + 1e-9)).toBe(held);
      expect(ask(held * 10)).toBe(held);
    }
    expect(planDelever(inputOf({ perps: [{ symbol: HL, qty: 0.29 * 900 }, { symbol: GATE, qty: 0.29 * 900 }] })).legs[0].closeQty).toBe(261);
  });

  it('refuses a qty below the venue minimum, naming the venue and its minimum', () => {
    const tiny = planDelever(
      inputOf({
        perps: [
          { symbol: HL, qty: 0.0001 },
          { symbol: GATE, qty: 0.0001 },
        ],
      }),
    );
    const gateMin = minQtyOf(PERP_RULES[GATE], LOT, BTC_MARK);
    expect(gateMin).toBe(0.0002);
    expect(tiny.refused).toEqual({ reason: 'below-min', venue: 'GATE', minQty: gateMin, coin: 'BTC' });
    const atMin = planDelever(
      inputOf({
        perps: [
          { symbol: HL, qty: gateMin },
          { symbol: GATE, qty: gateMin },
        ],
      }),
    );
    expect(atMin.refused).toBeNull();
  });

  it('boros impact from the book', () => {
    const withBook = planDelever(inputOf());
    const noBook = planDelever(inputOf({ boros: [borosLeg(155, 900, null)] }));
    const walk = walkBorosBook(BOROS_BOOK.bids, 180, 1);
    if (!walk) throw new Error('walk');
    const mid = (BOROS_BOOK.bids[0][0] + BOROS_BOOK.asks[0][0]) / 2;
    const expected = Math.abs(walk.execApr - mid) * 180 * BTC_MARK * YEARS;
    expect(expected).toBeGreaterThan(0);
    for (const exec of ['maker', 'market'] as const) {
      expect(withBook.estimates[exec].impactUsd - noBook.estimates[exec].impactUsd).toBeCloseTo(expected, 6);
    }
    const pastBook = planDelever(inputOf({ borosAsk: [{ marketId: 155, size: 900 }] }));
    const pastNoBook = planDelever(inputOf({ boros: [borosLeg(155, 900, null)], borosAsk: [{ marketId: 155, size: 900 }] }));
    const filled = BOROS_BOOK.bids.reduce((total, [apr, size]) => total + apr * size, 0);
    const depth = BOROS_BOOK.bids.reduce((total, [, size]) => total + size, 0);
    const avg = (filled + 0.085 * (900 - depth)) / 900;
    expect(pastBook.estimates.market.impactUsd - pastNoBook.estimates.market.impactUsd).toBeCloseTo(
      Math.abs(avg - mid) * 900 * BTC_MARK * YEARS,
      6,
    );
  });

  it('estimate has perps fee, boros fee and impact from both perp books', () => {
    const plan = planDelever(inputOf());
    const notional = 180 * BTC_MARK;
    expect(plan.makerLeg).toBe(1);
    expect(plan.estimates.maker.feePerpsUsd).toBeCloseTo(notional * (0.0002 + 0.00042), 6);
    expect(plan.estimates.market.feePerpsUsd).toBeCloseTo(notional * (0.0005 + 0.00042), 6);
    const feeBoros = BOROS_FEE * 180 * BTC_MARK * YEARS;
    const perpsOnly = planDelever(inputOf({ boros: [borosLeg(155, 900, null)] }));
    for (const exec of ['maker', 'market'] as const) {
      const estimate = plan.estimates[exec];
      expect(estimate.feeBorosUsd).toBeCloseTo(feeBoros, 6);
      expect(estimate.totalUsd).toBeCloseTo(estimate.feePerpsUsd + estimate.feeBorosUsd + estimate.impactUsd, 6);
      expect(perpsOnly.estimates[exec].impactUsd).toBeGreaterThan(0);
      expect(estimate.impactUsd).toBeGreaterThan(perpsOnly.estimates[exec].impactUsd);
    }
    expect(plan.estimates.market.impactUsd).toBeGreaterThan(plan.estimates.maker.impactUsd);
  });

  it('maker leg from pickCloseMakerLeg', () => {
    const hlRates = { makerRate: 0.00018, takerRate: 0.00042, slippagePct: null };
    const gateRates = { makerRate: 0.0002, takerRate: 0.0005, slippagePct: null };
    expect(planDelever(inputOf()).makerLeg).toBe(pickCloseMakerLeg(hlRates, gateRates));
    expect(planDelever(inputOf({ order: 'gate-first' })).makerLeg).toBe(pickCloseMakerLeg(gateRates, hlRates));
    expect(planDelever(inputOf({ order: 'gate-first' })).makerLeg).toBe(0);
  });

  it('im used per margin account before and after', () => {
    const pairs = [
      { symbol: HL, exchange: 'HYPERLIQUID' },
      { symbol: 'LIGHTER_FUTURE_BTC_USDC', exchange: 'LIGHTER' },
    ];
    for (const short of pairs) {
      const input = inputOf({ short });
      const plan = planDelever(input);
      expect(plan.imUsed).toHaveLength(1);
      const [row] = plan.imUsed;
      expect(row.account).toBe('CROSSEX');
      expect(row.before).toBe(imUsedOf(input.account)[0].pct);
      expect(row.before).toBeCloseTo(0.26, 12);
      expect(row.after).toBeCloseTo(0.26 * 0.8, 12);
    }
  });

  it('refuses a leg with no order book', () => {
    expect(() => planDelever(inputOf({ books: { [HL]: HL_BTC, [GATE]: null } }))).toThrow(`No order book for ${GATE}.`);
    expect(() => planDelever(inputOf({ books: { [HL]: { bids: [], asks: [], ts: 0 }, [GATE]: GATE_BTC } }))).toThrow(
      `No order book for ${HL}.`,
    );
  });

  it('prices the slices and the not-hedged qty on the follow leg', () => {
    const plan = planDelever(inputOf({ sliceUsd: 100_000 }));
    const mid = touchOf(HL_BTC)?.mid ?? 0;
    const minQty = Math.max(minQtyOf(PERP_RULES[HL], LOT, BTC_MARK), minQtyOf(PERP_RULES[GATE], LOT, BTC_MARK));
    const qtys = sliceQtys(180, 100_000 / mid, minQty, LOT);
    expect(plan.notHedgedMaxQty).toBe(Math.max(...qtys));
    expect(plan.notHedgedMaxUsd).toBeCloseTo(plan.notHedgedMaxQty * mid, 6);
    expect(plan.sliceOptions.some((option) => option.custom && option.sizeUsd === 100_000)).toBe(true);
    expect(plan.defaultSliceUsd).toBeGreaterThan(0);
  });

  it('prices every rung of the size ladder', () => {
    for (const usd of LADDER) {
      const held = Number(floorToStep((usd * 5) / BTC_MARK, LOT));
      const plan = planDelever(inputOf({ held }));
      const closeQty = plan.legs[0].closeQty;
      expect(closeQty).toBe(Number(floorToStep(held * 0.2, LOT)));
      expect(plan.estimates.market.feePerpsUsd).toBeCloseTo(closeQty * BTC_MARK * (0.0005 + 0.00042), 6);
      for (const exec of ['maker', 'market'] as const) {
        expect(Number.isFinite(plan.estimates[exec].totalUsd)).toBe(true);
        expect(plan.estimates[exec].totalUsd).toBeGreaterThan(0);
      }
      expect(plan.notHedgedMaxQty).toBeLessThanOrEqual(closeQty);
    }
  });

  it('refuses a request that names a missing leg or a market twice', () => {
    expect(() => planDelever(inputOf({ perps: [{ symbol: HL, qty: 1 }, { symbol: 'GATE_FUTURE_ETH_USDT', qty: 1 }] }))).toThrow(
      'No open position on GATE_FUTURE_ETH_USDT.',
    );
    expect(() => planDelever(inputOf({ borosAsk: [{ marketId: 155, size: 1 }, { marketId: 155, size: 1 }] }))).toThrow(
      'A Boros market is listed twice.',
    );
    expect(() => planDelever(inputOf({ borosAsk: [{ marketId: 999, size: 1 }] }))).toThrow(
      'No open Boros position on market 999.',
    );
  });

  it('refuses two perps on the same side, so it never doubles the exposure', () => {
    const base = inputOf();
    const plan = planDelever({ ...base, positions: base.positions.map((row) => ({ ...row, side: 'LONG' as const })) });
    expect(plan.refused).toEqual({ reason: 'same-side', coin: 'BTC' });
    expect(planDelever(inputOf()).refused).toBeNull();
  });

  it('caps the custom slice at the venue max order size, from $50 to $6M', () => {
    const maxCoins = 2;
    const rules = { ...PERP_RULES, [GATE]: { ...PERP_RULES[GATE], maxMarketSize: String(maxCoins) } };
    const capUsd = maxCoins * BTC_MARK;
    for (const sliceUsd of LADDER) {
      const plan = planDelever({ ...inputOf({ sliceUsd }), rules });
      const custom = plan.sliceOptions.find((option) => option.custom);
      expect(custom?.sizeUsd).toBeLessThanOrEqual(capUsd);
      expect(plan.notHedgedMaxQty).toBeLessThanOrEqual(maxCoins);
      for (const option of plan.sliceOptions) expect(option.notHedgedMaxQty).toBeLessThanOrEqual(maxCoins);
    }
    const free = planDelever(inputOf({ sliceUsd: 50_000_000 }));
    expect(free.notHedgedMaxQty).toBe(180);
  });
});

describe('planDelever: a 100% Delever closes the whole position', () => {
  const unevenOf = (hl: number, gate: number, pct: number): DeleverInput => {
    const base = inputOf({ held: Math.min(hl, gate), perps: [{ symbol: HL, qty: hl * pct }, { symbol: GATE, qty: gate * pct }] });
    const sizeOf = (symbol: string): number => (symbol === HL ? hl : gate);
    return {
      ...base,
      positions: base.positions.map((row) => ({ ...row, qty: sizeOf(row.symbol), initialMargin: (sizeOf(row.symbol) * BTC_MARK) / (row.symbol === HL ? 40 : 25) })),
    };
  };
  const SIZES = [
    [0.01659, 0.0166],
    [63.15789, 63.1579],
  ];

  it.each(SIZES)('100%% of %d BTC on Hyperliquid and %d BTC on Gate closes both legs whole', (hl, gate) => {
    const plan = planDelever(unevenOf(hl, gate, 1));
    expect(plan.legs.map(({ before, after, closeQty, closeAll }) => ({ before, after, closeQty, closeAll }))).toEqual([
      { before: hl, after: 0, closeQty: Number(floorToStep(hl, LOT)), closeAll: true },
      { before: gate, after: 0, closeQty: Number(floorToStep(hl, LOT)), closeAll: true },
    ]);
    expect(plan.imUsed[0].after).toBe(0);
    expect(plan.refused).toBeNull();
  });

  it.each(SIZES)('50%% of %d BTC on Hyperliquid and %d BTC on Gate keeps the rest open', (hl, gate) => {
    const plan = planDelever(unevenOf(hl, gate, 0.5));
    const closeQty = Number(floorToStep(hl * 0.5, LOT));
    expect(plan.legs.map(({ after, closeQty: qty, closeAll }) => ({ after, qty, closeAll }))).toEqual([
      { after: Number((hl - closeQty).toFixed(5)), qty: closeQty, closeAll: false },
      { after: Number((gate - closeQty).toFixed(4)), qty: closeQty, closeAll: false },
    ]);
  });

  it('a typed size 0.00005 BTC under the $6M pair closes both perps and every asked Boros leg in full', () => {
    const hl = 63.15789;
    const typed = hl - 0.00005;
    const base = unevenOf(hl, 63.1579, 1);
    const input: DeleverInput = {
      ...base,
      boros: [borosLeg(155, hl), borosLeg(156, -30)],
      request: { ...base.request, perps: [{ symbol: HL, qty: typed }, { symbol: GATE, qty: typed }], boros: [{ marketId: 155, size: typed }, { marketId: 156, size: 0 }] },
    };
    const plan = planDelever(input);
    expect(plan.legs.map(({ closeAll, after }) => [closeAll, after])).toEqual([
      [true, 0],
      [true, 0],
    ]);
    expect(plan.boros).toEqual([
      { marketId: 155, before: hl, after: 0, closeSize: hl },
      { marketId: 156, before: -30, after: -30, closeSize: 0 },
    ]);
    const half = planDelever({ ...input, request: { ...input.request, perps: [{ symbol: HL, qty: hl / 2 }, { symbol: GATE, qty: hl / 2 }], boros: [{ marketId: 155, size: hl / 2 }] } });
    expect(half.boros).toEqual([{ marketId: 155, before: hl, after: hl - hl / 2, closeSize: hl / 2 }]);
  });

  it('a $6M Boros market held at twice the pair share closes only the asked share on a 100% Delever', () => {
    const hl = 63.15789;
    const base = unevenOf(hl, 63.1579, 1);
    const input: DeleverInput = {
      ...base,
      boros: [borosLeg(155, 2 * hl)],
      request: { ...base.request, perps: [{ symbol: HL, qty: hl }, { symbol: GATE, qty: 63.1579 }], boros: [{ marketId: 155, size: hl }] },
    };
    const plan = planDelever(input);
    expect(plan.legs.map(({ closeAll }) => closeAll)).toEqual([true, true]);
    expect(plan.boros).toEqual([{ marketId: 155, before: 2 * hl, after: 2 * hl - hl, closeSize: hl }]);
    const typed = planDelever({ ...input, request: { ...input.request, boros: [{ marketId: 155, size: hl - 0.00005 }] } });
    expect(typed.boros[0].closeSize).toBe(hl - 0.00005);
  });

  it.each([
    [0.0165, 0.0166],
    [0.01659, 0.0167],
    [63.1578, 63.1579],
    [63.15789, 63.158],
  ])('a Gate leg one lot or more above the %d BTC pair is not closed whole', (hl, gate) => {
    const input = unevenOf(hl, gate, 1);
    const plan = planDelever(input);
    const closeQty = Number(floorToStep(hl, LOT));
    expect(plan.legs.map(({ closeAll }) => closeAll)).toEqual([true, false]);
    expect(plan.legs[0].after).toBe(0);
    expect(plan.legs[1].after).toBe(Number((gate - closeQty).toFixed(4)));
    expect(plan.legs[1].after).toBeGreaterThanOrEqual(Number(LOT));
    const freed = (hl * BTC_MARK) / 40 + (closeQty / gate) * ((gate * BTC_MARK) / 25);
    const account = input.account;
    expect(plan.imUsed[0].after).toBeCloseTo(Math.max(0, Number(account.initialMargin) - freed) / Number(account.marginBalance), 12);
  });
});
