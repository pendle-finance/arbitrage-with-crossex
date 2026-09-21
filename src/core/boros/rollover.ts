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
 * What this module does NOT do: size legs, walk books or judge margin —
 * each step is priced by `simulateBorosPair` + `evaluatePairGate`, and the
 * batch as a whole by the venue's own preview (`simulations/roll-over`),
 * which runs the four orders in order on one account state and is the only
 * thing that can say whether a FOK fills whole and whether the account
 * still clears its initial margin once the closes have freed theirs. This
 * module combines those verdicts, adds the checks that only exist because
 * the two steps are one batch, names the legs for the venue, and reads its
 * answer.
 */
import { classifyLegFailure } from './orders';
import type { BorosLegFailureCode, BorosLegFill, BorosOrderClient, BorosRollLeg, BorosRollSimulation } from './orders';
import { fmtSize } from './pair';
import type { BlockerCode, BorosPairLegInput, BorosPairSimulation, PairGate, SimulatedLeg } from './pair';

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
  /** The venue's preview of the batch; null when it could not be obtained. */
  venue: BorosRollSimulation | null;
  /** Why the preview could not be obtained, when the call itself failed. */
  venueError?: string | null;
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
  /** The venue could not preview the batch, so nothing can vouch for it. */
  | 'roll-unpriced'
  /** The venue's preview refuses the batch — a leg the book cannot fill whole, or margin. */
  | 'venue-refused';

export interface RollBlocker {
  code: RollBlockerCode;
  message: string;
  step?: RollStep;
  leg?: 'A' | 'B';
  marketId?: number;
}

/**
 * The account's margin around the batch, as the venue simulated it: the
 * pair gate priced the re-entry before the old legs' margin was freed, so
 * its own margin blockers are replaced by this. Collateral units.
 */
export interface RollMargin {
  /** Initial margin the opens require, with the account's leverage. */
  need: number | null;
  /** Initial margin spendable before the batch. */
  availableBefore: number | null;
  /** …and after it; negative means the venue refuses the batch for margin. */
  availableAfter: number | null;
  /** …and between the closes and the opens: what the opens are judged on.
   * The figure a refused batch still has, when the venue reports it. */
  availableAfterExit: number | null;
  /** How far short of the opens' margin the account is: −availableAfter when
   * that is negative; on a batch the venue refused for margin without an
   * after-state, `need − availableAfterExit`; else 0; 0 when unknown. */
  shortfall: number;
}

export interface RollGate {
  blockers: RollBlocker[];
  warnings: string[];
  margin: RollMargin;
}

const MARGIN_CODES: ReadonlySet<BlockerCode> = new Set(['cross-short-margin', 'isolated-short-margin']);
/** The venue's margin refusals: its own post-batch check (`INSUFFICIENT_MARGIN`)
 * and the contract's revert mid-batch (`MM_INSUFFICIENT_IM`). */
const VENUE_MARGIN_CODE = /INSUFFICIENT_(MARGIN|IM)\b/;
const same = (a: number, b: number): boolean => Math.abs(a - b) <= FULL_FILL_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const sum = (xs: Array<number | null>): number | null =>
  xs.every((x): x is number => x !== null) ? xs.reduce((t, x) => t + x, 0) : null;

/**
 * Why the venue refused ONE leg, in the trader's terms, with that cause's own
 * remedy.
 *
 * ⚠ The venue's "Insufficient liquidity" is `MarketOrderFOKNotFilled`: the
 * whole size did not fill INSIDE THE RATE BOUND. That is two different
 * problems with two different remedies, and the venue's wording names the
 * rarer one. Measured live 2026-09-22: a 670 ETH leg was refused
 * "Insufficient liquidity" against 7,136 ETH of book — only 390 of it sat
 * inside the 1% bound. So the leg's own book walk decides which it is: a book
 * that cannot supply the size at ANY rate is liquidity; one that can, but not
 * inside the bound, is slippage. Every other cause keeps the venue's words.
 */
function refusalCause(error: string, sim: SimulatedLeg | null, collateral: string): string {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  switch (classifyLegFailure(error)) {
    case 'insufficient-depth': {
      if (sim === null || sim.shortfallSize > 0 || sim.bookStatus !== 'ok') {
        return sim !== null && sim.bookStatus !== 'unavailable'
          ? `Insufficient liquidity: the whole book holds ${fmtSize(sim.estFillSize)} ${collateral}. Reduce the size.`
          : 'Insufficient liquidity. Reduce the size.';
      }
      // Widening only helps while the venue's rate band has room for the
      // bound. When even the widest tolerance the band allows does not hold
      // the size, the band is what binds — and "widen" would be wrong advice.
      const size = Math.abs(sim.sizing.deltaSize);
      if (sim.depth !== null && sim.maxToleranceApr !== null) {
        let withinBand = 0;
        for (const [adverse, cum] of sim.depth) {
          if (adverse > sim.maxToleranceApr) break;
          withinBand = cum;
        }
        if (withinBand < size) {
          return `Rate limit exceeded: only ${fmtSize(withinBand)} ${collateral} fills inside the venue's max rate deviation. Reduce the size.`;
        }
      }
      // Only when this side's book AGREES it is short: one that has moved
      // since it was read has nothing truthful to add (nerax1s, e79d672).
      return sim.sizeWithinTolerance !== null && sim.sizeWithinTolerance < size
        ? `Slippage too high: only ${fmtSize(sim.sizeWithinTolerance)} ${collateral} fills inside the ${pct(sim.slippageApr)} tolerance. Widen the tolerance or reduce the size.`
        : 'Slippage too high: the size does not fill inside the tolerance. Widen the tolerance or reduce the size.';
    }
    case 'rate-deviation':
      return `Rate limit exceeded (${error}): the rate sits too far from the venue's mark. Reduce the size.`;
    case 'insufficient-margin':
      return `${error}. Add margin or roll a smaller size.`;
    case 'no-gas':
      return `${error}. Top up the gas balance.`;
    default:
      return `${error}.`;
  }
}

export function evaluateRollGate(input: EvaluateRollInput): RollGate {
  const { exit, entry, venue } = input;
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
  const stepBlockers = [...blockers];

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

  // The venue's preview is the only judge of the batch as a whole: FOK fills
  // are decided level by level up to the bound, and the opens' margin only
  // after the closes have freed theirs.
  const legs = [exit.simulation.legA, exit.simulation.legB, entry.simulation.legA, entry.simulation.legB];
  const marketName = (marketId: number): string =>
    legs.find((l) => l.marketId === marketId)?.marketName ?? `market ${marketId}`;
  if (venue === null) {
    blockers.push({
      code: 'roll-unpriced',
      message: input.venueError
        ? `The venue could not preview this roll — ${input.venueError}`
        : 'The venue could not preview this roll — waiting for a quote.',
    });
  } else if (venue.status === 'Refused') {
    const named = venue.orders.filter((o) => o.error !== null);
    if (named.length > 0) {
      // One line per leg the venue named, each with ITS cause and ITS remedy:
      // the four legs can fail for four different reasons, and one shared
      // "widen the tolerance" is wrong advice for the margin one (his call
      // 2026-09-22). Newline-separated; the panel renders them stacked.
      const lines = named.map((o) => {
        const step = o.action === 'close' ? exit : entry;
        const sim = [step.simulation.legA, step.simulation.legB].find((l) => l.marketId === o.marketId) ?? null;
        return `${o.action === 'close' ? 'Exit' : 'Re-entry'} · ${marketName(o.marketId)} — ${refusalCause(o.error ?? '', sim, step.simulation.collateral)}`;
      });
      /**
       * ONE error per leg, in one list (his call 2026-09-22). The pair gates
       * above judged each leg before the wire; the venue then judged the same
       * legs — and two boxes about one leg read as two problems. The venue's
       * line wins for a leg it named (it is the concrete one); a leg only the
       * pair gate flagged keeps that, folded into the same list. Blockers
       * that carry their own control or readout stay as they are.
       */
      const OWN_UI: ReadonlySet<string> = new Set(['isolated-must-switch', 'slippage-exceeds-max']);
      const stepOf = (o: { action: 'close' | 'open' }): RollStep => (o.action === 'close' ? 'exit' : 'entry');
      const venueNamed = new Set(named.map((o) => `${stepOf(o)}:${o.marketId}`));
      const seen = new Set<string>();
      const folded: string[] = [];
      for (let i = blockers.length - 1; i >= 0; i -= 1) {
        const b = blockers[i];
        if (b.step === undefined || b.marketId === undefined || OWN_UI.has(b.code)) continue;
        blockers.splice(i, 1);
      }
      for (const b of stepBlockers) {
        if (b.step === undefined || b.marketId === undefined || OWN_UI.has(b.code)) continue;
        const key = `${b.step}:${b.marketId}`;
        // Every distinct cause a leg carries, once — a leg can be short of
        // margin AND carry a bound outside the band, and both are its to know.
        if (venueNamed.has(key) || seen.has(`${key}:${b.code}`)) continue;
        seen.add(`${key}:${b.code}`);
        folded.push(b.message.replace(/^(Exit|Re-entry): /, '$1 · '));
      }
      blockers.push({ code: 'venue-refused', message: ['The venue refuses this roll:', ...lines, ...folded].join('\n') });
    } else {
      blockers.push({
        code: 'venue-refused',
        message: `The venue refuses this roll — ${venue.reason?.message ?? 'refused'}. ${
          VENUE_MARGIN_CODE.test(venue.reason?.code ?? '')
            ? 'Add margin or roll a smaller size.'
            : 'Widen the tolerance or reduce the size.'
        }`,
      });
    }
  }

  const shortfall = (): number => {
    if (!venue) return 0;
    if (venue.availableAfter !== null) return venue.availableAfter < 0 ? -venue.availableAfter : 0;
    // The batch reverted, so there is no after; the opens were judged on
    // the margin left once the closes ran, which the venue does report.
    const forMargin = venue.status === 'Refused' && VENUE_MARGIN_CODE.test(venue.reason?.code ?? '');
    return forMargin && venue.availableAfterExit !== null ? Math.max(0, venue.marginRequired - venue.availableAfterExit) : 0;
  };
  const margin: RollMargin = {
    need: venue?.marginRequired ?? null,
    availableBefore: venue?.availableBefore ?? null,
    availableAfter: venue?.availableAfter ?? null,
    availableAfterExit: venue?.availableAfterExit ?? null,
    shortfall: shortfall(),
  };
  // Account-level notices (gas) come from both steps' gates; say them once.
  return { blockers, warnings: [...new Set(warnings)], margin };
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
