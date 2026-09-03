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
  sinceSec: number;
  exclusions: Exclusions;
}

type AllBooks = Record<string, AssetViewPrefs>;

const EMPTY: AssetViewPrefs = { sinceSec: 0, exclusions: {} };

const validate = (parsed: unknown): AllBooks => {
  if (!parsed || typeof parsed !== 'object') return {};
  const out: AllBooks = {};
  for (const [book, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<AssetViewPrefs>;
    const sinceSec = Number(p.sinceSec);
    const exclusions: Exclusions = {};
    if (p.exclusions && typeof p.exclusions === 'object') {
      for (const [k, q] of Object.entries(p.exclusions)) {
        if (q === 'all') exclusions[k] = 'all';
        else if (Number.isFinite(Number(q)) && Number(q) > 0) exclusions[k] = Number(q);
      }
    }
    out[book] = { sinceSec: Number.isFinite(sinceSec) && sinceSec > 0 ? sinceSec : 0, exclusions };
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
