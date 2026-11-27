import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PreviewResult } from '../../src/core/actions';
import { gate, HOST, makeTestApp, mockGateGet } from '../server/helpers/gate-nock';

let app: FastifyInstance;

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

const MAKER = { kind: 'open-limit', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '1', price: '1990', tif: 'POC' };

async function preview(): Promise<PreviewResult> {
  const res = await app.inject({ method: 'POST', url: '/api/preview', headers: HOST, payload: { actions: [MAKER] } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as { previews: PreviewResult[] }).previews[0];
}

describe('POST /api/preview keeps the last venue touch through a failed book fetch', () => {
  it('keeps the touch for 10 s, then says the book is missing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json', times: 3 });
    mockGateGet('/fee', { fixture: 'fee.json', times: 3 });
    mockGateGet('/positions', { body: [], times: 3 });
    gate().get('/api/v4/spot/tickers').query(true).reply(200, [{ currency_pair: 'ETH_USDT', last: '2000' }]).persist();
    gate()
      .get(/\/api\/v4\/futures\/usdt\/contracts\//)
      .query(true)
      .reply(200, { quanto_multiplier: '0.01', order_price_round: '0.05' })
      .persist();
    gate()
      .get('/api/v4/futures/usdt/order_book')
      .query(true)
      .reply(200, { bids: [{ p: '1999.5', s: 100 }], asks: [{ p: '2000.5', s: 100 }] });
    gate().get('/api/v4/futures/usdt/order_book').query(true).reply(500, {}).persist();

    const first = await preview();
    expect(first.restEstimate).toMatchObject({ bestBid: 1999.5, bestAsk: 2000.5 });

    vi.setSystemTime(Date.now() + 9_000);
    const kept = await preview();
    expect(kept.restEstimate).toEqual(first.restEstimate);
    expect(kept.warnings).not.toContain("No order book, so the maker price can't follow the market");

    vi.setSystemTime(Date.now() + 2_000);
    const gone = await preview();
    expect(gone.restEstimate).toBeUndefined();
    expect(gone.warnings).toContain("No order book, so the maker price can't follow the market");
  });
});
