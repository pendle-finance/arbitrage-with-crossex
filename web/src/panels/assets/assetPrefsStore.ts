/**
 * Asset-view preferences — the ONLY durable state the asset view has:
 *   - sinceSec: the user-chosen start date the lifetime sums are windowed to
 *     (0 = all time), and
 *   - exclusions: legs (or portions of legs) the user does not consider part
 *     of the funding farm (see assetModel.ts Exclusions).
 *
 * Stored under its own key (`crossex.assetView.v1`), per book. Everything else
 * the view shows is derived from the venue feeds, which is the point of the
 * model: lose this key and only preferences are lost, never numbers.
 */
import { readJson, writeJson } from '../../lib/storage';
import { bookKey } from '../bookId';
import type { Exclusions } from './assetModel';

const KEY = 'crossex.assetView.v1';

export interface AssetViewPrefs {
  /** Per-ASSET start dates (base → unix sec; absent = all time). The window
   * is a property of a strategy, not of the app — his call 2026-09-04. */
  sinceByAsset: Record<string, number>;
  exclusions: Exclusions;
  /** Per-Boros-leg "counted from" (borosKey → unix sec): history before it
   * belongs to an earlier use of the same market, not to this farm. */
  legSince: Record<string, number>;
}

/** The `legSince` query value: `marketId:sec` pairs, sorted for a stable key. */
export function legSinceParam(legSince: Record<string, number>): string {
  return Object.entries(legSince)
    .map(([k, sec]) => [Number(k.replace(/^boros:/, '')), sec] as const)
    .filter(([id, sec]) => Number.isFinite(id) && sec > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, sec]) => `${id}:${sec}`)
    .join(',');
}

type AllBooks = Record<string, AssetViewPrefs>;

const EMPTY: AssetViewPrefs = { sinceByAsset: {}, exclusions: {}, legSince: {} };

const validate = (parsed: unknown): AllBooks => {
  if (!parsed || typeof parsed !== 'object') return {};
  const out: AllBooks = {};
  for (const [book, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<AssetViewPrefs> & { sinceSec?: unknown };
    const legSince: Record<string, number> = {};
    if (p.legSince && typeof p.legSince === 'object') {
      for (const [k, q] of Object.entries(p.legSince)) {
        const n = Number(q);
        if (k.startsWith('boros:') && Number.isFinite(n) && n > 0) legSince[k] = n;
      }
    }
    const sinceByAsset: Record<string, number> = {};
    if (p.sinceByAsset && typeof p.sinceByAsset === 'object') {
      for (const [base, q] of Object.entries(p.sinceByAsset)) {
        const n = Number(q);
        if (Number.isFinite(n) && n > 0) sinceByAsset[base.toUpperCase()] = n;
      }
    }
    // Legacy shape carried ONE app-wide sinceSec — the window is per asset
    // now; a legacy date is simply dropped (preferences only, never numbers).
    const exclusions: Exclusions = {};
    if (p.exclusions && typeof p.exclusions === 'object') {
      for (const [k, q] of Object.entries(p.exclusions)) {
        // Exclusions are Boros-only (his call 2026-09-09): a perp leg is
        // never set aside, so a legacy `perp:` entry is dropped rather than
        // left silently shaping the numbers with no row to restore it from.
        if (!k.startsWith('boros:')) continue;
        if (q === 'all') exclusions[k] = 'all';
        else if (q && typeof q === 'object') {
          // The priced-slice shape. A bad qty drops the entry; a bad price
          // keeps the qty and falls back to pro-rata.
          const slice = q as { qty?: unknown; at?: unknown };
          const qty = Number(slice.qty);
          if (!Number.isFinite(qty) || qty <= 0) continue;
          const at = Number(slice.at);
          // A Boros fixed rate can be negative (negative-funding regime), so
          // only a non-number is dropped — the sign is part of the price.
          exclusions[k] = Number.isFinite(at) ? { qty, at } : { qty };
        } else if (Number.isFinite(Number(q)) && Number(q) > 0) exclusions[k] = Number(q);
      }
    }
    out[book] = { sinceByAsset, exclusions, legSince };
  }
  return out;
};

export function loadPrefs(bookId: string | null): AssetViewPrefs {
  return readJson<AllBooks>(KEY, {}, validate)[bookKey(bookId)] ?? EMPTY;
}

export function savePrefs(bookId: string | null, prefs: AssetViewPrefs): void {
  const all = readJson<AllBooks>(KEY, {}, validate);
  all[bookKey(bookId)] = prefs;
  writeJson(KEY, all);
}
