/**
 * GET /api/version — the GitHub update check. The route must be silent on
 * every failure (a check that can fail loudly is worse than no check), lazy
 * (no remote read until asked), cached, and provably network-free whenever
 * the local version is unknown or the check is disabled.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { compareVersions, VERSION_URL } from '../../src/server/version';
import { HOST, makeTestApp } from './helpers/gate-nock';

/** Minimal FetchLike stub in the boros-stub style. */
function stub(
  body: unknown,
  opts: { status?: number; reject?: boolean; calls?: string[] } = {},
): FetchLike {
  return async (url) => {
    opts.calls?.push(url);
    if (opts.reject) throw new Error('network down');
    const status = opts.status ?? 200;
    return { ok: status < 400, status, json: async () => body };
  };
}

describe('GET /api/version', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const get = () => app.inject({ method: 'GET', url: '/api/version', headers: HOST });

  it('announces a newer remote with its highlights', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: ['a', 'b'] }, { calls }),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      current: '1.0.0',
      install: null,
      latest: '1.1.0',
      updateAvailable: true,
      highlights: ['a', 'b'],
    });
    expect(calls).toEqual([VERSION_URL]);
  });

  it('equal versions: no update, no highlights', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.1.0' },
      versionFetch: stub({ version: '1.1.0', highlights: ['a'] }),
    });
    const { data } = (await get()).json();
    expect(data.updateAvailable).toBe(false);
    expect(data.highlights).toEqual([]);
  });

  it('a locally-newer dev checkout never sees the banner', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.2.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
  });

  it('network failure is silent: 200, no update — the route never throws', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub(null, { reject: true }),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      current: '1.0.0',
      install: null,
      latest: null,
      updateAvailable: false,
      highlights: [],
    });
  });

  it('non-200 and malformed bodies are equally silent', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0' }, { status: 404 }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
    await app.close();

    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: 42 }),
    });
    expect((await get()).json().data.latest).toBeNull();
    await app.close();

    // Unparseable remote version → null compare → "not newer".
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.0.x' }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
  });

  it('caches the remote read — two requests, one fetch', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { calls }),
    });
    await get();
    await get();
    expect(calls).toHaveLength(1);
  });

  it('UPDATE_CHECK=0 (disabled) never touches the network', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0', disabled: true },
      versionFetch: stub({ version: '9.9.9', highlights: [] }, { calls }),
    });
    const { data } = (await get()).json();
    expect(calls).toHaveLength(0);
    expect(data).toEqual({
      current: '1.0.0',
      install: null,
      latest: null,
      updateAvailable: false,
      highlights: [],
    });
  });

  it('an unknown local version (the makeTestApp default) is network-free too', async () => {
    // Every existing test app omits updateCheck — this pins that none of them
    // can escape nock through the update check's global-fetch default.
    const calls: string[] = [];
    app = makeTestApp({ versionFetch: stub({ version: '9.9.9', highlights: [] }, { calls }) });
    const { data } = (await get()).json();
    expect(calls).toHaveLength(0);
    expect(data.current).toBeNull();
    expect(data.updateAvailable).toBe(false);
  });

  it('echoes the installer provenance so the UI can show which commit runs', async () => {
    const install = {
      repo: 'pendle-finance/arbitrage-with-crossex',
      requestedRef: 'refs/heads/main',
      commit: 'f4f681af8b36c1bddc98048f214ff1405d56ca73',
      source: 'github-archive',
      installedAt: '2026-07-30T10:00:00Z',
    };
    app = makeTestApp({ updateCheck: { current: '1.0.0', disabled: true }, install });
    expect((await get()).json().data.install).toEqual(install);
  });
});

describe('compareVersions', () => {
  it('compares piecewise numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')!).toBeGreaterThan(0);
    expect(compareVersions('1.9.9', '1.10.0')!).toBeLessThan(0);
  });

  it('tolerates a v prefix and differing segment counts', () => {
    expect(compareVersions('v1.1.0', '1.1')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')!).toBeGreaterThan(0);
  });

  it('returns null on garbage — treated as "not newer" by callers', () => {
    expect(compareVersions('1.0.x', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', '')).toBeNull();
    expect(compareVersions('main', '1.0.0')).toBeNull();
  });
});
