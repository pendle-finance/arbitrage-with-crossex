/**
 * Update check against the repo's latest signed GitHub Release.
 *
 * The running copy's version comes from `<repoRoot>/version.json` (shipped
 * inside the install archive); the latest is the Release's `release.json`,
 * trusted only when its signature matches a release key, and cached for hours.
 * A check that can fail loudly would be worse than no check, so every failure
 * — missing local file, network, non-200, a bad signature or manifest, an
 * unparseable version — resolves to "no update", never an error. A failed
 * read or check leaves one log line with the reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FetchLike } from '../core/boros/client';
import { type ReleaseManifest, verifyRelease } from './releaseVerify';

const RELEASES_URL = 'https://api.github.com/repos/pendle-finance/arbitrage-with-crossex/releases';
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 5_000;
/** Cap on remote highlights — the modal is a nudge, not a changelog. */
const MAX_HIGHLIGHTS = 10;

export type ReleaseFetch = (
  ...args: Parameters<FetchLike>
) => Promise<Awaited<ReturnType<FetchLike>> & { arrayBuffer(): Promise<ArrayBuffer> }>;

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  assets: Map<string, string>;
}

export interface RemoteVersion {
  version: string;
  highlights: string[];
  commit: string | null;
}

/** Read a JSON file this app wrote about itself, tolerating a UTF-8 BOM.
 * `JSON.parse` throws on a leading U+FEFF and every failure here is swallowed,
 * so a BOM surfaces as "installed copy claims to be a source checkout" rather
 * than as an error. install.ps1 no longer writes one; Notepad still would. */
function readSelfJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** The running copy's version from `<repoRoot>/version.json`, or null when the
 * file is missing/unparseable — callers then skip the remote check entirely. */
export function readLocalVersion(repoRoot: string): string | null {
  try {
    const parsed = readSelfJson(path.join(repoRoot, 'version.json')) as { version?: unknown };
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
    const parsed = readSelfJson(path.join(repoRoot, 'install-info.json')) as Record<
      string,
      unknown
    >;
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

export const releaseUrl = (): string =>
  process.env.BOROS_RELEASE_TAG
    ? `${RELEASES_URL}/tags/${encodeURIComponent(process.env.BOROS_RELEASE_TAG)}`
    : `${RELEASES_URL}/latest`;

export async function downloadAsset(
  fetchImpl: ReleaseFetch,
  assets: Map<string, string>,
  name: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Buffer> {
  const url = assets.get(name);
  if (!url) throw new Error(`the release has no ${name} — update refused`);
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`could not download ${name} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchVerifiedRelease(
  fetchImpl: ReleaseFetch,
  current: string,
): Promise<VerifiedRelease | null> {
  const res = await fetchImpl(releaseUrl(), {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not read the release (HTTP ${res.status})`);
  const body = (await res.json()) as { tag_name?: unknown; assets?: unknown };
  const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/-rc\.\d+$/, '') : '';
  if ((compareVersions(tag, current) ?? 0) <= 0) return null;
  const assets = new Map<string, string>();
  for (const asset of Array.isArray(body.assets) ? body.assets : []) {
    if (typeof asset?.name === 'string' && typeof asset.url === 'string') assets.set(asset.name, asset.url);
  }
  const [json, signature] = await Promise.all([
    downloadAsset(fetchImpl, assets, 'release.json'),
    downloadAsset(fetchImpl, assets, 'release.json.sig'),
  ]);
  return { manifest: verifyRelease(json, signature, current), assets };
}

/** The latest signed release, when it is newer than `current`. NEVER throws —
 * any failure returns null, which the TtlCache then holds for the full TTL (one
 * quiet retry per window, not a retry storm). */
export async function fetchLatestVersion(
  fetchImpl: ReleaseFetch,
  current: string,
): Promise<RemoteVersion | null> {
  try {
    const release = await fetchVerifiedRelease(fetchImpl, current);
    if (!release) return null;
    const { version, highlights, commit } = release.manifest;
    return { version, highlights: highlights.slice(0, MAX_HIGHLIGHTS), commit };
  } catch (err) {
    console.warn(`update check: ${(err as Error).message}`);
    return null;
  }
}
