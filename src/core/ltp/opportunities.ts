/**
 * Forward-looking fixed-return opportunities with the perp legs executed
 * through LTP (LiquidityTech prime broker) instead of Gate CrossEx. The Boros
 * side is identical to core/boros/opportunities.ts — same groups, same book
 * walks, same IM model — and every Boros-side helper is IMPORTED from there so
 * the two engines cannot drift.
 *
 * The trade, for a group's HIGH market A and LOW market B:
 *   Boros SHORT fixed on A + LTP perp SHORT on venue A
 *   Boros LONG  fixed on B + LTP perp LONG  on venue B
 * BINANCE/OKX perps are native RapidX; every other venue is reached through an
 * LTP DMA sub-account (tagged on the leg — collateral mobility and the VIP fee
 * ladder are only proven for RapidX). Funding still cancels per venue, so the
 * engine stays funding-agnostic.
 *
 * What replaces the CrossEx capital model: both perp legs sit in one MarginX
 * group at perp leverage L, and part of that collateral is financed by a
 * MarginX borrow at "borrow leverage" M (M = required collateral / posted):
 *   perpCollateralRequiredUsd = N / L_short + N / L_long
 *   postedPerpCollateralUsd   = required / M          (M=1 → no borrow)
 *   borrowedUsd               = required · (1 − 1/M)
 *   loanInterestUsd           = borrowed × loanRateApr × T   — a COST line
 *   capitalUsd                = borosShortIm + borosLongIm + posted
 * `netFixedAprOnCapital` divides by POSTED capital only: borrowed money is not
 * the user's capital; its price appears exactly once, as loanInterestUsd in the
 * ledger. The amplification (posted shrinks with M, profit shrinks only by the
 * interest) is the point of the borrow.
 *
 * Money conventions match the CrossEx engine: APRs are per-year decimal
 * fractions, *Usd costs are positive — EXCEPT perpEntryFeesUsd/perpExitFeesUsd,
 * which go negative when a VIP4+ maker REBATE outweighs the fee. Unknowable
 * values are null, never guessed, each with a plain-language reason.
 */
import { touchOf, type NormalizedBook } from '../estimate/books';
import type { BorosMarket, BorosOrderBook } from '../boros/client';
import {
  assignPerpCosts,
  borosInitialMarginUsd,
  borosSideExec,
  byValueDesc,
  crossCostUsd,
  groupBorosMarkets,
  usd,
  type BookStatus,
  type BorosEntryMode,
  type EntryMode,
  type ExitMode,
  type MarketGroupPlan,
  type PerpLegCost,
  type SideExec,
} from '../boros/opportunities';
import { normalizeVenue, SECONDS_IN_YEAR } from '../boros/venue';

/** RapidX trades these natively; everything else goes through an LTP DMA
 * sub-account. Boros venues absent from this map still pair — as DMA — so a
 * new Boros venue appears (tagged, caveated) instead of vanishing. */
export const BOROS_VENUE_TO_LTP: Record<string, LtpVenueAccess> = {
  BINANCE: 'rapidx',
  OKX: 'rapidx',
  BYBIT: 'dma',
  GATE: 'dma',
  HYPERLIQUID: 'dma',
  KRAKEN: 'dma',
  KUCOIN: 'dma',
  LIGHTER: 'dma',
};

export type LtpVenueAccess = 'rapidx' | 'dma';

/** LTP symbol convention: `VENUE_PERP_BASE_QUOTE` (matches scripts/ltp/arb.ts). */
export function ltpPerpSym(ltpVenue: string, base: string, quote = 'USDT'): string {
  return `${ltpVenue}_PERP_${base}_${quote}`;
}

/** Soft-warning thresholds: L above this has no cap feed to validate against;
 * M above this exceeds MarginX's configured 2× loan leverage (5% loan MMR). */
export const LTP_PERP_LEVERAGE_WARN = 20;
export const LTP_BORROW_LEVERAGE_WARN = 2;

/** Per-venue perp fee rates and where they came from (live account schedule vs
 * the simulated VIP ladder). */
export interface LtpPerpFeeRates {
  makerRate: number;
  takerRate: number;
  source: 'account' | 'tier';
}

export interface LtpOpportunityMarketRow {
  marketId: number;
  name: string;
  /** Boros platformName, verbatim. */
  venue: string;
  /** Normalized venue key the LTP leg trades on (same alphabet as Boros'). */
  ltpVenue: string;
  ltpSym: string;
  venueAccess: LtpVenueAccess;
  /** Whether ltpSym is present in LTP's live symbol universe; null when the
   * universe itself was unavailable. */
  ltpListed: boolean | null;
  base: string;
  midApr: number;
  markApr: number;
  floatingApr: number;
  oiUsd: number | null;
  execShortApr: number | null;
  execLongApr: number | null;
  bookStatus: BookStatus;
}

export interface LtpOpportunityLeg {
  marketId: number;
  /** Boros platformName. */
  venue: string;
  ltpVenue: string;
  ltpSym: string;
  venueAccess: LtpVenueAccess;
  base: string;
  midApr: number;
  execApr: number | null;
}

export interface LtpOpportunityCostBreakdown {
  borosTakerFeeUsd: number;
  borosSettleFeeUsd: number;
  /** May be NEGATIVE under a VIP4+ maker rebate. */
  perpEntryFeesUsd: number | null;
  perpEntrySlippageUsd: number | null;
  /** 0 under `roll`; may be negative under a rebate. */
  perpExitFeesUsd: number | null;
  perpExitSlippageUsd: number | null;
  /** borrowedUsd × loanRateApr × T — 0 when M=1. Never null: it depends only
   * on the knobs, not on any feed. */
  loanInterestUsd: number;
  totalUsd: number | null;
  annualizedApr: number | null;
}

export interface LtpOpportunityCapitalBreakdown {
  borosShortImUsd: number | null;
  borosLongImUsd: number | null;
  /** N/L_short + N/L_long — both perp legs' collateral, one MarginX pool,
   * each leg at its own (possibly venue-capped) leverage. */
  perpCollateralRequiredUsd: number;
  /** required / M — the part the user actually posts. */
  postedPerpCollateralUsd: number;
  /** required − posted — financed by the MarginX borrow. */
  borrowedUsd: number;
  /** The requested knob. */
  perpLeverage: number;
  /** The knob clamped by the leg venue's published cap (today: Hyperliquid's
   * per-asset max leverage; other venues have no public cap feed). */
  shortLegLeverage: number;
  longLegLeverage: number;
  borrowLeverage: number;
}

export interface LtpOpportunityPair {
  base: string;
  shortLeg: LtpOpportunityLeg;
  longLeg: LtpOpportunityLeg;
  grossSpreadApr: number;
  execSpreadApr: number | null;
  borosImpactApr: number | null;
  makerLeg: 'short' | 'long' | null;
  costs: LtpOpportunityCostBreakdown;
  capital: LtpOpportunityCapitalBreakdown;
  /** borosShortIm + borosLongIm + postedPerpCollateral; null when a Boros IM is. */
  capitalUsd: number | null;
  netFixedApr: number | null;
  netFixedAprOnCapital: number | null;
  effectiveLeverage: number | null;
  estProfitUsd: number | null;
  secondsToMaturity: number;
  reasons: string[];
}

export interface LtpOpportunityGroup {
  tokenId: number;
  collateral: string;
  collateralPriceUsd: number | null;
  maturity: number;
  secondsToMaturity: number;
  underlying: string;
  markets: LtpOpportunityMarketRow[];
  pairs: LtpOpportunityPair[];
  bestPair: LtpOpportunityPair | null;
  warnings: string[];
}

export interface LtpOpportunitiesResult {
  groups: LtpOpportunityGroup[];
  meta: {
    asOfSec: number;
    notionalUsd: number;
    borosEntry: BorosEntryMode;
    entryMode: EntryMode;
    exitMode: ExitMode;
    perpLeverage: number;
    borrowLeverage: number;
    loanRateApr: number;
  };
  warnings: string[];
}

export interface BuildLtpOpportunitiesInput {
  markets: BorosMarket[];
  /** tokenId → USD price of the collateral token (null = unpriceable). */
  collateralPricesUsd: Map<number, number | null>;
  /** marketId → Boros book; null/absent = fetch failed or wasn't attempted. */
  borosBooks: Map<number, BorosOrderBook | null>;
  /** `LTPVENUE:BASE` → the venue's own public perp book (fetchVenueBook). */
  venueBooks: Map<string, NormalizedBook | null>;
  /** LTP's live symbol universe (bulk sym/info); null = unavailable — legs
   * still price, with a scan-level warning that listings are assumed. */
  ltpSyms: Set<string> | null;
  /** LTP venue → perp fee rates; null = wholly unpriceable (no account
   * schedule and no ladder entry for the requested tier). */
  perpFees: Map<string, LtpPerpFeeRates> | null;
  /** BASE → Hyperliquid's max leverage (its public meta): HL legs run over a
   * DMA rail that passes HL's own limits through, so the knob is clamped per
   * HL leg. null/absent = caps unavailable — HL legs assume the knob. */
  hlMaxLeverage?: Map<string, number> | null;
  nowSec: number;
}

export interface BuildLtpOpportunitiesOptions {
  notionalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** L — both perp legs' leverage inside the MarginX group. */
  perpLeverage: number;
  /** M — required perp collateral / posted (1 = no borrow). */
  borrowLeverage: number;
  /** Yearly decimal fraction the MarginX borrow accrues at. */
  loanRateApr: number;
  takerFeeOverride?: number;
}

// ---------------------------------------------------------------------------
// Per-market execution
// ---------------------------------------------------------------------------

interface MarketRowBuild {
  row: LtpOpportunityMarketRow;
  market: BorosMarket;
  short: SideExec | null;
  long: SideExec | null;
}

function buildMarketRow(
  market: BorosMarket,
  input: BuildLtpOpportunitiesInput,
  options: BuildLtpOpportunitiesOptions,
  collateralPriceUsd: number | null,
): MarketRowBuild {
  const ltpVenue = normalizeVenue(market.venue);
  const venueAccess = BOROS_VENUE_TO_LTP[ltpVenue] ?? 'dma';
  const base = market.base.toUpperCase();
  const ltpSym = ltpPerpSym(ltpVenue, base);

  const { short, long, bookStatus } = borosSideExec(
    market,
    input.borosBooks,
    options.borosEntry,
    options.notionalUsd,
    collateralPriceUsd,
  );

  return {
    market,
    short,
    long,
    row: {
      marketId: market.marketId,
      name: market.name,
      venue: market.venue,
      ltpVenue,
      ltpSym,
      venueAccess,
      ltpListed: input.ltpSyms === null ? null : input.ltpSyms.has(ltpSym),
      base,
      midApr: market.midApr,
      markApr: market.markApr,
      floatingApr: market.floatingApr,
      oiUsd: collateralPriceUsd === null ? null : market.notionalOi * collateralPriceUsd,
      execShortApr: short ? short.apr : null,
      execLongApr: long ? long.apr : null,
      bookStatus,
    },
  };
}

// ---------------------------------------------------------------------------
// Perp legs
// ---------------------------------------------------------------------------

function perpLegCost(
  leg: LtpOpportunityLeg,
  side: 'SHORT' | 'LONG',
  input: BuildLtpOpportunitiesInput,
  notionalUsd: number,
  reasons: string[],
): PerpLegCost {
  const rates = input.perpFees?.get(leg.ltpVenue) ?? null;
  if (!rates) {
    reasons.push(
      input.perpFees
        ? `No LTP fee rates for ${leg.ltpVenue} — that leg's perp trading fees can't be priced.`
        : `No LTP fee schedule for this tier — perp trading fees for ${leg.ltpVenue} ${leg.ltpSym} can't be priced.`,
    );
  }
  const cost: PerpLegCost = {
    makerRate: rates?.makerRate ?? null,
    takerRate: rates?.takerRate ?? null,
    entrySlipUsd: null,
    exitSlipUsd: null,
  };

  // Slippage comes from the venue's own public book — LTP routes orders to the
  // venue, so the venue's depth IS the fill quality; LTP has no depth endpoint.
  const book = input.venueBooks.get(`${leg.ltpVenue}:${leg.base}`) ?? null;
  const touch = touchOf(book);
  if (!book || !touch || !(touch.mid > 0)) {
    reasons.push(
      `No usable ${leg.ltpVenue} order book for ${leg.base} — the perp slippage at ${usd(notionalUsd)} can't be estimated.`,
    );
    return cost;
  }
  const qty = notionalUsd / touch.mid;
  const entry = crossCostUsd(book, side === 'SHORT' ? 'SELL' : 'BUY', qty, touch.mid);
  const exit = crossCostUsd(book, side === 'SHORT' ? 'BUY' : 'SELL', qty, touch.mid);
  cost.entrySlipUsd = entry ? entry.costUsd : null;
  cost.exitSlipUsd = exit ? exit.costUsd : null;
  if (entry?.exhausted || exit?.exhausted) {
    reasons.push(
      `The ${leg.ltpVenue} ${leg.base} book runs out of depth before ${usd(notionalUsd)} — its slippage estimate extrapolates the last level.`,
    );
  }
  if (!entry || !exit) {
    reasons.push(
      `The ${leg.ltpVenue} ${leg.base} book has no usable levels on one side — the perp slippage at ${usd(notionalUsd)} can't be estimated.`,
    );
  }
  return cost;
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

interface GroupContext {
  plan: MarketGroupPlan;
  secondsToMaturity: number;
  yearsToMaturity: number;
  collateralPriceUsd: number | null;
}

function toLeg(build: MarketRowBuild, side: 'short' | 'long'): LtpOpportunityLeg {
  const exec = side === 'short' ? build.short : build.long;
  return {
    marketId: build.row.marketId,
    venue: build.row.venue,
    ltpVenue: build.row.ltpVenue,
    ltpSym: build.row.ltpSym,
    venueAccess: build.row.venueAccess,
    base: build.row.base,
    midApr: build.row.midApr,
    execApr: exec ? exec.apr : null,
  };
}

/** Names the depth actually available against the size that was asked for. */
function depthReason(
  build: MarketRowBuild,
  exec: SideExec | null,
  sideLabel: 'receive-fixed' | 'pay-fixed',
  ctx: GroupContext,
  notionalUsd: number,
): string | null {
  if (exec && !exec.insufficient) return null;
  if (ctx.collateralPriceUsd === null) {
    return `Can't price ${ctx.plan.collateral} collateral in USD (no reference market) — the Boros book on ${build.row.name} can't be sized in dollars.`;
  }
  if (!exec) {
    return `No Boros order book for ${build.row.name} (market #${build.row.marketId}) — its ${sideLabel} rate at ${usd(notionalUsd)} is unknown.`;
  }
  return `The Boros book on ${build.row.name} (market #${build.row.marketId}) only has ${usd(exec.filledUsd ?? 0)} of ${sideLabel} depth — ${usd(notionalUsd)} is needed to lock this leg.`;
}

function buildPair(
  ctx: GroupContext,
  a: MarketRowBuild,
  b: MarketRowBuild,
  input: BuildLtpOpportunitiesInput,
  options: BuildLtpOpportunitiesOptions,
): LtpOpportunityPair {
  const { notionalUsd, entryMode, exitMode, takerFeeOverride } = options;
  const perpLeverage = Math.max(1, options.perpLeverage);
  const borrowLeverage = Math.max(1, options.borrowLeverage);
  const reasons: string[] = [];
  const shortLeg = toLeg(a, 'short');
  const longLeg = toLeg(b, 'long');

  // --- Boros side (identical to the CrossEx engine) --------------------------
  const grossSpreadApr = a.row.midApr - b.row.midApr;
  const shortDepth = depthReason(a, a.short, 'receive-fixed', ctx, notionalUsd);
  const longDepth = depthReason(b, b.long, 'pay-fixed', ctx, notionalUsd);
  if (shortDepth) reasons.push(shortDepth);
  if (longDepth) reasons.push(longDepth);
  const lockable = a.short && b.long && !a.short.insufficient && !b.long.insufficient;
  const execSpreadApr = lockable ? a.short!.apr - b.long!.apr : null;
  const borosImpactApr = execSpreadApr === null ? null : grossSpreadApr - execSpreadApr;

  // --- LTP standing caveats ---------------------------------------------------
  for (const leg of [shortLeg, longLeg]) {
    if (leg.venueAccess === 'dma') {
      reasons.push(
        `The ${leg.ltpVenue} leg executes via an LTP DMA sub-account, not RapidX — MarginX cross-venue collateral mobility may not hold there and the VIP fee ladder may not apply.`,
      );
    }
    const listed = input.ltpSyms === null ? null : input.ltpSyms.has(leg.ltpSym);
    if (listed === false) {
      reasons.push(
        `${leg.ltpSym} is not in LTP's live symbol universe — this leg may not be tradable through LTP as modelled.`,
      );
    }
  }

  // --- Perp legs --------------------------------------------------------------
  const shortCost = perpLegCost(shortLeg, 'SHORT', input, notionalUsd, reasons);
  const longCost = perpLegCost(longLeg, 'LONG', input, notionalUsd, reasons);
  const entry = assignPerpCosts(shortCost, longCost, (l) => l.entrySlipUsd, notionalUsd, entryMode);
  const exit =
    exitMode === 'roll'
      ? { feesUsd: 0, slippageUsd: 0, makerLeg: null as 'short' | 'long' | null }
      : assignPerpCosts(shortCost, longCost, (l) => l.exitSlipUsd, notionalUsd, entryMode);
  if (entryMode === 'maker-hedge') {
    if (entry.makerLeg) {
      const maker = entry.makerLeg === 'short' ? shortLeg : longLeg;
      reasons.push(
        `The ${maker.ltpVenue} ${maker.ltpSym} leg rests as a maker order — its fill is not guaranteed and the cost assumes it fills at mid.`,
      );
    } else {
      reasons.push(
        `Maker + hedge needs both legs' fee rates and book depth — the perp cost can't be split between a resting maker order and its taker hedge.`,
      );
    }
  }

  // --- Capital (the LTP-specific model) ---------------------------------------
  // Each leg is sized at the knob leverage, clamped by Hyperliquid's published
  // per-asset cap when the leg runs over the HL DMA rail (no other venue has a
  // public cap feed wired — their legs keep the knob).
  const legLeverage = (leg: LtpOpportunityLeg): number => {
    if (leg.ltpVenue !== 'HYPERLIQUID') return perpLeverage;
    const cap = input.hlMaxLeverage?.get(leg.base.toUpperCase());
    return cap !== undefined && cap < perpLeverage ? cap : perpLeverage;
  };
  const shortLegLeverage = legLeverage(shortLeg);
  const longLegLeverage = legLeverage(longLeg);
  for (const [leg, lev] of [
    [shortLeg, shortLegLeverage],
    [longLeg, longLegLeverage],
  ] as const) {
    if (lev < perpLeverage) {
      reasons.push(
        `Hyperliquid caps ${leg.base} at ${lev}× — the ${leg.ltpVenue} leg opens at ${lev}×, not ${perpLeverage}×, and its collateral is sized accordingly.`,
      );
    }
  }
  const perpCollateralRequiredUsd = notionalUsd / shortLegLeverage + notionalUsd / longLegLeverage;
  const postedPerpCollateralUsd = perpCollateralRequiredUsd / borrowLeverage;
  const borrowedUsd = perpCollateralRequiredUsd - postedPerpCollateralUsd;
  if (borrowedUsd > 0) {
    reasons.push(
      `The MarginX borrow finances ${usd(borrowedUsd)} of the perp collateral — the loan carries its own 5% maintenance margin and liquidation dynamics on top of the position's.`,
    );
  }

  // --- Costs -------------------------------------------------------------------
  const notionalYears = notionalUsd * ctx.yearsToMaturity;
  const borosTakerRate = (m: BorosMarket): number =>
    takerFeeOverride !== undefined && takerFeeOverride >= 0 ? takerFeeOverride : m.takerFeeRate;
  const borosTakerFeeUsd = (borosTakerRate(a.market) + borosTakerRate(b.market)) * notionalYears;
  const borosSettleFeeUsd = (a.market.settleFeeApr + b.market.settleFeeApr) * notionalYears;
  const loanInterestUsd = borrowedUsd * options.loanRateApr * ctx.yearsToMaturity;
  const perpParts = [entry.feesUsd, entry.slippageUsd, exit.feesUsd, exit.slippageUsd];
  const totalUsd = perpParts.some((p) => p === null)
    ? null
    : borosTakerFeeUsd +
      borosSettleFeeUsd +
      loanInterestUsd +
      (perpParts as number[]).reduce((s, p) => s + p, 0);
  const annualizedApr = totalUsd === null || !(notionalYears > 0) ? null : totalUsd / notionalYears;
  const netFixedApr =
    execSpreadApr === null || annualizedApr === null ? null : execSpreadApr - annualizedApr;
  const estProfitUsd = netFixedApr === null ? null : netFixedApr * notionalYears;

  // --- Capital total & headline -------------------------------------------------
  const borosIm = (build: MarketRowBuild, execApr: number | null): number | null => {
    if (execApr === null) {
      reasons.push(
        `${build.row.name} (market #${build.row.marketId}) has no lockable rate at ${usd(notionalUsd)} — its Boros initial margin can't be modelled, so the capital and the APR on capital are unknown.`,
      );
      return null;
    }
    const im = borosInitialMarginUsd(build.market, execApr, notionalUsd, input.nowSec);
    if (im === null) {
      reasons.push(
        `${build.row.name} (market #${build.row.marketId}) carries no margin coefficient — its Boros initial margin can't be modelled, so the capital and the APR on capital are unknown.`,
      );
    }
    return im;
  };

  const capital: LtpOpportunityCapitalBreakdown = {
    borosShortImUsd: borosIm(a, shortLeg.execApr),
    borosLongImUsd: borosIm(b, longLeg.execApr),
    perpCollateralRequiredUsd,
    postedPerpCollateralUsd,
    borrowedUsd,
    perpLeverage,
    shortLegLeverage,
    longLegLeverage,
    borrowLeverage,
  };
  const capitalUsd =
    capital.borosShortImUsd === null || capital.borosLongImUsd === null
      ? null
      : capital.borosShortImUsd + capital.borosLongImUsd + postedPerpCollateralUsd;
  const capitalPriced = capitalUsd !== null && capitalUsd > 0 ? capitalUsd : null;
  const netFixedAprOnCapital =
    capitalPriced === null || estProfitUsd === null || !(ctx.yearsToMaturity > 0)
      ? null
      : estProfitUsd / (capitalPriced * ctx.yearsToMaturity);
  const effectiveLeverage = capitalPriced === null ? null : notionalUsd / capitalPriced;

  return {
    base: shortLeg.base === longLeg.base ? shortLeg.base : ctx.plan.underlying,
    shortLeg,
    longLeg,
    grossSpreadApr,
    execSpreadApr,
    borosImpactApr,
    makerLeg: entry.makerLeg,
    costs: {
      borosTakerFeeUsd,
      borosSettleFeeUsd,
      perpEntryFeesUsd: entry.feesUsd,
      perpEntrySlippageUsd: entry.slippageUsd,
      perpExitFeesUsd: exit.feesUsd,
      perpExitSlippageUsd: exit.slippageUsd,
      loanInterestUsd,
      totalUsd,
      annualizedApr,
    },
    capital,
    capitalUsd,
    netFixedApr,
    netFixedAprOnCapital,
    effectiveLeverage,
    estProfitUsd,
    secondsToMaturity: ctx.secondsToMaturity,
    reasons: [...new Set(reasons)],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const directionApr = (build: MarketRowBuild, options: BuildLtpOpportunitiesOptions): number =>
  options.borosEntry === 'mark' ? build.row.markApr : build.row.midApr;

export function buildLtpOpportunities(
  input: BuildLtpOpportunitiesInput,
  options: BuildLtpOpportunitiesOptions,
): LtpOpportunitiesResult {
  const warnings: string[] = [];
  if (input.perpFees === null) {
    warnings.push(
      "No LTP fee schedule for this tier — perp trading fees are unknown, so net fixed APRs can't be quoted.",
    );
  }
  if (input.ltpSyms === null) {
    warnings.push(
      'LTP is not configured on this server — perp listings on BINANCE/OKX are assumed, not confirmed against the live LTP symbol universe.',
    );
  }
  if (options.perpLeverage > LTP_PERP_LEVERAGE_WARN) {
    warnings.push(
      `Perp leverage ${options.perpLeverage}× exceeds ${LTP_PERP_LEVERAGE_WARN}× — LTP exposes no leverage-cap feed for its RapidX venues, so a venue may reject or force a lower setting (Hyperliquid legs are already clamped to HL's published cap); check uniMMR after opening.`,
    );
  }
  if (options.borrowLeverage > LTP_BORROW_LEVERAGE_WARN) {
    warnings.push(
      `Borrow leverage ${options.borrowLeverage}× exceeds MarginX's configured ${LTP_BORROW_LEVERAGE_WARN}× loan cap (5% loan maintenance margin) — this borrow likely cannot be opened as modelled.`,
    );
  }

  const groups = groupBorosMarkets(input.markets, input.nowSec).map((plan) => {
    const collateralPriceUsd = input.collateralPricesUsd.get(plan.tokenId) ?? null;
    const secondsToMaturity = Math.max(0, plan.maturity - input.nowSec);
    const ctx: GroupContext = {
      plan,
      secondsToMaturity,
      yearsToMaturity: secondsToMaturity / SECONDS_IN_YEAR,
      collateralPriceUsd,
    };
    const groupWarnings: string[] = [];
    if (collateralPriceUsd === null && options.borosEntry === 'market') {
      groupWarnings.push(
        `Can't price ${plan.collateral} collateral in USD (no reference market) — this group's book depth and open interest can't be sized in dollars.`,
      );
    }

    const builds = plan.markets.map((m) => buildMarketRow(m, input, options, collateralPriceUsd));

    // Every Boros venue maps to an LTP leg (RapidX or DMA), so — unlike the
    // CrossEx engine — no market is unpairable; the DMA/unlisted caveats live
    // on the pairs.
    const pairs: LtpOpportunityPair[] = [];
    for (let i = 0; i < builds.length; i += 1) {
      for (let j = 0; j < builds.length; j += 1) {
        const a = builds[i];
        const b = builds[j];
        if (directionApr(a, options) <= directionApr(b, options)) continue;
        if (a.row.ltpVenue === b.row.ltpVenue) continue;
        pairs.push(buildPair(ctx, a, b, input, options));
      }
    }
    pairs.sort(
      (x, y) =>
        byValueDesc(x.netFixedAprOnCapital, y.netFixedAprOnCapital) ||
        byValueDesc(x.netFixedApr, y.netFixedApr) ||
        byValueDesc(x.execSpreadApr, y.execSpreadApr) ||
        y.grossSpreadApr - x.grossSpreadApr,
    );

    return {
      tokenId: plan.tokenId,
      collateral: plan.collateral,
      collateralPriceUsd,
      maturity: plan.maturity,
      secondsToMaturity,
      underlying: plan.underlying,
      markets: builds.map((x) => x.row),
      pairs,
      bestPair: pairs.length && pairs[0].netFixedAprOnCapital !== null ? pairs[0] : null,
      warnings: [...new Set(groupWarnings)],
    };
  });

  const topGross = (g: LtpOpportunityGroup): number =>
    g.pairs.length ? Math.max(...g.pairs.map((p) => p.grossSpreadApr)) : -Infinity;
  const top = (g: LtpOpportunityGroup): LtpOpportunityPair | null => g.pairs[0] ?? null;
  groups.sort(
    (x, y) =>
      byValueDesc(top(x)?.netFixedAprOnCapital ?? null, top(y)?.netFixedAprOnCapital ?? null) ||
      byValueDesc(top(x)?.netFixedApr ?? null, top(y)?.netFixedApr ?? null) ||
      topGross(y) - topGross(x),
  );

  return {
    groups,
    meta: {
      asOfSec: input.nowSec,
      notionalUsd: options.notionalUsd,
      borosEntry: options.borosEntry,
      entryMode: options.entryMode,
      exitMode: options.exitMode,
      perpLeverage: options.perpLeverage,
      borrowLeverage: options.borrowLeverage,
      loanRateApr: options.loanRateApr,
    },
    warnings: [...new Set(warnings)],
  };
}
