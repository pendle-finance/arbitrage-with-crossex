import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BorosMarketOrderRequest, BorosOrderClient } from '../../src/core/boros/orders';
import { account, ADDRESS, BN, fillFor, HL, market, OK, wei, wireBook } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NORMAL = 2;
const CLOSE_ONLY = 1;

const bodies = (markets: unknown[], positions: Array<{ marketId: number; size: string }>): Record<string, unknown> => ({
  '/apis/v1/markets': { results: markets },
  [`/apis/v1/markets/order-book?marketId=${HL}`]: wireBook(900, 920),
  [`/apis/v1/markets/order-book?marketId=${BN}`]: wireBook(400, 420),
  ...account(500_000, positions),
});

const closeOnlyPair = () => [market(HL, 'Hyperliquid', 0.09, CLOSE_ONLY), market(BN, 'Binance', 0.045, NORMAL)];

interface Relay {
  placed: BorosMarketOrderRequest[];
  closes: Array<{ size: number; openSizeWei: string }>;
  calls: string[];
}

function relay(sent: Relay, onCancel: () => void = () => {}): BorosOrderClient {
  return {
    placeMarketOrders: async (reqs) => {
      sent.calls.push('place');
      sent.placed.push(...reqs);
      return reqs.map(fillFor);
    },
    cancelOrders: async () => {
      sent.calls.push('cancel');
      onCancel();
    },
    closePosition: async (r) => {
      sent.calls.push('close');
      sent.closes.push({ size: r.size, openSizeWei: r.openSizeWei });
      return fillFor(r);
    },
  };
}

const emptyRelay = (): Relay => ({ placed: [], closes: [], calls: [] });

let app: FastifyInstance | null = null;
beforeEach(() => {
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
});
afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.BOROS_ROOT_ADDRESS;
});

const context = () =>
  app!.inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });

const post = (url: string, payload: Record<string, unknown>) =>
  app!.inject({ method: 'POST', url, headers: HOST, payload });

const pairBody = (intent: 'open' | 'close', size: number) => ({
  address: ADDRESS,
  legA: { marketId: HL, direction: 'short', slippageApr: 0.0025 },
  legB: { marketId: BN, direction: 'long', slippageApr: 0.0025 },
  size,
  intent,
  opposingAcknowledged: true,
  clientOrderIdA: `coid-${intent}-aaaa`,
  clientOrderIdB: `coid-${intent}-bbbb`,
});

describe('close-only markets', () => {
  it('keeps a held close-only market in the context, marked closeOnly', async () => {
    app = makeTestApp({ borosFetch: borosStub(bodies(closeOnlyPair(), [{ marketId: HL, size: wei(75_000) }])) });
    const res = await context();
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.markets as Array<{ marketId: number; closeOnly: boolean }>;
    expect(rows.map((m) => [m.marketId, m.closeOnly])).toEqual([
      [BN, false],
      [HL, true],
    ]);
  });

  it('drops an unheld close-only market from the context', async () => {
    const markets = [
      market(HL, 'Hyperliquid', 0.09, NORMAL),
      market(BN, 'Binance', 0.045, NORMAL),
      market(OK, 'OKX', 0.05, CLOSE_ONLY),
    ];
    app = makeTestApp({ borosFetch: borosStub(bodies(markets, [])) });
    const rows = (await context()).json().data.markets as Array<{ marketId: number; closeOnly: boolean }>;
    expect(rows.map((m) => [m.marketId, m.closeOnly])).toEqual([
      [BN, false],
      [HL, false],
    ]);
  });

  it('refuses an open that touches a close-only market with 409', async () => {
    const sent = emptyRelay();
    app = makeTestApp({
      borosFetch: borosStub(bodies(closeOnlyPair(), [{ marketId: HL, size: wei(75_000) }])),
      getBorosOrders: () => relay(sent),
    });
    const res = await post('/api/boros/pair/execute', pairBody('open', 10_000));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('This market takes closes only. Switch to Close.');
    expect(sent.calls).toEqual([]);
  });

  it('sends a pair close on a close-only market, each leg sized to its fresh open size', async () => {
    const sent = emptyRelay();
    const wire = bodies(closeOnlyPair(), [
      { marketId: HL, size: wei(90_000) },
      { marketId: BN, size: wei(-80_000) },
    ]);
    app = makeTestApp({ borosFetch: borosStub(wire), getBorosOrders: () => relay(sent) });
    expect((await context()).statusCode).toBe(200);

    Object.assign(
      wire,
      account(500_000, [
        { marketId: HL, size: wei(75_000) },
        { marketId: BN, size: wei(-60_000) },
      ]),
    );
    const res = await post('/api/boros/pair/execute', pairBody('close', 100_000));
    expect(res.statusCode).toBe(200);
    expect(sent.placed.map((o) => [o.marketId, o.direction, o.size])).toEqual([
      [HL, 'short', 75_000],
      [BN, 'long', 60_000],
    ]);
  });

  it('sends a single close on a close-only market at the fresh open size', async () => {
    const sent = emptyRelay();
    const wire = bodies(closeOnlyPair(), [{ marketId: HL, size: wei(75_000) }]);
    app = makeTestApp({
      borosFetch: borosStub(wire),
      getBorosOrders: () => relay(sent, () => Object.assign(wire, account(500_000, [{ marketId: HL, size: wei(50_000) }]))),
    });
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, { clientOrderId: 'coid-close-only' });
    expect(res.statusCode).toBe(200);
    expect(sent.calls).toEqual(['cancel', 'close']);
    expect(sent.closes).toHaveLength(1);
    expect(sent.closes[0].openSizeWei).toBe(wei(50_000));
    expect(sent.closes[0].size).toBeCloseTo(50_000, 6);
  });
});
