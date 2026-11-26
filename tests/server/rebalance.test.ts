import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { roundToStep } from '../../src/core/numbers';
import type { NormalizedBook } from '../../src/core/estimate/books';
import type { AccountLike, EvenPlan, PlannedStep } from '../../src/core/rebalance/plan';
import type { RealizeLeg, RealizePerp, RealizePlan } from '../../src/core/rebalance/realize';
import type { SliceOption } from '../../src/core/rebalance/slices';
import { FEE_ROWS, GATE_ETH, OWNER_HL_ETH, ownerBook, perp, PERP_RULES, realizeBook, type RealizeBook } from '../unit/fixtures/realize-books';
import { Store } from '../../src/engine/db';
import { closeBorosLegs } from '../../src/server/borosClose';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { gateVenue } from '../../src/engine/venueGate';
import { GATE_HISTORY_FLOOR_MS } from '../../src/server/interestLedger';
import { InterestFile } from '../../src/server/interestLedger';
import { gapsLeftBy, JobFile, newJob, newTransferJob, TransferFile, type Job } from '../../src/server/rebalanceJob';
import { LOOKUP_WINDOW_MS } from '../../src/server/rebalanceRunner';
import { isShownRealize } from '../../src/server/routes/rebalance';
import { gate, HOST, makeTestApp, mockGateGet, orderBody, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { accountA, asset, waitFor } from './helpers/rebalance';

const planEdit = vi.hoisted(() => ({ dropConvertSteps: false, convertCost: null as number | null, realize: null as RealizePlan | null }));

vi.mock(import('../../src/server/borosClose'), async (importOriginal) => ({ ...(await importOriginal()), closeBorosLegs: vi.fn() }));

vi.mock(import('../../src/core/rebalance/plan'), async (importOriginal) => {
  const plan = await importOriginal();
  return {
    ...plan,
    planFor: (...args: Parameters<typeof plan.planFor>) => {
      const made = plan.planFor(...args);
      const convert = { ...made.routes.convert };
      if (planEdit.dropConvertSteps) convert.steps = [];
      if (planEdit.convertCost !== null) convert.costUsd = planEdit.convertCost;
      return { ...made, routes: { ...made.routes, convert }, ...(planEdit.realize ? { realize: planEdit.realize } : {}) };
    },
  };
});

const API = '/api/v4';
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ESTIMATES = { maker: { feeUsd: 0, impactUsd: 0, totalUsd: 0 }, market: { feeUsd: 0, impactUsd: 0, totalUsd: 0 } };

let t: number;
let apps: FastifyInstance[];

beforeEach(() => {
  t = Date.now();
  apps = [];
  planEdit.dropConvertSteps = false;
  planEdit.convertCost = null;
  planEdit.realize = null;
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

const noCashAccount = {
  user_id: '1',
  available_margin: '594',
  margin_balance: '595',
  initial_margin: '1',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    asset('USDT', 'CROSSEX', { balance: '100', available_balance: '100', equity: '100' }),
    asset('USDC', 'HYPERLIQUID', { balance: '-5', upnl: '500', equity: '495', liability: '5', borrowing_initial_margin: '1' }),
    asset('USDC', 'GATE'),
  ],
};

const lighterAccount = {
  user_id: '1',
  available_margin: '4000',
  margin_balance: '4000',
  initial_margin: '0',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    asset('USDT', 'CROSSEX', { balance: '4000', available_balance: '4000', equity: '4000' }),
    asset('USDC', 'HYPERLIQUID'),
    asset('USDC', 'LIGHTER'),
    asset('USDC', 'GATE'),
  ],
};

const THREE_WALLET_POSITIONS = [
  { symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'NONE', position_qty: '0.2', position_value: '500', mark_price: '2500' },
  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', position_side: 'NONE', position_qty: '-0.1', position_value: '250', mark_price: '2500' },
  { symbol: 'LIGHTER_FUTURE_ETH_USDC', position_side: 'NONE', position_qty: '-0.1', position_value: '250', mark_price: '2500' },
];

const REFUSAL = { label: 'INVALID_PARAM_VALUE', message: 'refused by the test' };

const PLAN_CHANGED_TEXT = 'The plan changed. Check the new route before you rebalance.';

const RELOAD_TEXT = 'This page is out of date. Reload it and check the plan before you rebalance.';

const HEDGED_POSITIONS = [
  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', position_side: 'NONE', position_qty: '-0.1', position_value: '250', mark_price: '2500' },
  { symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'NONE', position_qty: '0.1', position_value: '250', mark_price: '2500' },
];

const PERP_RULE_ROWS = Object.entries(PERP_RULES).map(([symbol, rule]) => ({
  symbol,
  exchange_type: symbol.split('_')[0],
  business_type: 'FUTURE',
  state: 'live',
  lot_size: rule.lotSize,
  min_size: rule.minSize,
  min_notional: rule.minNotional,
}));

const FEE_WIRE_ROWS = FEE_ROWS.map((row) => ({
  exchange_type: row.exchangeType,
  future_maker_fee: row.futureMakerFee,
  future_taker_fee: row.futureTakerFee,
  ...(row.exchangeType === 'GATE' ? { spot_maker_fee: '0', spot_taker_fee: '0' } : {}),
  special_fee_list: [],
}));

function mockView(
  opts: { account?: unknown; disabled?: string; accountDelayMs?: number; positions?: unknown[]; rates?: unknown[] } = {},
): void {
  const accounts = gate().persist().get(`${API}/crossex/accounts`).query(true);
  if (opts.accountDelayMs) accounts.delay(opts.accountDelayMs);
  accounts.reply(200, opts.account ?? accountA);
  gate()
    .persist()
    .get(`${API}/crossex/interest_rate`)
    .query(true)
    .reply(200, opts.rates ?? [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(t) }]);
  gate().persist().get(`${API}/crossex/history_margin_interests`).query(true).reply(200, []);
  gate().persist().get(`${API}/crossex/positions`).query(true).reply(200, opts.positions ?? HEDGED_POSITIONS);
  gate()
    .persist()
    .get(`${API}/crossex/transfers/coin`)
    .query(true)
    .reply(200, [{ coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: opts.disabled ?? '0' }]);
  gate()
    .persist()
    .get(`${API}/crossex/rule/symbols`)
    .query(true)
    .reply(200, [{ symbol: 'GATE_SPOT_USDC_USDT', exchange_type: 'GATE', business_type: 'SPOT', state: 'live' }, ...PERP_RULE_ROWS]);
  gate().persist().get(`${API}/crossex/fee`).query(true).reply(200, FEE_WIRE_ROWS);
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

function boot(over: { job?: unknown; borosFetch?: ReturnType<typeof borosStub> } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  const transfers = new TransferFile(dataDir);
  const store = new Store(':memory:');
  const app = makeTestApp({
    getClients,
    rebalance: { jobs, sleep },
    transfer: { jobs: transfers },
    engine: { store, venue: gateVenue(getClients), clock: { now: () => t } },
    ...(over.borosFetch ? { borosFetch: over.borosFetch } : {}),
  });
  apps.push(app);
  return {
    jobs,
    transfers,
    store,
    dataDir,
    ready: () => app.ready(),
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'rebalance.json'), 'utf8')) as Job,
    get: (url: string) => app.inject({ method: 'GET', url, headers: HOST }),
    post: (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: HOST, payload }),
    plan: async (): Promise<EvenPlan> =>
      (await app.inject({ method: 'GET', url: '/api/rebalance', headers: HOST })).json().data.plans.even,
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
      mockGateGet('/positions', { body: HEDGED_POSITIONS }),
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
      ['coin', 'venue', 'cash', 'upnl', 'equity', 'borrow', 'imHeldUsd', 'mmHeldUsd', 'interestPaidUsd', 'interestPerDayUsd', 'ratePerYear'].sort(),
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
    // Five rounds save cents over Convert, not worth their minutes.
    expect(plan).toMatchObject({ balanced: false, noLegs: false, recommended: 'convert' });
    expect(plan.routes.loop!.steps.every((step) => step.from === 'CROSSEX' && step.to === 'HYPERLIQUID')).toBe(true);
  });

  it('splits equity by position size across the Gate, Hyperliquid and Lighter wallets', async () => {
    mockView({ account: lighterAccount, positions: THREE_WALLET_POSITIONS });
    const h = boot();

    const plan = await h.plan();

    expect(plan).toMatchObject({ balanced: false, noLegs: false });
    expect(plan.split).toEqual([
      { coin: 'USDT', venue: 'CROSSEX', notionalUsd: 500, share: 0.5 },
      { coin: 'USDC', venue: 'HYPERLIQUID', notionalUsd: 250, share: 0.25 },
      { coin: 'USDC', venue: 'LIGHTER', notionalUsd: 250, share: 0.25 },
    ]);
    expect(plan.routes.loop!.steps.map(({ from, to, kind, move, arrives }) => ({ from, to, kind, move, arrives }))).toEqual([
      { from: 'CROSSEX', to: 'HYPERLIQUID', kind: 'round', move: 999.72, arrives: 999.67 },
      { from: 'CROSSEX', to: 'LIGHTER', kind: 'round', move: 1000.7, arrives: 999.67 },
    ]);
  });

  it('abandoned job keeps inTransit', async () => {
    mockView();
    const h = boot();
    const plan = await h.plan();
    const job = newJob(
      {
        route: 'loop',
        steps: plan.routes.loop!.steps,
        amount: plan.moves,
        costUsd: plan.routes.loop!.costUsd,
        target: plan.routes.loop!.after,
        userId: '1',
      },
      t,
    );
    for (const step of job.steps.slice(0, 8)) Object.assign(step, { status: 'done', qty: step.planned });
    Object.assign(job, { status: 'abandoned', stepIndex: 8, fundsAt: 'SPOT' });
    h.jobs.write(job);

    const { data } = await h.view();

    expect(data.job).toMatchObject({ id: job.id, status: 'abandoned' });
    expect(data.job.inTransit).toEqual({ coin: 'USDC', qty: 36.58, at: 'SPOT' });
  });

  it('a Gate error on the rebalance card reads as a plain sentence', async () => {
    gate().get(`${API}/crossex/accounts`).query(true).reply(401, { label: 'INVALID_KEY', message: 'Invalid key' });
    const h = boot();

    const res = await h.get('/api/rebalance');

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.message).toBe('Gate refused the API key.');
    expect(error.hint).toBe('Check it in Settings.');
    expect(error.category).toBe('auth');
  });
});

describe('GET /api/account', () => {
  it("a Gate error on another route keeps Gate's status and label", async () => {
    gate().get(`${API}/crossex/accounts`).query(true).reply(401, { label: 'INVALID_KEY', message: 'Invalid key' });
    const h = boot();

    const res = await h.get('/api/account');

    expect(res.statusCode).toBe(401);
    const { error } = res.json();
    expect(error.message).toBe('Gate API error (HTTP 401) [INVALID_KEY]: Invalid key');
    expect(error.hint).toBe('Check the Gate API key and secret in Settings.');
  });
});

describe('POST /api/rebalance', () => {
  it('starts the picked route', async () => {
    mockView();
    refuseSends();
    const h = boot();
    const plan = await h.plan();
    expect(plan.recommended).toBe('convert');

    const res = await h.post('/api/rebalance', { route: 'convert', costUsd: plan.routes.convert.costUsd });

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

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: plan.routes.loop!.costUsd, amount: 5 });

    expect(res.statusCode).toBe(202);
    expect(h.file().amount).toBe(movedBy(plan.routes.loop!.steps));
    expect(h.file().amount).not.toBe(5);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('refuses a blocked route', async () => {
    mockView({ disabled: '1' });
    const h = boot();

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Gate paused USDC transfers.');
    expect(() => h.file()).toThrow();
  });

  it('refuses while a transfer moves', async () => {
    const h = boot();
    await h.ready();
    h.transfers.write(newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, t));

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Rebalance waits until the transfer ends.');
    expect(() => h.file()).toThrow();
  });

  it('refuses when balanced', async () => {
    mockView({ account: balancedAccount });
    const h = boot();

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Already even.');
    expect(() => h.file()).toThrow();
  });

  it('refuses with no open positions', async () => {
    mockView({ account: lighterAccount, positions: [] });
    const h = boot();

    const plan = await h.plan();
    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: 0 });

    expect(plan).toMatchObject({ balanced: true, noLegs: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('No open positions. Nothing to rebalance.');
    expect(() => h.file()).toThrow();
  });

  it('starts one job that moves into both Hyperliquid and Lighter', async () => {
    mockView({ account: lighterAccount, positions: THREE_WALLET_POSITIONS });
    refuseSends();
    const h = boot();
    const plan = await h.plan();

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: plan.routes.loop!.costUsd });

    expect(res.statusCode).toBe(202);
    expect(h.file().steps.map(({ name, round, from, to }) => [name, round, from, to])).toEqual([
      ['Buy USDC', 1, 'CROSSEX', 'HYPERLIQUID'],
      ['To spot', 1, 'CROSSEX', 'HYPERLIQUID'],
      ['To Hyperliquid', 1, 'CROSSEX', 'HYPERLIQUID'],
      ['Buy USDC', 2, 'CROSSEX', 'LIGHTER'],
      ['To spot', 2, 'CROSSEX', 'LIGHTER'],
      ['To Lighter', 2, 'CROSSEX', 'LIGHTER'],
    ]);
    expect(h.file()).toMatchObject({ amount: 2000.42, fundsAt: 'CROSSEX' });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('refuses a route with no steps', async () => {
    mockView();
    planEdit.dropConvertSteps = true;
    const h = boot();
    const plan = await h.plan();
    expect(plan).toMatchObject({ balanced: false, routes: { convert: { available: true, steps: [] } } });

    const res = await h.post('/api/rebalance', { route: 'convert', costUsd: plan.routes.convert.costUsd });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Already even.');
    expect(() => h.file()).toThrow();
  });

  it('refuses every route when the sending wallet has no cash', async () => {
    mockView({ account: noCashAccount });
    const h = boot();

    for (const route of ['convert', 'loop', 'mix']) {
      const res = await h.post('/api/rebalance', { route, costUsd: 0 });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('Already even.');
    }
    expect(() => h.file()).toThrow();
  });

  it('starts the full Spot loop when posted beside the recommended capped mix', async () => {
    const assets = [
      asset('USDT', 'CROSSEX', { balance: '-612.35', equity: '-612.35', liability: '612.35', borrowing_initial_margin: '61.24' }),
      asset('USDC', 'HYPERLIQUID', { balance: '1842.16', available_balance: '1842.16', equity: '1842.16' }),
      asset('USDC', 'GATE'),
    ];
    mockView({ account: { ...lighterAccount, available_margin: '1100', margin_balance: '1229.81', initial_margin: '310', assets } });
    refuseSends();
    const h = boot();
    const plan = await h.plan();
    expect(plan.routes.loop).toMatchObject({ available: true });
    expect(plan.routes.mix).toMatchObject({ available: true });
    expect(plan.routes.mix!.costUsd).toBeLessThanOrEqual(plan.routes.loop!.costUsd);
    expect(plan.recommended).toBe('mix');

    const res = await h.post('/api/rebalance', { route: 'loop', costUsd: plan.routes.loop!.costUsd });

    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({ route: 'loop', goal: 'even' });
  });

  it('refuses a capped loop post as a changed plan when the fresh plan offers only the full Spot loop', async () => {
    mockView();
    refuseSends();
    const h = boot();
    const plan = await h.plan();
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ available: true });

    const res = await h.post('/api/rebalance', { route: 'mix', costUsd: plan.routes.loop!.costUsd });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT });
    expect(() => h.file()).toThrow();
  });

  it.each([
    ['no cost', { route: 'convert' }],
    ['a null cost', { route: 'convert', costUsd: null }],
    ['a cost sent as text', { route: 'convert', costUsd: '0.46' }],
    ['a negative cost', { route: 'convert', costUsd: -0.01 }],
    ['a cost that is not a number', { route: 'convert', costUsd: 'NaN' }],
  ])('asks a page from before the update to reload when the post carries %s', async (_, payload) => {
    mockView();
    refuseSends();
    const h = boot();

    const res = await h.post('/api/rebalance', payload);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ category: 'validation', message: RELOAD_TEXT, retryable: true });
    expect(() => h.file()).toThrow();
  });

  it.each([
    ['$0.46', 0.46, 1.46, 1.47, 0.23],
    ['$5', 5, 6, 6.01, 2.5],
    ['$20.10', 20.1, 21.1, 21.11, 10.05],
    ['$4,000', 4000, 4200, 4200.01, 2000],
    ['$12,000', 12000, 12600, 12600.01, 6000],
  ])('at a %s shown cost, runs a fresh cost at the limit or lower and refuses one cent over', async (_, shown, limit, over, lower) => {
    mockView();
    refuseSends();

    for (const fresh of [limit, lower]) {
      planEdit.convertCost = fresh;
      const h = boot();
      const res = await h.post('/api/rebalance', { route: 'convert', costUsd: shown });

      expect(res.statusCode, `fresh cost ${fresh}`).toBe(202);
      expect(h.file()).toMatchObject({ route: 'convert', costUsd: fresh });
      await waitFor(() => h.file().status === 'halted', 'the halt');
    }

    planEdit.convertCost = over;
    const h = boot();
    const res = await h.post('/api/rebalance', { route: 'convert', costUsd: shown });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({
      category: 'validation',
      label: 'PLAN_CHANGED',
      message: PLAN_CHANGED_TEXT,
      retryable: true,
    });
    expect(() => h.file()).toThrow();
  });

  it('starts a Spot loop that costs more than Convert, and still refuses a mix that is Convert in disguise', async () => {
    const assets = [
      asset('USDT', 'CROSSEX', { balance: '40', available_balance: '40', equity: '40' }),
      asset('USDC', 'HYPERLIQUID'),
      asset('USDC', 'GATE'),
    ];
    mockView({
      account: { ...lighterAccount, available_margin: '40', margin_balance: '40', assets },
      positions: HEDGED_POSITIONS,
    });
    const h = boot();
    const plan = await h.plan();
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ available: true });
    expect(plan.routes.loop!.costUsd).toBeGreaterThan(plan.routes.convert.costUsd);
    expect(plan.recommended).toBe('convert');

    const mix = await h.post('/api/rebalance', { route: 'mix', costUsd: 0 });
    expect(mix.statusCode).toBe(409);
    expect(mix.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT });
    expect(() => h.file()).toThrow();

    const loop = await h.post('/api/rebalance', { route: 'loop', costUsd: plan.routes.loop!.costUsd });
    expect(loop.statusCode).toBe(202);
    expect(h.file()).toMatchObject({ route: 'loop' });
  });

  it('one of two rebalance posts', async () => {
    mockView({ accountDelayMs: 50 });
    refuseSends();
    const h = boot();
    const shown = { route: 'loop', costUsd: (await h.plan()).routes.loop!.costUsd };

    const [first, second] = await Promise.all([h.post('/api/rebalance', shown), h.post('/api/rebalance', shown)]);

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

  it('resume refuses while a transfer moves', async () => {
    const convert: PlannedStep = { round: null, kind: 'convert', buy: 0, move: 12, arrives: 11.97, borrowLeft: 0, seconds: 0, from: 'CROSSEX', to: 'HYPERLIQUID' };
    const job = newJob({ route: 'convert', steps: [convert], amount: 12, costUsd: 0, target: [], userId: null }, t);
    Object.assign(job, { status: 'halted', haltReason: 'Gate took too long on this step.' });
    const h = boot({ job });
    await h.ready();
    h.transfers.write(newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, t));

    const res = await h.post(`/api/rebalance/${job.id}/resume`);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Rebalance waits until the transfer ends.');
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: 'Gate took too long on this step.' });
  });
});

describe('GET /api/rebalance prices a $6,000,000 Spot loop from the order book', () => {
  const whaleAccount = {
    user_id: '1',
    available_margin: '10800000',
    margin_balance: '12000000',
    initial_margin: '1200000',
    account_mode: 'CROSS_EXCHANGE',
    assets: [
      asset('USDT', 'CROSSEX', { balance: '12000000', available_balance: '12000000', equity: '12000000' }),
      asset('USDC', 'HYPERLIQUID'),
      asset('USDC', 'GATE'),
    ],
  };
  const whalePositions = [
    { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', position_side: 'NONE', position_qty: '-2400', position_value: '6000000', mark_price: '2500' },
    { symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'NONE', position_qty: '2400', position_value: '6000000', mark_price: '2500' },
  ];
  const bookBody = JSON.parse(
    readFileSync(path.resolve(__dirname, '../fixtures/gate/spot-order-book-usdc-usdt.json'), 'utf8'),
  ) as unknown;

  it('shows a higher loop cost with the book read than with the book read failing, and a failed read is not stale', async () => {
    mockView({ account: whaleAccount, positions: whalePositions });
    const bookRead = gate()
      .get(`${API}/spot/order_book`)
      .query((q) => q.currency_pair === 'USDC_USDT' && q.limit === '100')
      .reply(200, bookBody as nock.Body);
    const booked = await boot().view();
    const failedRead = gate().get(`${API}/spot/order_book`).query(true).reply(500, { label: 'SERVER_ERROR', message: 'server error' });
    const failed = await boot().view();

    expect(bookRead.isDone()).toBe(true);
    expect(failedRead.isDone()).toBe(true);
    const bookedLoop = (booked.data.plans.even as EvenPlan).routes.loop!;
    const failedLoop = (failed.data.plans.even as EvenPlan).routes.loop!;
    expect(movedBy(bookedLoop.steps)).toBeGreaterThan(5_990_000);
    expect(movedBy(failedLoop.steps)).toBeGreaterThan(5_990_000);
    expect(bookedLoop.costUsd).toBeGreaterThan(failedLoop.costUsd + 1_000);
    expect(booked.meta?.stale).toBeUndefined();
    expect(failed.meta?.stale).toBeUndefined();
  });

  it('prices from the top of the book, not the old book, when Gate rate-limits the book read', async () => {
    mockView({ account: whaleAccount, positions: whalePositions });
    gate().get(`${API}/spot/order_book`).query(true).reply(500, { label: 'SERVER_ERROR', message: 'server error' });
    const topLoop = ((await boot().view()).data.plans.even as EvenPlan).routes.loop!;
    const h = boot();
    gate().get(`${API}/spot/order_book`).query(true).reply(200, bookBody as nock.Body);
    const bookedLoop = ((await h.view()).data.plans.even as EvenPlan).routes.loop!;
    const limited = gate()
      .get(`${API}/spot/order_book`)
      .query(true)
      .reply(429, { label: 'TOO_MANY_REQUESTS', message: 'too many requests' });
    const later = Date.now() + 5_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const again = await h.view();
      const againLoop = (again.data.plans.even as EvenPlan).routes.loop!;

      expect(limited.isDone()).toBe(true);
      expect(bookedLoop.costUsd).toBeGreaterThan(topLoop.costUsd + 1_000);
      expect(againLoop.costUsd).toBe(topLoop.costUsd);
      expect(again.meta?.stale).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('POST /api/rebalance with a close and reopen', () => {
  const HL_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
  const owner = ownerBook();

  const wireAccount = (account: AccountLike) => ({
    user_id: '1',
    available_margin: account.availableMargin,
    margin_balance: account.marginBalance,
    initial_margin: account.initialMargin,
    account_mode: 'CROSS_EXCHANGE',
    assets: (account.assets ?? []).map((a) =>
      asset(a.coin ?? '', a.exchangeType ?? '', {
        balance: a.balance ?? '0',
        available_balance: a.availableBalance ?? '0',
        upnl: a.upnl ?? '0',
        equity: a.equity ?? '0',
        liability: a.liability ?? '0',
        borrowing_initial_margin: a.borrowingInitialMargin,
        borrowing_maintenance_margin: a.borrowingMaintenanceMargin,
      }),
    ),
  });

  const wirePosition = (perp: RealizePerp) => ({
    symbol: perp.symbol,
    position_side: 'NONE',
    position_qty: perp.positionQty,
    position_value: String(Math.abs(Number(perp.positionQty)) * Number(perp.markPrice)),
    entry_price: perp.entryPrice,
    mark_price: perp.markPrice,
    initial_margin: perp.initialMargin,
    upnl: String(Number(perp.positionQty) * (Number(perp.markPrice) - Number(perp.entryPrice))),
  });

  const OWNER_RATES = [
    { coin: 'USDT', exchange_type: 'CROSSEX', hour_interest_rate: String(0.0596 / 8760), time: String(Date.now()) },
    { coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: String(0.05 / 8760), time: String(Date.now()) },
  ];

  const THIN_HL_ETH: NormalizedBook = { bids: [[1811, 1000]], asks: [[1831, 1000]], ts: 0 };

  function mockOwnerBook(book: NormalizedBook = OWNER_HL_ETH, view: { accountDelayMs?: number } = {}): void {
    mockView({
      account: wireAccount(owner.account),
      positions: owner.spec.perps.map(wirePosition),
      rates: OWNER_RATES,
      ...view,
    });
    const levels = (side: Array<[number, number]>) => side.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }));
    nock('https://api.hyperliquid.xyz')
      .persist()
      .post('/info', (body) => body.type === 'l2Book' && body.coin === 'ETH')
      .reply(200, { coin: 'ETH', levels: [levels(book.bids), levels(book.asks)] });
  }

  function refuseQuotes(): void {
    gate().persist().post(`${API}/crossex/convert/quote`).query(true).reply(400, REFUSAL);
  }

  const shownOf = (plan: EvenPlan) => {
    const route = plan.routes[plan.recommended ?? 'convert']!;
    const legs = plan.realize?.legs ?? [];
    const fees = legs.reduce((total, leg) => total + leg.closeFeeUsd + leg.reopenFeeUsd + (leg.convert?.feeUsd ?? 0), 0);
    const impact = legs.reduce((total, leg) => total + leg.closeImpactUsd + leg.reopenImpactUsd, 0);
    return {
      route: plan.recommended ?? 'convert',
      costUsd: route.costUsd + fees + Math.max(0, impact),
      realizeQty: legs.map((leg) => ({ symbol: leg.symbol, qty: leg.qty })),
    };
  };

  const OWNER_MARK = 1_821;
  const ownerAccount = (): RealizeBook =>
    realizeBook({
      usdt: { cash: -7_169.33, upnl: 0 },
      usdc: { cash: 55.98, upnl: 66 * (2_100 - OWNER_MARK) },
      availableMargin: 2_000,
      perps: [perp(HL_ETH, -66, 2_100, OWNER_MARK), perp('GATE_FUTURE_ETH_USDT', 66, OWNER_MARK, OWNER_MARK)],
      books: { [HL_ETH]: OWNER_HL_ETH, GATE_FUTURE_ETH_USDT: GATE_ETH },
      notionalUsd: 66 * OWNER_MARK,
    });

  function mockAccount(book: RealizeBook): void {
    mockView({ account: wireAccount(book.account), positions: book.spec.perps.map(wirePosition), rates: OWNER_RATES });
    const levels = (side: Array<[number, number]>) => side.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }));
    nock('https://api.hyperliquid.xyz')
      .persist()
      .post('/info', (body) => body.type === 'l2Book' && body.coin === 'ETH')
      .reply(200, { coin: 'ETH', levels: [levels(OWNER_HL_ETH.bids), levels(OWNER_HL_ETH.asks)] });
  }

  function mockGateEthBook(): void {
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
  }

  const DELEVER_ASK = {
    perps: [
      { symbol: HL_ETH, qty: 100 },
      { symbol: 'GATE_FUTURE_ETH_USDT', qty: 100 },
    ],
    boros: [],
    exec: 'maker',
  };

  it('full plan priced at limit + hedge', async () => {
    mockAccount(ownerAccount());
    const h = boot();

    const res = await h.get('/api/rebalance');

    expect(res.statusCode).toBe(200);
    const { fullPlan, realize, imUsed, plans } = res.json().data;
    expect(fullPlan.costUsd).toBeGreaterThanOrEqual(40);
    expect(fullPlan.costUsd).toBeLessThanOrEqual(42);
    expect(fullPlan).toMatchObject({ days: 36, clearsBorrow: true, needsRealize: true });
    expect(realize.clearDebt.legs[0]).toMatchObject({ symbol: HL_ETH, side: 'SHORT' });
    expect(imUsed).toEqual([{ account: 'CROSSEX', pct: expect.any(Number) }]);
    expect(plans.repay.realize).toBeNull();
  });

  it('a custom slice size gets its own slice row', async () => {
    mockAccount(ownerAccount());
    const h = boot();

    const res = await h.get('/api/rebalance?sliceUsd=30000');

    expect(res.statusCode).toBe(200);
    expect(res.json().data.realize.sliceOptions).toContainEqual(expect.objectContaining({ sizeUsd: 30_000, custom: true }));
  });

  it('a realize job is rebuilt from realizeUsd and ignores sent leg sizes', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;
    const plan = realize.clearDebt;

    const res = await h.post('/api/rebalance', {
      kind: 'realize',
      realizeTarget: 'clear-debt',
      exec: 'maker',
      costUsd: plan.estimates.maker.totalUsd,
      realizeQty: [{ symbol: HL_ETH, qty: 999 }],
    });

    expect(res.statusCode).toBe(202);
    const job = h.file();
    expect(job).toMatchObject({ kind: 'realize', exec: 'maker', slice: { index: 1, sizeUsd: realize.defaultSliceUsd } });
    expect(job.realize!.legs.map((leg) => leg.qty)).toEqual(plan.legs.map((leg: RealizeLeg) => leg.qty));
    expect(job.steps.map((step) => step.name)).toContain('Slices');
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a Limit + hedge realize keeps the maker settings it is sent, and fills the defaults when none are sent', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;
    const costUsd = realize.clearDebt.estimates.maker.totalUsd;
    const ask = { kind: 'realize', realizeTarget: 'clear-debt', exec: 'maker', costUsd };

    const res = await h.post('/api/rebalance', { ...ask, maker: { takerAfterSec: 600, repegBehindBp: 2 } });

    expect(res.statusCode).toBe(202);
    expect(h.file().maker).toEqual({ takerAfterSec: 600, repegBehindBp: 2 });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a realize refuses a wait before taker outside 30s to 24h, and Market keeps no maker settings', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;
    const ask = { kind: 'realize', realizeTarget: 'clear-debt', costUsd: realize.clearDebt.estimates.maker.totalUsd };

    const short = await h.post('/api/rebalance', { ...ask, exec: 'maker', maker: { takerAfterSec: 10, repegBehindBp: 5 } });
    const repeg = await h.post('/api/rebalance', { ...ask, exec: 'maker', maker: { takerAfterSec: 300, repegBehindBp: 3 } });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.message).toBe('Taker after must be 30s to 24h.');
    expect(repeg.statusCode).toBe(400);

    const market = await h.post('/api/rebalance', { ...ask, exec: 'market', costUsd: realize.clearDebt.estimates.market.totalUsd, maker: { takerAfterSec: 600, repegBehindBp: 2 } });
    expect(market.statusCode).toBe(202);
    expect(h.file().maker ?? null).toBeNull();
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a realize job needs the picked target', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;

    const bare = await h.post('/api/rebalance', { kind: 'realize', exec: 'maker', costUsd: realize.clearDebt.estimates.maker.totalUsd });
    const custom = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'custom', exec: 'maker', costUsd: 1 });

    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.message).toBe('Pick Clear debt, All or Custom before you realize.');
    expect(custom.statusCode).toBe(400);
    expect(custom.json().error.message).toBe('Enter the Custom amount before you realize.');
    expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);

    const all = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'all', exec: 'maker', costUsd: realize.all.estimates.maker.totalUsd });

    expect(all.statusCode).toBe(202);
    expect(h.file().realize!.legs.map((leg) => leg.qty)).toEqual(realize.all.legs.map((leg: RealizeLeg) => leg.qty));
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a realize for a wallet with no uPnL is refused, and a wallet name the app does not know is a 400', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;
    expect(realize.pools).toEqual(['HYPERLIQUID']);

    const view = await h.get('/api/rebalance?realizePool=LIGHTER');
    const bad = await h.get('/api/rebalance?realizePool=BINANCE');
    const start = await h.post('/api/rebalance', {
      kind: 'realize', realizeTarget: 'all', realizePool: 'LIGHTER', exec: 'maker', costUsd: realize.all.estimates.maker.totalUsd,
    });

    expect(view.json().data.realize.pool).toBe('HYPERLIQUID');
    expect(bad.statusCode).toBe(400);
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: 'This wallet has no uPnL to realize now. Pick another wallet.' });
    expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);

    const own = await h.post('/api/rebalance', {
      kind: 'realize', realizeTarget: 'all', realizePool: 'HYPERLIQUID', exec: 'maker', costUsd: realize.all.estimates.maker.totalUsd,
    });
    expect(own.statusCode).toBe(202);
    expect(h.file().realize!.legs.every((leg) => leg.pool === 'HYPERLIQUID')).toBe(true);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('realize cost counts in plan changed', async () => {
    mockAccount(ownerAccount());
    const h = boot();
    const plan = (await h.view()).data.realize.clearDebt;

    const res = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'clear-debt', exec: 'market', costUsd: plan.estimates.maker.totalUsd / 2 });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT });
    expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);
  });

  it('a move job carries no realize', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    refuseQuotes();
    const h = boot();
    const plan = (await h.view()).data.plans.repay as EvenPlan;
    const route = plan.recommended ?? 'convert';

    const res = await h.post('/api/rebalance', { goal: 'repay', route, costUsd: plan.routes[route]!.costUsd });

    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({ kind: 'move', realize: null });
    expect(h.file().steps.map((step) => step.name)).not.toContain('Slices');
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('delever clamps to the position', async () => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    refuseSends();
    const h = boot();

    const planned = await h.post('/api/rebalance/delever/plan', DELEVER_ASK);

    expect(planned.statusCode).toBe(200);
    const plan = planned.json().data;
    for (const leg of plan.legs) expect(leg.closeQty).toBeLessThanOrEqual(66);

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: DELEVER_ASK });

    expect(res.statusCode).toBe(202);
    const job = h.file();
    expect(job.kind).toBe('delever');
    for (const leg of job.delever!.legs) expect(leg.before - leg.after).toBeLessThanOrEqual(66);
    expect(job.imUsedStart).toEqual([{ account: 'CROSSEX', pct: plan.imUsed[0].before }]);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a delever job starts with the plan IM used at end', async () => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    refuseSends();
    const h = boot();
    const plan = (await h.post('/api/rebalance/delever/plan', DELEVER_ASK)).json().data;

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: DELEVER_ASK });

    expect(res.statusCode).toBe(202);
    expect(plan.imUsed[0].after).toBeLessThan(plan.imUsed[0].before);
    expect(h.file().imUsedEnd).toEqual([{ account: 'CROSSEX', pct: plan.imUsed[0].after }]);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it.each(['market', 'maker'] as const)('a delever with TWAP off starts one order in the picked mode (%s)', async (exec) => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    refuseSends();
    const h = boot();
    const plan = (await h.post('/api/rebalance/delever/plan', DELEVER_ASK)).json().data;
    const res = await h.post('/api/rebalance', { kind: 'delever', exec, costUsd: plan.estimates[exec].totalUsd, delever: DELEVER_ASK });
    expect(res.statusCode).toBe(202);
    expect(h.file()).toMatchObject({ exec, slice: { count: 1 } });
    expect(h.file().deleverTwap ?? null).toBeNull();
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  const DELEVER_TWAP = { durationSec: 3600, slices: 12 };

  it('delever plan with twap', async () => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    const h = boot();

    const res = await h.post('/api/rebalance/delever/plan', { ...DELEVER_ASK, twap: DELEVER_TWAP });

    expect(res.statusCode, res.body).toBe(200);
    const { twap, priceImpact, legs, makerLeg } = res.json().data;
    expect(twap.refusal).toBeNull();
    expect(twap.plan).toMatchObject({ slices: 12, intervalSec: 300, durationSec: 3600 });
    const lots = Number(twap.plan.sliceQty) * 11 + Number(twap.plan.lastQty);
    expect(lots).toBeCloseTo(legs[makerLeg].closeQty, 8);
    expect(twap.price).toBeGreaterThan(0);
    expect(priceImpact.sliced).toBeGreaterThanOrEqual(0);
    expect(priceImpact.whole === null || priceImpact.whole >= priceImpact.sliced).toBe(true);
  });

  it('delever plan slice past the book', async () => {
    const book = ownerAccount();
    mockView({ account: wireAccount(book.account), positions: book.spec.perps.map(wirePosition), rates: OWNER_RATES });
    nock('https://api.hyperliquid.xyz')
      .persist()
      .post('/info', (body) => body.type === 'l2Book' && body.coin === 'ETH')
      .reply(200, { coin: 'ETH', levels: [[{ px: '1820.9', sz: '2', n: 1 }], [{ px: '1821.1', sz: '2', n: 1 }]] });
    mockGateEthBook();
    const h = boot();

    const res = await h.post('/api/rebalance/delever/plan', { ...DELEVER_ASK, twap: DELEVER_TWAP });

    expect(res.statusCode, res.body).toBe(200);
    const { twap } = res.json().data;
    expect(twap.refusal.text).toMatch(/^Book too thin for [\d.]+ ETH a slice\.$/);
    expect(twap.refusal.fix.label).toBe('Use 1m 49s interval');
    expect(twap.refusal.fix.patch).toMatchObject({ durationSec: 3600, intervalSec: 109 });
  });

  async function deleverPlanAt(usd: number) {
    const qty = Math.max(0.02, Math.floor((usd / OWNER_MARK) * 100) / 100);
    const half = Math.floor((qty / 2) * 100) / 100;
    const deep: NormalizedBook = { bids: [[1_820.9, 100_000]], asks: [[1_821.1, 100_000]], ts: 0 };
    const book = realizeBook({
      usdt: { cash: usd * 0.5, upnl: 0 },
      usdc: { cash: usd * 0.5, upnl: 0 },
      availableMargin: usd * 0.6,
      perps: [perp(HL_ETH, -qty, OWNER_MARK, OWNER_MARK), perp('GATE_FUTURE_ETH_USDT', qty, OWNER_MARK, OWNER_MARK)],
      books: { [HL_ETH]: deep, GATE_FUTURE_ETH_USDT: deep },
      notionalUsd: qty * OWNER_MARK,
    });
    mockView({ account: wireAccount(book.account), positions: book.spec.perps.map(wirePosition), rates: OWNER_RATES });
    const levels = (side: Array<[number, number]>) => side.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }));
    nock('https://api.hyperliquid.xyz')
      .persist()
      .post('/info', (body) => body.type === 'l2Book' && body.coin === 'ETH')
      .reply(200, { coin: 'ETH', levels: [levels(deep.bids), levels(deep.asks)] });
    mockGateEthBook();
    refuseSends();
    const h = boot();
    const ask = { ...DELEVER_ASK, perps: DELEVER_ASK.perps.map((leg) => ({ ...leg, qty: half })) };
    const planned = await h.post('/api/rebalance/delever/plan', ask);
    expect(planned.statusCode).toBe(200);
    return { h, ask, half, plan: planned.json().data };
  }

  it.each([50, 5_000, 100_000, 1_000_000, 6_000_000])('a delever start of %d USD closes in one order and sizes IM used from the plan', async (usd) => {
    const { h, ask, half, plan } = await deleverPlanAt(usd);

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: ask });

    expect(res.statusCode).toBe(202);
    const job = h.file();
    const closeUsd = half * OWNER_MARK;
    for (const leg of job.delever!.legs) expect(leg.before - leg.after).toBeCloseTo(half, 8);
    expect(job.slice!.count).toBe(1);
    expect(job.slice!.sizeUsd).toBeGreaterThanOrEqual(closeUsd);
    expect(plan.notHedgedMaxQty).toBeCloseTo(half, 8);
    expect(job.costUsd).toBeGreaterThan(0);
    expect(job.costUsd).toBeLessThan(closeUsd * 0.01);
    expect(job.imUsedEnd![0].pct).toBeLessThanOrEqual(job.imUsedStart![0].pct);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it.each([50, 5_000, 100_000, 1_000_000, 6_000_000])('a delever start refuses a cost rise past max($1, 5%%) at %d USD', async (usd) => {
    const { h, ask, plan } = await deleverPlanAt(usd);
    const fresh = Math.round(plan.estimates.maker.totalUsd * 100);
    const passCents = fresh >= 2100 ? Math.ceil((fresh * 20) / 21) : Math.max(0, fresh - 100);
    const start = (cents: number) => h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: cents / 100, delever: ask });

    if (passCents > 0) {
      const refused = await start(passCents - 1);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT });
      expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);
    }
    const passed = await start(passCents);
    expect(passed.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it.each([100, 6_000_000])('a delever TWAP start at %d USD keeps the taker-after and re-peg it was sent', async (usd) => {
    const { h, ask, plan } = await deleverPlanAt(usd);
    const twap = { durationSec: 3600, slices: 2, takerAfterSec: 600, repegBehindBp: 2 };

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: { ...ask, twap } });

    expect(res.statusCode, res.body).toBe(202);
    expect(h.file().deleverTwap).toEqual({ durationSec: 3600, intervalSec: 1800, slices: 2, takerAfterSec: 600, repegBehindBp: 2 });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it.each([100_000, 6_000_000])('a delever TWAP plan at %d USD prices the TWAP slices, not one order', async (usd) => {
    const { h, ask, plan } = await deleverPlanAt(usd);
    const twap = { durationSec: 3600, slices: 4 };

    const planned = await h.post('/api/rebalance/delever/plan', { ...ask, twap });

    expect(planned.statusCode, planned.body).toBe(200);
    const twapped = planned.json().data;
    expect(twapped.twap.plan.slices).toBe(4);
    expect(twapped.notHedgedMaxQty).toBeCloseTo(Math.max(Number(twapped.twap.plan.sliceQty), Number(twapped.twap.plan.lastQty)), 8);
    for (const exec of ['maker', 'market'] as const) {
      expect(twapped.estimates[exec].feePerpsUsd).toBeCloseTo(plan.estimates[exec].feePerpsUsd, 6);
      expect(twapped.estimates[exec].impactUsd).toBeLessThanOrEqual(plan.estimates[exec].impactUsd);
    }
    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'market', costUsd: twapped.estimates.market.totalUsd, delever: { ...ask, twap } });
    expect(res.statusCode, res.body).toBe(202);
    expect(h.file().costUsd).toBeCloseTo(twapped.estimates.market.totalUsd, 6);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a delever with TWAP off keeps the maker settings it is sent; with TWAP on the TWAP keeps its own', async () => {
    const { h, ask, plan } = await deleverPlanAt(5_000);
    const maker = { takerAfterSec: null, repegBehindBp: 10 };

    const off = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: ask, maker });
    expect(off.statusCode, off.body).toBe(202);
    expect(h.file().maker).toEqual(maker);
    expect(h.file().deleverTwap ?? null).toBeNull();
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a delever TWAP start ignores a top-level maker setting', async () => {
    const { h, ask, plan } = await deleverPlanAt(5_000);
    const twap = { durationSec: 3600, slices: 2, takerAfterSec: 600, repegBehindBp: 2 };

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: { ...ask, twap }, maker: { takerAfterSec: 10, repegBehindBp: 5 } });

    expect(res.statusCode, res.body).toBe(202);
    expect(h.file().maker ?? null).toBeNull();
    expect(h.file().deleverTwap).toMatchObject({ takerAfterSec: 600, repegBehindBp: 2 });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a delever TWAP start with Never and re-peg off keeps both', async () => {
    const { h, ask, plan } = await deleverPlanAt(5_000);
    const twap = { durationSec: 3600, slices: 2, takerAfterSec: null, repegBehindBp: null };

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: { ...ask, twap } });

    expect(res.statusCode, res.body).toBe(202);
    expect(h.file().deleverTwap).toMatchObject({ takerAfterSec: null, repegBehindBp: null });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it.each([
    ['a taker-after past 80% of the interval', { takerAfterSec: 1441 }],
    ['a taker-after under 30 s', { takerAfterSec: 29 }],
    ['a re-peg of 3 bp', { repegBehindBp: 3 }],
  ])('a delever TWAP start refuses %s and writes no job', async (_name, over) => {
    const { h, ask, plan } = await deleverPlanAt(5_000);
    const twap = { durationSec: 3600, slices: 2, ...over };

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: { ...ask, twap } });

    expect(res.statusCode, res.body).toBe(400);
    expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);
  });

  it('a delever plan with no Boros leg sends no Boros close', async () => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    const h = boot();

    const res = await h.post('/api/rebalance/delever/plan', { ...DELEVER_ASK, twap: DELEVER_TWAP });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ borosCloses: 0, borosGasUsd: 0 });
  });

  const SHALLOW_HL_ETH: NormalizedBook = { bids: [[1_820.9, 20]], asks: [[1_821.1, 20]], ts: 0 };

  function mockShallowHlBook(): void {
    const book = ownerAccount();
    mockView({ account: wireAccount(book.account), positions: book.spec.perps.map(wirePosition), rates: OWNER_RATES });
    const levels = (side: Array<[number, number]>) => side.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }));
    nock('https://api.hyperliquid.xyz')
      .persist()
      .post('/info', (body) => body.type === 'l2Book' && body.coin === 'ETH')
      .reply(200, { coin: 'ETH', levels: [levels(SHALLOW_HL_ETH.bids), levels(SHALLOW_HL_ETH.asks)] });
  }

  it('a realize start at a slice past the book is refused, and a slice inside the book starts', async () => {
    mockShallowHlBook();
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;
    const options = realize.sliceOptions as SliceOption[];
    const past = options.find((option) => option.pastBook);
    const inside = options.find((option) => !option.pastBook);
    expect(past).toBeDefined();
    expect(inside).toBeDefined();
    const startAt = async (sliceUsd: number) => {
      const plan = (await h.get(`/api/rebalance?sliceUsd=${sliceUsd}`)).json().data.realize.all;
      return h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'all', exec: 'maker', sliceUsd, costUsd: plan.estimates.maker.totalUsd });
    };

    const refused = await startAt(past!.sizeUsd);

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT });
    expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);

    const started = await startAt(inside!.sizeUsd);

    expect(started.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a delever start at a slice past the book is refused, and a slice inside the book starts', async () => {
    mockShallowHlBook();
    mockGateEthBook();
    refuseSends();
    const h = boot();
    const plan = (await h.post('/api/rebalance/delever/plan', DELEVER_ASK)).json().data;
    const options = plan.sliceOptions as SliceOption[];
    const past = options.find((option) => option.pastBook);
    const inside = options.find((option) => !option.pastBook);
    expect(past).toBeDefined();
    expect(inside).toBeDefined();
    const startAt = (sliceUsd: number) => h.post('/api/rebalance', { kind: 'delever', exec: 'maker', sliceUsd, costUsd: plan.estimates.maker.totalUsd, delever: DELEVER_ASK });

    const refused = await startAt(past!.sizeUsd);

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: PLAN_CHANGED_TEXT });
    expect(existsSync(path.join(h.dataDir, 'rebalance.json'))).toBe(false);

    const started = await startAt(inside!.sizeUsd);

    expect(started.statusCode).toBe(202);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a delever on a thin book refuses one order, and the same close with TWAP on starts', async () => {
    mockShallowHlBook();
    mockGateEthBook();
    refuseSends();
    const h = boot();
    const plan = (await h.post('/api/rebalance/delever/plan', DELEVER_ASK)).json().data;
    expect((plan.sliceOptions as SliceOption[]).find((option) => option.whole)?.pastBook).toBe(true);

    const refused = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: DELEVER_ASK });

    expect(refused.statusCode).toBe(409);
    const twap = { durationSec: 3600, slices: 40 };
    const twapped = (await h.post('/api/rebalance/delever/plan', { ...DELEVER_ASK, twap })).json().data;
    expect(twapped.twap.refusal).toBeNull();
    const started = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: twapped.estimates.maker.totalUsd, delever: { ...DELEVER_ASK, twap } });
    expect(started.statusCode, started.body).toBe(202);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a realize start with Split the close off runs one order', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const { realize } = (await h.view()).data;
    const whole = (realize.sliceOptions as SliceOption[]).find((option) => option.whole)!;
    expect(whole.count).toBe(1);
    const plan = (await h.get(`/api/rebalance?sliceUsd=${whole.sizeUsd}`)).json().data.realize.all;

    const res = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'all', exec: 'maker', sliceUsd: whole.sizeUsd, costUsd: plan.estimates.maker.totalUsd });

    expect(res.statusCode, res.body).toBe(202);
    expect(h.file().slice).toMatchObject({ count: 1, sizeUsd: whole.sizeUsd });
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a realize job amount is the plan realized total', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    const h = boot();
    const plan = (await h.view()).data.realize.clearDebt;
    const gross = plan.legs.reduce((total: number, leg: RealizeLeg) => total + leg.realizedUsd, 0);

    const res = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'clear-debt', exec: 'maker', costUsd: plan.estimates.maker.totalUsd });

    expect(res.statusCode).toBe(202);
    expect(gross).toBeGreaterThan(plan.estimates.maker.totalUsd);
    expect(Math.abs(h.file().amount - gross)).toBeLessThanOrEqual(0.005 + 1e-9);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it.each(['realize', 'delever'] as const)('two %s starts at once make one job', async (kind) => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    refuseSends();
    const h = boot();
    const body =
      kind === 'realize'
        ? { kind, realizeTarget: 'clear-debt', exec: 'maker', costUsd: (await h.view()).data.realize.clearDebt.estimates.maker.totalUsd }
        : { kind, exec: 'maker', costUsd: (await h.post('/api/rebalance/delever/plan', DELEVER_ASK)).json().data.estimates.maker.totalUsd, delever: DELEVER_ASK };

    const [a, b] = await Promise.all([h.post('/api/rebalance', body), h.post('/api/rebalance', body)]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    expect(h.file().kind).toBe(kind);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a running job refuses a realize and a delever start', async () => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    h.jobs.write(slicedJob({ status: 'running' }));

    const realize = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'clear-debt', exec: 'maker', costUsd: 1 });
    const delever = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: 1, delever: DELEVER_ASK });

    expect(realize.statusCode).toBe(409);
    expect(delever.statusCode).toBe(409);
    expect(h.file().id).toBe(slicedJob({}).id);
  });

  const DEAL = { id: 'deal-1', a: { symbol: 'GATE_FUTURE_ETH_USDT' }, b: { symbol: HL_ETH } };

  const slicedJob = (over: Partial<Job>): Job => ({
    ...newJob({ route: 'mix', steps: [], amount: 0, costUsd: 30, target: [], userId: '1', kind: 'delever', delever: DELEVER_JOB, sliceCount: 14, sliceUsd: 25_000 }, t),
    ...over,
  });

  const DELEVER_JOB = {
    makerLeg: 0 as const,
    legs: [
      { symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT' as const, before: 66, after: 33, closeQty: 33 },
      { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', base: 'ETH', side: 'LONG' as const, before: 66, after: 33, closeQty: 33 },
    ],
    boros: [],
  };

  it('delever holds the money lock', async () => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    h.jobs.write(slicedJob({ status: 'running' }));

    const rebalance = await h.post('/api/rebalance', { goal: 'repay', route: 'convert', costUsd: 1 });
    const deal = await h.post('/api/deals', DEAL);

    expect(rebalance.statusCode).toBe(409);
    expect(deal.statusCode).toBe(409);
  });

  describe('a Delever TWAP job', () => {
    const TWAP = { durationSec: 3600, intervalSec: 300, slices: 12 };
    const ETH_MARKET = {
      marketId: 7,
      tokenId: 2,
      imData: { name: 'Hyperliquid ETH 31 Dec 2099', maturity: 4_102_358_400 },
      extConfig: { settleFeeRate: '0', paymentPeriod: 3600 },
      config: { status: 2 },
      platform: { platformId: 'Hyperliquid' },
      metadata: { underlyingSymbol: 'ETH' },
      data: { markApr: 0.07, floatingApr: 0.07, assetMarkPrice: 2400 },
    };
    const marketsBody = (results: unknown[]) => ({ '/apis/v1/markets': { results, total: results.length, skip: 0 } });

    const twapJob = (filled: number, over: Partial<Job> = {}): Job => {
      const delever = { ...DELEVER_JOB, boros: [{ marketId: 7, before: 10, after: 0, closeSize: 10 }] };
      const job: Job = { ...newJob({ route: 'mix', steps: [], amount: 0, costUsd: 30, target: [], userId: '1', kind: 'delever', delever, sliceCount: 12, twap: TWAP }, t), ...over };
      const id = `${job.id}-s1-1`;
      Object.assign(job.steps[0], {
        status: 'running',
        lead: { text: id, venueId: null, sentAt: t, credited: 0, poc: true, price: null, side: 'BUY', mid: 2500, entry: null },
        cut: { qty: filled, from: 0, at: t, ioc: false },
      });
      return job;
    };

    const doneChild = (store: Store, id: string, filled: number): void => {
      const leg = (contract: string, side: 'BUY' | 'SELL') => ({ contract, side, lot: '0.0001', minSize: '0', minNotional: '0', tick: '0.1', reduceOnly: true });
      store.createPair({
        id,
        mode: 'DONE',
        a: leg(HL_ETH, 'BUY'),
        b: leg('GATE_FUTURE_ETH_USDT', 'SELL'),
        targetQty: String(filled),
        limitPrice: '2500',
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
        haltKind: null,
        haltReason: null,
        reportJson: null,
        createdAt: t,
      });
      for (const [side, which] of [['BUY', 'A'], ['SELL', 'B']] as const) {
        const order = store.insertPendingOrder({ pairId: id, leg: which, kind: 'taker', side, qty: String(filled), price: null, tif: 'ioc', now: t });
        store.updateOrder(id, which, order.seq, { state: 'CLOSED', cumQty: String(filled), avgFillPrice: '2500', resolvedAt: t });
      }
    };

    beforeEach(() => {
      process.env.BOROS_ROOT_ADDRESS = '0x00000000000000000000000000000000000000a1';
      vi.mocked(closeBorosLegs).mockReset();
      vi.mocked(closeBorosLegs).mockImplementation(async (_deps, input) => ({ filled: input.legs.map(({ marketId, size }) => ({ marketId, size })), held: [] }) as never);
    });

    afterEach(() => {
      delete process.env.BOROS_ROOT_ADDRESS;
    });

    const heldBoros = (gas: unknown): Record<string, unknown> => ({
      ...marketsBody([ETH_MARKET]),
      '/apis/v1/accounts/market-acc-infos-by-root': {
        results: [
          {
            marketAcc: marketAcc('0x00000000000000000000000000000000000000a1', 2),
            netBalance: raw(20),
            initialMargin: raw(1),
            availableInitialMargin: raw(19),
            positions: [{ marketId: 7, signedSize: raw(10), initialMargin: raw(1), maintMargin: raw(0.5), liquidationApr: raw(0.2), orders: [] }],
          },
        ],
      },
      '/apis/v1/accounts/active-positions': { results: [] },
      ...(gas === undefined ? {} : { '/apis/v1/gas-price/current': gas }),
    });

    it.each([
      ['prices the closes at the Boros gas read', { estimatedOrderGasCostUsd: 0.004 }, 12 * 0.004],
      ['shows no gas figure when the gas read fails', undefined, null],
      ['shows no gas figure when Boros has no estimate', { estimatedOrderGasCostUsd: null }, null],
    ])('a delever TWAP plan with one Boros leg counts one close a slice and %s', async (_name, gas, gasUsd) => {
      mockAccount(ownerAccount());
      mockGateEthBook();
      const h = boot({ borosFetch: borosStub(heldBoros(gas)) });

      const res = await h.post('/api/rebalance/delever/plan', { ...DELEVER_ASK, boros: [{ marketId: 7, size: 10 }], twap: { durationSec: 3600, slices: 12 } });

      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data.boros[0].closeSize).toBeGreaterThan(0);
      expect(data.borosCloses).toBe(12);
      if (gasUsd === null) expect(data.borosGasUsd).toBeNull();
      else expect(data.borosGasUsd).toBeCloseTo(gasUsd, 9);
    });

    it.each([
      ['waits for the $10 floor when the route reads the ETH price', [ETH_MARKET], 0],
      ['closes the Boros share at once when the route has no collateral price', [], 1],
    ])('a slice of 0.01 ETH: the Boros share %s', async (_name, markets, closes) => {
      mockView();
      const h = boot({ borosFetch: borosStub(marketsBody(markets)) });
      await h.ready();
      const job = twapJob(0.01, { status: 'halted', haltReason: 'stopped', pauseRequested: true });
      doneChild(h.store, job.steps[0].lead!.text, 0.01);
      h.jobs.write(job);

      const res = await h.post(`/api/rebalance/${job.id}/resume`);
      expect(res.statusCode).toBe(200);
      await waitFor(() => h.file().paused === true, 'the pause after the slice');

      expect(vi.mocked(closeBorosLegs)).toHaveBeenCalledTimes(closes);
      const share = (10 * 0.01) / 33;
      expect(h.file().delever?.boros[0].closed).toBeCloseTo(closes ? share : 0, 9);
      expect(share * 2400).toBeLessThan(10);
    });

    it('GET /rebalance returns the TWAP view for a Delever job with a TWAP, and none without', async () => {
      mockView();
      const h = boot();
      await h.ready();
      const job = twapJob(0.01, { status: 'running' });
      doneChild(h.store, job.steps[0].lead!.text, 0.01);
      h.jobs.write(job);

      const { data } = await h.view();
      expect(data.job).toMatchObject({ id: job.id, kind: 'delever' });
      expect(data.job.twap).toBeDefined();
      expect(data.job.orders).toEqual(expect.any(Array));
      expect(data.job.orders.length).toBeGreaterThan(0);

      h.jobs.write({ ...job, deleverTwap: null });
      const plain = await h.view();
      expect(plain.data.job).not.toHaveProperty('orders');
    });
  });

  it('paused job keeps the lock, no alert', async () => {
    mockAccount(ownerAccount());
    const h = boot({ job: slicedJob({ status: 'halted', paused: true, haltReason: null }) });
    await h.ready();

    const rebalance = await h.post('/api/rebalance', { kind: 'realize', realizeTarget: 'clear-debt', costUsd: 1 });
    const deal = await h.post('/api/deals', DEAL);

    expect(rebalance.statusCode).toBe(409);
    expect(deal.statusCode).toBe(409);
    expect(h.store.listAlerts({ unackedOnly: true })).toEqual([]);
  });

  it('pause needs a running job', async () => {
    const h = boot({ job: slicedJob({ status: 'halted', haltReason: 'stopped' }) });
    await h.ready();

    const res = await h.post(`/api/rebalance/${h.file().id}/pause`);

    expect(res.statusCode).toBe(409);
    expect(h.file().pauseRequested).toBe(false);
  });

  it('pause and fix are idempotent', async () => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'running' });
    h.jobs.write(job);

    const [first, second] = await Promise.all([h.post(`/api/rebalance/${job.id}/pause`), h.post(`/api/rebalance/${job.id}/pause`)]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(h.file()).toMatchObject({ status: 'running', pauseRequested: true });

    const halted = slicedJob({ status: 'halted', haltReason: 'stopped', borosLeftYu: 0, follow: null });
    h.jobs.write(halted);
    const fixes = await Promise.all([
      h.post(`/api/rebalance/${halted.id}/fix`, { action: 'market' }),
      h.post(`/api/rebalance/${halted.id}/fix`, { action: 'market' }),
    ]);
    expect(fixes.map((res) => res.statusCode)).toEqual([409, 409]);
    expect(fixes[0].json().error.message).toBe('Nothing is left to fix.');
  });

  it('fix answers in the states the run view draws its holds', async () => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const running = slicedJob({ status: 'running', followMisses: 2 });
    h.jobs.write(running);
    const early = await h.post(`/api/rebalance/${running.id}/fix`, { action: 'market' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toBe(`rebalance ${running.id} is running`);

    const abandoned = slicedJob({ status: 'abandoned', borosGapYu: 5, delever: null });
    h.jobs.write(abandoned);
    const notDelever = await h.post(`/api/rebalance/${abandoned.id}/fix`, { action: 'boros-retry' });
    expect(notDelever.statusCode).toBe(409);
    expect(notDelever.json().error.message).toBe(`rebalance ${abandoned.id} is abandoned`);

    const paused = slicedJob({ status: 'halted', paused: true, borosGapYu: 5, borosLeftYu: 0, delever: { pct: 0.2, legs: [], boros: [] } });
    h.jobs.write(paused);
    const gap = await h.post(`/api/rebalance/${paused.id}/fix`, { action: 'boros-retry' });
    expect(gap.json().error?.message).not.toBe('Nothing is left to fix.');

    const addedBack = slicedJob({ status: 'halted', borosLeftYu: 5, delever: { pct: 0.2, legs: [], boros: [] } });
    addedBack.steps[addedBack.stepIndex].addBack = { qty: 3, legs: [{ symbol: HL_ETH, filled: 3, order: null }] };
    h.jobs.write(addedBack);
    const retry = await h.post(`/api/rebalance/${addedBack.id}/fix`, { action: 'boros-retry' });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.message).toBe('One perp is already added back. Hold to add back to finish the other first.');

    const abandonedAddBack = slicedJob({ status: 'abandoned', borosLeftYu: 5, delever: { pct: 0.2, legs: [], boros: [] } });
    abandonedAddBack.steps[abandonedAddBack.stepIndex].addBack = { qty: 3, legs: [{ symbol: HL_ETH, filled: 3, order: null }] };
    h.jobs.write(abandonedAddBack);
    const abandonedRetry = await h.post(`/api/rebalance/${abandonedAddBack.id}/fix`, { action: 'boros-retry' });
    expect(abandonedRetry.json().error?.message).not.toBe('One perp is already added back. Hold to add back to finish the other first.');
    expect(abandonedRetry.statusCode).not.toBe(409);
  });

  it.each([
    [0.0166, '0.0166'],
    [2_000, '2,000'],
  ])('a part add back refuses Resume, and Abandon names each perp and the gap without a hold, %d ETH', async (q, size) => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: q, order: null }, { symbol: 'GATE_FUTURE_ETH_USDT', filled: 0, order: null }] };
    h.jobs.write(job);

    const resume = await h.post(`/api/rebalance/${job.id}/resume`);
    expect(resume.statusCode).toBe(409);
    expect(resume.json().error.message).toBe('One perp is already added back. Hold to add back to finish the other first.');
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: 'Add back stopped.' });

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);
    expect(abandon.statusCode).toBe(200);
    expect(h.file()).toMatchObject({
      status: 'abandoned',
      haltReason: `Add back stopped: Hyperliquid ${size} of ${size} ETH, Gate 0 of ${size} ETH. The Gate long is ${size} ETH smaller than the Hyperliquid short. Close ${size} ETH of the Hyperliquid short in Positions.`,
    });
  });

  const GATE_ETH_PERP = 'GATE_FUTURE_ETH_USDT';
  const addBackOrder = (venueId: string | null, sentAt: number) => ({ text: `t-ab-${sentAt}`, venueId, sentAt, credited: 0, poc: false, price: null, side: 'SELL' as const, mid: null });
  const gapText = (size: string) => `The Gate long is ${size} ETH smaller than the Hyperliquid short. Close ${size} ETH of the Hyperliquid short in Positions.`;

  const addBackChild = (store: Store, id: string, filled: number, mode: 'DONE' | 'OPENING'): void => {
    store.createPair({
      id,
      mode,
      a: { contract: HL_ETH, side: 'SELL', lot: '0.0001', minSize: '0', minNotional: '0', tick: '0.1' },
      b: null,
      targetQty: String(filled),
      limitPrice: '2500',
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
      haltKind: null,
      haltReason: null,
      reportJson: null,
      createdAt: t,
    });
    const order = store.insertPendingOrder({ pairId: id, leg: 'A', kind: 'taker', side: 'SELL', qty: String(filled), price: null, tif: 'ioc', now: t });
    store.updateOrder(id, 'A', order.seq, { state: 'CLOSED', cumQty: String(filled), avgFillPrice: '2500', resolvedAt: t });
  };

  const withAddBackChild = (h: ReturnType<typeof boot>, q: number, mode: 'DONE' | 'OPENING') => {
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Gate has not confirmed the last order yet. Try again in two minutes.' });
    const order = { ...addBackOrder(null, t), text: `${job.id}-f1` };
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: 0, order }, { symbol: GATE_ETH_PERP, filled: 0, order: null }] };
    addBackChild(h.store, order.text, q, mode);
    h.jobs.write(job);
    return job;
  };

  it.each([
    [0.0166, '0.0166'],
    [2_000, '2,000'],
  ])('Abandon reads an unconfirmed add back child from the engine store, credits its fill and names the gap, %d ETH', async (q, size) => {
    mockAccount(ownerAccount());
    const posts = gate().persist().post(/\/api\/v4\/crossex\/orders/).query(true).reply(200, {});
    const reads = gate().persist().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).reply(200, {});
    const h = boot();
    await h.ready();
    const job = withAddBackChild(h, q, 'DONE');

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);

    expect(abandon.statusCode).toBe(200);
    const file = h.file();
    expect(file.status).toBe('abandoned');
    expect(file.haltReason).toBe(`Add back stopped: Hyperliquid ${size} of ${size} ETH, Gate 0 of ${size} ETH. ${gapText(size)}`);
    expect(file.steps[file.stepIndex].addBack?.legs[0]).toMatchObject({ filled: q, order: null });
    expect(file.openGaps).toEqual([
      {
        leg: { symbol: GATE_ETH_PERP, base: 'ETH', exchange: 'GATE', side: 'LONG', positionQty: 66, hedge: 'HYPERLIQUID' },
        qty: q,
        hedges: [{ symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SHORT', qty: 66 }],
      },
    ]);
    expect(posts.isDone()).toBe(false);
    expect(reads.isDone()).toBe(false);
  });

  it.each([0.0166, 2_000])('Abandon refuses while the add back child is still live in the engine, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const job = withAddBackChild(h, q, 'OPENING');

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);

    expect(abandon.statusCode).toBe(409);
    expect(abandon.json().error.message).toBe('Gate has not confirmed the last order yet. Try again in two minutes.');
    expect(h.file()).toMatchObject({ status: 'halted' });
    expect(h.file().steps[job.stepIndex].addBack?.legs[0].order).toMatchObject({ text: `${job.id}-f1` });
    expect(h.file().openGaps).toBeUndefined();
  });

  it.each([
    [0.0166, '0.0166'],
    [2_000, '2,000'],
  ])('Abandon refuses while an add back order is still unknown inside the lookup window, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    gate().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).reply(404, { label: 'ORDER_NOT_FOUND', message: 'not found' });
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    const order = addBackOrder('902', t - 1_000);
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: q, order: null }, { symbol: GATE_ETH_PERP, filled: 0, order }] };
    h.jobs.write(job);

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);

    expect(abandon.statusCode).toBe(409);
    expect(abandon.json().error.message).toBe('Gate has not confirmed the last order yet. Try again in two minutes.');
    expect(h.file()).toMatchObject({ status: 'halted', haltReason: 'Add back stopped.' });
    expect(h.file().steps[job.stepIndex].addBack?.legs[1].order).toMatchObject({ venueId: '902' });
    expect(h.file().openGaps).toBeUndefined();
  });

  it.each([
    [0.0166, '0.0166'],
    [2_000, '2,000'],
  ])('after the lookup window with no order found, Abandon goes ahead and names the fills it knows, %d ETH', async (q, size) => {
    mockAccount(ownerAccount());
    gate().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).reply(404, { label: 'ORDER_NOT_FOUND', message: 'not found' });
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    const order = addBackOrder('903', t - LOOKUP_WINDOW_MS - 1);
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: q, order: null }, { symbol: GATE_ETH_PERP, filled: 0, order }] };
    h.jobs.write(job);

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);

    expect(abandon.statusCode).toBe(200);
    expect(h.file()).toMatchObject({
      status: 'abandoned',
      haltReason: `Add back stopped: Hyperliquid ${size} of ${size} ETH, Gate 0 of ${size} ETH. ${gapText(size)} Gate has not confirmed the Gate add back order. Check the Gate long in Positions before you trade.`,
    });
    expect(h.file().steps[job.stepIndex].addBack?.legs[1].order).toBeNull();
  });

  it.each([
    [0.004, 'BTC', '0.004', '0.004'],
    [333.3333, 'ETH', '333.3333', '333.33'],
    [2_000, 'ETH', '2,000', '2,000'],
  ])('the add back gap prints the whole lot size, %d %s', async (q, coin, size, target) => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    for (const leg of job.delever!.legs) leg.base = coin;
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: q, order: null }, { symbol: GATE_ETH_PERP, filled: 0, order: null }] };
    h.jobs.write(job);

    await h.post(`/api/rebalance/${job.id}/abandon`);

    expect(h.file().haltReason).toBe(
      `Add back stopped: Hyperliquid ${size} of ${target} ${coin}, Gate 0 of ${target} ${coin}. The Gate long is ${size} ${coin} smaller than the Hyperliquid short. Close ${size} ${coin} of the Hyperliquid short in Positions.`,
    );
  });

  it.each([0.0166, 2_000])('an abandoned part add back keeps its perp gap after the Boros close, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: q, order: null }, { symbol: GATE_ETH_PERP, filled: 0, order: null }] };
    h.jobs.write(job);
    await h.post(`/api/rebalance/${job.id}/abandon`);
    h.jobs.write({ ...h.file(), borosLeftYu: 0, borosGapYu: 0 });

    const closed = h.file();
    const uneven = [
      { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SHORT' as const, qty: 33 + q },
      { symbol: GATE_ETH_PERP, exchange: 'GATE', side: 'LONG' as const, qty: 33 },
    ];
    expect(gapsLeftBy(closed, uneven)).toEqual([expect.objectContaining({ qty: q, leg: expect.objectContaining({ symbol: GATE_ETH_PERP, side: 'LONG' }) })]);
    const even = [{ ...uneven[0], qty: 33 }, uneven[1]];
    expect(gapsLeftBy(closed, even)).toEqual([]);
  });

  it('a fix sent while the boot cancel runs is answered, and Abandon works after it', async () => {
    mockAccount(ownerAccount());
    refuseSends();
    gate().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).delay(300).reply(404, { label: 'ORDER_NOT_FOUND', message: 'not found' });
    const job = slicedJob({ status: 'running', followMisses: 3 });
    const slices = job.steps.find((step) => step.name === 'Slices')!;
    slices.status = 'running';
    slices.lead = { text: 't-boot-1', venueId: null, sentAt: t, credited: 0, poc: true, price: '2999.9', side: 'BUY', mid: null };
    job.realize!.legs[0].filledQty = 5;
    job.notHedgedQty = 5;
    job.follow = { symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', qty: 5 } as Job['follow'];
    const h = boot({ job });
    await h.ready();

    const fix = await h.post(`/api/rebalance/${job.id}/fix`, { action: 'market' });
    expect(fix.statusCode).toBeGreaterThanOrEqual(200);
    await waitFor(() => h.file().status === 'halted', 'the boot halt');

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);
    expect(abandon.json().error?.message).not.toBe('A fix is still running. Wait for it to finish.');
    expect(abandon.statusCode).toBe(200);
  });

  it('plan check allows a 1% size gap at 6M', () => {
    const lot = Number(PERP_RULES[HL_ETH].lotSize);
    const qty = 3_294.6;
    const fresh = [{ symbol: HL_ETH, qty } as RealizeLeg];
    const shownAt = (shownQty: number) => isShownRealize(fresh, [{ symbol: HL_ETH, qty: shownQty }], PERP_RULES);
    expect(shownAt(qty * 1.01)).toBe(true);
    expect(shownAt(qty * 0.99)).toBe(true);
    expect(shownAt(qty * 1.0102)).toBe(false);
    expect(shownAt(qty * 0.9898)).toBe(false);
    const small = [{ symbol: HL_ETH, qty: 0.01 } as RealizeLeg];
    expect(isShownRealize(small, [{ symbol: HL_ETH, qty: 0.01 + lot }], PERP_RULES)).toBe(true);
    expect(isShownRealize(small, [{ symbol: HL_ETH, qty: 0.01 + 2 * lot }], PERP_RULES)).toBe(false);
  });

  it('job stores the route price impact apart', async () => {
    mockOwnerBook();
    refuseSends();
    refuseQuotes();
    const h = boot();
    const plan = await h.plan();
    const shown = shownOf(plan);

    const res = await h.post('/api/rebalance', shown);

    expect(res.statusCode).toBe(202);
    expect(h.file().routeImpactUsd).toBe(plan.routes[shown.route]!.priceImpactUsd);
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });

  it('a second post while the realize runs is refused', async () => {
    mockOwnerBook(OWNER_HL_ETH, { accountDelayMs: 50 });
    refuseSends();
    refuseQuotes();
    const h = boot();
    const shown = shownOf(await h.plan());

    const [first, second] = await Promise.all([h.post('/api/rebalance', shown), h.post('/api/rebalance', shown)]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().error.message).toMatch(new RegExp(`^rebalance ${h.file().id} is (running|halted)$`));
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });
});
