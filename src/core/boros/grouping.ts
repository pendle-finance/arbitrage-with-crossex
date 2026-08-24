/**
 * Which trades were placed TOGETHER.
 *
 * This module does two things — scores candidate pairings, then binds them
 * into executions — and nothing else. It answers one question and returns one
 * fact:
 *
 *   given the atoms a book is made of, which of them went out as one trade?
 *
 * WHY THAT IS THE WHOLE JOB. The current solver divides a Boros leg market by
 * market, each in its own call, scored against a different set of eligible
 * tranches. Two legs bought in ONE transaction are therefore free to land on
 * two different cards, which is exactly what a live book showed. Nothing in
 * that pipeline can express "these two are one thing", so no amount of tuning
 * fixes it. An execution is that missing object.
 *
 * ⚠ CONFIDENCE COMES FROM IMPROBABILITY, NOT PROVENANCE. An earlier design
 * had two "certain" tiers — our own order tag, and a same-transaction id —
 * over a single "guess" tier. Both of those only recognise trades THIS
 * TERMINAL placed, so on a book opened anywhere else the whole ladder
 * collapses to guessing. The bands below instead score how unlikely the
 * coincidence is: opposite sides, different venues, matching size and a few
 * seconds apart are independent signals, and together they are not a guess —
 * that is what a cross-exchange hedge IS. Identity still participates; it is
 * simply the most improbable coincidence there is, not a different kind.
 */

import { TIME_SCALE_SEC } from './partition';

/** Where an atom sits in time. A BOUND is not a measurement: it says "at or
 * before", which is all a reconstructed prefix can honestly claim. */
type AtomTime = { kind: 'at'; sec: number } | { kind: 'before'; sec: number };

/** One trade, or the smallest indivisible remnant of one. */
export interface Atom {
  /** Stable within one solve; how executions refer back to their members. */
  id: string;
  /** `perp:SYMBOL` or `boros:MARKETID` — the leg this trade moved. */
  legKey: string;
  venue: string;
  base: string;
  /** Signed FLOATING exposure, in a comparable unit (USD). A Boros long
   * receives floating (+), a perp long pays it (−) — so two atoms that hedge
   * each other have opposite signs and sum toward zero. */
  floating: number;
  /** Absolute size, in whatever unit the leg is denominated in. */
  qty: number;
  /** Traded rate (Boros) or price (perp); NaN when unknown. */
  rate: number;
  at: AtomTime;
  /** Identity, when the venue or our own tag provides one: a transaction id,
   * an engine order tag, or a journal deal id. Atoms sharing a non-null key
   * were provably placed together. */
  identity?: string;
}

type Band = 'certain' | 'tight' | 'strong' | 'weak';

/** A set of atoms placed together. NEVER divided between positions — that is
 * the entire point of the object. */
export interface Execution {
  atomIds: string[];
  band: Band;
  score: number;
}

/** Relative weight of each penalty. All four terms are dimensionless (see
 * `pairScore`), so these are directly comparable — which is the only reason
 * tuning them here is meaningful. */
const W_TIME = 1;
const W_SIZE = 1;
const W_RATE = 1;
/** Two legs at the SAME venue do not hedge each other's floating rate, so a
 * same-venue pairing is penalised rather than forbidden — a book can hold one. */
const W_VENUE = 0.5;

/** Band thresholds. `tight` is what a real cross-exchange hedge looks like:
 * the engine fires both legs within seconds. `weak` is the outer edge of
 * "possibly related", and deliberately does NOT bind — it falls through to be
 * fitted by cost like any unpaired atom. */
const BANDS: Array<{ band: Exclude<Band, 'certain'>; maxGapSec: number; maxSizeRel: number }> = [
  { band: 'tight', maxGapSec: 5, maxSizeRel: 0.001 },
  { band: 'strong', maxGapSec: 60, maxSizeRel: 0.01 },
  { band: 'weak', maxGapSec: 900, maxSizeRel: Number.POSITIVE_INFINITY },
];

const rel = (a: number, b: number): number => {
  const hi = Math.max(Math.abs(a), Math.abs(b));
  return hi > 0 ? Math.abs(a - b) / hi : 0;
};

/**
 * Seconds between two atoms, or null when one of them only has a BOUND.
 *
 * A bound must never read as proximity. "At or before 09:00" and "at 09:00"
 * are not five seconds apart — the first says nothing about how far back it
 * goes, and treating it as an instant would hand a reconstructed prefix the
 * tightest band in the table.
 */
function gapSec(a: AtomTime, b: AtomTime): number | null {
  if (a.kind === 'before' || b.kind === 'before') return null;
  return Math.abs(a.sec - b.sec);
}

/** True when these two atoms could be the two sides of one hedge. */
function eligible(a: Atom, b: Atom): boolean {
  if (a.id === b.id) return false;
  if (a.legKey === b.legKey) return false;
  if (a.base !== b.base) return false;
  // Opposite floating exposure: together they cancel rather than compound.
  return a.floating * b.floating < 0;
}

/**
 * Lower is a better pairing. Dimensionless, so the weights are comparable.
 *
 * Identity short-circuits to 0 — not as a special case in the caller, but
 * because a shared transaction id IS a coincidence of probability zero.
 */
function pairScore(a: Atom, b: Atom): number {
  if (a.identity !== undefined && a.identity === b.identity) return 0;
  const gap = gapSec(a.at, b.at);
  const timeTerm = gap === null ? Number.POSITIVE_INFINITY : gap / TIME_SCALE_SEC;
  const rateTerm = Number.isFinite(a.rate) && Number.isFinite(b.rate) ? rel(a.rate, b.rate) : 1;
  return (
    W_TIME * timeTerm +
    W_SIZE * rel(a.qty, b.qty) +
    W_RATE * rateTerm +
    W_VENUE * (a.venue === b.venue ? 1 : 0)
  );
}

/** The tightest band this pairing qualifies for, or null for none. */
function bandFor(a: Atom, b: Atom): Band | null {
  if (a.identity !== undefined && a.identity === b.identity) return 'certain';
  const gap = gapSec(a.at, b.at);
  if (gap === null) return null;
  const size = rel(a.qty, b.qty);
  for (const t of BANDS) {
    if (gap <= t.maxGapSec && size <= t.maxSizeRel) return t.band;
  }
  return null;
}

const RANK: Record<Band, number> = { certain: 0, tight: 1, strong: 2, weak: 3 };

/** Bands at or above this bind into an execution. `weak` does not: it is a
 * guess, and a guess must not create an object later steps may not divide. */
const BINDING = RANK.strong;

interface BindOptions {
  /**
   * False when the history behind these atoms was truncated.
   *
   * ⚠ A band is a claim about what ELSE was placed nearby, which is an
   * argument from absence — and truncation answers that wrongly, confidently.
   * Presence-based evidence survives truncation (two fills sharing an order
   * tag were still placed together, whatever else was cut), so identity still
   * binds; everything inferred is capped at `weak`, which does not bind.
   */
  historyComplete?: boolean;
}

/**
 * Bind atoms into executions, strongest coincidence first.
 *
 * Greedy and deterministic: candidates are sorted by score, then by atom id to
 * break exact ties, so the same book always yields the same executions. An
 * atom already in an execution may be joined by another only when doing so
 * still reduces that execution's net floating exposure — otherwise a third leg
 * on the same side could pile into a finished pair.
 */
export function bindExecutions(atoms: readonly Atom[], opts: BindOptions = {}): Execution[] {
  const complete = opts.historyComplete !== false;

  interface Candidate { a: Atom; b: Atom; band: Band; score: number }
  const candidates: Candidate[] = [];
  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const a = atoms[i];
      const b = atoms[j];
      if (!eligible(a, b)) continue;
      let band = bandFor(a, b);
      if (band === null) continue;
      // Truncated history: nothing inferred may outrank a guess.
      if (!complete && band !== 'certain' && RANK[band] < RANK.weak) band = 'weak';
      if (RANK[band] > BINDING) continue;
      candidates.push({ a, b, band, score: pairScore(a, b) });
    }
  }
  candidates.sort(
    (x, y) =>
      x.score - y.score ||
      RANK[x.band] - RANK[y.band] ||
      (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0) ||
      (x.b.id < y.b.id ? -1 : 1),
  );

  const execOf = new Map<string, number>();
  const execs: Array<{ ids: string[]; net: number; band: Band; score: number }> = [];
  const atomById = new Map(atoms.map((a) => [a.id, a]));

  for (const c of candidates) {
    const ea = execOf.get(c.a.id);
    const eb = execOf.get(c.b.id);
    if (ea !== undefined && eb !== undefined) continue; // both spoken for
    if (ea === undefined && eb === undefined) {
      execs.push({
        ids: [c.a.id, c.b.id],
        net: c.a.floating + c.b.floating,
        band: c.band,
        score: c.score,
      });
      execOf.set(c.a.id, execs.length - 1);
      execOf.set(c.b.id, execs.length - 1);
      continue;
    }
    const idx = (ea ?? eb) as number;
    const joiner = ea === undefined ? c.a : c.b;
    const exec = execs[idx];
    // Only if it brings the execution CLOSER to flat. A same-side third leg
    // makes it more directional, which is not what an execution means.
    if (Math.abs(exec.net + joiner.floating) >= Math.abs(exec.net)) continue;
    exec.ids.push(joiner.id);
    exec.net += joiner.floating;
    if (RANK[c.band] > RANK[exec.band]) exec.band = c.band;
    exec.score = Math.max(exec.score, c.score);
    execOf.set(joiner.id, idx);
  }

  return execs
    .filter((e) => e.ids.length > 1 && e.ids.every((id) => atomById.has(id)))
    .map((e) => ({ atomIds: [...e.ids].sort(), band: e.band, score: e.score }));
}

/** legKey → the execution it belongs to, for the legs an execution spans.
 * Two legs in one execution must land on the same card. */
export function legsBoundTogether(
  atoms: readonly Atom[],
  execs: readonly Execution[],
): Map<string, string[]> {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const out = new Map<string, string[]>();
  for (const e of execs) {
    const legs = [...new Set(e.atomIds.map((id) => byId.get(id)?.legKey).filter((k): k is string => !!k))];
    if (legs.length < 2) continue;
    for (const l of legs) out.set(l, legs);
  }
  return out;
}
