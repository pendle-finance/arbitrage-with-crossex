import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import type { EvenPlan, PlannedStep } from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { HALT_TEXT, inTransitOf, JobFile, newJob, type Job, type Step } from '../../src/server/rebalanceJob';
import { tagFor } from '../../src/server/rebalanceRunner';
import type { AppDeps } from '../../src/server/app';
import { gate, HOST, makeTestApp, mockGateGet, mockGatePost, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { accountA, waitFor } from './helpers/rebalance';

const API = '/api/v4';
const BOUGHT = '299.97';

let t: number;
let apps: FastifyInstance[];

const sleep = async (ms: number): Promise<void> => {
  t += ms;
};

beforeEach(() => {
  t = Date.now();
  apps = [];
});

afterEach(async () => {
  await reset();
});

async function reset(): Promise<void> {
  for (const app of apps) await app.close();
  apps = [];
  nock.cleanAll();
}

function boot(over: { store?: Store; job?: unknown; credentials?: AppDeps['credentials'] } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  const app = makeTestApp({
    getClients,
    rebalance: { jobs, sleep },
    engine: { store: over.store ?? new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
    credentials: over.credentials,
  });
  apps.push(app);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: HOST })).json();
  return {
    jobs,
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'rebalance.json'), 'utf8')) as Job,
    post: (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: HOST, payload }),
    view: () => get('/api/rebalance'),
    alerts: async () => (await get('/api/alerts')).data as Record<string, unknown>[],
  };
}

const HEDGED_POSITIONS = [
  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', position_side: 'NONE', position_qty: '-0.1', position_value: '250', mark_price: '2500' },
  { symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'NONE', position_qty: '0.1', position_value: '250', mark_price: '2500' },
];

function mockView(opts: { accountThen429?: boolean; onAccountRead?: () => void; positions?: unknown[] } = {}): void {
  if (opts.accountThen429) {
    gate().get(`${API}/crossex/accounts`).query(true).reply(200, accountA);
    gate().persist().get(`${API}/crossex/accounts`).query(true).reply(429, { label: 'TOO_MANY_REQUESTS', message: 'slow down' });
  } else {
    gate()
      .persist()
      .get(`${API}/crossex/accounts`)
      .query(true)
      .reply(200, () => {
        opts.onAccountRead?.();
        return accountA;
      });
  }
  gate()
    .persist()
    .get(`${API}/crossex/interest_rate`)
    .query(true)
    .reply(200, [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }]);
  gate().persist().get(`${API}/crossex/history_margin_interests`).query(true).reply(200, []);
  gate().persist().get(`${API}/crossex/positions`).query(true).reply(200, opts.positions ?? HEDGED_POSITIONS);
  gate()
    .persist()
    .get(`${API}/crossex/transfers/coin`)
    .query(true)
    .reply(200, [{ coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: '0' }]);
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

const ONE_ROUND: PlannedStep[] = [{ round: 1, kind: 'round', buy: 300, move: 300, arrives: 299.95, borrowLeft: 0, seconds: 130, from: 'CROSSEX', to: 'HYPERLIQUID' }];

function haltedLoopJob(stepIndex: number, patch: Partial<Step> = {}): Job {
  const job = newJob({ route: 'loop', steps: ONE_ROUND, amount: 300, costUsd: 0.08, target: [], userId: null }, t);
  job.status = 'halted';
  job.haltReason = HALT_TEXT.restart;
  job.stepIndex = stepIndex;
  job.tagCount = stepIndex;
  job.fundsAt = (['CROSSEX', 'GATE', 'SPOT'] as const)[stepIndex];
  const venueIds = ['o1', 'x1'];
  for (let i = 0; i < stepIndex; i += 1) {
    Object.assign(job.steps[i], {
      text: tagFor(job.id, i),
      venueId: venueIds[i],
      qty: Number(BOUGHT),
      status: 'done',
      startedAt: t,
      doneAt: t,
    });
  }
  Object.assign(job.steps[stepIndex], { text: tagFor(job.id, stepIndex), status: 'running', startedAt: t, ...patch });
  return job;
}

async function accountAPlan(): Promise<EvenPlan> {
  const h = boot();
  return (await h.view()).data.plan;
}

function roundThreeInSpot(plan: EvenPlan, status: Job['status']): Job {
  const { steps, costUsd, after } = plan.routes.loop;
  const job = newJob({ route: 'loop', steps, amount: plan.moves, costUsd, target: after, userId: '1' }, t);
  for (const step of job.steps.slice(0, 8)) Object.assign(step, { status: 'done', qty: step.planned, startedAt: t, doneAt: t });
  Object.assign(job.steps[8], { status: 'running', startedAt: t });
  return Object.assign(job, { status, stepIndex: 8, fundsAt: 'SPOT' });
}

const transferRow = (id: string, status: string, over: Record<string, string> = {}) => ({
  id,
  status,
  coin: 'USDC',
  amount: '299.97000',
  ...over,
});

const createDeal = (store: Store): void => {
  store.createPair({
    id: 'deal-409',
    mode: 'OPENING',
    a: { contract: 'GATE_FUTURE_ETH_USDT', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
    b: null,
    targetQty: '0.05',
    limitPrice: '2500',
    pricePolicy: 'fixed',
    deadlineAt: null,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip: null,
    clipBandBp: null,
    haltReason: null,
    reportJson: null,
    createdAt: Date.now(),
  });
};

const busyDeal = () => {
  const store = new Store(':memory:');
  createDeal(store);
  return store;
};

describe('1.6.0 job files', () => {
  it('parses a 1.6.0 job file', async () => {
    const id = 'mfhq1x2k';
    mockView();
    const h = boot({
      job: {
        id,
        userId: '1',
        direction: 'toUsdc',
        route: 'loop',
        amount: 111.96,
        status: 'halted',
        stepIndex: 1,
        steps: [
          step160('Buy USDC', { text: `t-rb${id}0`, venueId: 'o1', qty: 111.96, status: 'done', startedAt: t, doneAt: t }),
          step160('To spot', { text: `t-rb${id}1`, status: 'running', startedAt: t }),
          step160('To Hyperliquid'),
        ],
        fundsAt: 'GATE',
        haltReason: 'Gate API error (HTTP 422) [TRANSFER_AMOUNT_INSUFFICIENT]: Insufficient transferAvailable, transferAvailable: 25.08',
        createdAt: t,
        updatedAt: t,
      },
    });

    const { data } = await h.view();

    expect(h.jobs.read()?.steps[1].planned).toBe(111.96);
    expect(data.job).toMatchObject({ id, route: 'loop', amount: 111.96, status: 'halted', costUsd: null, target: null, inTransit: null });
    expect(data.job.steps.map((s: Step) => [s.name, s.round, s.planned])).toEqual([
      ['Buy USDC', 1, 111.96],
      ['To spot', 1, 111.96],
      ['To Hyperliquid', 1, 111.96],
    ]);
  });

  it('1.6.0 done job reads', async () => {
    mockView();
    const h = boot({
      job: {
        id: 'mfhq1x2k',
        userId: '1',
        direction: 'toUsdt',
        route: 'convert',
        amount: 12,
        status: 'done',
        stepIndex: 0,
        steps: [step160('Convert', { quoteId: 'q3', venueId: 'c3', qty: 11.98, status: 'done' })],
        fundsAt: 'CROSSEX',
        haltReason: null,
        createdAt: t,
        updatedAt: t,
      },
    });

    const res = await h.view();

    expect(res.ok).toBe(true);
    expect(res.data.job).toMatchObject({ route: 'convert', status: 'done', costUsd: null, target: null, inTransit: null });
  });
});

describe('GET /api/rebalance on a halted job', () => {
  it('a halted job drops on the way once Gate shows the transfer landed', async () => {
    mockView();
    const job = haltedLoopJob(2, { venueId: 'x2' });
    expect(job.steps[2].name).toBe('To Hyperliquid');
    expect(inTransitOf(job)).toEqual({ coin: 'USDC', qty: Number(BOUGHT), at: 'MOVING' });
    const h = boot({ job });
    const rows = mockGateGet('/transfers', { body: [transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })] });

    const { data } = await h.view();

    expect(rows.isDone()).toBe(true);
    expect(data.job).toMatchObject({ id: job.id, status: 'halted', inTransit: null });
    expect(h.file()).toEqual(job);
  });

  it('a halted To spot that landed shows in Gate spot', async () => {
    mockView();
    const job = haltedLoopJob(1, { venueId: 'x1' });
    expect(job.steps[1].name).toBe('To spot');
    expect(inTransitOf(job)).toEqual({ coin: 'USDC', qty: 300, at: 'MOVING' });
    const h = boot({ job });
    const rows = mockGateGet('/transfers', { body: [transferRow('x1', 'SUCCESS', { actual_receive: BOUGHT })] });

    const { data } = await h.view();

    expect(rows.isDone()).toBe(true);
    expect(data.job).toMatchObject({ id: job.id, status: 'halted' });
    expect(data.job.inTransit).toEqual({ coin: 'USDC', qty: Number(BOUGHT), at: 'SPOT' });
    expect(h.file()).toEqual(job);
  });

  it('a failed lookup keeps on the way', async () => {
    mockView();
    const job = haltedLoopJob(2, { venueId: 'x2' });
    const h = boot({ job });
    const rows = mockGateGet('/transfers', { status: 500, body: { label: 'SERVER_ERROR', message: 'internal error' } });

    const res = await h.view();

    expect(res.ok).toBe(true);
    expect(rows.isDone()).toBe(true);
    expect(res.data.job).toMatchObject({ id: job.id, status: 'halted' });
    expect(res.data.job.inTransit).toEqual({ coin: 'USDC', qty: Number(BOUGHT), at: 'MOVING' });
    expect(h.file()).toEqual(job);
  });
});

describe('halt alerts', () => {
  it('halt alert says where the money is', async () => {
    mockView();
    const plan = await accountAPlan();
    gate().persist().post(`${API}/crossex/transfers`).query(true).reply(400, { label: 'INVALID_PARAM_VALUE', message: 'refused by the test' });
    const h = boot();
    const job = roundThreeInSpot(plan, 'halted');
    h.jobs.write(job);

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(200);
    await waitFor(() => h.jobs.read()?.status === 'halted', 'the halt');
    expect(await h.alerts()).toEqual([
      expect.objectContaining({
        level: 'error',
        pair_id: `rebalance:${job.id}`,
        message: 'Rebalance stopped in round 3. 36.58 USDC is in Gate spot.',
      }),
    ]);
  });

  it('boot halt alert has pair id', async () => {
    mockView();
    const plan = await accountAPlan();
    const job = roundThreeInSpot(plan, 'running');

    const h = boot({ job });

    expect(await h.alerts()).toEqual([
      expect.objectContaining({
        level: 'error',
        pair_id: `rebalance:${job.id}`,
        message: 'Rebalance stopped in round 3. 36.58 USDC is in Gate spot.',
      }),
    ]);
    expect(h.file()).toMatchObject({
      status: 'halted',
      haltReason: 'The app restarted during the run. Nothing failed. Press Resume.',
    });
  });

  it('boot waits for a step Gate is moving, then halts before the next send', async () => {
    const steps: PlannedStep[] = [ONE_ROUND[0], { ...ONE_ROUND[0], round: 2 }];
    const job = newJob({ route: 'loop', steps, amount: 600, costUsd: 0.16, target: [], userId: null }, t);
    for (const [index, venueId] of ['o1', 'x1'].entries()) {
      Object.assign(job.steps[index], { text: tagFor(job.id, index + 1), venueId, qty: Number(BOUGHT), status: 'done', startedAt: t, doneAt: t });
    }
    Object.assign(job.steps[2], { text: tagFor(job.id, 3), venueId: 'x2', status: 'running', startedAt: t - 3_600_000 });
    Object.assign(job, { stepIndex: 2, tagCount: 3, fundsAt: 'SPOT' });
    const seen: string[] = [];
    const sends: string[] = [];
    let h: ReturnType<typeof boot> | null = null;
    gate()
      .persist()
      .get(`${API}/crossex/transfers`)
      .query(true)
      .reply(200, () => {
        seen.push(h?.file().status ?? 'not booted');
        return seen.length === 1 ? [transferRow('x2', 'PENDING')] : [transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })];
      });
    for (const kind of ['transfers', 'orders']) {
      gate()
        .persist()
        .post(`${API}/crossex/${kind}`)
        .query(true)
        .reply(200, () => {
          sends.push(kind);
          return { tx_id: 'x9', order_id: 'o9' };
        });
    }

    h = boot({ job });
    const booted = h;
    await booted.alerts();
    await waitFor(() => booted.file().status === 'halted', 'the halt');

    expect(booted.file()).toMatchObject({ stepIndex: 3, fundsAt: 'HYPERLIQUID', haltReason: HALT_TEXT.restart });
    expect(booted.file().steps[2]).toMatchObject({ venueId: 'x2', status: 'done', qty: 299.92 });
    expect(seen).toEqual(['running', 'running']);
    expect(sends).toEqual([]);
    expect(await booted.alerts()).toEqual([
      expect.objectContaining({ pair_id: `rebalance:${job.id}`, message: 'Rebalance stopped in round 2.' }),
    ]);
  });

  it('a job that ends done clears its halt alert and no other', async () => {
    const store = new Store(':memory:');
    store.alert('error', 'deal-other', 'another alert', t);
    const job = haltedLoopJob(2, { text: null });
    Object.assign(job, { status: 'running', haltReason: null });
    mockGatePost('/transfers', { body: { tx_id: 'x2', text: 't' } });
    mockGateGet('/transfers', { body: [transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })] });
    const h = boot({ job, store });
    expect(await h.alerts()).toEqual([
      expect.objectContaining({ pair_id: 'deal-other', ack: 0 }),
      expect.objectContaining({ pair_id: `rebalance:${job.id}`, ack: 0 }),
    ]);

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    await waitFor(() => store.listAlerts({ unackedOnly: true }).length === 1, 'the ack');
    expect(store.listAlerts({ unackedOnly: true })).toEqual([expect.objectContaining({ pair_id: 'deal-other' })]);
  });
});

describe('POST /api/rebalance refusals kept from 1.6.0', () => {
  it('answers 400 for a route that is not mix, loop or convert', async () => {
    const h = boot();

    const res = await h.post('/api/rebalance', { route: 'fastest' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('unknown route fastest');
    expect(() => h.file()).toThrow();
  });

  it('answers 409 for a halted job and a working deal, and 403 before the disclaimer', async () => {
    const stored = haltedLoopJob(1, { venueId: 'x1' });
    let h = boot({ job: stored });
    let res = await h.post('/api/rebalance', { route: 'loop' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${stored.id} is halted`);

    await reset();
    h = boot({ store: busyDeal() });
    res = await h.post('/api/rebalance', { route: 'loop' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: { category: 'validation', message: 'deal deal-409 is still working', retryable: true },
    });

    await reset();
    const envPath = path.join(mkdtempSync(path.join(tmpdir(), 'disc-')), '.env');
    h = boot({ credentials: { envPath, setClients: () => {} } });
    res = await h.post('/api/rebalance', { route: 'loop' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.label).toBe('DISCLAIMER_NOT_ACCEPTED');
  });

  it('answers 409 when the fresh account read is rate-limited and Gate would have served the cached one', async () => {
    mockView({ accountThen429: true });
    const h = boot();
    expect((await h.view()).ok).toBe(true);

    const res = await h.post('/api/rebalance', { route: 'loop' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Gate is rate-limiting the account read. Try again in a few seconds.');
    expect(() => h.file()).toThrow();
  });

  it('answers 409 when a deal starts while the plan is being read', async () => {
    const store = new Store(':memory:');
    mockView({
      onAccountRead: () => {
        if (store.listPairs({ activeOnly: true }).length === 0) createDeal(store);
      },
    });
    const h = boot({ store });

    const res = await h.post('/api/rebalance', { route: 'loop' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('deal deal-409 is still working');
    expect(() => h.file()).toThrow();
  });
});

describe('POST /api/rebalance/:id/resume and /abandon', () => {
  it('resume runs a halted job at its step, abandon ends it, both refuse a done job', async () => {
    const job = haltedLoopJob(1, { venueId: 'x1' });
    mockGateGet('/transfers', { body: [transferRow('x1', 'SUCCESS', { actual_receive: BOUGHT })] });
    mockGatePost('/transfers', { body: { tx_id: 'x2', text: 't' } });
    mockGateGet('/transfers', {
      body: [transferRow('x1', 'SUCCESS'), transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })],
    });
    let h = boot({ job });

    let res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: job.id, status: 'running', haltReason: null, stepIndex: 1 });
    expect(res.json().data.steps[1].startedAt).toBe(t);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(h.file().steps.map((s) => s.venueId)).toEqual(['o1', 'x1', 'x2']);
    expect(h.file().steps.map((s) => s.qty)).toEqual([299.97, 299.97, 299.92]);

    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${job.id} is done`);
    res = await h.post(`/api/rebalance/${job.id}/abandon`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${job.id} is done`);
    res = await h.post('/api/rebalance/nope/resume');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('unknown rebalance nope');
    res = await h.post('/api/rebalance/nope/abandon');
    expect(res.statusCode).toBe(400);

    await reset();
    const halted = haltedLoopJob(1, { venueId: 'x1' });
    h = boot({ job: halted });

    res = await h.post(`/api/rebalance/${halted.id}/abandon`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: halted.id, status: 'abandoned', stepIndex: 1 });
    expect(h.file().status).toBe('abandoned');
    res = await h.post(`/api/rebalance/${halted.id}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${halted.id} is abandoned`);
  });

  it('resume refuses while a deal is working', async () => {
    const job = haltedLoopJob(1, { venueId: 'x1' });
    const h = boot({ job, store: busyDeal() });

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('deal deal-409 is still working');
    expect(h.file().status).toBe('halted');
  });

  it('resume refuses a deal that starts while the account is read, and the job stays halted', async () => {
    const store = new Store(':memory:');
    mockView({
      onAccountRead: () => {
        if (store.listPairs({ activeOnly: true }).length === 0) createDeal(store);
      },
    });
    const job = haltedLoopJob(1, { venueId: 'x1' });
    job.userId = '1';
    const h = boot({ job, store });

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('deal deal-409 is still working');
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.restart });
  });

  it('resume refuses a job abandoned while the account is read', async () => {
    let abandon = (): void => {};
    mockView({ onAccountRead: () => abandon() });
    const job = haltedLoopJob(1, { venueId: 'x1' });
    job.userId = '1';
    const h = boot({ job });
    abandon = () => {
      const current = h.jobs.read();
      if (current?.status === 'halted') h.jobs.write({ ...current, status: 'abandoned' });
    };

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${job.id} is no longer halted`);
    expect(h.file().status).toBe('abandoned');
  });

  it('resume refuses a job started on another Gate account and runs one started on this account', async () => {
    mockView();
    const foreign = haltedLoopJob(1, { venueId: 'x1' });
    foreign.userId = '2';
    let h = boot({ job: foreign });

    let res = await h.post(`/api/rebalance/${foreign.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${foreign.id} was started on another Gate account. Abandon it.`);
    expect(h.file().status).toBe('halted');

    await reset();
    mockView();
    const own = haltedLoopJob(1, { venueId: 'x1' });
    own.userId = '1';
    mockGateGet('/transfers', { body: [transferRow('x1', 'SUCCESS', { actual_receive: BOUGHT })] });
    mockGatePost('/transfers', { body: { tx_id: 'x2', text: 't' } });
    mockGateGet('/transfers', {
      body: [transferRow('x1', 'SUCCESS'), transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })],
    });
    h = boot({ job: own });

    res = await h.post(`/api/rebalance/${own.id}/resume`);

    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
  });
});
