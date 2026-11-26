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

function mockStack(mark: number): void {
  app = makeTestApp();
  mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });
  mockGateGet('/fee', { fixture: 'fee.json' });
  gate().get('/api/v4/spot/tickers').query(true).times(4).reply(200, [{ currency_pair: 'ETH_USDT', last: String(mark) }]);
  const bids: BookLevel[] = [[String(mark - 0.5), '5000']];
  const asks: BookLevel[] = [[String(mark + 0.5), '5000']];
  const toGate = (levels: BookLevel[]) => levels.map(([p, qty]) => ({ p, s: Math.round(Number(qty) / 0.01) }));
  gate()
    .get(/\/api\/v4\/futures\/usdt\/contracts\//)
    .query(true)
    .reply(200, { quanto_multiplier: '0.01', order_price_round: '0.05' })
    .persist();
  gate().get('/api/v4/futures/usdt/order_book').query(true).reply(200, { bids: toGate(bids), asks: toGate(asks) }).persist();
  nock('https://fapi.binance.com').get('/fapi/v1/depth').query(true).reply(200, { bids, asks }).persist();
}

const makerHedge = (qty: string, mark: number) => [
  { kind: 'open-limit', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty, price: String(mark), tif: 'POC', pairGroupId: 'pg', pairRole: 'maker' },
  { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', qty, pairGroupId: 'pg', pairRole: 'hedge' },
];

const marketPair = (qty: string) => [
  { kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty, pairGroupId: 'pg' },
  { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', qty, pairGroupId: 'pg' },
];

async function post(actions: unknown[], twap?: unknown): Promise<Response> {
  const res = await app.inject({ method: 'POST', url: '/api/preview', headers: HOST, payload: { actions, twap } });
  expect(res.statusCode).toBe(200);
  return res.json().data as Response;
}

const codes = (data: Response) => data.previews.flatMap((p) => p.violations.map((v) => v.code));

describe('POST /api/preview checks the venue max order size per slice when TWAP is on', () => {
  it.each([
    ['maker and hedge', makerHedge],
    ['two market legs', (qty: string) => marketPair(qty)],
  ])('%s: 3,647 ETH ($6M) in 2 slices under Binance 2,000 ETH market max previews clean', async (_name, actions) => {
    const mark = 1645;
    mockStack(mark);

    const data = await post(actions('3647', mark), { durationSec: 3600, slices: 2 });

    expect(codes(data)).toEqual([]);
    expect(data.twap).toMatchObject({ plan: { slices: 2, sliceQty: '1823.5', lastQty: '1823.5' }, refusal: null });
  });

  it('a $50 pair in 2 slices previews clean', async () => {
    const mark = 1250;
    mockStack(mark);

    const data = await post(makerHedge('0.04', mark), { durationSec: 3600, slices: 2 });

    expect(codes(data)).toEqual([]);
    expect(data.twap).toMatchObject({ plan: { slices: 2, sliceQty: '0.02' }, refusal: null });
  });

  it.each([
    ['maker and hedge', makerHedge],
    ['two market legs', (qty: string) => marketPair(qty)],
  ])('%s: the whole 3,647 ETH with TWAP off keeps the max market size violation', async (_name, actions) => {
    const mark = 1645;
    mockStack(mark);

    const data = await post(actions('3647', mark));

    expect(codes(data)).toContain('exceeds-max-market-size');
  });

  it('a slice over the max is the TWAP refusal', async () => {
    const mark = 1645;
    mockStack(mark);

    const data = await post(makerHedge('4200', mark), { durationSec: 3600, slices: 2 });

    expect(codes(data)).toEqual([]);
    expect(data.twap?.refusal?.field).toBe('sliceSize');
    expect(data.twap?.refusal?.text).toContain('Binance takes at most');
  });
});
