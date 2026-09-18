import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import type { EvenPlan, PlannedStep } from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { JobFile, newJob, TransferFile, type Job, type Step } from '../../src/server/rebalanceJob';
import { tagFor } from '../../src/server/rebalanceRunner';
import { gate, HOST, makeTestApp, mockGateGet, mockGatePost, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { accountA, waitFor } from './helpers/rebalance';

const API = '/api/v4';
const BOUGHT = '299.97';

let t: number;
let apps: FastifyInstance[];

const jobSleep = async (ms: number): Promise<void> => {
  t += ms;
};

beforeEach(() => {
  t = Date.now();
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
  nock.cleanAll();
});

function mockView(): void {
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, accountA);
  gate()
    .persist()
    .get(`${API}/crossex/interest_rate`)
    .query(true)
    .reply(200, [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }]);
  gate().persist().get(`${API}/crossex/history_margin_interests`).query(true).reply(200, []);
  gate()
    .persist()
    .get(`${API}/crossex/positions`)
    .query(true)
    .reply(200, [
      { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', position_side: 'NONE', position_qty: '-0.1', position_value: '250', mark_price: '2500' },
      { symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'NONE', position_qty: '0.1', position_value: '250', mark_price: '2500' },
    ]);
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

function bootRebalance(over: { job?: Job; onDone?: () => void } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'telegram-hooks-rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  const app = makeTestApp({
    getClients,
    rebalance: { jobs, sleep: jobSleep, onDone: over.onDone },
    engine: { store: new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
  });
  apps.push(app);
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: HOST })).json();
  return {
    jobs,
    post: (url: string) => app.inject({ method: 'POST', url, headers: HOST }),
    view: () => get('/api/rebalance'),
  };
}

const ONE_ROUND: PlannedStep[] = [
  { round: 1, kind: 'round', buy: 300, move: 300, arrives: 299.95, borrowLeft: 0, seconds: 130, from: 'CROSSEX', to: 'HYPERLIQUID' },
];

function haltedLoopJob(stepIndex: number, patch: Partial<Step> = {}): Job {
  const job = newJob({ route: 'loop', steps: ONE_ROUND, amount: 300, costUsd: 0.08, target: [], userId: null }, t);
  job.status = 'halted';
  job.stepIndex = stepIndex;
  job.tagCount = stepIndex;
  job.fundsAt = (['CROSSEX', 'GATE', 'SPOT'] as const)[stepIndex];
  const venueIds = ['o1', 'x1'];
  for (let i = 0; i < stepIndex; i += 1) {
    Object.assign(job.steps[i], { text: tagFor(job.id, i), venueId: venueIds[i], qty: Number(BOUGHT), status: 'done', startedAt: t, doneAt: t });
  }
  Object.assign(job.steps[stepIndex], { text: tagFor(job.id, stepIndex), status: 'running', startedAt: t, ...patch });
  return job;
}

async function accountAPlan(): Promise<EvenPlan> {
  const h = bootRebalance();
  return (await h.view()).data.plan;
}

function roundThreeInSpot(plan: EvenPlan): Job {
  const { steps, costUsd, after } = plan.routes.loop!;
  const job = newJob({ route: 'loop', steps, amount: plan.moves, costUsd, target: after, userId: '1' }, t);
  for (const step of job.steps.slice(0, 8)) Object.assign(step, { status: 'done', qty: step.planned, startedAt: t, doneAt: t });
  Object.assign(job.steps[8], { status: 'running', startedAt: t });
  return Object.assign(job, { status: 'halted' as const, stepIndex: 8, fundsAt: 'SPOT' as const });
}

const transferRow = (id: string, status: string, over: Record<string, string> = {}) => ({
  id,
  status,
  coin: 'USDC',
  amount: '299.97000',
  ...over,
});

describe('a rebalance job that ends syncs Telegram', () => {
  it('a job that ends done calls onDone once', async () => {
    const job = haltedLoopJob(1, { venueId: 'x1' });
    mockGateGet('/transfers', { body: [transferRow('x1', 'SUCCESS', { actual_receive: BOUGHT })] });
    mockGatePost('/transfers', { body: { tx_id: 'x2', text: 't' } });
    mockGateGet('/transfers', {
      body: [transferRow('x1', 'SUCCESS'), transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })],
    });
    let calls = 0;
    const h = bootRebalance({
      job,
      onDone: () => {
        calls += 1;
      },
    });

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(200);
    await waitFor(() => h.jobs.read()?.status === 'done', 'done');
    expect(calls).toBe(1);
  });

  it('a job that halts mid-run calls onDone once', async () => {
    mockView();
    const plan = await accountAPlan();
    gate().persist().post(`${API}/crossex/transfers`).query(true).reply(400, { label: 'INVALID_PARAM_VALUE', message: 'refused by the test' });
    const job = roundThreeInSpot(plan);
    let calls = 0;
    const h = bootRebalance({
      job,
      onDone: () => {
        calls += 1;
      },
    });

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(200);
    await waitFor(() => h.jobs.read()?.status === 'halted', 'the halt');
    expect(calls).toBe(1);
  });
});

const account = {
  user_id: '1',
  available_margin: '831.95',
  margin_balance: '988.23',
  initial_margin: '156.28',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    { coin: 'USDT', exchange_type: 'CROSSEX', balance: '986.60', equity: '986.60', upnl: '0', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' },
    { coin: 'USDC', exchange_type: 'HYPERLIQUID', balance: '11.92', equity: '11.92', upnl: '0', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' },
    { coin: 'USDC', exchange_type: 'GATE', balance: '0.29', equity: '0.29', upnl: '0', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' },
  ],
};

const transferCoins = [
  { coin: 'USDT', min_trans_amount: '0.00000001', est_fee: '0', precision: 8, is_disabled: 0 },
  { coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: 0 },
];

const SPOT_ROWS = [
  { currency: 'USDT', available: '318.42', locked: '0' },
  { currency: 'USDC', available: '0', locked: '0' },
];

const HL_OUT = { coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: '11.88' };

function mockTransferReads(): void {
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, account);
  gate().persist().get(`${API}/crossex/transfers/coin`).query(true).reply(200, transferCoins);
  gate().persist().get(`${API}/spot/accounts`).query(true).reply(200, SPOT_ROWS);
}

function mockTransferSend(reply: { status: number; body: unknown } = { status: 200, body: { tx_id: '123', text: 't' } }): void {
  gate()
    .persist()
    .post(`${API}/crossex/transfers`)
    .reply(reply.status, reply.body as nock.Body);
}

const mockTransferRows = (status: string, over: Record<string, unknown> = {}): nock.Scope =>
  gate()
    .persist()
    .get(`${API}/crossex/transfers`)
    .query(true)
    .reply(200, [{ id: 123, text: 't-tr', coin: 'USDC', amount: '11.88', status, ...over }]);

function bootTransfer(over: { onDone?: () => void } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'telegram-hooks-transfer-'));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const transfers = new TransferFile(dataDir);
  const app = makeTestApp({
    getClients,
    engine: { store: new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => Date.now() } },
    transfer: { jobs: transfers, sleep: async () => undefined, onDone: over.onDone },
  });
  apps.push(app);
  return {
    transfers,
    post: (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/transfer', headers: HOST, payload }),
  };
}

describe('a transfer that ends syncs Telegram', () => {
  it('a transfer that ends in success calls onDone once', async () => {
    mockTransferReads();
    mockTransferSend();
    mockTransferRows('SUCCESS', { actual_receive: '10.88' });
    let calls = 0;
    const h = bootTransfer({
      onDone: () => {
        calls += 1;
      },
    });

    const res = await h.post(HL_OUT);

    expect(res.statusCode).toBe(202);
    await waitFor(() => h.transfers.read()?.status === 'done', 'the transfer end');
    expect(calls).toBe(1);
  });

  it('a failed transfer calls onDone once', async () => {
    mockTransferReads();
    mockTransferSend({
      status: 422,
      body: { label: 'TRANSFER_AMOUNT_INSUFFICIENT', message: 'Insufficient transferAvailable, transferAvailable: 11.85' },
    });
    let calls = 0;
    const h = bootTransfer({
      onDone: () => {
        calls += 1;
      },
    });

    const res = await h.post(HL_OUT);

    expect(res.statusCode).toBe(202);
    await waitFor(() => h.transfers.read()?.status !== 'moving', 'the refusal');
    expect(h.transfers.read()?.status).toBe('failed');
    expect(calls).toBe(1);
  });
});
