import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { account, ADDRESS, BN, fillFor, HL, market, relay, wei, wireBook } from '../helpers/boros-pair-fixtures';
import { resetAgentApprovalCache } from '../../src/server/borosAgentApproval';
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

const bothHeld = (): Record<string, unknown> => ({
  ...bodies(false),
  ...account(500_000, [
    { marketId: HL, size: 75_000 },
    { marketId: BN, size: -75_000 },
  ]),
});

const target = (id: string) =>
  app!.inject({
    method: 'POST',
    url: '/api/boros/pair/execute',
    headers: HOST,
    payload: {
      address: ADDRESS,
      legA: { marketId: HL, direction: 'long', slippageApr: 0.0025 },
      legB: { marketId: BN, direction: 'short', slippageApr: 0.0025 },
      size: 50_000,
      intent: 'target',
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

  it('refuses a $9.99 partial close before the cancel, and sends a $10.01 one', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(bodies(false)), getBorosOrders: () => relay(calls) });

    const small = await close({ clientOrderId: 'coid-min-999', size: 9.99 });
    expect(small.statusCode).toBeGreaterThanOrEqual(400);
    expect(small.json().error.category).toBe('size-too-small');
    expect(calls).toEqual([]);

    const enough = await close({ clientOrderId: 'coid-min-1001', size: 10.01 });
    expect(enough.statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close']);
  });

  it('a reducing target waits for a running close on its market', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => (entered = resolve));
    app = makeTestApp({
      borosFetch: borosStub(bothHeld()),
      getBorosOrders: () =>
        relay(calls, async (r) => {
          entered();
          await held;
          return fillFor(r);
        }),
    });

    const single = close({ clientOrderId: 'coid-target-one' });
    await closing;
    const reduce = await target('coid-target-wait');
    expect(reduce.statusCode).toBe(409);
    expect(reduce.json().error.message).toBe('An order on this market is already running.');

    release();
    expect((await single).statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close']);
  });

  it('an open on a market with an order running gets the order text, and a close gets the close text', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => (entered = resolve));
    app = makeTestApp({
      borosFetch: borosStub(bothHeld()),
      getBorosOrders: () =>
        relay(calls, async (r) => {
          entered();
          await held;
          return fillFor(r);
        }),
    });

    const single = close({ clientOrderId: 'coid-open-one' });
    await closing;
    const open = await app.inject({
      method: 'POST',
      url: '/api/boros/pair/execute',
      headers: HOST,
      payload: {
        address: ADDRESS,
        legA: { marketId: HL, direction: 'long', slippageApr: 0.0025 },
        legB: { marketId: BN, direction: 'short', slippageApr: 0.0025 },
        size: 1_000,
        intent: 'open',
        clientOrderIdA: 'coid-open-wait-a',
        clientOrderIdB: 'coid-open-wait-b',
      },
    });
    const pair = await pairClose('coid-open-close');

    expect(open.statusCode).toBe(409);
    expect(open.json().error.message).toBe('An order on this market is already running.');
    expect(pair.statusCode).toBe(409);
    expect(pair.json().error.message).toBe('A close on this market is already running.');

    release();
    expect((await single).statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close']);
  });

  it('a reducing target holds its markets until its orders land', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const placing = new Promise<void>((resolve) => (entered = resolve));
    const orders = relay(calls);
    app = makeTestApp({
      borosFetch: borosStub(bothHeld()),
      getBorosOrders: () => ({
        ...orders,
        placeMarketOrders: async (reqs) => {
          entered();
          await held;
          return orders.placeMarketOrders(reqs);
        },
      }),
    });

    const reduce = target('coid-target-hold');
    await Promise.race([placing, reduce]);
    const single = await close({ clientOrderId: 'coid-target-two' });
    expect(single.statusCode).toBe(409);
    expect(single.json().error.message).toBe('A close on this market is already running.');

    release();
    expect((await reduce).statusCode).toBe(200);
    expect(calls).toEqual(['place']);
  });

  it('an order that only adds frees its markets before it is sent', async () => {
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

    const add = app.inject({
      method: 'POST',
      url: '/api/boros/pair/execute',
      headers: HOST,
      payload: {
        address: ADDRESS,
        legA: { marketId: HL, direction: 'long', slippageApr: 0.0025 },
        legB: { marketId: BN, direction: 'short', slippageApr: 0.01 },
        size: 1_000,
        intent: 'open',
        clientOrderIdA: 'coid-add-a',
        clientOrderIdB: 'coid-add-b',
      },
    });
    await Promise.race([placing, add]);
    const single = await close({ clientOrderId: 'coid-add-close' });
    expect(single.statusCode).toBe(200);

    release();
    expect((await add).statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close', 'place']);
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

describe('agent approval on-chain', () => {
  const KEY = `0x${'a'.repeat(64)}`;
  afterEach(() => {
    delete process.env.BOROS_AGENT_PRIVATE_KEY;
    resetAgentApprovalCache();
  });

  it('refuses a close when the chain shows no approval, and sends nothing', async () => {
    // The key is stored, but the wallet prompt was rejected or the agent was revoked.
    process.env.BOROS_AGENT_PRIVATE_KEY = KEY;
    resetAgentApprovalCache();
    const calls: string[] = [];
    app = makeTestApp({
      borosFetch: borosStub({ ...bodies(false), '/apis/v1/agents/expiry-time': { expiryTime: 0 } }),
      getBorosOrders: () => relay(calls, async (r) => fillFor(r)),
    });
    const res = await close({ clientOrderId: 'coid-unapproved' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).toMatch(/not approved on-chain/);
    expect(calls).toEqual([]);
  });

  it('lets the close through when the chain shows a live approval', async () => {
    process.env.BOROS_AGENT_PRIVATE_KEY = KEY;
    resetAgentApprovalCache();
    const calls: string[] = [];
    app = makeTestApp({
      borosFetch: borosStub({
        ...bodies(false),
        '/apis/v1/agents/expiry-time': { expiryTime: Math.floor(Date.now() / 1000) + 86400 },
      }),
      getBorosOrders: () => relay(calls, async (r) => fillFor(r)),
    });
    expect((await close({ clientOrderId: 'coid-approved' })).statusCode).toBe(200);
  });
});
