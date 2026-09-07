import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { newJob, type Job, type Step } from '../../src/server/rebalanceJob';
import { LOOKUP_RETRY_MS, STEP_TIMEOUT_MS, tagFor } from '../../src/server/rebalanceRunner';
import { gate, HOST, makeTestApp, mockGateGet, mockGatePost, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const API = '/api/v4';
const AMOUNT = 300;
const BOUGHT = '299.97';

let t: number;
let hold: Promise<void> | null;
let apps: FastifyInstance[];

const sleep = async (ms: number): Promise<void> => {
  t += ms;
  if (hold) await hold;
};

beforeEach(() => {
  t = Date.now();
  hold = null;
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

async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function boot(over: { store?: Store; sleep?: (ms: number) => Promise<void>; job?: Job } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const app = makeTestApp({
    getClients,
    rebalance: { dataDir, sleep: over.sleep ?? sleep },
    engine: { store: over.store ?? new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
  });
  apps.push(app);
  return {
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'rebalance.json'), 'utf8')) as Job,
    post: (url = '/api/rebalance') => app.inject({ method: 'POST', url, headers: HOST, payload: {} }),
    view: async () => (await app.inject({ method: 'GET', url: '/api/rebalance', headers: HOST })).json(),
  };
}

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

const account = (usdcOnHl: Record<string, string> = { equity: '-300', liability: '300', borrowing_initial_margin: '30' }) => ({
  user_id: '1',
  available_margin: '900',
  margin_balance: '900',
  account_mode: 'CROSS_EXCHANGE',
  assets: [asset('USDT', 'CROSSEX', { balance: '1200', equity: '1200' }), asset('USDC', 'HYPERLIQUID', usdcOnHl), asset('USDC', 'GATE')],
});

function mockView(opts: { ask?: string; account?: unknown; disabled?: number } = {}): void {
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, opts.account ?? account());
  mockGateGet('/interest_rate', {
    body: [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }],
  });
  mockGateGet('/history_margin_interests', {
    body: [{ liability_coin: 'USDC', exchange_type: 'HYPERLIQUID', interest: '0.01', create_time: String(t - 1000) }],
  });
  mockGateGet('/transfers/coin', {
    body: [{ coin: 'USDC', min_trans_amount: 11, est_fee: 0.05, precision: 5, is_disabled: opts.disabled ?? 0 }],
  });
  mockGateGet('/rule/symbols', {
    body: [{ symbol: 'GATE_SPOT_USDC_USDT', exchange_type: 'GATE', business_type: 'SPOT', state: 'live' }],
  });
  mockGateGet('/fee', { fixture: 'fee.json' });
  gate()
    .persist()
    .get(`${API}/spot/tickers`)
    .query(true)
    .reply(200, [{ currency_pair: 'USDC_USDT', lowest_ask: opts.ask ?? '1.0001', highest_bid: '1', last: '1' }]);
}

const orderBody = (state: string, executedQty: string, orderId = 'o1') => ({
  order_id: orderId,
  text: 't',
  state,
  executed_qty: executedQty,
});
const transferRow = (id: string, status: string, over: Record<string, string> = {}) => ({
  id,
  status,
  coin: 'USDC',
  amount: '299.97000',
  ...over,
});
const quoteBody = (quoteId: string, toAmount: string) => ({
  quote_id: quoteId,
  valid_ms: '5000',
  from_coin: 'USDT',
  to_coin: 'USDC',
  from_amount: String(AMOUNT),
  to_amount: toAmount,
  price: '0.998',
});

function mockLoopAfterBuy(): nock.Scope {
  const poll = mockGateGet('/orders/o1', { body: orderBody('FILLED', BOUGHT) });
  mockGatePost('/transfers', { body: { tx_id: 'x1', text: 't' } });
  mockGateGet('/transfers', { body: [transferRow('x1', 'SUCCESS', { actual_receive: BOUGHT })] });
  mockGatePost('/transfers', { body: { tx_id: 'x2', text: 't' } });
  mockGateGet('/transfers', { body: [transferRow('x1', 'SUCCESS'), transferRow('x2', 'PENDING')] });
  mockGateGet('/transfers', {
    body: [transferRow('x1', 'SUCCESS'), transferRow('x2', 'SUCCESS', { actual_receive: '299.92' })],
  });
  return poll;
}

function haltedLoopJob(stepIndex: number, patch: Partial<Step> = {}): Job {
  const job = newJob('loop', AMOUNT, t);
  job.status = 'halted';
  job.haltReason = 'server restarted';
  job.stepIndex = stepIndex;
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

function holdRunner(): () => void {
  let release: () => void = () => undefined;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

const busyDeal = () => {
  const store = new Store(':memory:');
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
  return store;
};

describe('POST /api/rebalance', () => {
  it('starts: 202 with the id, rebalance.json running, and the order POST leaves within 2 s', async () => {
    const release = holdRunner();
    mockView();
    const orders = mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('REJECT', '0') });
    const h = boot();

    const res = await h.post();

    expect(res.statusCode).toBe(202);
    const { id } = res.json().data;
    expect(id).toBeTypeOf('string');
    expect(h.file()).toMatchObject({ id, status: 'running', route: 'loop', amount: AMOUNT, stepIndex: 0 });
    await waitFor(() => orders.isDone(), 'the order POST', 2000);
    expect(h.file().status).toBe('running');

    release();
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('refuses: 409 for a running job, a working deal, no route, and one of two concurrent POSTs', async () => {
    mockView();
    let h = boot({ store: busyDeal() });
    let res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: { category: 'validation', message: 'deal deal-409 is still working', retryable: true },
    });

    await reset();
    mockView({ disabled: 1, account: account({ equity: '0', liability: '0' }) });
    h = boot();
    res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('no route');

    await reset();
    const release = holdRunner();
    mockView();
    const orders = mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('REJECT', '0') });
    h = boot();
    const [first, second] = await Promise.all([h.post(), h.post()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const { id } = h.file();
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().error.message).toBe(`rebalance ${id} is running`);
    res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${id} is running`);
    await waitFor(() => orders.isDone(), 'the order POST', 2000);
    expect(orders.isDone()).toBe(true);

    release();
    await waitFor(() => h.file().status === 'halted', 'the halt');
    res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${id} is halted`);
  });

  it('completes loop: three steps done with venue ids within 5 s of the last SUCCESS', async () => {
    mockView();
    const orders = mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockLoopAfterBuy();
    const h = boot();

    const res = await h.post();
    expect(res.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'done', 'done');

    const { job } = (await h.view()).data;
    expect(job).toMatchObject({ status: 'done', route: 'loop', amount: AMOUNT, stepIndex: 2, fundsAt: 'HYPERLIQUID', haltReason: null });
    expect(job.steps.map((s: Step) => s.name)).toEqual(['Buy USDC', 'To spot', 'To Hyperliquid']);
    expect(job.steps.map((s: Step) => s.status)).toEqual(['done', 'done', 'done']);
    expect(job.steps.map((s: Step) => s.venueId)).toEqual(['o1', 'x1', 'x2']);
    expect(job.steps.map((s: Step) => s.qty)).toEqual([299.97, 299.97, 299.92]);
    for (const step of job.steps as Step[]) {
      expect(step.startedAt).toBeTypeOf('number');
      expect(step.doneAt).toBeTypeOf('number');
      expect(step.text).toBe(tagFor(job.id, job.steps.indexOf(step)));
    }
    expect(orders.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('convert: quotes and sends when convert is cheaper; halted below the floor with no order sent', async () => {
    mockView({ ask: '1.003' });
    const quotes = mockGatePost('/convert/quote', { body: quoteBody('q1', '299.4') });
    const orders = mockGatePost('/convert/orders', { body: { order_id: 'c1', text: 'q1' } });
    let h = boot();

    let res = await h.post();
    expect(res.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'done', 'done');

    let { job } = (await h.view()).data;
    expect(job).toMatchObject({ status: 'done', route: 'convert', amount: AMOUNT, fundsAt: 'HYPERLIQUID' });
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0]).toMatchObject({
      name: 'Convert',
      text: tagFor(job.id, 0),
      quoteId: 'q1',
      venueId: 'c1',
      qty: 299.4,
      balanceBefore: 0,
      status: 'done',
    });
    expect(quotes.isDone()).toBe(true);
    expect(orders.isDone()).toBe(true);

    await reset();
    mockView({ ask: '1.003' });
    mockGatePost('/convert/quote', { body: quoteBody('q2', '299.0') });
    const unsent = mockGatePost('/convert/orders', { body: { order_id: 'c2', text: 'q2' } });
    h = boot();

    res = await h.post();
    expect(res.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'halted', 'the halt');

    job = (await h.view()).data.job;
    expect(job).toMatchObject({ status: 'halted', haltReason: 'quote worse than 30 bps', fundsAt: 'CROSSEX' });
    expect(job.steps[0]).toMatchObject({ quoteId: null, venueId: null, status: 'running' });
    expect(unsent.isDone()).toBe(false);
  });

  it('halts: on a rejected order, a failed transfer, a labelled 400 at send, and a 600 s timeout', async () => {
    mockView();
    mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('REJECT', '0') });
    let h = boot();
    await h.post();
    await waitFor(() => h.file().status === 'halted', 'the halt');
    expect(h.file()).toMatchObject({ haltReason: 'order REJECT with nothing filled', fundsAt: 'CROSSEX', stepIndex: 0 });

    await reset();
    mockView();
    mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('FILLED', BOUGHT) });
    mockGatePost('/transfers', { body: { tx_id: 'x1', text: 't' } });
    mockGateGet('/transfers', { body: [transferRow('x1', 'FAILED', { fail_reason: 'insufficient balance' })] });
    h = boot();
    await h.post();
    await waitFor(() => h.file().status === 'halted', 'the halt');
    expect(h.file()).toMatchObject({ haltReason: 'insufficient balance', fundsAt: 'GATE', stepIndex: 1 });
    expect(h.file().steps[0].status).toBe('done');

    await reset();
    mockView();
    mockGatePost('/orders', {
      status: 400,
      body: { label: 'TRADE_INVALID_QUOTE_ORDER_QTY', message: 'quote qty is required' },
    });
    h = boot();
    await h.post();
    await waitFor(() => h.file().status === 'halted', 'the halt');
    expect(h.file().haltReason).toContain('TRADE_INVALID_QUOTE_ORDER_QTY');
    expect(h.file()).toMatchObject({ fundsAt: 'CROSSEX', stepIndex: 0 });
    expect(h.file().steps[0].venueId).toBeNull();

    await reset();
    mockView();
    mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    gate().persist().get(`${API}/crossex/orders/o1`).query(true).reply(200, orderBody('OPEN', '0'));
    h = boot({
      sleep: async (ms) => {
        t += ms * 100;
      },
    });
    const startedAt = t;
    await h.post();
    await waitFor(() => h.file().status === 'halted', 'the halt');
    expect(h.file()).toMatchObject({ haltReason: 'timeout', fundsAt: 'CROSSEX' });
    expect(t - startedAt).toBeGreaterThan(STEP_TIMEOUT_MS);
  });

  it('halts on boot: a running job in rebalance.json is halted with server restarted before the first GET', async () => {
    mockView();
    const job = newJob('loop', AMOUNT, t);
    Object.assign(job.steps[0], { text: tagFor(job.id, 0), venueId: 'o1', status: 'running', startedAt: t });
    const h = boot({ job });

    const { data } = await h.view();

    expect(data.job).toMatchObject({ id: job.id, status: 'halted', haltReason: 'server restarted', stepIndex: 0 });
    expect(data.job.steps[0]).toMatchObject({ venueId: 'o1', status: 'running' });
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: 'server restarted' });
  });
});

describe('POST /api/rebalance/:id/resume and /abandon', () => {
  it('resume and abandon: resume runs a halted job at its step, abandon ends it, both refuse a done job', async () => {
    mockView();
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

    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${job.id} is done`);
    res = await h.post(`/api/rebalance/${job.id}/abandon`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${job.id} is done`);
    res = await h.post('/api/rebalance/nope/resume');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('unknown rebalance nope');

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

  it('no double send: a venueId is polled once, a found tag is adopted, a missing tag is sent once after 10 s, a landed quote needs no order', async () => {
    mockView();
    let orders = mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    let poll = mockLoopAfterBuy();
    let job = haltedLoopJob(0, { venueId: 'o1' });
    let h = boot({ job });
    let res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(poll.isDone()).toBe(true);
    expect(orders.isDone()).toBe(false);
    expect(h.file().steps[0].venueId).toBe('o1');

    await reset();
    mockView();
    orders = mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    job = haltedLoopJob(0);
    const lookup = mockGateGet(`/orders/${tagFor(job.id, 0)}`, { body: orderBody('FILLED', BOUGHT, 'o1') });
    poll = mockLoopAfterBuy();
    h = boot({ job });
    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(lookup.isDone()).toBe(true);
    expect(poll.isDone()).toBe(true);
    expect(orders.isDone()).toBe(false);
    expect(h.file().steps[0].venueId).toBe('o1');

    await reset();
    mockView();
    job = haltedLoopJob(0);
    const seen: number[] = [];
    gate()
      .get(`${API}/crossex/orders/${tagFor(job.id, 0)}`)
      .query(true)
      .times(2)
      .reply(() => {
        seen.push(t);
        return [404, { label: 'ORDER_NOT_FOUND', message: 'order not found' }];
      });
    orders = mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockLoopAfterBuy();
    h = boot({ job });
    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(seen).toHaveLength(2);
    expect(seen[1] - seen[0]).toBe(LOOKUP_RETRY_MS);
    expect(orders.isDone()).toBe(true);
    expect(h.file().steps[0].venueId).toBe('o1');

    await reset();
    mockView({ account: account({ balance: '399.4', equity: '99.4', liability: '300', borrowing_initial_margin: '30' }) });
    const quotes = mockGatePost('/convert/quote', { body: quoteBody('q9', '299.4') });
    const convertOrders = mockGatePost('/convert/orders', { body: { order_id: 'c9', text: 'q9' } });
    job = newJob('convert', AMOUNT, t);
    job.status = 'halted';
    job.haltReason = 'server restarted';
    Object.assign(job.steps[0], {
      text: tagFor(job.id, 0),
      quoteId: 'q1',
      qty: 299.4,
      balanceBefore: 100,
      status: 'running',
      startedAt: t,
    });
    h = boot({ job });
    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(h.file()).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(h.file().steps[0]).toMatchObject({ quoteId: 'q1', venueId: null, qty: 299.4, status: 'done' });
    expect(quotes.isDone()).toBe(false);
    expect(convertOrders.isDone()).toBe(false);
  });
});
