/**
 * Fixed-return opportunity math (src/core/boros/opportunities.ts): arb grouping,
 * the non-extrapolating Boros book walk, the 4-leg cost ledger, the maker-hedge
 * joint minimum, roll vs close, and every degraded mode's null + reason.
 *
 * Every expectation is derived by hand below — never by calling the code under
 * test. Book APRs carry float noise (923 × 0.0001 = 0.09230000000000001), so
 * rates are compared with toBeCloseTo, never toBe.
 */
import { describe, expect, it } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import {
  borosAprFloor,
  borosInitialMarginUsd,
  buildOpportunities,
  groupBorosMarkets,
  normalizeUnderlying,
  perpInitialMarginUsd,
  walkBorosBook,
  type BuildOpportunitiesInput,
  type BuildOpportunitiesOptions,
} from '../../src/core/boros/opportunities';
import { SECONDS_IN_YEAR } from '../../src/core/boros/returns';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { imInputs } from '../helpers/boros-fixtures';

const NOW = 1_752_000_000;
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;
const N = 1_000_000;
/** Shared duration of the canonical fixture, in years. */
const T = (30 * DAY) / SECONDS_IN_YEAR;

/** The fixture's margin floor: 1.00005 ^ (770 × 2) − 1 ≈ 0.08004. */
const FLOOR = 1.00005 ** (770 * 2) - 1;
/** Venue max leverage, deliberately different per venue. */
const HL_LEVERAGE = 10;
const BN_LEVERAGE = 20;

const HL_SYMBOL = 'HYPERLIQUID_FUTURE_ETH_USDC';
const BN_SYMBOL = 'BINANCE_FUTURE_ETH_USDT';

const hlMarket: BorosMarket = {
  maxRateDeviationApr: 0.016,
  marketId: 155,
  tokenId: 3,
  name: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  maturity: MATURITY,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: 0.089,
  floatingApr: 0.088,
  midApr: 0.09,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 1_880,
  ...imInputs,
};
const bnMarket: BorosMarket = {
  ...hlMarket,
  marketId: 101,
  name: 'Binance ETHUSDT 31 Aug 2026',
  venue: 'Binance',
  markApr: 0.046,
  floatingApr: 0.044,
  midApr: 0.045,
  notionalOi: 3_000_000,
};

/** Deep one-level book: best bid 0.0899 / best ask 0.0901 (HL), 0.0449/0.0451 (BN). */
const borosBook = (marketId: number, bidApr: number, askApr: number): BorosOrderBook => ({
  marketId,
  bids: [[bidApr, 20_000_000]],
  asks: [[askApr, 20_000_000]],
});

/** Perp book with mid exactly 1000, so N = $1M ⇒ qty = 1000 contracts. */
const perpBook = (halfSpread: number, size = 5_000): NormalizedBook => ({
  bids: [[1000 - halfSpread, size]],
  asks: [[1000 + halfSpread, size]],
  ts: 0,
});

const feeRows = [
  { exchangeType: 'HYPERLIQUID', futureMakerFee: '0.0002', futureTakerFee: '0.0005' },
  { exchangeType: 'BINANCE', futureMakerFee: '0.0002', futureTakerFee: '0.0005' },
];

function input(over: Partial<BuildOpportunitiesInput> = {}): BuildOpportunitiesInput {
  return {
    markets: [hlMarket, bnMarket],
    collateralPricesUsd: new Map([[3, 1]]),
    borosBooks: new Map([
      [155, borosBook(155, 0.0899, 0.0901)],
      [101, borosBook(101, 0.0449, 0.0451)],
    ]),
    venueBooks: new Map([
      [HL_SYMBOL, perpBook(0.1)],
      [BN_SYMBOL, perpBook(0.1)],
    ]),
    symbolsByVenueBase: new Map([
      ['HYPERLIQUID:ETH', HL_SYMBOL],
      ['BINANCE:ETH', BN_SYMBOL],
    ]),
    leverageMaxBySymbol: new Map([
      [HL_SYMBOL, HL_LEVERAGE],
      [BN_SYMBOL, BN_LEVERAGE],
    ]),
    feeRows,
    nowSec: NOW,
    ...over,
  };
}

const opts = (over: Partial<BuildOpportunitiesOptions> = {}): BuildOpportunitiesOptions => ({
  notionalUsd: N,
  borosEntry: 'market',
  entryMode: 'both-market',
  exitMode: 'close',
  ...over,
});

describe('groupBorosMarkets', () => {
  it('groups by collateral + maturity + underlying, members midApr desc', () => {
    const groups = groupBorosMarkets([bnMarket, hlMarket], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(`3:${MATURITY}:ETH`);
    expect(groups[0].collateral).toBe('USDT');
    expect(groups[0].markets.map((m) => m.marketId)).toEqual([155, 101]);
  });

  it('drops singleton groups — a differing collateral or maturity splits the pair apart', () => {
    expect(groupBorosMarkets([hlMarket, { ...bnMarket, tokenId: 2 }], NOW)).toHaveLength(0);
    expect(
      groupBorosMarkets([hlMarket, { ...bnMarket, maturity: MATURITY + DAY }], NOW),
    ).toHaveLength(0);
  });

  it('excludes matured markets and any state other than Normal', () => {
    expect(groupBorosMarkets([hlMarket, { ...bnMarket, maturity: NOW }], NOW)).toHaveLength(0);
    expect(groupBorosMarkets([hlMarket, { ...bnMarket, state: 'Matured' }], NOW)).toHaveLength(0);
  });

  it('collapses fungible tickers into one underlying (XAU + GOLD → GOLD)', () => {
    expect(normalizeUnderlying('xau')).toBe('GOLD');
    expect(normalizeUnderlying('BRENTOIL')).toBe('CRUDE');
    expect(normalizeUnderlying('SOL')).toBe('SOL');
    const groups = groupBorosMarkets(
      [
        { ...hlMarket, base: 'XAU', name: 'Hyperliquid XAU' },
        { ...bnMarket, base: 'GOLD', name: 'Binance GOLD' },
      ],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].underlying).toBe('GOLD');
  });
});

describe('walkBorosBook', () => {
  it('VWAPs across levels exactly, in book order', () => {
    // 6000 USD @ 9% + 4000 USD @ 8.8% = 540 + 352 = 892 over 10_000.
    const walk = walkBorosBook(
      [
        [0.09, 6_000],
        [0.088, 10_000],
      ],
      10_000,
      1,
    );
    expect(walk!.execApr).toBeCloseTo(892 / 10_000, 10);
    expect(walk!.filledUsd).toBeCloseTo(10_000, 6);
    expect(walk!.insufficient).toBe(false);
  });

  it('never extrapolates the tail — a short book flags insufficient', () => {
    // Only 16_000 available: 540 + 880 = 1420 over 16_000 = 8.875%.
    const walk = walkBorosBook(
      [
        [0.09, 6_000],
        [0.088, 10_000],
      ],
      20_000,
      1,
    );
    expect(walk!.execApr).toBeCloseTo(1420 / 16_000, 10);
    expect(walk!.filledUsd).toBeCloseTo(16_000, 6);
    expect(walk!.insufficient).toBe(true);
  });

  it('scales collateral-token sizes by the collateral price', () => {
    // 6 ETH = $11_280 @ 9%, then 8_720 of the 10-ETH level @ 8.8%.
    const walk = walkBorosBook(
      [
        [0.09, 6],
        [0.088, 10],
      ],
      20_000,
      1_880,
    );
    expect(walk!.execApr).toBeCloseTo((11_280 * 0.09 + 8_720 * 0.088) / 20_000, 10);
    expect(walk!.insufficient).toBe(false);
  });

  it('returns null on an empty side or a non-positive size/price', () => {
    expect(walkBorosBook([], 10_000, 1)).toBeNull();
    expect(walkBorosBook([[0.09, 100]], 0, 1)).toBeNull();
    expect(walkBorosBook([[0.09, 100]], 10_000, 0)).toBeNull();
  });
});

describe('buildOpportunities — canonical pair (both-market entry, close at maturity)', () => {
  const result = () => buildOpportunities(input(), opts());

  it('pairs the high-mid market SHORT against the low-mid market LONG', () => {
    const group = result().groups[0];
    expect(group.tokenId).toBe(3);
    expect(group.collateral).toBe('USDT');
    expect(group.collateralPriceUsd).toBe(1);
    expect(group.underlying).toBe('ETH');
    expect(group.secondsToMaturity).toBe(30 * DAY);
    expect(group.pairs).toHaveLength(1);
    const pair = group.bestPair!;
    expect(pair.shortLeg.marketId).toBe(155);
    expect(pair.shortLeg.crossexSymbol).toBe(HL_SYMBOL);
    expect(pair.longLeg.marketId).toBe(101);
    expect(pair.longLeg.crossexSymbol).toBe(BN_SYMBOL);
    expect(pair.base).toBe('ETH');
  });

  it('locks the bid of A against the ask of B, and reports the book impact', () => {
    const pair = result().groups[0].bestPair!;
    // SHORT fixed sells into A's bids (8.99%); LONG fixed lifts B's asks (4.51%).
    expect(pair.shortLeg.execApr).toBeCloseTo(0.0899, 10);
    expect(pair.longLeg.execApr).toBeCloseTo(0.0451, 10);
    expect(pair.grossSpreadApr).toBeCloseTo(0.09 - 0.045, 10);
    expect(pair.execSpreadApr).toBeCloseTo(0.0899 - 0.0451, 10);
    expect(pair.borosImpactApr).toBeCloseTo(0.045 - (0.0899 - 0.0451), 10);
    expect(pair.reasons).toEqual([]);
  });

  it('pins every cost component, the annualized drag, and the net fixed APR', () => {
    const pair = result().groups[0].bestPair!;
    // Boros carried fees: (5bps + 5bps) and (10bps + 10bps) on $1M for 30/365y.
    expect(pair.costs.borosTakerFeeUsd).toBeCloseTo(0.001 * N * T, 8);
    expect(pair.costs.borosSettleFeeUsd).toBeCloseTo(0.002 * N * T, 8);
    // Perp entry: taker both sides, $1M × 5bps each.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(2 * N * 0.0005, 8);
    // qty = 1M/1000 = 1000; each side crosses half a $0.2 spread → $100.
    expect(pair.costs.perpEntrySlippageUsd).toBeCloseTo(2 * 0.1 * 1000, 8);
    // Close flips sides on the same snapshots — symmetric here.
    expect(pair.costs.perpExitFeesUsd).toBeCloseTo(2 * N * 0.0005, 8);
    expect(pair.costs.perpExitSlippageUsd).toBeCloseTo(2 * 0.1 * 1000, 8);
    expect(pair.makerLeg).toBeNull();

    const total = 0.001 * N * T + 0.002 * N * T + 1_000 + 200 + 1_000 + 200;
    expect(pair.costs.totalUsd).toBeCloseTo(total, 8);
    expect(pair.costs.annualizedApr).toBeCloseTo(total / (N * T), 10);
    expect(pair.netFixedApr).toBeCloseTo(0.0899 - 0.0451 - total / (N * T), 10);
    expect(pair.estProfitUsd).toBeCloseTo((0.0899 - 0.0451 - total / (N * T)) * N * T, 6);
    expect(pair.secondsToMaturity).toBe(30 * DAY);
  });

  it('reports every group member with its exec rates, OI in USD, and book status', () => {
    const [hl, bn] = result().groups[0].markets;
    expect(hl.marketId).toBe(155);
    expect(hl.bookStatus).toBe('ok');
    expect(hl.execShortApr).toBeCloseTo(0.0899, 10);
    expect(hl.execLongApr).toBeCloseTo(0.0901, 10);
    expect(hl.oiUsd).toBeCloseTo(5_000_000, 6);
    expect(hl.crossexVenue).toBe('HYPERLIQUID');
    expect(bn.crossexSymbol).toBe(BN_SYMBOL);
  });

  it('applies takerFeeOverride (the BOROS_TAKER_FEE_OVERRIDE knob) to both markets', () => {
    const pair = buildOpportunities(input(), opts({ takerFeeOverride: 0.0001 })).groups[0]
      .bestPair!;
    expect(pair.costs.borosTakerFeeUsd).toBeCloseTo(0.0002 * N * T, 8);
  });
});

describe('borosAprFloor', () => {
  it('compounds the margin tick step over the threshold', () => {
    expect(borosAprFloor(hlMarket)).toBeCloseTo(1.00005 ** 1540 - 1, 12);
    // Live BYBIT-HYPEUSDT-31JUL2026: 583 ticks of 2 ≈ 6.00%.
    expect(borosAprFloor({ ...hlMarket, imTickThresh: 583 })).toBeCloseTo(
      1.00005 ** 1166 - 1,
      12,
    );
  });

  it('is inert when either input is missing', () => {
    expect(borosAprFloor({ ...hlMarket, imTickThresh: 0, imTickStep: 0 })).toBe(0);
    expect(borosAprFloor({ ...hlMarket, imTickStep: NaN })).toBe(0);
    expect(borosAprFloor({ ...hlMarket, imTickThresh: undefined as unknown as number })).toBe(0);
  });
});

describe('borosInitialMarginUsd', () => {
  const kIM = imInputs.kIM;

  it('charges the entry rate when it clears the floor', () => {
    // 9.231% > 8.004% floor; 30d > 5d tThresh.
    const im = borosInitialMarginUsd(hlMarket, 0.09231, N, NOW);
    expect(im).toBeCloseTo((N * 0.09231 * 30 * kIM) / 365, 6);
  });

  it('charges the floor when the entry rate is below it', () => {
    // 2.531% < 8.004% floor — the live HYPE cohort's case.
    const im = borosInitialMarginUsd(hlMarket, 0.02531, N, NOW);
    expect(im).toBeCloseTo((N * FLOOR * 30 * kIM) / 365, 6);
  });

  it('uses the magnitude of a negative entry rate', () => {
    expect(borosInitialMarginUsd(hlMarket, -0.2, N, NOW)).toBeCloseTo(
      (N * 0.2 * 30 * kIM) / 365,
      6,
    );
  });

  it('floors the time at tThresh on a short-dated market', () => {
    // BYBIT-HYPEUSDT-31JUL2026 shape: 10d tThresh against 6d to maturity.
    const shortDated: BorosMarket = {
      ...hlMarket,
      maturity: NOW + 6 * DAY,
      tThreshSec: 10 * DAY,
    };
    expect(borosInitialMarginUsd(shortDated, 0.09231, N, NOW)).toBeCloseTo(
      (N * 0.09231 * 10 * kIM) / 365,
      6,
    );
  });

  it('uses the real time to maturity once it exceeds tThresh', () => {
    const longDated: BorosMarket = { ...hlMarket, tThreshSec: 10 * DAY };
    expect(borosInitialMarginUsd(longDated, 0.09231, N, NOW)).toBeCloseTo(
      (N * 0.09231 * 30 * kIM) / 365,
      6,
    );
  });

  it('is null — never 0 — when the margin coefficient is absent', () => {
    expect(borosInitialMarginUsd({ ...hlMarket, kIM: 0 }, 0.09, N, NOW)).toBeNull();
    expect(borosInitialMarginUsd({ ...hlMarket, kIM: NaN }, 0.09, N, NOW)).toBeNull();
  });
});

describe('perpInitialMarginUsd', () => {
  it('sizes the leg at the venue max leverage', () => {
    expect(perpInitialMarginUsd(1_000_000, 10)).toBeCloseTo(100_000, 6);
    // No preflight buffer and no taker-fee reserve — raw initial margin.
    expect(perpInitialMarginUsd(1_000_000, 20)).toBeCloseTo(50_000, 6);
  });

  it('is null when the leverage cap is unknown or non-positive', () => {
    expect(perpInitialMarginUsd(1_000_000, 0)).toBeNull();
    expect(perpInitialMarginUsd(1_000_000, -5)).toBeNull();
    expect(perpInitialMarginUsd(1_000_000, undefined)).toBeNull();
    expect(perpInitialMarginUsd(1_000_000, null)).toBeNull();
  });
});

describe('buildOpportunities — capital and the APR on capital', () => {
  const kIM = imInputs.kIM;
  /** Hand-derived from the canonical fixture: exec 8.99% short / 4.51% long. */
  const borosShort = (N * 0.0899 * 30 * kIM) / 365;
  const borosLong = (N * FLOOR * 30 * kIM) / 365; // 4.51% < the 8.004% floor
  const capital = borosShort + borosLong + N / HL_LEVERAGE + N / BN_LEVERAGE;

  it('models each leg margin and sums them into capital', () => {
    const pair = buildOpportunities(input(), opts()).groups[0].bestPair!;
    expect(pair.capital.borosShortImUsd).toBeCloseTo(borosShort, 6);
    expect(pair.capital.borosLongImUsd).toBeCloseTo(borosLong, 6);
    expect(pair.capital.perpShortImUsd).toBeCloseTo(100_000, 6);
    expect(pair.capital.perpLongImUsd).toBeCloseTo(50_000, 6);
    expect(pair.capital.shortLeverageMax).toBe(HL_LEVERAGE);
    expect(pair.capital.longLeverageMax).toBe(BN_LEVERAGE);
    expect(pair.capitalUsd).toBeCloseTo(capital, 6);
    // Perp margin dominates: ~$150k of the ~$156k total.
    expect(pair.effectiveLeverage).toBeCloseTo(N / capital, 10);
  });

  it('quotes the net fixed APR on that capital, far above the notional basis', () => {
    const pair = buildOpportunities(input(), opts()).groups[0].bestPair!;
    const total = 0.001 * N * T + 0.002 * N * T + 1_000 + 200 + 1_000 + 200;
    const netOnNotional = 0.0899 - 0.0451 - total / (N * T);
    const profit = netOnNotional * N * T;
    expect(pair.netFixedAprOnCapital).toBeCloseTo(profit / (capital * T), 10);
    // The two bases differ by exactly the effective leverage.
    expect(pair.netFixedAprOnCapital! / pair.netFixedApr!).toBeCloseTo(N / capital, 8);
  });

  it('is identically estProfitUsd / (capitalUsd × T)', () => {
    for (const mode of ['mark', 'market'] as const) {
      for (const pair of buildOpportunities(input(), opts({ borosEntry: mode })).groups[0].pairs) {
        expect(pair.netFixedAprOnCapital).toBeCloseTo(
          pair.estProfitUsd! / (pair.capitalUsd! * T),
          12,
        );
      }
    }
  });

  it('a missing leverage row nulls capital only, naming the venue and symbol', () => {
    const out = buildOpportunities(
      input({ leverageMaxBySymbol: new Map([[HL_SYMBOL, HL_LEVERAGE]]) }),
      opts(),
    );
    const pair = out.groups[0].pairs[0];
    expect(pair.capital.perpShortImUsd).toBeCloseTo(100_000, 6);
    expect(pair.capital.perpLongImUsd).toBeNull();
    expect(pair.capital.longLeverageMax).toBeNull();
    expect(pair.capitalUsd).toBeNull();
    expect(pair.netFixedAprOnCapital).toBeNull();
    expect(pair.effectiveLeverage).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /No max leverage for BINANCE BINANCE_FUTURE_ETH_USDT — that perp leg's initial margin can't be modelled/,
    );
    // The notional basis is untouched.
    const total = 0.001 * N * T + 0.002 * N * T + 1_000 + 200 + 1_000 + 200;
    expect(pair.netFixedApr).toBeCloseTo(0.0899 - 0.0451 - total / (N * T), 10);
    expect(pair.estProfitUsd).toBeCloseTo((0.0899 - 0.0451 - total / (N * T)) * N * T, 6);
    expect(out.groups[0].bestPair).toBeNull();
  });

  it('a market without a margin coefficient nulls capital only, naming the market', () => {
    const out = buildOpportunities(
      input({ markets: [hlMarket, { ...bnMarket, kIM: 0 }] }),
      opts(),
    );
    const pair = out.groups[0].pairs[0];
    expect(pair.capital.borosShortImUsd).toBeCloseTo(borosShort, 6);
    expect(pair.capital.borosLongImUsd).toBeNull();
    expect(pair.capitalUsd).toBeNull();
    expect(pair.netFixedAprOnCapital).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /Binance ETHUSDT 31 Aug 2026 \(market #101\) carries no margin coefficient/,
    );
    const total = 0.001 * N * T + 0.002 * N * T + 1_000 + 200 + 1_000 + 200;
    expect(pair.netFixedApr).toBeCloseTo(0.0899 - 0.0451 - total / (N * T), 10);
  });
});

describe('buildOpportunities — exit mode', () => {
  it('roll zeroes both exit components; the net APR gains exactly the exit drag', () => {
    const close = buildOpportunities(input(), opts()).groups[0].bestPair!;
    const roll = buildOpportunities(input(), opts({ exitMode: 'roll' })).groups[0].bestPair!;
    expect(roll.costs.perpExitFeesUsd).toBe(0);
    expect(roll.costs.perpExitSlippageUsd).toBe(0);
    // Exit cost was $1000 of fees + $200 of slippage on $1M over 30/365y.
    expect(roll.netFixedApr! - close.netFixedApr!).toBeCloseTo(1_200 / (N * T), 10);
    expect(roll.costs.totalUsd).toBeCloseTo(close.costs.totalUsd! - 1_200, 8);
  });
});

describe('buildOpportunities — maker + hedge', () => {
  /** HL crosses cheaply ($100), Binance expensively ($800). */
  const skewed = () =>
    input({
      venueBooks: new Map([
        [HL_SYMBOL, perpBook(0.1)],
        [BN_SYMBOL, perpBook(0.8)],
      ]),
      feeRows: [
        { exchangeType: 'HYPERLIQUID', futureMakerFee: '0', futureTakerFee: '0.0004' },
        { exchangeType: 'BINANCE', futureMakerFee: '0.0002', futureTakerFee: '0.0003' },
      ],
    });

  it('minimises fees AND slippage jointly, not fees alone', () => {
    const pair = buildOpportunities(skewed(), opts({ entryMode: 'maker-hedge' })).groups[0]
      .bestPair!;
    // Fees alone would rest on HL (short): $0 + $300 vs $200 + $400.
    // Jointly: HL maker 300 + BN taker slip 800 = 1100, vs
    //          BN maker 600 + HL taker slip 100 = 700 → rest on Binance.
    expect(pair.makerLeg).toBe('long');
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(N * (0.0002 + 0.0004), 8);
    expect(pair.costs.perpEntrySlippageUsd).toBeCloseTo(100, 8);
    expect(pair.reasons.join(' ')).toMatch(/rests as a maker order — its fill is not guaranteed/);
  });

  it('both-market on the same fixture crosses both books at taker rates', () => {
    const pair = buildOpportunities(skewed(), opts()).groups[0].bestPair!;
    expect(pair.makerLeg).toBeNull();
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(N * (0.0004 + 0.0003), 8);
    expect(pair.costs.perpEntrySlippageUsd).toBeCloseTo(900, 8);
  });
});

describe('buildOpportunities — borosEntry: mark', () => {
  it('uses each market mark APR and never touches the Boros books', () => {
    const out = buildOpportunities(
      input({ borosBooks: new Map() }),
      opts({ borosEntry: 'mark' }),
    );
    const group = out.groups[0];
    expect(group.markets.map((m) => m.bookStatus)).toEqual(['not-fetched', 'not-fetched']);
    const pair = group.bestPair!;
    expect(pair.shortLeg.execApr).toBeCloseTo(0.089, 10);
    expect(pair.longLeg.execApr).toBeCloseTo(0.046, 10);
    expect(pair.execSpreadApr).toBeCloseTo(0.089 - 0.046, 10);
    expect(pair.borosImpactApr).toBeCloseTo(0.045 - (0.089 - 0.046), 10);
    expect(pair.netFixedApr).not.toBeNull();
    expect(pair.reasons).toEqual([]);
    expect(out.meta.borosEntry).toBe('mark');
  });

  it('takes the pair direction from markApr when it inverts the mid ordering', () => {
    // HL mid 0.0453 > BN mid 0.0450, but the marks invert: 0.0461 < 0.0470, so
    // only short-Binance / long-Hyperliquid locks anything (+9 bps).
    const markets: BorosMarket[] = [
      { ...hlMarket, midApr: 0.0453, markApr: 0.0461 },
      { ...bnMarket, midApr: 0.045, markApr: 0.047 },
    ];
    const group = buildOpportunities(
      input({ markets, borosBooks: new Map() }),
      opts({ borosEntry: 'mark' }),
    ).groups[0];

    expect(group.pairs).toHaveLength(1);
    const pair = group.pairs[0];
    expect(pair.shortLeg.marketId).toBe(101);
    expect(pair.longLeg.marketId).toBe(155);
    expect(pair.execSpreadApr).toBeCloseTo(0.0009, 10);
    expect(pair.grossSpreadApr).toBeCloseTo(0.045 - 0.0453, 10);
  });
});

describe('buildOpportunities — degraded modes', () => {
  it('unknown fee schedule: fee + total + net go null with a global warning', () => {
    const out = buildOpportunities(input({ feeRows: null }), opts());
    const pair = out.groups[0].pairs[0];
    expect(pair.costs.perpEntryFeesUsd).toBeNull();
    expect(pair.costs.perpExitFeesUsd).toBeNull();
    expect(pair.costs.totalUsd).toBeNull();
    expect(pair.costs.annualizedApr).toBeNull();
    expect(pair.netFixedApr).toBeNull();
    expect(pair.estProfitUsd).toBeNull();
    // Slippage doesn't need the schedule — it stays known.
    expect(pair.costs.perpEntrySlippageUsd).toBeCloseTo(200, 8);
    expect(pair.reasons.join(' ')).toMatch(
      /fee schedule is unavailable — perp trading fees for HYPERLIQUID HYPERLIQUID_FUTURE_ETH_USDC/,
    );
    expect(out.warnings.join(' ')).toMatch(/fee schedule is unavailable/);
    expect(out.groups[0].bestPair).toBeNull();
  });

  it('a venue row missing from the schedule names that venue and symbol', () => {
    const out = buildOpportunities(
      input({ feeRows: [{ exchangeType: 'HYPERLIQUID', futureMakerFee: '0.0002', futureTakerFee: '0.0005' }] }),
      opts(),
    );
    expect(out.groups[0].pairs[0].reasons.join(' ')).toMatch(
      /No CrossEx fee row for BINANCE \(BINANCE_FUTURE_ETH_USDT\)/,
    );
  });

  it('a missing perp book nulls the slippage and says so, keeping the exec spread', () => {
    const out = buildOpportunities(
      input({ venueBooks: new Map([[HL_SYMBOL, perpBook(0.1)]]) }),
      opts(),
    );
    const pair = out.groups[0].pairs[0];
    expect(pair.execSpreadApr).toBeCloseTo(0.0899 - 0.0451, 10);
    expect(pair.costs.perpEntrySlippageUsd).toBeNull();
    expect(pair.costs.perpExitSlippageUsd).toBeNull();
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(1_000, 8);
    expect(pair.netFixedApr).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /No usable BINANCE order book for BINANCE_FUTURE_ETH_USDT — the perp slippage at \$1,000,000/,
    );
  });

  it('a thin perp book still prices, flagged as extrapolated depth', () => {
    const out = buildOpportunities(
      input({
        venueBooks: new Map([
          [HL_SYMBOL, perpBook(0.1)],
          [BN_SYMBOL, perpBook(0.1, 400)], // only 400 of the 1000 qty needed
        ]),
      }),
      opts(),
    );
    const pair = out.groups[0].pairs[0];
    expect(pair.netFixedApr).not.toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /BINANCE_FUTURE_ETH_USDT book runs out of depth before \$1,000,000/,
    );
  });

  it('a thin Boros book reports execApr for transparency but refuses a net APR', () => {
    const out = buildOpportunities(
      input({
        borosBooks: new Map([
          [155, borosBook(155, 0.0899, 0.0901)],
          // Only $250k of asks — a $1M pay-fixed leg can't be filled.
          [101, { marketId: 101, bids: [[0.0449, 20_000_000]], asks: [[0.0451, 250_000]] }],
        ]),
      }),
      opts(),
    );
    const group = out.groups[0];
    expect(group.markets.find((m) => m.marketId === 101)!.bookStatus).toBe('insufficient-depth');
    expect(group.markets.find((m) => m.marketId === 101)!.execLongApr).toBeCloseTo(0.0451, 10);
    const pair = group.pairs[0];
    expect(pair.longLeg.execApr).toBeCloseTo(0.0451, 10);
    expect(pair.execSpreadApr).toBeNull();
    expect(pair.borosImpactApr).toBeNull();
    expect(pair.netFixedApr).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /only has \$250,000 of pay-fixed depth — \$1,000,000 is needed/,
    );
    expect(group.bestPair).toBeNull();
  });

  it('a missing Boros book marks the row unavailable and names the market', () => {
    const out = buildOpportunities(
      input({ borosBooks: new Map([[155, borosBook(155, 0.0899, 0.0901)]]) }),
      opts(),
    );
    const group = out.groups[0];
    expect(group.markets.find((m) => m.marketId === 101)!.bookStatus).toBe('unavailable');
    expect(group.pairs[0].reasons.join(' ')).toMatch(
      /No Boros order book for Binance ETHUSDT 31 Aug 2026 \(market #101\)/,
    );
    expect(group.pairs[0].netFixedApr).toBeNull();
  });

  it('a one-sided Boros book is unavailable, not thin, and keeps the side it does have', () => {
    const out = buildOpportunities(
      input({
        borosBooks: new Map([
          [155, borosBook(155, 0.0899, 0.0901)],
          [101, { marketId: 101, bids: [[0.0449, 20_000_000]], asks: [] }],
        ]),
      }),
      opts(),
    );
    const row = out.groups[0].markets.find((m) => m.marketId === 101)!;
    expect(row.bookStatus).toBe('unavailable');
    expect(row.execShortApr).toBeCloseTo(0.0449, 10);
    expect(row.execLongApr).toBeNull();
    expect(out.groups[0].pairs[0].netFixedApr).toBeNull();
  });

  it('an unpriceable collateral zone warns and blocks the depth walk', () => {
    const ethMargined = [
      { ...hlMarket, tokenId: 4 },
      { ...bnMarket, tokenId: 4 },
    ];
    const out = buildOpportunities(
      input({ markets: ethMargined, collateralPricesUsd: new Map([[4, null]]) }),
      opts(),
    );
    const group = out.groups[0];
    expect(group.collateral).toBe('BNB');
    expect(group.collateralPriceUsd).toBeNull();
    expect(group.markets.every((m) => m.oiUsd === null)).toBe(true);
    expect(group.warnings.join(' ')).toMatch(/Can't price BNB collateral in USD/);
    expect(group.pairs[0].execSpreadApr).toBeNull();
    expect(group.pairs[0].reasons.join(' ')).toMatch(/Can't price BNB collateral in USD/);
  });

  it('a venue with no CrossEx perp is listed but never paired', () => {
    const out = buildOpportunities(
      input({
        markets: [hlMarket, bnMarket, { ...bnMarket, marketId: 190, name: 'Lighter ETH', venue: 'Lighter', midApr: 0.07 }],
      }),
      opts(),
    );
    const group = out.groups[0];
    expect(group.markets).toHaveLength(3);
    expect(group.markets.find((m) => m.marketId === 190)!.crossexVenue).toBeNull();
    expect(group.pairs).toHaveLength(1);
    expect(group.warnings.join(' ')).toMatch(
      /Lighter ETH trades against Lighter, which has no CrossEx perp venue/,
    );
  });

  it('a mapped venue with no live CrossEx symbol still pairs — venue fees resolve, missing book nulls the net', () => {
    const out = buildOpportunities(
      input({ symbolsByVenueBase: new Map([['HYPERLIQUID:ETH', HL_SYMBOL]]) }),
      opts(),
    );
    const group = out.groups[0];
    expect(group.pairs).toHaveLength(1);
    const pair = group.pairs[0];
    expect(pair.longLeg.crossexSymbol).toBeNull();
    expect(pair.grossSpreadApr).toBeCloseTo(0.09 - 0.045, 10);
    expect(pair.execSpreadApr).toBeCloseTo(0.0899 - 0.0451, 10);
    // The BINANCE venue fee row applies even without a symbol, so fees price;
    // the slippage has no fallback book here, which nulls the net.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(2 * N * 0.0005, 8);
    expect(pair.costs.perpEntrySlippageUsd).toBeNull();
    expect(pair.netFixedApr).toBeNull();
    expect(pair.capitalUsd).toBeNull();
    expect(pair.estProfitUsd).toBeNull();
    expect(group.bestPair).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /No usable BINANCE order book for ETH — the perp slippage at \$1,000,000 can't be estimated/,
    );
    expect(pair.reasons.join(' ')).toMatch(
      /No confirmed CrossEx listing for BINANCE ETH — its leverage cap is auth-gated/,
    );
    expect(group.warnings.join(' ')).toMatch(
      /No live CrossEx BINANCE symbol for ETH — Binance ETHUSDT 31 Aug 2026/,
    );
  });

  it('symbol-less legs price fully from venue fee rows + VENUE:BASE fallback books (capital stays unknown)', () => {
    // The unconfigured shape: NO symbol universe at all, but the route fetched
    // the public books under their fallback keys and synthesized a fee tier.
    const out = buildOpportunities(
      input({
        symbolsByVenueBase: new Map(),
        leverageMaxBySymbol: new Map(),
        venueBooks: new Map([
          ['HYPERLIQUID:ETH', perpBook(0.1)],
          ['BINANCE:ETH', perpBook(0.1)],
        ]),
      }),
      opts(),
    );
    const group = out.groups[0];
    expect(group.pairs).toHaveLength(1);
    const pair = group.pairs[0];
    expect(pair.shortLeg.crossexSymbol).toBeNull();
    expect(pair.longLeg.crossexSymbol).toBeNull();
    // Identical rates and books to the canonical case ⇒ identical net numbers.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(2 * N * 0.0005, 8);
    expect(pair.costs.perpEntrySlippageUsd).toBeCloseTo(2 * 0.1 * 1000, 8);
    const total = 0.001 * N * T + 0.002 * N * T + 1_000 + 200 + 1_000 + 200;
    expect(pair.netFixedApr).toBeCloseTo(0.0899 - 0.0451 - total / (N * T), 10);
    expect(pair.estProfitUsd).toBeCloseTo((0.0899 - 0.0451 - total / (N * T)) * N * T, 6);
    // Leverage caps stay auth-gated — capital and its APR remain unknown.
    expect(pair.capitalUsd).toBeNull();
    expect(pair.netFixedAprOnCapital).toBeNull();
    expect(group.bestPair).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(/leverage cap is auth-gated/);
  });
});

describe('buildOpportunities — ranking', () => {
  it('orders pairs by net fixed APR desc with nulls last, and groups by their best pair', () => {
    // A second, WIDER cohort on a later maturity, plus a third whose only
    // Binance leg has no CrossEx symbol (so it can produce no priceable pair).
    const later = MATURITY + 60 * DAY;
    const wideHl: BorosMarket = { ...hlMarket, marketId: 255, maturity: later, midApr: 0.14 };
    const wideBn: BorosMarket = { ...bnMarket, marketId: 201, maturity: later, midApr: 0.04 };
    const deadHl: BorosMarket = {
      ...hlMarket,
      marketId: 355,
      base: 'SOL',
      name: 'Hyperliquid SOL',
      maturity: later,
    };
    const deadBn: BorosMarket = {
      ...bnMarket,
      marketId: 301,
      base: 'SOL',
      name: 'Binance SOL',
      maturity: later,
    };
    const out = buildOpportunities(
      input({
        markets: [hlMarket, bnMarket, wideHl, wideBn, deadHl, deadBn],
        borosBooks: new Map([
          [155, borosBook(155, 0.0899, 0.0901)],
          [101, borosBook(101, 0.0449, 0.0451)],
          [255, borosBook(255, 0.1399, 0.1401)],
          [201, borosBook(201, 0.0399, 0.0401)],
        ]),
      }),
      opts(),
    );
    expect(out.groups.map((g) => g.maturity)).toEqual([later, MATURITY, later]);
    expect(out.groups[0].underlying).toBe('ETH');
    expect(out.groups[0].bestPair!.grossSpreadApr).toBeCloseTo(0.1, 10);
    expect(out.groups[1].bestPair!.grossSpreadApr).toBeCloseTo(0.045, 10);
    // The SOL cohort has no priceable pair (no CrossEx symbols) → last.
    expect(out.groups[2].underlying).toBe('SOL');
    expect(out.groups[2].bestPair).toBeNull();
  });

  it('sinks a null-net pair below a priceable one inside the same group', () => {
    // A third HL-venue market can't pair with HL, but pairs with Binance; give
    // it a mid between the two so both orderings exist.
    const okxMarket: BorosMarket = {
      ...bnMarket,
      marketId: 158,
      name: 'OKX ETHUSDT 31 Aug 2026',
      venue: 'OKX',
      midApr: 0.07,
    };
    const out = buildOpportunities(
      input({
        markets: [hlMarket, bnMarket, okxMarket],
        // OKX's book is missing → every pair touching it is unpriceable.
        symbolsByVenueBase: new Map([
          ['HYPERLIQUID:ETH', HL_SYMBOL],
          ['BINANCE:ETH', BN_SYMBOL],
          ['OKX:ETH', 'OKX_FUTURE_ETH_USDT'],
        ]),
        feeRows: [...feeRows, { exchangeType: 'OKX', futureMakerFee: '0.0002', futureTakerFee: '0.0005' }],
      }),
      opts(),
    );
    const pairs = out.groups[0].pairs;
    expect(pairs[0].netFixedApr).not.toBeNull();
    expect(pairs[0].shortLeg.marketId).toBe(155);
    expect(pairs[0].longLeg.marketId).toBe(101);
    expect(pairs.slice(1).every((p) => p.netFixedApr === null)).toBe(true);
    // Nulls are ordered among themselves by exec spread, then gross spread.
    expect(pairs[1].grossSpreadApr).toBeGreaterThanOrEqual(pairs[2].grossSpreadApr);
  });
});

describe('buildOpportunities — ranking keys on the capital basis', () => {
  /** OKX below both others, so the WIDEST notional spread is HL → OKX. */
  const okxMarket: BorosMarket = {
    ...bnMarket,
    marketId: 158,
    name: 'OKX ETHUSDT 31 Aug 2026',
    venue: 'OKX',
    midApr: 0.02,
    markApr: 0.02,
  };
  const withOkx = () =>
    input({
      markets: [hlMarket, bnMarket, okxMarket],
      borosBooks: new Map([
        [155, borosBook(155, 0.0899, 0.0901)],
        [101, borosBook(101, 0.0449, 0.0451)],
        [158, borosBook(158, 0.0199, 0.0201)],
      ]),
      venueBooks: new Map([
        [HL_SYMBOL, perpBook(0.1)],
        [BN_SYMBOL, perpBook(0.1)],
        ['OKX_FUTURE_ETH_USDT', perpBook(0.1)],
      ]),
      symbolsByVenueBase: new Map([
        ['HYPERLIQUID:ETH', HL_SYMBOL],
        ['BINANCE:ETH', BN_SYMBOL],
        ['OKX:ETH', 'OKX_FUTURE_ETH_USDT'],
      ]),
      // OKX has no risk-limit row → every pair touching it prices on notional
      // only, even though its notional spread is the widest in the group.
      leverageMaxBySymbol: new Map([
        [HL_SYMBOL, HL_LEVERAGE],
        [BN_SYMBOL, BN_LEVERAGE],
      ]),
      feeRows: [...feeRows, { exchangeType: 'OKX', futureMakerFee: '0.0002', futureTakerFee: '0.0005' }],
    });

  it('sinks an unpriceable-capital pair below a priced one that earns less on notional', () => {
    const pairs = buildOpportunities(withOkx(), opts()).groups[0].pairs;
    expect(pairs[0].shortLeg.marketId).toBe(155);
    expect(pairs[0].longLeg.marketId).toBe(101);
    expect(pairs[0].netFixedAprOnCapital).not.toBeNull();
    // The pair it beat locks 8.99% − 2.01% on notional versus 8.99% − 4.51%.
    expect(pairs[1].longLeg.marketId).toBe(158);
    expect(pairs[1].netFixedAprOnCapital).toBeNull();
    expect(pairs[1].netFixedApr).toBeGreaterThan(pairs[0].netFixedApr!);
    expect(pairs.slice(1).every((p) => p.capitalUsd === null)).toBe(true);
    // Nulls stay ordered among themselves by the notional basis.
    expect(pairs[1].netFixedApr!).toBeGreaterThan(pairs[2].netFixedApr!);
  });

  it('ranks groups by their top pair capital APR, reordering them against the notional basis', () => {
    // A SOL cohort locking a NARROWER spread (2.98% vs 4.48%) but on 100x perps
    // instead of 10x/20x: ~$26k of capital against ~$207k, so it wins on capital
    // and loses on notional.
    const HL_SOL = 'HYPERLIQUID_FUTURE_SOL_USDC';
    const BN_SOL = 'BINANCE_FUTURE_SOL_USDT';
    const solHl: BorosMarket = { ...hlMarket, marketId: 255, base: 'SOL', name: 'Hyperliquid SOL', midApr: 0.075 };
    const solBn: BorosMarket = { ...bnMarket, marketId: 201, base: 'SOL', name: 'Binance SOL', midApr: 0.045 };
    const out = buildOpportunities(
      input({
        markets: [hlMarket, bnMarket, solHl, solBn],
        borosBooks: new Map([
          [155, borosBook(155, 0.0899, 0.0901)],
          [101, borosBook(101, 0.0449, 0.0451)],
          [255, borosBook(255, 0.0749, 0.0751)],
          [201, borosBook(201, 0.0449, 0.0451)],
        ]),
        venueBooks: new Map([
          [HL_SYMBOL, perpBook(0.1)],
          [BN_SYMBOL, perpBook(0.1)],
          [HL_SOL, perpBook(0.1)],
          [BN_SOL, perpBook(0.1)],
        ]),
        symbolsByVenueBase: new Map([
          ['HYPERLIQUID:ETH', HL_SYMBOL],
          ['BINANCE:ETH', BN_SYMBOL],
          ['HYPERLIQUID:SOL', HL_SOL],
          ['BINANCE:SOL', BN_SOL],
        ]),
        leverageMaxBySymbol: new Map([
          [HL_SYMBOL, HL_LEVERAGE],
          [BN_SYMBOL, BN_LEVERAGE],
          [HL_SOL, 100],
          [BN_SOL, 100],
        ]),
      }),
      opts({ exitMode: 'roll' }),
    );
    expect(out.groups.map((g) => g.underlying)).toEqual(['SOL', 'ETH']);
    const [sol, eth] = out.groups.map((g) => g.bestPair!);
    expect(sol.execSpreadApr).toBeCloseTo(0.0749 - 0.0451, 10);
    expect(eth.execSpreadApr).toBeCloseTo(0.0899 - 0.0451, 10);
    expect(sol.netFixedAprOnCapital!).toBeGreaterThan(eth.netFixedAprOnCapital!);
    expect(sol.netFixedApr!).toBeLessThan(eth.netFixedApr!);
  });
});

describe('buildOpportunities — meta', () => {
  it('echoes the clock and the chosen assumptions', () => {
    const out = buildOpportunities(input(), opts({ entryMode: 'maker-hedge', exitMode: 'roll' }));
    expect(out.meta).toEqual({
      asOfSec: NOW,
      notionalUsd: N,
      borosEntry: 'market',
      entryMode: 'maker-hedge',
      exitMode: 'roll',
    });
  });
});
