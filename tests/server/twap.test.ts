import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { fx, fxFloorToStep, fxStr } from '../../src/engine/fx';
import { tickPair, type LoopDeps } from '../../src/engine/loop';
import { TTL, TtlCache } from '../../src/server/cache';
import { isChildOf, JobFile, newTwapJob, TransferFile, type Job } from '../../src/server/rebalanceJob';
import { bootHaltTwap, loadTwapChildren, twapViewOf, type TwapRunDeps } from '../../src/server/twapRun';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { fixture, gate, HOST, makeTestApp } from './helpers/gate-nock';
import { asset, waitFor } from './helpers/rebalance';

const API = '/api/v4';
const BOT_HOST = 'https://boros-bot-notification.pendle.finance';
const RUNNING_TEXT = 'A TWAP is running. Orders and transfers wait until it ends.';
const PAUSED_TEXT = 'A TWAP is paused. Orders wait until it ends.';
const ERROR_TEXT = 'A TWAP stopped on an error. Orders and transfers wait until you resume or stop it.';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  nock.cleanAll();
});

interface RuleOver {
  minSize?: string;
  minNotional?: string;
  maxSize?: string;
}

const ruleRow = (symbol: string, over: RuleOver = {}) => ({
  symbol,
  state: 'live',
  business_type: 'FUTURE',
  lot_size: '0.001',
  min_size: over.minSize ?? '0',
  min_notional: over.minNotional ?? '0',
  tick_size: '0.01',
  max_market_size: over.maxSize ?? '10000',
  max_limit_size: '10000',
});

const feeRow = (exchange: string, maker: string, taker: string) => ({
  exchange_type: exchange,
  future_maker_fee: maker,
  future_taker_fee: taker,
});

const transferAsset = (coin: string, venue: string, balance: string) => asset(coin, venue, { balance, equity: balance });

const transferAccount = {
  user_id: '1',
  available_margin: '831.95',
  margin_balance: '988.23',
  initial_margin: '156.28',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    transferAsset('USDT', 'CROSSEX', '986.60'),
    transferAsset('USDC', 'HYPERLIQUID', '11.92'),
    transferAsset('USDC', 'GATE', '0.29'),
  ],
};

const longPosition = (symbol: string, qty: string) => ({
  user_id: '1234567',
  position_id: '41001',
  symbol,
  position_side: 'LONG',
  position_qty: qty,
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

const HL_OUT = { coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: '11.88' };

interface World {
  app: FastifyInstance;
  store: Store;
  venue: FakeVenue;
  clock: VirtualClock;
  jobs: JobFile;
  dataDir: string;
  cache: TtlCache;
  loop: LoopDeps;
  gate: { rules: unknown[]; account: unknown; fees: unknown[] | null; positions: unknown[]; botCalls: number };
  waiters: Array<() => void>;
}

function mockVenueReads(w: World): void {
  gate().persist().get(`${API}/crossex/rule/symbols`).query(true).reply(200, () => w.gate.rules);
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, () => w.gate.account);
  gate()
    .persist()
    .get(`${API}/crossex/fee`)
    .query(true)
    .reply(() => (w.gate.fees ? [200, w.gate.fees] : [500, { label: 'SERVER_ERROR', message: 'no fee read' }]));
  const cap = (symbol: string) => ({ symbol, tiers: [{ max_risk_limit_value: '1000000000', leverage_max: '50' }] });
  gate().persist().get(`${API}/crossex/rule/risk_limits`).query(true).reply(200, [cap(A_CONTRACT), cap(B_CONTRACT)]);
  gate().persist().get(`${API}/crossex/positions`).query(true).reply(200, () => w.gate.positions);
  gate().persist().get(`${API}/crossex/open_orders`).query(true).reply(200, []);
  gate().persist().get(`${API}/crossex/transfers/coin`).query(true).reply(200, [
    { coin: 'USDT', min_trans_amount: '0.00000001', est_fee: '0', precision: 8, is_disabled: 0 },
    { coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: 0 },
  ]);
  gate().persist().get(`${API}/spot/accounts`).query(true).reply(200, [{ currency: 'USDT', available: '318.42', locked: '0' }, { currency: 'USDC', available: '0', locked: '0' }]);
  gate().persist().post(`${API}/crossex/transfers`).reply(200, { tx_id: '123', text: 't' });
  gate()
    .persist()
    .get(`${API}/crossex/transfers`)
    .query(true)
    .reply(200, [{ id: 123, text: 't-tr', coin: 'USDC', amount: '11.88', status: 'PENDING' }]);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    nock(BOT_HOST)
      .persist()
      .intercept(/.*/, method)
      .reply(() => {
        w.gate.botCalls += 1;
        return [200, {}];
      });
  }
}

function boot(from?: Pick<World, 'store' | 'venue' | 'clock' | 'jobs' | 'dataDir' | 'gate'>): World {
  const dataDir = from?.dataDir ?? mkdtempSync(path.join(tmpdir(), 'twap-'));
  const store = from?.store ?? new Store(':memory:');
  const venue = from?.venue ?? new FakeVenue();
  const clock = from?.clock ?? new VirtualClock();
  const jobs = from?.jobs ?? new JobFile(dataDir);
  const cache = new TtlCache();
  const waiters: Array<() => void> = [];
  const sleep = (): Promise<void> => new Promise<void>((resolve) => waiters.push(resolve));
  const park = (): Promise<void> => new Promise<void>(() => undefined);
  const app = makeTestApp({
    cache,
    dataDir,
    engine: { store, venue, clock },
    rebalance: { jobs, sleep },
    transfer: { jobs: new TransferFile(dataDir), sleep: park },
  });
  apps.push(app);
  const w: World = {
    app,
    store,
    venue,
    clock,
    jobs,
    dataDir,
    cache,
    loop: { store, venue, clock },
    gate: from?.gate ?? { rules: [ruleRow(A_CONTRACT), ruleRow(B_CONTRACT)], account: fixture('account.json'), fees: null, positions: [], botCalls: 0 },
    waiters,
  };
  if (!from) mockVenueReads(w);
  return w;
}

const job = (w: World): Job => w.jobs.read()!;
const childId = (w: World, slice: number, k = 1): string => `${job(w).id}-s${slice}-${k}`;
const child = (w: World, slice: number) => w.store.getPair(childId(w, slice));

async function settle(w: World): Promise<void> {
  await waitFor(() => w.waiters.length > 0 || w.jobs.read()?.status !== 'running', 'a runner pass', 10_000);
  if (w.jobs.read()?.status !== 'running') await new Promise((resolve) => setTimeout(resolve, 30));
}

async function pass(w: World): Promise<void> {
  await settle(w);
  w.waiters.shift()?.();
  await settle(w);
}

async function tickLive(w: World, skipHalted = false): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    for (const pair of w.store.listPairs({ activeOnly: true })) {
      if (!skipHalted || pair.mode !== 'HALTED') await tickPair(w.loop, pair.id);
    }
  }
}

async function step(w: World, ms = 30_000): Promise<void> {
  w.clock.advance(ms);
  await tickLive(w);
  await pass(w);
}

async function fillChild(w: World, id: string, qty?: string): Promise<void> {
  if (!w.venue.liveOrder(w.store.getPair(id)!.a.contract)) await tickPair(w.loop, id);
  const pair = w.store.getPair(id)!;
  const maker = w.venue.liveOrder(pair.a.contract)!;
  expect(maker, `resting maker of ${id}`).toBeDefined();
  w.venue.fill(maker.clientText, qty ?? pair.targetQty);
  await tickLive(w);
}

const stateOf = (w: World): string =>
  JSON.stringify({
    job: { status: job(w).status, haltKind: job(w).haltKind, haltReason: job(w).haltReason, slice: job(w).twap?.sliceIndex },
    pairs: w.store.listPairs().map((pair) => [pair.id.split('-').slice(1).join('-'), pair.mode, pair.haltReason, pair.targetQty]),
  });

async function untilSlice(w: World, slice: number, maxSteps = 40): Promise<void> {
  for (let i = 0; i < maxSteps && !child(w, slice); i += 1) await step(w);
  expect(child(w, slice), `slice ${slice} child; ${stateOf(w)}`).not.toBeNull();
}

async function runFullSlices(w: World, upTo: number): Promise<void> {
  for (let slice = 1; slice <= upTo; slice += 1) {
    await untilSlice(w, slice);
    await fillChild(w, childId(w, slice));
    expect(child(w, slice)!.mode).toBe('DONE');
  }
}

const dealBody = (over: Record<string, unknown> = {}) => ({
  id: 'deal-twap-1',
  a: { symbol: A_CONTRACT, side: 'BUY' },
  b: { symbol: B_CONTRACT, side: 'SELL' },
  qty: '1.824',
  execution: 'maker',
  pricePolicy: 'touch',
  ...over,
});

const startBody = (over: Record<string, unknown> = {}, deal: Record<string, unknown> = {}) => ({
  kind: 'twap',
  clientId: 'client-1',
  durationSec: 3600,
  slices: 12,
  deal: dealBody(deal),
  ...over,
});

const post = (w: World, url: string, payload: Record<string, unknown> = {}) =>
  w.app.inject({ method: 'POST', url: `/api/${url}`, headers: HOST, payload });

async function start(w: World, over: Record<string, unknown> = {}, deal: Record<string, unknown> = {}): Promise<string> {
  const res = await post(w, 'rebalance', startBody(over, deal));
  expect(res.statusCode, res.body).toBe(202);
  await settle(w);
  return res.json().data.id as string;
}

const plainDeal = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  a: { symbol: A_CONTRACT, side: 'BUY' },
  b: { symbol: B_CONTRACT, side: 'SELL' },
  qty: '0.152',
  execution: 'maker',
  price: '2500',
  pricePolicy: 'fixed',
  timeoutSec: 240,
  ...over,
});

function writeTwap(w: World, status: Job['status'], over: Partial<Job> = {}): Job {
  const made = newTwapJob(
    {
      userId: null,
      deal: { a: { symbol: A_CONTRACT, side: 'BUY' }, b: { symbol: B_CONTRACT, side: 'SELL' }, execution: 'maker', totalQty: '1.824', coin: 'ETH', rules: [] },
      plan: { slices: 12, sliceQty: '0.152', lastQty: '0.152', intervalSec: 300, durationSec: 3600, takerAfterSec: 240 },
      makerLeg: 'a',
      repegBehindBp: 5,
      takerAfterSec: 240,
      clientId: 'client-lock',
    },
    w.clock.now(),
  );
  const written = { ...made, status, ...over };
  w.jobs.write(written);
  return written;
}

const twapDeps = (w: World, createChild: TwapRunDeps['createChild']): TwapRunDeps => ({
  store: w.store,
  engineWake: () => undefined,
  createChild,
  now: w.clock.now,
  jobs: w.jobs,
  readFees: async () => ({}),
});

const LOT = fx('0.001');
const PLAIN_QTY = /^\d+(\.\d+)?$/;
const onLots = (qty: string): boolean => PLAIN_QTY.test(qty) && fx(qty) % LOT === 0n;
const lotsPart = (qty: string, num: bigint, den: bigint): string => fxStr(fxFloorToStep((fx(qty) * num) / den, LOT));
const rebalanceFiles = (w: World): string[] => readdirSync(w.dataDir).filter((name) => name.startsWith('rebalance'));

const RUNGS = [
  { usd: 50, qty: '0.021' },
  { usd: 5_000, qty: '2.003' },
  { usd: 100_000, qty: '40.007' },
  { usd: 1_000_000, qty: '400.009' },
  { usd: 6_000_000, qty: '2400.011' },
];

describe('TWAP start', { timeout: 30_000 }, () => {
  it('start posts one job', async () => {
    const w = boot();
    const res = await post(w, 'rebalance', startBody());
    expect(res.statusCode, res.body).toBe(202);
    expect(Object.keys(res.json().data)).toEqual(['id']);
    await settle(w);
    const saved = job(w);
    expect(saved.id).toBe(res.json().data.id);
    expect(saved.kind).toBe('twap');
    expect(saved.twap).toMatchObject({ durationSec: 3600, slices: 12, intervalSec: 300 });
    expect(saved.twap!.deal).toMatchObject({ a: { symbol: A_CONTRACT, side: 'BUY' }, b: { symbol: B_CONTRACT, side: 'SELL' }, totalQty: '1.824' });
  });

  it('start refuses over 100 slices', async () => {
    const w = boot();
    const res = await post(w, 'rebalance', startBody({ slices: 101, durationSec: 86_400 }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toContain('101 slices. Max 100');
    expect(w.jobs.read()).toBeNull();
  });

  it('start refuses over 24h', async () => {
    const w = boot();
    const res = await post(w, 'rebalance', startBody({ durationSec: 90_000 }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toBe('Duration at most 24h.');
    expect(w.jobs.read()).toBeNull();
  });

  it('start re-checks venue minimums', async () => {
    const w = boot();
    const cached = [A_CONTRACT, B_CONTRACT].map((symbol) => ({
      symbol,
      state: 'live',
      businessType: 'FUTURE',
      lotSize: '0.001',
      minSize: '0',
      minNotional: '0',
      tickSize: '0.01',
      maxMarketSize: '10000',
      maxLimitSize: '10000',
    }));
    await w.cache.get('rules:all', TTL.static, async () => cached);
    w.gate.rules = [ruleRow(A_CONTRACT, { minSize: '0.2' }), ruleRow(B_CONTRACT)];
    const res = await post(w, 'rebalance', startBody());
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toMatch(/^Hyperliquid takes at least 0\.2 ETH \(\$[\d,.]+\) a slice\.$/);
    expect(w.jobs.read()).toBeNull();
  });

  it('repeated start returns the running job', async () => {
    const w = boot();
    const first = await post(w, 'rebalance', startBody());
    expect(first.statusCode, first.body).toBe(202);
    const second = await post(w, 'rebalance', startBody());
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(readdirSync(w.dataDir).filter((name) => name.startsWith('rebalance'))).toHaveLength(1);
    expect(job(w).id).toBe(first.json().data.id);
  });
});

describe('TWAP slices', { timeout: 30_000 }, () => {
  it('slice 1 at once with the step at 80%', async () => {
    const w = boot();
    const startedAt = w.clock.now();
    await start(w);
    const first = child(w, 1)!;
    expect(first).not.toBeNull();
    expect(first.createdAt).toBe(startedAt);
    expect(first.deadlineAt).toBe(startedAt + 240_000);
  });

  it('slice 2 on the interval', async () => {
    const w = boot();
    const startedAt = w.clock.now();
    await start(w);
    for (let i = 0; i < 8; i += 1) await step(w);
    expect(child(w, 1)!.mode).toBe('DONE');
    await step(w, 50_000);
    expect(child(w, 2)).toBeNull();
    await step(w, 10_000);
    const second = child(w, 2)!;
    expect(second).not.toBeNull();
    expect(second.createdAt).toBe(startedAt + 300_000);
  });

  it('next slice waits for the last child', async () => {
    const w = boot();
    await start(w);
    await tickPair(w.loop, childId(w, 1));
    for (let i = 0; i < 7; i += 1) await step(w);
    w.venue.nextCreate.push('unknown-lost');
    await step(w);
    expect(child(w, 1)!.mode).toBe('CONVERTING');
    await step(w, 60_000);
    expect(child(w, 1)!.mode).toBe('CONVERTING');
    expect(child(w, 2)).toBeNull();
    const view = twapViewOf(job(w), await loadTwapChildren({ store: w.store, readFees: async () => ({}) }, job(w)));
    expect(view.twap!.nextAt).toBeNull();
    for (let i = 0; i < 20 && child(w, 1)!.mode !== 'DONE'; i += 1) {
      await step(w, 10_000);
      if (child(w, 1)!.mode !== 'DONE') expect(child(w, 2)).toBeNull();
    }
    expect(child(w, 1)!.mode).toBe('DONE');
    expect(child(w, 2)!.createdAt).toBe(w.clock.now());
  });

  it('child id dedupes', async () => {
    const w = boot();
    await start(w);
    const id = childId(w, 1);
    await tickPair(w.loop, id);
    const orders = w.venue.orders.size;
    const again = await post(w, 'deals', plainDeal(id, { pricePolicy: 'touch' }));
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().data).toMatchObject({ id, duplicate: true });
    await tickPair(w.loop, id);
    expect(w.venue.orders.size).toBe(orders);
  });

  it('auto maker leg is fixed at the start', async () => {
    const w = boot();
    w.gate.fees = [feeRow('HYPERLIQUID', '0.0002', '0.0005'), feeRow('OKX', '0.0001', '0.0005')];
    await start(w);
    expect(job(w).twap!.makerLeg).toBe('b');
    await runFullSlices(w, 4);
    w.gate.fees = [feeRow('HYPERLIQUID', '0.0001', '0.0005'), feeRow('OKX', '0.0002', '0.0005')];
    w.cache.bust('fees');
    await untilSlice(w, 5);
    expect(child(w, 5)!.a.contract).toBe(B_CONTRACT);
    expect(job(w).twap!.makerLeg).toBe('b');
  });

  it('capped rest joins the next slice', async () => {
    const w = boot();
    await start(w, {}, { clipBandPct: 0.5 });
    await tickPair(w.loop, childId(w, 1));
    for (let i = 0; i < 7; i += 1) await step(w);
    w.venue.nextIocFill.push(0.5, 1, 0, 0, 0, 0, 0, 0, 0, 0);
    await untilSlice(w, 2);
    const first = child(w, 1)!;
    expect(first.mode).toBe('DONE');
    const filled = Number(w.store.listOrders(first.id).filter((o) => o.leg === 'A').reduce((sum, o) => sum + Number(o.cumQty), 0).toFixed(3));
    expect(filled).toBeLessThan(0.152);
    const rest = Number((0.152 - filled).toFixed(3));
    expect(Number(child(w, 2)!.targetQty)).toBeCloseTo(0.152 + rest, 9);
  });

  it('capped rest after the last slice pauses', async () => {
    const w = boot();
    await start(w, { durationSec: 600, slices: 2 }, { qty: '0.304', clipBandPct: 0.5 });
    await runFullSlices(w, 1);
    await untilSlice(w, 2);
    await tickPair(w.loop, childId(w, 2));
    w.venue.nextIocFill.push(0.5, 1, 0, 0, 0, 0, 0, 0, 0, 0);
    for (let i = 0; i < 20 && job(w).status === 'running'; i += 1) await step(w);
    const halted = job(w);
    expect(halted.status).toBe('halted');
    expect(halted.haltKind).toBe('capped-rest');
    expect(halted.haltReason).toMatch(/^[\d.]+ ETH not (closed|opened)$/);
  });

  it('unread fee counts at the schedule', async () => {
    const w = boot();
    await start(w);
    await fillChild(w, childId(w, 1));
    expect(child(w, 1)!.mode).toBe('DONE');
    const view = twapViewOf(job(w), await loadTwapChildren({ store: w.store, readFees: async () => ({}) }, job(w)));
    const orders = w.store.listOrders(childId(w, 1)).filter((o) => Number(o.cumQty) > 0);
    const expected = orders.reduce(
      (sum, o) => sum + (Number(o.cumQty) * Number(o.avgFillPrice) * (o.kind === 'maker' ? 2 : 5)) / 10_000,
      0,
    );
    expect(orders.some((o) => o.kind === 'maker')).toBe(true);
    expect(orders.some((o) => o.kind === 'taker')).toBe(true);
    expect(view.fees.est).toBe(true);
    expect(view.fees.readUsd).toBe(0);
    expect(view.fees.estUsd).toBeCloseTo(expected, 9);
    expect(view.fees.estUsd).toBeCloseTo(0.152 * 2500 * 0.0007, 9);
  });

  it('next slice starts at the best price', async () => {
    const w = boot();
    await start(w);
    const first = childId(w, 1);
    await tickPair(w.loop, first);
    const typed = await post(w, `deals/${first}/repeg`, { price: '2400' });
    expect(typed.statusCode, typed.body).toBe(200);
    expect(w.store.getPair(first)!.repegBehindBp).toBeNull();
    await fillChild(w, first);
    w.venue.bestA = '2490';
    await untilSlice(w, 2);
    const second = child(w, 2)!;
    expect(second.limitPrice).toBe('2490');
    expect(second.pricePolicy).toBe('touch');
    expect(second.repegBehindBp).toBe(5);
  });
});

describe('TWAP pause, resume and stop', { timeout: 30_000 }, () => {
  it('pause stops the live child at once', async () => {
    const w = boot();
    await start(w);
    const id = childId(w, 1);
    await fillChild(w, id, '0.05');
    expect(child(w, 1)!.mode).toBe('OPENING');
    const res = await post(w, `rebalance/${job(w).id}/pause`);
    expect(res.statusCode, res.body).toBe(200);
    expect(child(w, 1)!.mode).toBe('STOPPING');
    await tickLive(w);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(truth.bTrue);
    expect(child(w, 1)!.mode).toBe('DONE');
    await pass(w);
    expect(job(w)).toMatchObject({ status: 'halted', paused: true });
  });

  it('pause waits out an order in doubt', async () => {
    const w = boot();
    await start(w);
    await tickPair(w.loop, childId(w, 1));
    for (let i = 0; i < 7; i += 1) await step(w);
    w.venue.nextCreate.push('unknown-lost');
    await step(w);
    expect(child(w, 1)!.mode).toBe('CONVERTING');
    const res = await post(w, `rebalance/${job(w).id}/pause`);
    expect(res.statusCode, res.body).toBe(200);
    await pass(w);
    expect(child(w, 1)!.mode).not.toBe('DONE');
    expect(job(w)).toMatchObject({ status: 'running', pauseRequested: true });
    for (let i = 0; i < 20 && child(w, 1)!.mode !== 'DONE'; i += 1) {
      await step(w, 10_000);
      if (child(w, 1)!.mode !== 'DONE') expect(job(w)).toMatchObject({ status: 'running', pauseRequested: true });
    }
    expect(child(w, 1)!.mode).toBe('DONE');
    await pass(w);
    expect(job(w)).toMatchObject({ status: 'halted', paused: true });
    expect(child(w, 2)).toBeNull();
  });

  async function pausedAfterThree(): Promise<World> {
    const w = boot();
    await start(w);
    await runFullSlices(w, 2);
    await untilSlice(w, 3);
    await fillChild(w, childId(w, 3), '0.1');
    const res = await post(w, `rebalance/${job(w).id}/pause`);
    expect(res.statusCode, res.body).toBe(200);
    await tickLive(w);
    await pass(w);
    expect(job(w)).toMatchObject({ status: 'halted', paused: true });
    return w;
  }

  it('resume replans the rest', async () => {
    const w = await pausedAfterThree();
    const resumedAt = w.clock.now();
    const res = await post(w, `rebalance/${job(w).id}/resume`);
    expect(res.statusCode, res.body).toBe(200);
    await settle(w);
    const twap = job(w).twap!;
    const next = child(w, 4)!;
    expect(next).not.toBeNull();
    expect(next.createdAt).toBe(resumedAt);
    expect(twap.slices - twap.sliceIndex + 1).toBe(9);
    expect(twap.nextAt).toBe(resumedAt + 300_000);
    const rest = 1.824 - 0.152 * 2 - 0.1;
    expect(twap.sliceQty).toBe('0.157');
    expect(Number(next.targetQty)).toBeCloseTo(Number(twap.sliceQty), 9);
    expect(Number(twap.sliceQty) * 9).toBeLessThanOrEqual(rest + 1e-9);
  });

  it('slice numbers keep counting', async () => {
    const w = await pausedAfterThree();
    await post(w, `rebalance/${job(w).id}/resume`);
    await settle(w);
    expect(w.store.getPair(`${job(w).id}-s4-1`)).not.toBeNull();
    expect(w.store.getPair(`${job(w).id}-s1-2`)).toBeNull();
    expect(w.store.listPairs().filter((pair) => pair.id.endsWith('-s1-1'))).toHaveLength(1);
  });

  it('stop ends a running twap', async () => {
    const w = boot();
    await start(w);
    await fillChild(w, childId(w, 1), '0.05');
    const res = await post(w, `rebalance/${job(w).id}/abandon`);
    expect(res.statusCode, res.body).toBe(200);
    expect(child(w, 1)!.mode).toBe('STOPPING');
    expect(job(w).status).toBe('abandoned');
    for (let i = 0; i < 15; i += 1) await step(w);
    expect(child(w, 1)!.mode).toBe('DONE');
    expect(child(w, 2)).toBeNull();
    expect(job(w).status).toBe('abandoned');
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(truth.bTrue);
  });
});

describe('TWAP restart, sleep and Never', { timeout: 30_000 }, () => {
  it('restart halts before the loop', async () => {
    const w = boot();
    await start(w);
    await runFullSlices(w, 2);
    await untilSlice(w, 3);
    await tickPair(w.loop, childId(w, 3));
    const posted: string[] = [];
    const pending = bootHaltTwap(
      twapDeps(w, async (req) => {
        posted.push(req.id);
      }),
      job(w),
    );
    expect(job(w)).toMatchObject({ status: 'halted', haltKind: 'restart' });
    expect(child(w, 3)!.mode).toBe('STOPPING');
    await pending;
    expect(posted).toEqual([]);
  });

  it('no slice fires after downtime', async () => {
    const w = boot();
    await start(w);
    await runFullSlices(w, 2);
    await untilSlice(w, 3);
    await tickPair(w.loop, childId(w, 3));
    await bootHaltTwap(twapDeps(w, async () => undefined), job(w));
    await w.app.close();
    w.clock.advance(12 * 60_000);
    const again = boot(w);
    await again.app.ready();
    await tickLive(again);
    expect(child(again, 3)!.mode).toBe('DONE');
    expect(child(again, 4)).toBeNull();
    expect(child(again, 5)).toBeNull();
    expect(job(again).status).toBe('halted');
    const res = await post(again, `rebalance/${job(again).id}/resume`);
    expect(res.statusCode, res.body).toBe(200);
    await settle(again);
    expect(child(again, 4)).not.toBeNull();
    expect(child(again, 5)).toBeNull();
  });

  it('sleep halts like a restart', async () => {
    const w = boot();
    await start(w);
    await runFullSlices(w, 2);
    await untilSlice(w, 3);
    await fillChild(w, childId(w, 3), '0.05');
    const iocOnA = () => [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT && o.tif === 'ioc').length;
    expect(iocOnA()).toBe(0);
    w.clock.advance(40 * 60_000);
    await pass(w);
    expect(job(w)).toMatchObject({ status: 'halted', haltKind: 'sleep' });
    expect(child(w, 3)!.mode).toBe('STOPPING');
    await tickLive(w);
    expect(child(w, 3)!.mode).toBe('DONE');
    expect(iocOnA()).toBe(0);
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(truth.bTrue);
  });

  it('never carries the rest', async () => {
    const w = boot();
    await start(w, {}, { timeoutSec: null });
    const first = childId(w, 1);
    expect(w.store.getPair(first)!.deadlineAt).toBeNull();
    await fillChild(w, first, '0.1');
    await untilSlice(w, 2);
    expect(child(w, 1)!.mode).toBe('DONE');
    expect(Number(child(w, 2)!.targetQty)).toBeCloseTo(0.152 + 0.052, 9);
    expect(child(w, 2)!.deadlineAt).toBeNull();
  });

  it('never rest holds the run', async () => {
    const w = boot();
    await start(w, { durationSec: 600, slices: 2 }, { qty: '0.304', timeoutSec: null });
    await untilSlice(w, 2);
    await fillChild(w, childId(w, 2), '0.1');
    for (let i = 0; i < 20; i += 1) await step(w);
    expect(child(w, 2)!.mode).toBe('OPENING');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
    expect(job(w).status).toBe('running');
    const res = await post(w, 'deals', plainDeal('deal-plain-1'));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe(RUNNING_TEXT);
  });
});

describe('TWAP halts', { timeout: 30_000 }, () => {
  it('refused slice halts', async () => {
    const w = boot();
    await start(w);
    await runFullSlices(w, 3);
    await untilSlice(w, 4);
    w.venue.nextCreate.push(...Array.from({ length: 10 }, () => 'reject:INSUFFICIENT_MARGIN' as const));
    for (let i = 0; i < 20 && job(w).status === 'running'; i += 1) await step(w);
    expect(job(w), stateOf(w)).toMatchObject({ status: 'halted', haltKind: 'refused' });
    expect(job(w).haltReason).toBe('Hyperliquid refused slice 4: not enough margin');
    expect(child(w, 5)).toBeNull();
  });

  it('slice under minimum mid-run halts', async () => {
    const w = boot();
    w.gate.rules = [ruleRow(A_CONTRACT), ruleRow(B_CONTRACT, { minNotional: '300' })];
    await start(w);
    await runFullSlices(w, 6);
    w.venue.bestA = '1900';
    w.venue.refPrices.set(A_CONTRACT, '1900');
    w.venue.refPrices.set(B_CONTRACT, '1900');
    for (let i = 0; i < 20 && job(w).status === 'running'; i += 1) await step(w);
    expect(child(w, 7)).toBeNull();
    expect(job(w), stateOf(w)).toMatchObject({ status: 'halted', haltKind: 'refused' });
    expect(job(w).haltReason).toBe("Slice 7 is under OKX's $300 minimum");
  });

  async function hedgeRefused(): Promise<World> {
    const w = boot();
    await start(w);
    const id = childId(w, 1);
    await tickPair(w.loop, id);
    w.venue.nextCreate.push(...Array.from({ length: 20 }, () => 'reject:INSUFFICIENT_MARGIN' as const));
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.152');
    for (let i = 0; i < 20 && w.store.getPair(id)!.mode !== 'HALTED'; i += 1) {
      await tickPair(w.loop, id);
      w.clock.advance(5_000);
    }
    expect(w.store.getPair(id)!).toMatchObject({ mode: 'HALTED', haltKind: 'hedge-margin' });
    w.venue.nextCreate.length = 0;
    await pass(w);
    expect(job(w)).toMatchObject({ status: 'halted', haltKind: 'hedge-margin' });
    return w;
  }

  async function drive<T>(w: World, work: Promise<T>): Promise<T> {
    let done = false;
    const watched = work.finally(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i += 1) {
      w.clock.advance(1_000);
      await tickLive(w, true);
      w.waiters.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return watched;
  }

  it('fix market hedges the gap', async () => {
    const w = await hedgeRefused();
    expect(w.venue.truth().bTrue).toBe(0n);
    const res = await drive(w, post(w, `rebalance/${job(w).id}/fix`, { action: 'market' }));
    expect(res.statusCode, res.body).toBe(200);
    await tickLive(w);
    const truth = w.venue.truth();
    expect(truth.aTrue).toBeGreaterThan(0n);
    expect(truth.bTrue).toBe(truth.aTrue);
    expect(child(w, 1)!.mode).toBe('DONE');
  });

  it('fix unwind closes the filled leg', async () => {
    const w = await hedgeRefused();
    w.gate.positions = [longPosition(A_CONTRACT, '0.152')];
    w.cache.bust('positions');
    const res = await drive(w, post(w, `rebalance/${job(w).id}/fix`, { action: 'unwind' }));
    expect(res.statusCode, res.body).toBe(200);
    const unwind = w.store.getPair(`${job(w).id}-f1`)!;
    expect(unwind, `${res.body} ${stateOf(w)}`).not.toBeNull();
    expect(unwind.b).toBeNull();
    expect(unwind.a).toMatchObject({ contract: A_CONTRACT, side: 'SELL', reduceOnly: true });
    expect(unwind.targetQty).toBe('0.152');
    const sent = w.store.listOrders(unwind.id);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((order) => order.kind === 'taker' && order.leg === 'A')).toBe(true);
    expect(unwind.mode).toBe('DONE');
    expect(sent.reduce((sum, order) => sum + Number(order.cumQty), 0)).toBeCloseTo(0.152, 9);
    expect(w.venue.truth().bTrue).toBe(0n);
  });

  it('resume after hedge-margin does not re-send the filled leg', async () => {
    const w = await hedgeRefused();
    w.gate.positions = [longPosition(A_CONTRACT, '0.152')];
    w.cache.bust('positions');
    const halted = structuredClone(job(w));
    const unwinds = (world: World) => world.store.listPairs().filter((pair) => pair.id.startsWith(`${halted.id}-f`));
    const closed = (world: World): bigint =>
      unwinds(world)
        .flatMap((pair) => world.store.listOrders(pair.id))
        .reduce((sum, order) => sum + fx(order.cumQty), 0n);
    const first = await drive(w, post(w, `rebalance/${halted.id}/fix`, { action: 'unwind' }));
    expect(first.statusCode, first.body).toBe(200);
    expect(closed(w)).toBe(fx('0.152'));
    const calls = w.venue.createCalls.length;
    w.store.updatePair(childId(w, 1), { mode: 'HALTED' });
    w.jobs.write(halted);
    await w.app.close();
    const again = boot(w);
    await again.app.ready();
    const second = await drive(again, post(again, `rebalance/${halted.id}/fix`, { action: 'unwind' }));
    expect(second.statusCode, second.body).toBe(200);
    expect(unwinds(again)).toHaveLength(1);
    expect(again.venue.createCalls).toHaveLength(calls);
    expect(closed(again)).toBe(fx('0.152'));
    const third = await post(again, `rebalance/${halted.id}/fix`, { action: 'unwind' });
    expect(third.statusCode, third.body).toBe(409);
    expect(again.venue.createCalls).toHaveLength(calls);
    expect(again.venue.truth().aTrue).toBe(fx('0.304'));
    expect(again.venue.truth().bTrue).toBe(0n);
  });

  async function childError(): Promise<World> {
    const w = boot();
    await start(w);
    const id = childId(w, 1);
    await tickPair(w.loop, id);
    w.store.updatePair(id, { mode: 'HALTED', haltReason: 'order in doubt' });
    await pass(w);
    return w;
  }

  it('child error halts the job with an alert', async () => {
    const w = await childError();
    expect(job(w)).toMatchObject({ status: 'halted', haltKind: 'error' });
    const alerts = w.store.listAlerts({ unackedOnly: true }).map((row) => row.message);
    expect(alerts).toContain('Slice 1 stopped on an error. Check the orders, then resume or stop.');
  });

  it('no telegram on a twap error', async () => {
    const w = await childError();
    expect(job(w).haltKind).toBe('error');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.gate.botCalls).toBe(0);
  });
});

describe('TWAP lock', { timeout: 30_000 }, () => {
  it('lock refuses a plain deal', async () => {
    const w = boot();
    writeTwap(w, 'running');
    const res = await post(w, 'deals', plainDeal('deal-plain-1'));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe(RUNNING_TEXT);
  });

  it("lock passes the job's child", async () => {
    const w = boot();
    const running = writeTwap(w, 'running');
    const res = await post(w, 'deals', plainDeal(`${running.id}-s3-1`));
    expect(res.statusCode, res.body).toBe(202);
    expect(w.store.getPair(`${running.id}-s3-1`)).not.toBeNull();
  });

  it('lock refuses a fake child id', async () => {
    const w = boot();
    const running = writeTwap(w, 'running');
    const res = await post(w, 'deals', plainDeal(`${running.id}-x`));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe(RUNNING_TEXT);
    expect(w.store.getPair(`${running.id}-x`)).toBeNull();
  });

  it('paused lets transfers through', async () => {
    const w = boot();
    w.gate.account = transferAccount;
    writeTwap(w, 'halted', { paused: true });
    const res = await post(w, 'transfer', HL_OUT);
    expect(res.statusCode, res.body).toBe(202);
  });

  it('paused refuses deals', async () => {
    const w = boot();
    writeTwap(w, 'halted', { paused: true });
    const res = await post(w, 'deals', plainDeal('deal-plain-1'));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe(PAUSED_TEXT);
  });

  it('error halt blocks transfers', async () => {
    const w = boot();
    const running = writeTwap(w, 'running');
    const id = `${running.id}-s1-1`;
    const made = await post(w, 'deals', plainDeal(id));
    expect(made.statusCode, made.body).toBe(202);
    w.store.updatePair(id, { mode: 'HALTED', haltReason: 'order in doubt' });
    w.jobs.write({ ...job(w), status: 'halted', haltKind: 'error', haltReason: 'Slice 1 stopped on an error. Check the orders, then resume or stop.' });
    w.gate.account = transferAccount;
    const res = await post(w, 'transfer', HL_OUT);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe(ERROR_TEXT);
  });
});

describe('TWAP money paths at size', { timeout: 60_000 }, () => {
  async function refusesStart(w: World, texts: string[]): Promise<void> {
    const before = w.jobs.read()?.id ?? null;
    const files = rebalanceFiles(w).length;
    const orders = w.venue.orders.size;
    const res = await post(w, 'rebalance', startBody({ clientId: 'client-new' }));
    expect(res.statusCode, res.body).toBe(409);
    expect(texts).toContain(res.json().error.message);
    expect(rebalanceFiles(w)).toHaveLength(files);
    expect(w.jobs.read()?.id ?? null).toBe(before);
    expect(w.venue.orders.size).toBe(orders);
    expect(w.store.listPairs().filter((pair) => pair.id.startsWith('deal-twap'))).toHaveLength(0);
  }

  it('start refuses while another twap runs', async () => {
    const w = boot();
    const running = writeTwap(w, 'running');
    await refusesStart(w, [RUNNING_TEXT, `rebalance ${running.id} is running`]);
  });

  it('start refuses while a delever job runs', async () => {
    const w = boot();
    await w.app.ready();
    const running = writeTwap(w, 'running', { kind: 'delever' });
    await refusesStart(w, [`rebalance ${running.id} is running`]);
  });

  it('start refuses while a transfer moves', async () => {
    const w = boot();
    w.gate.account = transferAccount;
    const moving = await post(w, 'transfer', HL_OUT);
    expect(moving.statusCode, moving.body).toBe(202);
    await refusesStart(w, ['Rebalance waits until the transfer ends.']);
    expect(w.jobs.read()).toBeNull();
  });

  it('two simultaneous starts make one job', async () => {
    const w = boot();
    const [first, second] = await Promise.all([post(w, 'rebalance', startBody()), post(w, 'rebalance', startBody())]);
    expect(first.statusCode, first.body).toBe(202);
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().data.id).toBe(first.json().data.id);
    await settle(w);
    expect(rebalanceFiles(w)).toHaveLength(1);
    expect(job(w).id).toBe(first.json().data.id);
    expect(w.store.listPairs().filter((pair) => isChildOf(job(w).id, pair.id)).map((pair) => pair.id)).toEqual([childId(w, 1)]);
    await tickLive(w);
    expect(w.venue.createCalls).toHaveLength(1);
  });

  it.each(RUNGS)('start at $usd dollars keeps every qty a plain decimal on whole lots', async ({ qty }) => {
    const w = boot();
    await start(w, {}, { qty });
    const twap = job(w).twap!;
    expect(twap.deal.totalQty).toBe(qty);
    expect(onLots(twap.sliceQty)).toBe(true);
    const last = fx(qty) - fx(twap.sliceQty) * BigInt(twap.slices - 1);
    expect(last >= fx(twap.sliceQty)).toBe(true);
    expect(last % LOT).toBe(0n);
    const first = child(w, 1)!;
    expect(first.targetQty).toBe(twap.sliceQty);
    await fillChild(w, first.id);
    expect(child(w, 1)!.mode).toBe('DONE');
    const orders = w.store.listOrders(first.id);
    expect(orders.length).toBeGreaterThan(1);
    for (const order of orders) {
      expect(onLots(order.qty), order.qty).toBe(true);
      expect(onLots(order.cumQty), order.cumQty).toBe(true);
    }
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(fx(twap.sliceQty));
    expect(truth.bTrue).toBe(truth.aTrue);
  });

  it('start with a slice over the venue max market size re-plans', async () => {
    const w = boot();
    w.gate.rules = [ruleRow(A_CONTRACT, { maxSize: '500' }), ruleRow(B_CONTRACT)];
    const over = await post(w, 'rebalance', startBody({ durationSec: 86_400, slices: 2 }, { qty: '3468' }));
    expect(over.statusCode, over.body).toBe(400);
    expect(over.json().error.message).toMatch(/^\S+ takes at most 500 ETH a slice\.$/);
    expect(w.jobs.read()).toBeNull();
    expect(w.venue.createCalls).toHaveLength(0);
    await start(w, { durationSec: 86_400, slices: 100, clientId: 'client-2' }, { qty: '3468' });
    const twap = job(w).twap!;
    expect(twap.slices).toBe(100);
    expect(fx(twap.sliceQty) <= fx('500')).toBe(true);
    expect(fx(child(w, 1)!.targetQty) <= fx('500')).toBe(true);
    expect(fx(twap.deal.totalQty) - fx(twap.sliceQty) * 99n <= fx('500')).toBe(true);
  });

  it('a child posted before the job write is found by id on boot', async () => {
    const w = boot();
    await start(w);
    const first = childId(w, 1);
    await tickPair(w.loop, first);
    const sent = w.store.listOrders(first).length;
    expect(sent).toBeGreaterThan(0);
    const calls = w.venue.createCalls.length;
    w.jobs.write({ ...job(w), twap: { ...job(w).twap!, sliceIndex: 0, nextAt: null } });
    await bootHaltTwap(twapDeps(w, async () => undefined), job(w));
    await w.app.close();
    const again = boot(w);
    await again.app.ready();
    await tickLive(again);
    expect(child(again, 1)!.mode).toBe('DONE');
    expect(job(again)).toMatchObject({ status: 'halted', haltKind: 'restart' });
    const resumedAt = again.clock.now();
    const res = await post(again, `rebalance/${job(again).id}/resume`);
    expect(res.statusCode, res.body).toBe(200);
    await settle(again);
    expect(again.store.listPairs().filter((pair) => pair.id.endsWith('-s1-1'))).toHaveLength(1);
    expect(again.store.listOrders(first)).toHaveLength(sent);
    expect(again.venue.createCalls).toHaveLength(calls);
    expect(job(again).twap!.sliceIndex).toBe(1);
    await untilSlice(again, 2);
    expect(child(again, 2)!.createdAt).toBe(resumedAt + 300_000);
    expect(fx(child(again, 2)!.targetQty) <= fx('1.824')).toBe(true);
  });

  it('a carry over the venue max halts the run and resume re-plans under the max', async () => {
    const w = boot();
    w.gate.rules = [ruleRow(A_CONTRACT, { maxSize: '0.2' }), ruleRow(B_CONTRACT)];
    await start(w, {}, { timeoutSec: null });
    await fillChild(w, childId(w, 1), '0.076');
    const calls = w.venue.createCalls.length;
    for (let i = 0; i < 20 && job(w).status === 'running'; i += 1) await step(w);
    expect(job(w), stateOf(w)).toMatchObject({ status: 'halted', haltKind: 'refused' });
    expect(job(w).haltReason).toMatch(/^Slice 2 is over \S+'s 0\.2 ETH maximum$/);
    expect(child(w, 1)!.mode).toBe('DONE');
    expect(child(w, 2)).toBeNull();
    expect(w.venue.createCalls).toHaveLength(calls);
    const res = await post(w, `rebalance/${job(w).id}/resume`);
    expect(res.statusCode, res.body).toBe(200);
    await settle(w);
    const twap = job(w).twap!;
    expect(fx(twap.sliceQty) <= fx('0.2')).toBe(true);
    for (let slice = 2; slice <= twap.slices; slice += 1) {
      await untilSlice(w, slice);
      const target = child(w, slice)!.targetQty;
      expect(onLots(target), target).toBe(true);
      expect(fx(target) <= fx('0.2'), `slice ${slice} ${target}`).toBe(true);
      await fillChild(w, childId(w, slice));
    }
    for (let i = 0; i < 20 && job(w).status === 'running'; i += 1) await step(w);
    expect(job(w), stateOf(w)).toMatchObject({ status: 'done' });
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(fx('1.824'));
    expect(truth.bTrue).toBe(truth.aTrue);
  });

  it('a maker part fill rolls its rest into the next slice on whole lots', async () => {
    const w = boot();
    await start(w, {}, { qty: '400.009', timeoutSec: null });
    const sliceQty = job(w).twap!.sliceQty;
    const half = lotsPart(sliceQty, 1n, 2n);
    await fillChild(w, childId(w, 1), half);
    await untilSlice(w, 2);
    expect(child(w, 1)!.mode).toBe('DONE');
    const next = child(w, 2)!.targetQty;
    expect(onLots(next), next).toBe(true);
    expect(fx(next)).toBe(fx(sliceQty) * 2n - fx(half));
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(fx(half));
    expect(truth.bTrue).toBe(truth.aTrue);
  });

  it('a second boot does not stop or post twice', async () => {
    const w = boot();
    await start(w);
    await runFullSlices(w, 2);
    await untilSlice(w, 3);
    await tickPair(w.loop, childId(w, 3));
    const posted: string[] = [];
    const record = async (req: { id: string }): Promise<void> => {
      posted.push(req.id);
    };
    const alerts = w.store.listAlerts().length;
    await bootHaltTwap(twapDeps(w, record), job(w));
    expect(child(w, 3)!.mode).toBe('STOPPING');
    await tickLive(w);
    expect(child(w, 3)!.mode).toBe('DONE');
    const halted = job(w);
    const calls = w.venue.createCalls.length;
    await w.app.close();
    const again = boot(w);
    await again.app.ready();
    await bootHaltTwap(twapDeps(again, record), job(again));
    await tickLive(again);
    expect(posted).toEqual([]);
    expect(job(again)).toMatchObject({ status: 'halted', haltKind: 'restart', haltReason: halted.haltReason });
    expect(child(again, 3)!.mode).toBe('DONE');
    expect(child(again, 4)).toBeNull();
    expect(again.venue.createCalls).toHaveLength(calls);
    expect(again.store.listAlerts()).toHaveLength(alerts);
  });

  it.each(RUNGS)('restart at $usd dollars stops the child and leaves no gap', async ({ qty }) => {
    const w = boot();
    await start(w, { durationSec: 600, slices: 2 }, { qty });
    const id = childId(w, 1);
    const half = lotsPart(job(w).twap!.sliceQty, 1n, 2n);
    await fillChild(w, id, half);
    expect(child(w, 1)!.mode).toBe('OPENING');
    await bootHaltTwap(twapDeps(w, async () => undefined), job(w));
    expect(job(w)).toMatchObject({ status: 'halted', haltKind: 'restart' });
    await tickLive(w);
    expect(child(w, 1)!.mode).toBe('DONE');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    expect(w.venue.liveOrder(B_CONTRACT)).toBeUndefined();
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(fx(half));
    expect(truth.bTrue).toBe(truth.aTrue);
    for (const order of w.store.listOrders(id)) {
      expect(onLots(order.qty), order.qty).toBe(true);
      expect(onLots(order.cumQty), order.cumQty).toBe(true);
    }
  });

  it('sleep with a part-filled maker hedges the filled part only', async () => {
    const w = boot();
    await start(w, {}, { qty: '400.009' });
    const id = childId(w, 1);
    const part = lotsPart(job(w).twap!.sliceQty, 3n, 10n);
    const maker = child(w, 1)!.a.contract;
    const hedge = child(w, 1)!.b!.contract;
    const iocs = (contract: string) => [...w.venue.orders.values()].filter((order) => order.contract === contract && order.tif === 'ioc');
    await fillChild(w, id, part);
    expect(iocs(maker)).toHaveLength(0);
    w.clock.advance(40 * 60_000);
    await pass(w);
    expect(job(w)).toMatchObject({ status: 'halted', haltKind: 'sleep' });
    expect(child(w, 1)!.mode).toBe('STOPPING');
    await tickLive(w);
    expect(child(w, 1)!.mode).toBe('DONE');
    expect(iocs(maker)).toHaveLength(0);
    expect(iocs(hedge).reduce((sum, order) => sum + order.cum, 0n)).toBe(fx(part));
    const truth = w.venue.truth();
    expect(truth.aTrue).toBe(truth.bTrue);
    expect(w.venue.liveOrder(maker)).toBeUndefined();
  });
});
