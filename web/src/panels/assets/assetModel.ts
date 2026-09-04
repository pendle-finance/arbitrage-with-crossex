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

/** `perp:{symbol}` or `boros:{marketId}` → excluded quantity in the leg's own
 * size unit (perp: base coin; Boros: collateral token), or 'all'. */
export type Exclusions = Record<string, number | 'all'>;

export const perpKey = (symbol: string): string => `perp:${symbol}`;
export const borosKey = (marketId: number): string => `boros:${marketId}`;

/** Fraction of the leg that is EXCLUDED (0..1). */
export function excludedFraction(ex: Exclusions, key: string, legQty: number): number {
  const v = ex[key];
  if (v === undefined) return 0;
  if (v === 'all') return 1;
  if (!(legQty > 0) || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(1, v / legQty);
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
  action: 'long-boros' | 'short-boros';
  /** |gap| in `unit`. */
  size: number;
  unit: 'base' | 'usd';
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
): AssetDerived {
  const unit = sizeUnitForBase(group.base);

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
      gaps.push({
        venue: v.venue,
        action: v.gap > 0 ? 'long-boros' : 'short-boros',
        size: Math.abs(v.gap),
        unit,
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
    const keep = 1 - excludedFraction(exclusions, perpKey(l.symbol), l.qty);
    if (keep <= 0) continue;
    perpUpnlUsd += l.upnlUsd * keep;
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
  let anyLocked = false;
  for (const l of group.borosOpen) {
    const keep = 1 - excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken);
    if (keep <= 0 || !coveredVenues.has(l.venue)) continue;
    if (!(l.maturity > nowSec)) continue;
    anyLocked = true;
    const perYear = (l.side === 'SHORT' ? 1 : -1) * l.entryApr * l.notionalUsd * keep;
    lockedCarryPerYearUsd += perYear;
    lockedToMaturityUsd += (perYear * (l.maturity - nowSec)) / SECONDS_IN_YEAR;
  }
  const lockedOk = anyLocked && deltaNeutral;
  const lockedAprFwd =
    lockedOk && capitalUsd >= MIN_APR_CAPITAL_USD ? lockedCarryPerYearUsd / capitalUsd : null;

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
  };
}
