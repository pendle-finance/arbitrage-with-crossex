import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PreviewResult } from '../../src/core/actions';
import type { TwapPreview } from '../../src/core/preview';
import { gate, HOST, makeTestApp, mockGateGet } from '../server/helpers/gate-nock';

type Response = TwapPreview & { previews: PreviewResult[] };
type BookLevel = [string, string];
let app: FastifyInstance;

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
});

afterEach(async () => {
  await app?.close();
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

function mockStack(): void {
  app = makeTestApp();
  mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });
  mockGateGet('/fee', { fixture: 'fee.json' });
  mockGateGet('/positions', { body: [{ symbol: 'GATE_FUTURE_ETH_USDT', position_qty: '3', mark_price: '2000' }] });
  gate().get('/api/v4/spot/tickers').query(true).times(4).reply(200, [{ currency_pair: 'ETH_USDT', last: '2000' }]);
  const levels: BookLevel[] = [['1', '1'], ['2', '1'], ['3', '10']];
  const bids = levels.map(([step, qty]): BookLevel => [String(2000 - Number(step) + 0.5), qty]);
  const asks = levels.map(([step, qty]): BookLevel => [String(2000 + Number(step) - 0.5), qty]);
  const toGate = (rows: BookLevel[]) => rows.map(([p, qty]) => ({ p, s: Math.round(Number(qty) / 0.01) }));
  gate()
    .get(/\/api\/v4\/futures\/usdt\/contracts\//)
    .query(true)
    .reply(200, { quanto_multiplier: '0.01', order_price_round: '0.05' })
    .persist();
  gate().get('/api/v4/futures/usdt/order_book').query(true).reply(200, { bids: toGate(bids), asks: toGate(asks) }).persist();
}

async function post(actions: unknown[]): Promise<Response> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/preview',
    headers: HOST,
    payload: { actions, twap: { durationSec: 3600, slices: 12 } },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Response;
}

describe('POST /api/preview gives a one-leg TWAP its price impact', () => {
  it.each([
    ['an open on the single ticket', { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '3' }],
    ['a close of one leg', { kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT', qty: '3' }],
  ])('%s gets the whole and sliced impact, sliced under whole', async (_name, action) => {
    mockStack();

    const data = await post([action]);

    expect(data.makerLeg).toBeNull();
    expect(data.twap?.plan).toMatchObject({ slices: 12, sliceQty: '0.25' });
    expect(data.priceImpact?.whole).toBeCloseTo(4.5, 6);
    expect(data.priceImpact?.sliced).toBeCloseTo(1.5, 6);
  });
});
