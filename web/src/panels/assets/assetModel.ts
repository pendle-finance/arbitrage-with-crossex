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
  Rebate,
  StrategyLeg,
  VenueFees,
} from '../../api/types';
import { sizeUnitForBase } from '../../lib/boros';
import { rebatedSettleApr } from '../../lib/rebate';
import { isSpreadLeg, venueLegsOf } from '../../lib/spread';
import { groupBook, sameSize, type GroupCard, type WrongSide } from './grouping';

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** |net|/gross under this is "hedged" — mirrors the exposure feed's 2%. */
export const HEDGE_TOLERANCE = 0.02;
/** The tighter band where both sides count in coins (ETH, BTC on a
 * coin-margined Boros market): price cannot move that gap. A USDT-market leg
 * is fixed in dollars while the perp is fixed in coins, so its gap moves with
 * price and keeps HEDGE_TOLERANCE (his call 2026-10-09). */
export const COIN_HEDGE_TOLERANCE = 0.001;

/** Boros coverage that lapses within this window gets an expiry warning —
 * and is the window a roll is recommended in. 10 days, not the original 14:
 * his call 2026-09-20. Change it HERE only; the guide copy, the chip and
 * the tests all read this one number. */
export const EXPIRY_WARN_SEC = 10 * 24 * 3600;
/** The same window in days, for copy that has to name it. */
export const EXPIRY_WARN_DAYS = EXPIRY_WARN_SEC / 86_400;

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
    .map((l) => ({ symbol: l.symbol as string, qty: l.sizeToken, venue: l.venue, partial: !sameSize(l.share, 1) }));
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
          entryApr: b.entryApr ?? undefined,
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

/**
 * The pair's locked SPREAD: the rate on NOTIONAL — what the receive leg
 * locks minus what the pay leg locks, net of settlement fees. `lockedAprFwd`
 * is that same carry over CAPITAL (the leveraged figure the headline shows),
 * so the spread is recovered from it: carry per year = lockedAprFwd ×
 * capital; per-leg notional = half the pair's two RATE-leg notionals — the
 * notional the carry was earned on. Not the perps': on a USD-collateral
 * market the perp notional moves with price while the rate legs do not, and
 * a 5% lock read 4% after a 25% rally. Null when either input is missing.
 */
export function pairLockedSpread(pair: Pick<PairEstimate, 'lockedAprFwd' | 'capitalUsd' | 'legs'>): number | null {
  const perLegNotional = pair.legs.reduce(
    (t, l) => (l.kind !== 'yu' ? t : isSpreadLeg(l) ? t + l.notionalUsd : t + l.notionalUsd / 2),
    0,
  );
  return pair.lockedAprFwd !== null && perLegNotional > 0
    ? (pair.lockedAprFwd * pair.capitalUsd) / perLegNotional
    : null;
}

/**
 * The rate a rate leg was entered at, recovered from `lockedApr`, which is
 * signed by side (SHORT +, LONG −). NOT its magnitude: a leg entered while
 * the market's fixed rate was negative has a negative entry rate, and
 * `Math.abs` would price its exit against the wrong number (audit 2026-09-24).
 */
export const entryAprOf = (side: 'LONG' | 'SHORT', lockedApr: number): number =>
  side === 'SHORT' ? lockedApr : -lockedApr;

/**
 * A pair whose rate legs have not matured yet — what the pair card's Roll
 * over action is offered on. No window: a roll is the trader's to make at
 * any time (his call 2026-09-30); the window only decides when the app
 * REMINDS (`pairRollDue`).
 */
export function pairCanRoll(pair: Pick<PairEstimate, 'soonestMaturitySec'>, nowSec: number): boolean {
  return pair.soonestMaturitySec > nowSec;
}

/**
 * A pair whose rate legs mature inside the expiry-warn window and have not
 * matured yet — what the roll-over banner counts, the pair card flags and
 * the roll signal probes. Same window as a venue's `expiresSoon`, read per
 * unit.
 */
export function pairRollDue(pair: Pick<PairEstimate, 'soonestMaturitySec'>, nowSec: number): boolean {
  return pairCanRoll(pair, nowSec) && pair.soonestMaturitySec - nowSec < EXPIRY_WARN_SEC;
}

type TimelinePair = Pick<PairEstimate, 'hedgedSinceSec' | 'soonestMaturitySec'>;

/** Where a pair's timeline starts: when it was hedged, or a month before
 * maturity when that is unknown. */
const timelineStartSec = (pair: TimelinePair): number =>
  pair.hedgedSinceSec ?? pair.soonestMaturitySec - SECONDS_IN_YEAR / 12;

/** The span of time every pair card of one asset is drawn on. */
export interface TimelineAxis {
  startSec: number;
  endSec: number;
}

/** Earliest pair start to latest maturity, with today inside it. One axis for
 * all of an asset's pairs is what lets their bars compare: a pair that matures
 * sooner ends further left, and the same day sits at the same point on every
 * card. */
export function pairTimelineAxis(pairs: ReadonlyArray<TimelinePair>, nowSec: number): TimelineAxis {
  let startSec = nowSec;
  let endSec = nowSec;
  for (const p of pairs) {
    startSec = Math.min(startSec, timelineStartSec(p));
    endSec = Math.max(endSec, p.soonestMaturitySec);
  }
  return { startSec, endSec };
}

/**
 * A pair's bar on its asset's axis, every figure in percent of the axis:
 * where the bar starts, its length (start → maturity), how much of that has
 * elapsed, and where today is. True time proportions throughout — the filled
 * part over the bar is exactly the share of the pair's term that has passed.
 */
export function timelineBar(
  pair: TimelinePair,
  nowSec: number,
  axis: TimelineAxis,
): { leftPct: number; widthPct: number; elapsedPct: number; todayPct: number } {
  const span = Math.max(1, axis.endSec - axis.startSec);
  const at = (sec: number) => Math.max(0, Math.min(100, ((sec - axis.startSec) / span) * 100));
  const start = timelineStartSec(pair);
  const end = pair.soonestMaturitySec;
  return {
    leftPct: at(start),
    widthPct: at(end) - at(start),
    elapsedPct: at(Math.min(Math.max(nowSec, start), end)) - at(start),
    todayPct: at(nowSec),
  };
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
 * An asset is ACTIVE while it still carries an open leg the farm counts: any
 * open perp (perps are never excluded), or an open Boros leg that is not
 * wholly set aside. Hedged or not makes no difference — an unhedged leg is
 * the one most worth seeing. History alone does not make an asset active.
 *
 * `nowSec` is required because the chain keeps listing a MATURED leg in
 * `borosOpen` forever: it hedges nothing and earns nothing, so `deriveAsset`
 * drops it from the card (same rule, his call 2026-09-09). Reading the raw
 * list here made an asset whose every leg had matured render as fully closed
 * and still refuse to hide (his catch 2026-09-21).
 */
export function assetIsActive(
  group: Pick<AssetGroup, 'perpOpen' | 'borosOpen'>,
  ex: Exclusions,
  nowSec: number,
): boolean {
  if (group.perpOpen.length > 0) return true;
  return group.borosOpen.some(
    (l) => l.maturity > nowSec && excludedFraction(ex, borosKey(l.marketId), l.sizeToken) < 1,
  );
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
): { keep: number; entry: number; at: number | null };
export function keptSlice(
  ex: Exclusions,
  key: string,
  legQty: number,
  entry: number | null,
): { keep: number; entry: number | null; at: number | null };
export function keptSlice(
  ex: Exclusions,
  key: string,
  legQty: number,
  entry: number | null,
): { keep: number; entry: number | null; at: number | null } {
  const f = excludedFraction(ex, key, legQty);
  const keep = 1 - f;
  const at = exclusionAt(ex[key]);
  if (entry === null || keep <= 0 || at === null || f <= 0) return { keep, entry, at };
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
  /** Within HEDGE_TOLERANCE whatever the coin: what the locked APR needs. */
  coveredLoose: boolean;
  /** A Boros leg on this venue is margined in a token other than the coin. */
  borosInDollars: boolean;
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
    /** Backend-attributed settlement-fee rebate, a positive credit inside
     * pnlUsd and carryGrossUsd. 0 when the account is not rebated. */
    borosRebateUsd: number;
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
  spreadVenues?: [string, string] | null;
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
  /** What the Boros side is: one spread market, or two single markets. A
   * book holding both at the same venues and term shows two pairs. */
  kind: 'spread' | 'singles';
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
  spreadVenues?: [string, string] | null;
  maturity: number;
  /** Unallocated size as a quantity of the asset's coin, and in dollars. */
  sizeBase: number;
  notionalUsd: number;
  /** The asset's display unit, as PairEstimate.unit. */
  unit: 'base' | 'usd';
  /** Signed by side, as PairLegDetail.lockedApr. */
  lockedApr: number | null;
  /** The leg's settlement fee as a yearly rate on notional, after any
   * rebate — what a unit's spread is net of, as a 4-leg pair's is. */
  settleFeeApr?: number;
  imUsd: number;
  /** Fraction of the venue leg (after exclusions) that no unit claimed —
   * 1 when the whole leg is pending. A close from the ungrouped list is
   * capped at this slice, so a leg partly in a pair keeps the pair's share. */
  share: number;
  rowSizeToken: number;
  wrongSide?: WrongSide;
}

/**
 * A perp leg — or the slice of one — that no 4-leg unit claimed: a venue
 * with no YU behind it, or what is left once its YU ran out. It still
 * cancels price against the other side's perps, but earns no fixed rate
 * and pays floating funding on its own.
 */
export interface UnpairedPerp {
  venue: string;
  side: 'LONG' | 'SHORT';
  /** The exact CrossEx symbol — the join key to the live position. */
  symbol: string;
  sizeBase: number;
  notionalUsd: number;
  unit: 'base' | 'usd';
  imUsd: number;
  share: number;
  quoteTwin: boolean;
}

/**
 * Two unpaired perps that OFFSET each other — a long at one venue, a short
 * at another — with the rate side missing behind them: the hedge a roll was
 * missed on, or perps opened ahead of their Boros legs. Price risk is
 * cancelled; what the unit lacks is one or both YU legs. Grouped so the card
 * can say exactly that, and offer to open what is missing, instead of
 * listing four anonymous rows under "ungrouped" (his call 2026-09-20).
 */
export interface PerpOnlyPair {
  /** Unique and stable across refreshes: the two perp symbols, the held rate
   * legs' market ids (or 'none'), and an index. One perp unit splits into
   * several parts at the same two venues, so the venues alone repeat. */
  partKey: string;
  longVenue: string;
  shortVenue: string;
  /** The two perp SLICES this unit is made of, both sized to `size`. */
  long: UnpairedPerp;
  short: UnpairedPerp;
  /** In the asset's unit (coin quantity, or dollars). */
  size: number;
  unit: 'base' | 'usd';
  /** Both perp slices, as PairEstimate.notionalUsd counts them. */
  notionalUsd: number;
  /** Perp margin plus whatever rate leg is already there. */
  imUsd: number;
  /** A rate leg ALREADY behind one of the perps, sliced to this part: the
   * other side is then the only one missing, at this leg's maturity. Both
   * only when the two legs share a maturity, which `deriveAsset` pairs
   * first, so its output never holds both. */
  longYu: PendingLeg | null;
  shortYu: PendingLeg | null;
  /** What each side still has to open, in the asset's unit (0 = covered),
   * capped at what the venue lacks: its perps on that side minus every
   * single it holds there, at any date (owner 2026-10-16). */
  missingLong: number;
  missingShort: number;
  /** Set when that cap cut the side: the venue's singles on it, largest
   * first — what the card names as the reason. */
  heldElsewhereLong?: PendingLeg[];
  heldElsewhereShort?: PendingLeg[];
  blockedLong: boolean;
  blockedShort: boolean;
  excludedNetsLong: ExcludedNet[];
  excludedNetsShort: ExcludedNet[];
  otherWay: PendingLeg[];
  offerMaturity: number | null;
}

export type ExcludedNet = { marketId: number; venue: string; side: 'LONG' | 'SHORT'; maturity: number };

/** A perp-only pair's two perps as the close form's rows: each SLICE, not
 * the venue's whole position — Hyperliquid's short may be shared with
 * another unit, and closing all of it would strip that one's hedge too. */
export function perpOnlyCloseLegs(pair: Pick<PerpOnlyPair, 'long' | 'short'>): PerpCloseLeg[] {
  return [pair.long, pair.short].map((l) => ({ symbol: l.symbol, qty: l.sizeBase, venue: l.venue, partial: !sameSize(l.share, 1) }));
}

/** What a side still has to open. Float residue is not missing: 0.949 − 0.158
 * against 0.791 left "missing <0.000001 ETH" with an Open leg button. The cut
 * is relative too, as a dollar-unit leg of $8M has float steps above 1e-9. */
function missingOf(take: number, have: { unit: 'base' | 'usd'; sizeBase: number; notionalUsd: number } | null): number {
  return residueOf(take, have ? sizeIn(have, have.unit) : 0);
}

function residueOf(whole: number, part: number): number {
  const rest = whole - part;
  return rest > Math.max(1e-9, whole * 1e-9) ? rest : 0;
}

/**
 * The mirror of PerpOnlyPair: two leftover rate legs that make a unit's Boros
 * side — a LONG YU at one venue, a SHORT YU at another, SAME maturity — with
 * one or both perps missing behind them. The spread is already locked; what
 * the unit lacks is the price hedge. Grouped so the card can name the missing
 * perps and offer to open them, instead of listing the legs as ungrouped.
 */
export interface BorosOnlyPair {
  longVenue: string;
  shortVenue: string;
  maturity: number;
  /** The two rate-leg SLICES this unit is made of, both sized to `size`. */
  longYu: PendingLeg | null;
  shortYu: PendingLeg | null;
  borosLegs: PendingLeg[];
  /** In the asset's unit (coin quantity, or dollars). */
  size: number;
  unit: 'base' | 'usd';
  /** Both rate-leg slices. */
  notionalUsd: number;
  /** Rate-leg margin plus whatever perp is already there. */
  imUsd: number;
  /** A perp ALREADY behind one of the rate legs (sliced to this unit). Never
   * both — two leftover perps would have formed a perp-only pair first. */
  longPerp: UnpairedPerp | null;
  shortPerp: UnpairedPerp | null;
  /** What each side still has to open, in the asset's unit (0 = covered). */
  missingLong: number;
  missingShort: number;
  /** Receive leg minus pay leg, on notional, net of settlement fees; null
   * while either rate is pending. */
  lockedSpread: number | null;
}

/**
 * A part-hedged book's carry, split in two. The FIXED part is every live rate
 * leg's locked rate (net of settlement fees) — locked whether or not its perp
 * is there. The FLOATING part is the funding the unlocked remainder earns:
 * at each venue, the gap between perp and rate legs pays or receives that
 * venue's funding (a LONG perp pays it, a LONG rate leg receives it), so a
 * covered venue nets to zero and only the gap counts. 10 ETH long HL and
 * short Gate with 6 ETH locked on each earns 4 ETH × (Gate − HL funding).
 *
 * The venue rate is what the account's own perps there REALISED over the
 * last 7 days (his call 2026-10-01); a venue with only rate legs falls back
 * to Boros's current floating rate. An estimate, not a lock: it moves with
 * funding and can turn negative.
 */
export interface UnlockedEstimate {
  /** (fixed + floating) / capital. */
  apr: number;
  fixedApr: number;
  floatingApr: number;
  fixedCarryPerYearUsd: number;
  floatingCarryPerYearUsd: number;
  /** Margin of the unhedged legs the estimate leaves out (0 = none). */
  leftOutCapitalUsd: number;
  /** One row per venue with an unlocked gap — what the floating part is made of. */
  venues: Array<{
    venue: string;
    /** The venue's funding rate, longs-pay sign (positive = longs pay shorts). */
    fundingApr: number;
    source: '7d' | 'current';
    /** Signed unlocked size (perp minus rate legs, LONG +), in dollars. */
    gapUsd: number;
    /** What that gap earns a year at `fundingApr`; negative = pays. */
    carryPerYearUsd: number;
  }>;
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
  /** |netPerp|/grossPerp ≤ 0.1% on ETH and BTC, ≤ 2% on other coins (true when no perps at all). */
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
  /**
   * The APR a book that is NOT fully locked earns, estimated — only ever set
   * where `lockedAprFwd` is null, so a book that shows its fixed rate keeps
   * showing exactly that (his call 2026-10-01). See `UnlockedEstimate`.
   */
  unlockedEstimate: UnlockedEstimate | null;
  /** Rough per-pair decomposition (see PairEstimate). Empty when the book
   * has no long/short perp pairing to decompose. */
  pairs: PairEstimate[];
  perpOnly: PerpOnlyPair[];
  borosOnly: BorosOnlyPair[];
  /** YU legs left over once every 4-leg unit is formed (see PendingLeg). */
  pendingLegs: PendingLeg[];
  /** Perp legs (or slices) left over the same way (see UnpairedPerp). */
  unpairedPerps: UnpairedPerp[];
  /** The settlement-fee rebate config applied to the forward locked-rate math, so
   * the card's bundle/leg views share the ONE discount (per-market, per-mode).
   * Null = not rebated. */
  rebate: Rebate | null;
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

const borosVenuesOf = (l: Pick<AssetBorosOpen, 'venue' | 'spreadVenues'>): readonly string[] => l.spreadVenues ?? [l.venue];

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

export const excludedNetsOf = (borosOpen: AssetBorosOpen[], exclusions: Exclusions, venue: string, side: 'LONG' | 'SHORT'): ExcludedNet[] =>
  borosOpen
    .flatMap((b) => {
      if (!(excludedFraction(exclusions, borosKey(b.marketId), b.sizeToken) > 0)) return [];
      const leg = venueLegsOf(b, 1).find((l) => l.venue === venue && l.side !== side);
      return leg ? [{ marketId: b.marketId, venue, side: leg.side, maturity: b.maturity }] : [];
    })
    .sort((a, b) => a.maturity - b.maturity || a.marketId - b.marketId);

export function deriveAsset(
  group: AssetGroup,
  exclusions: Exclusions,
  sinceSec: number,
  nowSec: number,
  /** The account's own CrossEx fee schedule (VIP tier + per-symbol
   * overrides) — prices the pairs' exit-fee estimate; flat fallback
   * when absent. */
  feeRows?: readonly VenueFees[],
  /** The account's settlement-fee rebate config. Applied ONLY to the FORWARD
   * locked-rate math (current fixed APR, per-pair est. APR), per market — realized
   * rebate rides on each history row's `rebateUsd`. Null = none. */
  rebate?: Rebate | null,
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
        coveredLoose: false,
        borosInDollars: false,
        soonestMaturity: 0,
        expiresSoon: false,
      };
      byVenue.set(venue, v);
    }
    return v;
  };

  const twinSigned = new Map<string, number>();
  for (const l of group.perpOpen) {
    const keep = 1 - excludedFraction(exclusions, perpKey(l.symbol), l.qty);
    if (keep <= 0) continue;
    if (l.quoteTwin) twinSigned.set(l.venue, (twinSigned.get(l.venue) ?? 0) + signedPerp(l, unit, keep));
    else venueFor(l.venue).perpSigned += signedPerp(l, unit, keep);
  }
  for (const l of group.borosOpen) {
    const keep = 1 - excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken);
    if (keep <= 0) continue;
    const signed = signedBoros(l, unit, keep, group.base, group.priceUsd);
    const inDollars = (l.collateral ?? '').toUpperCase() !== group.base.toUpperCase();
    borosVenuesOf(l).forEach((venue, i) => {
      const v = venueFor(venue);
      v.borosSigned += i === 0 ? signed : -signed;
      if (inDollars) v.borosInDollars = true;
      if (v.soonestMaturity === 0 || l.maturity < v.soonestMaturity) {
        v.soonestMaturity = l.maturity;
      }
    });
  }

  const gaps: HedgeGapRow[] = [];
  for (const v of byVenue.values()) {
    v.gap = v.perpSigned - v.borosSigned;
    const scale = Math.max(Math.abs(v.perpSigned), Math.abs(v.borosSigned));
    const tolerance = unit === 'base' && !v.borosInDollars ? COIN_HEDGE_TOLERANCE : HEDGE_TOLERANCE;
    v.covered = scale === 0 || Math.abs(v.gap) <= scale * tolerance;
    v.coveredLoose = scale === 0 || Math.abs(v.gap) <= scale * HEDGE_TOLERANCE;
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

  const perpNets = new Map(venues.map((v) => [v.venue, v.perpSigned]));
  for (const [venue, signed] of twinSigned) perpNets.set(venue, (perpNets.get(venue) ?? 0) + signed);
  const netPerp = [...perpNets.values()].reduce((s, n) => s + n, 0);
  const grossPerp = [...perpNets.values()].reduce((s, n) => s + Math.abs(n), 0);
  const perpTolerance = unit === 'base' ? COIN_HEDGE_TOLERANCE : HEDGE_TOLERANCE;
  const deltaNeutral = grossPerp === 0 || Math.abs(netPerp) / grossPerp <= perpTolerance;
  const deltaNeutralLoose = grossPerp === 0 || Math.abs(netPerp) / grossPerp <= HEDGE_TOLERANCE;

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
  let borosRebateUsd = 0;
  let borosTradePnlUsd = 0;
  let borosTradeFeeUsd = 0;
  for (const h of group.borosHistory) {
    const keep = borosHistoryKeep(exclusions, group, h);
    if (keep <= 0) continue;
    borosSettleUsd += h.settleUsd * keep;
    borosSettleFeeUsd += h.settleFeeUsd * keep;
    // The backend owns the amount; here it is only summed. A credit ADDED BACK,
    // never a re-netting of the settlement (which is already net of its fee).
    borosRebateUsd += (h.rebateUsd ?? 0) * keep;
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
    perpUpnlUsd +
    perpFundingUsd -
    perpFeesUsd +
    perpClosedPnlUsd +
    borosSettleUsd +
    borosTradePnlUsd +
    borosRebateUsd;
  // The same sum, regrouped the way a trader reads it (identical by algebra).
  const perpFundingAllUsd = perpFundingUsd + closedFundingUsd;
  const perpFeesAllUsd = perpFeesUsd + closedFeesUsd;
  const priceResidualUsd = perpUpnlUsd + closedPriceUsd;
  // The rebate is carry — it gives back part of the settlement fee that lives
  // inside net settlement carry.
  const carryUsd = perpFundingAllUsd + borosSettleUsd + borosRebateUsd;
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
  const carryGrossUsd =
    perpFundingAllUsd + borosSettleUsd + borosRebateUsd + borosTradePnlUsd + borosTradeFeeUsd;
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
  const coveredVenues = new Set([...byVenue.values()].filter((v) => v.coveredLoose).map((v) => v.venue));
  let lockedCarryPerYearUsd = 0;
  let lockedToMaturityUsd = 0;
  let lockedNotionalUsd = 0;
  let anyLocked = false;
  let hasUnknownRate = false;
  for (const l of group.borosOpen) {
    const { keep, entry: entryApr } = keptSlice(
      exclusions,
      borosKey(l.marketId),
      l.sizeToken,
      l.entryApr,
    );
    if (keep <= 0 || !borosVenuesOf(l).every((venue) => coveredVenues.has(venue))) continue;
    if (!(l.maturity > nowSec)) continue;
    anyLocked = true;
    if (entryApr === null) {
      hasUnknownRate = true;
      continue;
    }
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
      rebatedSettleApr(l.settleFeeApr ?? 0, rebate, l.marketId) * l.notionalUsd * keep;
    lockedCarryPerYearUsd += perYear;
    lockedToMaturityUsd += (perYear * (l.maturity - nowSec)) / SECONDS_IN_YEAR;
    lockedNotionalUsd += l.notionalUsd * keep;
  }
  // "Locked" means the whole book is: a venue with a missing or short leg
  // has no deterministic carry to quote, however good the covered half.
  const lockedOk =
    anyLocked && !hasUnknownRate && deltaNeutralLoose && [...byVenue.values()].every((v) => v.coveredLoose);
  const lockedAprFwd =
    lockedOk && capitalUsd >= MIN_APR_CAPITAL_USD ? lockedCarryPerYearUsd / capitalUsd : null;

  // A book whose fixed rate cannot be quoted gets an ESTIMATE instead —
  // never in place of one that can (see UnlockedEstimate). `dropBoros` and
  // `dropPerps` are slices left out of it with their margin.
  const estimateOf = (dropBoros: readonly PendingLeg[], dropPerps: readonly UnpairedPerp[]): UnlockedEstimate | null => {
    if (lockedAprFwd !== null) return null;
    if (group.perpOpen.length === 0 && group.borosOpen.length === 0) return null;
    const leftOutCapitalUsd = [...dropBoros, ...dropPerps].reduce((t, l) => t + l.imUsd, 0);
    const cap = capitalUsd - leftOutCapitalUsd;
    if (cap < MIN_APR_CAPITAL_USD) return null;
    const droppedShare = new Map<number, number>();
    const droppedGap = new Map<string, number>();
    const addGap = (venue: string, signed: number) => droppedGap.set(venue, (droppedGap.get(venue) ?? 0) + signed);
    for (const d of dropBoros) {
      droppedShare.set(d.marketId, (droppedShare.get(d.marketId) ?? 0) + d.share);
      // gap = perp − rate legs, so a dropped rate leg adds its signed size back.
      for (const v of venueLegsOf(d, sizeIn(d, unit))) addGap(v.venue, v.side === 'LONG' ? v.size : -v.size);
    }
    for (const p of dropPerps) addGap(p.venue, p.side === 'LONG' ? -sizeIn(p, unit) : sizeIn(p, unit));
    let fixedCarry = 0;
    for (const l of group.borosOpen) {
      const slice = keptSlice(exclusions, borosKey(l.marketId), l.sizeToken, l.entryApr);
      const keep = slice.keep * (1 - Math.min(1, droppedShare.get(l.marketId) ?? 0));
      if (!(keep > 1e-9)) continue;
      // An unknown entry rate leaves the fixed part unknown — no estimate.
      if (slice.entry === null) return null;
      fixedCarry +=
        (l.side === 'SHORT' ? 1 : -1) * slice.entry * l.notionalUsd * keep -
        rebatedSettleApr(l.settleFeeApr ?? 0, rebate, l.marketId) * l.notionalUsd * keep;
    }
    // Each venue's funding, longs-pay sign: from the perps held there (what
    // a SHORT received is the rate; a LONG's is its negative), weighted by
    // notional; else Boros's current floating rate on the venue's rate legs.
    const ownFunding = (venue: string): { rate: number; source: '7d' | 'current' } | null => {
      let num = 0;
      let den = 0;
      for (const p of group.perpOpen) {
        if (p.venue !== venue || p.fundingApr7d == null || !(p.notionalUsd > 0)) continue;
        num += (p.side === 'SHORT' ? 1 : -1) * p.fundingApr7d * p.notionalUsd;
        den += p.notionalUsd;
      }
      if (den > 0) return { rate: num / den, source: '7d' };
      for (const b of group.borosOpen) {
        if (b.venue !== venue || isSpreadLeg(b) || !Number.isFinite(b.floatingApr) || !(b.notionalUsd > 0)) continue;
        num += b.floatingApr * b.notionalUsd;
        den += b.notionalUsd;
      }
      return den > 0 ? { rate: num / den, source: 'current' } : null;
    };
    // A venue with only a spread leg: the spread floats at its first venue's
    // rate minus its second's (core/boros/spread.ts), so this venue's rate is
    // the other venue's own rate plus or minus the spread's. The asset feed
    // carries no listed single market to read it from directly.
    const funding = (venue: string): { rate: number; source: '7d' | 'current' } | null => {
      const own = ownFunding(venue);
      if (own) return own;
      let num = 0;
      let den = 0;
      for (const b of group.borosOpen) {
        if (!b.spreadVenues?.includes(venue) || !Number.isFinite(b.floatingApr) || !(b.notionalUsd > 0)) continue;
        const [first, second] = b.spreadVenues;
        const other = ownFunding(first === venue ? second : first);
        if (!other) continue;
        num += (first === venue ? other.rate + b.floatingApr : other.rate - b.floatingApr) * b.notionalUsd;
        den += b.notionalUsd;
      }
      return den > 0 ? { rate: num / den, source: 'current' } : null;
    };
    const px = unit === 'base' ? group.priceUsd : 1;
    const venues: UnlockedEstimate['venues'] = [];
    let floatingCarry = 0;
    for (const v of byVenue.values()) {
      const gapUsd = (v.gap + (droppedGap.get(v.venue) ?? 0)) * px;
      // Dust is a rounding residual, not an exposure.
      if (Math.abs(gapUsd) < 1) continue;
      const f = funding(v.venue);
      if (f === null || !Number.isFinite(gapUsd)) return null;
      // A LONG gap (more perp than rate leg) pays the venue's funding.
      const carryPerYearUsd = -f.rate * gapUsd;
      floatingCarry += carryPerYearUsd;
      venues.push({ venue: v.venue, fundingApr: f.rate, source: f.source, gapUsd, carryPerYearUsd });
    }
    return {
      apr: (fixedCarry + floatingCarry) / cap,
      fixedApr: fixedCarry / cap,
      floatingApr: floatingCarry / cap,
      fixedCarryPerYearUsd: fixedCarry,
      floatingCarryPerYearUsd: floatingCarry,
      leftOutCapitalUsd,
      venues,
    };
  };

  const keepOf = (l: AssetPerpOpen) => 1 - excludedFraction(exclusions, perpKey(l.symbol), l.qty);
  const borosKeepOf = (l: AssetBorosOpen) =>
    1 - excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken);
  const yuSize = (l: AssetBorosOpen) => borosSizeIn(l, unit, group.base, group.priceUsd);
  const legSize = (l: AssetPerpOpen) => (unit === 'base' ? l.qty : l.notionalUsd) * keepOf(l);
  const keptPerps = group.perpOpen.filter((l) => keepOf(l) > 0);
  const keptBoros = group.borosOpen.filter((b) => borosKeepOf(b) > 0);
  const borosById = new Map(keptBoros.map((b) => [b.marketId, b]));
  const histByMarket = new Map(group.borosHistory.map((h) => [h.marketId, h]));
  const result = groupBook({
    perps: keptPerps.map((l) => ({
      venue: l.venue,
      side: l.side,
      symbol: l.symbol,
      size: legSize(l),
      notionalUsd: l.notionalUsd * keepOf(l),
      quoteTwin: l.quoteTwin ?? false,
    })),
    boros: keptBoros.map((b) => {
      const size = yuSize(b) * borosKeepOf(b);
      return { marketId: b.marketId, legs: venueLegsOf(b, size), size, notionalUsd: b.notionalUsd * borosKeepOf(b), maturity: b.maturity };
    }),
    restShare: unit === 'base' ? 0.001 : 0.005,
  });

  const perpSharesOf = (venue: string, side: 'LONG' | 'SHORT', size: number) => {
    const at = keptPerps.filter((l) => l.venue === venue && l.side === side && !l.quoteTwin);
    const total = at.reduce((t, l) => t + legSize(l), 0);
    return total > 0 ? at.map((l) => ({ l, share: size / total })) : [];
  };
  const unpairedOf = (l: AssetPerpOpen, share: number): UnpairedPerp => {
    const f = keepOf(l) * share;
    return {
      venue: l.venue,
      side: l.side,
      symbol: l.symbol,
      sizeBase: l.qty * f,
      notionalUsd: l.notionalUsd * f,
      unit,
      imUsd: l.imUsd * f,
      share: f,
      quoteTwin: l.quoteTwin ?? false,
    };
  };
  const perpRowOf = (row: { venue: string; side: 'LONG' | 'SHORT'; size: number } | undefined): UnpairedPerp | null => {
    if (!row) return null;
    const [first, ...rest] = perpSharesOf(row.venue, row.side, row.size).map(({ l, share }) => unpairedOf(l, share));
    if (!first) return null;
    return rest.reduce(
      (t, p) => ({ ...t, sizeBase: t.sizeBase + p.sizeBase, notionalUsd: t.notionalUsd + p.notionalUsd, imUsd: t.imUsd + p.imUsd }),
      first,
    );
  };
  const pendingOf = (b: AssetBorosOpen, size: number, wrongSide?: WrongSide | null): PendingLeg => {
    const f = yuSize(b) > 0 ? size / yuSize(b) : 0;
    const kept = yuSize(b) * borosKeepOf(b);
    const entry = keptSlice(exclusions, borosKey(b.marketId), b.sizeToken, b.entryApr).entry;
    const token = yuSize(b) > 0 ? (b.sizeToken * size) / yuSize(b) : 0;
    return {
      venue: b.venue,
      side: b.side,
      marketId: b.marketId,
      spreadVenues: b.spreadVenues,
      maturity: b.maturity,
      sizeBase: borosSizeIn(b, 'base', group.base, group.priceUsd) * f,
      notionalUsd: b.notionalUsd * f,
      unit,
      lockedApr: entry === null ? null : (b.side === 'SHORT' ? 1 : -1) * entry,
      settleFeeApr: rebatedSettleApr(b.settleFeeApr ?? 0, rebate, b.marketId),
      imUsd: b.imUsd * f,
      share: kept > 0 ? size / kept : 0,
      rowSizeToken: sameSize(token, b.sizeToken) ? b.sizeToken : Number(token.toPrecision(12)),
      ...(wrongSide ? { wrongSide } : {}),
    };
  };
  const pendingRowsOf = (rows: ReadonlyArray<{ marketId: number; size: number }>): PendingLeg[] =>
    rows.flatMap((row) => {
      const b = borosById.get(row.marketId);
      return b ? [pendingOf(b, row.size)] : [];
    });

  const FALLBACK_TAKER_RATE = 0.00045;
  const pairOf = (card: GroupCard): PairEstimate => {
    const legs: PairLegDetail[] = [];
    let cap = 0;
    let notionalUsd = 0;
    let exitFeeUsd = 0;
    let perpFeesPaidUsd = 0;
    let borosFeesPaidUsd = 0;
    let perYear = 0;
    let hasUnknownPairRate = false;
    let hedgedSince = 0;
    let perpOpened = 0;
    let borosOpened = Number.POSITIVE_INFINITY;
    const legStart = (t: number | null | undefined) => {
      if (t && t > hedgedSince) hedgedSince = t;
    };
    for (const { l, share } of card.perps.flatMap((row) => perpSharesOf(row.venue, row.side, row.size))) {
      const f = keepOf(l) * share;
      cap += l.imUsd * f;
      notionalUsd += l.notionalUsd * f;
      exitFeeUsd += l.notionalUsd * f * (takerOf(l.symbol) ?? FALLBACK_TAKER_RATE);
      perpFeesPaidUsd += l.feesUsd * f;
      legStart(l.openedAt);
      perpOpened = Math.max(perpOpened, l.openedAt ?? 0);
      legs.push({
        venue: l.venue,
        kind: 'perp',
        side: l.side,
        share: f,
        sizeToken: l.qty * f,
        sizeBase: l.qty * f,
        notionalUsd: l.notionalUsd * f,
        lockedApr: null,
        feesUsd: l.feesUsd * f,
        symbol: l.symbol,
        maturity: 0,
        imUsd: l.imUsd * f,
        imAtOpenUsd: null,
      });
    }
    for (const row of card.boros) {
      const b = borosById.get(row.marketId);
      const kept = b ? yuSize(b) * borosKeepOf(b) : 0;
      if (!b || !(kept > 0)) continue;
      const frac = row.size / kept;
      const slice = keptSlice(exclusions, borosKey(b.marketId), b.sizeToken, b.entryApr);
      const keep = slice.keep * frac;
      const entryApr = slice.entry;
      cap += b.imUsd * keep;
      if (entryApr === null) hasUnknownPairRate = true;
      else
        perYear +=
          (b.side === 'SHORT' ? 1 : -1) * entryApr * b.notionalUsd * keep -
          rebatedSettleApr(b.settleFeeApr ?? 0, rebate, b.marketId) * b.notionalUsd * keep;
      const h = histByMarket.get(b.marketId);
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
        lockedApr: entryApr === null ? null : (b.side === 'SHORT' ? 1 : -1) * entryApr,
        feesUsd: fees,
        maturity: b.maturity,
        marketId: b.marketId,
        spreadVenues: b.spreadVenues,
        imUsd: b.imUsd * keep,
        imAtOpenUsd:
          h?.firstEventSec && b.maturity > nowSec && b.maturity > h.firstEventSec
            ? (b.imUsd * keep * (b.maturity - h.firstEventSec)) / (b.maturity - nowSec)
            : null,
      });
    }
    return {
      longVenue: card.longVenue,
      shortVenue: card.shortVenue,
      kind: card.spread ? 'spread' : 'singles',
      size: card.size,
      unit,
      notionalUsd,
      capitalUsd: cap,
      lockedAprFwd: cap >= MIN_APR_CAPITAL_USD && perYear !== 0 && !hasUnknownPairRate ? perYear / cap : null,
      exitFeeUsd,
      hedgedSinceSec: hedgedSince > 0 && hedgedSince < nowSec ? hedgedSince : null,
      perpOpenedSec: perpOpened > 0 ? perpOpened : null,
      borosOpenedSec: Number.isFinite(borosOpened) ? borosOpened : null,
      soonestMaturitySec: card.maturity ?? 0,
      legs,
      perpFeesPaidUsd,
      borosFeesPaidUsd,
    };
  };

  const otherWayIds = new Set([
    ...result.cards.flatMap((c) => c.otherWay.map((w) => w.marketId)),
    ...result.ungrouped.boros.filter((b) => b.wrongSide).map((b) => b.marketId),
  ]);
  const heldElsewhereOf = (venue: string, side: 'LONG' | 'SHORT'): PendingLeg[] =>
    keptBoros
      .flatMap((b) => {
        if (otherWayIds.has(b.marketId) || !venueLegsOf(b, 1).some((l) => l.venue === venue && l.side === side)) return [];
        const kept = yuSize(b) * borosKeepOf(b);
        const away = result.cards.reduce((t, c) => {
          const row = c.boros.find((r) => r.marketId === b.marketId);
          return t + (row && !c.perps.some((p) => p.venue === venue && p.side === side) ? row.size : 0);
        }, 0);
        const counted = residueOf(kept, away);
        return counted > 0 ? [pendingOf(b, counted)] : [];
      })
      .sort((a, b) => sizeIn(b, b.unit) - sizeIn(a, a.unit) || a.maturity - b.maturity);
  const cardDates = result.cards.flatMap((c) => (c.maturity === null ? [] : [c.maturity]));
  const latestCardDate = cardDates.length > 0 ? Math.max(...cardDates) : null;

  const pairs: PairEstimate[] = [];
  const perpOnly: PerpOnlyPair[] = [];
  const borosOnly: BorosOnlyPair[] = [];
  const keyCount = new Map<string, number>();
  for (const card of result.cards) {
    if (card.kind === 'hedged') {
      pairs.push(pairOf(card));
      continue;
    }
    const longPerp = perpRowOf(card.perps.find((p) => p.side === 'LONG'));
    const shortPerp = perpRowOf(card.perps.find((p) => p.side === 'SHORT'));
    const borosLegs = pendingRowsOf(card.boros);
    if (card.kind === 'perpMissing') {
      const notionalUsd = borosLegs.reduce((t, y) => t + y.notionalUsd, 0);
      borosOnly.push({
        longVenue: card.longVenue,
        shortVenue: card.shortVenue,
        maturity: card.maturity ?? 0,
        longYu: card.spread ? null : (borosLegs.find((y) => y.side === 'LONG') ?? null),
        shortYu: card.spread ? null : (borosLegs.find((y) => y.side === 'SHORT') ?? null),
        borosLegs,
        size: card.size,
        unit,
        notionalUsd,
        imUsd: borosLegs.reduce((t, y) => t + y.imUsd, 0) + (longPerp?.imUsd ?? 0) + (shortPerp?.imUsd ?? 0),
        longPerp,
        shortPerp,
        missingLong: missingOf(card.size, longPerp),
        missingShort: missingOf(card.size, shortPerp),
        lockedSpread: borosLegs.every((y) => y.lockedApr !== null)
          ? borosLegs.reduce((t, y) => t + (y.lockedApr ?? 0) - (y.settleFeeApr ?? 0), 0)
          : null,
      });
      continue;
    }
    if (!longPerp || !shortPerp) continue;
    const cut = (side: 'LONG' | 'SHORT', offer: number, blocked: boolean) =>
      card.holds !== side && !blocked && residueOf(card.size, offer) > 0 ? heldElsewhereOf(side === 'LONG' ? card.longVenue : card.shortVenue, side) : [];
    const heldLong = cut('LONG', card.offer.long, card.blocked.long);
    const heldShort = cut('SHORT', card.offer.short, card.blocked.short);
    const heldTotal = borosLegs.reduce((t, y) => t + sizeIn(y, y.unit), 0);
    const parts = borosLegs.length > 0 ? borosLegs.map((y) => ({ y, f: heldTotal > 0 ? sizeIn(y, y.unit) / heldTotal : 1 })) : [{ y: null, f: 1 }];
    parts.forEach(({ y, f }, i) => {
      const scale = (p: UnpairedPerp): UnpairedPerp => ({ ...p, sizeBase: p.sizeBase * f, notionalUsd: p.notionalUsd * f, imUsd: p.imUsd * f, share: p.share * f });
      const long = scale(longPerp);
      const short = scale(shortPerp);
      const base = `${long.symbol}:${short.symbol}:${y?.marketId ?? 'none'}`;
      const n = keyCount.get(base) ?? 0;
      keyCount.set(base, n + 1);
      perpOnly.push({
        partKey: `${base}:${n}`,
        longVenue: card.longVenue,
        shortVenue: card.shortVenue,
        long,
        short,
        size: card.size * f,
        unit,
        notionalUsd: long.notionalUsd + short.notionalUsd,
        imUsd: long.imUsd + short.imUsd + (y?.imUsd ?? 0),
        longYu: y?.side === 'LONG' ? y : null,
        shortYu: y?.side === 'SHORT' ? y : null,
        missingLong: card.offer.long * f,
        missingShort: card.offer.short * f,
        blockedLong: card.blocked.long,
        blockedShort: card.blocked.short,
        excludedNetsLong: card.offer.long > 0 ? excludedNetsOf(group.borosOpen, exclusions, card.longVenue, 'LONG') : [],
        excludedNetsShort: card.offer.short > 0 ? excludedNetsOf(group.borosOpen, exclusions, card.shortVenue, 'SHORT') : [],
        otherWay:
          i === 0
            ? card.otherWay.flatMap((w) => {
                const b = borosById.get(w.marketId);
                return b ? [pendingOf(b, yuSize(b) * borosKeepOf(b), { blocks: w.blocks, againstVenue: w.againstVenue })] : [];
              })
            : [],
        offerMaturity: y ? y.maturity : latestCardDate,
        ...(heldLong.length > 0 ? { heldElsewhereLong: heldLong } : {}),
        ...(heldShort.length > 0 ? { heldElsewhereShort: heldShort } : {}),
      });
    });
  }
  pairs.sort((a, b) => b.notionalUsd - a.notionalUsd || a.soonestMaturitySec - b.soonestMaturitySec);
  perpOnly.sort((a, b) => b.notionalUsd - a.notionalUsd || a.partKey.localeCompare(b.partKey));
  borosOnly.sort((a, b) => b.notionalUsd - a.notionalUsd || a.maturity - b.maturity || a.longVenue.localeCompare(b.longVenue));

  const pendingLegs = result.ungrouped.boros.flatMap((row) => {
    const b = borosById.get(row.marketId);
    return b ? [pendingOf(b, row.size, row.wrongSide)] : [];
  });
  pendingLegs.sort((a, b) => a.maturity - b.maturity || b.notionalUsd - a.notionalUsd);
  const unpairedPerps = result.ungrouped.perps.flatMap((p) =>
    p.quoteTwin
      ? keptPerps.filter((l) => l.symbol === p.symbol).map((l) => unpairedOf(l, p.size / legSize(l)))
      : perpSharesOf(p.venue, p.side, p.size).map(({ l, share }) => unpairedOf(l, share)),
  );
  unpairedPerps.sort((a, b) => b.notionalUsd - a.notionalUsd || a.venue.localeCompare(b.venue));

  /**
   * The estimate counts hedged units only: a rate leg with no perp behind it,
   * and a perp with no other side, are left out with their margin. A rate leg
   * whose perps rolled to a later term keeps its fixed rate on little more
   * than its own margin, which shrinks toward maturity, so counting it puts
   * the book's APR above every pair's. A quote twin
   * stays: its margin counted before and its funding never did. A book with
   * no hedged unit keeps the whole-book estimate.
   */
  const hedgedUnits = pairs.length > 0 || perpOnly.length > 0;
  const unlockedEstimate = hedgedUnits
    ? estimateOf(
        [...borosOnly.flatMap((u) => u.borosLegs), ...pendingLegs],
        [
          ...borosOnly.flatMap((u) => [u.longPerp, u.shortPerp].filter((p): p is UnpairedPerp => p !== null)),
          ...unpairedPerps.filter((p) => !p.quoteTwin),
        ],
      )
    : estimateOf([], []);

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
        borosRebateUsd,
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
    unlockedEstimate,
    lockedAprFwd,
    lockedToMaturityUsd: lockedOk ? lockedToMaturityUsd : null,
    lockedNotionalUsd: lockedOk && lockedNotionalUsd > 0 ? lockedNotionalUsd : null,
    pairs,
    perpOnly,
    borosOnly,
    pendingLegs,
    unpairedPerps,
    rebate: rebate ?? null,
  };
}
