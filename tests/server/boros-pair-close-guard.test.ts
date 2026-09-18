import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { ADDRESS, BN, fillFor, HL, market, relay, wei, wireBook } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const bodies = (isolated: boolean): Record<string, unknown> => {
  const acc = marketAcc(ADDRESS, 3, isolated ? HL : undefined);
  const position = { marketId: HL, signedSize: wei(75_000), initialMargin: raw(0), orders: [] };
  return {
    '/apis/v1/markets': { results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.045)] },
    [`/apis/v1/markets/order-book?marketId=${HL}`]: wireBook(900, 920),
    [`/apis/v1/markets/order-book?marketId=${BN}`]: wireBook(400, 420),
    '/apis/v1/accounts/market-acc-infos-by-root': {
      results: [
        { marketAcc: marketAcc(ADDRESS, 3), netBalance: raw(500_000), initialMargin: raw(0), positions: isolated ? [] : [position] },
        ...(isolated ? [{ marketAcc: acc, netBalance: raw(20_000), initialMargin: raw(0), positions: [position] }] : []),
      ],
    },
    '/apis/v1/accounts/active-positions': {
      results: [
        { marketAcc: acc, marketId: HL, side: 0, fixedApr: 0, signedSize: wei(75_000), unrealisedPnl: '0', settlementPnl: '0' },
      ],
    },
  };
};

let app: FastifyInstance | null = null;
beforeEach(() => {
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
});
afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.BOROS_ROOT_ADDRESS;
});

const close = (payload: Record<string, unknown>) =>
  app!.inject({ method: 'POST', url: `/api/boros/pair/market/${HL}/cancel-and-close`, headers: HOST, payload });

const pairClose = (id: string) =>
  app!.inject({
    method: 'POST',
    url: '/api/boros/pair/execute',
    headers: HOST,
    payload: {
      address: ADDRESS,
      legA: { marketId: HL, direction: 'short', slippageApr: 0.0025 },
      legB: { marketId: BN, direction: 'long', slippageApr: 0.0025 },
      size: 75_000,
      intent: 'close',
      opposingAcknowledged: true,
      clientOrderIdA: `${id}-a`,
      clientOrderIdB: `${id}-b`,
    },
  });

describe('cancel-and-close guards', () => {
  it('one close at a time: a second close on the same market gets 409', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => (entered = resolve));
    app = makeTestApp({
      borosFetch: borosStub(bodies(false)),
      getBorosOrders: () =>
        relay(calls, async (r) => {
          entered();
          await held;
          return fillFor(r);
        }),
    });

    const first = close({ clientOrderId: 'coid-lock-one' });
    await closing;
    const second = await close({ clientOrderId: 'coid-lock-two' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe('A close on this market is already running.');

    release();
    expect((await first).statusCode).toBe(200);
    expect(calls.filter((c) => c === 'close')).toHaveLength(1);
  });

  it('frees the market when the close fails, so the next close goes through', async () => {
    const calls: string[] = [];
    let failures = 1;
    app = makeTestApp({
      borosFetch: borosStub(bodies(false)),
      getBorosOrders: () =>
        relay(calls, async (r) => {
          if (failures-- > 0) throw new Error('Boros API /v1/calldata-builder/agent/place-order — HTTP 400');
          return fillFor(r);
        }),
    });
    expect((await close({ clientOrderId: 'coid-free-one' })).statusCode).toBeGreaterThanOrEqual(400);
    const res = await close({ clientOrderId: 'coid-free-two' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close', 'cancel', 'close']);
  });

  it('pair close and single close share the lock', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => (entered = resolve));
    app = makeTestApp({
      borosFetch: borosStub(bodies(false)),
      getBorosOrders: () =>
        relay(calls, async (r) => {
          entered();
          await held;
          return fillFor(r);
        }),
    });

    const single = close({ clientOrderId: 'coid-share-one' });
    await closing;
    const pair = await pairClose('coid-share-pair');
    expect(pair.statusCode).toBe(409);
    expect(pair.json().error.message).toBe('A close on this market is already running.');

    release();
    expect((await single).statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close']);
  });

  it('a pair close holds its markets until it ends', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const placing = new Promise<void>((resolve) => (entered = resolve));
    const orders = relay(calls);
    app = makeTestApp({
      borosFetch: borosStub(bodies(false)),
      getBorosOrders: () => ({
        ...orders,
        placeMarketOrders: async (reqs) => {
          entered();
          await held;
          return orders.placeMarketOrders(reqs);
        },
      }),
    });

    const pair = pairClose('coid-hold-pair');
    await Promise.race([placing, pair]);
    const single = await close({ clientOrderId: 'coid-hold-one' });
    expect(single.statusCode).toBe(409);
    expect(single.json().error.message).toBe('A close on this market is already running.');

    release();
    expect((await pair).statusCode).toBe(200);
    expect((await close({ clientOrderId: 'coid-hold-two' })).statusCode).toBe(200);
    expect(calls).toEqual(['place', 'cancel', 'close']);
  });

  it('refuses an isolated position before any cancel', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(bodies(true)), getBorosOrders: () => relay(calls) });
    const res = await close({ clientOrderId: 'coid-isolated' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('This position is on isolated margin. Close it on Boros.');
    expect(calls).toEqual([]);

    const again = await close({ clientOrderId: 'coid-isolated-2' });
    expect(again.json().error.message).toBe('This position is on isolated margin. Close it on Boros.');
  });
});
