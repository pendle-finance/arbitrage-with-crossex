import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkFile, verifyRelease } from '../../src/server/releaseVerify';

const pair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const trusted = pair();
const PEM = trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const COMMIT = '3f7c1b9e2d4a6058cbe1740f9a2d5b83c6e0f1a4';
const TARBALL = Buffer.from('tarball bytes');

function release(fields: Record<string, unknown> = {}, key: KeyObject = trusted.privateKey) {
  const json = Buffer.from(
    JSON.stringify({
      version: '1.8.0',
      commit: COMMIT,
      highlights: ['faster'],
      files: { 'app.tar.gz': createHash('sha256').update(TARBALL).digest('hex') },
      ...fields,
    }),
  );
  return { json, sig: sign('sha256', json, { key, dsaEncoding: 'der' }) };
}

describe('verifyRelease', () => {
  it('accepts a manifest signed by a trusted key', () => {
    const { json, sig } = release();
    expect(verifyRelease(json, sig, '1.7.2', [PEM])).toMatchObject({
      version: '1.8.0',
      commit: COMMIT,
      highlights: ['faster'],
    });
  });

  it('refuses an edited manifest', () => {
    const { json, sig } = release();
    const edited = Buffer.from(json.toString('utf8').replace('1.8.0', '9.9.9'));
    expect(() => verifyRelease(edited, sig, '1.7.2', [PEM])).toThrow(
      'release signature does not match — update refused',
    );
  });

  it('refuses a manifest signed by another key', () => {
    const { json, sig } = release({}, pair().privateKey);
    expect(() => verifyRelease(json, sig, '1.7.2', [PEM])).toThrow(
      'release signature does not match — update refused',
    );
  });

  it('refuses every manifest while no trusted key is shipped', () => {
    const { json, sig } = release();
    expect(() => verifyRelease(json, sig, '1.7.2')).toThrow('release signature does not match — update refused');
  });

  it.each(['1.8.0', '1.9.0'])('refuses a release that is not newer than an installed %s', (installed) => {
    const { json, sig } = release();
    expect(() => verifyRelease(json, sig, installed, [PEM])).toThrow(
      `release 1.8.0 is not newer than ${installed} — update refused`,
    );
  });

  it('refuses a commit that is not 40 hex characters', () => {
    const { json, sig } = release({ commit: 'main' });
    expect(() => verifyRelease(json, sig, '1.7.2', [PEM])).toThrow(
      'release commit "main" is not a 40-hex sha — update refused',
    );
  });

  it('refuses a signed manifest with the wrong shape', () => {
    const { json, sig } = release({ files: { 'app.tar.gz': 'not-a-hash' } });
    expect(() => verifyRelease(json, sig, '1.7.2', [PEM])).toThrow(
      'release.json has the wrong shape — update refused',
    );
  });
});

describe('checkFile', () => {
  const { json, sig } = release();
  const manifest = verifyRelease(json, sig, '1.7.2', [PEM]);

  it('passes a file whose sha256 the manifest names', () => {
    expect(() => checkFile(manifest, 'app.tar.gz', TARBALL)).not.toThrow();
  });

  it('refuses a changed file', () => {
    expect(() => checkFile(manifest, 'app.tar.gz', Buffer.from('tarball bytes!'))).toThrow(
      'app.tar.gz does not match the signed release — update refused',
    );
  });

  it('refuses a file the manifest does not name', () => {
    expect(() => checkFile(manifest, 'install.sh', TARBALL)).toThrow(
      'install.sh does not match the signed release — update refused',
    );
  });
});
