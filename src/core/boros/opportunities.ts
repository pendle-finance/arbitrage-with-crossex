/**
 * Forward-looking fixed-return opportunities: scan the Boros arb groups (same
 * collateral + same maturity + same underlying, ≥2 markets — the grouping the
 * boros-tools OTC dashboard uses) and price the 4-leg trade at a chosen
 * notional, so the answer to "what's the best fixed return I could put on right
 * now?" is a NET APR rather than a headline spread.
 *
 * The trade, for a group's HIGH-mid-APR market A and LOW-mid-APR market B
 * (same sign conventions as returns.ts):
 *   Boros SHORT fixed on A  → SELL into A's BIDS, receive fixed rate_A
 *   Boros LONG  fixed on B  → BUY  from B's ASKS, pay     fixed rate_B
 *   perp SHORT on venue A   → receives floating_A ⇒ cancels the Boros leg
 *   perp LONG  on venue B   → pays     floating_B ⇒ cancels the Boros leg
 * The locked spread is exec_A − exec_B, funding-agnostic; every cost below is
 * what erodes it.
 *
 * Money conventions: all APR fields are per-year decimal FRACTIONS (never
 * percent) and every *Usd cost is a POSITIVE number. Two net APRs are quoted,
 * on the per-leg notional N and on the CAPITAL the trade consumes, over the
 * shared duration T:
 *   netFixedApr          = execSpreadApr − totalCostUsd / (N × T)
 *   netFixedAprOnCapital = estProfitUsd / (capitalUsd × T)
 * The capital basis is the headline — it is the same figure the Positions view
 * calls "Fixed APR on capital" (returns.ts `lockedAprOnCapital`), so an
 * opportunity is directly comparable to an open strategy, and it is what pairs
 * and groups rank on. Capital there is live account state; here it is MODELLED
 * (Boros initial margin per leg + perp initial margin at venue max leverage),
 * so it is the MINIMUM the trade requires — over-collateralizing a Boros
 * account makes the same trade read lower once it is open.
 *
 * Pure module: books, fee rows and the clock are all injected, so nothing here
 * fetches or reads time. A cost component that cannot be computed is `null`,
 * never a guess — nulls propagate to totalUsd/netFixedApr/estProfitUsd and each
 * one leaves a plain-language sentence in `reasons`.
 */
import { touchOf, type NormalizedBook } from '../estimate/books';
import { walkBook } from '../estimate/fill';
import { resolveFeeRates, resolveVenueFeeRates, type VenueFeeRow } from '../estimate/fees';
import { BOROS_TOKEN_SYMBOLS, type BorosMarket, type BorosOrderBook } from './client';
import { normalizeVenue, SECONDS_IN_YEAR } from './venue';

/** Boros platformName (normalized) → CrossEx exchange key. Venues absent here
 * (Kucoin, Lighter) are listed in the group but can't carry a perp leg. */
export const BOROS_VENUE_TO_CROSSEX: Record<string, string> = {
  BINANCE: 'BINANCE',
  BYBIT: 'BYBIT',
  GATE: 'GATE',
  OKX: 'OKX',
  HYPERLIQUID: 'HYPERLIQUID',
  KRAKEN: 'KRAKEN',
};

/** Fungible tickers that must land in ONE group (mirrors boros-tools'
 * _UNDERLYING_GROUPS) — the books trade the same underlying under two names. */
const UNDERLYING_GROUPS: Record<string, string> = {
  XAU: 'GOLD',
  GOLD: 'GOLD',
  BRENTOIL: 'CRUDE',
  CL: 'CRUDE',
};

/** Group key for a market's traded coin; unknown tickers pass through upper-cased. */
export function normalizeUnderlying(base: string): string {
  const b = base.trim().toUpperCase();
  return UNDERLYING_GROUPS[b] ?? b;
}

/** How the Boros entry rate is established: taker VWAP of both books at N, or
 * each market's mark APR (assumes patient limit entry, needs no book). */
export type BorosEntryMode = 'mark' | 'market';

/** How the two perp legs are executed: both crossing, or one resting maker
 * order hedged by a taker fill on the other venue. */
export type EntryMode = 'both-market' | 'maker-hedge';

/** Whether the perps are closed at maturity or rolled into the next cohort. */
export type ExitMode = 'close' | 'roll';

/** Why a market's exec APRs are what they are — drives the UI's per-row badge. */
export type BookStatus = 'ok' | 'insufficient-depth' | 'unavailable' | 'not-fetched';

/** One member of an arb group, whether or not it can carry a perp leg. */
export interface OpportunityMarketRow {
  marketId: number;
  name: string;
  /** Boros platformName, verbatim. */
  venue: string;
  /** Mapped CrossEx exchange; null when the venue has no CrossEx perp. */
  crossexVenue: string | null;
  /** Live CrossEx symbol for (crossexVenue, base); null when none is listed. */
  crossexSymbol: string | null;
  base: string;
  midApr: number;
  markApr: number;
  floatingApr: number;
  /** Open interest in USD; null when the collateral can't be priced. */
  oiUsd: number | null;
  /** Rate achievable going SHORT fixed here (hitting bids) at the chosen size. */
  execShortApr: number | null;
  /** Rate achievable going LONG fixed here (lifting asks) at the chosen size. */
  execLongApr: number | null;
  bookStatus: BookStatus;
}

/** The pair's cost ledger. The four perp components are null when unknowable;
 * the two Boros components are always computable from the market config. */
export interface OpportunityCostBreakdown {
  /** (takerFeeRateA + takerFeeRateB) × N × T — charged on notional × duration. */
  borosTakerFeeUsd: number;
  /** (settleFeeAprA + settleFeeAprB) × N × T, accrued to maturity. */
  borosSettleFeeUsd: number;
  perpEntryFeesUsd: number | null;
  perpEntrySlippageUsd: number | null;
  /** 0 under `roll` — nothing is closed. */
  perpExitFeesUsd: number | null;
  perpExitSlippageUsd: number | null;
  totalUsd: number | null;
  /** totalUsd / (N × T) — the cost expressed as an APR drag. */
  annualizedApr: number | null;
}

export interface OpportunityLeg {
  marketId: number;
  /** Boros platformName. */
  venue: string;
  crossexVenue: string;
  crossexSymbol: string;
  base: string;
  midApr: number;
  /** The rate this leg actually locks (receive-fixed on the short, pay-fixed on
   * the long); null when the book can't support the size. */
  execApr: number | null;
}

/** The modelled minimum capital a pair consumes, leg by leg. Each component is
 * null when an input it needs is missing, and any null nulls `capitalUsd`. */
export interface OpportunityCapitalBreakdown {
  borosShortImUsd: number | null;
  borosLongImUsd: number | null;
  perpShortImUsd: number | null;
  perpLongImUsd: number | null;
  /** Max leverage used to size the perp leg's margin; null when unknown. */
  shortLeverageMax: number | null;
  longLeverageMax: number | null;
}

export interface OpportunityPair {
  /** The legs' shared asset symbol, or the group underlying when they differ
   * (fungible groups like GOLD collapse XAU and GOLD markets). */
  base: string;
  /** Market A: Boros SHORT fixed + perp SHORT. */
  shortLeg: OpportunityLeg;
  /** Market B: Boros LONG fixed + perp LONG. */
  longLeg: OpportunityLeg;
  /** midApr_A − midApr_B — the headline spread, before any execution cost. */
  grossSpreadApr: number;
  /** execApr_A − execApr_B — what the size actually locks. */
  execSpreadApr: number | null;
  /** grossSpreadApr − execSpreadApr: the Boros books' price impact. */
  borosImpactApr: number | null;
  /** Which leg rests as the maker order under `maker-hedge`; null otherwise. */
  makerLeg: 'short' | 'long' | null;
  costs: OpportunityCostBreakdown;
  capital: OpportunityCapitalBreakdown;
  /** Σ of the four capital components; null when any one of them is. */
  capitalUsd: number | null;
  netFixedApr: number | null;
  /** The headline: the locked net fixed return over the capital consumed. */
  netFixedAprOnCapital: number | null;
  /** notionalUsd / capitalUsd — the ratio between the two net APRs. */
  effectiveLeverage: number | null;
  estProfitUsd: number | null;
  secondsToMaturity: number;
  /** Plain-language sentences: every null above, plus standing caveats. */
  reasons: string[];
}

export interface OpportunityGroup {
  tokenId: number;
  /** Collateral token symbol, e.g. "USDT". */
  collateral: string;
  /** USD price of the collateral token (1 for USDT); null = unpriceable. */
  collateralPriceUsd: number | null;
  /** Unix seconds. */
  maturity: number;
  secondsToMaturity: number;
  underlying: string;
  markets: OpportunityMarketRow[];
  pairs: OpportunityPair[];
  /** pairs[0] when its netFixedAprOnCapital is known; null otherwise. */
  bestPair: OpportunityPair | null;
  warnings: string[];
}

export interface OpportunitiesResult {
  groups: OpportunityGroup[];
  meta: {
    asOfSec: number;
    notionalUsd: number;
    borosEntry: BorosEntryMode;
    entryMode: EntryMode;
    exitMode: ExitMode;
  };
  warnings: string[];
}

/** What the route must fetch for one group — produced by `groupBorosMarkets`
 * so the fetch plan and the math can never disagree about membership. */
export interface MarketGroupPlan {
  key: string;
  tokenId: number;
  collateral: string;
  maturity: number;
  underlying: string;
  /** Members, midApr descending. */
  markets: BorosMarket[];
}

export interface BuildOpportunitiesInput {
  markets: BorosMarket[];
  /** tokenId → USD price of the COLLATERAL token (null = unpriceable). */
  collateralPricesUsd: Map<number, number | null>;
  /** marketId → book; null/absent = the fetch failed or wasn't attempted. */
  borosBooks: Map<number, BorosOrderBook | null>;
  /** CrossEx symbol → perp book; null/absent = unavailable. */
  venueBooks: Map<string, NormalizedBook | null>;
  /** `VENUE:BASE` → live CrossEx symbol. */
  symbolsByVenueBase: Map<string, string>;
  /** CrossEx symbol → venue max leverage; absent = the risk-limit read failed
   * or wasn't attempted, which nulls that pair's capital. */
  leverageMaxBySymbol: Map<string, number>;
  /** /crossex/fee rows; null = the schedule is unavailable. */
  feeRows: VenueFeeRow[] | null;
  nowSec: number;
}

export interface BuildOpportunitiesOptions {
  notionalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** Taker-fee rate that replaces every market's own when set (≥ 0) — the
   * BOROS_TAKER_FEE_OVERRIDE env knob, resolved once by the route. */
  takerFeeOverride?: number;
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * VWAP over the FILLED portion of one Boros book side, walking levels in order
 * (they arrive best-first). Sizes are collateral-token units, so each level is
 * worth `size × collateralPriceUsd`.
 *
 * Unlike `walkBook` (estimate/fill.ts) this NEVER extrapolates the tail: a rate
 * beyond the last level isn't lockable, so a short book sets `insufficient` and
 * the caller refuses to quote a net APR. Null on an empty side or a
 * non-positive target/price.
 */
export function walkBorosBook(
  levels: Array<[number, number]>,
  targetUsd: number,
  collateralPriceUsd: number,
): { execApr: number; filledUsd: number; insufficient: boolean } | null {
  if (!Array.isArray(levels) || !(targetUsd > 0) || !(collateralPriceUsd > 0)) return null;
  let remaining = targetUsd;
  let weighted = 0;
  let filled = 0;
  for (const [apr, size] of levels) {
    if (!Number.isFinite(apr) || !(size > 0)) continue;
    const levelUsd = size * collateralPriceUsd;
    const take = remaining < levelUsd ? remaining : levelUsd;
    weighted += take * apr;
    filled += take;
    remaining -= take; // exact 0 on the final level (take === remaining)
    if (remaining === 0) break;
  }
  if (filled === 0) return null;
  return { execApr: weighted / filled, filledUsd: filled, insufficient: remaining > 0 };
}

// ---------------------------------------------------------------------------
// Capital model
// ---------------------------------------------------------------------------

const DAY_SECONDS = 86_400;
const DAYS_IN_YEAR = 365;

/**
 * The APR floor the Boros IM formula charges when the entry rate is smaller:
 * `1.00005 ^ (iTickThresh × margin tickStep) − 1`. Live floors run 6%–300%, so
 * on a low-rate market it — not the entry rate — sets the margin. 0 when either
 * input is missing, which makes the floor inert rather than wrong.
 */
export function borosAprFloor(m: BorosMarket): number {
  const exponent = m.imTickThresh * m.imTickStep;
  if (!Number.isFinite(exponent)) return 0;
  return 1.00005 ** exponent - 1;
}

/**
 * Initial margin one Boros leg posts, per the whitepaper formula:
 *   IM = N × max(|apr|, floor) × max(DTM_days, tThresh_days) / 365 × kIM
 * It is linear in N, so a USD notional yields IM in USD directly — there is no
 * collateral-price step. `execApr` is the rate that leg actually locks
 * (receive-fixed on the short, pay-fixed on the long).
 *
 * Null when `kIM` is missing or non-positive, so a market whose config didn't
 * carry the margin inputs degrades visibly instead of reading as free margin.
 */
export function borosInitialMarginUsd(
  m: BorosMarket,
  execApr: number,
  notionalUsd: number,
  nowSec: number,
): number | null {
  if (!Number.isFinite(m.kIM) || m.kIM <= 0) return null;
  if (!Number.isFinite(execApr) || !Number.isFinite(notionalUsd)) return null;
  const rate = Math.max(Math.abs(execApr), borosAprFloor(m));
  const dtmDays = (m.maturity - nowSec) / DAY_SECONDS;
  const tThreshDays = (Number.isFinite(m.tThreshSec) ? m.tThreshSec : 0) / DAY_SECONDS;
  return (notionalUsd * rate * Math.max(dtmDays, tThreshDays) * m.kIM) / DAYS_IN_YEAR;
}

/**
 * Initial margin one perp leg posts at the venue's max leverage — what
 * `PairTicket` actually opens at. Deliberately EXCLUDES preflight's
 * `PREFLIGHT_MARGIN_BUFFER` and `TAKER_FEE_RESERVE`: those make preflight a
 * sufficiency check, whereas the capital figure here (like the Positions view's)
 * is raw initial margin. Null when the leverage cap is unknown or non-positive.
 */
export function perpInitialMarginUsd(
  notionalUsd: number,
  leverageMax: number | null | undefined,
): number | null {
  if (leverageMax === null || leverageMax === undefined) return null;
  if (!Number.isFinite(leverageMax) || leverageMax <= 0) return null;
  if (!Number.isFinite(notionalUsd)) return null;
  return notionalUsd / leverageMax;
}

/**
 * Arb groups: live markets sharing collateral token, maturity and underlying,
 * with at least two members. Matured or non-`Normal` markets are dropped —
 * neither is tradable.
 */
export function groupBorosMarkets(markets: BorosMarket[], nowSec: number): MarketGroupPlan[] {
  const groups = new Map<string, MarketGroupPlan>();
  for (const m of markets) {
    if (m.state !== 'Normal' || m.maturity <= nowSec) continue;
    const underlying = normalizeUnderlying(m.base);
    const key = `${m.tokenId}:${m.maturity}:${underlying}`;
    const group = groups.get(key) ?? {
      key,
      tokenId: m.tokenId,
      collateral: BOROS_TOKEN_SYMBOLS[m.tokenId] ?? `token#${m.tokenId}`,
      maturity: m.maturity,
      underlying,
      markets: [],
    };
    group.markets.push(m);
    groups.set(key, group);
  }
  const out: MarketGroupPlan[] = [];
  for (const group of groups.values()) {
    if (group.markets.length < 2) continue;
    group.markets.sort((a, b) => b.midApr - a.midApr);
    out.push(group);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-market execution
// ---------------------------------------------------------------------------

interface SideExec {
  apr: number;
  /** USD actually available on that side; null under `mark` (no book walked). */
  filledUsd: number | null;
  insufficient: boolean;
}

interface MarketRowBuild {
  row: OpportunityMarketRow;
  market: BorosMarket;
  /** Hitting the bids — the receive-fixed (SHORT) side. */
  short: SideExec | null;
  /** Lifting the asks — the pay-fixed (LONG) side. */
  long: SideExec | null;
}

function buildMarketRow(
  market: BorosMarket,
  input: BuildOpportunitiesInput,
  options: BuildOpportunitiesOptions,
  collateralPriceUsd: number | null,
): MarketRowBuild {
  const crossexVenue = BOROS_VENUE_TO_CROSSEX[normalizeVenue(market.venue)] ?? null;
  const base = market.base.toUpperCase();
  const crossexSymbol = crossexVenue
    ? (input.symbolsByVenueBase.get(`${crossexVenue}:${base}`) ?? null)
    : null;

  let short: SideExec | null = null;
  let long: SideExec | null = null;
  let bookStatus: BookStatus;
  if (options.borosEntry === 'mark') {
    short = { apr: market.markApr, filledUsd: null, insufficient: false };
    long = { apr: market.markApr, filledUsd: null, insufficient: false };
    bookStatus = 'not-fetched';
  } else {
    const book = input.borosBooks.get(market.marketId) ?? null;
    const px = collateralPriceUsd;
    if (book && px !== null) {
      const bidWalk = walkBorosBook(book.bids, options.notionalUsd, px);
      const askWalk = walkBorosBook(book.asks, options.notionalUsd, px);
      short = bidWalk && { apr: bidWalk.execApr, filledUsd: bidWalk.filledUsd, insufficient: bidWalk.insufficient };
      long = askWalk && { apr: askWalk.execApr, filledUsd: askWalk.filledUsd, insufficient: askWalk.insufficient };
    }
    // A side with no levels at all is 'unavailable', not thin: there is no rate
    // to quote there, and the per-side execAprs say which one is missing.
    if (!short || !long) bookStatus = 'unavailable';
    else if (short.insufficient || long.insufficient) bookStatus = 'insufficient-depth';
    else bookStatus = 'ok';
  }

  return {
    market,
    short,
    long,
    row: {
      marketId: market.marketId,
      name: market.name,
      venue: market.venue,
      crossexVenue,
      crossexSymbol,
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

interface PerpLegCost {
  makerRate: number | null;
  takerRate: number | null;
  /** Crossing cost of opening this leg at N, USD, positive = paid up vs mid. */
  entrySlipUsd: number | null;
  /** Same walk on the opposite side of the same snapshot — the close. */
  exitSlipUsd: number | null;
}

/** Signed-against-the-taker crossing cost of `qty` on one side, in USD. */
function crossCostUsd(
  book: NormalizedBook,
  side: 'BUY' | 'SELL',
  qty: number,
  mid: number,
): { costUsd: number; exhausted: boolean } | null {
  const walk = walkBook(side === 'BUY' ? book.asks : book.bids, qty);
  if (!walk) return null;
  const perUnit = side === 'BUY' ? walk.avgPrice - mid : mid - walk.avgPrice;
  return { costUsd: perUnit * qty, exhausted: walk.exhausted };
}

/** venueBooks key for a leg. A leg without a live CrossEx symbol falls back to
 * the venue's PUBLIC book under `VENUE:BASE` — the route fetches that key when
 * the symbol universe is unavailable (Gate unconfigured or down). */
function bookKeyOf(leg: OpportunityLeg): string {
  return leg.crossexSymbol ?? `${leg.crossexVenue}:${leg.base}`;
}

function perpLegCost(
  leg: OpportunityLeg,
  side: 'SHORT' | 'LONG',
  input: BuildOpportunitiesInput,
  notionalUsd: number,
  reasons: string[],
): PerpLegCost {
  // Without a live CrossEx symbol the leg still prices: fees from the venue's
  // fee row, slippage from the venue's public book. What stays unknown is
  // whether CrossEx actually lists the perp — the group warning carries that.
  const rates = input.feeRows
    ? leg.crossexSymbol
      ? resolveFeeRates(input.feeRows, leg.crossexSymbol)
      : resolveVenueFeeRates(input.feeRows, leg.crossexVenue)
    : null;
  const label = leg.crossexSymbol ?? leg.base;
  if (!rates) {
    reasons.push(
      input.feeRows
        ? `No CrossEx fee row for ${leg.crossexVenue} (${label}) — that leg's perp trading fees can't be priced.`
        : `The CrossEx fee schedule is unavailable — perp trading fees for ${leg.crossexVenue} ${label} can't be priced.`,
    );
  }
  const cost: PerpLegCost = {
    makerRate: rates?.makerRate ?? null,
    takerRate: rates?.takerRate ?? null,
    entrySlipUsd: null,
    exitSlipUsd: null,
  };

  const book = input.venueBooks.get(bookKeyOf(leg)) ?? null;
  const touch = touchOf(book);
  if (!book || !touch || !(touch.mid > 0)) {
    reasons.push(
      `No usable ${leg.crossexVenue} order book for ${label} — the perp slippage at ${usd(notionalUsd)} can't be estimated.`,
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
      `The ${leg.crossexVenue} ${label} book runs out of depth before ${usd(notionalUsd)} — its slippage estimate extrapolates the last level.`,
    );
  }
  if (!entry || !exit) {
    reasons.push(
      `The ${leg.crossexVenue} ${label} book has no usable levels on one side — the perp slippage at ${usd(notionalUsd)} can't be estimated.`,
    );
  }
  return cost;
}

/**
 * Split one phase's perp cost between the two legs. `both-market` crosses both
 * books; `maker-hedge` rests one leg and hedges the other, choosing the
 * assignment that minimises fees AND slippage JOINTLY — a fee-only pick can
 * lose more on the hedge's crossing cost than it saves.
 */
function assignPerpCosts(
  a: PerpLegCost,
  b: PerpLegCost,
  slipOf: (leg: PerpLegCost) => number | null,
  notionalUsd: number,
  entryMode: EntryMode,
): { feesUsd: number | null; slippageUsd: number | null; makerLeg: 'short' | 'long' | null } {
  const slipA = slipOf(a);
  const slipB = slipOf(b);
  if (entryMode === 'both-market') {
    return {
      feesUsd:
        a.takerRate === null || b.takerRate === null
          ? null
          : notionalUsd * (a.takerRate + b.takerRate),
      slippageUsd: slipA === null || slipB === null ? null : slipA + slipB,
      makerLeg: null,
    };
  }
  if (
    a.makerRate === null ||
    a.takerRate === null ||
    b.makerRate === null ||
    b.takerRate === null ||
    slipA === null ||
    slipB === null
  ) {
    return { feesUsd: null, slippageUsd: null, makerLeg: null };
  }
  const makerOnA = notionalUsd * (a.makerRate + b.takerRate) + slipB;
  const makerOnB = notionalUsd * (b.makerRate + a.takerRate) + slipA;
  return makerOnA <= makerOnB
    ? { feesUsd: notionalUsd * (a.makerRate + b.takerRate), slippageUsd: slipB, makerLeg: 'short' }
    : { feesUsd: notionalUsd * (b.makerRate + a.takerRate), slippageUsd: slipA, makerLeg: 'long' };
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

function toLeg(build: MarketRowBuild, side: 'short' | 'long'): OpportunityLeg {
  const exec = side === 'short' ? build.short : build.long;
  return {
    marketId: build.row.marketId,
    venue: build.row.venue,
    crossexVenue: build.row.crossexVenue as string,
    crossexSymbol: build.row.crossexSymbol as string,
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
  input: BuildOpportunitiesInput,
  options: BuildOpportunitiesOptions,
): OpportunityPair {
  const { notionalUsd, entryMode, exitMode, takerFeeOverride } = options;
  const reasons: string[] = [];
  const shortLeg = toLeg(a, 'short');
  const longLeg = toLeg(b, 'long');

  // --- Boros side ----------------------------------------------------------
  const grossSpreadApr = a.row.midApr - b.row.midApr;
  const shortDepth = depthReason(a, a.short, 'receive-fixed', ctx, notionalUsd);
  const longDepth = depthReason(b, b.long, 'pay-fixed', ctx, notionalUsd);
  if (shortDepth) reasons.push(shortDepth);
  if (longDepth) reasons.push(longDepth);
  const lockable = a.short && b.long && !a.short.insufficient && !b.long.insufficient;
  const execSpreadApr = lockable ? a.short!.apr - b.long!.apr : null;
  const borosImpactApr = execSpreadApr === null ? null : grossSpreadApr - execSpreadApr;

  // --- Perp legs -----------------------------------------------------------
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
        `The ${maker.crossexVenue} ${maker.crossexSymbol} leg rests as a maker order — its fill is not guaranteed and the cost assumes it fills at mid.`,
      );
    } else {
      reasons.push(
        `Maker + hedge needs both legs' fee rates and book depth — the perp cost can't be split between a resting maker order and its taker hedge.`,
      );
    }
  }

  // --- Costs ---------------------------------------------------------------
  const notionalYears = notionalUsd * ctx.yearsToMaturity;
  const borosTakerRate = (m: BorosMarket): number =>
    takerFeeOverride !== undefined && takerFeeOverride >= 0 ? takerFeeOverride : m.takerFeeRate;
  const borosTakerFeeUsd =
    (borosTakerRate(a.market) + borosTakerRate(b.market)) * notionalYears;
  const borosSettleFeeUsd = (a.market.settleFeeApr + b.market.settleFeeApr) * notionalYears;
  const perpParts = [entry.feesUsd, entry.slippageUsd, exit.feesUsd, exit.slippageUsd];
  const totalUsd = perpParts.some((p) => p === null)
    ? null
    : borosTakerFeeUsd + borosSettleFeeUsd + (perpParts as number[]).reduce((s, p) => s + p, 0);
  const annualizedApr = totalUsd === null || !(notionalYears > 0) ? null : totalUsd / notionalYears;
  const netFixedApr =
    execSpreadApr === null || annualizedApr === null ? null : execSpreadApr - annualizedApr;
  const estProfitUsd = netFixedApr === null ? null : netFixedApr * notionalYears;

  // --- Capital -------------------------------------------------------------
  // The minimum the trade must post: Boros IM on each fixed leg at the rate it
  // locks, plus perp IM at each venue's max leverage. Both ways a leg's margin
  // can go unknown — no lockable rate, or no margin coefficient — name the
  // market, so every null capital number has a note that explains it.
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
  const leverageMaxOf = (leg: OpportunityLeg): number | null => {
    if (!leg.crossexSymbol) {
      reasons.push(
        `No confirmed CrossEx listing for ${leg.crossexVenue} ${leg.base} — its leverage cap is auth-gated, so that perp leg's initial margin can't be modelled and the capital and the APR on capital are unknown.`,
      );
      return null;
    }
    const lev = input.leverageMaxBySymbol.get(leg.crossexSymbol);
    if (lev === undefined || !Number.isFinite(lev) || lev <= 0) {
      reasons.push(
        `No max leverage for ${leg.crossexVenue} ${leg.crossexSymbol} — that perp leg's initial margin can't be modelled, so the capital and the APR on capital are unknown.`,
      );
      return null;
    }
    return lev;
  };

  const shortLeverageMax = leverageMaxOf(shortLeg);
  const longLeverageMax = leverageMaxOf(longLeg);
  const capital: OpportunityCapitalBreakdown = {
    borosShortImUsd: borosIm(a, shortLeg.execApr),
    borosLongImUsd: borosIm(b, longLeg.execApr),
    perpShortImUsd: perpInitialMarginUsd(notionalUsd, shortLeverageMax),
    perpLongImUsd: perpInitialMarginUsd(notionalUsd, longLeverageMax),
    shortLeverageMax,
    longLeverageMax,
  };
  const capitalParts = [
    capital.borosShortImUsd,
    capital.borosLongImUsd,
    capital.perpShortImUsd,
    capital.perpLongImUsd,
  ];
  const capitalUsd = capitalParts.some((p) => p === null)
    ? null
    : (capitalParts as number[]).reduce((s, p) => s + p, 0);
  const capitalPriced = capitalUsd !== null && capitalUsd > 0 ? capitalUsd : null;
  // Identically (execSpreadApr × N − totalUsd / T) / capitalUsd — one
  // implementation, expressed through the profit that is already computed.
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

/**
 * The rate a pair's direction is decided on: whichever basis the exec legs will
 * actually be priced at. Under `mark` that is markApr — it can order a group
 * differently from midApr, and ordering on mid there would emit only the losing
 * direction and drop the profitable one entirely.
 */
const directionApr = (build: MarketRowBuild, options: BuildOpportunitiesOptions): number =>
  options.borosEntry === 'mark' ? build.row.markApr : build.row.midApr;

/** Descending sort that always sinks nulls to the bottom. */
const byValueDesc = (x: number | null, y: number | null): number => {
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
};

export function buildOpportunities(
  input: BuildOpportunitiesInput,
  options: BuildOpportunitiesOptions,
): OpportunitiesResult {
  const warnings: string[] = [];
  if (input.feeRows === null) {
    warnings.push(
      "The CrossEx fee schedule is unavailable — perp trading fees are unknown, so net fixed APRs can't be quoted.",
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
    for (const build of builds) {
      if (!build.row.crossexVenue) {
        groupWarnings.push(
          `${build.row.name} trades against ${build.row.venue}, which has no CrossEx perp venue — it can't carry a hedge leg here.`,
        );
      } else if (!build.row.crossexSymbol) {
        groupWarnings.push(
          `No live CrossEx ${build.row.crossexVenue} symbol for ${build.row.base} — ${build.row.name} can't carry a hedge leg here.`,
        );
      }
    }

    const pairs: OpportunityPair[] = [];
    // A mapped venue pairs even without a live CrossEx symbol (Gate down or
    // unconfigured): the Boros spread still prices and the perp-side numbers
    // degrade to null with reasons. Only a venue CrossEx doesn't list at all
    // can never carry a hedge leg, so it never pairs.
    const tradable = builds.filter((x) => x.row.crossexVenue);
    for (let i = 0; i < tradable.length; i += 1) {
      for (let j = 0; j < tradable.length; j += 1) {
        const a = tradable[i];
        const b = tradable[j];
        if (directionApr(a, options) <= directionApr(b, options)) continue;
        if (a.row.crossexVenue === b.row.crossexVenue) continue;
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

  // Groups rank on their own top pair — which `bestPair` only mirrors when its
  // capital is priced, so a group whose capital degraded still sorts on the
  // notional basis rather than falling in with the truly unpriceable ones.
  const topGross = (g: OpportunityGroup): number =>
    g.pairs.length ? Math.max(...g.pairs.map((p) => p.grossSpreadApr)) : -Infinity;
  const top = (g: OpportunityGroup): OpportunityPair | null => g.pairs[0] ?? null;
  groups.sort(
    (x, y) =>
      byValueDesc(
        top(x)?.netFixedAprOnCapital ?? null,
        top(y)?.netFixedAprOnCapital ?? null,
      ) ||
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
    },
    warnings: [...new Set(warnings)],
  };
}
