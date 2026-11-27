import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import type { OrderRow } from '../../src/engine/types';
import { TtlCache } from '../../src/server/cache';
import { childIdFor, JobFile, newTwapJob, REOPEN_HALT, TransferFile, type Job, type TwapDealTemplate } from '../../src/server/rebalanceJob';
import { readChildFees, type TradePage, type TradeRow } from '../../src/server/routes/rebalance';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { fixture, gate, HOST, makeTestApp } from './helpers/gate-nock';

const API = '/api/v4';
const BOT_HOST = 'https://boros-bot-notification.pendle.finance';
const RUNNING_TEXT = 'A TWAP is running. Orders and transfers wait until it ends.';
const PAUSED_TEXT = 'A TWAP is paused. Orders wait until it ends.';
const ERROR_TEXT = 'A TWAP stopped on an error. Orders wait until you resume or stop it.';

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

function mockVenueReads(): void {
  gate().persist().get(`${API}/crossex/rule/symbols`).query(true).reply(200, [ruleRow(A_CONTRACT), ruleRow(B_CONTRACT)]);
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, fixture('account.json'));
  gate().persist().get(`${API}/crossex/fee`).query(true).reply(500, { label: 'SERVER_ERROR', message: 'no fee read' });
  const cap = (symbol: string) => ({ symbol, tiers: [{ max_risk_limit_value: '1000000000', leverage_max: '50' }] });
  gate().persist().get(`${API}/crossex/rule/risk_limits`).query(true).reply(200, [cap(A_CONTRACT), cap(B_CONTRACT)]);
  gate().persist().get(`${API}/crossex/positions`).query(true).reply(200, []);
  gate().persist().get(`${API}/crossex/open_orders`).query(true).reply(200, []);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) nock(BOT_HOST).persist().intercept(/.*/, method).reply(200, {});
}

interface World {
  app: FastifyInstance;
  store: Store;
  jobs: JobFile;
}

async function boot(seed?: (store: Store, jobs: JobFile) => void): Promise<World> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'twap-lock-'));
  const store = new Store(':memory:');
  const jobs = new JobFile(dataDir);
  seed?.(store, jobs);
  const park = (): Promise<void> => new Promise<void>(() => undefined);
  const app = makeTestApp({
    cache: new TtlCache(),
    dataDir,
    engine: { store, venue: new FakeVenue(), clock: new VirtualClock() },
    rebalance: { jobs, sleep: park },
    transfer: { jobs: new TransferFile(dataDir), sleep: park },
  });
  apps.push(app);
  await app.ready();
  mockVenueReads();
  return { app, store, jobs };
}

const TEMPLATE: TwapDealTemplate = {
  a: { symbol: A_CONTRACT, side: 'BUY' },
  b: { symbol: B_CONTRACT, side: 'SELL' },
  execution: 'maker',
  totalQty: '1.824',
  coin: 'ETH',
  rules: [],
};

function twapJob(over: Partial<Job> = {}): Job {
  const plan = { slices: 12, sliceQty: '0.152', lastQty: '0.152', intervalSec: 300, durationSec: 3600, takerAfterSec: 240 };
  const job = newTwapJob({ userId: '1', deal: TEMPLATE, plan, makerLeg: 'a', repegBehindBp: 5, takerAfterSec: 240, clientId: 'client-1' }, 1_000);
  return { ...job, ...over };
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

const twapStart = (over: Record<string, unknown> = {}, deal: Record<string, unknown> = {}) => ({
  kind: 'twap',
  clientId: 'client-2',
  durationSec: 3600,
  slices: 12,
  deal: dealBody(deal),
  ...over,
});

const STARTS: Record<string, Record<string, unknown>> = {
  move: { kind: 'move', goal: 'even', route: 'mix', costUsd: 0, realizeQty: [] },
  realize: { kind: 'realize', exec: 'maker', costUsd: 0, realizeTarget: 'all' },
  delever: { kind: 'delever', exec: 'maker', costUsd: 0, delever: { perps: [{ symbol: A_CONTRACT, qty: 1 }], boros: [], exec: 'maker' } },
  twap: twapStart(),
};

const post = (w: World, payload: Record<string, unknown>) =>
  w.app.inject({ method: 'POST', url: '/api/rebalance', headers: HOST, payload });

describe('a TWAP that is not done refuses every rebalance start', () => {
  const cases: Array<[string, Partial<Job>, string]> = [
    ['paused', { status: 'halted', haltKind: null }, PAUSED_TEXT],
    ['stopped on an error', { status: 'halted', haltKind: 'error' }, ERROR_TEXT],
    ['running', { status: 'running' }, RUNNING_TEXT],
  ];
  for (const [state, over, text] of cases) {
    for (const [kind, body] of Object.entries(STARTS)) {
      it(`${state} TWAP with no live slice refuses a ${kind} start and keeps its record`, async () => {
        const held = twapJob(over);
        const w = await boot((_store, jobs) => jobs.write(held));
        const res = await post(w, body);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error.message).toBe(text);
        expect(w.jobs.read()?.id).toBe(held.id);
        expect(w.jobs.read()?.kind).toBe('twap');
      });
    }
  }
});

describe('a TWAP stopped on an error refuses a plain deal with the text that matches its slice', () => {
  const liveChild = (store: Store, job: Job): void => {
    const leg = (symbol: string, side: 'BUY' | 'SELL') => ({ contract: symbol, side, lot: '0.001', minSize: '0.001', minNotional: '0', tick: '0.01' });
    store.createPair({
      id: childIdFor(job.id, 1, 1),
      mode: 'OPENING',
      a: leg(A_CONTRACT, 'BUY'),
      b: leg(B_CONTRACT, 'SELL'),
      targetQty: '0.152',
      limitPrice: '3000',
      pricePolicy: 'touch',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      repegBehindBp: 5,
      repegAutoBp: 5,
      repegNotBefore: 0,
      haltKind: null,
      haltReason: null,
      reportJson: null,
      createdAt: 1_000,
    });
  };

  it.each([
    ['no live slice', false, ERROR_TEXT],
    ['a live slice', true, 'A TWAP stopped on an error. Orders and transfers wait until you resume or stop it.'],
  ])('with %s', async (_name, live, text) => {
    const held = twapJob({ status: 'halted', haltKind: 'error' });
    const w = await boot((store, jobs) => {
      jobs.write(held);
      if (live) liveChild(store, held);
    });
    const res = await w.app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: dealBody() });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe(text);
  });
});

describe('TWAP start checks the size and runs the plan the ticket showed', () => {
  it('refuses a size with an exponent', async () => {
    const w = await boot();
    const res = await post(w, twapStart({}, { qty: '2e3' }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toBe('qty must be a positive decimal string');
    expect(w.jobs.read()).toBeNull();
  });

  it('refuses a size that is not a whole number of lots', async () => {
    const w = await boot();
    const res = await post(w, twapStart({}, { qty: '1.8245' }));
    expect(res.statusCode, res.body).toBe(400);
    expect(w.jobs.read()).toBeNull();
  });

  it('keeps a typed 7 minute interval instead of spreading the slices over the hour', async () => {
    const w = await boot();
    const res = await post(w, twapStart({ durationSec: 3600, slices: 8, intervalSec: 420, sliceQty: '0.228' }));
    expect(res.statusCode, res.body).toBe(202);
    expect(w.jobs.read()?.twap).toMatchObject({ slices: 8, intervalSec: 420, sliceQty: '0.228' });
  });

  it('keeps a typed slice size instead of evening the slices out', async () => {
    const w = await boot();
    const res = await post(w, twapStart({ durationSec: 2400, slices: 4, intervalSec: 600, sliceQty: '0.5' }));
    expect(res.statusCode, res.body).toBe(202);
    expect(w.jobs.read()?.twap).toMatchObject({ slices: 4, intervalSec: 600, sliceQty: '0.5' });
  });

  it('refuses when the plan no longer matches the ticket', async () => {
    const w = await boot();
    const res = await post(w, twapStart({ durationSec: 3600, slices: 12, intervalSec: 300, sliceQty: '0.3' }));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ label: 'PLAN_CHANGED', message: 'The TWAP plan changed. Check the new slices before you start.' });
    expect(w.jobs.read()).toBeNull();
  });
});

describe('a Delever TWAP at boot', () => {
  it('stops its live slice and waits for Resume', async () => {
    const job = twapJob({ kind: 'delever', status: 'running', deleverTwap: { durationSec: 3600, intervalSec: 300, slices: 12 } });
    const childId = childIdFor(job.id, 1, 1);
    const leg = (symbol: string, side: 'BUY' | 'SELL') => ({ contract: symbol, side, lot: '0.001', minSize: '0.001', minNotional: '0', tick: '0.01' });
    const w = await boot((store, jobs) => {
      jobs.write(job);
      store.createPair({
        id: childId,
        mode: 'OPENING',
        a: leg(A_CONTRACT, 'BUY'),
        b: leg(B_CONTRACT, 'SELL'),
        targetQty: '0.152',
        limitPrice: '3000',
        pricePolicy: 'touch',
        deadlineAt: null,
        makerNotBefore: 0,
        hedgeNotBefore: 0,
        pocRejects: 0,
        hedgeRejectStreak: 0,
        maxClip: null,
        clipBandBp: null,
        repegBehindBp: 5,
        repegAutoBp: 5,
        repegNotBefore: 0,
        haltKind: null,
        haltReason: null,
        reportJson: null,
        createdAt: 1_000,
      });
    });
    expect(w.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'restart' });
    expect(w.store.getPair(childId)?.mode).not.toBe('OPENING');
  });
});

describe('readChildFees', () => {
  const order = (pairId: string, venueOrderId: string, cumQty: string): OrderRow => ({ pairId, venueOrderId, cumQty, createdAt: 600_000 }) as OrderRow;
  const storeOf = (orders: OrderRow[]) => ({ listOrders: (id: string) => orders.filter((row) => row.pairId === id) });
  const pages = (...rows: TradeRow[][]): { list: TradePage; froms: number[] } => {
    const froms: number[] = [];
    return {
      froms,
      list: async ({ page, from }) => {
        froms.push(from);
        return rows[page - 1] ?? [];
      },
    };
  };

  it('reads the venue fee of a $50 slice', async () => {
    const read = pages([{ orderId: 'v1', qty: '0.02', fee: '0.01', feeCoin: 'USDT' }]);
    expect(await readChildFees(storeOf([order('d1', 'v1', '0.02')]), read.list, ['d1'])).toEqual({ d1: 0.01 });
    expect(read.froms).toEqual([540_000]);
  });

  it('sums every fill of a $6M slice across pages', async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({ orderId: `other${i}`, qty: '1', fee: '1', feeCoin: 'USDT' }));
    const read = pages([...filler.slice(0, 999), { orderId: 'v1', qty: '1500', fee: '900', feeCoin: 'USDT' }], [{ orderId: 'v2', qty: '500', fee: '300', feeCoin: 'USDC' }]);
    const orders = [order('d1', 'v1', '1500'), order('d1', 'v2', '500')];
    expect(await readChildFees(storeOf(orders), read.list, ['d1'])).toEqual({ d1: 1200 });
  });

  it('leaves a slice estimated while part of its fill is not in the history yet', async () => {
    const read = pages([{ orderId: 'v1', qty: '1500', fee: '900', feeCoin: 'USDT' }]);
    expect(await readChildFees(storeOf([order('d1', 'v1', '2000')]), read.list, ['d1'])).toEqual({});
  });

  it('leaves a slice estimated when the fee is not in dollars', async () => {
    const read = pages([{ orderId: 'v1', qty: '0.02', fee: '0.5', feeCoin: 'GT' }]);
    expect(await readChildFees(storeOf([order('d1', 'v1', '0.02')]), read.list, ['d1'])).toEqual({});
  });

  it('reads nothing when no slice has filled', async () => {
    const read = pages();
    expect(await readChildFees(storeOf([order('d1', 'v1', '0')]), read.list, ['d1'])).toEqual({});
    expect(read.froms).toEqual([]);
  });
});

describe('close-only halt text', () => {
  const leg = { exchange: 'GATE', side: 'SHORT' as const, base: 'ETH', hedge: 'HYPERLIQUID' };

  it('names the size to close when part of the leg is open', () => {
    expect(REOPEN_HALT.closeOnly(leg, 53.8)).toBe(
      'Gate CrossEx takes no new orders on this contract. Resume when it does, or close 53.8 ETH of the Hyperliquid long in Positions.',
    );
  });

  it('ends at Resume when nothing is open yet', () => {
    expect(REOPEN_HALT.closeOnly(leg, 0)).toBe('Gate CrossEx takes no new orders on this contract. Resume when it does.');
    expect(REOPEN_HALT.closeOnly(leg, -0.001)).toBe('Gate CrossEx takes no new orders on this contract. Resume when it does.');
  });
});
