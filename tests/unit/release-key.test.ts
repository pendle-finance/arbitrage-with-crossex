import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_PUBLIC_KEYS } from '../../src/server/releaseKey';

const PEM = new URL('../../release-signing.pub.pem', import.meta.url);

describe('the trusted release key', () => {
  it('is the public key the release workflow verifies with', () => {
    expect(existsSync(PEM), 'release-signing.pub.pem is missing at the repo root').toBe(true);
    expect(RELEASE_PUBLIC_KEYS.map((k) => k.trim())).toContain(readFileSync(PEM, 'utf8').trim());
  });
});
