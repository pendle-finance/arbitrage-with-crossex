/**
 * Update check against the repo's own `version.json` on GitHub `main`.
 *
 * The running copy's version comes from `<repoRoot>/version.json` (shipped
 * inside the install archive); the latest is one small raw-GitHub read,
 * cached for hours. Everything here is deliberately silent: a check that can
 * fail loudly would be worse than no check, so every failure — missing local
 * file, network, non-200, bad JSON, unparseable version — resolves to "no
 * update", never an error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FetchLike } from '../core/boros/client';

export const VERSION_URL =
  'https://raw.githubusercontent.com/pendle-finance/crossex-boros-terminal/main/version.json';
const FETCH_TIMEOUT_MS = 5_000;
/** Cap on remote highlights — the modal is a nudge, not a changelog. */
const MAX_HIGHLIGHTS = 10;

export interface RemoteVersion {
  version: string;
  highlights: string[];
}

/** The running copy's version from `<repoRoot>/version.json`, or null when the
 * file is missing/unparseable — callers then skip the remote check entirely. */
export function readLocalVersion(repoRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** What the installer recorded about the tree it laid down. Written into the
 * app dir, so it is swapped atomically with the code it describes. */
export interface InstallInfo {
  repo: string | null;
  requestedRef: string | null;
  commit: string | null;
  source: string | null;
  installedAt: string | null;
}

/** Read `<repoRoot>/install-info.json`, or null when there is none — a source
 * checkout has no installer provenance, and that is not an error. Fields are
 * coerced and length-capped: a hand-edited file must not reshape the API. */
export function readInstallInfo(repoRoot: string): InstallInfo | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'install-info.json'), 'utf8'),
    ) as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
    return {
      repo: str(parsed.repo),
      requestedRef: str(parsed.requestedRef),
      commit: str(parsed.commit),
      source: str(parsed.source),
      installedAt: str(parsed.installedAt),
    };
  } catch {
    return null;
  }
}

/**
 * Piecewise-numeric compare ("1.10.0" > "1.9.9"; a leading "v" and differing
 * segment counts are tolerated, missing segments count 0). Returns null when
 * either side is unparseable — callers must treat null as "not newer", so a
 * garbage version can never announce an update.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (s: string): number[] | null => {
    const parts = s.trim().replace(/^v/, '').split('.');
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.length > 0 && nums.every(Number.isFinite) ? nums : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Fetch the latest published version.json. NEVER throws — any failure returns
 * null, which the TtlCache then holds for the full TTL (one quiet retry per
 * window, not a retry storm). */
export async function fetchLatestVersion(fetchImpl: FetchLike): Promise<RemoteVersion | null> {
  try {
    const res = await fetchImpl(VERSION_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; highlights?: unknown };
    if (typeof body.version !== 'string') return null;
    const highlights = Array.isArray(body.highlights)
      ? body.highlights.filter((h): h is string => typeof h === 'string').slice(0, MAX_HIGHLIGHTS)
      : [];
    return { version: body.version, highlights };
  } catch {
    return null;
  }
}
