/**
 * Asset-view preferences — the ONLY durable state the asset view has:
 *   - sinceSec: the user-chosen start date the lifetime sums are windowed to
 *     (0 = all time), and
 *   - exclusions: legs (or portions of legs) the user does not consider part
 *     of the funding farm (see assetModel.ts Exclusions).
 *
 * Stored under its own key (`crossex.assetView.v1`), per book — never touches
 * the classic view's annotations. Everything else the view shows is derived
 * from the venue feeds, which is the point of the model: lose this key and
 * only preferences are lost, never numbers.
 */
import { readJson, writeJson } from '../../lib/storage';
import { bookKey } from '../partitionStore';
import type { Exclusions } from './assetModel';

const KEY = 'crossex.assetView.v1';

export interface AssetViewPrefs {
  /** Per-ASSET start dates (base → unix sec; absent = all time). The window
   * is a property of a strategy, not of the app — his call 2026-09-04. */
  sinceByAsset: Record<string, number>;
  exclusions: Exclusions;
}

type AllBooks = Record<string, AssetViewPrefs>;

const EMPTY: AssetViewPrefs = { sinceByAsset: {}, exclusions: {} };

const validate = (parsed: unknown): AllBooks => {
  if (!parsed || typeof parsed !== 'object') return {};
  const out: AllBooks = {};
  for (const [book, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<AssetViewPrefs> & { sinceSec?: unknown };
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
        if (q === 'all') exclusions[k] = 'all';
        else if (Number.isFinite(Number(q)) && Number(q) > 0) exclusions[k] = Number(q);
      }
    }
    out[book] = { sinceByAsset, exclusions };
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
