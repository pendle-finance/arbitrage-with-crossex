/**
 * Roll-over: close a Boros pair at one maturity and re-open it at a later
 * one, as ONE all-or-nothing batch.
 *
 * The batch is every close, then every open, each FOK, sent by
 * `placeMarketOrders` as a single `tryAggregate` with `requireSuccess`. The
 * venue simulates the batch before submitting it (the calls run in order, in
 * one state, so the opens are checked against the margin the closes free),
 * refuses the whole thing if any call would fail, and on-chain a revert
 * anywhere undoes everything. FOK closes the last gap: an IOC leg that fills
 * PART of its size still succeeds, so `requireSuccess` alone would let the
 * old legs close 100% while the new ones open 60%. Under FOK a leg either
 * fills whole or reverts, and its revert takes the batch. A roll therefore
 * ends in exactly one of three states: rolled in full, nothing happened, or
 * the venue never confirmed (`unknown`).
 *
 * What this module does NOT do: size legs, walk books or judge margin —
 * each step is priced by `simulateBorosPair` + `evaluatePairGate`, and the
 * batch as a whole by the venue's own preview (`v2/simulations/roll-over`),
 * which runs the same orders in the same order on one account state and is
 * the only thing that can say whether a FOK fills whole and whether the
 * account still clears its initial margin once the closes have freed theirs.
 * This module combines those verdicts, adds the checks that only exist
 * because the two steps are one batch, names the legs for the venue, and
 * reads its answer.
 */
import type { BorosMarket } from './client';
import { classifyLegFailure } from './orders';
import type {
  BorosLegFailureCode,
  BorosLegFill,
  BorosMarketOrderRequest,
  BorosOrderClient,
  BorosRollSimulation,
  PlaceOrdersOptions,
} from './orders';
import { fmtSize, reducingOrderSize } from './pair';
import type { BlockerCode, BorosLegDirection, BorosPairLegInput, BorosPairSimulation, PairGate, SimulatedLeg } from './pair';
import { normalizeVenue } from './venue';

/** Fills with a relative shortfall under this are whole (an 18-decimal size
 * does not survive a float round-trip exactly — see borosApi). */
const FULL_FILL_TOLERANCE = 1e-9;

export type RollStep = 'exit' | 'entry';
export type RollLegKey = string;

export interface RollStepInput {
  simulation: BorosPairSimulation;
  gate: PairGate;
  legs: BorosPairLegInput[];
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
  leg?: number;
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
const heldSide = (leg: SimulatedLeg): BorosLegDirection | null =>
  leg.sizing.currentSize > 0 ? 'long' : leg.sizing.currentSize < 0 ? 'short' : null;
const opposite = (side: BorosLegDirection): BorosLegDirection => (side === 'long' ? 'short' : 'long');
const sum = (xs: Array<number | null>): number | null =>
  xs.every((x): x is number => x !== null) ? xs.reduce((t, x) => t + x, 0) : null;
const venuesOf = (m: BorosMarket): readonly string[] => m.spreadVenues ?? [normalizeVenue(m.venue)];

/** `MarketSelfSwap` (MarketOrderAndOtc.sol): the order would fill against the
 * account's own resting order. Spelled "Self swapping error" by the SDK's
 * message table, `MarketSelfSwap()` without it. */
const SELF_SWAP = /self\s*swap/i;

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
function refusalCause(error: string, sim: SimulatedLeg | null, collateral: string, wholeRollHelps = false): Refusal {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const reduce = 'Reduce the size.';
  switch (classifyLegFailure(error)) {
    case 'insufficient-depth': {
      if (sim === null || sim.shortfallSize > 0 || sim.bookStatus !== 'ok') {
        return {
          cause:
            sim !== null && sim.bookStatus !== 'unavailable'
              ? `Insufficient liquidity: the whole book holds ${fmtSize(sim.estFillSize)} ${collateral}.`
              : 'Insufficient liquidity.',
          fix: reduce,
        };
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
          return { cause: `Rate limit exceeded: only ${fmtSize(withinBand)} ${collateral} fills inside the venue's max rate deviation.`, fix: reduce };
        }
      }
      // Only when this side's book AGREES it is short: one that has moved
      // since it was read has nothing truthful to add (nerax1s, e79d672).
      return {
        cause:
          sim.sizeWithinTolerance !== null && sim.sizeWithinTolerance < size
            ? `Slippage too high: only ${fmtSize(sim.sizeWithinTolerance)} ${collateral} fills inside the ${pct(sim.slippageApr)} tolerance.`
            : 'Slippage too high: the size does not fill inside the tolerance.',
        fix: 'Widen the tolerance or reduce the size.',
      };
    }
    case 'rate-deviation':
      return { cause: `Rate limit exceeded (${error}): the rate sits too far from the venue's mark.`, fix: reduce };
    case 'insufficient-margin':
      return { cause: `${error}.`, fix: 'Add margin or roll a smaller size.' };
    case 'no-gas':
      return { cause: `${error}.`, fix: 'Top up the gas balance.' };
    // Reached when the roll needs more slots than its closes free, for
    // example one spread into two singles with every other market in use.
    case 'market-limit':
      // A whole roll exits the old markets once they are flat (G1), so on a
      // part roll that is the fix that keeps every other position.
      return {
        cause: 'Market limit reached: every Boros market slot holds a position or an order.',
        fix: wholeRollHelps ? 'Roll the whole position (it frees the old markets), or close a position you no longer need.' : 'Close a position you no longer need, then roll.',
      };
    default:
      return SELF_SWAP.test(error)
        ? { cause: 'Your own order on this market blocks the fill.', fix: 'Cancel it on Boros, then roll.' }
        : { cause: `${error}.`, fix: null };
  }
}

interface Refusal {
  cause: string;
  /** The cause's own remedy, said once per message however many legs share it. */
  fix: string | null;
}

/** "The venue refuses this roll:", one bullet per cause naming the legs that
 * share it, then each distinct fix once (his call 2026-10-16: no wall of text). */
function refusalMessage(
  items: ReadonlyArray<{ leg: { action: string; market: string } | null; refusal: Refusal }>,
  extra: readonly string[] = [],
): string {
  const byCause = new Map<string, { labels: Map<string, string[]>; fix: string | null }>();
  for (const { leg, refusal } of items) {
    const group = byCause.get(refusal.cause) ?? { labels: new Map<string, string[]>(), fix: refusal.fix };
    if (leg !== null) group.labels.set(leg.action, [...(group.labels.get(leg.action) ?? []), leg.market]);
    byCause.set(refusal.cause, group);
  }
  const bullets = [...byCause].map(([cause, { labels }]) => {
    const who = [...labels].map(([action, markets]) => `${action} · ${markets.join(', ')}`).join('; ');
    return `• ${who ? `${who}: ` : ''}${cause}`;
  });
  const fixes = [...new Set([...byCause.values()].flatMap((g) => (g.fix ? [g.fix] : [])))].map((f) => `Fix: ${f}`);
  return ['The venue refuses this roll:', ...bullets, ...extra.map((e) => `• ${e}`), ...fixes].join('\n');
}

export function evaluateRollGate(input: EvaluateRollInput): RollGate {
  const { exit, entry, venue } = input;
  const blockers: RollBlocker[] = [];
  // A roll is sent as one opening batch, so the entry step's gas line is the
  // true one; the exit's, priced as a close, would contradict it.
  const warnings = [...exit.gate.warnings.filter((w) => !w.startsWith('Prepaid gas')), ...entry.gate.warnings];

  const prefixed = (step: RollStep, gate: PairGate, label: string): void => {
    for (const b of gate.blockers) {
      // The entry's margin was judged before the exit — replaced by `margin`
      // below, which the venue judges after the closes have freed theirs.
      if (step === 'entry' && MARGIN_CODES.has(b.code)) continue;
      // A roll re-opens what each venue already holds, so two singles of
      // slightly different sizes are the book as it stands, not a lopsided
      // new open. The exposure checks below keep each venue's size and side.
      if (step === 'entry' && b.code === 'unhedged-open') continue;
      blockers.push({ code: b.code, message: `${label}: ${b.message}`, step, leg: b.leg, marketId: b.marketId });
    }
  };
  prefixed('exit', exit.gate, 'Exit');
  prefixed('entry', entry.gate, 'Re-entry');
  // A whole roll helps at the market limit only when the old markets it
  // frees cover the new ones its opens need: one spread into two singles
  // frees one slot and needs two (report 2026-10-18).
  const wholeRollHelps =
    exit.simulation.legs.some((l) => l.sizing.resultingSize !== 0) &&
    exit.legs.length >= entry.simulation.legs.filter((l) => l.sizing.currentSize === 0).length;
  const stepBlockers = [...blockers];

  const oldMaturity = Math.max(...exit.legs.map((l) => l.market.maturity));
  const newMaturity = Math.min(...entry.legs.map((l) => l.market.maturity));
  if (!(newMaturity > oldMaturity)) {
    blockers.push({ code: 'maturity-not-later', message: 'The new maturity must be later than the one being left.' });
  }
  if (new Set([...exit.legs, ...entry.legs].map((l) => l.market.tokenId)).size !== 1) {
    blockers.push({ code: 'collateral-mismatch', message: 'Every leg must post the same collateral.' });
  }

  const oldLegs = exit.simulation.legs.map((sim, i) => ({ sim, market: exit.legs[i].market }));
  const newLegs = entry.simulation.legs.map((sim, i) => ({ sim, market: entry.legs[i].market }));
  if (oldLegs.length === newLegs.length) {
    oldLegs.forEach(({ sim: old, market: oldMarket }, index) => {
      const { sim: next, market: nextMarket } = newLegs[index];
      if (old.venue !== next.venue || old.base.toLowerCase() !== next.base.toLowerCase()) {
        blockers.push({
          code: 'market-mismatch',
          leg: index,
          message: `${nextMarket.name} is not a later maturity of ${oldMarket.name}.`,
        });
      }
      const held = heldSide(old);
      if (held !== null && next.sizing.orderSide !== held) {
        blockers.push({
          code: 'sides-mismatch',
          leg: index,
          message: `${nextMarket.name}: the new leg must be ${held}, the side ${oldMarket.name} holds.`,
        });
      }
      if (!same(Math.abs(old.sizing.deltaSize), Math.abs(next.sizing.deltaSize))) {
        blockers.push({
          code: 'size-mismatch',
          leg: index,
          message:
            `${oldMarket.name} closes ${Math.abs(old.sizing.deltaSize)} but ${nextMarket.name} would open ` +
            `${Math.abs(next.sizing.deltaSize)} — a roll moves one size.`,
        });
      }
    });
  } else {
    type StepLeg = (typeof oldLegs)[number];
    const exposure = (legs: StepLeg[], signedOf: (sim: SimulatedLeg) => number): Map<string, number> => {
      const out = new Map<string, number>();
      for (const { sim, market } of legs) {
        const signed = signedOf(sim);
        venuesOf(market).forEach((v, i) => out.set(v, (out.get(v) ?? 0) + (i === 0 ? signed : -signed)));
      }
      return out;
    };
    const signedSize = (side: BorosLegDirection, size: number): number => (side === 'long' ? 1 : -1) * Math.abs(size);
    const closed = exposure(oldLegs, (sim) => signedSize(opposite(sim.sizing.orderSide), sim.sizing.deltaSize));
    const opened = exposure(newLegs, (sim) => signedSize(sim.sizing.orderSide, sim.sizing.deltaSize));
    const base = oldLegs[0].sim.base.toLowerCase();
    const unmatched = (legs: StepLeg[], step: RollStep, other: Map<string, number>): void =>
      legs.forEach(({ sim, market }, index) => {
        if (sim.base.toLowerCase() === base && venuesOf(market).every((v) => other.has(v))) return;
        blockers.push({ code: 'market-mismatch', step, leg: index, message: `${market.name} does not match the pair being rolled.` });
      });
    const before = blockers.length;
    unmatched(oldLegs, 'exit', opened);
    unmatched(newLegs, 'entry', closed);
    const matched = blockers.length === before;
    const spreadAt = newLegs.findIndex(({ market }) => market.spreadVenues !== null);
    const target = spreadAt === -1 ? null : newLegs[spreadAt].market.spreadVenues;
    const unevenForSpread =
      matched && target !== null && !same(Math.abs(closed.get(target[0]) ?? 0), Math.abs(closed.get(target[1]) ?? 0));
    if (unevenForSpread) {
      blockers.push({
        code: 'size-mismatch',
        step: 'entry',
        leg: spreadAt,
        message: 'This pair holds different sizes on its two venues. One spread cannot hold both.',
      });
    }
    if (matched && !unevenForSpread) {
      for (const [venue, was] of closed) {
        const now = opened.get(venue) ?? 0;
        const single = ({ market }: StepLeg): boolean => !market.spreadVenues && venuesOf(market)[0] === venue;
        const atExit = oldLegs.findIndex(single);
        const step: RollStep = atExit !== -1 ? 'exit' : 'entry';
        const index = atExit !== -1 ? atExit : Math.max(0, newLegs.findIndex(single));
        const { market } = (step === 'exit' ? oldLegs : newLegs)[index];
        if (was !== 0 && now !== 0 && Math.sign(was) !== Math.sign(now)) {
          blockers.push({
            code: 'sides-mismatch',
            step,
            leg: index,
            message: `${market.name}: the new maturity must stay ${was < 0 ? 'short' : 'long'} on this venue to keep the hedge.`,
          });
        } else if (!same(Math.abs(was), Math.abs(now))) {
          blockers.push({
            code: 'size-mismatch',
            step,
            leg: index,
            message: `${market.name}: the roll closes ${fmtSize(Math.abs(was))} on this venue but opens ${fmtSize(Math.abs(now))}. A roll moves one size.`,
          });
        }
      }
    }
  }

  // The venue's preview is the only judge of the batch as a whole: FOK fills
  // are decided level by level up to the bound, and the opens' margin only
  // after the closes have freed theirs.
  const markets = [...exit.legs, ...entry.legs].map((l) => l.market);
  const marketName = (marketId: number): string => {
    const m = markets.find((x) => x.marketId === marketId);
    return m ? m.name : `market ${marketId}`;
  };
  if (venue === null) {
    // A leg with no rate to send at never reaches the preview (`rollPlanFor`
    // returns null), so no quote is coming; that leg's own book blocker says why.
    const unpriceable = stepBlockers.some((b) => b.code === 'no-depth' || b.code === 'book-unavailable');
    if (!unpriceable) {
      blockers.push({
        code: 'roll-unpriced',
        message: input.venueError
          ? `The venue could not preview this roll — ${input.venueError}`
          : 'The venue could not preview this roll — waiting for a quote.',
      });
    }
  } else if (venue.status === 'Refused') {
    const named = venue.orders.filter((o) => o.error !== null);
    if (named.length > 0) {
      // One line per leg the venue named, each with ITS cause and ITS remedy:
      // the four legs can fail for four different reasons, and one shared
      // "widen the tolerance" is wrong advice for the margin one (his call
      // 2026-09-22). Newline-separated; the panel renders them stacked.
      const items = named.map((o) => {
        const step = o.action === 'close' ? exit : entry;
        const sim = step.simulation.legs.find((l) => l.marketId === o.marketId) ?? null;
        return {
          leg: { action: o.action === 'close' ? 'Exit' : 'Re-entry', market: marketName(o.marketId) },
          refusal: refusalCause(o.error ?? '', sim, step.simulation.collateral, wholeRollHelps),
        };
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
      blockers.push({ code: 'venue-refused', message: refusalMessage(items, folded) });
    } else {
      const why = venue.reason?.message ?? 'refused';
      const cause = classifyLegFailure(why);
      // No one order to blame: two opens that each pass alone can still need
      // one more market slot than the closes free (live 16 Oct). The cause's
      // own advice, then; "widen" is only for a fill problem.
      const refusal: Refusal = VENUE_MARGIN_CODE.test(venue.reason?.code ?? '')
        ? { cause: `${why}.`, fix: 'Add margin or roll a smaller size.' }
        : cause === 'market-limit' || cause === 'no-gas' || SELF_SWAP.test(why)
          ? refusalCause(why, null, '', wholeRollHelps)
          : { cause: `${why}.`, fix: 'Widen the tolerance or reduce the size.' };
      blockers.push({ code: 'venue-refused', message: refusalMessage([{ leg: null, refusal }]) });
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

/** Every close, then every open: the batch the venue previews and `placeMarketOrders` sends. */
export interface RollPlan {
  closes: BorosMarketOrderRequest[];
  opens: BorosMarketOrderRequest[];
}

export interface RollPlanOptions {
  ids?: Partial<RollOrderIds>;
  openSizeWei?: Partial<Record<number, string>>;
}

const fillKey = (step: RollStep, marketId: number): RollLegKey => `${step}:${marketId}`;

export function rollFillKeys(plan: RollPlan): RollLegKey[] {
  return [...plan.closes.map((o) => fillKey('exit', o.marketId)), ...plan.opens.map((o) => fillKey('entry', o.marketId))];
}

export function rollPlanFor(
  exit: BorosPairSimulation,
  entry: BorosPairSimulation,
  options: RollPlanOptions = {},
): RollPlan | null {
  const trades = (l: SimulatedLeg): boolean => Math.abs(l.sizing.deltaSize) > 0 && l.execApr !== null && l.worstApr !== null;
  if (exit.legs.length === 0 || entry.legs.length === 0 || ![...exit.legs, ...entry.legs].every(trades)) return null;

  const order = (step: RollStep, leg: SimulatedLeg, sizedAs?: BorosMarketOrderRequest): BorosMarketOrderRequest => {
    const asked = Math.abs(leg.sizing.deltaSize);
    const openWei = step === 'exit' ? options.openSizeWei?.[leg.marketId] : undefined;
    const reduced = openWei !== undefined ? reducingOrderSize(openWei, asked) : null;
    const sizeWei = sizedAs ? sizedAs.sizeWei : reduced?.sizeWei;
    return {
      marketId: leg.marketId,
      direction: leg.sizing.orderSide,
      size: sizedAs?.size ?? reduced?.size ?? asked,
      limitApr: leg.worstApr as number,
      clientOrderId: options.ids?.[fillKey(step, leg.marketId)] ?? fillKey(step, leg.marketId),
      ...(sizeWei !== undefined ? { sizeWei } : {}),
    };
  };
  const closes = exit.legs.map((l) => order('exit', l));
  // Singles ↔ spread: each open at its own size; the gate checks each venue's exposure.
  if (exit.legs.length !== entry.legs.length) return { closes, opens: entry.legs.map((l) => order('entry', l)) };

  // Leg for leg: each open re-opens its close's venue and side at the close's
  // size, to the wei, so the new maturity holds exactly what the old one did.
  const used = new Set<number>();
  const opens: BorosMarketOrderRequest[] = [];
  for (const [i, close] of exit.legs.entries()) {
    const index = entry.legs.findIndex(
      (open, j) =>
        !used.has(j) &&
        open.sizing.orderSide === heldSide(close) &&
        open.venue === close.venue &&
        open.base.toLowerCase() === close.base.toLowerCase(),
    );
    if (index === -1) return null;
    used.add(index);
    opens.push(order('entry', entry.legs[index], closes[i]));
  }
  return { closes, opens };
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

/**
 * Fire the batch and read the answer. A throw is folded into `unknown`:
 * the transport gave no verdict, so the fill state is genuinely uncertain.
 * A refusal with a status code never reaches here as a throw — the venue
 * adapter reports it as failed legs, because nothing ran.
 */
export async function submitBorosRoll(
  client: BorosOrderClient,
  plan: RollPlan,
  opts?: Pick<PlaceOrdersOptions, 'cancelOrdersOn' | 'gasTopUpMarket'>,
): Promise<BorosRollResult> {
  let fills: BorosLegFill[];
  try {
    const batch: PlaceOrdersOptions = { ...opts, topUpAfter: plan.closes.length, timeInForce: 'fill-or-kill' };
    fills = await client.placeMarketOrders([...plan.closes, ...plan.opens], batch);
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
    fills = [...plan.closes, ...plan.opens].map((o) => lost(o.marketId, o.direction, o.size));
  }
  return readRollFills(fills, rollFillKeys(plan));
}

export function readRollFills(fills: BorosLegFill[], keys: RollLegKey[]): BorosRollResult {
  const legs = Object.fromEntries(keys.map((k, i) => [k, fills[i]])) as Record<RollLegKey, BorosLegFill>;
  const entries = keys.map((k) => [k, legs[k]] as const);
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
  if (failed && fills.every((f) => f.filledSize === 0)) return { status: 'refused', legs, reason: reasonOf(failed[1].failure!.code), rolledSize: 0 };
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
