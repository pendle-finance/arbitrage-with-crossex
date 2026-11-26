import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import type { EvenPlan, PlannedStep } from '../../src/core/rebalance/plan';
import type { RealizeLeg } from '../../src/core/rebalance/realize';
import { Store } from '../../src/engine/db';
import { project } from '../../src/engine/decide';
import type { PairRow } from '../../src/engine/types';
import { gateVenue } from '../../src/engine/venueGate';
import { HALT_TEXT, inTransitOf, JobFile, newJob, type Job, type Step } from '../../src/server/rebalanceJob';
import { tagFor } from '../../src/server/rebalanceRunner';
import type { AppDeps } from '../../src/server/app';
import { gate, HOST, makeTestApp, mockGateGet, mockGatePost, orderBody, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { account as borosAccount, ADDRESS, HL as HL_MARKET, market, relay, wireBook } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { accountA, waitFor } from './helpers/rebalance';

const API = '/api/v4';
const BOUGHT = '299.97';

let t: number;
let apps: FastifyInstance[];

type Outcome = { a?: string; b?: string; mode?: PairRow['mode']; haltKind?: PairRow['haltKind'] };

let live: Store | null;
let auto: boolean;
let modes: string[];
let outcomeOf: (pair: PairRow) => Outcome;

const fillOrder = (store: Store, id: string, leg: 'A' | 'B', side: 'BUY' | 'SELL', qty: string): void => {
  const order = store.insertPendingOrder({ pairId: id, leg, kind: 'taker', side, qty, price: null, tif: 'ioc', now: t });
  store.updateOrder(id, leg, order.seq, { state: 'CLOSED', cumQty: qty, avgFillPrice: qty === '0' ? '0' : '1821', resolvedAt: t });
};

function settleAll(): void {
  if (!auto || !live) return;
  for (const pair of live.listPairs()) {
    if (pair.mode === 'OPENING' || pair.mode === 'CONVERTING') {
      const out = outcomeOf(pair);
      const a = out.a ?? pair.targetQty;
      fillOrder(live, pair.id, 'A', pair.a.side, a);
      if (pair.b) fillOrder(live, pair.id, 'B', pair.b.side, out.b ?? a);
      live.updatePair(pair.id, { mode: out.mode ?? 'DONE', haltKind: out.haltKind ?? null });
    } else if (pair.mode === 'STOPPING') {
      modes.push(`${pair.id}:STOPPING`);
      const filled = project(pair, live.listOrders(pair.id));
      const gap = Number(filled.aFilled) - Number(filled.bFilled);
      if (pair.b && gap > 0) fillOrder(live, pair.id, 'B', pair.b.side, String(gap));
      live.updatePair(pair.id, { mode: 'DONE' });
    }
  }
}

const sleep = async (ms: number): Promise<void> => {
  t += ms;
  settleAll();
  if (!auto) await new Promise((resolve) => setTimeout(resolve, 1));
};

beforeEach(() => {
  t = Date.now();
  apps = [];
  live = null;
  auto = true;
  modes = [];
  outcomeOf = () => ({});
});

afterEach(async () => {
  await reset();
});

async function reset(): Promise<void> {
  for (const app of apps) await app.close();
  apps = [];
  nock.cleanAll();
}

function boot(over: { store?: Store; job?: unknown; credentials?: AppDeps['credentials']; extra?: Partial<AppDeps> } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  live = over.store ?? new Store(':memory:');
  const app = makeTestApp({
    getClients,
    rebalance: { jobs, sleep },
    engine: { store: live, venue: gateVenue(getClients), clock: { now: () => t }, wake: settleAll },
    credentials: over.credentials,
    ...over.extra,
  });
  apps.push(app);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: HOST })).json();
  return {
    jobs,
    store: live,
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
  return (await h.view()).data.plans.even;
}

function roundThreeInSpot(plan: EvenPlan, status: Job['status']): Job {
  const { steps, costUsd, after } = plan.routes.loop!;
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
    repegBehindBp: null,
    repegAutoBp: null,
    repegNotBefore: 0,
    haltKind: null,
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

  it.each([
    [2_448_286.19, 2_448_286.19],
    [0, 0],
    [null, undefined],
    ['12', undefined],
    [undefined, undefined],
  ])('a Buy step with cashBefore %o reads back %o', (cashBefore, kept) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rebalance-job-'));
    const job = haltedLoopJob(1);
    const steps = [{ ...job.steps[0], cashBefore }, ...job.steps.slice(1)];
    writeFileSync(path.join(dir, 'rebalance.json'), JSON.stringify({ ...job, steps }));

    const read = new JobFile(dir).read();

    expect(read?.steps.map((step) => step.name)).toEqual(['Buy USDC', 'To spot', 'To Hyperliquid']);
    if (kept === undefined) expect(read?.steps[0]).not.toHaveProperty('cashBefore');
    else expect(read?.steps[0].cashBefore).toBe(kept);
  });

  it.each([
    [1_758_000_000_000, 1_758_000_000_000],
    [0, 0],
    [null, undefined],
    ['1758000000000', undefined],
    [undefined, undefined],
  ])('a Buy step with sentAt %o reads back %o', (sentAt, kept) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rebalance-job-'));
    const job = haltedLoopJob(1);
    const steps = [{ ...job.steps[0], sentAt }, ...job.steps.slice(1)];
    writeFileSync(path.join(dir, 'rebalance.json'), JSON.stringify({ ...job, steps }));

    const read = new JobFile(dir).read();

    expect(read?.steps.map((step) => step.name)).toEqual(['Buy USDC', 'To spot', 'To Hyperliquid']);
    if (kept === undefined) expect(read?.steps[0]).not.toHaveProperty('sentAt');
    else expect(read?.steps[0].sentAt).toBe(kept);
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

describe('realize leg fees on the job', () => {
  const leg = (usd: number): RealizeLeg => ({
    pool: 'HYPERLIQUID',
    symbol: 'HYPERLIQUID_PERP_ETH_USDC',
    exchange: 'HYPERLIQUID',
    base: 'ETH',
    side: 'SHORT',
    positionQty: 66 * usd,
    qty: 53.8 * usd,
    realizedUsd: 34386 * usd,
    convert: { amount: 10298 * usd, count: 1, feeUsd: 20.6 * usd },
    closeFeeUsd: 51.2 * usd,
    reopenFeeUsd: 51.19 * usd,
    closeImpactUsd: 9.44 * usd,
    reopenImpactUsd: 9.44 * usd,
    impactBp: 1.9,
    closeMakerFeeUsd: 20.5 * usd,
  });
  const jobFor = (realize: RealizeLeg) =>
    newJob({ route: 'convert', steps: [], amount: 0, costUsd: 0, target: [], userId: '1', realize: { legs: [realize], refused: null, estimates: { maker: { feeUsd: 0, impactUsd: 0, totalUsd: 0 }, market: { feeUsd: 0, impactUsd: 0, totalUsd: 0 } } } }, t);

  it.each([1 / 4000, 1, 30])('the job keeps the plan fees per leg at %o of the 53.8 ETH leg', (usd) => {
    const job = jobFor(leg(usd));

    expect(job.realize?.legs[0]).toMatchObject({
      closeFeeUsd: 51.2 * usd,
      reopenFeeUsd: 51.19 * usd,
      closeImpactUsd: 9.44 * usd,
      reopenImpactUsd: 9.44 * usd,
      convert: { amount: 10298 * usd, feeUsd: 20.6 * usd },
    });
  });

  it('a leg with no convert stores none', () => {
    expect(jobFor({ ...leg(1), convert: null }).realize?.legs[0].convert).toBeNull();
  });

  it('an old job file with no leg fees still reads', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rebalance-job-'));
    const job = jobFor(leg(1));
    const legs = job.realize!.legs.map(({ closeFeeUsd, reopenFeeUsd, closeImpactUsd, reopenImpactUsd, convert, ...rest }) => rest);
    writeFileSync(path.join(dir, 'rebalance.json'), JSON.stringify({ ...job, realize: { ...job.realize, legs } }));

    const read = new JobFile(dir).read();

    expect(read?.realize?.legs[0]).toMatchObject({ qty: 53.8, filledQty: 0 });
    expect(read?.realize?.legs[0]).not.toHaveProperty('closeFeeUsd');
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
    let res = await h.post('/api/rebalance', { route: 'loop', costUsd: 1000 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${stored.id} is halted`);

    await reset();
    h = boot({ store: busyDeal() });
    res = await h.post('/api/rebalance', { route: 'loop', costUsd: 1000 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: { category: 'validation', message: 'A deal is still running. Wait for it to finish.', retryable: true },
    });

    await reset();
    const envPath = path.join(mkdtempSync(path.join(tmpdir(), 'disc-')), '.env');
    h = boot({ credentials: { envPath, setClients: () => {} } });
    res = await h.post('/api/rebalance', { route: 'loop', costUsd: 1000 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.label).toBe('DISCLAIMER_NOT_ACCEPTED');
  });

  it('answers 409 when the fresh account read is rate-limited and Gate would have served the cached one', async () => {
    mockView({ accountThen429: true });
    const h = boot();
    expect((await h.view()).ok).toBe(true);

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: 1000 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Gate is limiting requests from this account. Try again in a few seconds.');
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

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: 1000 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('A deal is still running. Wait for it to finish.');
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
    expect(res.json().error.message).toBe('A deal is still running. Wait for it to finish.');
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
    expect(res.json().error.message).toBe('A deal is still running. Wait for it to finish.');
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
    expect(res.json().error.message).toBe('This rebalance is no longer halted');
    expect(h.file().status).toBe('abandoned');
  });

  it('resume refuses a job started on another Gate account and runs one started on this account', async () => {
    mockView();
    const foreign = haltedLoopJob(1, { venueId: 'x1' });
    foreign.userId = '2';
    let h = boot({ job: foreign });

    let res = await h.post(`/api/rebalance/${foreign.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('This rebalance was started on another Gate account. Abandon it.');
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

describe('sliced jobs through the routes', () => {
  const HL = 'HYPERLIQUID_FUTURE_ETH_USDC';
  const DELEVER = {
    makerLeg: 0 as const,
    legs: [
      { symbol: HL, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT' as const, before: 66, after: 33, closeQty: 33 },
      { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', base: 'ETH', side: 'LONG' as const, before: 66, after: 33, closeQty: 33 },
    ],
    boros: [],
  };
  const sliced = (over: Partial<Job> = {}): Job => ({
    ...newJob({ route: 'mix', steps: [], amount: 0, costUsd: 30, target: [], userId: '1', kind: 'delever', delever: DELEVER, sliceCount: 14, sliceUsd: 25_000 }, t),
    slice: { index: 6, count: 14, sizeUsd: 25_000 },
    ...over,
  });

  it('pausing state', async () => {
    const h = boot();
    await h.alerts();
    const job = sliced({ status: 'running' });
    h.jobs.write(job);

    const res = await h.post(`/api/rebalance/${job.id}/pause`);

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'running', pauseRequested: true, slice: { index: 6, count: 14 } });
    expect(h.file().pauseRequested).toBe(true);
  });

  const GATE_ETH = 'GATE_FUTURE_ETH_USDT';
  const perpRule = (symbol: string) => ({
    symbol,
    state: 'live',
    business_type: 'FUTURE',
    lot_size: '0.01',
    min_size: '0.01',
    min_notional: '0',
    tick_size: '0.1',
    max_market_size: '10000',
    max_limit_size: '10000',
  });
  const levels = { coin: 'ETH', levels: [[{ px: '1820.9', sz: '1000', n: 1 }], [{ px: '1821.1', sz: '1000', n: 1 }]] };
  const borosDeps = (): Partial<AppDeps> => {
    process.env.BOROS_ROOT_ADDRESS = ADDRESS;
    return {
      borosFetch: borosStub({
        '/apis/v1/markets': { results: [market(HL_MARKET, 'Hyperliquid', 0.09)] },
        [`/apis/v1/markets/order-book?marketId=${HL_MARKET}`]: wireBook(900, 920),
        ...borosAccount(500_000, [{ marketId: HL_MARKET, size: 100 }]),
      }),
      getBorosOrders: () => relay(borosCalls),
    };
  };
  let borosCalls: string[] = [];

  afterEach(() => {
    delete process.env.BOROS_ROOT_ADDRESS;
    borosCalls = [];
  });

  type Sent = Record<string, string | number | undefined>;
  const heldPerps = (hl: number, gateQty: number) => [
    { symbol: HL, position_side: 'NONE', position_qty: String(-hl), position_value: String(hl * 1821), mark_price: '1821' },
    { symbol: GATE_ETH, position_side: 'NONE', position_qty: String(gateQty), position_value: String(gateQty * 1821), mark_price: '1821' },
  ];
  function sliceVenue(positions: unknown[] = heldPerps(66, 66), rules: unknown[] = [perpRule(HL), perpRule(GATE_ETH)]): Sent[] {
    const sent: Sent[] = [];
    gate()
      .persist()
      .get(`${API}/crossex/rule/symbols`)
      .query(true)
      .reply(200, rules);
    mockView({ positions });
    const tier = (symbol: string) => ({ symbol, tiers: [{ max_risk_limit_value: '1000000000', leverage_max: '50' }] });
    gate().persist().get(`${API}/crossex/open_orders`).query(true).reply(200, []);
    gate().persist().get(`${API}/crossex/rule/risk_limits`).query(true).reply(200, [tier(HL), tier(GATE_ETH)]);
    nock('https://api.hyperliquid.xyz').persist().post('/info', (body) => body.type === 'l2Book').reply(200, levels);
    nock('https://api.gateio.ws')
      .persist()
      .get('/api/v4/futures/usdt/contracts/ETH_USDT')
      .query(true)
      .reply(200, { name: 'ETH_USDT', quanto_multiplier: '0.01', order_price_round: '0.01' });
    nock('https://api.gateio.ws')
      .persist()
      .get('/api/v4/futures/usdt/order_book')
      .query(true)
      .reply(200, { bids: [{ p: '1820.9', s: 1_000_000 }], asks: [{ p: '1821.1', s: 1_000_000 }] });
    gate()
      .persist()
      .post(`${API}/crossex/orders`)
      .query(true)
      .reply(200, (_uri, body) => {
        sent.push(body as Record<string, string>);
        return { order_id: `o${sent.length}`, text: (body as Record<string, string>).text };
      });
    return sent;
  }

  const seedChild = (
    store: Store,
    id: string,
    over: { mode: PairRow['mode']; a: string; b?: string; qty?: string; haltKind?: PairRow['haltKind']; aSide?: 'BUY' | 'SELL'; bSide?: 'BUY' | 'SELL'; aContract?: string; bContract?: string; reduceOnly?: boolean },
  ): void => {
    const spec = (contract: string, side: 'BUY' | 'SELL') => ({ contract, side, lot: '0.01', minSize: '0.01', minNotional: '0', tick: '0.1', ...(over.reduceOnly === false ? {} : { reduceOnly: true }) });
    const aSide = over.aSide ?? 'BUY';
    const bSide = over.bSide ?? 'SELL';
    store.createPair({
      id,
      mode: over.mode,
      a: spec(over.aContract ?? HL, aSide),
      b: over.b === undefined ? null : spec(over.bContract ?? GATE_ETH, bSide),
      targetQty: over.qty ?? '10',
      limitPrice: '1821',
      pricePolicy: 'touch',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      repegBehindBp: null,
      repegAutoBp: null,
      repegNotBefore: 0,
      haltKind: over.haltKind ?? null,
      haltReason: over.haltKind ? 'The hedge was refused.' : null,
      reportJson: null,
      createdAt: t,
    });
    if (Number(over.a) > 0) fillOrder(store, id, 'A', aSide, over.a);
    if (over.b !== undefined && Number(over.b) > 0) fillOrder(store, id, 'B', bSide, over.b);
  };

  const leadOf = (id: string) => ({ text: id, venueId: null, sentAt: t, credited: 0, poc: false, price: null, side: 'BUY' as const, mid: 1821, entry: null });

  const inFlight = (id: string, over: Partial<Job> = {}): Job => {
    const job = sliced({ status: 'running', exec: 'market', ...over });
    job.steps[0].lead = leadOf(id);
    job.steps[0].hedge = { ...leadOf(id), side: 'SELL' };
    job.steps[0].cut = { qty: 10, from: 0, at: t, ioc: true };
    return job;
  };

  const halted = (over: Partial<Job> = {}): { job: Job; id: string } => {
    const job = inFlight('placeholder', { status: 'halted', haltReason: 'HL refused', haltKind: 'hedge-margin', ...over });
    const id = `${job.id}-s6-1`;
    job.steps[0].lead = leadOf(id);
    job.steps[0].hedge = { ...leadOf(id), side: 'SELL' };
    return { job, id };
  };

  const atBoros = (): Job => {
    const job = newJob(
      {
        route: 'mix',
        steps: [],
        amount: 0,
        costUsd: 30,
        target: [],
        userId: '1',
        kind: 'delever',
        delever: { ...DELEVER, boros: [{ marketId: HL_MARKET, before: 100, after: 50, closeSize: 50 }] },
        sliceCount: 3,
        sliceUsd: 25_000,
      },
      t,
    );
    job.realize!.legs[0].filledQty = 33;
    Object.assign(job.steps[0], { status: 'done', qty: 33, startedAt: t, doneAt: t });
    job.delever!.boros[0].closed = 20;
    Object.assign(job, { status: 'halted', haltReason: 'Boros did not close all of its share.', stepIndex: 1, borosLeftYu: 30, borosGapYu: 30 });
    return job;
  };

  const unfilled = (): Job => {
    const job = sliced({ status: 'halted', haltReason: HALT_TEXT.restart, exec: 'market' });
    job.realize!.legs[0].filledQty = 12;
    Object.assign(job.steps[0], { status: 'running', startedAt: t, qty: 12, cut: { qty: 2, from: 10, at: t, ioc: true } });
    return job;
  };

  it('boot stops a live slice child and halts restart', async () => {
    const sent = sliceVenue();
    const job = inFlight('placeholder');
    const id = `${job.id}-s6-1`;
    job.steps[0].lead = leadOf(id);
    auto = false;
    const store = new Store(':memory:');
    seedChild(store, id, { mode: 'OPENING', a: '5', b: '2', qty: '10', haltKind: null });
    const h = boot({ job, store });

    await h.alerts();
    await waitFor(() => h.file().status === 'halted', 'the boot halt');

    expect(store.getPair(id)?.mode).toBe('STOPPING');
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.restart, haltKind: 'restart', paused: false });
    expect(sent).toEqual([]);
  });

  it('boot pauses the job when a pause was asked and no child is live', async () => {
    const sent = sliceVenue();
    const job = inFlight('placeholder', { pauseRequested: true });
    const id = `${job.id}-s6-1`;
    job.steps[0].lead = leadOf(id);
    const store = new Store(':memory:');
    seedChild(store, id, { mode: 'DONE', a: '10', b: '10' });
    const h = boot({ job, store });

    await h.alerts();
    await waitFor(() => h.file().status === 'halted', 'the boot halt');

    expect(h.file()).toMatchObject({ status: 'halted', paused: true, pauseRequested: false, haltReason: null });
    expect(sent).toEqual([]);
  });

  it('boot hedges what the stopped child holds, and Resume credits both fills', async () => {
    const sent = sliceVenue();
    const job = inFlight('placeholder', { pauseRequested: true });
    const id = `${job.id}-s6-1`;
    job.steps[0].lead = leadOf(id);
    const store = new Store(':memory:');
    seedChild(store, id, { mode: 'OPENING', a: '5', b: '2', qty: '10' });
    const h = boot({ job, store });
    await h.alerts();
    await waitFor(() => h.file().status === 'halted', 'the boot halt');
    expect(modes).toEqual([`${id}:STOPPING`]);
    expect(project(store.getPair(id) as PairRow, store.listOrders(id))).toMatchObject({ aFilled: '5', bFilled: '5' });
    expect(h.file()).toMatchObject({ pauseRequested: true, paused: false });

    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.file().paused === true, 'the pause');

    expect(h.file().realize!.legs[0].filledQty).toBe(5);
    expect(h.file().steps[0].qty).toBe(5);
    expect(h.store!.listPairs()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('a Delever slice is one engine child with both legs reduce-only, and Gate sees no perp order', async () => {
    const sent = sliceVenue();
    const job = unfilled();
    const h = boot({ job, extra: borosDeps() });

    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');

    const first = h.store!.getPair(`${job.id}-s7-1`) as PairRow;
    expect(first).toMatchObject({
      a: { contract: HL, side: 'BUY', reduceOnly: true },
      b: { contract: GATE_ETH, side: 'SELL', reduceOnly: true },
    });
    expect(h.file().slice!.index).toBeGreaterThan(6);
    expect(h.file().realize!.legs[0].filledQty).toBe(33);
    expect(sent).toEqual([]);
  });

  it('a slice never asks more than the venue max order size, even when the live mid is below the plan mark', async () => {
    sliceVenue(heldPerps(66, 66), [perpRule(HL), { ...perpRule(GATE_ETH), max_market_size: '5', max_limit_size: '5' }]);
    const job = unfilled();
    expect(job.slice!.sizeUsd / 1821).toBeGreaterThan(5);
    const h = boot({ job, extra: borosDeps() });

    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');

    const children = h.store!.listPairs();
    expect(children.length).toBeGreaterThan(1);
    for (const child of children) expect(Number(child.targetQty)).toBeLessThanOrEqual(5);
    expect(h.file().realize!.legs[0].filledQty).toBe(33);
  });

  it('with TWAP off, Pause lets the child in flight end first, then the job pauses', async () => {
    const sent = sliceVenue();
    const job = unfilled();
    auto = false;
    const h = boot({ job, extra: borosDeps() });
    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.store!.listPairs().length === 1, 'the child');
    const id = h.store!.listPairs()[0].id;

    expect((await h.post(`/api/rebalance/${job.id}/pause`)).statusCode).toBe(200);
    await waitFor(() => h.file().pauseRequested === true, 'the pause flag');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.store!.getPair(id)?.mode).not.toBe('STOPPING');
    auto = true;
    settleAll();
    await waitFor(() => h.file().paused === true, 'the pause');

    expect(h.store!.listPairs()).toHaveLength(1);
    expect(h.file()).toMatchObject({ status: 'halted', paused: true, pauseRequested: false, haltReason: null });
    expect(sent).toEqual([]);
  });

  it('with TWAP on, Pause stops the live child at once', async () => {
    const sent = sliceVenue();
    const job = unfilled();
    job.deleverTwap = { durationSec: 600, intervalSec: 60, slices: 10 };
    auto = false;
    const h = boot({ job, extra: borosDeps() });
    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.store!.listPairs().length === 1, 'the child');
    const id = h.store!.listPairs()[0].id;

    expect((await h.post(`/api/rebalance/${job.id}/pause`)).statusCode).toBe(200);
    await waitFor(() => h.store!.getPair(id)?.mode === 'STOPPING', 'the stop');
    auto = true;
    settleAll();
    await waitFor(() => h.file().paused === true, 'the pause');

    expect(sent).toEqual([]);
  });

  it('a child halted on the hedge halts a Delever, and names the venue and the slice', async () => {
    const sent = sliceVenue();
    const job = unfilled();
    outcomeOf = () => ({ a: '4', b: '0', mode: 'HALTED', haltKind: 'hedge-margin' });
    const h = boot({ job, extra: borosDeps() });

    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.file().status === 'halted', 'the halt');

    expect(h.file()).toMatchObject({ status: 'halted', haltKind: 'hedge-margin', haltReason: 'Gate refused the hedge in slice 7' });
    expect(sent).toEqual([]);
  });

  it.each(['market', 'limit'] as const)('fix at %s resumes the halted child, the engine hedges the gap at market, then the job runs', async (action) => {
    const sent = sliceVenue();
    const { job, id } = halted();
    const store = new Store(':memory:');
    seedChild(store, id, { mode: 'HALTED', a: '10', b: '6', qty: '10', haltKind: 'hedge-margin' });
    const h = boot({ job, store, extra: borosDeps() });

    const res = await h.post(`/api/rebalance/${job.id}/fix`, { action });

    expect(res.statusCode).toBe(200);
    expect(modes).toEqual([`${id}:STOPPING`]);
    expect(project(store.getPair(id) as PairRow, store.listOrders(id))).toMatchObject({ aFilled: '10', bFilled: '10' });
    await waitFor(() => h.file().status === 'done', 'done');
    expect(sent).toEqual([]);
  });

  it('two fix presses resume the child once', async () => {
    const sent = sliceVenue();
    const { job, id } = halted();
    const store = new Store(':memory:');
    seedChild(store, id, { mode: 'HALTED', a: '10', b: '6', qty: '10', haltKind: 'hedge-margin' });
    const h = boot({ job, store, extra: borosDeps() });
    await h.alerts();

    const [first, second] = await Promise.all([
      h.post(`/api/rebalance/${job.id}/fix`, { action: 'market' }),
      h.post(`/api/rebalance/${job.id}/fix`, { action: 'market' }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(modes.filter((mode) => mode === `${id}:STOPPING`)).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('fix unwind sends a one-leg market child that reverses the maker fill, ends the halted child and leaves the job paused', async () => {
    const sent = sliceVenue();
    const { job, id } = halted();
    const store = new Store(':memory:');
    seedChild(store, id, { mode: 'HALTED', a: '4', b: '0', qty: '10', haltKind: 'hedge-margin' });
    const h = boot({ job, store, extra: borosDeps() });

    const res = await h.post(`/api/rebalance/${job.id}/fix`, { action: 'unwind' });
    expect(res.statusCode).toBe(200);
    expect(store.getPair(id)?.mode).toBe('DONE');
    const unwind = store.getPair(`${job.id}-s6-2`) as PairRow;
    expect(unwind).toMatchObject({ a: { contract: HL, side: 'SELL' }, b: null, targetQty: '4' });
    expect(unwind.a.reduceOnly).toBeFalsy();
    expect(h.file()).toMatchObject({ status: 'halted', paused: true, haltReason: null });
    expect(sent).toEqual([]);
  });

  it('a whole-leg Delever with unequal legs ends with a one-leg reduce-only taker child for the excess', async () => {
    const sent = sliceVenue(heldPerps(33, 30));
    const job = newJob(
      {
        route: 'mix',
        steps: [],
        amount: 0,
        costUsd: 30,
        target: [],
        userId: '1',
        kind: 'delever',
        delever: {
          makerLeg: 0,
          legs: [
            { symbol: HL, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', before: 33, after: 0, closeQty: 33, closeAll: true },
            { symbol: GATE_ETH, exchange: 'GATE', base: 'ETH', side: 'LONG', before: 30, after: 0, closeQty: 30, closeAll: true },
          ],
          boros: [],
        },
        sliceCount: 3,
        sliceUsd: 25_000,
      },
      t,
    );
    Object.assign(job, { status: 'halted', haltReason: HALT_TEXT.restart });
    const h = boot({ job, extra: borosDeps() });

    expect((await h.post(`/api/rebalance/${job.id}/resume`)).statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');

    const pairs = h.store!.listPairs();
    const last = pairs[pairs.length - 1];
    expect(last).toMatchObject({ a: { contract: HL, side: 'BUY', reduceOnly: true }, b: null, targetQty: '3' });
    expect(pairs.slice(0, -1).every((pair) => pair.b !== null)).toBe(true);
    expect(sent).toEqual([]);
  });

  it('fix boros retry', async () => {
    mockView();
    const job = atBoros();
    const h = boot({ job, extra: borosDeps() });

    const res = await h.post(`/api/rebalance/${job.id}/fix`, { action: 'boros-retry' });

    expect(res.json().error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'done', borosLeftYu: 0 });
    expect(h.file().delever!.boros[0].closed).toBe(50);
    expect(borosCalls.length).toBeGreaterThan(0);
  });

  it('fix add back sends one one-leg market child per perp and Gate sees no perp order', async () => {
    const sent = sliceVenue();
    const job = atBoros();
    const h = boot({ job, extra: borosDeps() });

    const res = await h.post(`/api/rebalance/${job.id}/fix`, { action: 'add-back' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'done', borosLeftYu: 0 });
    const pairs = h.store!.listPairs();
    expect(pairs.map((pair) => ({ id: pair.id, contract: pair.a.contract, side: pair.a.side, qty: pair.targetQty, b: pair.b }))).toEqual([
      { id: `${job.id}-f1`, contract: HL, side: 'SELL', qty: '19.8', b: null },
      { id: `${job.id}-f2`, contract: GATE_ETH, side: 'BUY', qty: '19.8', b: null },
    ]);
    expect(pairs.every((pair) => pair.a.reduceOnly !== true)).toBe(true);
    expect(sent).toEqual([]);
  });

  it('loads a 1.7.9 job', async () => {
    const old: Record<string, unknown> = { ...sliced({ status: 'halted', haltReason: 'stopped' }) };
    for (const key of ['kind', 'exec', 'slice', 'notHedgedQty', 'followMisses', 'follow', 'borosGapYu', 'borosLeftYu', 'feeSoFarUsd', 'estimate', 'pauseRequested', 'paused', 'delever', 'imUsedNow', 'imUsedEnd', 'imUsedStart', 'totalCostUsd', 'retryConverts']) delete old[key];
    const legacy = newJob({ route: 'convert', steps: ONE_ROUND, amount: 300, costUsd: 1, target: [], userId: '1' }, t);
    const file: Record<string, unknown> = { ...legacy, status: 'halted', haltReason: 'stopped' };
    for (const key of Object.keys(old)) if (!(key in file)) delete file[key];
    for (const key of ['kind', 'exec', 'slice', 'pauseRequested', 'paused', 'delever', 'retryConverts']) delete file[key];
    const h = boot({ job: file });
    mockView();

    const res = await h.post('/api/rebalance', { route: 'convert', costUsd: 1 });

    expect(h.jobs.read()).toMatchObject({ status: 'halted', kind: 'move', paused: false });
    expect(res.statusCode).toBe(409);
  });

  it('stop alert is in-app only', async () => {
    const telegram = nock('https://api.telegram.org').post(/.*/).reply(200, { ok: true });
    const job = newJob({ route: 'convert', steps: ONE_ROUND, amount: 300, costUsd: 1, target: [], userId: '1' }, t);
    const h = boot({ job });

    await h.alerts();
    await waitFor(() => h.file().status === 'halted', 'the halt');

    expect((await h.alerts()).some((row) => String(row.pairId ?? row.pair_id).startsWith('rebalance:'))).toBe(true);
    expect(telegram.isDone()).toBe(false);
  });
});
