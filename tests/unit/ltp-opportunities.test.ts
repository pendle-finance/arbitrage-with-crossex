/**
 * LTP opportunity math (src/core/ltp/opportunities.ts): the MarginX capital
 * model (L, M, loan interest), maker rebates, RapidX/DMA tagging, universe
 * degradation, and the assumption warnings. Boros-side mechanics are pinned in
 * boros-opportunities.test.ts — these tests only assert what the LTP engine
 * changes. Every expectation is hand-derived, never computed by the code under
 * test.
 */
import { describe, expect, it } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import {
  BOROS_VENUE_TO_LTP,
  buildLtpOpportunities,
  ltpPerpSym,
  type BuildLtpOpportunitiesInput,
  type BuildLtpOpportunitiesOptions,
  type LtpPerpFeeRates,
} from '../../src/core/ltp/opportunities';
import { SECONDS_IN_YEAR } from '../../src/core/boros/venue';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { imInputs } from '../helpers/boros-fixtures';

const NOW = 1_752_000_000;
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;
const N = 10_000;
const T = (30 * DAY) / SECONDS_IN_YEAR;

/** The fixture's Boros margin floor: 1.00005 ^ (770 × 2) − 1 ≈ 0.08004. */
const FLOOR = 1.00005 ** (770 * 2) - 1;

const bnMarket: BorosMarket = {
  marketId: 155,
  tokenId: 3,
  name: 'Binance ETHUSDT 30d',
  venue: 'Binance',
  base: 'ETH',
  maturity: MATURITY,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: 0.089,
  floatingApr: 0.088,
  midApr: 0.09,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  maxRateDeviationApr: 0.016,
  state: 'Normal',
  assetMarkPriceUsd: 1_880,
  ...imInputs,
};
const okxMarket: BorosMarket = {
  ...bnMarket,
  marketId: 101,
  name: 'OKX ETHUSDT 30d',
  venue: 'OKX',
  markApr: 0.046,
  floatingApr: 0.044,
  midApr: 0.045,
};

/** Deep one-level books: BN 0.0899/0.0901, OKX 0.0449/0.0451 → exec spread
 * 0.0899 − 0.0451 = 0.0448 shorting BN / longing OKX. */
const borosBooks = new Map<number, BorosOrderBook | null>([
  [155, { marketId: 155, bids: [[0.0899, 20_000_000]], asks: [[0.0901, 20_000_000]] }],
  [101, { marketId: 101, bids: [[0.0449, 20_000_000]], asks: [[0.0451, 20_000_000]] }],
]);

/** Perp books with mid exactly 10 000 and a $1 half-spread: at $10k (qty 1)
 * each crossing leg slips exactly $1 — tight enough that the fixture trade
 * stays PROFITABLE, which the M-comparison test depends on (leverage amplifies
 * a loss the other way). */
const perpBook = (): NormalizedBook => ({
  bids: [[9_999, 5_000]],
  asks: [[10_001, 5_000]],
  ts: NOW * 1000,
});
const venueBooks = new Map<string, NormalizedBook | null>([
  ['BINANCE:ETH', perpBook()],
  ['OKX:ETH', perpBook()],
]);

const vip1: LtpPerpFeeRates = { makerRate: 0.0001, takerRate: 0.00035, source: 'tier' };
const perpFees = new Map<string, LtpPerpFeeRates>([
  ['BINANCE', vip1],
  ['OKX', vip1],
]);
const ltpSyms = new Set([ltpPerpSym('BINANCE', 'ETH'), ltpPerpSym('OKX', 'ETH')]);

function makeInput(over: Partial<BuildLtpOpportunitiesInput> = {}): BuildLtpOpportunitiesInput {
  return {
    markets: [bnMarket, okxMarket],
    collateralPricesUsd: new Map([[3, 1]]),
    borosBooks,
    venueBooks,
    ltpSyms,
    perpFees,
    nowSec: NOW,
    ...over,
  };
}

function makeOptions(over: Partial<BuildLtpOpportunitiesOptions> = {}): BuildLtpOpportunitiesOptions {
  return {
    notionalUsd: N,
    borosEntry: 'market',
    entryMode: 'both-market',
    exitMode: 'close',
    perpLeverage: 10,
    borrowLeverage: 2,
    loanRateApr: 0.095,
    ...over,
  };
}

function bestPair(
  inputOver: Partial<BuildLtpOpportunitiesInput> = {},
  optionsOver: Partial<BuildLtpOpportunitiesOptions> = {},
) {
  const result = buildLtpOpportunities(makeInput(inputOver), makeOptions(optionsOver));
  expect(result.groups).toHaveLength(1);
  return { result, pair: result.groups[0].pairs[0] };
}

describe('capital & loan model', () => {
  it('pins the L/M/loan formulas: N=10k, L=10, M=2, 9.5% over 30d', () => {
    const { result, pair } = bestPair();

    // Legs: short the rich BN market, long the cheap OKX one; both RapidX.
    expect(pair.shortLeg.ltpVenue).toBe('BINANCE');
    expect(pair.shortLeg.ltpSym).toBe('BINANCE_PERP_ETH_USDT');
    expect(pair.shortLeg.venueAccess).toBe('rapidx');
    expect(pair.longLeg.ltpVenue).toBe('OKX');
    expect(pair.longLeg.venueAccess).toBe('rapidx');
    expect(pair.execSpreadApr).toBeCloseTo(0.0448, 10);

    // Collateral: C = 2·10 000/10 = 2 000; posted 1 000; borrowed 1 000.
    expect(pair.capital.perpCollateralRequiredUsd).toBeCloseTo(2_000, 10);
    expect(pair.capital.postedPerpCollateralUsd).toBeCloseTo(1_000, 10);
    expect(pair.capital.borrowedUsd).toBeCloseTo(1_000, 10);
    expect(pair.capital.perpLeverage).toBe(10);
    expect(pair.capital.borrowLeverage).toBe(2);
    // Interest: 1 000 × 0.095 × 30/365 ≈ 7.8082.
    expect(pair.costs.loanInterestUsd).toBeCloseTo(1_000 * 0.095 * T, 10);

    // Boros IM at the locked rates (0.0899 received; 0.0451 sits under the
    // ~8.004% floor, so the floor charges the long leg).
    const kIM = imInputs.kIM;
    const imShort = N * 0.0899 * (30 / 365) * kIM;
    const imLong = N * FLOOR * (30 / 365) * kIM;
    expect(pair.capital.borosShortImUsd).toBeCloseTo(imShort, 6);
    expect(pair.capital.borosLongImUsd).toBeCloseTo(imLong, 6);

    // Capital = Boros IMs + POSTED collateral only — borrowed money is not
    // the user's capital.
    const capital = imShort + imLong + 1_000;
    expect(pair.capitalUsd).toBeCloseTo(capital, 6);
    expect(pair.effectiveLeverage).toBeCloseTo(N / capital, 8);

    // Full ledger: Boros 5+5 bp taker and 10+10 bp settle on N×T, VIP1 taker
    // ×2 legs entry AND exit, $1+$1 slip each way, plus the loan interest.
    const nt = N * T;
    const expectedTotal =
      0.001 * nt + 0.002 * nt + N * 0.0007 + 2 + N * 0.0007 + 2 + 1_000 * 0.095 * T;
    expect(pair.costs.totalUsd).toBeCloseTo(expectedTotal, 8);
    expect(pair.netFixedApr).toBeCloseTo(0.0448 - expectedTotal / nt, 8);
    expect(pair.estProfitUsd).toBeCloseTo((0.0448 - expectedTotal / nt) * nt, 6);
    expect(pair.netFixedAprOnCapital).toBeCloseTo(pair.estProfitUsd! / (capital * T), 6);
    expect(result.meta).toMatchObject({ perpLeverage: 10, borrowLeverage: 2, loanRateApr: 0.095 });
  });

  it('M=1 is the no-borrow identity: zero borrowed, zero interest', () => {
    const { pair: m1 } = bestPair({}, { borrowLeverage: 1, exitMode: 'roll' });
    expect(m1.capital.borrowedUsd).toBe(0);
    expect(m1.costs.loanInterestUsd).toBe(0);
    expect(m1.capital.postedPerpCollateralUsd).toBeCloseTo(2_000, 10);
    expect(m1.reasons.join(' ')).not.toMatch(/MarginX borrow/);

    // Against M=2 on the same PROFITABLE trade: profit drops by exactly the
    // interest, while the APR on capital RISES because the posted denominator
    // halves — the point of M. (On a loss-making trade the amplification cuts
    // the other way, which is why this fixture must stay profitable.)
    const { pair: m2 } = bestPair({}, { exitMode: 'roll' });
    expect(m1.netFixedAprOnCapital!).toBeGreaterThan(0);
    expect(m1.estProfitUsd! - m2.estProfitUsd!).toBeCloseTo(m2.costs.loanInterestUsd, 8);
    expect(m2.netFixedAprOnCapital!).toBeGreaterThan(m1.netFixedAprOnCapital!);
    expect(m2.capitalUsd!).toBeLessThan(m1.capitalUsd!);
  });

  it('a VIP4 maker rebate reduces the ledger through maker-hedge', () => {
    const vip4 = { makerRate: -0.00001, takerRate: 0.0002, source: 'tier' as const };
    const fees4 = new Map([
      ['BINANCE', vip4],
      ['OKX', vip4],
    ]);
    const { pair } = bestPair({ perpFees: fees4 }, { entryMode: 'maker-hedge' });
    // One resting maker leg REBATES 0.1bp while the hedge pays 2bp taker; the
    // resting leg also contributes no slippage.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(N * (-0.00001 + 0.0002), 10);
    expect(pair.costs.perpEntrySlippageUsd).toBeCloseTo(1, 10);
    expect(pair.makerLeg).not.toBeNull();

    // Same books at VIP3 (maker exactly 0): the rebate strictly beats it.
    const vip3 = { makerRate: 0, takerRate: 0.0002, source: 'tier' as const };
    const { pair: p3 } = bestPair(
      { perpFees: new Map([['BINANCE', vip3], ['OKX', vip3]]) },
      { entryMode: 'maker-hedge' },
    );
    expect(pair.costs.totalUsd!).toBeLessThan(p3.costs.totalUsd!);
  });
});

describe('venue access & universe', () => {
  it('tags DMA legs and carries the caveat; RapidX legs carry none', () => {
    const bybit: BorosMarket = { ...okxMarket, marketId: 202, name: 'Bybit ETHUSDT 30d', venue: 'Bybit' };
    const input = makeInput({
      markets: [bnMarket, bybit],
      borosBooks: new Map([
        [155, borosBooks.get(155)!],
        [202, { marketId: 202, bids: [[0.0449, 20_000_000]], asks: [[0.0451, 20_000_000]] }],
      ]),
      venueBooks: new Map([
        ['BINANCE:ETH', perpBook()],
        ['BYBIT:ETH', perpBook()],
      ]),
      perpFees: new Map([
        ['BINANCE', vip1],
        ['BYBIT', vip1],
      ]),
      ltpSyms: null,
    });
    const { groups } = buildLtpOpportunities(input, makeOptions());
    const pair = groups[0].pairs[0];
    expect(pair.longLeg.venueAccess).toBe('dma');
    expect(pair.shortLeg.venueAccess).toBe('rapidx');
    expect(pair.reasons.join(' ')).toMatch(/BYBIT leg executes via an LTP DMA sub-account/);
    expect(pair.reasons.join(' ')).not.toMatch(/BINANCE leg executes via/);
    // The pair still prices in full — DMA is a caveat, not a hole.
    expect(typeof pair.netFixedApr).toBe('number');
  });

  it('maps unknown Boros venues to DMA instead of dropping them', () => {
    expect(BOROS_VENUE_TO_LTP.PARADEX).toBeUndefined();
    const paradex: BorosMarket = { ...okxMarket, marketId: 303, venue: 'Paradex', name: 'Paradex ETH 30d' };
    const { groups } = buildLtpOpportunities(
      makeInput({ markets: [bnMarket, paradex], ltpSyms: null, borosBooks, venueBooks }),
      makeOptions({ borosEntry: 'mark' }),
    );
    const row = groups[0].markets.find((m) => m.marketId === 303)!;
    expect(row.venueAccess).toBe('dma');
    expect(row.ltpVenue).toBe('PARADEX');
    expect(groups[0].pairs.length).toBeGreaterThan(0);
  });

  it('a null universe warns once and still prices; a missing sym gets a reason', () => {
    const { result: nullUniverse, pair: p1 } = bestPair({ ltpSyms: null });
    expect(nullUniverse.warnings.join(' ')).toMatch(/LTP is not configured/);
    expect(p1.shortLeg.venueAccess).toBe('rapidx');
    expect(typeof p1.netFixedApr).toBe('number');
    expect(p1.reasons.join(' ')).not.toMatch(/symbol universe/);

    const { pair: p2 } = bestPair({ ltpSyms: new Set([ltpPerpSym('BINANCE', 'ETH')]) });
    expect(p2.reasons.join(' ')).toMatch(
      /OKX_PERP_ETH_USDT is not in LTP's live symbol universe/,
    );
    expect(typeof p2.netFixedApr).toBe('number'); // priced anyway
  });

  it('null perpFees nulls the perp fee lines with a scan warning', () => {
    const { result, pair } = bestPair({ perpFees: null });
    expect(result.warnings.join(' ')).toMatch(/No LTP fee schedule for this tier/);
    expect(pair.costs.perpEntryFeesUsd).toBeNull();
    expect(pair.costs.totalUsd).toBeNull();
    expect(pair.netFixedApr).toBeNull();
    // Loan interest is knob-derived and never nulls.
    expect(pair.costs.loanInterestUsd).toBeCloseTo(1_000 * 0.095 * T, 10);
  });
});

describe('assumption warnings', () => {
  it('warns above the L and M thresholds, silent at them', () => {
    const quiet = buildLtpOpportunities(makeInput(), makeOptions({ perpLeverage: 20, borrowLeverage: 2 }));
    expect(quiet.warnings.join(' ')).not.toMatch(/leverage/i);

    const loud = buildLtpOpportunities(makeInput(), makeOptions({ perpLeverage: 25, borrowLeverage: 3 }));
    expect(loud.warnings.join(' ')).toMatch(/Perp leverage 25× exceeds 20×/);
    expect(loud.warnings.join(' ')).toMatch(/Borrow leverage 3× exceeds MarginX's configured 2×/);
  });

  it('a borrow flags its own liquidation dynamics on the pair', () => {
    const { pair } = bestPair();
    expect(pair.reasons.join(' ')).toMatch(/MarginX borrow finances \$1,000/);
  });
});

describe('Hyperliquid leverage caps', () => {
  const hlMarket: BorosMarket = { ...okxMarket, venue: 'Hyperliquid' };
  const hlInput = () => ({
    markets: [bnMarket, hlMarket],
    venueBooks: new Map([...venueBooks, ['HYPERLIQUID:ETH', perpBook()] as const]),
    perpFees: new Map([...perpFees, ['HYPERLIQUID', vip1] as const]),
    ltpSyms: null,
  });

  it("clamps an HL leg to HL's published cap; the other leg keeps the knob", () => {
    const { pair } = bestPair(
      { ...hlInput(), hlMaxLeverage: new Map([['ETH', 4]]) },
      { perpLeverage: 10 },
    );
    expect(pair.longLeg.ltpVenue).toBe('HYPERLIQUID');
    expect(pair.capital.shortLegLeverage).toBe(10);
    expect(pair.capital.longLegLeverage).toBe(4);
    expect(pair.capital.perpCollateralRequiredUsd).toBeCloseTo(N / 10 + N / 4, 6);
    expect(pair.reasons.join(' ')).toMatch(/Hyperliquid caps ETH at 4×/);
  });

  it('a cap at or above the knob, or absent caps, changes nothing', () => {
    const roomy = bestPair(
      { ...hlInput(), hlMaxLeverage: new Map([['ETH', 25]]) },
      { perpLeverage: 10 },
    ).pair;
    expect(roomy.capital.longLegLeverage).toBe(10);
    const unknown = bestPair({ ...hlInput() }, { perpLeverage: 10 }).pair;
    expect(unknown.capital.longLegLeverage).toBe(10);
    expect(unknown.capital.perpCollateralRequiredUsd).toBeCloseTo((2 * N) / 10, 6);
    expect(unknown.reasons.join(' ')).not.toMatch(/Hyperliquid caps/);
  });
});
