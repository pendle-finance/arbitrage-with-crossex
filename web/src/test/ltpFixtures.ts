import { http, HttpResponse } from 'msw';
import type { LtpOpportunitiesResult, LtpOpportunityGroup, LtpOpportunityLeg, LtpOpportunityMarketRow, LtpOpportunityPair } from '../api/ltpTypes';
import { env } from './server';
import { OPP_NOW, OPP_MATURITY, OPP_SECONDS_TO_MATURITY, OPP_NOTIONAL, OPP_NT } from './fixtures';

// ---------------------------------------------------------------------------
// LTP opportunities fixtures — the same canonical ETH/USDT cohort with the perp
// legs through LTP: short Hyperliquid (via DMA), long Binance (native RapidX),
// L=5 → $4,000 perp collateral required, M=2 → $2,000 posted / $2,000 financed
// at 9.5%. Costs stay identity-exact by construction.
// ---------------------------------------------------------------------------

export const LTP_OPP_PERP_LEVERAGE = 5;
export const LTP_OPP_BORROW_LEVERAGE = 2;
export const LTP_OPP_LOAN_RATE_APR = 0.095;

export function makeLtpOpportunityLeg(
  overrides: Partial<LtpOpportunityLeg> = {},
): LtpOpportunityLeg {
  return {
    marketId: 101,
    venue: 'HYPERLIQUID',
    ltpVenue: 'HYPERLIQUID',
    ltpSym: 'HYPERLIQUID_PERP_ETH_USDT',
    venueAccess: 'dma',
    base: 'ETH',
    midApr: 0.09,
    execApr: 0.0895,
    ...overrides,
  };
}

export function makeLtpOpportunityMarketRow(
  overrides: Partial<LtpOpportunityMarketRow> = {},
): LtpOpportunityMarketRow {
  return {
    marketId: 101,
    name: 'Hyperliquid ETH',
    venue: 'HYPERLIQUID',
    ltpVenue: 'HYPERLIQUID',
    ltpSym: 'HYPERLIQUID_PERP_ETH_USDT',
    venueAccess: 'dma',
    ltpListed: true,
    base: 'ETH',
    midApr: 0.09,
    markApr: 0.0902,
    floatingApr: 0.112,
    oiUsd: 4_200_000,
    execShortApr: 0.0895,
    execLongApr: 0.0905,
    bookStatus: 'ok',
    ...overrides,
  };
}

export function makeLtpOpportunityPair(
  overrides: Partial<LtpOpportunityPair> = {},
): LtpOpportunityPair {
  const borosTakerFeeUsd = 0.001 * OPP_NT;
  const borosSettleFeeUsd = 0.002 * OPP_NT;
  const perpEntryFeesUsd = 7; // VIP1 taker 3.5bp × 2 legs on $10k
  // Tighter slips than the CrossEx fixture: the $15.6 loan interest joins the
  // ledger, and the fixture trade must stay PROFITABLE (hero 1.3% APR) or the
  // viability filter hides the card.
  const perpEntrySlippageUsd = 1;
  const perpExitFeesUsd = 7;
  const perpExitSlippageUsd = 1;
  // The MarginX borrow: required = 2·N/L = $4,000; posted = required/M = $2,000.
  const perpCollateralRequiredUsd = (2 * OPP_NOTIONAL) / LTP_OPP_PERP_LEVERAGE;
  const postedPerpCollateralUsd = perpCollateralRequiredUsd / LTP_OPP_BORROW_LEVERAGE;
  const borrowedUsd = perpCollateralRequiredUsd - postedPerpCollateralUsd;
  const loanInterestUsd = borrowedUsd * LTP_OPP_LOAN_RATE_APR * (OPP_NT / OPP_NOTIONAL);
  const totalUsd =
    borosTakerFeeUsd +
    borosSettleFeeUsd +
    perpEntryFeesUsd +
    perpEntrySlippageUsd +
    perpExitFeesUsd +
    perpExitSlippageUsd +
    loanInterestUsd;
  const grossSpreadApr = 0.09 - 0.045;
  const execSpreadApr = 0.0895 - 0.0455;
  const netFixedApr = execSpreadApr - totalUsd / OPP_NT;
  const estProfitUsd = netFixedApr * OPP_NT;
  const capital = {
    borosShortImUsd: 8,
    borosLongImUsd: 4,
    perpCollateralRequiredUsd,
    postedPerpCollateralUsd,
    borrowedUsd,
    perpLeverage: LTP_OPP_PERP_LEVERAGE,
    shortLegLeverage: LTP_OPP_PERP_LEVERAGE,
    longLegLeverage: LTP_OPP_PERP_LEVERAGE,
    borrowLeverage: LTP_OPP_BORROW_LEVERAGE,
  };
  const capitalUsd = capital.borosShortImUsd + capital.borosLongImUsd + postedPerpCollateralUsd;
  return {
    base: 'ETH',
    shortLeg: makeLtpOpportunityLeg(),
    longLeg: makeLtpOpportunityLeg({
      marketId: 102,
      venue: 'BINANCE',
      ltpVenue: 'BINANCE',
      ltpSym: 'BINANCE_PERP_ETH_USDT',
      venueAccess: 'rapidx',
      midApr: 0.045,
      execApr: 0.0455,
    }),
    grossSpreadApr,
    execSpreadApr,
    borosImpactApr: grossSpreadApr - execSpreadApr,
    makerLeg: null,
    costs: {
      borosTakerFeeUsd,
      borosSettleFeeUsd,
      perpEntryFeesUsd,
      perpEntrySlippageUsd,
      perpExitFeesUsd,
      perpExitSlippageUsd,
      loanInterestUsd,
      totalUsd,
      annualizedApr: totalUsd / OPP_NT,
    },
    capital,
    capitalUsd,
    netFixedApr,
    netFixedAprOnCapital: estProfitUsd / (capitalUsd * (OPP_NT / OPP_NOTIONAL)),
    effectiveLeverage: OPP_NOTIONAL / capitalUsd,
    estProfitUsd,
    secondsToMaturity: OPP_SECONDS_TO_MATURITY,
    reasons: [
      'The HYPERLIQUID leg executes via an LTP DMA sub-account, not RapidX — MarginX cross-venue collateral mobility may not hold there and the VIP fee ladder may not apply.',
    ],
    ...overrides,
  };
}

export function makeLtpOpportunityGroup(
  overrides: Partial<LtpOpportunityGroup> = {},
): LtpOpportunityGroup {
  const pairs = overrides.pairs ?? [makeLtpOpportunityPair()];
  const best = pairs[0];
  return {
    tokenId: 3,
    collateral: 'USDT',
    collateralPriceUsd: 1,
    maturity: OPP_MATURITY,
    secondsToMaturity: OPP_SECONDS_TO_MATURITY,
    underlying: 'ETH',
    markets: [
      makeLtpOpportunityMarketRow(),
      makeLtpOpportunityMarketRow({
        marketId: 102,
        name: 'Binance ETH',
        venue: 'BINANCE',
        ltpVenue: 'BINANCE',
        ltpSym: 'BINANCE_PERP_ETH_USDT',
        venueAccess: 'rapidx',
        midApr: 0.045,
        markApr: 0.0451,
        floatingApr: 0.0518,
        oiUsd: 9_100_000,
        execShortApr: 0.0445,
        execLongApr: 0.0455,
      }),
    ],
    pairs,
    bestPair: best !== undefined && best.netFixedAprOnCapital !== null ? best : null,
    warnings: [],
    ...overrides,
  };
}

export function makeLtpOpportunitiesResult(
  overrides: Partial<LtpOpportunitiesResult> = {},
): LtpOpportunitiesResult {
  return {
    groups: [makeLtpOpportunityGroup()],
    meta: {
      asOfSec: OPP_NOW,
      notionalUsd: OPP_NOTIONAL,
      borosEntry: 'market',
      entryMode: 'both-market',
      exitMode: 'close',
      ltpTier: 'vip1',
      tierSource: 'account',
      perpLeverage: LTP_OPP_PERP_LEVERAGE,
      borrowLeverage: LTP_OPP_BORROW_LEVERAGE,
      loanRateApr: LTP_OPP_LOAN_RATE_APR,
    },
    warnings: [],
    ...overrides,
  };
}

/** GET /api/opportunities-ltp returning `data` (or 502 when data is an Error);
 * `opts.urls` collects request URLs for query-param assertions. */
export function ltpOpportunitiesHandler(
  data: LtpOpportunitiesResult | Error,
  opts: { urls?: string[] } = {},
) {
  return http.get('/api/opportunities-ltp', ({ request }) => {
    opts.urls?.push(request.url);
    return data instanceof Error
      ? HttpResponse.json(
          { ok: false, error: { category: 'network', message: data.message } },
          { status: 502 },
        )
      : HttpResponse.json(env(data));
  });
}
