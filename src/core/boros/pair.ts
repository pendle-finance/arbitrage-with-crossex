/**
 * Two-leg Boros market entry: eligibility, simulation, sizing arithmetic and
 * the confirm-time failsafes. Pure module — books, positions, margin buckets
 * and the clock are all injected, so nothing here fetches or reads time.
 *
 * The trade is a rate SPREAD across two Boros books that share a collateral
 * token and a maturity. One leg receives fixed, the other pays fixed:
 *
 *   direction 'short' → hit the BIDS  → RECEIVE fixed at exec_short
 *   direction 'long'  → lift the ASKS → PAY     fixed at exec_long
 *   spread = exec_short − exec_long − fees
 *
 * Sign discipline, because getting it wrong silently inverts every readout:
 * a HIGHER exec rate is better on the receive-fixed leg and WORSE on the
 * pay-fixed leg. Slippage therefore moves the two legs in opposite directions
 * on the number line but the SAME direction in the spread — the two tolerances
 * ADD. `worstSpreadApr = estSpreadApr − (slipShort + slipLong)`; quoting one
 * leg's worst case would understate the pair's by roughly half.
 *
 * Units: everything money-shaped in this module is in COLLATERAL-TOKEN units
 * (the unit a Boros margin bucket is actually denominated in, and the unit §6's
 * "you need X USDT in its account" has to be quoted in). USD is a display
 * conversion the caller applies with `collateralPriceUsd`. Since both legs of
 * an eligible pair share a tokenId, one collateral unit serves both.
 *
 * APRs are per-year decimal FRACTIONS everywhere, never percent. Slippage
 * tolerances are quoted in the same unit — an APR fraction, where one Boros
 * book tick is 0.0001 — never as a percentage OF the rate: the book is priced
 * in rate space, so a rate-relative tolerance would mean a different number of
 * ticks on a 3% book than on a 30% one.
 */
import {
  borosInitialMarginUsd,
  walkBorosBook,
  type BookStatus,
} from './opportunities';
import { SECONDS_IN_YEAR } from './returns';
import { BOROS_TOKEN_SYMBOLS, type BorosMarket, type BorosOrderBook } from './client';

/** Default per-leg tolerance: 25 ticks of APR. Wide enough that a normal
 * two-or-three-level walk is not rejected, tight enough that the worst-case
 * spread it implies (2 × 25 ticks = 0.5% APR of give-up) is still a number a
 * spread trader will react to rather than wave through. */
export const DEFAULT_SLIPPAGE_APR = 0.0025;

/** Hard ceiling on a per-leg tolerance. Past this the "worst case" stops
 * bounding anything — 10% APR of give-up on each leg is not a market order
 * with a limit, it is a market order. */
export const MAX_SLIPPAGE_APR = 0.1;

export const MIN_GAS_BALANCE_USD = 0.3;

/** How long a simulation may back a confirm before it is refused as stale
 * (§7). The panel re-simulates well inside this. */
export const SIMULATION_MAX_AGE_MS = 12_000;

/** 'short' RECEIVES fixed (hits bids); 'long' PAYS fixed (lifts asks). */
export type BorosLegDirection = 'long' | 'short';

/** What the ticket is doing with the entered size. `close` forces both legs
 * reduce-only against what the account already holds; `open` runs the
 * three-state behaviour in `resolveLegSizing`. */
export type PairIntent = 'open' | 'close';

export type PairIneligibleCode =
  | 'different-collateral'
  | 'different-maturity'
  | 'same-market'
  | 'not-tradable';

export interface PairEligibility {
  eligible: boolean;
  code: PairIneligibleCode | null;
  /** Shown verbatim next to the greyed pair (§2) — never hide the pair. */
  reason: string | null;
}

/**
 * Can these two markets offset each other? Shared collateral and shared
 * maturity, per §2 — margin MODE is deliberately not consulted, it decides
 * where margin sits, not whether a pair is valid (§6).
 */
export function pairEligibility(
  a: BorosMarket,
  b: BorosMarket,
  nowSec: number,
): PairEligibility {
  const no = (code: PairIneligibleCode, reason: string): PairEligibility => ({
    eligible: false,
    code,
    reason,
  });
  if (a.marketId === b.marketId) {
    return no('same-market', 'same market — a leg cannot offset itself');
  }
  const dead = [a, b].find((m) => m.state !== 'Normal' || m.maturity <= nowSec);
  if (dead) {
    return no(
      'not-tradable',
      dead.maturity <= nowSec ? `${dead.name} has matured` : `${dead.name} is not trading`,
    );
  }
  if (a.tokenId !== b.tokenId) {
    const nameOf = (m: BorosMarket) => BOROS_TOKEN_SYMBOLS[m.tokenId] ?? `token#${m.tokenId}`;
    return no('different-collateral', `different collateral — ${nameOf(a)} vs ${nameOf(b)}`);
  }
  if (a.maturity !== b.maturity) return no('different-maturity', 'different maturity');
  return { eligible: true, code: null, reason: null };
}

// ---------------------------------------------------------------------------
// Sizing (§4)
// ---------------------------------------------------------------------------

export interface LegSizing {
  /** What the account holds on this market NOW, signed: + long fixed, − short
   * fixed. Read off the NETTED (account, market) position — it is the whole
   * exposure in this market, not just what this panel opened. */
  currentSize: number;
  /** Signed change this leg attempts, before any depth shortfall. */
  deltaSize: number;
  /** currentSize + deltaSize — what the account would hold if it all fills. */
  resultingSize: number;
  /** The delta opposes an existing position (§4 row 3). */
  opposing: boolean;
  /** Opposing AND large enough to cross zero: closes and re-opens the other way. */
  flips: boolean;
  /** `close` intent clamped the size down to what is actually there to close. */
  clampedToClose: boolean;
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * The §4 arithmetic for one leg. `close` reduces the existing position and can
 * never flip it (size clamps at |current|, and a flat market gets a zero
 * delta); `open` runs the three starting states — flat, same direction,
 * opposing — off the same signed sum.
 */
export function resolveLegSizing(
  currentSize: number,
  requestedSize: number,
  direction: BorosLegDirection,
  intent: PairIntent,
): LegSizing {
  const cur = Number.isFinite(currentSize) ? currentSize : 0;
  const want = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 0;
  const signedWant = direction === 'long' ? want : -want;

  let delta = signedWant;
  let clampedToClose = false;
  if (intent === 'close') {
    // Reduce-only: the delta must oppose the position and can never exceed it.
    if (cur === 0 || sign(signedWant) === sign(cur)) {
      delta = 0;
      clampedToClose = want > 0;
    } else if (want > Math.abs(cur)) {
      delta = -cur;
      clampedToClose = true;
    }
  }

  const resulting = cur + delta;
  const opposing = cur !== 0 && delta !== 0 && sign(delta) !== sign(cur);
  return {
    currentSize: cur,
    deltaSize: delta,
    resultingSize: resulting,
    opposing,
    // Strictly through zero — a delta that lands exactly flat closes, it does
    // not re-open, so it needs no flip acknowledgement.
    flips: opposing && Math.abs(delta) > Math.abs(cur),
    clampedToClose,
  };
}

// ---------------------------------------------------------------------------
// Simulation (§3)
// ---------------------------------------------------------------------------

export interface BorosPairLegInput {
  market: BorosMarket;
  /** null = the book fetch failed or was not attempted. */
  book: BorosOrderBook | null;
  direction: BorosLegDirection;
  /** Per-leg tolerance as an APR fraction. Clamped to [0, MAX_SLIPPAGE_APR]. */
  slippageApr: number;
  /** Netted signed position on this market, collateral units. */
  currentSize: number;
  /** True when this market can only be traded on isolated margin (§6B). */
  isolatedOnly?: boolean;
  /** True when the account currently holds this market inside an ISOLATED
   * bucket — the §6A precondition, derived from the live margin groups. */
  onIsolatedMargin?: boolean;
  /** §6A only fires when that isolated bucket actually has something in it. */
  isolatedHasPositionOrOrders?: boolean;
  /** Any TP/SL resting on this market (§7 — flagged at confirm, not blocking). */
  hasTpSl?: boolean;
  /**
   * Initial margin this market ALREADY has committed in its bucket, collateral
   * units. Needed because `available` is net of every committed margin: a leg
   * that adds to an existing position only has to fund the DIFFERENCE between
   * the resulting position's margin and what it already posts. Charging the
   * full resulting margin against an already-net balance double-counts the
   * existing position and blocks trades that are perfectly fundable. Defaults
   * to 0, which is exactly right for a leg opening from flat.
   */
  committedMargin?: number;
}

export interface SimulatedLeg {
  marketId: number;
  marketName: string;
  venue: string;
  base: string;
  direction: BorosLegDirection;
  /** VWAP the entered size would achieve against the book as it stands. */
  execApr: number | null;
  /** execApr moved a full tolerance the WRONG way for this leg's direction:
   * lower on a receive-fixed leg, higher on a pay-fixed one. */
  worstApr: number | null;
  /** Collateral units the book can actually supply; < requested on a thin book. */
  estFillSize: number;
  /** Requested − estFillSize. Non-zero means this leg alone will fall short. */
  shortfallSize: number;
  bookStatus: BookStatus;
  /** Initial margin this leg posts at the rate it locks, collateral units. */
  marginRequired: number | null;
  /** Effective tolerance after clamping. */
  slippageApr: number;
  sizing: LegSizing;
}

export interface BorosPairSimulation {
  legA: SimulatedLeg;
  legB: SimulatedLeg;
  /** Which leg receives fixed; null when the two directions do not oppose, in
   * which case the pair is not a spread and no spread number is quoted. */
  receiveLeg: 'A' | 'B' | null;
  /** NET of Boros taker and settlement fees. The only spread numbers that
   * exist in this flow — nothing gross is ever computed here, so nothing
   * gross can leak into the UI (§3). */
  estSpreadApr: number | null;
  /** estSpreadApr with BOTH tolerances spent at once — the legs cross in
   * opposite directions, so the slips add rather than offset. */
  worstSpreadApr: number | null;
  /** Taker fee to cross both books now, collateral units. */
  costToCrossSize: number;
  /** The fee drag already subtracted from both spread numbers, as an APR. */
  feeDragApr: number;
  /** Σ of the legs' margin; null if either leg's is unknown. Displayed per leg
   * as well — per-market floors differ, so one figure hides the asymmetry. */
  marginRequiredTotal: number | null;
  /** min(fill A, fill B) — the size that actually ends up hedged. */
  hedgedSize: number;
  /** How much of the entered size ends up directional if both legs fill to
   * their estimates. */
  unhedgedSize: number;
  collateral: string;
  collateralPriceUsd: number | null;
  secondsToMaturity: number;
  /** Plain-language notes for everything that could not be computed. */
  reasons: string[];
}

const clampSlippage = (s: number): number =>
  !Number.isFinite(s) || s < 0 ? 0 : Math.min(s, MAX_SLIPPAGE_APR);

/**
 * Walk one leg's book at the entered size. Reuses `walkBorosBook`, which never
 * extrapolates past the last level — a size the book cannot support comes back
 * as a real fill estimate plus a shortfall, not an invented rate.
 */
function simulateLeg(
  leg: BorosPairLegInput,
  requestedSize: number,
  intent: PairIntent,
  nowSec: number,
  reasons: string[],
): SimulatedLeg {
  const slippageApr = clampSlippage(leg.slippageApr);
  const sizing = resolveLegSizing(leg.currentSize, requestedSize, leg.direction, intent);
  const size = Math.abs(sizing.deltaSize);

  const levels = leg.book ? (leg.direction === 'long' ? leg.book.asks : leg.book.bids) : null;
  // Collateral units in, collateral units out: the walk is linear in the price
  // it is handed, so passing 1 keeps every size in book units.
  const walk = levels && size > 0 ? walkBorosBook(levels, size, 1) : null;

  let bookStatus: BookStatus = 'ok';
  if (!leg.book) {
    bookStatus = 'unavailable';
    reasons.push(
      `${leg.market.name}: order book unavailable — no rate, spread or margin can be quoted for this leg.`,
    );
  } else if (!walk) {
    bookStatus = size > 0 ? 'insufficient-depth' : 'not-fetched';
    if (size > 0) {
      reasons.push(
        `${leg.market.name}: the ${leg.direction === 'long' ? 'ask' : 'bid'} side is empty — nothing to cross.`,
      );
    }
  } else if (walk.insufficient) {
    bookStatus = 'insufficient-depth';
    reasons.push(
      `${leg.market.name}: the book only supports ${fmtSize(walk.filledUsd)} of the ${fmtSize(size)} requested — this leg will fill short.`,
    );
  }

  const execApr = walk ? walk.execApr : null;
  // A receive-fixed leg is hurt by a LOWER rate, a pay-fixed leg by a HIGHER one.
  const worstApr =
    execApr === null ? null : leg.direction === 'short' ? execApr - slippageApr : execApr + slippageApr;

  // Margin is charged at the rate the leg actually locks; the IM formula is
  // linear in notional, so collateral units in gives collateral units out.
  // Sized off the RESULTING position, not the delta — Boros nets to one
  // position per (account, market), so that is what the bucket has to carry.
  const marginRequired =
    execApr === null
      ? null
      : borosInitialMarginUsd(leg.market, execApr, Math.abs(sizing.resultingSize), nowSec);
  if (marginRequired === null && execApr !== null) {
    reasons.push(
      `${leg.market.name} carries no margin coefficient — its initial margin cannot be modelled.`,
    );
  }

  const estFill = walk ? walk.filledUsd : 0;
  return {
    marketId: leg.market.marketId,
    marketName: leg.market.name,
    venue: leg.market.venue,
    base: leg.market.base,
    direction: leg.direction,
    execApr,
    worstApr,
    estFillSize: estFill,
    shortfallSize: Math.max(0, size - estFill),
    bookStatus,
    marginRequired,
    slippageApr,
    sizing,
  };
}

export interface SimulateBorosPairInput {
  legA: BorosPairLegInput;
  legB: BorosPairLegInput;
  /** Notional per leg, collateral-token units. */
  size: number;
  intent: PairIntent;
  /**
   * Trade ONE leg only, leaving the other untouched (size 0).
   *
   * This is what "complete now at market" needs: after a partial fill the gap
   * is closed by adding to the leg that filled LESS, and trading both legs
   * again would just grow the book at the same imbalance. Modelled here rather
   * than in a separate single-leg path so completion keeps the whole gate —
   * margin, gas, depth, eligibility — instead of a thinner copy of it.
   */
  onlyLeg?: 'A' | 'B';
  /** USD per collateral token; null = unpriceable (USD readouts suppressed). */
  collateralPriceUsd: number | null;
  nowSec: number;
  /** Replaces every market's own taker rate when set — mirrors the
   * BOROS_TAKER_FEE_OVERRIDE knob the opportunities scan already honours. */
  takerFeeOverride?: number;
}

/**
 * Price the pair at the entered size. Every spread number that comes out of
 * here is already net of Boros taker and settlement fees; the gross figure is
 * never computed, so it cannot leak into a readout (§3).
 */
export function simulateBorosPair(input: SimulateBorosPairInput): BorosPairSimulation {
  const { legA, legB, size, intent, nowSec } = input;
  const reasons: string[] = [];

  // A leg the caller excluded gets a zero size, which walks no book and
  // produces a zero delta — the submission path then skips it entirely.
  const sizeFor = (key: 'A' | 'B'): number =>
    input.onlyLeg && input.onlyLeg !== key ? 0 : size;
  const a = simulateLeg(legA, sizeFor('A'), intent, nowSec, reasons);
  const b = simulateLeg(legB, sizeFor('B'), intent, nowSec, reasons);

  const maturity = legA.market.maturity;
  const secondsToMaturity = Math.max(0, maturity - nowSec);
  const years = secondsToMaturity / SECONDS_IN_YEAR;

  const takerRate = (m: BorosMarket): number =>
    input.takerFeeOverride !== undefined && input.takerFeeOverride >= 0
      ? input.takerFeeOverride
      : m.takerFeeRate;

  /**
   * Both fees are quoted as rates charged on notional × years, so as an APR
   * drag they are the sum of the rates OF THE LEGS THAT ACTUALLY TRADE.
   *
   * A single-leg ticket carries a borrowed partner sized to zero purely to
   * make the pair shape valid. Summing unconditionally charged that phantom
   * leg's taker and settlement fees too — a one-leg trade was quoted double
   * the drag it pays, which then propagated into the spread and the net APR.
   */
  const tradesA = Math.abs(a.sizing.deltaSize) > 0;
  const tradesB = Math.abs(b.sizing.deltaSize) > 0;
  // Before a size is entered NEITHER leg trades; the pair's own fees are still
  // the right thing to quote, so fall back to both rather than reporting zero.
  const bothIdle = !tradesA && !tradesB;
  const takerDragApr =
    (tradesA || bothIdle ? takerRate(legA.market) : 0) +
    (tradesB || bothIdle ? takerRate(legB.market) : 0);
  const settleDragApr =
    (tradesA || bothIdle ? legA.market.settleFeeApr : 0) +
    (tradesB || bothIdle ? legB.market.settleFeeApr : 0);
  const feeDragApr = takerDragApr + settleDragApr;

  const receiveLeg: 'A' | 'B' | null =
    a.direction === b.direction ? null : a.direction === 'short' ? 'A' : 'B';
  if (receiveLeg === null) {
    reasons.push(
      'Both legs point the same way, so they do not offset — no spread is quoted. Flip one leg to trade a spread.',
    );
  }

  const recv = receiveLeg === 'A' ? a : b;
  const pay = receiveLeg === 'A' ? b : a;
  const quotable = receiveLeg !== null && recv.execApr !== null && pay.execApr !== null;

  const estSpreadApr = quotable ? recv.execApr! - pay.execApr! - feeDragApr : null;
  // Both tolerances spent at once. Equivalently estSpread − (slipA + slipB):
  // the legs cross in opposite directions so the two slips compound.
  const worstSpreadApr = quotable ? recv.worstApr! - pay.worstApr! - feeDragApr : null;

  // What crossing both books costs right now, in collateral units. Sized off
  // the notional actually expected to trade, not the requested size.
  // ⚠ min() only when BOTH legs trade. A single-leg ticket (onlyLeg) sizes the
  // other leg to zero, and min(size, 0) reported the taker fee as 0 on a trade
  // that genuinely pays one — free execution is the last thing to be wrong
  // about. With one leg live, that leg IS the traded size.
  const sizeA = Math.abs(a.sizing.deltaSize);
  const sizeB = Math.abs(b.sizing.deltaSize);
  const tradedSize = sizeA === 0 || sizeB === 0 ? Math.max(sizeA, sizeB) : Math.min(sizeA, sizeB);
  const costToCrossSize = takerDragApr * tradedSize * years;

  /**
   * Σ of the legs that actually trade.
   *
   * ⚠ A leg sized to zero (a single-leg ticket's borrowed partner) never walks
   * a book, so it has no execApr and therefore no margin — and requiring BOTH
   * to be known reported the total as "—" on a trade whose one real leg had a
   * perfectly good number. Null still propagates from a leg that IS trading
   * but cannot be modelled, which is the case worth refusing to guess at.
   */
  const marginParts = [
    { size: sizeA, margin: a.marginRequired },
    { size: sizeB, margin: b.marginRequired },
  ].filter((x) => x.size > 0);
  const marginRequiredTotal = marginParts.some((x) => x.margin === null)
    ? null
    : marginParts.reduce((sum, x) => sum + (x.margin ?? 0), 0);

  // Only meaningful when BOTH legs trade. On a single-leg completion there is
  // no pair to hedge — reporting the one fill as "unhedged" would call closing
  // a gap the opposite of what it is.
  const bothTrade =
    Math.abs(a.sizing.deltaSize) > 0 && Math.abs(b.sizing.deltaSize) > 0;
  const hedgedSize = bothTrade ? Math.min(a.estFillSize, b.estFillSize) : 0;
  // Dust guard, as in the fill decoder: walkBorosBook accumulates `filled`
  // across levels while decrementing `remaining`, so two legs walking different
  // level counts drift by ~1e-11 at 18-decimal magnitudes. Without this a
  // perfectly matched pair reports itself as partly directional.
  const rawUnhedged = bothTrade ? Math.abs(a.estFillSize - b.estFillSize) : 0;
  const unhedgedSize = rawUnhedged > Math.max(1e-12, size * 1e-9) ? rawUnhedged : 0;
  if (unhedgedSize > 0) {
    reasons.push(
      'The two legs fill to different sizes at this notional — the difference is left directional.',
    );
  }

  return {
    legA: a,
    legB: b,
    receiveLeg,
    estSpreadApr,
    worstSpreadApr,
    costToCrossSize,
    feeDragApr,
    marginRequiredTotal,
    hedgedSize,
    unhedgedSize,
    collateral: BOROS_TOKEN_SYMBOLS[legA.market.tokenId] ?? `token#${legA.market.tokenId}`,
    collateralPriceUsd: input.collateralPriceUsd,
    secondsToMaturity,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Margin buckets + confirm gating (§6, §7)
// ---------------------------------------------------------------------------

export interface BorosMarginBucket {
  /** Free collateral in this bucket: netBalance − initial margin already
   * committed. Bonds and pending withdrawals must be excluded UPSTREAM — this
   * module trusts the number it is handed (§6). */
  available: number;
  /** Whether the bucket holds any position or resting order right now. */
  hasPositionOrOrders: boolean;
}

export interface BorosPairAccountState {
  /** The shared cross bucket for the pair's collateral token; null when the
   * account has no cross bucket in that token at all. */
  cross: BorosMarginBucket | null;
  /** marketId → that market's own isolated bucket, when one exists. */
  isolatedByMarket: Map<number, BorosMarginBucket>;
  /**
   * Prepaid gas the relayer spends submitting these orders, in USD — that is
   * what `Exchange.getGasBalance()` returns (`balanceInUSD`), NOT a collateral
   * amount. Boros charges it from a treasury balance topped up with
   * `payTreasury`, SEPARATELY from trading collateral, so an account with
   * plenty of margin can still be unable to send an order.
   *
   * undefined = not read; no blocker is raised, which is the right default for
   * an install that cannot place orders anyway.
   */
  gasBalanceUsd?: number | null;
}

export type BlockerCode =
  | 'ineligible-pair'
  | 'no-size'
  | 'legs-do-not-offset'
  | 'book-unavailable'
  | 'no-depth'
  | 'isolated-must-switch'
  | 'isolated-short-margin'
  | 'cross-short-margin'
  | 'margin-unknown'
  | 'no-gas'
  | 'flip-unacknowledged'
  | 'stale-simulation';

export interface PairBlocker {
  code: BlockerCode;
  message: string;
  /** Which leg it is about, when it is about one. */
  leg?: 'A' | 'B';
  /** The market it is about — what a remediation button acts on. */
  marketId?: number;
  /** The exact top-up a margin blocker needs, collateral units — the SHORTFALL
   * (required − available), never the total required (§6). */
  shortfall?: number;
}

export interface EvaluatePairInput {
  simulation: BorosPairSimulation;
  legA: BorosPairLegInput;
  legB: BorosPairLegInput;
  account: BorosPairAccountState;
  eligibility: PairEligibility;
  /** The §4 acknowledgement, ticked by the user. */
  opposingAcknowledged: boolean;
  /** When the simulation backing this confirm was produced. */
  simulatedAtMs: number;
  nowMs: number;
}

export interface PairGate {
  /** Confirm unlocks only when this is empty. */
  blockers: PairBlocker[];
  /** Non-blocking things the user must still be told at confirm (§7 TP/SL). */
  warnings: string[];
  /** True when either leg opposes an existing position — the checkbox is
   * required (§4), and its copy has to say which case it is. */
  requiresAcknowledgement: boolean;
  /** The legs that oppose, so the copy can name the market and the size. */
  opposingLegs: Array<'A' | 'B'>;
}

/**
 * Everything that stands between the user and a confirm. Margin is the subtle
 * one: §7 wants the COMBINED requirement of both legs checked rather than each
 * leg independently, but §6 forbids summing across isolated buckets because
 * those balances are not fungible. Both hold at once — cross legs pool and are
 * checked together against the cross bucket, isolated legs are each checked
 * against their own.
 */
export function evaluatePairGate(input: EvaluatePairInput): PairGate {
  const { simulation: sim, legA, legB, account } = input;
  const blockers: PairBlocker[] = [];
  const warnings: string[] = [];

  if (!input.eligibility.eligible) {
    blockers.push({
      code: 'ineligible-pair',
      message: input.eligibility.reason ?? 'These two markets cannot be paired.',
    });
  }

  const legs: Array<{ key: 'A' | 'B'; sim: SimulatedLeg; input: BorosPairLegInput }> = [
    { key: 'A', sim: sim.legA, input: legA },
    { key: 'B', sim: sim.legB, input: legB },
  ];

  if (legs.every((l) => Math.abs(l.sim.sizing.deltaSize) === 0)) {
    /**
     * "Enter a size" is wrong when a size WAS entered and reduce-only zeroed
     * it — the user is then told to do the one thing they already did, with no
     * hint that the direction is what needs changing. `clampedToClose` already
     * records exactly this, so say which market and why.
     */
    const clamped = legs.filter(
      (l) => l.sim.sizing.clampedToClose && Math.abs(l.sim.sizing.deltaSize) === 0,
    );
    const flat = clamped.filter((l) => l.sim.sizing.currentSize === 0);
    const adding = clamped.filter((l) => l.sim.sizing.currentSize !== 0);
    let message = 'Enter a size to trade.';
    if (adding.length) {
      message =
        `Close is reduce-only, and ${adding.map((l) => l.sim.marketName).join(' and ')} ` +
        `${adding.length > 1 ? 'are' : 'is'} pointed the same way as the position you hold — ` +
        'this would add to it, not reduce it. Flip the direction, or switch to Open.';
    } else if (flat.length) {
      message = `You hold nothing on ${flat.map((l) => l.sim.marketName).join(' or ')} — there is nothing to close.`;
    }
    blockers.push({ code: 'no-size', message });
  }

  if (sim.receiveLeg === null) {
    blockers.push({
      code: 'legs-do-not-offset',
      message: 'Both legs point the same way — flip one to trade a spread.',
    });
  }

  for (const { key, sim: leg, input: legIn } of legs) {
    if (Math.abs(leg.sizing.deltaSize) === 0) continue;
    if (leg.bookStatus === 'unavailable') {
      blockers.push({
        code: 'book-unavailable',
        leg: key,
        marketId: leg.marketId,
        message: `${leg.marketName}: order book unavailable — cannot price this leg.`,
      });
    } else if (leg.execApr === null) {
      blockers.push({
        code: 'no-depth',
        leg: key,
        marketId: leg.marketId,
        message: `${leg.marketName}: nothing resting on the side this leg would cross.`,
      });
    }
    if (leg.marginRequired === null && leg.execApr !== null) {
      blockers.push({
        code: 'margin-unknown',
        leg: key,
        marketId: leg.marketId,
        message: `${leg.marketName}: initial margin cannot be modelled, so margin sufficiency is unknown.`,
      });
    }
    // §6A — an isolated bucket with something in it must be emptied and the
    // market switched to cross before this pair can trade. We never switch a
    // margin mode on the user's behalf.
    if (legIn.onIsolatedMargin && legIn.isolatedHasPositionOrOrders && !legIn.isolatedOnly) {
      blockers.push({
        code: 'isolated-must-switch',
        leg: key,
        marketId: leg.marketId,
        message: `${leg.marketName} is on isolated margin with an open position/order. Switch it to cross margin to trade this pair.`,
      });
    }
    if (legIn.hasTpSl) {
      warnings.push(
        `${leg.marketName} has a TP/SL order set — if it triggers, this pair stops being hedged.`,
      );
    }
  }

  // --- Margin sufficiency --------------------------------------------------
  // §6B: an isolated-only market draws on its own bucket and cannot borrow from
  // the cross pool, so its shortfall is reported alone and never summed with
  // another bucket's.
  let crossRequired = 0;
  let crossKnown = true;
  for (const { key, sim: leg, input: legIn } of legs) {
    if (Math.abs(leg.sizing.deltaSize) === 0) continue;
    // What this leg still has to FUND: the resulting position's margin less
    // whatever it already posts (see `committedMargin`). Never negative — a leg
    // that frees margin does not lend it to the other one.
    const required =
      leg.marginRequired === null
        ? null
        : Math.max(0, leg.marginRequired - (legIn.committedMargin ?? 0));
    if (legIn.isolatedOnly) {
      const bucket = account.isolatedByMarket.get(leg.marketId);
      const available = bucket?.available ?? 0;
      if (required !== null && required > available) {
        blockers.push({
          code: 'isolated-short-margin',
          leg: key,
          marketId: leg.marketId,
          shortfall: required - available,
          message: `${leg.marketName} is isolated-only. You need ${fmtSize(required - available)} ${sim.collateral} in its account to open this leg.`,
        });
      }
      continue;
    }
    if (required === null) crossKnown = false;
    else crossRequired += required;
  }
  if (crossKnown && crossRequired > 0) {
    const available = account.cross?.available ?? 0;
    if (crossRequired > available) {
      blockers.push({
        code: 'cross-short-margin',
        shortfall: crossRequired - available,
        message: `Cross margin is short ${fmtSize(crossRequired - available)} ${sim.collateral} for both legs together.`,
      });
    }
  }

  // --- Gas ------------------------------------------------------------------
  // Distinct from margin on purpose: the remedy is `payTreasury`, not a
  // collateral top-up, and conflating them sends the user to the wrong screen.
  const gas = input.account.gasBalanceUsd;
  if (gas === null) {
    warnings.push(
      'Prepaid gas on this Boros account could not be read, so this order may still be refused for gas. ' +
        'This is gas, not trading collateral: topping up your margin will not fix it.',
    );
  } else if (gas !== undefined && gas < MIN_GAS_BALANCE_USD) {
    blockers.push({
      code: 'no-gas',
      message:
        `Prepaid gas on this Boros account is ${gas <= 0 ? 'empty' : `low, about $${gas.toFixed(2)}`} — top it up to send an order. ` +
        'This is gas, not trading collateral: topping up your margin will not fix it.',
    });
  }

  // --- §4 acknowledgement --------------------------------------------------
  const opposingLegs = legs.filter((l) => l.sim.sizing.opposing).map((l) => l.key);
  if (opposingLegs.length > 0 && !input.opposingAcknowledged) {
    blockers.push({
      code: 'flip-unacknowledged',
      message: 'Tick the acknowledgement to confirm what happens to your existing position.',
    });
  }

  // --- §7 staleness --------------------------------------------------------
  const age = input.nowMs - input.simulatedAtMs;
  if (!Number.isFinite(age) || age > SIMULATION_MAX_AGE_MS || age < 0) {
    blockers.push({
      code: 'stale-simulation',
      message: 'The simulation is out of date — waiting for a fresh quote.',
    });
  }

  return {
    blockers,
    warnings,
    requiresAcknowledgement: opposingLegs.length > 0,
    opposingLegs,
  };
}

/**
 * A collateral amount for a user-facing message.
 *
 * Fixed 2dp is wrong here: an eligible pair's collateral may be USDT (amounts
 * in the thousands) or ETH/BTC (amounts in hundredths), and "you need 0.00 ETH"
 * is worse than useless — it reads as "you need nothing" on the exact screen
 * that is blocking the trade. Scale the precision to the magnitude instead.
 */
const fmtSize = (n: number): string => {
  const abs = Math.abs(n);
  if (abs > 0 && abs < 1e-6) return '<0.000001';
  const dp = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
};

/**
 * The §4 checkbox copy. The spec's sentence describes a FLIP; a delta that
 * only reduces (or lands exactly flat) does something materially different, so
 * it gets its own wording rather than a sentence that overstates it.
 */
export function acknowledgementCopy(leg: SimulatedLeg, collateral: string): string {
  const { sizing } = leg;
  const held = fmtSize(Math.abs(sizing.currentSize));
  const heldSide = sizing.currentSize > 0 ? 'long' : 'short';
  if (sizing.flips) {
    const opened = fmtSize(Math.abs(sizing.resultingSize));
    return `I understand this closes my existing ${leg.marketName} ${heldSide} position of ${held} ${collateral}, realising its PnL, and opens ${opened} ${collateral} in the opposite direction.`;
  }
  if (sizing.resultingSize === 0) {
    return `I understand this closes my existing ${leg.marketName} ${heldSide} position of ${held} ${collateral} in full, realising its PnL.`;
  }
  const reducedTo = fmtSize(Math.abs(sizing.resultingSize));
  return `I understand this reduces my existing ${leg.marketName} ${heldSide} position of ${held} ${collateral} to ${reducedTo} ${collateral}, realising part of its PnL.`;
}
