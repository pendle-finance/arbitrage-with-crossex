import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { account, ADDRESS, BN, HL, market, relay, wei } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const ACCOUNT_READ = '/apis/v1/accounts/market-acc-infos-by-root';

const bodies = (): Record<string, unknown> => ({
  '/apis/v1/markets': { results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.045)] },
  ...account(500_000, [{ marketId: HL, size: wei(75_000) }]),
});

function limitedAccountReads(limited: number[]): FetchLike {
  const stub = borosStub(bodies());
  let reads = 0;
  return async (url, init) => {
    if (new URL(url).pathname === ACCOUNT_READ && limited.includes(++reads)) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return stub(url, init);
  };
}

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

describe('cancel-and-close when Boros limits reads', () => {
  it('answers 503 on a 429 before the cancel, and sends nothing', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: limitedAccountReads([1]), getBorosOrders: () => relay(calls) });
    const res = await close({ clientOrderId: 'coid-429-pre', size: 25_000 });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('Boros is limiting reads. Nothing was sent. Try again in a minute.');
    expect(calls).toEqual([]);
  });

  it('answers 503 on a 429 after the cancel, and says the orders were cancelled', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: limitedAccountReads([2]), getBorosOrders: () => relay(calls) });
    const res = await close({ clientOrderId: 'coid-429-post', size: 25_000 });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe(
      'Boros is limiting reads. Your open orders on this market were cancelled. The close was not sent. Try again in a minute.',
    );
    expect(calls).toEqual(['cancel']);
  });

  it('frees the market after a 429, so the next close goes through', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: limitedAccountReads([1]), getBorosOrders: () => relay(calls) });
    expect((await close({ clientOrderId: 'coid-429-one' })).statusCode).toBe(503);
    const res = await close({ clientOrderId: 'coid-429-two' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['cancel', 'close']);
  });
});
