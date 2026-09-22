import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { account, ADDRESS, BN, HL, market, relay, wireBook } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const SOL_A = 171;
const SOL_B = 174;
const NOT_SUPPORTED = 'This coin is not supported. Pick ETH, HYPE or BTC.';

const sol = (marketId: number, platformName: string, midApr: number) => {
  const m = market(marketId, platformName, midApr);
  return { ...m, imData: { ...m.imData, name: `${platformName} SOL 30d` }, metadata: { underlyingSymbol: 'SOL' } };
};

const bodies = (positions: Array<{ marketId: number; size: number }> = []): Record<string, unknown> => ({
  '/apis/v1/markets': {
    results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.045), sol(SOL_A, 'Hyperliquid', 0.09), sol(SOL_B, 'Binance', 0.045)],
  },
  [`/apis/v1/markets/order-book?marketId=${SOL_A}`]: wireBook(900, 920),
  [`/apis/v1/markets/order-book?marketId=${SOL_B}`]: wireBook(400, 420),
  ...account(500_000, positions),
});

let app: FastifyInstance | null = null;
beforeEach(() => {
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
});
afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.BOROS_ROOT_ADDRESS;
});

const start = (positions: Array<{ marketId: number; size: number }>, calls: string[]) => {
  app = makeTestApp({ borosFetch: borosStub(bodies(positions)), getBorosOrders: () => relay(calls) });
};

const execute = (intent: string, size: number, directions: ['long' | 'short', 'long' | 'short'] = ['short', 'long']) =>
  app!.inject({
    method: 'POST',
    url: '/api/boros/pair/execute',
    headers: HOST,
    payload: {
      address: ADDRESS,
      legA: { marketId: SOL_A, direction: directions[0], slippageApr: 0.0025 },
      legB: { marketId: SOL_B, direction: directions[1], slippageApr: 0.0025 },
      size,
      intent,
      opposingAcknowledged: true,
      clientOrderIdA: `coid-${intent}-${size}-a`,
      clientOrderIdB: `coid-${intent}-${size}-b`,
    },
  });

const contextIds = async (): Promise<number[]> => {
  const res = await app!.inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
  return res.json().data.markets.map((m: { marketId: number }) => m.marketId).sort();
};

describe('the Boros pair ticket keeps to the supported coins', () => {
  it('lists only markets on a supported coin', async () => {
    start([], []);
    expect(await contextIds()).toEqual([HL, BN].sort());
  });

  it('keeps an off-list market the account holds, so it can be closed', async () => {
    start([{ marketId: SOL_A, size: 75_000 }, { marketId: SOL_B, size: -75_000 }], []);
    expect(await contextIds()).toEqual([HL, BN, SOL_A, SOL_B].sort());
  });

  it('refuses an open on an off-list coin before any order', async () => {
    const calls: string[] = [];
    start([], calls);
    const res = await execute('open', 1_000);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(NOT_SUPPORTED);
    expect(calls).toEqual([]);
  });

  it('refuses a target that grows an off-list position before any order', async () => {
    const calls: string[] = [];
    start([], calls);
    const res = await execute('target', 1_000);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(NOT_SUPPORTED);
    expect(calls).toEqual([]);
  });

  it('sends a pair close on an off-list coin', async () => {
    const calls: string[] = [];
    start([{ marketId: SOL_A, size: 75_000 }, { marketId: SOL_B, size: -75_000 }], calls);
    const res = await execute('close', 75_000);
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['place']);
  });

  it('sends a target that only reduces an off-list position', async () => {
    const calls: string[] = [];
    start([{ marketId: SOL_A, size: 75_000 }, { marketId: SOL_B, size: -75_000 }], calls);
    const res = await execute('target', 50_000, ['long', 'short']);
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['place']);
  });
});
