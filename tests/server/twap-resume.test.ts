import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VenueFeeRow } from '../../src/core/estimate/fees';
import { planSlices, type TwapInput, type TwapLegRule } from '../../src/core/twap';
import type { DealRequest } from '../../src/engine/create';
import { Store } from '../../src/engine/db';
import { fx, fxStr } from '../../src/engine/fx';
import { tickPair, type LoopDeps } from '../../src/engine/loop';
import type { PairRow } from '../../src/engine/types';
import { TtlCache } from '../../src/server/cache';
import { childIdFor, type Job, JobFile, newTwapJob, TransferFile, type TwapDealTemplate } from '../../src/server/rebalanceJob';
import { loadTwapChildren, runTwap, type TwapRunDeps, twapViewOf } from '../../src/server/twapRun';
import { dealSlippage } from '../../web/src/trade/dealSlippage';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { fixture, gate, HOST, makeTestApp } from './helpers/gate-nock';
import { waitFor } from './helpers/rebalance';

const T0 = Date.UTC(2026, 10, 25, 14, 0, 0);
const MIN = 60_000;

const ETH_RULES: TwapLegRule[] = [
  { venue: 'GATE', coin: 'ETH', lot: '0.001', minSize: '0.001', minNotional: '0', maxMarketSize: '2000', maxLimitSize: '2000' },
  { venue: 'HYPERLIQUID', coin: 'ETH', lot: '0.0001', minSize: '0.0001', minNotional: '10', maxMarketSize: null, maxLimitSize: null },
];

const BTC_RULES: TwapLegRule[] = [
  { venue: 'GATE', coin: 'BTC', lot: '0.0001', minSize: '0.0001', minNotional: '0', maxMarketSize: '1200', maxLimitSize: '1200' },
  { venue: 'BINANCE', coin: 'BTC', lot: '0.001', minSize: '0.001', minNotional: '50', maxMarketSize: '120', maxLimitSize: '1000' },
];

const ethDeal = (totalQty: string, close = false): TwapDealTemplate => ({
  a: { symbol: 'GATE_FUTURE_ETH_USDT', side: close ? 'SELL' : 'BUY', ...(close ? { reduceOnly: true } : {}) },
  b: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: close ? 'BUY' : 'SELL', ...(close ? { reduceOnly: true } : {}) },
  execution: 'maker',
  totalQty,
  coin: 'ETH',
  rules: ETH_RULES,
});

const btcDeal = (totalQty: string): TwapDealTemplate => ({
  a: { symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY' },
  b: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL' },
  execution: 'maker',
  totalQty,
  coin: 'BTC',
  rules: BTC_RULES,
});

interface World {
  t: number;
  store: Store;
  jobs: JobFile;
  requests: DealRequest[];
  onCreate: ((req: DealRequest) => void) | null;
  deps: TwapRunDeps;
}

let w: World;

function makeWorld(): World {
  const world = { t: T0, store: new Store(':memory:'), requests: [] as DealRequest[], onCreate: null } as World;
  world.jobs = new JobFile(fs.mkdtempSync(path.join(tmpdir(), 'twap-resume-')), () => world.t);
  const spec = (leg: { symbol: string; side: 'BUY' | 'SELL'; reduceOnly?: boolean }) => ({
    contract: leg.symbol,
    side: leg.side,
    lot: '0.001',
    minSize: '0.001',
    minNotional: '0',
    tick: '0.01',
    ...(leg.reduceOnly ? { reduceOnly: true } : {}),
  });
  world.deps = {
    store: world.store,
    engineWake: () => undefined,
    now: () => world.t,
    jobs: world.jobs,
    readFees: async () => ({}),
    createChild: async (req) => {
      world.requests.push(req);
      world.onCreate?.(req);
      world.store.createPair({
        id: req.id,
        mode: 'OPENING',
        a: spec(req.a),
        b: req.b ? spec(req.b) : null,
        targetQty: req.qty,
        limitPrice: '3000',
        pricePolicy: 'touch',
        deadlineAt: req.timeoutSec === null || req.timeoutSec === undefined ? null : world.t + req.timeoutSec * 1000,
        makerNotBefore: 0,
        hedgeNotBefore: 0,
        pocRejects: 0,
        hedgeRejectStreak: 0,
        maxClip: null,
        clipBandBp: null,
        repegBehindBp: req.repegBehindBp ?? null,
        repegAutoBp: req.repegBehindBp ?? null,
        repegNotBefore: 0,
        haltKind: null,
        haltReason: null,
        reportJson: null,
        createdAt: world.t,
      });
    },
  };
  return world;
}

function startJob(deal: TwapDealTemplate, input: TwapInput, mark: number, takerAfterSec?: number | null): Job {
  const result = planSlices(deal.totalQty, input, deal.rules, mark);
  if (!result.plan) throw new Error('no plan');
  const job = newTwapJob(
    {
      userId: 'u1',
      deal,
      plan: result.plan,
      makerLeg: 'a',
      repegBehindBp: 5,
      takerAfterSec: takerAfterSec === undefined ? result.plan.takerAfterSec : takerAfterSec,
      clientId: 'client-1',
    },
    w.t,
  );
  w.jobs.write(job);
  return job;
}

const read = (): Job => w.jobs.read() as Job;

const advance = async (job: Job, to: number): Promise<Job> => {
  while (w.t + 30_000 < to) {
    w.t += 30_000;
    await runTwap(w.deps, job);
  }
  w.t = to;
  await runTwap(w.deps, job);
  return read();
};

function fill(id: string, filledA: string, price: string, opts: { filledB?: string; bPrice?: string } = {}): void {
  const pair = w.store.getPair(id) as PairRow;
  const a = w.store.insertPendingOrder({ pairId: id, leg: 'A', kind: 'maker', side: pair.a.side, qty: pair.targetQty, price, tif: 'poc', now: w.t });
  w.store.updateOrder(id, 'A', a.seq, { state: 'CLOSED', cumQty: filledA, avgFillPrice: filledA === '0' ? '0' : price, resolvedAt: w.t });
  const filledB = opts.filledB ?? filledA;
  if (pair.b && filledB !== '0') {
    const b = w.store.insertPendingOrder({ pairId: id, leg: 'B', kind: 'taker', side: pair.b.side, qty: filledB, price: null, tif: 'ioc', now: w.t + 1 });
    w.store.updateOrder(id, 'B', b.seq, { state: 'CLOSED', cumQty: filledB, avgFillPrice: opts.bPrice ?? price, resolvedAt: w.t });
  }
  w.store.updatePair(id, { mode: 'DONE' });
}

async function resume(): Promise<Job> {
  const job = read();
  job.status = 'running';
  job.paused = false;
  job.haltKind = null;
  job.haltReason = null;
  w.jobs.write(job);
  return job;
}

const onResume = (job: Job): number => {
  const view = twapViewOf(job, []).twap!;
  return view.of - view.slice;
};

const sentSum = (from: number): number => w.requests.slice(from).reduce((sum, req) => sum + Number(req.qty), 0);

describe('twap resume re-plans the rest', () => {
  beforeEach(() => {
    w = makeWorld();
  });

  it('a last slice over the venue max at $6M resumes as slices under the max', async () => {
    const job = startJob(ethDeal('2033.333'), { durationSec: 3600, slices: 12 }, 3000, null);
    for (let slice = 1; slice <= 11; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), '0', '3000');
    }
    const halted = await advance(job, T0 + 55 * MIN);
    expect(halted).toMatchObject({ status: 'halted', haltKind: 'refused', haltReason: "Slice 12 is over Gate's 2,000 ETH maximum" });
    expect(onResume(halted)).toBe(2);
    const before = w.requests.length;
    await resume();
    w.t = T0 + 60 * MIN;
    await runTwap(w.deps, job);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s12-1`, qty: '1016.666' });
    fill(childIdFor(job.id, 12, 1), '1016.666', '3000');
    await advance(job, T0 + 65 * MIN);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s13-1`, qty: '1016.667' });
    expect(w.requests.slice(before).every((req) => Number(req.qty) <= 2000)).toBe(true);
    fill(childIdFor(job.id, 13, 1), '1016.667', '3000');
    expect((await advance(job, T0 + 70 * MIN)).status).toBe('done');
  });

  it('a rest under the venue min at $50 joins fewer slices on resume', async () => {
    const job = startJob(btcDeal('0.012'), { durationSec: 3600, slices: 12 }, 90_000);
    for (let slice = 1; slice <= 6; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), '0.001', slice === 6 ? '40000' : '90000');
    }
    const halted = await advance(job, T0 + 30 * MIN);
    expect(halted).toMatchObject({ status: 'halted', haltKind: 'refused', haltReason: "Slice 7 is under Binance's $50 minimum" });
    expect(onResume(halted)).toBe(3);
    const before = w.requests.length;
    await resume();
    for (let k = 0; k < 3; k += 1) {
      const after = await advance(job, T0 + (40 + k * 5) * MIN);
      expect(after.status, after.haltReason ?? '').not.toBe('halted');
      const req = w.requests.at(-1) as DealRequest;
      expect(Number(req.qty) * 40_000).toBeGreaterThanOrEqual(50);
      fill(req.id, req.qty, '40000');
    }
    expect(w.requests.slice(before).map((req) => req.id)).toEqual([7, 8, 9].map((slice) => `${job.id}-s${slice}-1`));
    expect(sentSum(before)).toBeCloseTo(0.006, 9);
    expect((await advance(job, T0 + 60 * MIN)).status).toBe('done');
  });

  it('a capped rest after the last slice shows one slice on resume', async () => {
    const job = startJob(ethDeal('60', true), { durationSec: 3600, slices: 12 }, 3000);
    for (let slice = 1; slice <= 12; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), slice === 12 ? '2' : '5', '3000');
    }
    const halted = await advance(job, T0 + 56 * MIN);
    expect(halted).toMatchObject({ status: 'halted', haltKind: 'capped-rest', haltReason: '3 ETH not closed' });
    expect(halted.twap?.carryQty).toBe('3');
    expect(onResume(halted)).toBe(1);
  });

  it('a pause mid-run keeps the planned slices on resume', async () => {
    const job = startJob(ethDeal('60'), { durationSec: 3600, slices: 12 }, 3000);
    await advance(job, T0);
    fill(childIdFor(job.id, 1, 1), '5', '3000');
    const paused = read();
    paused.pauseRequested = true;
    w.jobs.write(paused);
    const halted = await advance(job, T0 + MIN);
    expect(halted.status).toBe('halted');
    expect(onResume(halted)).toBe(11);
  });
});

const ETH_BINANCE_RULES: TwapLegRule[] = [
  { venue: 'GATE', coin: 'ETH', lot: '0.001', minSize: '0.001', minNotional: '0', maxMarketSize: '100000', maxLimitSize: '100000' },
  { venue: 'BINANCE', coin: 'ETH', lot: '0.001', minSize: '0.001', minNotional: '20', maxMarketSize: '2000', maxLimitSize: '10000' },
];

const ethBinanceDeal = (totalQty: string): TwapDealTemplate => ({
  a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' },
  b: { symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL' },
  execution: 'maker',
  totalQty,
  coin: 'ETH',
  rules: ETH_BINANCE_RULES,
});

describe('twap rest wholly under a venue minimum', () => {
  const STUCK = "Rest 0.006 ETH is under Binance's $20 minimum. Resume cannot send it. Stop ends the run.";

  beforeEach(() => {
    w = makeWorld();
  });

  for (const [size, total] of [
    ['$50', '0.017'],
    ['$6M', '2000'],
  ] as const) {
    it(`a ${size} run halts once, says Resume cannot send the rest, and the route refuses Resume`, async () => {
      const job = startJob(ethBinanceDeal(total), { durationSec: 3600, slices: 2 }, 3000);
      await advance(job, T0);
      const first = w.requests[0];
      fill(first.id, first.qty, '3000');
      await advance(job, T0 + 30 * MIN);
      const last = w.requests[1];
      fill(last.id, fxStr(fx(last.qty) - fx('0.006')), '3000');
      const capped = await advance(job, T0 + 31 * MIN);
      expect(capped).toMatchObject({ status: 'halted', haltKind: 'capped-rest', haltReason: '0.006 ETH not opened' });
      await resume();
      const halted = await advance(job, T0 + 32 * MIN);
      expect(halted).toMatchObject({
        status: 'halted',
        haltKind: 'refused',
        haltReason: STUCK,
        sizeRefusal: { slice: 3, venue: 'Binance', limit: '$20', bound: 'min', wholeRest: true },
      });
      expect(w.requests).toHaveLength(2);
      const a = bootApp([]);
      a.jobs.write(halted);
      const res = await a.app.inject({ method: 'POST', url: `/api/rebalance/${halted.id}/resume`, headers: HOST });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe(STUCK);
      expect(appJob(a)).toMatchObject({ status: 'halted', haltReason: STUCK });
    });
  }

  it('a slice under the minimum with more rest behind it keeps Resume', async () => {
    const job = startJob(btcDeal('0.012'), { durationSec: 3600, slices: 12 }, 90_000);
    for (let slice = 1; slice <= 6; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), '0.001', slice === 6 ? '40000' : '90000');
    }
    const halted = await advance(job, T0 + 30 * MIN);
    expect(halted.sizeRefusal).toEqual({ slice: 7, venue: 'Binance', limit: '$50', bound: 'min', wholeRest: false });
  });
});

describe('twap slice sizes', () => {
  beforeEach(() => {
    w = makeWorld();
  });

  it('a slice-size plan sends the sizes the plan shows', async () => {
    const job = startJob(ethDeal('693.64'), { durationSec: 3600, sliceQty: '60' }, 3000);
    const plan = job.twap!;
    expect(plan.slices).toBe(12);
    for (let slice = 1; slice <= 12; slice += 1) {
      await advance(job, T0 + (slice - 1) * plan.intervalSec * 1000);
      const req = w.requests.at(-1) as DealRequest;
      fill(req.id, req.qty, '3000');
    }
    expect(w.requests.map((req) => req.qty)).toEqual([...Array.from({ length: 11 }, () => '60'), '33.64']);
  });
});

describe('twap abandon race', () => {
  beforeEach(() => {
    w = makeWorld();
  });

  it('a slice created after an abandon and a new job is stopped', async () => {
    const job = startJob(ethDeal('60'), { durationSec: 3600, slices: 12 }, 3000);
    w.onCreate = () => {
      const old = read();
      old.status = 'abandoned';
      w.jobs.write(old);
      w.t += 1000;
      startJob(ethDeal('30'), { durationSec: 3600, slices: 6 }, 3000);
    };
    await runTwap(w.deps, job);
    expect(read().id).not.toBe(job.id);
    expect(w.store.getPair(childIdFor(job.id, 1, 1))?.mode).toBe('STOPPING');
  });
});

describe('twap fee and slippage view', () => {
  beforeEach(() => {
    w = makeWorld();
  });

  const vip: VenueFeeRow[] = [
    { exchangeType: 'GATE', futureMakerFee: '0.0001', futureTakerFee: '0.0003' },
    { exchangeType: 'HYPERLIQUID', futureMakerFee: '0.00015', futureTakerFee: '0.00035' },
  ];

  it('an unread fee counts at the account rates and the total adds the read fee', async () => {
    const job = startJob(ethDeal('60'), { durationSec: 3600, slices: 12 }, 3000);
    await advance(job, T0);
    fill(childIdFor(job.id, 1, 1), '5', '3000', { bPrice: '3003' });
    await advance(job, T0 + 5 * MIN);
    fill(childIdFor(job.id, 2, 1), '5', '3000', { bPrice: '3003' });
    const deps = { ...w.deps, readFees: async () => ({ [childIdFor(job.id, 2, 1)]: 4.2 }) };
    const view = twapViewOf(read(), await loadTwapChildren(deps, read()), vip);
    const est = 5 * 3000 * 0.0001 + 5 * 3003 * 0.00035;
    expect(view.fees.estUsd).toBeCloseTo(est, 10);
    expect(view.fees.readUsd).toBeCloseTo(4.2, 10);
    expect(view.fees.totalUsd).toBeCloseTo(4.2 + est, 10);
  });

  it('a venue with no loaded rate counts at 2 bp maker and 5 bp taker', async () => {
    const job = startJob(ethDeal('60'), { durationSec: 3600, slices: 12 }, 3000);
    await advance(job, T0);
    fill(childIdFor(job.id, 1, 1), '5', '3000', { bPrice: '3003' });
    const view = twapViewOf(read(), await loadTwapChildren(w.deps, read()), [vip[0]]);
    expect(view.fees.estUsd).toBeCloseTo(5 * 3000 * 0.0001 + 5 * 3003 * 0.0005, 10);
  });

  it('slippage uses the same rule as the deal window over uneven slices', async () => {
    const job = startJob(ethDeal('60'), { durationSec: 3600, slices: 12 }, 3000);
    await advance(job, T0);
    fill(childIdFor(job.id, 1, 1), '5', '3000', { filledB: '3', bPrice: '3003' });
    await advance(job, T0 + 5 * MIN);
    fill(childIdFor(job.id, 2, 1), '3', '3100', { filledB: '5', bPrice: '3103' });
    const view = twapViewOf(read(), await loadTwapChildren(w.deps, read()));
    const [long, short] = view.legs;
    const expected = dealSlippage({ longAvg: Number(long.avgPrice), shortAvg: Number(short.avgPrice), qty: 8, close: false })!;
    expect(view.slippage?.usd).toBeCloseTo(224, 9);
    expect(view.slippage).toEqual({ usd: expected.usd, pct: expected.pct });
  });
});

const API = '/api/v4';
const BOT_HOST = 'https://boros-bot-notification.pendle.finance';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  nock.cleanAll();
});

const ruleRow = (symbol: string) => ({
  symbol,
  state: 'live',
  business_type: 'FUTURE',
  lot_size: '0.001',
  min_size: '0',
  min_notional: '0',
  tick_size: '0.01',
  max_market_size: '10000',
  max_limit_size: '10000',
});

const position = (symbol: string, qty: string, side: 'LONG' | 'SHORT') => ({
  user_id: '1234567',
  position_id: `${symbol}-1`,
  symbol,
  position_side: side,
  position_qty: side === 'LONG' ? qty : `-${qty}`,
  position_value: String(Number(qty) * 2500),
  upnl: '0',
  upnl_rate: '0',
  entry_price: '2500',
  mark_price: '2500',
  leverage: '5',
  max_leverage: '50',
  initial_margin: String((Number(qty) * 2500) / 5),
  maintenance_margin: '1',
  fee: '0',
  funding_fee: '0',
  funding_time: '1751500800000',
  create_time: '1751000000000',
  update_time: '1751500000000',
  closed_pnl: '0',
});

interface AppWorld {
  store: Store;
  venue: FakeVenue;
  clock: VirtualClock;
  jobs: JobFile;
  loop: LoopDeps;
  app: FastifyInstance;
  waiters: Array<() => void>;
}

function bootApp(positions: unknown[]): AppWorld {
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'twap-resume-app-'));
  const store = new Store(':memory:');
  const venue = new FakeVenue();
  const clock = new VirtualClock();
  const jobs = new JobFile(dataDir);
  const waiters: Array<() => void> = [];
  const app = makeTestApp({
    cache: new TtlCache(),
    dataDir,
    engine: { store, venue, clock },
    rebalance: { jobs, sleep: () => new Promise<void>((resolve) => waiters.push(resolve)) },
    transfer: { jobs: new TransferFile(dataDir), sleep: () => new Promise<void>(() => undefined) },
  });
  apps.push(app);
  gate().persist().get(`${API}/crossex/rule/symbols`).query(true).reply(200, [ruleRow(A_CONTRACT), ruleRow(B_CONTRACT)]);
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, fixture('account.json'));
  gate().persist().get(`${API}/crossex/fee`).query(true).reply(500, { label: 'SERVER_ERROR', message: 'no fee read' });
  const cap = (symbol: string) => ({ symbol, tiers: [{ max_risk_limit_value: '1000000000', leverage_max: '50' }] });
  gate().persist().get(`${API}/crossex/rule/risk_limits`).query(true).reply(200, [cap(A_CONTRACT), cap(B_CONTRACT)]);
  gate().persist().get(`${API}/crossex/positions`).query(true).reply(200, positions);
  gate().persist().get(`${API}/crossex/open_orders`).query(true).reply(200, []);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) nock(BOT_HOST).persist().intercept(/.*/, method).reply(200, {});
  return { store, venue, clock, jobs, loop: { store, venue, clock }, app, waiters };
}

const appJob = (a: AppWorld): Job => a.jobs.read()!;
const appChild = (a: AppWorld, slice: number) => a.store.getPair(childIdFor(appJob(a).id, slice, 1));

async function settle(a: AppWorld): Promise<void> {
  await waitFor(() => a.waiters.length > 0 || a.jobs.read()?.status !== 'running', 'a runner pass', 10_000);
}

async function step(a: AppWorld): Promise<void> {
  a.clock.advance(30_000);
  for (let round = 0; round < 6; round += 1) {
    for (const pair of a.store.listPairs({ activeOnly: true })) await tickPair(a.loop, pair.id);
  }
  await settle(a);
  a.waiters.shift()?.();
  await settle(a);
}

describe('twap close slice at the Market slippage cap', () => {
  it('a reduce-only close child stopped at the cap carries its rest into the next slice', async () => {
    const a = bootApp([position(A_CONTRACT, '1.824', 'LONG'), position(B_CONTRACT, '1.824', 'SHORT')]);
    const res = await a.app.inject({
      method: 'POST',
      url: '/api/rebalance',
      headers: HOST,
      payload: {
        kind: 'twap',
        clientId: 'client-close',
        durationSec: 3600,
        slices: 12,
        deal: {
          id: 'deal-twap-close',
          a: { symbol: A_CONTRACT, side: 'SELL', reduceOnly: true },
          b: { symbol: B_CONTRACT, side: 'BUY', reduceOnly: true },
          qty: '1.824',
          execution: 'maker',
          pricePolicy: 'touch',
          clipBandPct: 0.5,
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    await settle(a);
    const first = appChild(a, 1)!;
    expect(first.a).toMatchObject({ side: 'SELL', reduceOnly: true });
    await tickPair(a.loop, first.id);
    for (let i = 0; i < 7; i += 1) await step(a);
    a.venue.nextIocFill.push(0.5, 1, 0, 0, 0, 0, 0, 0, 0, 0);
    for (let i = 0; i < 40 && !appChild(a, 2); i += 1) await step(a);
    const done = a.store.getPair(first.id)!;
    expect(done.mode).toBe('DONE');
    const filled = a.store
      .listOrders(first.id)
      .filter((order) => order.leg === 'A')
      .reduce((sum, order) => sum + Number(order.cumQty), 0);
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(0.152);
    const rest = Number((0.152 - filled).toFixed(3));
    expect(Number(appChild(a, 2)!.targetQty)).toBeCloseTo(0.152 + rest, 9);
    expect(appChild(a, 2)!.a).toMatchObject({ side: 'SELL', reduceOnly: true });
  });
});
