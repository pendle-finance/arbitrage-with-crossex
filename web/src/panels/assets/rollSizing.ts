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
import type { BorosSimulatedLeg } from '../../api/types';

/** `[adverse distance from mid, cumulative size]`, best-first. */
export type DepthLadder = ReadonlyArray<readonly [number, number]>;

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
const allowedOf = (leg: BorosSimulatedLeg, capApr: number): number =>
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
 * The most that fills across all four legs with each batch at its own
 * tolerance (never past a leg's band). Null until every leg carries a ladder.
 */
export function fitAcross(
  exitLegs: ReadonlyArray<BorosSimulatedLeg>,
  entryLegs: ReadonlyArray<BorosSimulatedLeg>,
  exitToleranceApr: number,
  entryToleranceApr: number,
  capApr: number,
): number | null {
  const all = [...exitLegs.map((l) => [l, exitToleranceApr] as const), ...entryLegs.map((l) => [l, entryToleranceApr] as const)];
  if (all.length !== 4 || all.some(([l]) => !Array.isArray(l.depth))) return null;
  return Math.min(...all.map(([l, tol]) => capacityAt(l.depth as DepthLadder, Math.min(tol, allowedOf(l, capApr)))));
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
  legs: ReadonlyArray<BorosSimulatedLeg>,
  size: number,
  seedApr: number,
  capApr: number,
): BatchPlan | null {
  if (legs.length === 0 || legs.some((l) => !Array.isArray(l.depth))) return null;
  let needed = 0;
  let limit: BatchLimit | null = null;
  for (const leg of legs) {
    const depth = leg.depth as DepthLadder;
    const allowed = allowedOf(leg, capApr);
    const maxSize = capacityAt(depth, allowed);
    const need = toleranceFor(depth, size);
    const found: BatchLimit | null =
      need === null
        ? { kind: 'liquidity', marketName: leg.marketName, maxSize }
        : need > allowed + EPS
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
  const allowedBatch = Math.min(...legs.map((l) => allowedOf(l, capApr)));
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
