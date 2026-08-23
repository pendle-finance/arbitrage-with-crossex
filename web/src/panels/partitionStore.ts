/** Which legs the user has said belong to which position, remembered across
 * reloads and sent to the server so the solve happens in one place.
 *
 * Same doctrine as entryPartsStore: a membership row records a FACT the user
 * asserted ("that Hyperliquid short is my Binance strategy"), not a viewing
 * preference, so it must survive a reload — but it stays client-side, because
 * the strategy view is address-driven and has to keep working with no engine
 * behind it.
 *
 * Wire format mirrors src/core/boros/partition.ts's `decodeMembership`; the
 * duplication is deliberate and matches the share codec's two copies. A golden
 * vector is pinned on BOTH sides so a field added to one fails a test rather
 * than silently dropping every user's assertions.
 */
import { readJson, writeJson } from '../lib/storage';

const KEY = 'crossex.partition.v1';

/** Matured positions would otherwise leave assertions behind forever.
 * Comfortably longer than any Boros maturity. */
const MAX_AGE_SEC = 180 * 24 * 3600;

/** A live leg, named the way its VENUE names it — a perp symbol or a Boros
 * marketId. Not `(base, venue, maturity)`: Binance lists ETH under two quote
 * coins, and Boros lists one market in two collateral zones. */
export type LegRef =
  | { kind: 'perp'; symbol: string }
  | { kind: 'boros'; marketId: number };

export const legRefKey = (l: LegRef): string =>
  l.kind === 'perp' ? `perp:${l.symbol}` : `boros:${l.marketId}`;

/** One leg belongs to one position.
 *
 * `positionId` absent = it belongs to NONE: the solver may not group it, and
 * it is reported as unhedged. `qty` absent = all of the leg no other position
 * claims, which is what a user usually means. */
export interface MembershipRow {
  positionId?: string;
  leg: LegRef;
  qty?: number;
  /**
   * What this position asserts it PAID for its share — price for a perp, APR
   * fraction for a Boros leg. Held in entryOverrideStore (a separate fact, set
   * independently of membership) and merged in only when the payload is
   * encoded, so the server can conserve the venue average across every claim.
   */
  entry?: number;
}

interface Entry {
  rows: MembershipRow[];
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

const isRow = (v: unknown): v is MembershipRow => {
  if (!v || typeof v !== 'object') return false;
  const r = v as MembershipRow;
  if (!isLeg(r.leg)) return false;
  if (r.positionId !== undefined && typeof r.positionId !== 'string') return false;
  // A missing qty is meaningful ("all of it") and must survive a reload as
  // itself, not become 0.
  return r.qty === undefined || Number.isFinite(r.qty);
};

const readAll = (): Stored =>
  readJson<Stored>(KEY, {}, (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Entry;
      if (e && Array.isArray(e.rows) && e.rows.every(isRow) && typeof e.savedAtSec === 'number') {
        out[k] = { rows: e.rows, savedAtSec: e.savedAtSec };
      }
    }
    return out;
  });

/**
 * Assertions live per BOOK — see `bookId.ts`.
 *
 * ⚠ Per tracked ADDRESS is not enough. A row names a leg the way its venue
 * names it, and half of those legs (`GATE_FUTURE_ETH_USDT`) belong to the Gate
 * account, not the wallet. Keyed by the wallet alone, swapping only the Gate
 * account left every row naming a symbol the new account also holds silently
 * claiming that account's position instead.
 */
export const bookKey = (bookId: string | null): string => (bookId ?? '').toLowerCase();

export function loadRows(bookId: string | null): MembershipRow[] {
  return readAll()[bookKey(bookId)]?.rows ?? [];
}

export function saveRows(bookId: string | null, rows: MembershipRow[], nowSec: number): void {
  const all = readAll();
  for (const [k, v] of Object.entries(all)) {
    if (nowSec - v.savedAtSec > MAX_AGE_SEC) delete all[k];
  }
  const key = bookKey(bookId);
  if (!rows.length) delete all[key];
  else all[key] = { rows, savedAtSec: nowSec };
  writeJson(KEY, all);
}

/**
 * A position id, minted rather than derived.
 *
 * 8 hex is 4 billion per book, and short enough that a whole book's rows stay
 * inside a comfortable URL. Never derived from the legs — that is the point:
 * it survives a re-pair, a venue swap and a maturity roll.
 */
export function newPositionId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The four things a user can say about one leg. */
export type RowChange =
  /** This position holds it — all of it, or `qty` of it. */
  | { mode: 'assign'; positionId: string; leg: LegRef; qty?: number }
  /** This position holds NONE of it. Other positions keep their claims, and
   * anything left goes back to the solver. */
  | { mode: 'release'; positionId: string; leg: LegRef }
  /** It belongs to no position at all — reported as unhedged exposure. `qty`
   * detaches only that much of a SHARED leg, leaving other positions' claims
   * alone; without it the whole venue leg is orphaned. */
  | { mode: 'orphan'; leg: LegRef; qty?: number }
  /** Forget everything said about it; the solver decides again. */
  | { mode: 'auto'; leg: LegRef };

export function withRow(rows: readonly MembershipRow[], change: RowChange): MembershipRow[] {
  const key = legRefKey(change.leg);
  const onLeg = (r: MembershipRow) => legRefKey(r.leg) === key;
  switch (change.mode) {
    case 'auto':
      return rows.filter((r) => !onLeg(r));
    case 'orphan': {
      const orphans = rows.filter((r) => onLeg(r) && r.positionId === undefined);
      // The WHOLE leg: exclusive, so no position may keep a claim on any of it.
      if (change.qty === undefined || orphans.some((r) => r.qty === undefined)) {
        return [...rows.filter((r) => !onLeg(r)), { leg: change.leg }];
      }
      // A SHARE of a shared leg: only this much is unclaimed. Other positions
      // hold the rest and must keep their rows — dropping them would detach
      // the whole venue position from a card the user never touched. Sums with
      // anything already detached, so two cards each letting go of their share
      // adds up to the whole rather than the last one winning.
      const qty = orphans.reduce((s, r) => s + (r.qty ?? 0), change.qty);
      return [
        ...rows.filter((r) => !(onLeg(r) && r.positionId === undefined)),
        { leg: change.leg, qty },
      ];
    }
    case 'release':
      return rows.filter((r) => !(onLeg(r) && r.positionId === change.positionId));
    case 'assign':
      return [
        // Drop any orphan row on this leg — a claim contradicts it — and this
        // position's own previous claim, which this one replaces.
        ...rows.filter(
          (r) => !(onLeg(r) && (r.positionId === undefined || r.positionId === change.positionId)),
        ),
        {
          positionId: change.positionId,
          leg: change.leg,
          ...(change.qty === undefined ? {} : { qty: change.qty }),
        },
      ];
  }
}

/** base64url of `{v:3,r:[…]}` — the `?partition=` query parameter. Empty when
 * there is nothing to send, so the URL stays clean. */
export function encodeRows(rows: readonly MembershipRow[]): string {
  if (!rows.length) return '';
  const body = {
    v: 3,
    r: rows.map((x) => ({
      ...(x.positionId === undefined ? {} : { p: x.positionId }),
      k: x.leg.kind === 'perp' ? 'p' : 'b',
      r: x.leg.kind === 'perp' ? x.leg.symbol : x.leg.marketId,
      ...(x.qty === undefined ? {} : { q: x.qty }),
      ...(x.entry === undefined ? {} : { e: x.entry }),
    })),
  };
  // btoa needs latin1; the payload is ASCII by construction (symbols and ids
  // are alphanumeric), so no escape dance is required.
  return btoa(JSON.stringify(body)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
