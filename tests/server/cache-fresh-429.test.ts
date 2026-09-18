import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const rateLimited = () => ({ response: { status: 429, data: { label: 'TOO_MANY_REQUESTS' } } });

describe('a fresh cache read never serves stale on a 429', () => {
  it('fresh read never serves stale: the primary fetch 429s with a stale value cached', async () => {
    const cache = new TtlCache();
    await cache.get('k', 0, async () => 'cached');
    await expect(cache.get('k', 1000, async () => Promise.reject(rateLimited()), { fresh: true })).rejects.toEqual(
      rateLimited(),
    );
  });

  it('fresh read never serves stale: a second fresh read during a 429 throws too', async () => {
    const cache = new TtlCache();
    await cache.get('k', 0, async () => 'cached');
    let reject!: (e: unknown) => void;
    const slow = new Promise<string>((_, rej) => (reject = rej));
    const fetch = vi.fn(() => slow);
    const primary = cache.get('k', 1000, fetch, { fresh: true });
    const waiter = cache.get('k', 1000, fetch, { fresh: true });
    reject(rateLimited());
    await expect(primary).rejects.toEqual(rateLimited());
    await expect(waiter).rejects.toEqual(rateLimited());
  });

  it('a non-fresh read keeps the stale fallback on the same paths', async () => {
    const cache = new TtlCache();
    await cache.get('k', 0, async () => 'cached');
    const stale = await cache.get('k', 1000, async () => Promise.reject(rateLimited()));
    expect(stale).toEqual({ value: 'cached', stale: true });
  });
});

describe('?fresh=1 over HTTP never serves a stale account on a 429', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  it('fresh read never serves stale: GET /api/account?fresh=1 rethrows past a warm cache', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });

    app = makeTestApp();
    mockGateGet('/accounts', { fixture: 'account.json' });
    mockGateGet('/accounts', { status: 429, body: { label: 'TOO_MANY_REQUESTS', message: 'too many requests' } });

    const warm = await app.inject({ method: 'GET', url: '/api/account', headers: HOST });
    expect(warm.statusCode).toBe(200);

    vi.setSystemTime(t0 + 3000);

    const fresh = await app.inject({ method: 'GET', url: '/api/account?fresh=1', headers: HOST });
    expect(fresh.statusCode).toBe(429);
    const body = fresh.json();
    expect(body.ok).toBe(false);
    expect(body.error.category).toBe('rate-limited');
    expect(body.data).toBeUndefined();
  });
});
