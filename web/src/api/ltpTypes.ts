/** Read-only LTP scan contract. APRs are fractions; amounts are USD. */
import type {
  OpportunitiesResult, OpportunityLeg, OpportunityCostBreakdown,
  OpportunityCapitalBreakdown, OpportunityPair, OpportunityMarketRow, OpportunityGroup,
} from './types';

/** LTP VIP fee tier (the ladder is account-confidential — the server may only
 * carry VIP1 unless the operator supplied the rest). */
export type LtpTier = 'vip1' | 'vip2' | 'vip3' | 'vip4' | 'vip5';

/** How a leg reaches its venue: native RapidX (BINANCE/OKX) or an LTP DMA
 * sub-account — where MarginX collateral mobility and the VIP ladder are
 * unproven. */
export type LtpVenueAccess = 'rapidx' | 'dma';

/** Where the priced fee schedule came from: the explicit ltpTier param, the
 * account's own userFeeRate, or the VIP1 default. */
export type LtpTierSource = 'param' | 'account' | 'default';

export interface LtpOpportunityLeg extends Omit<OpportunityLeg, 'crossexVenue' | 'crossexSymbol' | 'settleFeeApr'> {
  /** Normalized venue key the LTP leg trades on. */
  ltpVenue: string;
  /** LTP symbol convention: `VENUE_PERP_BASE_USDT`. */
  ltpSym: string;
  venueAccess: LtpVenueAccess;
}

export interface LtpOpportunityCostBreakdown extends OpportunityCostBreakdown {
  /** borrowedUsd × loanRateApr × T — 0 when borrowLeverage is 1. Knob-derived,
   * never null. */
  loanInterestUsd: number;
}

/** The LTP capital model: both perp legs' collateral sits in one MarginX group
 * at the chosen leverage L, partly financed by a MarginX borrow at M. */
export interface LtpOpportunityCapitalBreakdown
  extends Pick<OpportunityCapitalBreakdown, 'borosShortImUsd' | 'borosLongImUsd'> {
  /** N/L_short + N/L_long — both perp legs, one pool, each leg at its own
   * (possibly venue-capped) leverage. */
  perpCollateralRequiredUsd: number;
  /** required / M — what the user actually posts. */
  postedPerpCollateralUsd: number;
  /** required − posted — financed, not posted. */
  borrowedUsd: number;
  /** The requested knob. */
  perpLeverage: number;
  /** The knob clamped by the leg venue's published cap (today: Hyperliquid's
   * per-asset max leverage). */
  shortLegLeverage: number;
  longLegLeverage: number;
  borrowLeverage: number;
}

/** `capitalUsd` here = Boros IMs + POSTED perp collateral (borrowed money is
 * not the user's capital; its price is the loanInterestUsd cost line). */
export interface LtpOpportunityPair
  extends Omit<OpportunityPair, 'shortLeg' | 'longLeg' | 'costs' | 'capital'> {
  shortLeg: LtpOpportunityLeg;
  longLeg: LtpOpportunityLeg;
  costs: LtpOpportunityCostBreakdown;
  capital: LtpOpportunityCapitalBreakdown;
}

export interface LtpOpportunityMarketRow
  extends Omit<OpportunityMarketRow, 'crossexVenue' | 'crossexSymbol' | 'settleFeeApr'> {
  ltpVenue: string;
  ltpSym: string;
  venueAccess: LtpVenueAccess;
  /** Whether ltpSym is in LTP's live universe; null = universe unavailable. */
  ltpListed: boolean | null;
}

export interface LtpOpportunityGroup
  extends Omit<OpportunityGroup, 'markets' | 'pairs' | 'bestPair'> {
  markets: LtpOpportunityMarketRow[];
  pairs: LtpOpportunityPair[];
  bestPair: LtpOpportunityPair | null;
}

/** Groups arrive pre-ranked like OpportunitiesResult — never re-sort. */
export interface LtpOpportunitiesResult {
  groups: LtpOpportunityGroup[];
  meta: OpportunitiesResult['meta'] & {
    ltpTier: LtpTier;
    tierSource: LtpTierSource;
    perpLeverage: number;
    borrowLeverage: number;
    /** Decimal FRACTION (0.095 = 9.5%), like every other APR on the wire. */
    loanRateApr: number;
  };
  warnings: string[];
}
