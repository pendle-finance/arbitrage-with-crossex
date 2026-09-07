/**
 * The asset-view derivation: pure functions from the server's per-asset
 * groups (+ the user's exclusions) to what the cards render — hedge gaps,
 * PnL/capital totals, and an approximate APR.
 *
 * The model deliberately has NO stored state beyond exclusions and a start
 * date: everything is a pure function of the venue-reported feed, so the same
 * inputs render the same numbers on any device.
 *
 * Unit rule (single source: lib/boros.ts sizeUnitForBase): a coin-margined
 * Boros market (ETH/BTC) hedges a coin QUANTITY, so those assets compare
 * per-venue sizes in the base coin; USD-collateral markets denominate their
 * YU size in dollars, so those compare USD notionals.
 *
 * Direction rule: a LONG perp pays the floating funding rate, and a LONG
 * Boros YU (pays fixed, receives floating) cancels exactly that — so a
 * perfect hedge has, per venue, signed Boros size equal to signed perp size.
 */
import type {
  AssetBorosOpen,
  AssetGroup,
  AssetPerpClosed,
  AssetPerpOpen,
  VenueFees,
} from '../../api/types';
import { sizeUnitForBase } from '../../lib/boros';

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** |net|/gross under this is "hedged" — mirrors the exposure feed's 2%. */
export const HEDGE_TOLERANCE = 0.02;

/** Boros coverage that lapses within this window gets an expiry warning. */
export const EXPIRY_WARN_SEC = 14 * 24 * 3600;

/** No APR below this capital: annualizing dust yields three-digit noise
 * percentages (−587% on $4.41 of margin) that read as alarms. */
export const MIN_APR_CAPITAL_USD = 100;

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/** One leg's exclusion — the slice of it that is NOT part of the farm.
 * `qty` is in the leg's own size unit (perp: base coin; Boros: collateral
 * token). `at` is the price (perp, USD) or fixed rate (Boros, APR fraction)
 * that slice was put on at; when given, the REMAINDER's entry is re-derived as
 * the weighted residual, so excluding 300 ETH bought at $2,600 out of a
 * 1,000 ETH $2,489 leg leaves 700 ETH at $2,441 — not 700 ETH at $2,489.
 * A bare number is the legacy shape (qty only, pro-rata). */
export interface ExclusionSlice {
  qty: number;
  at?: number;
}
export type ExclusionEntry = number | ExclusionSlice | 'all';
/** `perp:{symbol}` or `boros:{marketId}` → that leg's exclusion. */
export type Exclusions = Record<string, ExclusionEntry>;

/** The excluded quantity of an entry, or null for 'all'/absent/invalid. */
export function exclusionQty(v: ExclusionEntry | undefined): number | null {
  if (v === undefined || v === 'all') return null;
  const q = typeof v === 'number' ? v : v.qty;
  return Number.isFinite(q) && q > 0 ? q : null;
}
/** The price/rate the excluded slice was carved out at, if one was given. */
export function exclusionAt(v: ExclusionEntry | undefined): number | null {
  if (v === undefined || v === 'all' || typeof v === 'number') return null;
  return v.at !== undefined && Number.isFinite(v.at) ? v.at : null;
}

/** A perp opened this long before its Boros leg was not opened FOR the hedge,
 * so its entry fees are not this pair's cost by default. */
export const PERP_PREDATES_HEDGE_SEC = 3 * 86_400;

/** Default for the pair popup's "perp fees paid" switch: on, unless the perp
 * side went on more than three days before the Boros side. Unknown opens
 * leave it on — a fee shown and dismissable beats one silently dropped. */
export function defaultChargePerpFees(pair: {
  perpOpenedSec: number | null;
  borosOpenedSec: number | null;
}): boolean {
  if (pair.perpOpenedSec === null || pair.borosOpenedSec === null) return true;
  return pair.perpOpenedSec >= pair.borosOpenedSec - PERP_PREDATES_HEDGE_SEC;
}

export const perpKey = (symbol: string): string => `perp:${symbol}`;
export const borosKey = (marketId: number): string => `boros:${marketId}`;

/** Fraction of the leg that is EXCLUDED (0..1). */
export function excludedFraction(ex: Exclusions, key: string, legQty: number): number {
  const v = ex[key];
  if (v === undefined) return 0;
  if (v === 'all') return 1;
  const q = exclusionQty(v);
  if (!(legQty > 0) || q === null) return 0;
  return Math.min(1, q / legQty);
}

/**
 * What remains of a leg after its exclusion: the kept fraction and the entry
 * (price or rate) of that remainder. With a slice price the remainder's entry
 * is the weighted residual `(entry − f·at) / (1 − f)`; without one the slice
 * is pro-rata and the entry is unchanged.
 */
export function keptSlice(
  ex: Exclusions,
  key: string,
  legQty: number,
  entry: number,
): { keep: number; entry: number; at: number | null } {
  const f = excludedFraction(ex, key, legQty);
  const keep = 1 - f;
  const at = exclusionAt(ex[key]);
  if (keep <= 0 || at === null || f <= 0) return { keep, entry, at };
  return { keep, entry: (entry - f * at) / keep, at };
}

// ---------------------------------------------------------------------------
// Derived shapes
// ---------------------------------------------------------------------------

export interface VenueHedge {
  venue: string;
  unit: 'base' | 'usd';
  /** Signed perp size after exclusions (LONG positive), in `unit`. */
  perpSigned: number;
  /** Signed Boros size after exclusions (LONG positive), in `unit`. */
  borosSigned: number;
  /** perpSigned − borosSigned: what is left UNHEDGED. Positive → the floating
   * leg needs more LONG YU; negative → more SHORT YU (or less perp). */
  gap: number;
  covered: boolean;
  /** Soonest maturity among this venue's Boros legs (0 = none). */
  soonestMaturity: number;
  /** Set when covered but the covering legs start maturing inside the warn
   * window — the hedge is fine today and lapses on this date. */
  expiresSoon: boolean;
}

export interface HedgeGapRow {
  venue: string;
  /** What to ADD to make the venue whole. */
  action: 'long-boros' | 'short-boros' | 'long-perp' | 'short-perp';
  /** |gap| in `unit`. */
  size: number;
  unit: 'base' | 'usd';
  /** The flag always sits on the side that is SHORT of the other, never on
   * the surplus: `missing` = that side has no leg at all on this venue,
   * `deficit` = it exists but is smaller than its partner by `size`. */
  kind: 'missing' | 'deficit';
  /** Which leg is short: the floating perp or the fixed Boros side. */
  leg: 'perp' | 'boros';
  /** Where the short side should end up (its partner's size), in `unit`. */
  want: number;
}

export interface AssetTotals {
  /** Headline: open perp (upnl + funding − fees) + closed perp
   * (closedPnl + funding − fees) + Boros history (settle + trade PnL).
   * Boros MtM deliberately excluded (see mtmUsd). */
  pnlUsd: number;
  /**
   * THE DRIVER — what the farm exists to harvest: perp funding (open +
   * closed) + Boros settlement PnL (net). The card leads with this.
   */
  carryUsd: number;
  /** Perp funding across open AND closed positions. */
  perpFundingAllUsd: number;
  /** Perp trading fees across open AND closed positions (positive cost). */
  perpFeesAllUsd: number;
  /** Boros fees: settlement + trade (positive cost; display — the settle
   * and trade PnL figures are already net of them). */
  borosFeesAllUsd: number;
  /**
   * The PRICE PACKAGE: open perp uPnL + closed positions' realized price
   * PnL. On a delta-neutral book the user expects this ≈ 0 — surfacing it
   * as one number makes the expectation checkable at a glance.
   */
  priceResidualUsd: number;
  /**
   * CARRY, GROSS — every dollar the farm paid out before any fee: perp
   * funding (open + closed) + Boros settlement AND trade PnL with their
   * fees added back. The card's first ledger.
   */
  carryGrossUsd: number;
  /**
   * COST — everything that eats into the carry, whenever it was paid: perp
   * fees + Boros fees − price basis (a positive price basis reduces cost).
   * Split by KIND, never by open/closed, so nothing changes bucket on the
   * day a leg matures. `pnlUsd === carryGrossUsd − costUsd` by algebra.
   */
  costUsd: number;
  /** Σ current initial margin across both sides, after exclusions. */
  capitalUsd: number;
  /** Mark value of the open Boros rate streams — info, not in pnlUsd. */
  mtmUsd: number;
  breakdown: {
    perpUpnlUsd: number;
    perpFundingUsd: number;
    perpFeesUsd: number;
    perpClosedPnlUsd: number;
    /** Net of settle fees (venue reports net). */
    borosSettleUsd: number;
    borosSettleFeeUsd: number;
    /** Net of trade fees. */
    borosTradePnlUsd: number;
    borosTradeFeeUsd: number;
  };
}

/** One leg of a pair estimate, with its attributed share of the venue
 * leg's windowed carry and paid fees — the popup reconstructs the pair
 * from these rows. */
export interface PairLegDetail {
  venue: string;
  kind: 'perp' | 'yu';
  side: 'LONG' | 'SHORT';
  /** Fraction of the venue leg attributed to this pair (1, or the
   * proportional share of the single short side). */
  share: number;
  /** Attributed size in the asset's unit. */
  size: number;
  /** YU: the fixed rate this leg locks, signed by side (SHORT receives +,
   * LONG pays −). Perps: null (their floating side is what the YU swaps). */
  lockedApr: number | null;
  /** Paid fees attributed to this pair (perp trading fees / Boros
   * settle+trade fees). */
  feesUsd: number;
  /** YU only: maturity (0 for perps). */
  maturity: number;
  /** Perp only: the exact CrossEx symbol — the join key to the live position
   * (and what a close order names). */
  symbol?: string;
  /** YU only: the Boros market id (what a close order names). */
  marketId?: number;
  /** Margin this slice ties up TODAY (venue-reported, pro-rata). */
  imUsd: number;
  /** YU only: the margin at open, ESTIMATED — Boros margin decays toward
   * maturity and the venue reports only today's requirement, so this scales
   * it back over the leg's life assuming the requirement is linear in time
   * to maturity. null for perps (their margin does not decay) and when the
   * leg's start is unknown. */
  imAtOpenUsd: number | null;
}

/**
 * A ROUGH 4-leg sub-strategy: one LONG perp venue paired against a
 * proportional slice of the SHORT side, with each venue's Boros legs
 * attached the same way. Explicitly an estimate ("no arrangement
 * necessary, just take some average and proportionally form the legs —
 * just for reference"): shares are by size, windows by the asset's date.
 */
export interface PairEstimate {
  /** LONG perp venue / SHORT perp venue. */
  longVenue: string;
  shortVenue: string;
  /** Paired size in the asset's unit. */
  size: number;
  unit: 'base' | 'usd';
  notionalUsd: number;
  capitalUsd: number;
  /** Forward locked APR of this pair's Boros slices (no fees). */
  lockedAprFwd: number | null;
  /** Estimated cost of closing BOTH perp legs once at taker — from the
   * account's own per-venue fee schedule (VIP tier, per-symbol overrides)
   * when available, else a flat 4.5bp fallback. The Boros legs mature on
   * their own and never pay an exit. */
  exitFeeUsd: number;
  /** When the pair was FIRST FULLY HEDGED: the latest of its legs' start
   * times (perp open time; Boros first settlement/trade). Fee drags
   * amortize over hedgedSince → soonest maturity — the position's full
   * hedged life, not the remaining days. Null when no leg start is known. */
  hedgedSinceSec: number | null;
  /** The LATER of the two perp legs' open times; null when unknown. */
  perpOpenedSec: number | null;
  /** The EARLIEST first settlement/trade among the pair's Boros legs — the
   * hourly-granular proxy for when the rate side went on; null if unknown. */
  borosOpenedSec: number | null;
  /** Soonest Boros maturity among the pair's live YU legs (0 = none). */
  soonestMaturitySec: number;
  /** Per-leg reconstruction: locked rates and paid fees per attributed
   * slice — what the pair popup renders. Dollar carry is deliberately
   * absent: windowed funding mixes eras already settled by completed
   * Boros legs, so only rates and fees are honest per pair. */
  legs: PairLegDetail[];
  /** Paid fees, split: perp trading fees (avoidable in a what-if — a
   * different entry could have paid less) vs Boros settle+trade fees
   * (structural: the Boros side is never exited, so never excludable). */
  perpFeesPaidUsd: number;
  borosFeesPaidUsd: number;
}

export interface AssetDerived {
  base: string;
  priceUsd: number;
  totals: AssetTotals;
  venues: VenueHedge[];
  gaps: HedgeGapRow[];
  /** Net perp delta across venues, in the asset's unit (signed, LONG +). */
  netPerp: number;
  grossPerp: number;
  /** |netPerp|/grossPerp ≤ 2% (true when no perps at all). */
  deltaNeutral: boolean;
  /** Every venue's floating leg covered AND delta-neutral. */
  perfect: boolean;
  /** The APR clock start: max(user since, the asset's earliest activity). */
  clockStartSec: number | null;
  /** pnl / capital, annualized over the clock — null when it cannot be
   * computed honestly (no capital, no clock, or a sub-hour window). */
  aprEst: number | null;
  /** Plain pnl / capital — no annualization games. Null under MIN capital. */
  roi: number | null;
  /**
   * FORWARD locked carry — the deterministic part of the future. On a
   * covered venue the floating sides cancel, so what remains is the fixed
   * side each Boros leg locked: SHORT YU receives its entry APR, LONG pays
   * it. Summed over open Boros legs on COVERED venues only (an uncovered
   * or non-neutral book isn't deterministic — null there).
   */
  lockedCarryPerYearUsd: number | null;
  /** lockedCarryPerYearUsd / capital — "the APR this position earns right
   * now", knowable the moment the hedge is complete. */
  lockedAprFwd: number | null;
  /** Each covered Boros leg's fixed carry accrued to ITS maturity — the
   * farm's deterministic future PnL from now. */
  lockedToMaturityUsd: number | null;
  /** Σ |notional| of the legs behind lockedCarryPerYearUsd — so the locked
   * rate can also be quoted ON NOTIONAL (the cross-farm comparison basis),
   * not only on margin. */
  lockedNotionalUsd: number | null;
  /** Rough per-pair decomposition (see PairEstimate). Empty when the book
   * has no long/short perp pairing to decompose. */
  pairs: PairEstimate[];
}

// ---------------------------------------------------------------------------

const signedPerp = (l: AssetPerpOpen, unit: 'base' | 'usd', keep: number): number => {
  const size = unit === 'base' ? l.qty : l.notionalUsd;
  return (l.side === 'LONG' ? size : -size) * keep;
};

const signedBoros = (l: AssetBorosOpen, unit: 'base' | 'usd', keep: number): number => {
  // Coin-margined markets size YU in the coin; USD-margined in dollars — the
  // same rule picks the asset's unit, so this is the matching reading.
  const size = unit === 'base' ? l.sizeToken : l.notionalUsd;
  return (l.side === 'LONG' ? size : -size) * keep;
};

export function deriveAsset(
  group: AssetGroup,
  exclusions: Exclusions,
  sinceSec: number,
  nowSec: number,
  /** The account's own CrossEx fee schedule (VIP tier + per-symbol
   * overrides) — prices the pairs' exit-fee estimate; flat fallback
   * when absent. */
  feeRows?: readonly VenueFees[],
): AssetDerived {
  const unit = sizeUnitForBase(group.base);
  /** Taker rate for a perp symbol from the account's schedule, or null. */
  const takerOf = (symbol: string): number | null => {
    const sym = symbol.toUpperCase();
    const ex = sym.split('_')[0] ?? '';
    const row = (feeRows ?? []).find((r) => (r.exchangeType ?? '').toUpperCase() === ex);
    if (!row) return null;
    const special = (row.specialFeeList ?? []).find((s) => s.symbol.toUpperCase() === sym);
    const rate = Number(special ? special.takerFeeRate : row.futureTakerFee);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  };

  /**
   * A market that MATURED before the window start is economically dead for
   * this window: it can neither settle nor hedge inside it. Its still-open
   * on-chain leg must not show, hedge, or tie up "capital" here — same
   * doctrine as history windowing, applied to the open side.
   */
  const borosOpenWindowed =
    sinceSec > 0 ? group.borosOpen.filter((l) => l.maturity >= sinceSec) : group.borosOpen;
  group = { ...group, borosOpen: borosOpenWindowed };

  // --- Per-venue hedge state ---------------------------------------------
  const byVenue = new Map<string, VenueHedge>();
  const venueFor = (venue: string): VenueHedge => {
    let v = byVenue.get(venue);
    if (!v) {
      v = {
        venue,
        unit,
        perpSigned: 0,
        borosSigned: 0,
        gap: 0,
        covered: false,
        soonestMaturity: 0,
        expiresSoon: false,
      };
      byVenue.set(venue, v);
    }
    return v;
  };

  for (const l of group.perpOpen) {
    const keep = 1 - excludedFraction(exclusions, perpKey(l.symbol), l.qty);
    if (keep <= 0) continue;
    venueFor(l.venue).perpSigned += signedPerp(l, unit, keep);
  }
  for (const l of group.borosOpen) {
    const keep = 1 - excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken);
    if (keep <= 0) continue;
    const v = venueFor(l.venue);
    v.borosSigned += signedBoros(l, unit, keep);
    if (v.soonestMaturity === 0 || l.maturity < v.soonestMaturity) {
      v.soonestMaturity = l.maturity;
    }
  }

  const gaps: HedgeGapRow[] = [];
  for (const v of byVenue.values()) {
    v.gap = v.perpSigned - v.borosSigned;
    const scale = Math.max(Math.abs(v.perpSigned), Math.abs(v.borosSigned));
    v.covered = scale === 0 || Math.abs(v.gap) <= scale * HEDGE_TOLERANCE;
    v.expiresSoon =
      v.covered &&
      v.soonestMaturity > 0 &&
      v.borosSigned !== 0 &&
      v.soonestMaturity - nowSec < EXPIRY_WARN_SEC;
    if (!v.covered) {
      // The side to flag is the SMALLER one — the trader is told what to
      // add, never what is in surplus. A Boros leg pointing the wrong way
      // (signs differ) counts as a Boros deficit of the whole distance.
      const p = Math.abs(v.perpSigned);
      const b = Math.abs(v.borosSigned);
      const sameWay = v.perpSigned * v.borosSigned > 0;
      const leg: 'perp' | 'boros' = p === 0 ? 'perp' : b === 0 || !sameWay || b < p ? 'boros' : 'perp';
      const kind: 'missing' | 'deficit' = (leg === 'perp' ? p : b) === 0 ? 'missing' : 'deficit';
      // Direction of what to add: the Boros side follows the perp's sign
      // (a long perp is hedged by a long YU); the perp follows the YU's.
      const dir = leg === 'boros' ? v.perpSigned > 0 : v.borosSigned > 0;
      gaps.push({
        venue: v.venue,
        action: leg === 'boros' ? (dir ? 'long-boros' : 'short-boros') : dir ? 'long-perp' : 'short-perp',
        size: Math.abs(v.gap),
        unit,
        kind,
        leg,
        want: leg === 'boros' ? p : b,
      });
    }
  }
  const venues = [...byVenue.values()].sort(
    (a, b) => Math.abs(b.perpSigned) - Math.abs(a.perpSigned) || a.venue.localeCompare(b.venue),
  );

  const netPerp = venues.reduce((s, v) => s + v.perpSigned, 0);
  const grossPerp = venues.reduce((s, v) => s + Math.abs(v.perpSigned), 0);
  const deltaNeutral = grossPerp === 0 || Math.abs(netPerp) / grossPerp <= HEDGE_TOLERANCE;

  // --- Totals -------------------------------------------------------------
  let perpUpnlUsd = 0;
  let perpFundingUsd = 0;
  let perpFeesUsd = 0;
  let capitalUsd = 0;
  let mtmUsd = 0;
  for (const l of group.perpOpen) {
    const { keep, at } = keptSlice(exclusions, perpKey(l.symbol), l.qty, l.entryPrice);
    if (keep <= 0) continue;
    // A slice carved out at its own price hands back exactly ITS
    // mark-to-market, not a pro-rata share of the venue's blended figure.
    perpUpnlUsd +=
      at !== null && l.markPrice > 0
        ? l.upnlUsd - (l.side === 'LONG' ? 1 : -1) * (1 - keep) * l.qty * (l.markPrice - at)
        : l.upnlUsd * keep;
    perpFundingUsd += l.fundingUsd * keep;
    perpFeesUsd += l.feesUsd * keep;
    capitalUsd += l.imUsd * keep;
  }
  // Closed rows and history sums cannot be split pro-rata (nothing attributes
  // a fraction of a finished position), so only a FULL exclusion of the same
  // symbol/market drops them.
  const closedCounted = (r: AssetPerpClosed): boolean => exclusions[perpKey(r.symbol)] !== 'all';
  let perpClosedPnlUsd = 0;
  let closedPriceUsd = 0;
  let closedFundingUsd = 0;
  let closedFeesUsd = 0;
  for (const r of group.perpClosed) {
    if (!closedCounted(r)) continue;
    perpClosedPnlUsd += r.closedPnlUsd + r.fundingUsd - r.feesUsd;
    closedPriceUsd += r.closedPnlUsd;
    closedFundingUsd += r.fundingUsd;
    closedFeesUsd += r.feesUsd;
  }
  let borosSettleUsd = 0;
  let borosSettleFeeUsd = 0;
  let borosTradePnlUsd = 0;
  let borosTradeFeeUsd = 0;
  for (const h of group.borosHistory) {
    if (exclusions[borosKey(h.marketId)] === 'all') continue;
    borosSettleUsd += h.settleUsd;
    borosSettleFeeUsd += h.settleFeeUsd;
    borosTradePnlUsd += h.tradePnlUsd;
    borosTradeFeeUsd += h.tradeFeeUsd;
  }
  for (const l of group.borosOpen) {
    const keep = 1 - excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken);
    if (keep <= 0) continue;
    capitalUsd += l.imUsd * keep;
    mtmUsd += l.mtmUsd * keep;
  }

  const pnlUsd =
    perpUpnlUsd + perpFundingUsd - perpFeesUsd + perpClosedPnlUsd + borosSettleUsd + borosTradePnlUsd;
  // The same sum, regrouped the way a trader reads it (identical by algebra).
  const perpFundingAllUsd = perpFundingUsd + closedFundingUsd;
  const perpFeesAllUsd = perpFeesUsd + closedFeesUsd;
  const priceResidualUsd = perpUpnlUsd + closedPriceUsd;
  const carryUsd = perpFundingAllUsd + borosSettleUsd;
  const carryGrossUsd =
    perpFundingAllUsd + borosSettleUsd + borosSettleFeeUsd + borosTradePnlUsd + borosTradeFeeUsd;
  const costUsd = perpFeesAllUsd + borosSettleFeeUsd + borosTradeFeeUsd - priceResidualUsd;

  // --- APR ----------------------------------------------------------------
  const clockStartSec =
    group.earliestSec !== null ? Math.max(sinceSec, group.earliestSec) : sinceSec > 0 ? sinceSec : null;
  const elapsedSec = clockStartSec !== null ? nowSec - clockStartSec : 0;
  const aprEst =
    clockStartSec !== null && elapsedSec > 3600 && capitalUsd >= MIN_APR_CAPITAL_USD
      ? pnlUsd / capitalUsd / (elapsedSec / SECONDS_IN_YEAR)
      : null;
  const roi = capitalUsd >= MIN_APR_CAPITAL_USD ? pnlUsd / capitalUsd : null;

  // Forward locked numbers — deterministic only where the hedge holds.
  const coveredVenues = new Set([...byVenue.values()].filter((v) => v.covered).map((v) => v.venue));
  let lockedCarryPerYearUsd = 0;
  let lockedToMaturityUsd = 0;
  let lockedNotionalUsd = 0;
  let anyLocked = false;
  for (const l of group.borosOpen) {
    const { keep, entry: entryApr } = keptSlice(
      exclusions,
      borosKey(l.marketId),
      l.sizeToken,
      l.entryApr,
    );
    if (keep <= 0 || !coveredVenues.has(l.venue)) continue;
    if (!(l.maturity > nowSec)) continue;
    anyLocked = true;
    const perYear = (l.side === 'SHORT' ? 1 : -1) * entryApr * l.notionalUsd * keep;
    lockedCarryPerYearUsd += perYear;
    lockedToMaturityUsd += (perYear * (l.maturity - nowSec)) / SECONDS_IN_YEAR;
    lockedNotionalUsd += l.notionalUsd * keep;
  }
  // "Locked" means the whole book is: a venue with a missing or short leg
  // has no deterministic carry to quote, however good the covered half.
  const lockedOk = anyLocked && deltaNeutral && gaps.length === 0;
  const lockedAprFwd =
    lockedOk && capitalUsd >= MIN_APR_CAPITAL_USD ? lockedCarryPerYearUsd / capitalUsd : null;

  /**
   * PAIR ESTIMATES — decompose the book into long-venue⇄short-venue
   * 4-leg sub-strategies, proportionally. Each LONG perp venue takes a
   * size-proportional slice of the whole SHORT side (and of the short
   * venues' Boros legs); its own venue's Boros legs ride along whole.
   */
  const keepOf = (l: AssetPerpOpen) => 1 - excludedFraction(exclusions, perpKey(l.symbol), l.qty);
  const borosKeepOf = (l: AssetBorosOpen) =>
    1 - excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken);
  const longs = group.perpOpen.filter((l) => l.side === 'LONG' && keepOf(l) > 0);
  const shorts = group.perpOpen.filter((l) => l.side === 'SHORT' && keepOf(l) > 0);
  const legSize = (l: AssetPerpOpen) => (unit === 'base' ? l.qty : l.notionalUsd) * keepOf(l);
  const longTotal = longs.reduce((t, l) => t + legSize(l), 0);
  const shortTotal = shorts.reduce((t, l) => t + legSize(l), 0);
  const pairs: PairEstimate[] = [];
  /**
   * Every long × short combination, sized L·S / max(ΣL, ΣS): each long is
   * spread over the shorts in proportion and vice versa, no leg is ever
   * over-allocated, and with one short and a balanced book it collapses to
   * "each long pairs with its slice of the short" exactly as before. A
   * book with two SHORT venues used to produce no pairs at all.
   */
  const pool = Math.max(longTotal, shortTotal);
  if (longs.length > 0 && shorts.length > 0 && pool > 0) {
    const histByMarket = new Map(group.borosHistory.map((h) => [h.marketId, h]));
    for (const lLeg of longs)
    for (const sLeg of shorts) {
      const lKeep = keepOf(lLeg);
      const sKeep = keepOf(sLeg);
      const lSize = legSize(lLeg);
      const sSize = legSize(sLeg);
      const size = (lSize * sSize) / pool;
      const lShare = size / lSize; // slice of the long leg
      const share = size / sSize; // slice of the short leg
      const longBoros = group.borosOpen.filter((b) => b.venue === lLeg.venue && borosKeepOf(b) > 0);
      const shortBoros = group.borosOpen.filter((b) => b.venue === sLeg.venue && borosKeepOf(b) > 0);
      let cap = lLeg.imUsd * lKeep * lShare + sLeg.imUsd * sKeep * share;
      let perYear = 0;
      let soonest = 0;
      const legs: PairLegDetail[] = [
        {
          venue: lLeg.venue,
          kind: 'perp',
          side: 'LONG',
          share: lShare,
          size,
          lockedApr: null,
          feesUsd: lLeg.feesUsd * lKeep * lShare,
          symbol: lLeg.symbol,
          maturity: 0,
          imUsd: lLeg.imUsd * lKeep * lShare,
          imAtOpenUsd: null,
        },
        {
          venue: sLeg.venue,
          kind: 'perp',
          side: 'SHORT',
          share,
          size: (unit === 'base' ? sLeg.qty : sLeg.notionalUsd) * sKeep * share,
          lockedApr: null,
          feesUsd: sLeg.feesUsd * sKeep * share,
          symbol: sLeg.symbol,
          maturity: 0,
          imUsd: sLeg.imUsd * sKeep * share,
          imAtOpenUsd: null,
        },
      ];
      // "First fully hedged" = the LATEST leg start: the hedge only exists
      // once every leg is in place. Perps carry their open time; a Boros
      // leg's first settlement/trade stands in for its open (hourly, so at
      // most an hour late). Legs with no known start are skipped.
      let hedgedSince = 0;
      const legStart = (t: number | null | undefined) => {
        if (t && t > hedgedSince) hedgedSince = t;
      };
      legStart(lLeg.openedAt);
      legStart(sLeg.openedAt);
      const perpOpened = Math.max(lLeg.openedAt ?? 0, sLeg.openedAt ?? 0);
      let borosOpened = Number.POSITIVE_INFINITY;
      let borosFeesPaidUsd = 0;
      const addBoros = (b: AssetBorosOpen, frac: number) => {
        const slice = keptSlice(exclusions, borosKey(b.marketId), b.sizeToken, b.entryApr);
        const keep = slice.keep * frac;
        const entryApr = slice.entry;
        cap += b.imUsd * keep;
        if (b.maturity > nowSec) {
          perYear += (b.side === 'SHORT' ? 1 : -1) * entryApr * b.notionalUsd * keep;
          if (soonest === 0 || b.maturity < soonest) soonest = b.maturity;
        }
        const h = histByMarket.get(b.marketId);
        const fees = h ? (h.settleFeeUsd + h.tradeFeeUsd) * keep : 0;
        borosFeesPaidUsd += fees;
        legStart(h?.firstEventSec);
        if (h?.firstEventSec) borosOpened = Math.min(borosOpened, h.firstEventSec);
        legs.push({
          venue: b.venue,
          kind: 'yu',
          side: b.side,
          share: frac,
          size: (unit === 'base' ? b.sizeToken : b.notionalUsd) * keep,
          lockedApr: (b.side === 'SHORT' ? 1 : -1) * entryApr,
          feesUsd: fees,
          maturity: b.maturity,
          marketId: b.marketId,
          imUsd: b.imUsd * keep,
          imAtOpenUsd:
            h?.firstEventSec && b.maturity > nowSec && b.maturity > h.firstEventSec
              ? (b.imUsd * keep * (b.maturity - h.firstEventSec)) / (b.maturity - nowSec)
              : null,
        });
      };
      for (const b of longBoros) addBoros(b, lShare);
      for (const b of shortBoros) addBoros(b, share);
      const notionalUsd = lLeg.notionalUsd * lKeep * lShare + sLeg.notionalUsd * sKeep * share;
      // Exit cost: both perp legs crossed once at taker — the account's own
      // per-venue schedule when known, a flat 4.5bp otherwise.
      const FALLBACK_TAKER_RATE = 0.00045;
      const exitFeeUsd =
        lLeg.notionalUsd * lKeep * lShare * (takerOf(lLeg.symbol) ?? FALLBACK_TAKER_RATE) +
        sLeg.notionalUsd * sKeep * share * (takerOf(sLeg.symbol) ?? FALLBACK_TAKER_RATE);
      // A 4-leg arbitrage needs all four: a perp AND a YU at each venue.
      // Two perps with a YU on one side only are a hedge in progress, and
      // quoting them as a "pair" would lend a locked rate to a book that has
      // none yet — the missing-leg rows already say what to open.
      if (longBoros.length === 0 || shortBoros.length === 0) continue;
      pairs.push({
        longVenue: lLeg.venue,
        shortVenue: sLeg.venue,
        size,
        unit,
        notionalUsd,
        capitalUsd: cap,
        lockedAprFwd: cap >= MIN_APR_CAPITAL_USD && perYear !== 0 ? perYear / cap : null,
        exitFeeUsd,
        hedgedSinceSec: hedgedSince > 0 && hedgedSince < nowSec ? hedgedSince : null,
        perpOpenedSec: perpOpened > 0 ? perpOpened : null,
        borosOpenedSec: Number.isFinite(borosOpened) ? borosOpened : null,
        soonestMaturitySec: soonest,
        legs,
        perpFeesPaidUsd: lLeg.feesUsd * lKeep * lShare + sLeg.feesUsd * sKeep * share,
        borosFeesPaidUsd,
      });
    }
    pairs.sort((a, b) => b.notionalUsd - a.notionalUsd);
  }

  return {
    base: group.base,
    priceUsd: group.priceUsd,
    totals: {
      pnlUsd,
      carryUsd,
      perpFundingAllUsd,
      perpFeesAllUsd,
      borosFeesAllUsd: borosSettleFeeUsd + borosTradeFeeUsd,
      priceResidualUsd,
      carryGrossUsd,
      costUsd,
      capitalUsd,
      mtmUsd,
      breakdown: {
        perpUpnlUsd,
        perpFundingUsd,
        perpFeesUsd,
        perpClosedPnlUsd,
        borosSettleUsd,
        borosSettleFeeUsd,
        borosTradePnlUsd,
        borosTradeFeeUsd,
      },
    },
    venues,
    gaps,
    netPerp,
    grossPerp,
    deltaNeutral,
    perfect: deltaNeutral && gaps.length === 0,
    clockStartSec,
    aprEst,
    roi,
    lockedCarryPerYearUsd: lockedOk ? lockedCarryPerYearUsd : null,
    lockedAprFwd,
    lockedToMaturityUsd: lockedOk ? lockedToMaturityUsd : null,
    lockedNotionalUsd: lockedOk && lockedNotionalUsd > 0 ? lockedNotionalUsd : null,
    pairs,
  };
}
