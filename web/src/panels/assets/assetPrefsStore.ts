import type { AssetPrefsPatch } from '../../api/queries';
import { readJson, writeJson } from '../../lib/storage';
import type { Exclusions } from './assetModel';

const LEGACY_KEY = 'crossex.assetView.v1';

/** The `legSince` query value: `marketId:sec` pairs, sorted for a stable key. */
export function legSinceParam(legSince: Record<string, number>): string {
  return Object.entries(legSince)
    .map(([k, sec]) => [Number(k.replace(/^boros:/, '')), sec] as const)
    .filter(([id, sec]) => Number.isFinite(id) && sec > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, sec]) => `${id}:${sec}`)
    .join(',');
}

export function readLegacyPrefs(): unknown {
  return readJson<unknown>(LEGACY_KEY, null, (parsed) => parsed);
}

export function clearLegacyPrefs(): void {
  localStorage.removeItem(LEGACY_KEY);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function legacyBook(map: unknown, book: string): Record<string, unknown> | null {
  const entry = isRecord(map) ? map[book] : undefined;
  return isRecord(entry) ? entry : null;
}

export function legacyExclusionsFor(book: string): Exclusions {
  const exclusions = legacyBook(readLegacyPrefs(), book)?.exclusions;
  if (!isRecord(exclusions)) return {};
  return Object.fromEntries(
    Object.entries(exclusions).filter(([k, v]) => k.startsWith('boros:') && v !== null),
  ) as Exclusions;
}

export function dropLegacyKeys(book: string, patch: AssetPrefsPatch): void {
  const map = readLegacyPrefs();
  const entry = legacyBook(map, book);
  if (!entry) return;
  for (const [section, keys] of Object.entries(patch)) {
    const target = entry[section];
    if (isRecord(target)) for (const key of Object.keys(keys ?? {})) delete target[key];
  }
  writeJson(LEGACY_KEY, map);
}
