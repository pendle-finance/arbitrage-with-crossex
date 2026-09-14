import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { roundToStep } from '../../src/core/numbers';
import type { EvenPlan, PlannedStep } from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { GATE_HISTORY_FLOOR_MS } from '../../src/server/interestLedger';
import { InterestFile } from '../../src/server/interestLedger';
import { JobFile, newJob, newTransferJob, TransferFile, type Job } from '../../src/server/rebalanceJob';
import { gate, HOST, makeTestApp, mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { accountA, asset, waitFor } from './helpers/rebalance';

const API = '/api/v4';
const DAY_MS = 24 * 60 * 60 * 1000;

let t: number;
let apps: FastifyInstance[];

beforeEach(() => {
  t = Date.now();
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  nock.cleanAll();
});

const sleep = async (ms: number): Promise<void> => {
  t += ms;
};

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

const balancedAccount = {
  user_id: '1',
  available_margin: '999.5',
  margin_balance: '999.5',
  initial_margin: '0',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    asset('USDT', 'CROSSEX', { balance: '500', available_balance: '500', equity: '500' }),
    asset('USDC', 'HYPERLIQUID', { balance: '499.5', available_balance: '499.5', equity: '499.5' }),
    asset('USDC', 'GATE'),
  ],
};

const REFUSAL = { label: 'INVALID_PARAM_VALUE', message: 'refused by the test' };

function mockView(opts: { account?: unknown; disabled?: string; accountDelayMs?: number } = {}): void {
  const accounts = gate().persist().get(`${API}/crossex/accounts`).query(true);
  if (opts.accountDelayMs) accounts.delay(opts.accountDelayMs);
  accounts.reply(200, opts.account ?? accountA);
  gate()
    .persist()
    .get(`${API}/crossex/interest_rate`)
    .query(true)
    .reply(200, [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }]);
  gate().persist().get(`${API}/crossex/history_margin_interests`).query(true).reply(200, []);
  gate()
    .persist()
    .get(`${API}/crossex/transfers/coin`)
    .query(true)
    .reply(200, [{ coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: opts.disabled ?? '0' }]);
  gate()
    .persist()
    .get(`${API}/crossex/rule/symbols`)
    .query(true)
    .reply(200, [{ symbol: 'GATE_SPOT_USDC_USDT', exchange_type: 'GATE', business_type: 'SPOT', state: 'live' }]);
  gate()
    .persist()
    .get(`${API}/crossex/fee`)
    .query(true)
    .reply(200, [{ exchange_type: 'GATE', spot_maker_fee: '0', spot_taker_fee: '0', special_fee_list: [] }]);
  gate()
    .persist()
    .get(`${API}/spot/tickers`)
    .query(true)
    .reply(200, [{ currency_pair: 'USDC_USDT', lowest_ask: '1.0001', highest_bid: '0.9999', last: '1' }]);
}

function refuseSends(): void {
  gate().persist().post(`${API}/crossex/transfers`).query(true).reply(400, REFUSAL);
  gate().persist().post(`${API}/crossex/orders`).query(true).reply(400, REFUSAL);
}

function boot(over: { job?: unknown } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  const transfers = new TransferFile(dataDir);
  const app = makeTestApp({
    getClients,
    rebalance: { jobs, sleep },
    transfer: { jobs: transfers },
    engine: { store: new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
  });
  apps.push(app);
  return {
    jobs,
    transfers,
    ready: () => app.ready(),
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'rebalance.json'), 'utf8')) as Job,
    post: (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: HOST, payload }),
    plan: async (): Promise<EvenPlan> =>
      (await app.inject({ method: 'GET', url: '/api/rebalance', headers: HOST })).json().data.plan,
    view: async () => (await app.inject({ method: 'GET', url: '/api/rebalance', headers: HOST })).json(),
  };
}

const movedBy = (steps: PlannedStep[]): number =>
  Number(roundToStep(steps.reduce((total, step) => total + step.move, 0), '0.01', 'down'));

const interestRow = (interest: string, createTime: number) => ({
  interest_id: `${createTime}`,
  liability_coin: 'USDC',
  exchange_type: 'HYPERLIQUID',
  interest,
  create_time: String(createTime),
});

describe('GET /api/rebalance', () => {
  it('returns the buckets with all-time interest and a null job', async () => {
    const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
    const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
    const app = makeTestApp({
      getClients,
      rebalance: {
        jobs: new JobFile(dataDir),
        interest: new InterestFile(dataDir),
        sleep,
      },
      engine: { store: new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
    });
    apps.push(app);
    const scopes = [
      mockGateGet('/accounts', { body: account }),
      mockGateGet('/interest_rate', {
        body: [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }],
      }),
      gate()
        .get('/api/v4/crossex/history_margin_interests')
        .query((q) => q.from === String(GATE_HISTORY_FLOOR_MS) && q.to === String(t) && q.page === '1' && q.limit === '1000')
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
    const { buckets, job } = body.data;

    expect(buckets).toHaveLength(3);
    const usdc = buckets.find((b: { coin: string; venue: string }) => b.coin === 'USDC' && b.venue === 'HYPERLIQUID');
    expect(Object.keys(usdc).sort()).toEqual(
      ['coin', 'venue', 'cash', 'upnl', 'equity', 'borrow', 'imHeldUsd', 'mmHeldUsd', 'interestPaidUsd', 'interestPerDayUsd'].sort(),
    );
    expect(usdc).toMatchObject({ cash: 0, upnl: 0, equity: -300, borrow: 300, interestPerDayUsd: 0 });
    expect(usdc.interestPaidUsd).toBeCloseTo(5.03, 6);
    const ledger = new InterestFile(dataDir).read();
    expect(ledger).toMatchObject({ userId: '1', through: t - 1000 });
    expect(ledger?.paid['USDC/HYPERLIQUID']).toBeCloseTo(5.03, 6);
    expect(buckets.find((b: { coin: string }) => b.coin === 'USDT')).toMatchObject({ venue: 'CROSSEX', cash: 1200 });

    expect(job).toBeNull();
    for (const scope of scopes) expect(scope.isDone()).toBe(true);
  });

  it('plan has three routes', async () => {
    mockView();
    const h = boot();

    const plan = await h.plan();

    expect(Object.keys(plan.routes).sort()).toEqual(['convert', 'loop', 'mix']);
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ available: true, reason: null, rounds: 5 });
    expect(plan.routes.convert).toMatchObject({ available: true, reason: null, rounds: 0 });
    expect(plan).toMatchObject({ direction: 'toUsdc', balanced: false, recommended: 'loop' });
  });

  it('abandoned job keeps inTransit', async () => {
    mockView();
    const h = boot();
    const plan = await h.plan();
    const job = newJob(
      {
        direction: 'toUsdc',
        route: 'loop',
        steps: plan.routes.loop.steps,
        amount: plan.moves,
        costUsd: plan.routes.loop.costUsd,
        target: plan.routes.loop.after,
        userId: '1',
      },
      t,
    );
    for (const step of job.steps.slice(0, 8)) Object.assign(step, { status: 'done', qty: step.planned });
    Object.assign(job, { status: 'abandoned', stepIndex: 8, fundsAt: 'SPOT' });
    h.jobs.write(job);

    const { data } = await h.view();

    expect(data.job).toMatchObject({ id: job.id, status: 'abandoned' });
    expect(data.job.inTransit).toEqual({ coin: 'USDC', qty: 36.58 });
  });
});

describe('POST /api/rebalance', () => {
  it('starts the picked route', async () => {
    mockView();
    refuseSends();
    const h = boot();
    const plan = await h.plan();
    expect(plan.recommended).toBe('loop');

    const res = await h.post('/api/rebalance', { route: 'convert' });

    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({
      id: res.json().data.id,
      route: 'convert',
      amount: movedBy(plan.routes.convert.steps),
      costUsd: plan.routes.convert.costUsd,
      target: plan.routes.convert.after,
    });
    expect(h.file().steps.map((step) => step.name)).toContain('Convert');
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('ignores a sent amount', async () => {
    mockView();
    refuseSends();
    const h = boot();
    const plan = await h.plan();

    const res = await h.post('/api/rebalance', { route: 'loop', amount: 5 });

    expect(res.statusCode).toBe(202);
    expect(h.file().amount).toBe(plan.moves);
    expect(h.file().amount).toBe(movedBy(plan.routes.loop.steps));
    expect(h.file().amount).not.toBe(5);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('refuses a blocked route', async () => {
    mockView({ disabled: '1' });
    const h = boot();

    const res = await h.post('/api/rebalance', { route: 'loop' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Gate paused USDC transfers.');
    expect(() => h.file()).toThrow();
  });

  it('refuses while a transfer moves', async () => {
    const h = boot();
    await h.ready();
    h.transfers.write(newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, t));

    const res = await h.post('/api/rebalance', { route: 'loop' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Rebalance waits until the transfer ends.');
    expect(() => h.file()).toThrow();
  });

  it('refuses when balanced', async () => {
    mockView({ account: balancedAccount });
    const h = boot();

    const res = await h.post('/api/rebalance', { route: 'loop' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Already even.');
    expect(() => h.file()).toThrow();
  });

  it('mix falls back to recommended', async () => {
    mockView();
    refuseSends();
    const h = boot();
    const plan = await h.plan();
    expect(plan.routes.mix).toBeNull();
    expect(plan.recommended).toBe('loop');

    const res = await h.post('/api/rebalance', { route: 'mix' });

    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({ route: 'loop', amount: movedBy(plan.routes.loop.steps) });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('one of two rebalance posts', async () => {
    mockView({ accountDelayMs: 50 });
    refuseSends();
    const h = boot();

    const [first, second] = await Promise.all([
      h.post('/api/rebalance', { route: 'loop' }),
      h.post('/api/rebalance', { route: 'loop' }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().error.message).toMatch(new RegExp(`^rebalance ${h.file().id} is (running|halted)$`));
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });
});

describe('POST /api/rebalance/:id/resume', () => {
  it('resumes a 1.6.0 job at the fresh fit', async () => {
    const id = 'mfhq1x2k';
    const startedAt = t - 60_000;
    const step160 = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      text: null,
      quoteId: null,
      venueId: null,
      qty: null,
      attempt: 0,
      status: 'pending',
      startedAt: null,
      doneAt: null,
      ...over,
    });
    const job160 = {
      id,
      userId: '1',
      direction: 'toUsdc',
      route: 'loop',
      amount: 111.96,
      status: 'halted',
      stepIndex: 1,
      steps: [
        step160('Buy USDC', { text: `t-rb${id}0`, venueId: 'o1', qty: 111.96, status: 'done', startedAt, doneAt: startedAt }),
        step160('To spot', { text: `t-rb${id}1`, status: 'running', startedAt }),
        step160('To Hyperliquid'),
      ],
      fundsAt: 'GATE',
      haltReason: 'Gate API error (HTTP 422) [TRANSFER_AMOUNT_INSUFFICIENT]: Insufficient transferAvailable, transferAvailable: 25.08',
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    mockView();
    const sent: Record<string, unknown>[] = [];
    gate()
      .persist()
      .post(`${API}/crossex/transfers`)
      .query(true)
      .reply(200, (_uri, body) => {
        sent.push(body as Record<string, unknown>);
        return { tx_id: 'x9' };
      });
    gate()
      .persist()
      .get(`${API}/crossex/transfers`)
      .query(true)
      .reply(200, [{ id: 'x9', text: 'other', coin: 'USDC', amount: '24.51', status: 'FAILED', fail_reason: 'stopped by the test' }]);
    const h = boot({ job: job160 });

    const res = await h.post(`/api/rebalance/${id}/resume`);

    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'halted', 'the halt');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', amount: '24.51' });
  });
});
