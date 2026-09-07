import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { JobFile } from '../../src/server/rebalanceJob';
import { gate, HOST, makeTestApp, mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const DAY_MS = 24 * 60 * 60 * 1000;

const asset = (coin: string, venue: string, over: Record<string, string> = {}) => ({
  coin,
  exchange_type: venue,
  balance: '0',
  upnl: '0',
  equity: '0',
  liability: '0',
  borrowing_initial_margin: '0',
  ...over,
});

const account = {
  user_id: '1',
  available_margin: '900',
  margin_balance: '900',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    asset('USDT', 'CROSSEX', { balance: '1200', equity: '1200' }),
    asset('USDC', 'HYPERLIQUID', { equity: '-300', liability: '300', borrowing_initial_margin: '30' }),
    asset('USDC', 'GATE'),
  ],
};

const interestRow = (interest: string, createTime: number) => ({
  liability_coin: 'USDC',
  exchange_type: 'HYPERLIQUID',
  interest,
  create_time: String(createTime),
});

describe('GET /api/rebalance', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('returns the buckets, the plan with both routes, and a null job', async () => {
    const t = Date.now();
    const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
    app = makeTestApp({
      getClients,
      rebalance: {
        jobs: new JobFile(mkdtempSync(path.join(tmpdir(), 'rebalance-'))),
        sleep: async () => undefined,
      },
      engine: { store: new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
    });
    const scopes = [
      mockGateGet('/accounts', { body: account }),
      mockGateGet('/interest_rate', {
        body: [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }],
      }),
      gate()
        .get('/api/v4/crossex/history_margin_interests')
        .query((q) => q.from === String(t - 30 * DAY_MS) && q.to === String(t) && q.page === '1' && q.limit === '100')
        .reply(200, [interestRow('5', t - 31 * DAY_MS), interestRow('0.02', t - 2000), interestRow('0.01', t - 1000)]),
      mockGateGet('/transfers/coin', {
        body: [{ coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: 0 }],
      }),
      mockGateGet('/rule/symbols', {
        body: [{ symbol: 'GATE_SPOT_USDC_USDT', exchange_type: 'GATE', business_type: 'SPOT', state: 'live' }],
      }),
      mockGateGet('/fee', { fixture: 'fee.json' }),
      gate()
        .get('/api/v4/spot/tickers')
        .query(true)
        .reply(200, [{ currency_pair: 'USDC_USDT', lowest_ask: '1.0001', highest_bid: '1', last: '1.0001' }]),
    ];

    const res = await app.inject({ method: 'GET', url: '/api/rebalance', headers: HOST });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.meta.stale).toBeUndefined();
    const { buckets, plan, job } = body.data;

    expect(buckets).toHaveLength(3);
    const usdc = buckets.find((b: { coin: string; venue: string }) => b.coin === 'USDC' && b.venue === 'HYPERLIQUID');
    expect(Object.keys(usdc).sort()).toEqual(
      ['coin', 'venue', 'cash', 'upnl', 'equity', 'borrow', 'imHeldUsd', 'mmHeldUsd', 'interestPaid30dUsd', 'interestPerDayUsd'].sort(),
    );
    expect(usdc).toMatchObject({ cash: 0, upnl: 0, equity: -300, borrow: 300, interestPerDayUsd: 0 });
    expect(usdc.interestPaid30dUsd).toBeCloseTo(0.03, 6);
    expect(buckets.find((b: { coin: string }) => b.coin === 'USDT')).toMatchObject({ venue: 'CROSSEX', cash: 1200 });

    expect(plan.amount).toBe(300);
    expect(plan.shortfall).toBeNull();
    expect(plan.routes.loop).toMatchObject({ waitSeconds: 150, available: true, reason: null });
    expect(plan.routes.loop.costUsd).toBeCloseTo(0.38, 6);
    expect(plan.routes.convert).toMatchObject({ waitSeconds: 0, available: true, reason: null });
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.6, 6);
    expect(plan.route).toBe('loop');
    expect(plan.savesPerDayUsd).toBe(0);
    // 30 of initial margin held on the 300 borrow, freed for what lands.
    expect(plan.marginFreedUsd).toBeCloseTo((plan.receives * 30) / 300, 9);

    expect(job).toBeNull();
    for (const scope of scopes) expect(scope.isDone()).toBe(true);
  });
});
