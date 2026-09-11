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
  AssetBorosHistory,
  AssetBorosOpen,
  AssetGroup,
  AssetPerpClosed,
  AssetPerpOpen,
  StrategyLeg,
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

// ---------------------------------------------------------------------------
// Closing from a pair row — what the close forms are handed
// ---------------------------------------------------------------------------

/** A perp leg to close, exactly as ClosePairForm takes it. */
export interface PerpCloseLeg {
  symbol: string;
  /** Base-coin quantity — the reduce-only order's size. */
  qty: number;
  venue: string;
  /** True when the pair holds only a slice of the venue position. */
  partial: boolean;
}

/** The perp legs of a pair, sized to close THIS pair's share: one order per
 * symbol, in the coin, whatever unit the asset displays in. */
export function pairPerpCloseLegs(pair: Pick<PairEstimate, 'legs'>): PerpCloseLeg[] {
  return pair.legs
    .filter((l) => l.kind === 'perp' && l.symbol !== undefined)
    .map((l) => ({ symbol: l.symbol as string, qty: l.sizeToken, venue: l.venue, partial: l.share < 0.9995 }));
}

/** The Boros legs of a pair as the close form's StrategyLeg rows: the
 * pair's attributed slice (a shared leg closes only its share), in the
 * collateral token, with the venue leg's own rates and maturity. A market
 * the account no longer lists is skipped — there is nothing to close. */
export function pairBorosCloseLegs(pair: Pick<PairEstimate, 'legs'>, group: Pick<AssetGroup, 'base' | 'borosOpen'>): StrategyLeg[] {
  return pair.legs
    .filter((l) => l.kind === 'yu' && l.marketId !== undefined)
    .flatMap((l): StrategyLeg[] => {
      const b = group.borosOpen.find((x) => x.marketId === l.marketId);
      if (!b) return [];
      return [
        {
          kind: 'boros',
          venue: b.venue,
          base: group.base,
          side: b.side,
          notionalUsd: l.notionalUsd,
          collateral: b.collateral,
          notionalToken: l.sizeToken,
          marketId: b.marketId,
          entryApr: b.entryApr,
          markApr: b.markApr,
          maturity: b.maturity,
          share: l.share,
          cashFlowUsd: 0,
          mtmUsd: 0,
          tradePnlUsd: 0,
          feesUsd: 0,
          netUsd: 0,
          openedAt: null,
          warnings: [],
        },
      ];
    });
}

/** A leg's size in the unit a card displays: coin quantity or dollars. */
export const sizeIn = (l: { sizeBase: number; notionalUsd: number }, unit: 'base' | 'usd'): number =>
  unit === 'base' ? l.sizeBase : l.notionalUsd;

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
  /** |gap| in `unit` — the reading the hedge is judged in. */
  size: number;
  unit: 'base' | 'usd';
  /** The same gap as a coin quantity and in dollars (converted at the
   * asset's price), so the ticket is armed from a number that says what
   * it is. */
  sizeBase: number;
  notionalUsd: number;
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
  /** Attributed size in the leg's OWN token — what a close order is sized
   * in: a perp's base-coin quantity, a YU leg's collateral-token size (USDT
   * on a USDT-margined market). Never "in the asset's unit": a number that
   * means coins or dollars depending on a sibling field is how a close order
   * gets sent in the wrong unit. */
  sizeToken: number;
  /** The same slice as a quantity of the asset's COIN (a USDT-margined YU
   * leg converts through its notional at the coin's price). */
  sizeBase: number;
  /** The same slice in dollars. Display picks coin or dollars via `sizeIn`. */
  notionalUsd: number;
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
  /**
   * The ONE maturity this pair settles at. A 4-leg arbitrage is a fixed-term
   * unit: two perps hedging two YU legs that mature together. A venue
   * pairing laddered across terms is several such units, listed separately,
   * not one blended row. (Kept named `soonest…` because every consumer reads
   * it as "when this pair ends", which is now exact rather than the minimum.)
   */
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

/**
 * A YU leg with no counterpart at its maturity — the far end of a ladder
 * mid-roll, or a rate leg opened ahead of its hedge. It earns its fixed
 * rate and ties up margin, but it is not part of any 4-leg unit yet, so it
 * is listed apart rather than blended into a pair that settles earlier.
 */
export interface PendingLeg {
  venue: string;
  side: 'LONG' | 'SHORT';
  marketId: number;
  maturity: number;
  /** Unallocated size as a quantity of the asset's coin, and in dollars. */
  sizeBase: number;
  notionalUsd: number;
  /** The asset's display unit, as PairEstimate.unit. */
  unit: 'base' | 'usd';
  /** Signed by side, as PairLegDetail.lockedApr. */
  lockedApr: number;
  imUsd: number;
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
  /** YU legs left over once every 4-leg unit is formed (see PendingLeg). */
  pendingLegs: PendingLeg[];
}

// ---------------------------------------------------------------------------

const signedPerp = (l: AssetPerpOpen, unit: 'base' | 'usd', keep: number): number => {
  const size = unit === 'base' ? l.qty : l.notionalUsd;
  return (l.side === 'LONG' ? size : -size) * keep;
};

/**
 * A Boros leg's size in the ASSET's unit.
 *
 * `sizeToken` is in the market's COLLATERAL token, which is the coin only on
 * a coin-margined market. The same coin trades on both kinds: Hyperliquid
 * BTC 25 Sep 2026 exists as market 137 (margined in BTC) and as market 194
 * (margined in USDT, and the one with the volume). Reading `sizeToken` as
 * coins on the USDT one compared 100,000 USDT against 1 BTC — a phantom
 * 99,999 BTC deficit, a blank locked APR and a sign-flipped pair rate on a
 * book that was perfectly hedged. So a leg whose collateral is not the coin
 * is converted through its dollar notional at the coin's price; on a
 * dollar-unit asset every leg is its notional.
 */
export function borosSizeIn(
  l: Pick<AssetBorosOpen, 'sizeToken' | 'notionalUsd' | 'collateral'>,
  unit: 'base' | 'usd',
  base: string,
  priceUsd: number,
): number {
  if (unit === 'usd') return l.notionalUsd;
  if ((l.collateral ?? '').toUpperCase() === base.toUpperCase()) return l.sizeToken;
  return priceUsd > 0 ? l.notionalUsd / priceUsd : 0;
}

const signedBoros = (
  l: AssetBorosOpen,
  unit: 'base' | 'usd',
  keep: number,
  base: string,
  priceUsd: number,
): number => {
  const size = borosSizeIn(l, unit, base, priceUsd);
  return (l.side === 'LONG' ? size : -size) * keep;
};

/** One venue's YU legs, as the allocator sees them. */
export interface YuSlice {
  marketId: number;
  maturity: number;
  /** Size in the asset's unit, AFTER exclusions. */
  size: number;
}

/** How much of each side's YU legs a pair receives, by market id. */
export interface YuAllocation {
  long: Map<number, number>;
  short: Map<number, number>;
}

/**
 * Allocate YU legs to a pair, MATCHING MATURITIES FIRST.
 *
 * The old rule scaled every YU at a venue by one perp-derived fraction, so a
 * book laddered across two maturities had each pair carry a slice of BOTH —
 * blending two locked rates and two terms into a single "Est. fixed APR"
 * while the timeline showed only the soonest. On a book whose legs were
 * opened as matched pairs (the normal case) that is pure fiction: the exact
 * pairing exists and the numbers should show it.
 *
 * So: for each maturity present on both sides, pair as much as that maturity
 * can support (capped by what this pair's perp size still needs, and by what
 * earlier pairs left unclaimed). Whatever the pair still needs after that —
 * a genuinely unmatched ladder, a one-sided maturity — falls back to the old
 * proportional split over the REMAINING legs, so nothing is lost and a book
 * with no clean pairing behaves exactly as before.
 *
 * `need` is the pair's perp-derived size; `remainingLong`/`remainingShort`
 * are mutated so pairs allocated earlier cannot be double-counted.
 */
export function allocateYuByMaturity(
  need: number,
  longLegs: readonly YuSlice[],
  shortLegs: readonly YuSlice[],
  remainingLong: Map<number, number>,
  remainingShort: Map<number, number>,
): YuAllocation {
  const long = new Map<number, number>();
  const short = new Map<number, number>();
  if (!(need > 0)) return { long, short };

  const take = (
    legs: readonly YuSlice[],
    remaining: Map<number, number>,
    out: Map<number, number>,
    want: number,
    maturity: number | null,
  ): number => {
    let got = 0;
    // Biggest first: a ladder's main leg should absorb the pair, not be
    // fragmented across the dust legs that happen to sort earlier.
    const pool = [...legs]
      .filter((l) => maturity === null || l.maturity === maturity)
      .sort((a, b) => (remaining.get(b.marketId) ?? 0) - (remaining.get(a.marketId) ?? 0));
    for (const l of pool) {
      if (got >= want - 1e-9) break;
      const avail = remaining.get(l.marketId) ?? 0;
      if (avail <= 0) continue;
      const t = Math.min(avail, want - got);
      remaining.set(l.marketId, avail - t);
      out.set(l.marketId, (out.get(l.marketId) ?? 0) + t);
      got += t;
    }
    return got;
  };

  // Phase 1 — maturities present on BOTH sides, soonest first (the nearest
  // expiry is the one a trader is managing).
  const shared = [...new Set(longLegs.map((l) => l.maturity))]
    .filter((m) => shortLegs.some((s) => s.maturity === m))
    .sort((a, b) => a - b);
  let placed = 0;
  for (const m of shared) {
    if (placed >= need - 1e-9) break;
    const want = need - placed;
    // Probe both sides against a copy first: a maturity can only pair as far
    // as its THINNER side goes, and taking the fat side first would strand
    // size that the other side cannot match.
    const probeL = new Map(remainingLong);
    const probeS = new Map(remainingShort);
    const canL = take(longLegs, probeL, new Map(), want, m);
    const canS = take(shortLegs, probeS, new Map(), want, m);
    const pairable = Math.min(canL, canS);
    if (pairable <= 1e-9) continue;
    take(longLegs, remainingLong, long, pairable, m);
    take(shortLegs, remainingShort, short, pairable, m);
    placed += pairable;
  }

  /**
   * No cross-maturity fallback: a 4-leg unit settles at ONE maturity, so
   * size that this maturity cannot pair is not part of it. It stays in the
   * remaining pool and surfaces as a pending leg — which is the honest
   * answer for a ladder mid-roll, and stops a unit claiming hedge that
   * matures on a different day.
   *
   * `placed` is deliberately unused past here; it stays for readability of
   * the loop above.
   */
  void placed;
  return { long, short };
}

/**
 * The kept fraction of a Boros market's HISTORY under its exclusion. A partial
 * exclusion scales settled PnL by the same fraction it scales capital — a
 * half-excluded leg is half the farm's, settlements included (his call
 * 2026-09-09; before, only capital moved and ROI doubled). The fraction is
 * taken against the live leg's size when the market is open, else the
 * largest size the history saw.
 */
export function borosHistoryKeep(
  exclusions: Exclusions,
  group: Pick<AssetGroup, 'borosOpen'>,
  h: Pick<AssetBorosHistory, 'marketId'> & { peakSizeToken?: number },
): number {
  const key = borosKey(h.marketId);
  if (exclusions[key] === undefined) return 1;
  if (exclusions[key] === 'all') return 0;
  const open = group.borosOpen.find((l) => l.marketId === h.marketId);
  const legQty = open ? open.sizeToken : (h.peakSizeToken ?? 0);
  return legQty > 0 ? 1 - excludedFraction(exclusions, key, legQty) : 1;
}

/**
 * Legs of two merged sub-pairs. ONE venue position attributed to both
 * sub-pairs — a single YU leg hedging two perp books at a venue, or the
 * short perp each of two long books took a share of — must come back as one
 * leg, or the close forms see the same market or symbol twice: an
 * ineligible Boros "pair" they cannot quote, and a close submitted twice.
 */
function mergeLegs(a: readonly PairLegDetail[], b: readonly PairLegDetail[]): PairLegDetail[] {
  const out: PairLegDetail[] = [...a];
  const same = (x: PairLegDetail, y: PairLegDetail) =>
    x.kind === y.kind &&
    x.side === y.side &&
    (x.kind === 'yu' ? x.marketId !== undefined && x.marketId === y.marketId : x.symbol !== undefined && x.symbol === y.symbol);
  for (const leg of b) {
    const i = out.findIndex((o) => same(o, leg));
    if (i < 0) {
      out.push(leg);
      continue;
    }
    const prev = out[i];
    const notionalUsd = prev.notionalUsd + leg.notionalUsd;
    out[i] = {
      ...prev,
      share: Math.min(1, prev.share + leg.share),
      sizeToken: prev.sizeToken + leg.sizeToken,
      sizeBase: prev.sizeBase + leg.sizeBase,
      notionalUsd,
      // Same market, same locked rate in practice; weight by notional regardless.
      lockedApr:
        prev.lockedApr !== null && leg.lockedApr !== null && notionalUsd > 0
          ? (prev.lockedApr * prev.notionalUsd + leg.lockedApr * leg.notionalUsd) / notionalUsd
          : (prev.lockedApr ?? leg.lockedApr),
      feesUsd: prev.feesUsd + leg.feesUsd,
      imUsd: prev.imUsd + leg.imUsd,
      imAtOpenUsd:
        prev.imAtOpenUsd !== null && leg.imAtOpenUsd !== null ? prev.imAtOpenUsd + leg.imAtOpenUsd : null,
    };
  }
  return out;
}

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
  const borosOpenWindowed = group.borosOpen.filter(
    (l) =>
      (sinceSec <= 0 || l.maturity >= sinceSec) &&
      /**
       * A MATURED leg is finished, whatever the chain still lists: it hedges
       * nothing, earns nothing, and its settlements are already in history.
       * It belongs in the matured list; the perp it used to cover is now
       * uncovered and must say so (his call 2026-09-09).
       */
      l.maturity > nowSec,
  );
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
    v.borosSigned += signedBoros(l, unit, keep, group.base, group.priceUsd);
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
        sizeBase: unit === 'base' ? Math.abs(v.gap) : group.priceUsd > 0 ? Math.abs(v.gap) / group.priceUsd : 0,
        notionalUsd: unit === 'usd' ? Math.abs(v.gap) : Math.abs(v.gap) * group.priceUsd,
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
    const keep = borosHistoryKeep(exclusions, group, h);
    if (keep <= 0) continue;
    borosSettleUsd += h.settleUsd * keep;
    borosSettleFeeUsd += h.settleFeeUsd * keep;
    borosTradePnlUsd += h.tradePnlUsd * keep;
    borosTradeFeeUsd += h.tradeFeeUsd * keep;
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
  /**
   * Carry as the venue paid it, and cost as what was avoidable.
   *
   * Settlement fees appear in NEITHER: `borosSettleUsd` is already net of
   * them, and they are unavoidable — charged by the settlement they belong
   * to, however the position was entered or rolled. Adding them back into
   * carry only to subtract them again in cost made both figures larger than
   * anything the trader can act on. The identity is untouched: the two
   * cancelled, so removing both sides leaves `pnlUsd` exactly as it was.
   *
   * Trade fees DO ride here — a different entry could have paid less, so
   * they belong in cost, against a carry quoted gross of them.
   */
  const carryGrossUsd = perpFundingAllUsd + borosSettleUsd + borosTradePnlUsd + borosTradeFeeUsd;
  const costUsd = perpFeesAllUsd + borosTradeFeeUsd - priceResidualUsd;

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
    /**
     * NET of the settlement fee. The entry rate is signed by side — a SHORT
     * receives it, a LONG pays it — but the settlement fee is a COST to
     * whoever holds the leg, so it subtracts either way. It accrues on
     * notional to maturity however the position was entered or rolled, so
     * it belongs inside the locked rate rather than in a fee ladder beside
     * it (the opportunities feed charges it the same way at entry).
     */
    const perYear =
      (l.side === 'SHORT' ? 1 : -1) * entryApr * l.notionalUsd * keep -
      (l.settleFeeApr ?? 0) * l.notionalUsd * keep;
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
  /** A YU leg's whole size in the asset's unit, by its own collateral. */
  const yuSize = (l: AssetBorosOpen) => borosSizeIn(l, unit, group.base, group.priceUsd);
  const longs = group.perpOpen.filter((l) => l.side === 'LONG' && keepOf(l) > 0);
  const shorts = group.perpOpen.filter((l) => l.side === 'SHORT' && keepOf(l) > 0);
  const legSize = (l: AssetPerpOpen) => (unit === 'base' ? l.qty : l.notionalUsd) * keepOf(l);
  const longTotal = longs.reduce((t, l) => t + legSize(l), 0);
  const shortTotal = shorts.reduce((t, l) => t + legSize(l), 0);
  const pairs: PairEstimate[] = [];
  const pendingLegs: PendingLeg[] = [];
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
    /**
     * What each YU leg still has to give, drawn down as pairs claim it.
     * Shared across the whole loop so a leg can never be allocated twice —
     * the old flat `share` could, whenever the perp shares summed past 1.
     */
    const yuRemaining = new Map<number, number>(
      group.borosOpen.map((b) => [
        b.marketId,
        yuSize(b) * borosKeepOf(b),
      ]),
    );
    const yuSlicesFor = (venue: string): YuSlice[] =>
      group.borosOpen
        .filter((b) => b.venue === venue && borosKeepOf(b) > 0)
        .map((b) => ({
          marketId: b.marketId,
          maturity: b.maturity,
          size: yuSize(b) * borosKeepOf(b),
        }));
    /**
     * One row per (long venue, short venue, MATURITY) — a 4-leg arbitrage is
     * a fixed-term unit, so a venue pairing laddered across two terms is two
     * units, not one blended row. Biggest first, then soonest: the largest
     * has the strongest claim on the YU size a maturity can support.
     */
    const ordered = longs
      .flatMap((l) =>
        shorts.flatMap((sh) => {
          const lm = new Set(yuSlicesFor(l.venue).map((y) => y.maturity));
          return [...new Set(yuSlicesFor(sh.venue).map((y) => y.maturity))]
            .filter((m) => lm.has(m))
            .map((maturity) => ({ l, sh, maturity }));
        }),
      )
      .sort(
        (a, b) =>
          (legSize(b.l) * legSize(b.sh)) / pool - (legSize(a.l) * legSize(a.sh)) / pool ||
          a.maturity - b.maturity,
      );
    for (const { l: lLeg, sh: sLeg, maturity } of ordered) {
      const lKeep = keepOf(lLeg);
      const sKeep = keepOf(sLeg);
      const lSize = legSize(lLeg);
      const sSize = legSize(sLeg);
      const longBoros = group.borosOpen.filter(
        (b) => b.venue === lLeg.venue && b.maturity === maturity && borosKeepOf(b) > 0,
      );
      const shortBoros = group.borosOpen.filter(
        (b) => b.venue === sLeg.venue && b.maturity === maturity && borosKeepOf(b) > 0,
      );
      /**
       * The YU size THIS maturity can actually pair, capped by the perp
       * pairing it sits inside: a unit is only as big as its thinnest leg.
       * Allocation runs first and the perps follow it, so the row's size is
       * what the hedge really is rather than a perp-derived guess.
       */
      const alloc = allocateYuByMaturity(
        (lSize * sSize) / pool,
        yuSlicesFor(lLeg.venue).filter((y) => y.maturity === maturity),
        yuSlicesFor(sLeg.venue).filter((y) => y.maturity === maturity),
        yuRemaining,
        yuRemaining,
      );
      const allocLong = [...alloc.long.values()].reduce((a, b) => a + b, 0);
      const allocShort = [...alloc.short.values()].reduce((a, b) => a + b, 0);
      const size = Math.min(allocLong, allocShort);
      if (!(size > 0)) continue;
      // Perps ride PRO-RATA with the YU size this unit claims, so several
      // maturity rows of the same venue pairing sum to the venue's real totals
      // rather than each claiming the whole perp position.
      const lShare = size / lSize; // slice of the long perp leg
      const share = size / sSize; // slice of the short perp leg
      let cap = lLeg.imUsd * lKeep * lShare + sLeg.imUsd * sKeep * share;
      let perYear = 0;
      let soonest = 0;
      const legs: PairLegDetail[] = [
        {
          venue: lLeg.venue,
          kind: 'perp',
          side: 'LONG',
          share: lShare,
          sizeToken: lLeg.qty * lKeep * lShare,
          sizeBase: lLeg.qty * lKeep * lShare,
          notionalUsd: lLeg.notionalUsd * lKeep * lShare,
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
          sizeToken: sLeg.qty * sKeep * share,
          sizeBase: sLeg.qty * sKeep * share,
          notionalUsd: sLeg.notionalUsd * sKeep * share,
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
          // Net of the settlement fee — see the asset-level note: a cost to
          // either side, unavoidable, so it lives inside the locked rate.
          perYear +=
            (b.side === 'SHORT' ? 1 : -1) * entryApr * b.notionalUsd * keep -
            (b.settleFeeApr ?? 0) * b.notionalUsd * keep;
          if (soonest === 0 || b.maturity < soonest) soonest = b.maturity;
        }
        const h = histByMarket.get(b.marketId);
        // TRADE fees only: settlement fees are already netted out of the
        // locked rate above, and charging them again here would double-count
        // them against the same carry.
        const fees = h ? h.tradeFeeUsd * keep : 0;
        borosFeesPaidUsd += fees;
        legStart(h?.firstEventSec);
        if (h?.firstEventSec) borosOpened = Math.min(borosOpened, h.firstEventSec);
        legs.push({
          venue: b.venue,
          kind: 'yu',
          side: b.side,
          share: frac,
          sizeToken: b.sizeToken * keep,
          sizeBase: borosSizeIn(b, 'base', group.base, group.priceUsd) * keep,
          notionalUsd: b.notionalUsd * keep,
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
      for (const b of longBoros) {
        const got = alloc.long.get(b.marketId) ?? 0;
        const whole = yuSize(b) * borosKeepOf(b);
        if (got > 0 && whole > 0) addBoros(b, got / whole);
      }
      for (const b of shortBoros) {
        const got = alloc.short.get(b.marketId) ?? 0;
        const whole = yuSize(b) * borosKeepOf(b);
        if (got > 0 && whole > 0) addBoros(b, got / whole);
      }
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
        soonestMaturitySec: maturity > nowSec ? maturity : soonest,
        legs,
        perpFeesPaidUsd: lLeg.feesUsd * lKeep * lShare + sLeg.feesUsd * sKeep * share,
        borosFeesPaidUsd,
      });
    }
    /**
     * Merge units that are the SAME venue pairing at the SAME maturity.
     * Two perp positions on one venue (an ETH_USDT and an ETH_USDC book,
     * say) generate one triple each, and showing them apart reads as two
     * hedges when it is one — with two nearly-identical APRs sitting side
     * by side, which is exactly what a duplicate looks like.
     */
    const merged = new Map<string, PairEstimate>();
    for (const p of pairs) {
      const k = `${p.longVenue}:${p.shortVenue}:${p.soonestMaturitySec}`;
      const prev = merged.get(k);
      if (!prev) {
        merged.set(k, p);
        continue;
      }
      const cap = prev.capitalUsd + p.capitalUsd;
      // Rates combine on capital — the only weighting under which the
      // merged row earns what its two halves earned.
      const apr =
        prev.lockedAprFwd !== null && p.lockedAprFwd !== null && cap > 0
          ? (prev.lockedAprFwd * prev.capitalUsd + p.lockedAprFwd * p.capitalUsd) / cap
          : (prev.lockedAprFwd ?? p.lockedAprFwd);
      merged.set(k, {
        ...prev,
        size: prev.size + p.size,
        notionalUsd: prev.notionalUsd + p.notionalUsd,
        capitalUsd: cap,
        lockedAprFwd: apr,
        exitFeeUsd: prev.exitFeeUsd + p.exitFeeUsd,
        perpFeesPaidUsd: prev.perpFeesPaidUsd + p.perpFeesPaidUsd,
        borosFeesPaidUsd: prev.borosFeesPaidUsd + p.borosFeesPaidUsd,
        legs: mergeLegs(prev.legs, p.legs),
        hedgedSinceSec:
          prev.hedgedSinceSec !== null && p.hedgedSinceSec !== null
            ? Math.max(prev.hedgedSinceSec, p.hedgedSinceSec)
            : (prev.hedgedSinceSec ?? p.hedgedSinceSec),
      });
    }
    pairs.length = 0;
    pairs.push(...merged.values());
    pairs.sort((a, b) => b.notionalUsd - a.notionalUsd || a.soonestMaturitySec - b.soonestMaturitySec);
    /**
     * Whatever no 4-leg unit could claim: the far end of a ladder mid-roll,
     * or a rate leg opened before its hedge. Dust below 0.1% of the leg is
     * a rounding residual, not a position — it would read as a phantom
     * "pending" row on a book that is fully paired.
     */
    for (const b of group.borosOpen) {
      const left = yuRemaining.get(b.marketId) ?? 0;
      const whole = yuSize(b) * borosKeepOf(b);
      if (whole <= 0 || left <= whole * 0.001) continue;
      pendingLegs.push({
        venue: b.venue,
        side: b.side,
        marketId: b.marketId,
        maturity: b.maturity,
        sizeBase: borosSizeIn(b, 'base', group.base, group.priceUsd) * (left / (yuSize(b) || 1)),
        notionalUsd: b.notionalUsd * (left / (yuSize(b) || 1)),
        unit,
        lockedApr: (b.side === 'SHORT' ? 1 : -1) * keptSlice(exclusions, borosKey(b.marketId), b.sizeToken, b.entryApr).entry,
        imUsd: b.imUsd * (left / whole),
      });
    }
    pendingLegs.sort((a, b) => a.maturity - b.maturity || b.notionalUsd - a.notionalUsd);
  }

  return {
    base: group.base,
    priceUsd: group.priceUsd,
    totals: {
      pnlUsd,
      carryUsd,
      perpFundingAllUsd,
      perpFeesAllUsd,
      // TRADE fees only: settlement fees are netted into the settlements
      // themselves and into the locked rate, never charged again here.
      borosFeesAllUsd: borosTradeFeeUsd,
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
    pendingLegs,
  };
}
