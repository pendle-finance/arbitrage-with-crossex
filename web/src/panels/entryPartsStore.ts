/** Which perp entry-cost parts a position is NOT charged, remembered across
 * reloads.
 *
 * This deliberately departs from the sibling Close/Roll and Include/Omit
 * toggles, which are per-card session state on purpose (see HomeControls): those
 * are viewing preferences, and re-picking one is instant. Un-ticking an
 * execution records a FACT about the position — "those fills belonged to my
 * previous strategy" — which the user would otherwise have to re-establish, from
 * memory, on every reload. */
import { readJson, writeJson } from '../lib/storage';

// v2: keyed by the strategy's own id, because one (base, maturity) can now
// hold several strategies. v1 entries are deliberately NOT migrated — an old
// `base:maturity` exclusion applied to every tranche of that maturity would
// hand back the same cost twice. They lapse; the card says so once.
const KEY = 'crossex.entryParts.v2';
export const LEGACY_KEY = 'crossex.entryParts.v1';

/** Matured positions would otherwise leave keys behind forever, and a card can
 * only ever see its own strategy — so a time bound is the only way to keep this
 * from growing without limit. Comfortably longer than any Boros maturity. */
const MAX_AGE_SEC = 180 * 24 * 3600;

interface Entry {
  ids: string[];
  savedAtSec: number;
}
type Stored = Record<string, Entry>;

const isEntry = (v: unknown): v is Entry =>
  !!v &&
  typeof v === 'object' &&
  Array.isArray((v as Entry).ids) &&
  (v as Entry).ids.every((s) => typeof s === 'string') &&
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

/** True when this browser still held v1 exclusions, which no longer apply.
 *
 * Answered ONCE per session, and the dead key is dropped as it is read: the
 * card shows "your un-ticks were reset" while that is news, and never again.
 * Left in place it would become permanent chrome on every card — and a
 * localStorage read on every render. */
let lapsedLegacy: boolean | undefined;
export function hasLapsedLegacyExclusions(): boolean {
  if (lapsedLegacy === undefined) {
    try {
      lapsedLegacy = localStorage.getItem(LEGACY_KEY) !== null;
      if (lapsedLegacy) localStorage.removeItem(LEGACY_KEY);
    } catch {
      lapsedLegacy = false;
    }
  }
  return lapsedLegacy;
}

export function loadExcludedPartIds(key: string): ReadonlySet<string> {
  return new Set(readAll()[key]?.ids ?? []);
}

export function saveExcludedPartIds(key: string, ids: ReadonlySet<string>, nowSec: number): void {
  const all = readAll();
  // Prune first, so one write can't carry stale entries forward forever.
  for (const [k, v] of Object.entries(all)) {
    if (nowSec - v.savedAtSec > MAX_AGE_SEC) delete all[k];
  }
  if (ids.size === 0) delete all[key]; // the default costs nothing to store
  else all[key] = { ids: [...ids], savedAtSec: nowSec };
  writeJson(KEY, all);
}
