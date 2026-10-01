import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEYS } from '../../src/server/releaseKey';
import { compareVersions, readLocalVersion } from '../../src/server/version';

const PEM = new URL('../../release-signing.pub.pem', import.meta.url);
const VERSION = readLocalVersion(fileURLToPath(new URL('../..', import.meta.url))) ?? '';
const SHIPS_SIGNED_UPDATES = (compareVersions(VERSION, '1.7.2') ?? 1) > 0;

describe('the trusted release key', () => {
  it.runIf(SHIPS_SIGNED_UPDATES)('is the public key the release workflow verifies with', () => {
    expect(existsSync(PEM), 'release-signing.pub.pem is missing at the repo root').toBe(true);
    expect(RELEASE_PUBLIC_KEYS.map((k) => k.trim())).toContain(readFileSync(PEM, 'utf8').trim());
  });
});
