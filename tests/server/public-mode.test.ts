/**
 * PUBLIC_MODE app surface (the read-only public landing deploy): foreign hosts
 * are served, ONLY health + opportunities exist (credentialed/trading routes
 * 404 — they are never registered), and the fresh=1 cache bypass is inert so an
 * anonymous caller can't force the full venue fan-out per request. The default
 * (non-public) app's guard and route table are pinned by the per-route suites.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { requireClients } from '../../src/core/clients';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import { borosStub } from '../helpers/boros-stub';

const EMPTY_MARKETS = { '/core/v1/markets': { results: [], total: 0, skip: 0 } };

/** The real public boot shape (src/server/index.ts under PUBLIC_MODE=1): no
 * engine (ledger + loop), no credentials service, clients permanently unconfigured. */
function makePublicApp(calls?: string[]): FastifyInstance {
  return buildApp({
    getClients: () => requireClients(null),
    cache: new TtlCache(),
    publicMode: true,
    borosFetch: borosStub(EMPTY_MARKETS, calls),
  });
}

describe('public mode', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('serves /api/opportunities and /api/health to a foreign Host/Origin (proxy-fronted)', async () => {
    app = makePublicApp();
    const headers = { host: 'example.com', origin: 'https://example.com' };

    const opps = await app.inject({ method: 'GET', url: '/api/opportunities', headers });
    expect(opps.statusCode).toBe(200);
    const body = opps.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.groups)).toBe(true);

    const health = await app.inject({ method: 'GET', url: '/api/health', headers });
    expect(health.statusCode).toBe(200);
    expect(health.json().data).toEqual({ status: 'ok' });
  });

  it('never registers credentialed or trading routes — 404, not 401/503', async () => {
    app = makePublicApp();
    const requests: Array<{ method: 'GET' | 'PUT' | 'POST' | 'DELETE'; url: string }> = [
      { method: 'GET', url: '/api/credentials' },
      { method: 'PUT', url: '/api/credentials' },
      { method: 'GET', url: '/api/account' },
      { method: 'GET', url: '/api/fees' },
      { method: 'GET', url: '/api/positions' },
      { method: 'GET', url: '/api/orders/open' },
      { method: 'DELETE', url: '/api/orders/123' },
      { method: 'GET', url: '/api/trades' },
      { method: 'GET', url: '/api/symbols' },
      { method: 'GET', url: '/api/strategy/0xabc' },
      { method: 'GET', url: '/api/books/GATE_FUTURE_ETH_USDT' },
      { method: 'PUT', url: '/api/leverage/GATE_FUTURE_ETH_USDT' },
      { method: 'POST', url: '/api/preview' },
      { method: 'POST', url: '/api/deals' },
      { method: 'GET', url: '/api/deals/some-id' },
      // The update check reads GitHub — the public landing must never carry it.
      { method: 'GET', url: '/api/version' },
    ];
    for (const { method, url } of requests) {
      const res = await app.inject({ method, url, headers: { host: 'example.com' } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('serves every response with the browser-side walls — no framing, sniffing, or full-URL referers', async () => {
    // The public origin now reflects (validated, escaped) stranger input at
    // /position, so the defense-in-depth headers apply in public mode too.
    app = makePublicApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'example.com' },
    });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('has no /position page unless the entry point passes the dep (no new /api surface either)', async () => {
    // The shared-position page is the one non-/api route a public deploy adds;
    // its own suite (position-page.test.ts) pins the served behavior. Here:
    // absent the dep — the exact makePublicApp shape above — it 404s like
    // everything else, and no /api/position ever exists.
    app = makePublicApp();
    const headers = { host: 'example.com' };
    expect((await app.inject({ method: 'GET', url: '/position', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/position', headers })).statusCode).toBe(404);
  });

  it('ignores ?fresh=1 — the second request is served from cache', async () => {
    const calls: string[] = [];
    app = makePublicApp(calls);
    const headers = { host: 'example.com' };

    const first = await app.inject({ method: 'GET', url: '/api/opportunities?fresh=1', headers });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: '/api/opportunities?fresh=1', headers });
    expect(second.statusCode).toBe(200);

    // Markets TTL is 30s — a second upstream hit could only be the fresh bypass.
    expect(calls.filter((c) => c.startsWith('/core/v1/markets'))).toHaveLength(1);
  });
});
