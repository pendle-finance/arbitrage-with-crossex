/**
 * How big a roll can be, and what tolerance it needs — pure arithmetic over
 * the depth ladders the server quotes per leg (`BorosSimulatedLeg.depth`).
 *
 * A roll's four orders are FOK limits at mid ± tolerance: each fills whole
 * inside its bound or the batch is refused. So for one leg, "does size s
 * fill at tolerance t" is exactly "do the levels whose own rate sits inside
 * t hold s" — a lookup on the ladder, no round trip. Three questions follow:
 *
 *   capacityAt(t)      how much fills at tolerance t
 *   toleranceFor(s)    the narrowest tolerance at which s fills
 *   planBatch(...)     the tolerance a batch should carry for s, or why no
 *                      tolerance can carry it
 */
import type { BorosLegSizing, BorosPairLegBody, BorosPairSimulation, BorosSimulatedLeg, Rebate } from '../../api/types';
import { rebatedSettleApr } from '../../lib/rebate';
import { SECONDS_IN_YEAR, entryAprOf, type PairLegDetail } from './assetModel';

/** `[adverse distance from mid, cumulative size]`, best-first. */
export type DepthLadder = ReadonlyArray<readonly [number, number]>;

/** What sizing reads off a quoted leg. Structural, so the server's own
 * `SimulatedLeg` fits as well as the client's `BorosSimulatedLeg` — the
 * Telegram probe sizes with these same functions. */
export type LadderLeg = Pick<BorosSimulatedLeg, 'marketName' | 'depth' | 'maxToleranceApr'>;

/** Float noise allowed when a figure sits exactly on a level. */
const EPS = 1e-9;

/**
 * Kept back from the book's capacity when SUGGESTING a size. A size equal to
 * the capacity sits on a razor's edge — the levels were summed from a quote a
 * few seconds old, and one cancelled 0.01 refuses the whole FOK batch (his
 * catch 2026-09-22: a suggested 389.943132 ETH was the exact sum of the five
 * levels inside the bound, and flickered between filling and "Insufficient
 * liquidity"). Applied to the CAPACITY, never to the position: a book that
 * holds the position with this much to spare still suggests 100%.
 */
export const ROLL_FIT_BUFFER = 0.05;

/** Headroom on an auto-widened tolerance, so a mid that drifts a tick between
 * the quote and the order does not push the needed level back outside. */
const TOLERANCE_HEADROOM = 1.1;
/** Tolerances are shown to 0.01% APR; an auto one is rounded UP to that. */
const TOLERANCE_STEP = 0.0001;

/**
 * How much of the venue's band an AUTO tolerance may use. The band hangs off
 * mark and the bound off mid, and both drift between the quote and the order:
 * a tolerance set to the band's very edge tripped the gate's own
 * `rate-bound-out-of-range` a moment later ("6.12% is outside 3.67%–6.12%",
 * his catch 2026-09-22). A tenth of the room is kept back.
 */
const BAND_USE = 0.9;

/** The widest tolerance a leg may carry: the venue's band (less the margin
 * above), under the app's cap. */
const allowedOf = (leg: LadderLeg, capApr: number): number =>
  Math.min(capApr, typeof leg.maxToleranceApr === 'number' ? leg.maxToleranceApr * BAND_USE : capApr);

/** How much fills at `tolerance`: the levels whose own rate sits inside it. */
export function capacityAt(depth: DepthLadder, tolerance: number): number {
  let filled = 0;
  for (const [adverse, cum] of depth) {
    if (adverse > tolerance + EPS) break;
    filled = cum;
  }
  return filled;
}

/** The narrowest tolerance at which `size` fills: the distance of the deepest
 * level it has to reach. Null when the whole book cannot supply it. */
export function toleranceFor(depth: DepthLadder, size: number): number | null {
  if (!(size > 0)) return 0;
  for (const [adverse, cum] of depth) {
    if (cum + EPS * Math.max(1, size) >= size) return Math.max(0, adverse);
  }
  return null;
}

/**
 * The most that fills across all four legs at the WIDEST tolerance the roll
 * may carry: each batch's shared band (the tighter leg's, as `planBatch`
 * judges it), under the app's cap. Null until every leg carries a ladder.
 *
 * The default roll size is sized off this, not off the seed. `planBatch`
 * widens a batch's tolerance for any size the band reaches, so the seed was
 * never the limit — sizing at it let one stray level decide: a 0.01 ETH ask
 * at 0.37% ahead of 1,000 ETH at 1.10% under a 1.0% seed defaulted the roll
 * to 0.0095 ETH of an 870 ETH pair (his catch 2026-09-23).
 */
export function fitAtBand(
  exitLegs: ReadonlyArray<LadderLeg>,
  entryLegs: ReadonlyArray<LadderLeg>,
  capApr: number,
): number | null {
  const fits = [exitLegs, entryLegs].map((legs) => fitLegsAtBand(legs, capApr));
  return fits.some((f) => f === null) ? null : Math.min(...(fits as number[]));
}

/**
 * The most that fills across ONE batch's two legs at the widest tolerance it
 * may carry: their shared band (the tighter leg's), under the app's cap. Null
 * until both legs carry a ladder. The entry-only sizing an open-only roll
 * needs — it closes nothing, so there is no exit batch to bind the size.
 */
export function fitLegsAtBand(legs: ReadonlyArray<LadderLeg>, capApr: number): number | null {
  if (legs.length === 0 || legs.some((l) => !Array.isArray(l.depth))) return null;
  const band = Math.min(...legs.map((l) => allowedOf(l, capApr)));
  return Math.min(...legs.map((l) => capacityAt(l.depth as DepthLadder, band)));
}

/** The size to suggest for a position of `held`, off a book that fills
 * `capacity` inside tolerance: the capacity less the buffer, or the whole
 * position when that still covers it. */
export function suggestedRollSize(capacity: number, held: number): number {
  return Math.max(0, Math.min(held, capacity * (1 - ROLL_FIT_BUFFER)));
}

export type BatchLimit =
  /** A leg's whole book cannot supply the size, at any rate. */
  | { kind: 'liquidity'; marketName: string; maxSize: number }
  /** A leg's book holds the size, but only past the venue's rate band. */
  | { kind: 'rate-limit'; marketName: string; maxSize: number };

export interface BatchPlan {
  /** The per-leg tolerance the batch should carry, as an APR fraction: the
   * seed while the size fills inside it, wider when the size needs it and the
   * venue's band allows it. */
  toleranceApr: number;
  /** True when `toleranceApr` was raised above the seed to fit the size. */
  widened: boolean;
  /** Why no tolerance can carry this size — null when one can. */
  limit: BatchLimit | null;
}

/**
 * The tolerance ONE batch (its two legs share one) should carry for `size`.
 *
 * Slippage is never the trader's problem to solve by hand: while widening the
 * tolerance makes the size fill and the venue's rate band still allows the
 * bound, it is widened for them (his call 2026-09-22). What cannot be fixed
 * that way is reported as a `limit`, with the most that WOULD roll:
 *   liquidity   the book does not hold the size at any rate
 *   rate-limit  the book holds it, but only past the venue's max rate deviation
 *
 * Null until both legs carry a ladder — nothing to plan against yet.
 */
export function planBatch(
  legs: ReadonlyArray<LadderLeg>,
  size: number,
  seedApr: number,
  capApr: number,
): BatchPlan | null {
  if (legs.length === 0 || legs.some((l) => !Array.isArray(l.depth))) return null;
  // The two legs carry ONE tolerance, so the band that binds is the tighter
  // leg's: a leg judged against its own, wider band would pass a size the
  // shared bound cannot reach, and the venue would refuse the batch with no
  // limit ever shown (the Gate / Hyperliquid pair, whose bands differ ~2x).
  const allowedBatch = Math.min(...legs.map((l) => allowedOf(l, capApr)));
  let needed = 0;
  let limit: BatchLimit | null = null;
  for (const leg of legs) {
    const depth = leg.depth as DepthLadder;
    const maxSize = capacityAt(depth, allowedBatch);
    const need = toleranceFor(depth, size);
    const found: BatchLimit | null =
      need === null
        ? { kind: 'liquidity', marketName: leg.marketName, maxSize }
        : need > allowedBatch + EPS
          ? { kind: 'rate-limit', marketName: leg.marketName, maxSize }
          : null;
    // The tightest leg names the limit: it is the one that decides the size.
    if (found !== null && (limit === null || found.maxSize < limit.maxSize)) limit = found;
    if (need !== null) needed = Math.max(needed, need);
  }
  // The seed while the size fills inside it; otherwise what the size needs,
  // with headroom, rounded UP to a displayable step.
  let toleranceApr =
    needed <= seedApr + EPS ? seedApr : Math.ceil((needed * TOLERANCE_HEADROOM) / TOLERANCE_STEP - EPS) * TOLERANCE_STEP;
  // Never past the venue's band — rounded DOWN into it, but not below what
  // the size needs (the headroom is what gives way, not the fill).
  if (toleranceApr > allowedBatch + EPS) {
    const inside = Math.floor(allowedBatch / TOLERANCE_STEP + EPS) * TOLERANCE_STEP;
    toleranceApr = inside + EPS >= needed ? inside : allowedBatch;
  }
  // A band with no room at all leaves nothing to choose; the gate says so.
  if (!(toleranceApr > 0)) toleranceApr = seedApr;
  return { toleranceApr: Number(toleranceApr.toFixed(6)), widened: toleranceApr > seedApr + EPS, limit };
}

/** The most that rolls across BOTH batches when one of them hit a limit. */
export function maxRollSize(limits: ReadonlyArray<BatchLimit | null>): number | null {
  const sizes = limits.filter((l): l is BatchLimit => l !== null).map((l) => l.maxSize);
  return sizes.length > 0 ? Math.min(...sizes) : null;
}

export type HeldRollLeg = Pick<
  PairLegDetail,
  'kind' | 'venue' | 'side' | 'sizeToken' | 'lockedApr' | 'maturity' | 'marketId' | 'spreadVenues' | 'imUsd'
>;

interface RollPairShape<L extends HeldRollLeg> {
  longVenue: string;
  shortVenue: string;
  legs: ReadonlyArray<L>;
}

const sameVenue = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function pairExposure(pair: RollPairShape<HeldRollLeg>): { long: number; short: number } {
  let long = 0;
  let short = 0;
  for (const l of pair.legs) {
    if (l.kind !== 'yu') continue;
    if (l.spreadVenues) {
      long += l.sizeToken;
      short += l.sizeToken;
    } else if (sameVenue(l.venue, pair.longVenue)) long += l.sizeToken;
    else if (sameVenue(l.venue, pair.shortVenue)) short += l.sizeToken;
  }
  return { long, short };
}

export function pairRollGeometry<L extends HeldRollLeg>(
  pair: RollPairShape<L>,
): { yuLegs: L[]; heldSize: number; exposure: { long: number; short: number }; pairPerpImUsd: number } {
  const yuLegs = pair.legs.filter((l) => l.kind === 'yu');
  const exposure = pairExposure(pair);
  return {
    yuLegs,
    heldSize: Math.max(exposure.long, exposure.short),
    exposure,
    pairPerpImUsd: pair.legs.filter((l) => l.kind === 'perp').reduce((t, l) => t + l.imUsd, 0),
  };
}

export const rollPart = (own: number, size: number, heldSize: number): number =>
  size >= heldSize ? own : size * (own / heldSize);

export function exitLegBodies({
  pair,
  slippageApr,
  size,
}: {
  pair: RollPairShape<HeldRollLeg>;
  slippageApr: number;
  size: number;
}): BorosPairLegBody[] | null {
  const { yuLegs, heldSize } = pairRollGeometry(pair);
  if (!(size > 0) || yuLegs.length === 0) return null;
  const legs: BorosPairLegBody[] = [];
  for (const l of yuLegs) {
    if (l.marketId === undefined) return null;
    legs.push({
      marketId: l.marketId,
      direction: l.side === 'LONG' ? 'short' : 'long',
      slippageApr,
      size: rollPart(l.sizeToken, size, heldSize),
    });
  }
  return legs;
}

export function inRollUnits<L extends LadderLeg>(
  legs: ReadonlyArray<L>,
  bodies: ReadonlyArray<Pick<BorosPairLegBody, 'size'>> | null,
  heldSize: number,
): L[] {
  return legs.map((l, i) => {
    const ratio = bodies?.[i] && heldSize > 0 ? bodies[i].size / heldSize : 1;
    if (!(ratio > 0) || ratio === 1 || !Array.isArray(l.depth)) return l;
    return { ...l, depth: l.depth.map(([adverse, cum]): [number, number] => [adverse, cum / ratio]) };
  });
}

export const ROLL_OPPORTUNITY_SHARE = 0.2;

export interface RollProbeResult {
  ok: boolean;
  rate: number | null;
  size: number;
}

export interface RollOpportunity {
  maturity: number;
  rate: number;
  current: number;
  currentMaturity: number;
  size: number;
}

export function rollOpportunities(
  probes: Record<number, RollProbeResult>,
  targets: ReadonlyArray<{ maturity: number }>,
  current: number | null,
  currentMaturity: number,
): RollOpportunity[] {
  if (current === null) return [];
  const found: RollOpportunity[] = [];
  for (const t of targets) {
    const r = probes[t.maturity];
    if (!r || !r.ok || r.rate === null || !(r.rate > current)) continue;
    found.push({ maturity: t.maturity, rate: r.rate, current, currentMaturity, size: r.size });
  }
  return found.sort((a, b) => b.rate - a.rate);
}

export interface RollRateInputs {
  perpExitUsd: number | null;
  shareOf: (size: number) => number;
  rebateApr: (marketIds: number[]) => number;
}

export const NO_ROLL_RATE_INPUTS: RollRateInputs = { perpExitUsd: 0, shareOf: () => 0, rebateApr: () => 0 };

export function rollRebateApr(
  settleOf: (marketId: number) => number,
  rebate: Rebate | null,
  marketIds: ReadonlyArray<number>,
): number {
  if (!rebate) return 0;
  return marketIds.reduce((sum, id) => sum + settleOf(id) - rebatedSettleApr(settleOf(id), rebate, id), 0);
}

type RollSimLeg = Pick<BorosSimulatedLeg, 'marketId' | 'marginRequired' | 'execApr' | 'worstApr' | 'estFillSize'> & {
  sizing: Pick<BorosLegSizing, 'resultingSize' | 'deltaSize'>;
};

export type RollSim = Pick<BorosPairSimulation, 'collateralPriceUsd' | 'costToCrossSize' | 'estSpreadApr'> & {
  legs: ReadonlyArray<RollSimLeg>;
};

export function addedMarginOf(sim: RollSim | null | undefined): number | null {
  if (!sim) return null;
  let total = 0;
  for (const leg of sim.legs) {
    if (leg.marginRequired === null) return null;
    const result = Math.abs(leg.sizing.resultingSize);
    const delta = Math.abs(leg.sizing.deltaSize);
    if (!(delta > 0)) continue;
    total += result > 0 ? leg.marginRequired * Math.min(1, delta / result) : leg.marginRequired;
  }
  return total;
}

export interface ExitPnlLeg {
  venue: string;
  side: 'LONG' | 'SHORT';
  lockedApr: number;
  execApr: number | null;
  pnl: number | null;
}

export function exitPnlOf(
  sim: RollSim | null | undefined,
  heldLegs: ReadonlyArray<HeldRollLeg>,
  nowSec: number,
  at: 'exec' | 'worst' = 'exec',
): { legs: ExitPnlLeg[]; total: number | null } {
  const one = (s: RollSimLeg | undefined, l: HeldRollLeg | undefined): ExitPnlLeg | null => {
    if (!s || !l || l.lockedApr === null) return null;
    const locked = entryAprOf(l.side, l.lockedApr);
    const years = Math.max(0, l.maturity - nowSec) / SECONDS_IN_YEAR;
    const rate = at === 'worst' ? s.worstApr : s.execApr;
    const pnl = rate !== null ? (l.side === 'LONG' ? rate - locked : locked - rate) * s.estFillSize * years : null;
    return { venue: l.venue, side: l.side, lockedApr: locked, execApr: rate, pnl };
  };
  const legs = (sim?.legs ?? []).map((s, i) => one(s, heldLegs[i])).filter((x): x is ExitPnlLeg => x !== null);
  const total = legs.length > 0 && legs.every((x) => x.pnl !== null) ? legs.reduce((a, x) => a + (x.pnl ?? 0), 0) : null;
  return { legs, total };
}

export interface RollFigures {
  netRate: number | null;
  spreadApr: number | null;
  netByMaturityUsd: number | null;
  grossByMaturityUsd: number | null;
  totalCostUsd: number | null;
  exitCostUsd: number | null;
  entryCostUsd: number | null;
  exitPnlUsd: number | null;
  capitalUsd: number | null;
  newBorosImUsd: number | null;
}

export function rollFigures({
  entrySim,
  exitSim,
  size,
  perpImUsd,
  maturity,
  heldLegs,
  nowSec,
  keepOld = false,
  rates = NO_ROLL_RATE_INPUTS,
}: {
  entrySim: RollSim | undefined;
  exitSim: RollSim | undefined;
  size: number;
  perpImUsd: number;
  maturity: number;
  heldLegs: ReadonlyArray<HeldRollLeg>;
  nowSec: number;
  keepOld?: boolean;
  rates?: RollRateInputs;
}): RollFigures {
  const termYears = Math.max(0, maturity - nowSec) / SECONDS_IN_YEAR;
  const px = entrySim?.collateralPriceUsd ?? exitSim?.collateralPriceUsd ?? null;
  const usdOf = (tokens: number | null | undefined): number | null =>
    tokens === null || tokens === undefined || px === null || !(px > 0) ? null : tokens * px;

  const newBorosImUsd = usdOf(addedMarginOf(entrySim));
  const capitalUsd = newBorosImUsd !== null ? perpImUsd + newBorosImUsd : null;
  const exitCostUsd = keepOld ? 0 : usdOf(exitSim?.costToCrossSize);
  const entryCostUsd = usdOf(entrySim?.costToCrossSize);
  const exitPnlUsd = keepOld ? 0 : usdOf(exitPnlOf(exitSim, heldLegs, nowSec).total);
  const totalCostUsd = exitCostUsd !== null && entryCostUsd !== null ? exitCostUsd + entryCostUsd : null;
  const perpExitUsd = rates.perpExitUsd === null ? null : rates.perpExitUsd * rates.shareOf(size);
  const allCostUsd = totalCostUsd !== null && perpExitUsd !== null ? totalCostUsd + perpExitUsd : null;
  const dragApr =
    allCostUsd !== null && capitalUsd !== null && capitalUsd > 0 && termYears > 0 ? allCostUsd / capitalUsd / termYears : null;

  const rolledNotionalUsd = usdOf(size) ?? 0;
  const spreadApr =
    entrySim?.estSpreadApr != null ? entrySim.estSpreadApr + rates.rebateApr(entrySim.legs.map((l) => l.marketId)) : null;
  const carryPerYearUsd = spreadApr !== null && rolledNotionalUsd > 0 ? spreadApr * rolledNotionalUsd : null;
  const rateOnCapital = carryPerYearUsd !== null && capitalUsd !== null && capitalUsd > 0 ? carryPerYearUsd / capitalUsd : null;
  const exitPnlApr =
    exitPnlUsd !== null && capitalUsd !== null && capitalUsd > 0 && termYears > 0 ? exitPnlUsd / capitalUsd / termYears : null;
  const netRate =
    perpExitUsd === null
      ? null
      : rateOnCapital !== null && dragApr !== null && exitPnlApr !== null
        ? rateOnCapital - dragApr + exitPnlApr
        : rateOnCapital;
  const grossByMaturityUsd = carryPerYearUsd !== null ? carryPerYearUsd * termYears : null;
  const netByMaturityUsd =
    grossByMaturityUsd !== null && allCostUsd !== null && exitPnlUsd !== null
      ? grossByMaturityUsd - allCostUsd + exitPnlUsd
      : null;

  return {
    netRate,
    spreadApr,
    netByMaturityUsd,
    grossByMaturityUsd,
    totalCostUsd,
    exitCostUsd,
    entryCostUsd,
    exitPnlUsd,
    capitalUsd,
    newBorosImUsd,
  };
}
