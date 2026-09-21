/**
 * Regression for the live rule shape that broke the smoke test: min_notional,
 * max_market_size and max_limit_size arriving as JSON `null` (the SDK's `string`
 * typing lies). Asserts the null limits (1) round-trip as null through GET
 * /api/symbols/:symbol without crashing and (2) raise no spurious sizing violation,
 * with the null max documented as UNCAPPED (Number(null) === 0 disables the cap).
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import type { PreviewResult } from '../../src/core/actions';
import { gate, HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const NULLS = 'rule-symbols-nulls.json';
const SYMBOL = 'GATE_FUTURE_HYPE_USDT';
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  nock.cleanAll();
});

function mockSpotTicker(pair: string, last: string): void {
  gate().get('/api/v4/spot/tickers').query(true).times(4).reply(200, [{ currency_pair: pair, last }]);
}

async function preview(actions: unknown[]): Promise<PreviewResult[]> {
  const res = await app.inject({ method: 'POST', url: '/api/preview', headers: HOST, payload: { actions } });
  expect(res.statusCode).toBe(200);
  return res.json().data.previews as PreviewResult[];
}

describe('null rule limits', () => {
  it('GET /api/symbols/:symbol returns null limits as null (no crash)', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: NULLS });
    mockGateGet('/rule/risk_limits', { body: [] });

    const res = await app.inject({ method: 'GET', url: `/api/symbols/${SYMBOL}`, headers: HOST });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.symbol).toBe(SYMBOL);
    expect(data.minNotional).toBeNull();
    expect(data.maxMarketSize).toBeNull();
    expect(data.maxLimitSize).toBeNull();
  });

  it('preview raises NO spurious violation from the null min_notional/max_size', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: NULLS });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('HYPE_USDT', '10');

    const previews = await preview([{ kind: 'open-market', symbol: SYMBOL, side: 'BUY', qty: '0.05' }]);
    // null min_notional → 0 → no below-min-notional; null max → 0 → no size cap.
    expect(previews[0].violations).toEqual([]);
    expect(previews[0].qty).toBe('0.05');
  });

  it('an oversized qty is UNCAPPED when max_market_size is null (Number(null) === 0 disables the cap)', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: NULLS });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('HYPE_USDT', '10');

    const previews = await preview([{ kind: 'open-market', symbol: SYMBOL, side: 'BUY', qty: '999999999' }]);
    // Documented behavior: the null max is treated as "no cap", so the oversize is NOT caught.
    expect(previews[0].violations.map((v) => v.code)).not.toContain('exceeds-max-market-size');
    expect(previews[0].violations).toEqual([]);
    expect(previews[0].qty).toBe('999999999.00'); // floored to lot 0.01 (2 dp), not capped
  });

  it('deal creation does NOT reject on the null limits (oversize passes uncapped -> 202)', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: NULLS });
    mockGateGet('/accounts', { fixture: 'account.json' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: HOST,
      payload: {
        id: 'null-limits-deal',
        a: { symbol: SYMBOL, side: 'BUY' },
        qty: '999999999',
        execution: 'taker',
      },
    });
    expect(res.statusCode, res.body).toBe(202); // NOT a 400 validation rejection

    const got = await app.inject({ method: 'GET', url: '/api/deals/null-limits-deal', headers: HOST });
    expect(got.json().data.pair.mode).toBe('CONVERTING'); // intent created; the loop owns the rest
  });
});
