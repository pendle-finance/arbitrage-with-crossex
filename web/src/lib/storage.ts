/** The Opportunities controls (capital, perp entry, …). The order ticket reads
 * its perp entry too, so the two start on the same setting. */
export const OPPORTUNITIES_STORAGE_KEY = 'crossex.opportunities.v2';

/** Best-effort localStorage JSON persistence (quota / private-mode tolerant).
 * readJson: any failure (missing key, bad JSON, throw in validate) → fallback. */
export function readJson<T>(key: string, fallback: T, validate: (parsed: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : validate(JSON.parse(raw) as unknown);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}
