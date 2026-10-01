import { createHash, verify } from 'node:crypto';
import { RELEASE_PUBLIC_KEYS } from './releaseKey';
import { COMMIT_SHA, compareVersions } from './version';

export interface ReleaseManifest {
  version: string;
  commit: string;
  highlights: string[];
  files: Record<string, string>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const refused = (reason: string): Error => new Error(`${reason} — update refused`);

function signedByTrustedKey(json: Buffer, signature: Buffer, keys: readonly string[]): boolean {
  return keys.some((key) => {
    try {
      return verify('sha256', json, { key, dsaEncoding: 'der' }, signature);
    } catch {
      return false;
    }
  });
}

function parseManifest(json: Buffer): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw refused('release.json is not valid JSON');
  }
  const m = (parsed ?? {}) as Record<string, unknown>;
  const files = m.files as Record<string, unknown> | null | undefined;
  if (
    typeof m.version !== 'string' ||
    typeof m.commit !== 'string' ||
    !Array.isArray(m.highlights) ||
    !m.highlights.every((h) => typeof h === 'string') ||
    typeof files !== 'object' ||
    files === null ||
    Array.isArray(files) ||
    !Object.values(files).every((h) => typeof h === 'string' && SHA256_HEX.test(h))
  ) {
    throw refused('release.json has the wrong shape');
  }
  return {
    version: m.version,
    commit: m.commit,
    highlights: m.highlights as string[],
    files: files as Record<string, string>,
  };
}

export function verifyRelease(
  json: Buffer,
  signature: Buffer,
  installed: string,
  keys: readonly string[] = RELEASE_PUBLIC_KEYS,
): ReleaseManifest {
  if (!signedByTrustedKey(json, signature, keys)) throw refused('release signature does not match');
  const manifest = parseManifest(json);
  if (!COMMIT_SHA.test(manifest.commit)) {
    throw refused(`release commit ${JSON.stringify(manifest.commit)} is not a 40-hex sha`);
  }
  if ((compareVersions(manifest.version, installed) ?? 0) <= 0) {
    throw refused(`release ${manifest.version} is not newer than ${installed}`);
  }
  return manifest;
}

export function checkFile(manifest: ReleaseManifest, name: string, bytes: Buffer): void {
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) {
    throw refused(`${name} does not match the signed release`);
  }
}
