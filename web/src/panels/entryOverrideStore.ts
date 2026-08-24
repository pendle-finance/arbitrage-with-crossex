/** What the user says a leg's ENTRY actually was — price for a perp, rate for
 * a Boros leg — remembered across reloads.
 *
 * Why this exists. `partition.ts:legOf` reports `entryPrice: null` whenever a
 * leg is SHARED and its venue entry is blended: the venue reports one average
 * across every strategy holding that leg, and handing that average to each of
 * them would invent a crossing cost none of them paid. Null is the honest
 * answer, but it is not a useful one — the user opened those legs and knows
 * what they paid. This is where they say so.
 *
 * Same doctrine as entryPartsStore and partitionStore: an override records a
 * FACT the user asserted about their own fills, not a viewing preference, so
 * it must survive a reload. It stays client-side for the same reason the
 * partition does — the strategy view is address-driven and has to keep working
 * with no engine behind it.
 *
 * ⚠ CONSERVATION. An override never changes what the VENUE reports. The venue
 * average is ground truth over the whole position; an override only says how
 * that total is divided between the strategies sharing it. So the weighted
 * average of every claim on a leg must come back to the venue's own entry —
 * see `impliedEntryFor`, which prices the un-asserted remainder so it does.
 * Anything else would let a user quietly restate their cost basis.
 */
import { readJson, writeJson } from '../lib/storage';
import { legRefKey, type LegRef, type MembershipRow } from './partitionStore';

const KEY = 'crossex.entryOverride.v1';

/** Matured positions would otherwise leave assertions behind forever.
 * Comfortably longer than any Boros maturity — matches the sibling stores. */
const MAX_AGE_SEC = 180 * 24 * 3600;

/** One strategy's asserted entry for one leg.
 *
 * `value` is a PRICE for a perp leg (quote per coin, the unit the venue's own
 * `entryPrice` is in) and a RATE for a Boros leg (an APR as a fraction, the
 * unit `entryApr` is in). The two never mix on one leg because a LegRef is
 * either a perp symbol or a Boros marketId.
 *
 * `feeUsd` is deliberately NOT stored. Fees are pro-rated from the venue's own
 * total by the size this strategy holds (`partition.ts:scaleFee`), which stays
 * correct however the entry is split — a strategy that owns 30% of a leg paid
 * 30% of its fees no matter what price it claims. Letting the user restate the
 * fee too would double-count against the venue's reported total.
 */
export interface EntryOverride {
  /** Which strategy is claiming this entry. */
  positionId: string;
  leg: LegRef;
  /** Perp: entry price. Boros: entry APR as a fraction. */
  value: number;
}

interface Entry {
  rows: EntryOverride[];
  savedAtSec: number;
}
type Stored = Record<string, Entry>;

const isLeg = (v: unknown): v is LegRef => {
  if (!v || typeof v !== 'object') return false;
  const l = v as LegRef;
  if (l.kind === 'perp') return typeof l.symbol === 'string' && l.symbol.length > 0;
  if (l.kind === 'boros') return Number.isInteger(l.marketId);
  return false;
};

const isRow = (v: unknown): v is EntryOverride => {
  if (!v || typeof v !== 'object') return false;
  const r = v as EntryOverride;
  return (
    typeof r.positionId === 'string' &&
    r.positionId.length > 0 &&
    isLeg(r.leg) &&
    typeof r.value === 'number' &&
    Number.isFinite(r.value)
  );
};

const isEntry = (v: unknown): v is Entry =>
  !!v &&
  typeof v === 'object' &&
  Array.isArray((v as Entry).rows) &&
  (v as Entry).rows.every(isRow) &&
  typeof (v as Entry).savedAtSec === 'number';

const readAll = (): Stored =>
  readJson<Stored>(KEY, {}, (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEntry(v)) out[k] = v;
    }
    return out;
  });

/** Scoped exactly like the partition: per book (wallet + Gate account), so
 * assertions never leak across a credential swap. */
const bookKey = (bookId: string | null): string => bookId ?? 'default';

export function loadOverrides(bookId: string | null): EntryOverride[] {
  return readAll()[bookKey(bookId)]?.rows ?? [];
}

export function saveOverrides(
  bookId: string | null,
  rows: readonly EntryOverride[],
  nowSec: number,
): void {
  const all = readAll();
  // Prune first, so one write can't carry stale entries forward forever.
  for (const [k, v] of Object.entries(all)) {
    if (nowSec - v.savedAtSec > MAX_AGE_SEC) delete all[k];
  }
  const key = bookKey(bookId);
  if (!rows.length) delete all[key]; // the default costs nothing to store
  else all[key] = { rows: [...rows], savedAtSec: nowSec };
  writeJson(KEY, all);
}

const sameRow = (r: EntryOverride, positionId: string, leg: LegRef) =>
  r.positionId === positionId && legRefKey(r.leg) === legRefKey(leg);

/** Set one strategy's asserted entry, or clear it with `value: null`. */
/**
 * Set one claim's asserted entry — and clear every OTHER claim's on that leg.
 *
 * ⚠ ONE ASSERTION PER LEG, deliberately. With the venue's blended entry fixed,
 * a leg split N ways has only N-1 degrees of freedom: say what one claim paid
 * and the rest follow. Storing two independent assertions on the same leg is
 * over-determined — the second cannot be honoured without either breaking
 * conservation or silently overriding the first, and the previous version did
 * the latter (whoever asserted first kept their number forever while the
 * others re-balanced around them).
 *
 * So asserting is a statement about the WHOLE leg's division, not about one
 * card in isolation: a new assertion replaces the old one and every other
 * claim is re-derived from it. That also makes the control idempotent — the
 * user can correct any portion, at any time, and always get the same book.
 */
export function withOverride(
  rows: readonly EntryOverride[],
  positionId: string,
  leg: LegRef,
  value: number | null,
): EntryOverride[] {
  const key = legRefKey(leg);
  // Drop EVERY assertion on this leg, not just this position's.
  const rest = rows.filter((r) => legRefKey(r.leg) !== key);
  return value === null || !Number.isFinite(value) ? rest : [...rest, { positionId, leg, value }];
}

export function overrideFor(
  rows: readonly EntryOverride[],
  positionId: string,
  leg: LegRef,
): number | null {
  return rows.find((r) => sameRow(r, positionId, leg))?.value ?? null;
}

/** One claim on a leg: how much of it a strategy holds, and what it says it
 * paid (null = it has not said, and takes the implied remainder). */
export interface EntryClaim {
  positionId: string;
  qty: number;
  asserted: number | null;
}

/**
 * The entry every claim on ONE leg should report, given the venue's own
 * blended entry over the whole position.
 *
 * The venue average is conserved: asserted claims keep exactly what the user
 * said, and everything they did not assert splits the REMAINDER evenly by
 * size, so
 *
 *   Σ(qty · entry) over all claims  ==  venueEntry · venueQty
 *
 * still holds. That is the whole point — the user is dividing a known total,
 * not restating it. This mirrors `impliedRemainderPrice` in
 * `src/core/boros/partition.ts`, which prices an unexplained remainder the
 * same way against the fills that WERE explained.
 *
 * Returns null for a claim when the remainder cannot be priced sensibly — the
 * assertions overrun the venue total, or they leave a non-positive implied
 * price for the rest. The caller shows the venue's own number and says the
 * override does not reconcile, rather than displaying an invented one.
 */
export function reconcileEntries(
  claims: readonly EntryClaim[],
  venueEntry: number,
  venueQty: number,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!(venueQty > 0) || !Number.isFinite(venueEntry)) {
    for (const c of claims) out.set(c.positionId, c.asserted);
    return out;
  }
  const asserted = claims.filter((c) => c.asserted !== null && c.qty > 0);
  const rest = claims.filter((c) => c.asserted === null && c.qty > 0);
  const assertedQty = asserted.reduce((s, c) => s + c.qty, 0);
  const assertedNotional = asserted.reduce((s, c) => s + c.qty * (c.asserted as number), 0);
  for (const c of asserted) out.set(c.positionId, c.asserted);

  // What the venue says is left for everyone who has not asserted. Uses the
  // VENUE's whole position, not just the claims — size the strategies do not
  // account for is still part of the average being divided.
  const restQty = venueQty - assertedQty;
  const restNotional = venueEntry * venueQty - assertedNotional;
  const implied = restQty > 0 ? restNotional / restQty : null;
  const usable = implied !== null && Number.isFinite(implied) && implied > 0;
  for (const c of rest) out.set(c.positionId, usable ? implied : null);
  return out;
}

/** True when the assertions on a leg cannot be reconciled against the venue's
 * own entry — the caller warns instead of showing a made-up number. */
export function overrunsVenue(
  claims: readonly EntryClaim[],
  venueEntry: number,
  venueQty: number,
): boolean {
  if (!(venueQty > 0) || !Number.isFinite(venueEntry)) return false;
  const asserted = claims.filter((c) => c.asserted !== null && c.qty > 0);
  if (!asserted.length) return false;
  const assertedQty = asserted.reduce((s, c) => s + c.qty, 0);
  // Every claim asserted and the sizes add up: nothing is left to imply, so it
  // reconciles only if the asserted notional matches the venue's own.
  const assertedNotional = asserted.reduce((s, c) => s + c.qty * (c.asserted as number), 0);
  const restQty = venueQty - assertedQty;
  if (Math.abs(restQty) <= Math.max(1e-9, venueQty * 1e-9)) {
    const band = Math.max(1e-6, Math.abs(venueEntry * venueQty) * 1e-6);
    return Math.abs(assertedNotional - venueEntry * venueQty) > band;
  }
  if (restQty < 0) return true; // asserted more size than the venue holds
  const implied = (venueEntry * venueQty - assertedNotional) / restQty;
  return !(Number.isFinite(implied) && implied > 0);
}

/**
 * Drop every asserted entry that no surviving CLAIM stands behind.
 *
 * An override is a statement about one claim — "my half of that leg entered at
 * 3 412" — so it dies with the claim, not just with the leg. Both ways of
 * dying are covered by taking the pruned membership rows as the authority:
 *
 *  - the leg closed, so `pruneRows` already deleted every row naming it;
 *  - the leg is still open but this position let go of it (moved it to another
 *    card, detached it, handed it back to the solver), so the row is gone
 *    while the leg is not.
 *
 * Left behind, either one is live ammunition rather than dead weight. The
 * value is merged into `?partition=` by position id and leg (`encodedPins`),
 * so it re-arms the moment that pair exists again — pricing a leg the user
 * re-opened at what a position they closed last month paid for it, and, since
 * the venue's blend is conserved across claims, pushing the invented
 * difference onto whatever else is claiming that leg. A stale grouping is
 * visible on the card; a stale entry is just a wrong number.
 *
 * ⚠ Prune membership FIRST and pass the result — passing the un-pruned rows
 * keeps exactly the overrides that most need to go.
 *
 * Returns `rows` itself when nothing is stale, so a caller can skip the write.
 */
export function pruneOverrides(
  rows: readonly EntryOverride[],
  membership: readonly MembershipRow[],
): EntryOverride[] {
  // Same key shape as `encodedPins` builds to merge the two back together —
  // if that ever stops matching, an override silently stops being sent.
  const claims = new Set(
    membership.flatMap((r) =>
      r.positionId === undefined ? [] : [`${r.positionId}|${legRefKey(r.leg)}`],
    ),
  );
  const kept = rows.filter((r) => claims.has(`${r.positionId}|${legRefKey(r.leg)}`));
  return kept.length === rows.length ? (rows as EntryOverride[]) : kept;
}
