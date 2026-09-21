/**
 * Roll-over: close a Boros pair at one maturity and re-open it at a later
 * one, as ONE all-or-nothing batch.
 *
 * The venue's own builder (`calldata-builder/agent/roll-over`) makes the four
 * orders — close A, close B, open A′, open B′, every one FOK, the closes
 * sized from the on-chain position — and they go out as a single
 * `tryAggregate` with `requireSuccess`. The venue simulates the batch before
 * submitting it (the calls run in order, in one state, so the opens are
 * checked against the margin the closes free), refuses the whole thing if
 * any call would fail, and on-chain a revert anywhere undoes everything. FOK
 * closes the last gap: an IOC leg that fills PART of its size still
 * succeeds, so `requireSuccess` alone would let the old legs close 100%
 * while the new ones open 60%. Under FOK a leg either fills whole or
 * reverts, and its revert takes the batch. A roll therefore ends in exactly
 * one of three states: rolled in full, nothing happened, or the venue never
 * confirmed (`unknown`).
 *
 * What this module does NOT do: size legs, walk books or judge each step's
 * margin — that is `simulateBorosPair` + `evaluatePairGate`, run once per
 * step by the caller. It combines the two verdicts, adds the checks that
 * only exist because the two steps are one batch, names the legs for the
 * venue, and reads its answer.
 */
import type { BorosLegFailureCode, BorosLegFill, BorosOrderClient, BorosRollLeg } from './orders';
import type { BlockerCode, BorosPairAccountState, BorosPairLegInput, BorosPairSimulation, PairGate, SimulatedLeg } from './pair';
import { SECONDS_IN_YEAR, knownRate } from './venue';

/** The post-exit margin estimate is scaled by this before it is compared
 * with what the re-entry needs: room for a fill at the bound and a mark
 * that moved while the batch was in flight. */
export const ROLL_MARGIN_HAIRCUT = 0.95;

/** Fills with a relative shortfall under this are whole (an 18-decimal size
 * does not survive a float round-trip exactly — see borosApi). */
const FULL_FILL_TOLERANCE = 1e-9;

export type RollStep = 'exit' | 'entry';
export type RollLegKey = 'exitA' | 'exitB' | 'entryA' | 'entryB';

export interface RollStepInput {
  simulation: BorosPairSimulation;
  gate: PairGate;
  legA: BorosPairLegInput;
  legB: BorosPairLegInput;
}

export interface EvaluateRollInput {
  /** The old pair, priced with intent `close`. */
  exit: RollStepInput;
  /** The new pair, priced with intent `open` at the same size. */
  entry: RollStepInput;
  account: BorosPairAccountState;
  nowSec: number;
}

export type RollBlockerCode =
  | BlockerCode
  /** The new maturity is not after the old one. */
  | 'maturity-not-later'
  /** The four markets do not share a collateral token. */
  | 'collateral-mismatch'
  /** A new leg is not the old leg's venue and underlying, one maturity later. */
  | 'market-mismatch'
  /** A new leg would not hold the side the old one holds. */
  | 'sides-mismatch'
  /** The four legs are not the same size — the exit was clamped to the position. */
  | 'size-mismatch'
  /** The book cannot fill a leg's whole size inside its rate bound; FOK would revert. */
  | 'partial-depth';

export interface RollBlocker {
  code: RollBlockerCode;
  message: string;
  step?: RollStep;
  leg?: 'A' | 'B';
  marketId?: number;
}

/**
 * The re-entry's margin, judged AFTER the exit rather than against today's
 * balance: the pair gate priced the entry before the old legs' margin was
 * freed, so its own shortfall would refuse every near-capacity roll. A
 * predicted shortfall is a warning, not a blocker — the venue judges the
 * real thing when it simulates the batch, and a refusal there executes
 * nothing.
 */
export interface RollMargin {
  /** Margin the re-entry ADDS on the new markets, collateral units. */
  need: number | null;
  /** The old legs' margin the exit frees. */
  freed: number | null;
  /** What closing realises if every leg fills at its bound, before fees. */
  worstExitPnl: number | null;
  /** The exit's taker fees. */
  exitFee: number | null;
  /** Spendable once the exit has run, after the haircut. */
  availableAfter: number | null;
  /** need − availableAfter when positive, else 0; 0 when unknown. */
  shortfall: number;
}

export interface RollGate {
  blockers: RollBlocker[];
  warnings: string[];
  margin: RollMargin;
}

const MARGIN_CODES: ReadonlySet<BlockerCode> = new Set(['cross-short-margin', 'isolated-short-margin']);
const same = (a: number, b: number): boolean => Math.abs(a - b) <= FULL_FILL_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const sum = (xs: Array<number | null>): number | null =>
  xs.every((x): x is number => x !== null) ? xs.reduce((t, x) => t + x, 0) : null;

/**
 * What a FOK order can actually take: the size resting at levels INSIDE its
 * rate bound. The venue matches level by level up to the limit tick and
 * fills nothing past it, so this is strictly per level — unlike the VWAP
 * figures (`estSlippageApr`, `sizeWithinTolerance`), which let a level past
 * the bound count as long as the average stays inside. Null without a book
 * or an anchor.
 */
export function depthWithinBound(leg: BorosPairLegInput, sim: SimulatedLeg): number | null {
  const anchor = knownRate(sim.midApr) ? sim.midApr : sim.execApr;
  if (!leg.book || anchor === null) return null;
  const { orderSide } = sim.sizing;
  const levels = orderSide === 'long' ? leg.book.asks : leg.book.bids;
  const tol = sim.slippageApr + 1e-12;
  return levels.reduce((t, [apr, size]) => {
    const adverse = orderSide === 'long' ? apr - anchor : anchor - apr;
    return adverse <= tol && size > 0 ? t + size : t;
  }, 0);
}

export function evaluateRollGate(input: EvaluateRollInput): RollGate {
  const { exit, entry } = input;
  const blockers: RollBlocker[] = [];
  const warnings = [...exit.gate.warnings, ...entry.gate.warnings];

  const prefixed = (step: RollStep, gate: PairGate, label: string): void => {
    for (const b of gate.blockers) {
      // The entry's margin was judged before the exit — replaced by `margin` below.
      if (step === 'entry' && MARGIN_CODES.has(b.code)) continue;
      blockers.push({ code: b.code, message: `${label}: ${b.message}`, step, leg: b.leg, marketId: b.marketId });
    }
  };
  prefixed('exit', exit.gate, 'Exit');
  prefixed('entry', entry.gate, 'Re-entry');

  const oldMaturity = Math.max(exit.legA.market.maturity, exit.legB.market.maturity);
  const newMaturity = Math.min(entry.legA.market.maturity, entry.legB.market.maturity);
  if (!(newMaturity > oldMaturity)) {
    blockers.push({ code: 'maturity-not-later', message: 'The new maturity must be later than the one being left.' });
  }
  if (new Set([exit.legA, exit.legB, entry.legA, entry.legB].map((l) => l.market.tokenId)).size !== 1) {
    blockers.push({ code: 'collateral-mismatch', message: 'All four legs must post the same collateral.' });
  }

  const steps = [
    { key: 'A' as const, old: exit.simulation.legA, next: entry.simulation.legA },
    { key: 'B' as const, old: exit.simulation.legB, next: entry.simulation.legB },
  ];
  for (const { key, old, next } of steps) {
    // A roll re-creates the same shape one maturity later: same venue and
    // underlying per leg, same side. Anything else is a different trade.
    if (old.venue !== next.venue || old.base.toLowerCase() !== next.base.toLowerCase()) {
      blockers.push({
        code: 'market-mismatch',
        leg: key,
        message: `${next.marketName} is not a later maturity of ${old.marketName}.`,
      });
    }
    const held = old.sizing.currentSize > 0 ? 'long' : old.sizing.currentSize < 0 ? 'short' : null;
    if (held !== null && next.sizing.orderSide !== held) {
      blockers.push({
        code: 'sides-mismatch',
        leg: key,
        message: `${next.marketName}: the new leg must be ${held}, the side ${old.marketName} holds.`,
      });
    }
    // The exit clamps to what is held; the entry must be sized to that.
    if (!same(Math.abs(old.sizing.deltaSize), Math.abs(next.sizing.deltaSize))) {
      blockers.push({
        code: 'size-mismatch',
        leg: key,
        message:
          `${old.marketName} closes ${Math.abs(old.sizing.deltaSize)} but ${next.marketName} would open ` +
          `${Math.abs(next.sizing.deltaSize)} — a roll moves one size.`,
      });
    }
  }

  // FOK: a leg that cannot fill whole inside its rate bound reverts, and
  // takes the batch with it. Judged per level, the way the venue matches —
  // `slippage-exceeds-max` is a VWAP test and can pass a book whose last
  // levels sit past the bound.
  const legs: Array<[RollStep, 'A' | 'B', BorosPairLegInput, SimulatedLeg]> = [
    ['exit', 'A', exit.legA, exit.simulation.legA],
    ['exit', 'B', exit.legB, exit.simulation.legB],
    ['entry', 'A', entry.legA, entry.simulation.legA],
    ['entry', 'B', entry.legB, entry.simulation.legB],
  ];
  for (const [step, leg, input, sim] of legs) {
    const size = Math.abs(sim.sizing.deltaSize);
    const depth = depthWithinBound(input, sim);
    if (size > 0 && depth !== null && depth < size * (1 - FULL_FILL_TOLERANCE)) {
      blockers.push({
        code: 'partial-depth',
        step,
        leg,
        marketId: sim.marketId,
        message:
          `${step === 'exit' ? 'Exit' : 'Re-entry'}: ${sim.marketName} has ${depth} of ${size} inside the rate bound — ` +
          'a roll fills whole or not at all; widen the tolerance or reduce the size.',
      });
    }
  }

  const margin = rollMargin(input);
  if (margin.shortfall > 0) {
    warnings.push(
      `The re-entry needs about ${margin.shortfall.toFixed(4)} ${entry.simulation.collateral} more than the exit ` +
        'is expected to leave spendable. The venue checks the real figure and refuses the whole roll if it is short.',
    );
  }
  // Account-level notices (gas) come from both steps' gates; say them once.
  return { blockers, warnings: [...new Set(warnings)], margin };
}

/**
 * The CROSS pool, which every leg of this panel's pairs draws on:
 *   available now
 *   + the old legs' margin the exit frees (this slice's share of it)
 *   + what the exit realises, priced at the WORST rate its bounds allow
 *   − the exit's own taker fees
 * then the haircut. An isolated-only market keeps its own bucket, which the
 * exit cannot feed (§6B), so such a leg is judged alone against it and its
 * shortfall added. Unknown when any input is.
 */
export function rollMargin({ exit, entry, account, nowSec }: EvaluateRollInput): RollMargin {
  const share = (delta: number, base: number): number => (base > 0 ? Math.min(1, Math.abs(delta) / base) : 0);
  // What a trade ADDS: `marginRequired` is quoted on the resulting netted
  // position (open 0.4 on 42 held answers for 42.4), so scale it by the
  // share of that position this trade opens.
  const added = (l: SimulatedLeg): number | null =>
    l.marginRequired === null ? null : l.marginRequired * share(l.sizing.deltaSize, Math.abs(l.sizing.resultingSize));
  const newLegs = [
    { sim: entry.simulation.legA, input: entry.legA },
    { sim: entry.simulation.legB, input: entry.legB },
  ];
  const oldLegs = [
    { sim: exit.simulation.legA, input: exit.legA },
    { sim: exit.simulation.legB, input: exit.legB },
  ];
  const cross = <T extends { input: BorosPairLegInput }>(legs: T[]): T[] => legs.filter((l) => !l.input.isolatedOnly);

  const need = sum(cross(newLegs).map((l) => added(l.sim)));
  const freed = sum(cross(oldLegs).map(({ sim, input }) => (input.committedMargin ?? 0) * share(sim.sizing.deltaSize, Math.abs(sim.sizing.currentSize))));
  // Closing realises the locked rate against the rate the close fills at,
  // over what is left of the old term: a LONG (pays fixed) gains when the
  // rate rose, a SHORT (receives fixed) when it fell.
  const worstExitPnl = sum(
    cross(oldLegs).map(({ sim, input }) => {
      const locked = input.positionApr;
      if (locked === undefined || !Number.isFinite(locked) || sim.worstApr === null || sim.sizing.deltaSize === 0) return null;
      const years = Math.max(0, input.market.maturity - nowSec) / SECONDS_IN_YEAR;
      const held = sim.sizing.currentSize > 0 ? 'long' : 'short';
      return (held === 'long' ? sim.worstApr - locked : locked - sim.worstApr) * Math.abs(sim.sizing.deltaSize) * years;
    }),
  );
  const exitFee = cross(oldLegs).reduce((t, l) => t + l.sim.takerFeeCost, 0);
  const available = account.cross?.available ?? null;
  const availableAfter =
    available !== null && freed !== null && worstExitPnl !== null
      ? Math.max(0, (available + freed + worstExitPnl - exitFee) * ROLL_MARGIN_HAIRCUT)
      : null;
  const crossShort = need !== null && availableAfter !== null ? Math.max(0, need - availableAfter) : 0;
  const isolatedShort = newLegs
    .filter((l) => l.input.isolatedOnly)
    .reduce((t, l) => t + Math.max(0, (added(l.sim) ?? 0) - (account.isolatedByMarket.get(l.sim.marketId)?.available ?? 0)), 0);
  return { need, freed, worstExitPnl, exitFee, availableAfter, shortfall: crossShort + isolatedShort };
}

export type RollOrderIds = Record<RollLegKey, string>;

/**
 * The two legs as the venue's builder takes them: the size each old leg
 * closes (the venue caps it at the position again, in its own units) and
 * each order's rate bound. Null when a leg has nothing to trade: a batch
 * missing a leg is not a roll, and must not be sent.
 */
export function rollLegsFor(exit: BorosPairSimulation, entry: BorosPairSimulation): BorosRollLeg[] | null {
  const legs = (['legA', 'legB'] as const).map((key): BorosRollLeg | null => {
    const close = exit[key];
    const open = entry[key];
    const size = Math.abs(close.sizing.deltaSize);
    if (size === 0 || close.execApr === null || open.execApr === null) return null;
    return {
      fromMarketId: close.marketId,
      toMarketId: open.marketId,
      size,
      closeRate: close.worstApr ?? undefined,
      openRate: open.worstApr ?? undefined,
    };
  });
  return legs.every((l): l is BorosRollLeg => l !== null) ? legs : null;
}

export interface BorosRollResult {
  /**
   * `rolled`: every leg filled whole. `refused`: the venue turned the batch
   * away and nothing traded — safe to fix and resend. `unknown`: the venue
   * never confirmed, or reported fills FOK cannot produce; the position must
   * be checked on Boros before anything is resent.
   */
  status: 'rolled' | 'refused' | 'unknown';
  legs: Record<RollLegKey, BorosLegFill>;
  /** Why, for `refused` and `unknown`; the leg the venue named, when it named one. */
  reason: { code: BorosLegFailureCode; message: string; leg: RollLegKey | null } | null;
  /** Collateral units moved to the new maturity; 0 unless `rolled`. */
  rolledSize: number;
}

const KEYS: RollLegKey[] = ['exitA', 'exitB', 'entryA', 'entryB'];

/**
 * Fire the batch and read the answer. A throw is folded into `unknown`:
 * the transport gave no verdict, so the fill state is genuinely uncertain.
 * A refusal with a status code never reaches here as a throw — the venue
 * adapter reports it as failed legs, because nothing ran.
 */
export async function submitBorosRoll(client: BorosOrderClient, legs: BorosRollLeg[]): Promise<BorosRollResult> {
  let fills: BorosLegFill[];
  try {
    fills = client.rollOver ? await client.rollOver(legs) : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lost = (marketId: number, direction: 'long' | 'short', size: number): BorosLegFill => ({
      marketId,
      direction,
      filledSize: 0,
      shortfallSize: size,
      execApr: null,
      feeSize: null,
      failure: { code: 'unknown', message: `${message} — the roll may or may not have gone through. Check the position on Boros before re-issuing.` },
    });
    fills = [...legs.map((l) => lost(l.fromMarketId, 'short', l.size)), ...legs.map((l) => lost(l.toMarketId, 'long', l.size))];
  }
  return readRollFills(fills);
}

/** The venue's four answers as one verdict. Exported for the tests. */
export function readRollFills(fills: BorosLegFill[]): BorosRollResult {
  const legs = Object.fromEntries(KEYS.map((k, i) => [k, fills[i]])) as Record<RollLegKey, BorosLegFill>;
  const entries = KEYS.map((k) => [k, legs[k]] as const);
  const missing = entries.find(([, f]) => f === undefined);
  if (missing) {
    return { status: 'unknown', legs, reason: { code: 'unknown', message: `no result came back for ${missing[0]}`, leg: missing[0] }, rolledSize: 0 };
  }
  const reasonOf = (code: BorosLegFailureCode) => {
    const named = entries.find(([, f]) => f.failure?.code === code && f.failure.cause === 'this-leg');
    const any = entries.find(([, f]) => f.failure?.code === code)!;
    return { code, message: (named ?? any)[1].failure!.message, leg: named ? named[0] : null };
  };
  const unknown = entries.find(([, f]) => f.failure?.code === 'unknown');
  if (unknown) return { status: 'unknown', legs, reason: reasonOf('unknown'), rolledSize: 0 };
  const failed = entries.find(([, f]) => f.failure !== null);
  if (failed) return { status: 'refused', legs, reason: reasonOf(failed[1].failure!.code), rolledSize: 0 };
  // Only whole fills exist under FOK. Anything else is a venue answer this
  // module cannot interpret, and the position has to be looked at.
  const whole = fills.every((f) => f.filledSize > 0 && f.shortfallSize <= FULL_FILL_TOLERANCE * f.filledSize);
  if (!whole) {
    return {
      status: 'unknown',
      legs,
      reason: { code: 'unknown', message: 'The venue reported a fill FOK legs cannot produce. Check the position on Boros before re-issuing.', leg: null },
      rolledSize: 0,
    };
  }
  return { status: 'rolled', legs, reason: null, rolledSize: Math.min(...fills.map((f) => f.filledSize)) };
}
