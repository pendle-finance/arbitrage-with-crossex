import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { ReleaseFetch } from '../../../src/server/version';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

export const RELEASE_TEST_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const RELEASE_COMMIT = '3f7c1b9e2d4a6058cbe1740f9a2d5b83c6e0f1a4';
export const RELEASES_URL = 'https://api.github.com/repos/pendle-finance/arbitrage-with-crossex/releases';
export const LATEST_URL = `${RELEASES_URL}/latest`;
export const assetUrl = (name: string): string => `${RELEASES_URL}/assets/${name}`;

export const RELEASE_FILES: Record<string, Buffer> = {
  'app.tar.gz': Buffer.from('signed tarball bytes'),
  'app.zip': Buffer.from('signed zip bytes'),
  'install.sh': Buffer.from('#!/bin/bash\n# Arbitrage with CrossEx installer (test fixture)\n'),
  'install.ps1': Buffer.from('# Arbitrage with CrossEx - Windows installer (test fixture)\n'),
};

export interface ReleaseStubOpts {
  version?: string;
  tag?: string;
  highlights?: string[];
  manifest?: Record<string, unknown>;
  served?: Record<string, Buffer>;
  assetStatus?: Record<string, number>;
  badSignature?: boolean;
  status?: number;
  reject?: boolean;
  calls?: string[];
}

export function releaseFetch(opts: ReleaseStubOpts = {}): ReleaseFetch {
  const version = opts.version ?? '1.1.0';
  const manifest = Buffer.from(
    JSON.stringify({
      version,
      commit: RELEASE_COMMIT,
      highlights: opts.highlights ?? [],
      files: Object.fromEntries(
        Object.entries(RELEASE_FILES).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]),
      ),
      ...opts.manifest,
    }),
  );
  const signed = opts.badSignature ? Buffer.concat([manifest, Buffer.from(' ')]) : manifest;
  const assets: Record<string, Buffer> = {
    ...RELEASE_FILES,
    ...opts.served,
    'release.json': manifest,
    'release.json.sig': sign('sha256', signed, { key: privateKey, dsaEncoding: 'der' }),
  };
  const reply = (status: number, body: Buffer | unknown) => ({
    ok: status < 400,
    status,
    json: async () => body,
    arrayBuffer: async () => {
      const bytes = body as Buffer;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  });
  return async (url) => {
    opts.calls?.push(url);
    if (opts.reject) throw new Error('network down');
    if (url === LATEST_URL || url.startsWith(`${RELEASES_URL}/tags/`)) {
      return reply(opts.status ?? 200, {
        tag_name: opts.tag ?? `v${version}`,
        assets: Object.keys(assets).map((name) => ({ name, url: assetUrl(name) })),
      });
    }
    const name = Object.keys(assets).find((n) => url === assetUrl(n));
    if (!name) return reply(404, {});
    return reply(opts.assetStatus?.[name] ?? 200, assets[name]);
  };
}
