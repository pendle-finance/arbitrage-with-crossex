import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { HYPERLIQUID_WITHDRAW_FEE_USD, TO_USDT_WAIT_SECONDS } from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob, type Job, type Step } from '../../src/server/rebalanceJob';
import { LOOKUP_RETRY_MS, STEP_TIMEOUT_MS, tagFor } from '../../src/server/rebalanceRunner';
import type { AppDeps } from '../../src/server/app';
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

function boot(
  over: {
    store?: Store;
    sleep?: (ms: number) => Promise<void>;
    job?: Job;
    credentials?: AppDeps['credentials'];
    cache?: TtlCache;
  } = {},
) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const app = makeTestApp({
    getClients,
    rebalance: { jobs: new JobFile(dataDir), sleep: over.sleep ?? sleep },
    engine: { store: over.store ?? new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
    credentials: over.credentials,
    ...(over.cache ? { cache: over.cache } : {}),
  });
  apps.push(app);
  return {
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'rebalance.json'), 'utf8')) as Job,
    post: (url = '/api/rebalance', payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url, headers: HOST, payload }),
    view: async (query = '') => (await app.inject({ method: 'GET', url: `/api/rebalance${query}`, headers: HOST })).json(),
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

function mockView(
  opts: { ask?: string; account?: unknown; disabled?: number; accountThen429?: boolean; onAccountRead?: () => void } = {},
): void {
  const body = opts.account ?? account();
  if (opts.accountThen429) {
    gate().get(`${API}/crossex/accounts`).query(true).reply(200, body);
    gate().persist().get(`${API}/crossex/accounts`).query(true).reply(429, { label: 'TOO_MANY_REQUESTS', message: 'slow down' });
  } else {
    gate()
      .persist()
      .get(`${API}/crossex/accounts`)
      .query(true)
      .reply(200, () => {
        opts.onAccountRead?.();
        return body;
      });
  }
  mockGateGet('/interest_rate', {
    body: [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }],
  });
  mockGateGet('/history_margin_interests', {
    body: [{ liability_coin: 'USDC', exchange_type: 'HYPERLIQUID', interest: '0.01', create_time: String(t - 1000) }],
  });
  mockGateGet('/transfers/coin', {
    body: [{ coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: opts.disabled ?? 0 }],
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
/** Gate books a convert as a filled market sell whose text is the quote id. */
const convertOrderBody = (orderId: string, quoteId: string, received: string) => ({
  order_id: orderId,
  text: quoteId,
  state: 'FILLED',
  executed_qty: '0',
  executed_amount: received,
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
  const job = newJob('toUsdc', 'loop', AMOUNT, t);
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

const TO_USDT_AMOUNT = 1200;

const toUsdtAccount = () => account({ balance: '5000', available_balance: '5000', equity: '5000', liability: '0' });

const isTransfer = (b: Record<string, unknown>, from: string, to: string, amount: string): boolean =>
  b.coin === 'USDC' && b.from === from && b.to === to && b.amount === amount && typeof b.text === 'string';

const isSell = (b: Record<string, unknown>): boolean =>
  b.symbol === 'GATE_SPOT_USDC_USDT' && b.side === 'SELL' && b.type === 'MARKET' && b.qty === '1199.00' && !('quote_qty' in b);

function holdRunner(): () => void {
  let release: () => void = () => undefined;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

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
    expect(h.file()).toMatchObject({ id, userId: '1', status: 'running', route: 'loop', amount: AMOUNT, stepIndex: 0 });
    await waitFor(() => orders.isDone(), 'the order POST', 2000);
    expect(h.file().status).toBe('running');

    release();
    await waitFor(() => h.file().status === 'halted', 'the halt');

    await reset();
    mockView();
    mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('REJECT', '0') });
    const capped = boot();
    const smaller = await capped.post('/api/rebalance', { amount: 100.005, route: 'loop' });
    expect(smaller.statusCode).toBe(202);
    expect(capped.file()).toMatchObject({ amount: 100, route: 'loop' });
    await waitFor(() => capped.file().status === 'halted', 'the halt');

    await reset();
    mockView();
    mockGatePost('/orders', { body: orderBody('OPEN', '0') });
    mockGateGet('/orders/o1', { body: orderBody('REJECT', '0') });
    const larger = boot();
    const capped2 = await larger.post('/api/rebalance', { amount: 5000 });
    expect(capped2.statusCode).toBe(202);
    expect(larger.file().amount).toBe(AMOUNT);
    await waitFor(() => larger.file().status === 'halted', 'the halt');
  });

  it('refuses: 409 for a running job, a working deal, no route, a changed plan, and one of two concurrent POSTs; 403 before the disclaimer', async () => {
    const stored = newJob('toUsdc', 'loop', AMOUNT, t);
    let h = boot({ job: stored });
    let res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(`rebalance ${stored.id} is halted`);

    await reset();
    h = boot({ store: busyDeal() });
    res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: { category: 'validation', message: 'deal deal-409 is still working', retryable: true },
    });

    await reset();
    const envPath = path.join(mkdtempSync(path.join(tmpdir(), 'disc-')), '.env');
    h = boot({ credentials: { envPath, setClients: () => {} } });
    res = await h.post();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.label).toBe('DISCLAIMER_NOT_ACCEPTED');

    await reset();
    mockView({ disabled: 1, account: account({ equity: '0', liability: '0' }) });
    h = boot();
    res = await h.post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('no route');

    await reset();
    mockView();
    h = boot();
    res = await h.post('/api/rebalance', { route: 'convert' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('plan changed: now loop');
    expect(() => h.file()).toThrow();

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

  it('refuses: 409 when the fresh account read is rate-limited and Gate would have served the cached one', async () => {
    mockView({ accountThen429: true });
    const h = boot();
    expect((await h.view()).ok).toBe(true);

    const res = await h.post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Gate is rate-limiting the account read. Try again in a few seconds.');
    expect(() => h.file()).toThrow();
  });

  it('refuses: 409 when a deal starts while the plan is being read', async () => {
    const store = new Store(':memory:');
    mockView({
      onAccountRead: () => {
        if (store.listPairs({ activeOnly: true }).length === 0) createDeal(store);
      },
    });
    const h = boot({ store });

    const res = await h.post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('deal deal-409 is still working');
    expect(() => h.file()).toThrow();
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
    expect(job).toMatchObject({
      direction: 'toUsdc',
      status: 'done',
      route: 'loop',
      amount: AMOUNT,
      stepIndex: 2,
      fundsAt: 'HYPERLIQUID',
      haltReason: null,
    });
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
    expect(h.file().steps[0]).toMatchObject({ venueId: null, text: null });

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
    const job = newJob('toUsdc', 'loop', AMOUNT, t);
    Object.assign(job.steps[0], { text: tagFor(job.id, 0), venueId: 'o1', status: 'running', startedAt: t });
    const h = boot({ job });

    const { data } = await h.view();

    expect(data.job).toMatchObject({ id: job.id, status: 'halted', haltReason: 'server restarted', stepIndex: 0 });
    expect(data.job.steps[0]).toMatchObject({ venueId: 'o1', status: 'running' });
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: 'server restarted' });
  });

  it('toUsdt: 202 with direction toUsdt, two transfers then a market sell sized by what landed, qty from executedAmount, funds at CROSSEX', async () => {
    const cache = new TtlCache();
    mockView({ account: toUsdtAccount() });
    const transfers = gate()
      .post(`${API}/crossex/transfers`, (b) => isTransfer(b, 'CROSSEX_HYPERLIQUID', 'SPOT', '1200.00000'))
      .query(true)
      .reply(200, { tx_id: 'p1', text: 't' });
    mockGateGet('/transfers', { body: [transferRow('p1', 'PENDING', { amount: '1200.00000' })] });
    mockGateGet('/transfers', { body: [transferRow('p1', 'SUCCESS', { amount: '1200.00000', actual_receive: '1199' })] });
    const toGate = gate()
      .post(`${API}/crossex/transfers`, (b) => isTransfer(b, 'SPOT', 'CROSSEX_GATE', '1199.00000'))
      .query(true)
      .reply(200, { tx_id: 'p2', text: 't' });
    mockGateGet('/transfers', {
      body: [
        transferRow('p1', 'SUCCESS', { amount: '1200.00000', actual_receive: '1199' }),
        transferRow('p2', 'SUCCESS', { amount: '1199.00000', actual_receive: '1199' }),
      ],
    });
    const sells = gate()
      .post(`${API}/crossex/orders`, isSell)
      .query(true)
      .reply(200, orderBody('OPEN', '0', 's1'));
    mockGateGet('/orders/s1', { body: orderBody('OPEN', '0', 's1') });
    mockGateGet('/orders/s1', { body: { ...orderBody('FILLED', '1199', 's1'), executed_amount: '1197.8011' } });
    let h = boot({ cache });

    const before = (await h.view(`?direction=toUsdt&amount=${TO_USDT_AMOUNT}`)).data;
    expect(before.plan).toMatchObject({
      direction: 'toUsdt',
      amount: TO_USDT_AMOUNT,
      route: 'loop',
      price: 1,
      receives: 1197.8,
      borrowAfterUsd: 0,
      shortfall: null,
      savesPerDayUsd: 0,
      marginFreedUsd: 0,
    });
    expect(before.plan.routes.loop).toMatchObject({ waitSeconds: TO_USDT_WAIT_SECONDS, available: true, reason: null });
    expect(before.plan.routes.loop.costUsd).toBeCloseTo(TO_USDT_AMOUNT * 0.001 + HYPERLIQUID_WITHDRAW_FEE_USD, 9);
    expect(before.plan.routes.convert).toMatchObject({ available: true, reason: null, waitSeconds: 0 });
    expect(before.plan.routes.convert.costUsd).toBeCloseTo(TO_USDT_AMOUNT * 0.002, 9);
    expect(before.job).toBeNull();

    const res = await h.post('/api/rebalance', { direction: 'toUsdt', amount: TO_USDT_AMOUNT, route: 'loop' });
    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({
      id: res.json().data.id,
      direction: 'toUsdt',
      route: 'loop',
      amount: TO_USDT_AMOUNT,
      status: 'running',
      fundsAt: 'HYPERLIQUID',
    });
    expect(h.file().steps.map((s) => s.name)).toEqual(['From Hyperliquid', 'To Gate', 'Sell USDC']);
    await waitFor(() => h.file().status === 'done', 'done');

    expect(transfers.isDone()).toBe(true);
    expect(toGate.isDone()).toBe(true);
    expect(sells.isDone()).toBe(true);
    const { value } = await cache.get('account', 60_000, async () => 'fresh');
    expect(value).toBe('fresh');

    const { job } = (await h.view()).data;
    expect(job).toMatchObject({ direction: 'toUsdt', status: 'done', stepIndex: 2, fundsAt: 'CROSSEX', haltReason: null });
    expect(job.steps.map((s: Step) => s.status)).toEqual(['done', 'done', 'done']);
    expect(job.steps.map((s: Step) => s.venueId)).toEqual(['p1', 'p2', 's1']);
    expect(job.steps.map((s: Step) => s.qty)).toEqual([1199, 1199, 1197.8011]);
    for (const step of job.steps as Step[]) {
      expect(step.text).toBe(tagFor(job.id, job.steps.indexOf(step)));
      expect(step.doneAt).toBeTypeOf('number');
    }
    expect(nock.pendingMocks()).toEqual([]);

    await reset();
    mockView();
    h = boot();
    const empty = (await h.view('?direction=toUsdt')).data.plan;
    expect(empty).toMatchObject({ direction: 'toUsdt', amount: 0, route: null, receives: 0, price: null });
    expect(empty.routes.loop).toMatchObject({ available: false, reason: 'nothing to move' });
    expect(empty.routes.convert).toMatchObject({ available: false, reason: 'nothing to move' });
    const refused = await h.post('/api/rebalance', { direction: 'toUsdt' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe('no route');
  });

  it('toUsdt convert: a small move picks convert, quotes USDC to USDT, sends, funds at CROSSEX; a resumed quote is found on Gate by its id', async () => {
    mockView({ account: toUsdtAccount() });
    const isToUsdtQuote = (b: Record<string, unknown>): boolean =>
      b.exchange_type === 'HYPERLIQUID' && b.from_coin === 'USDC' && b.to_coin === 'USDT' && b.from_amount === '12';
    const quotes = gate()
      .post(`${API}/crossex/convert/quote`, isToUsdtQuote)
      .query(true)
      .reply(200, { ...quoteBody('q3', '11.98'), from_coin: 'USDC', to_coin: 'USDT', from_amount: '12', price: '0.9981' });
    const orders = mockGatePost('/convert/orders', { body: { order_id: 'c3', text: 'q3' } });
    let h = boot();

    const before = (await h.view('?direction=toUsdt&amount=12')).data;
    expect(before.plan).toMatchObject({ direction: 'toUsdt', amount: 12, route: 'convert', price: 0.998, receives: 11.97 });
    expect(before.plan.routes.loop).toMatchObject({ available: true, reason: null });
    expect(before.plan.routes.loop.costUsd).toBeCloseTo(12 * 0.001 + HYPERLIQUID_WITHDRAW_FEE_USD, 9);
    expect(before.plan.routes.convert.costUsd).toBeCloseTo(0.024, 9);
    // Gate sends min_trans_amount as the string "11"; the reason must add, not concatenate.
    const small = (await h.view('?direction=toUsdt&amount=11.5')).data.plan;
    expect(small.routes.loop.reason).toBe(
      'Too small to move. Gate takes a flat $1 fee on the way out and needs at least 11 USDC to arrive. Move at least 12 USDC.',
    );
    expect(small.route).toBe('convert');

    const res = await h.post('/api/rebalance', { direction: 'toUsdt', amount: 12, route: 'convert' });
    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({ direction: 'toUsdt', route: 'convert', amount: 12, fundsAt: 'HYPERLIQUID' });
    expect(h.file().steps.map((s) => s.name)).toEqual(['Convert']);
    await waitFor(() => h.file().status === 'done', 'done');

    expect(quotes.isDone()).toBe(true);
    expect(orders.isDone()).toBe(true);
    const { job } = (await h.view()).data;
    expect(job).toMatchObject({ direction: 'toUsdt', route: 'convert', status: 'done', fundsAt: 'CROSSEX', haltReason: null });
    expect(job.steps[0]).toMatchObject({
      name: 'Convert',
      text: tagFor(job.id, 0),
      quoteId: 'q3',
      venueId: 'c3',
      qty: 11.98,
      status: 'done',
    });

    await reset();
    mockView({ account: toUsdtAccount() });
    const byQuote = mockGateGet('/orders/q4', { body: convertOrderBody('c4', 'q4', '11.98') });
    mockGateGet('/orders/c4', { body: convertOrderBody('c4', 'q4', '11.98') });
    const unsent = mockGatePost('/convert/orders', { body: { order_id: 'c5', text: 'q5' } });
    const resumed = newJob('toUsdt', 'convert', 12, t);
    resumed.status = 'halted';
    resumed.haltReason = 'server restarted';
    Object.assign(resumed.steps[0], { text: tagFor(resumed.id, 0), quoteId: 'q4', qty: 11.98, status: 'running', startedAt: t });
    h = boot({ job: resumed });

    const again = await h.post(`/api/rebalance/${resumed.id}/resume`);
    expect(again.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(byQuote.isDone()).toBe(true);
    expect(unsent.isDone()).toBe(false);
    expect(h.file()).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(h.file().steps[0]).toMatchObject({ quoteId: 'q4', venueId: 'c4', qty: 11.98, status: 'done' });
  });

  it('toUsdt halts and resumes like toUsdc: a FAILED transfer halts with funds at HYPERLIQUID, abandon ends it, and a resumed Sell USDC with a tag only adopts the order and sends nothing', async () => {
    mockView({ account: toUsdtAccount() });
    mockGatePost('/transfers', { body: { tx_id: 'p1', text: 't' } });
    mockGateGet('/transfers', { body: [transferRow('p1', 'FAILED', { amount: '1200.00000', fail_reason: 'withdraw paused' })] });
    let h = boot();
    let res = await h.post('/api/rebalance', { direction: 'toUsdt', amount: TO_USDT_AMOUNT });
    expect(res.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'halted', 'the halt');
    expect(h.file()).toMatchObject({ direction: 'toUsdt', haltReason: 'withdraw paused', fundsAt: 'HYPERLIQUID', stepIndex: 0 });
    expect(h.file().steps[0]).toMatchObject({ name: 'From Hyperliquid', venueId: null, text: null, status: 'running' });
    const { id } = h.file();
    res = await h.post(`/api/rebalance/${id}/abandon`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id, direction: 'toUsdt', status: 'abandoned' });

    await reset();
    mockView({ account: toUsdtAccount() });
    const job = newJob('toUsdt', 'loop', TO_USDT_AMOUNT, t);
    job.status = 'halted';
    job.haltReason = 'server restarted';
    job.stepIndex = 2;
    job.fundsAt = 'GATE';
    for (const i of [0, 1]) {
      Object.assign(job.steps[i], {
        text: tagFor(job.id, i),
        venueId: `p${i + 1}`,
        qty: 11,
        status: 'done',
        startedAt: t,
        doneAt: t,
      });
    }
    Object.assign(job.steps[2], { text: tagFor(job.id, 2), status: 'running', startedAt: t });
    const lookup = mockGateGet(`/orders/${tagFor(job.id, 2)}`, {
      body: { ...orderBody('FILLED', '11', 's1'), executed_amount: '10.9989' },
    });
    const poll = mockGateGet('/orders/s1', { body: { ...orderBody('FILLED', '11', 's1'), executed_amount: '10.9989' } });
    const sells = mockGatePost('/orders', { body: orderBody('OPEN', '0', 's1') });
    h = boot({ job });

    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: job.id, direction: 'toUsdt', status: 'running', stepIndex: 2 });
    await waitFor(() => h.file().status === 'done', 'done');
    expect(lookup.isDone()).toBe(true);
    expect(poll.isDone()).toBe(true);
    expect(sells.isDone()).toBe(false);
    expect(h.file()).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(h.file().steps[2]).toMatchObject({ name: 'Sell USDC', venueId: 's1', qty: 10.9989, status: 'done' });
  });
});

describe('GET /api/rebalance', () => {
  it('amount param: caps plan.amount at the query amount, floors it, ignores a bad value, and carries price, receives, borrowAfterUsd', async () => {
    mockView();
    const h = boot();
    const planAt = async (query: string) => (await h.view(query)).data.plan;

    const full = await planAt('');
    expect(full).toMatchObject({ direction: 'toUsdc', amount: AMOUNT, route: 'loop', price: 1.0001, receives: 299.62 });
    expect(full.borrowAfterUsd).toBeCloseTo(0.38, 9);

    const capped = await planAt('?amount=100.005');
    expect(capped).toMatchObject({ direction: 'toUsdc', amount: 100, route: 'loop', price: 1.0001, receives: 99.84 });
    expect(capped.borrowAfterUsd).toBeCloseTo(200.16, 9);

    expect((await planAt('?amount=5000')).amount).toBe(AMOUNT);
    expect((await planAt('?amount=abc')).amount).toBe(AMOUNT);
    expect((await planAt('?amount=0')).amount).toBe(AMOUNT);
    expect((await planAt('?direction=toUsdc&amount=50')).amount).toBe(50);
  });

  it('old job file: a rebalance.json without direction reads as toUsdc and is written back with it', async () => {
    mockView();
    const { direction: _direction, ...legacy } = newJob('toUsdc', 'loop', AMOUNT, t);
    const h = boot({ job: legacy as Job });

    const { data } = await h.view();

    expect(data.job).toMatchObject({ id: legacy.id, userId: null, direction: 'toUsdc', status: 'halted', haltReason: 'server restarted' });
    expect(data.job.steps.map((s: Step) => s.name)).toEqual(['Buy USDC', 'To spot', 'To Hyperliquid']);
    expect(h.file().direction).toBe('toUsdc');
  });

  it('accepts the direction names from before 1.5.1 on the API: pull reads as toUsdt, payDown as toUsdc', async () => {
    mockView();
    const h = boot();

    expect((await h.view('?direction=pull')).data.plan.direction).toBe('toUsdt');
    expect((await h.view('?direction=payDown')).data.plan.direction).toBe('toUsdc');
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
    mockView();
    const job = haltedLoopJob(1, { venueId: 'x1' });
    const h = boot({ job, store: busyDeal() });

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('deal deal-409 is still working');
    expect(h.file().status).toBe('halted');
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

  it('no double send: a venueId is polled once, a found tag is adopted, a missing tag is sent once after 10 s, a quote Gate knows needs no order', async () => {
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
    mockView();
    const quotes = mockGatePost('/convert/quote', { body: quoteBody('q9', '299.4') });
    const convertOrders = mockGatePost('/convert/orders', { body: { order_id: 'c9', text: 'q9' } });
    const known = mockGateGet('/orders/q1', { body: convertOrderBody('c1', 'q1', '299.4') });
    mockGateGet('/orders/c1', { body: convertOrderBody('c1', 'q1', '299.4') });
    job = newJob('toUsdc', 'convert', AMOUNT, t);
    job.status = 'halted';
    job.haltReason = 'server restarted';
    Object.assign(job.steps[0], { text: tagFor(job.id, 0), quoteId: 'q1', qty: 299.4, status: 'running', startedAt: t });
    h = boot({ job });
    res = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(res.statusCode).toBe(200);
    await waitFor(() => h.file().status === 'done', 'done');
    expect(h.file()).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(h.file().steps[0]).toMatchObject({ quoteId: 'q1', venueId: 'c1', qty: 299.4, status: 'done' });
    expect(known.isDone()).toBe(true);
    expect(quotes.isDone()).toBe(false);
    expect(convertOrders.isDone()).toBe(false);
  });
});
