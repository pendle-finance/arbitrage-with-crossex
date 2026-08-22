import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST, makeTestApp, mockGateGet, mockGatePost } from './helpers/gate-nock';

const SYMBOL = 'GATE_FUTURE_ETH_USDT';

describe('/api/leverage/:symbol', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  it('GET returns current leverage + leverageMax', async () => {
    app = makeTestApp();
    mockGateGet('/positions/leverage', { body: { [SYMBOL]: '5' } });
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });

    const res = await app.inject({ method: 'GET', url: `/api/leverage/${SYMBOL}`, headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ symbol: SYMBOL, leverage: 5, leverageMax: 50 });
  });

  it('GET stays available and reports max 0 when the risk row is tierless', async () => {
    app = makeTestApp();
    mockGateGet('/positions/leverage', { body: { [SYMBOL]: '5' } });
    mockGateGet('/rule/risk_limits', { body: [{ symbol: SYMBOL, tiers: [] }] });

    const res = await app.inject({ method: 'GET', url: `/api/leverage/${SYMBOL}`, headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ symbol: SYMBOL, leverage: 5, leverageMax: 0 });
  });

  it.each([
    ['empty', []],
    ['tierless', [{ symbol: SYMBOL, tiers: [] }]],
  ])('PUT fails closed on an %s risk-limit reply and performs no Gate write', async (_name, limits) => {
    app = makeTestApp();
    mockGateGet('/rule/risk_limits', { body: limits });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/leverage/${SYMBOL}`,
      headers: HOST,
      payload: { leverage: 5 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ category: 'leverage' });
    expect(res.json().error.message).toMatch(/could not verify maximum leverage/);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('PUT over max → 400 category leverage, and no Gate write happens', async () => {
    app = makeTestApp();
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });
    // No POST /crossex/positions/leverage interceptor exists: with net disabled,
    // any attempted write would explode into a network error, not a clean 400.

    const res = await app.inject({
      method: 'PUT',
      url: `/api/leverage/${SYMBOL}`,
      headers: HOST,
      payload: { leverage: 100 },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.category).toBe('leverage');
    expect(nock.pendingMocks()).toEqual([]); // only the risk-limits read was consumed
  });

  it('PUT within max writes {symbol, leverage} to Gate and busts the positions cache', async () => {
    app = makeTestApp();
    // Two positions interceptors: cached GET before the PUT + refetch after the bust.
    const positionsScope = mockGateGet('/positions', { fixture: 'positions.empty.json', times: 2 });
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });
    const writeScope = mockGatePost('/positions/leverage', {
      requestBody: { symbol: SYMBOL, leverage: '5' }, // SDK serializes leverage as a string
      body: { symbol: SYMBOL, leverage: '5' },
    });

    const before = await app.inject({ method: 'GET', url: '/api/positions', headers: HOST });
    expect(before.statusCode).toBe(200);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/leverage/${SYMBOL}`,
      headers: HOST,
      payload: { leverage: 5 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toEqual({ symbol: SYMBOL, leverage: 5 });
    expect(writeScope.isDone()).toBe(true);

    // Within the 2s TTL, so a second Gate call proves the cache was busted.
    const after = await app.inject({ method: 'GET', url: '/api/positions', headers: HOST });
    expect(after.statusCode).toBe(200);
    expect(positionsScope.isDone()).toBe(true);
  });

  it('keeps a stale-good max on rate limit instead of replacing it with unknown', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    app = makeTestApp();
    mockGateGet('/positions/leverage', { body: { [SYMBOL]: '5' } });
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });

    const warm = await app.inject({ method: 'GET', url: `/api/leverage/${SYMBOL}`, headers: HOST });
    expect(warm.statusCode).toBe(200);
    expect(warm.json().data.leverageMax).toBe(50);

    vi.setSystemTime(t0 + 600_001);
    mockGateGet('/rule/risk_limits', {
      status: 429,
      body: { label: 'TOO_MANY_REQUESTS', message: 'slow down' },
    });
    const write = mockGatePost('/positions/leverage', {
      requestBody: { symbol: SYMBOL, leverage: '50' },
      body: { symbol: SYMBOL, leverage: '50' },
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/leverage/${SYMBOL}`,
      headers: HOST,
      payload: { leverage: 50 },
    });

    expect(put.statusCode, put.body).toBe(200);
    expect(write.isDone()).toBe(true);
  });
});
