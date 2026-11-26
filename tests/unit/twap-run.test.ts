import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import type { NormalizedBook } from '../../src/core/estimate/books';
import type { VenueFeeRow } from '../../src/core/estimate/fees';
import { makerLegOf } from '../../src/core/preview';
import { planSlices, type TwapLegRule } from '../../src/core/twap';
import type { DealRequest } from '../../src/engine/create';
import { Store } from '../../src/engine/db';
import { commands } from '../../src/engine/loop';
import type { OrderRow, PairMode, PairRow } from '../../src/engine/types';
import {
  childIdFor,
  dealLockFor,
  isChildOf,
  type Job,
  JobFile,
  LOCK_TEXT,
  newJob,
  newTwapJob,
  requestPause,
  type TwapDealTemplate,
  transferLockFor,
} from '../../src/server/rebalanceJob';
import {
  bootHaltTwap,
  borosShareOf,
  loadTwapChildren,
  runTwap,
  sleepHaltTwap,
  stopLiveChild,
  type TwapRunDeps,
  twapViewOf,
} from '../../src/server/twapRun';

const T0 = Date.UTC(2026, 10, 25, 14, 0, 0);
const MIN = 60_000;

const ETH_RULES: TwapLegRule[] = [
  { venue: 'GATE', coin: 'ETH', lot: '0.001', minSize: '0.001', minNotional: '0', maxMarketSize: '100000', maxLimitSize: '100000' },
  { venue: 'HYPERLIQUID', coin: 'ETH', lot: '0.0001', minSize: '0.0001', minNotional: '10', maxMarketSize: null, maxLimitSize: null },
];

const BTC_RULES: TwapLegRule[] = [
  { venue: 'GATE', coin: 'BTC', lot: '0.0001', minSize: '0.0001', minNotional: '0', maxMarketSize: '1200', maxLimitSize: '1200' },
  { venue: 'BINANCE', coin: 'BTC', lot: '0.001', minSize: '0.001', minNotional: '50', maxMarketSize: '120', maxLimitSize: '1000' },
];

const ethOpen = (totalQty: string): TwapDealTemplate => ({
  a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' },
  b: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'SELL' },
  execution: 'maker',
  totalQty,
  coin: 'ETH',
  rules: ETH_RULES,
});

const ethClose = (totalQty: string): TwapDealTemplate => ({
  a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', reduceOnly: true },
  b: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'BUY', reduceOnly: true },
  execution: 'maker',
  clipBandPct: 0.5,
  totalQty,
  coin: 'ETH',
  rules: ETH_RULES,
});

interface World {
  t: number;
  store: Store;
  jobs: JobFile;
  requests: DealRequest[];
  refuse: unknown;
  wakes: number;
  fees: Record<string, number>;
  deps: TwapRunDeps;
}

let w: World;

function makeWorld(): World {
  const world = {
    t: T0,
    store: new Store(':memory:'),
    requests: [] as DealRequest[],
    refuse: null as unknown,
    wakes: 0,
    fees: {} as Record<string, number>,
  } as World;
  world.jobs = new JobFile(fs.mkdtempSync(path.join(tmpdir(), 'twap-run-')), () => world.t);
  world.deps = {
    store: world.store,
    engineWake: () => {
      world.wakes += 1;
    },
    now: () => world.t,
    jobs: world.jobs,
    readFees: async (ids) => Object.fromEntries(ids.filter((id) => id in world.fees).map((id) => [id, world.fees[id]])),
    createChild: async (req) => {
      world.requests.push(req);
      if (world.refuse) throw world.refuse;
      const [a, b] = req.makerLeg === 'b' && req.b ? [req.b, req.a] : [req.a, req.b ?? null];
      const spec = (leg: { symbol: string; side: 'BUY' | 'SELL'; reduceOnly?: boolean }) => ({
        contract: leg.symbol,
        side: leg.side,
        lot: '0.001',
        minSize: '0.001',
        minNotional: '0',
        tick: '0.01',
        ...(leg.reduceOnly ? { reduceOnly: true } : {}),
      });
      world.store.createPair({
        id: req.id,
        mode: 'OPENING',
        a: spec(a),
        b: b ? spec(b) : null,
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

function startJob(deal: TwapDealTemplate, opts: { durationSec?: number; slices?: number; takerAfterSec?: number | null; makerLeg?: 'a' | 'b'; mark?: number } = {}): Job {
  const result = planSlices(deal.totalQty, { durationSec: opts.durationSec ?? 3600, slices: opts.slices ?? 12 }, deal.rules, opts.mark ?? 3000);
  if (!result.plan) throw new Error('no plan');
  const job = newTwapJob(
    {
      userId: 'u1',
      deal,
      plan: result.plan,
      makerLeg: opts.makerLeg ?? 'a',
      repegBehindBp: 5,
      takerAfterSec: opts.takerAfterSec === undefined ? result.plan.takerAfterSec : opts.takerAfterSec,
      clientId: 'client-1',
    },
    w.t,
  );
  w.jobs.write(job);
  return job;
}

const at = (ms: number): void => {
  w.t = ms;
};

const pass = async (job: Job): Promise<Job> => {
  await runTwap(w.deps, job);
  return w.jobs.read() as Job;
};

function fill(id: string, filledA: string, price: string, opts: { mode?: PairMode; filledB?: string; bPrice?: string; aKind?: OrderRow['kind'] } = {}): void {
  const pair = w.store.getPair(id) as PairRow;
  const a = w.store.insertPendingOrder({ pairId: id, leg: 'A', kind: opts.aKind ?? 'maker', side: pair.a.side, qty: pair.targetQty, price, tif: 'poc', now: w.t });
  w.store.updateOrder(id, 'A', a.seq, { state: 'CLOSED', cumQty: filledA, avgFillPrice: filledA === '0' ? '0' : price, resolvedAt: w.t });
  if (pair.b) {
    const filledB = opts.filledB ?? filledA;
    const b = w.store.insertPendingOrder({ pairId: id, leg: 'B', kind: 'taker', side: pair.b.side, qty: filledB, price: null, tif: 'ioc', now: w.t + 1 });
    w.store.updateOrder(id, 'B', b.seq, { state: 'CLOSED', cumQty: filledB, avgFillPrice: opts.bPrice ?? price, resolvedAt: w.t });
  }
  w.store.updatePair(id, { mode: opts.mode ?? 'DONE' });
}

const advance = async (job: Job, to: number): Promise<Job> => {
  while (w.t + 30_000 < to) {
    w.t += 30_000;
    await runTwap(w.deps, job);
  }
  w.t = to;
  return pass(job);
};

const ids = (): string[] => w.requests.map((req) => req.id);

beforeEach(() => {
  w = makeWorld();
});

describe('twap child ids', () => {
  it('names a child by slice and part', () => {
    expect(childIdFor('mh1x2k3', 4, 1)).toBe('mh1x2k3-s4-1');
  });

  it('matches only the slice and add-back shapes', () => {
    expect(isChildOf('mh1x2k3', 'mh1x2k3-s3-1')).toBe(true);
    expect(isChildOf('mh1x2k3', 'mh1x2k3-f2')).toBe(true);
    expect(isChildOf('mh1x2k3', 'mh1x2k3-x')).toBe(false);
    expect(isChildOf('mh1x2k3', 'mh1x2k3-s3')).toBe(false);
    expect(isChildOf('mh1x2k3', 'mh1x2k3-s0-1')).toBe(false);
    expect(isChildOf('mh1x2k3', 'other-s3-1')).toBe(false);
    expect(isChildOf('mh1x2k3', 'mh1x2k3x-s3-1')).toBe(false);
  });
});

describe('twap schedule', () => {
  it('slice 1 at once with the step at 80%', async () => {
    const job = startJob(ethOpen('60'));
    const after = await pass(job);
    expect(ids()).toEqual([`${job.id}-s1-1`]);
    expect(w.requests[0]).toMatchObject({ qty: '5', timeoutSec: 240, deadlineCapSec: 240, repegBehindBp: 5, makerLeg: 'a', pricePolicy: 'touch' });
    expect(w.requests[0].price).toBeUndefined();
    expect(w.store.getPair(`${job.id}-s1-1`)?.deadlineAt).toBe(T0 + 4 * MIN);
    expect(after.twap?.nextAt).toBe(T0 + 5 * MIN);
    expect(w.wakes).toBeGreaterThan(0);
  });

  it('slice 2 on the interval', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    await advance(job, T0 + 4 * MIN + 20_000);
    fill(`${job.id}-s1-1`, '5', '3000');
    await pass(job);
    expect(ids()).toHaveLength(1);
    await advance(job, T0 + 5 * MIN);
    expect(ids()).toEqual([`${job.id}-s1-1`, `${job.id}-s2-1`]);
    expect(w.requests[1].qty).toBe('5');
  });

  it('next slice waits for the last child', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    w.store.updatePair(`${job.id}-s1-1`, { mode: 'CONVERTING' });
    for (const step of [1, 2, 3, 4, 5]) {
      await advance(job, T0 + step * MIN);
    }
    let read = w.jobs.read() as Job;
    expect(ids()).toHaveLength(1);
    expect(read.twap?.nextAt).toBeNull();
    expect(twapViewOf(read, []).twap?.nextAt).toBeNull();
    at(T0 + 5 * MIN + 30_000);
    fill(`${job.id}-s1-1`, '5', '3000');
    read = await pass(job);
    expect(ids()).toEqual([`${job.id}-s1-1`, `${job.id}-s2-1`]);
    expect(read.twap?.nextAt).toBe(T0 + 10 * MIN + 30_000);
  });

  it('auto maker leg is fixed at the start', async () => {
    const job = startJob(ethOpen('60'), { makerLeg: 'b' });
    for (let slice = 1; slice <= 5; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), '5', '3000');
    }
    expect(w.requests.map((req) => req.makerLeg)).toEqual(['b', 'b', 'b', 'b', 'b']);
  });

  it('capped rest joins the next slice', async () => {
    const job = startJob(ethClose('60'));
    await pass(job);
    fill(`${job.id}-s1-1`, '2', '3000');
    const read = await advance(job, T0 + 5 * MIN);
    expect(w.requests[1]).toMatchObject({ id: `${job.id}-s2-1`, qty: '8' });
    expect(read.twap?.behindQty).toBe('3');
  });

  it('capped rest after the last slice pauses, and resume posts the rest slice', async () => {
    const job = startJob(ethClose('60'));
    for (let slice = 1; slice <= 12; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), slice === 12 ? '2' : '5', '3000');
    }
    const halted = await advance(job, T0 + 56 * MIN);
    expect(halted.status).toBe('halted');
    expect(halted.haltKind).toBe('capped-rest');
    expect(halted.haltReason).toBe('3 ETH not closed');
    halted.status = 'running';
    halted.haltKind = null;
    halted.haltReason = null;
    w.jobs.write(halted);
    at(T0 + 60 * MIN);
    await pass(halted);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s13-1`, qty: '3' });
  });

  it('finishes when the last slice fills, with exact lot sums', async () => {
    const job = startJob(ethOpen('693.64'));
    for (let slice = 1; slice <= 12; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      const req = w.requests.at(-1) as DealRequest;
      fill(req.id, req.qty, '3000');
    }
    expect(w.requests.slice(0, 11).every((req) => req.qty === '57.803')).toBe(true);
    expect(w.requests[11].qty).toBe('57.807');
    const done = await advance(job, T0 + 60 * MIN);
    expect(done.status).toBe('done');
    expect(ids()).toHaveLength(12);
  });
});

describe('twap at size', () => {
  it.each([
    { label: '$50', total: '0.02', slices: 2, expected: ['0.01', '0.01'] },
    { label: '$5,000', total: '1.667', slices: 2, expected: ['0.833', '0.834'] },
    { label: '$100k', total: '33.334', slices: 4, expected: ['8.333', '8.333', '8.333', '8.335'] },
    { label: '$1M', total: '333.334', slices: 10, expected: [...Array.from({ length: 9 }, () => '33.333'), '33.337'] },
    { label: '$6M', total: '2000', slices: 100, expected: Array.from({ length: 100 }, () => '20') },
  ])('slices $label with exact strings', async ({ total, slices, expected }) => {
    const job = startJob(ethOpen(total), { durationSec: slices * 300, slices });
    for (let slice = 1; slice <= slices; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      const req = w.requests.at(-1) as DealRequest;
      fill(req.id, req.qty, '3000');
    }
    expect(w.requests.map((req) => req.qty)).toEqual(expected);
    await advance(job, T0 + slices * 5 * MIN - 30_000);
    at(T0 + slices * 5 * MIN);
    expect((await pass(job)).status).toBe('done');
  });
});

describe('twap never', () => {
  it('never carries the rest', async () => {
    const job = startJob(ethOpen('60'), { takerAfterSec: null });
    await pass(job);
    expect(w.requests[0].timeoutSec).toBeNull();
    expect(w.store.getPair(`${job.id}-s1-1`)?.deadlineAt).toBeNull();
    await advance(job, T0 + 5 * MIN);
    expect(w.store.getPair(`${job.id}-s1-1`)?.mode).toBe('STOPPING');
    expect(ids()).toHaveLength(1);
    fill(`${job.id}-s1-1`, '1.5', '3000');
    await advance(job, T0 + 5 * MIN + 3000);
    expect(w.requests[1]).toMatchObject({ id: `${job.id}-s2-1`, qty: '8.5' });
  });

  it('never rest holds the run', async () => {
    const job = startJob(ethOpen('10'), { durationSec: 600, slices: 2, takerAfterSec: null });
    await pass(job);
    fill(`${job.id}-s1-1`, '5', '3000');
    await advance(job, T0 + 5 * MIN);
        const read = await advance(job, T0 + 90 * MIN);
    expect(w.store.getPair(`${job.id}-s2-1`)?.mode).toBe('OPENING');
    expect(read.status).toBe('running');
    expect(dealLockFor({ rebalance: read, dealId: 'plain-deal-1' })).toBe(LOCK_TEXT.twapRunning);
  });
});

describe('twap pause and resume', () => {
  it('pause stops the live child at once', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    const read = w.jobs.read() as Job;
    w.jobs.write(requestPause(read));
    await stopLiveChild(w.deps, read);
    expect(w.store.getPair(`${job.id}-s1-1`)?.mode).toBe('STOPPING');
    const pausing = await pass(job);
    expect(pausing.status).toBe('running');
    expect(pausing.pauseRequested).toBe(true);
    fill(`${job.id}-s1-1`, '2', '3000', { mode: 'DONE' });
    const paused = await pass(job);
    expect(paused).toMatchObject({ status: 'halted', paused: true, pauseRequested: false, haltKind: null });
    expect(ids()).toHaveLength(1);
  });

  it('a pause in the last slice is a pause, and resume posts the rest slice', async () => {
    const job = startJob(ethOpen('60'));
    for (let slice = 1; slice <= 12; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      if (slice < 12) fill(childIdFor(job.id, slice, 1), '5', '3000');
    }
    const read = w.jobs.read() as Job;
    w.jobs.write(requestPause(read));
    await stopLiveChild(w.deps, read);
    fill(childIdFor(job.id, 12, 1), '2', '3000', { mode: 'DONE' });
    const paused = await pass(job);
    expect(paused).toMatchObject({ status: 'halted', paused: true, pauseRequested: false, haltKind: null, haltReason: null });
    expect(paused.twap?.behindQty).toBe('3');
    paused.status = 'running';
    paused.paused = false;
    w.jobs.write(paused);
    at(T0 + 60 * MIN);
    await pass(job);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s13-1`, qty: '3' });
  });

  it('resume replans the rest and slice numbers keep counting', async () => {
    const job = startJob(ethOpen('693.64'));
    for (let slice = 1; slice <= 3; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      if (slice < 3) fill(childIdFor(job.id, slice, 1), '57.803', '3000');
    }
    const read = w.jobs.read() as Job;
    w.jobs.write(requestPause(read));
    await stopLiveChild(w.deps, read);
    fill(childIdFor(job.id, 3, 1), '30.514', '3000');
    const paused = await pass(job);
    expect(paused.status).toBe('halted');
    paused.status = 'running';
    paused.paused = false;
    w.jobs.write(paused);
    at(T0 + 40 * MIN);
    const resumed = await pass(job);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s4-1`, qty: '60.835' });
    expect(resumed.twap?.nextAt).toBe(T0 + 45 * MIN);
    for (let slice = 4; slice <= 12; slice += 1) {
      const req = w.requests.at(-1) as DealRequest;
      fill(req.id, req.qty, '3000');
      await advance(job, T0 + 40 * MIN + (slice - 3) * 5 * MIN);
    }
    expect(ids().slice(3)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12].map((slice) => `${job.id}-s${slice}-1`));
    expect(w.requests.at(-1)?.qty).toBe('60.84');
    expect((w.jobs.read() as Job).status).toBe('done');
  });
});

describe('twap halts', () => {
  it('restart halts before the loop and no slice fires after downtime', async () => {
    const job = startJob(ethOpen('60'));
    for (let slice = 1; slice <= 3; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      if (slice < 3) fill(childIdFor(job.id, slice, 1), '5', '3000');
    }
    const halted = await bootHaltTwap(w.deps, w.jobs.read() as Job);
    expect(halted).toMatchObject({ status: 'halted', haltKind: 'restart' });
    expect(w.store.getPair(`${job.id}-s3-1`)?.mode).toBe('STOPPING');
    await advance(job, T0 + 30 * MIN);
    expect(ids()).toHaveLength(3);
  });

  it('sleep halts like a restart', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    const slept = sleepHaltTwap(w.deps, w.jobs.read() as Job, { fromMs: T0 + MIN, toMs: T0 + 41 * MIN });
    expect(w.store.getPair(`${job.id}-s1-1`)?.mode).toBe('STOPPING');
    expect(slept).toMatchObject({ status: 'halted', haltKind: 'sleep', sleptFrom: T0 + MIN, sleptTo: T0 + 41 * MIN });
    expect(w.store.getPair(`${job.id}-s1-1`)?.mode).not.toBe('CONVERTING');
  });

  it('sleep with no live child halts before the next slice', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    await advance(job, T0 + 4 * MIN);
    fill(`${job.id}-s1-1`, '5', '3000');
    await pass(job);
    at(T0 + 44 * MIN);
    const read = await pass(job);
    expect(read).toMatchObject({ status: 'halted', haltKind: 'sleep', sleptFrom: T0 + 4 * MIN, sleptTo: T0 + 44 * MIN });
    expect(ids()).toHaveLength(1);
  });

  it('refused slice halts', async () => {
    const job = startJob(ethOpen('60'));
    for (let slice = 1; slice <= 3; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), '5', '3000');
    }
    w.refuse = new CoreError('Not enough free margin', 'insufficient-margin');
    const read = await advance(job, T0 + 15 * MIN);
    expect(read).toMatchObject({ status: 'halted', haltKind: 'refused', haltReason: 'Gate refused slice 4: not enough margin' });
  });

  it('a maker refused for margin on the venue halts as refused', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    const id = `${job.id}-s1-1`;
    const order = w.store.insertPendingOrder({ pairId: id, leg: 'A', kind: 'maker', side: 'BUY', qty: '5', price: '3000', tif: 'poc', now: w.t });
    w.store.updateOrder(id, 'A', order.seq, { state: 'DEAD', closeReason: 'rejected:INSUFFICIENT_MARGIN' });
    w.store.updatePair(id, { mode: 'DONE' });
    const read = await pass(job);
    expect(read).toMatchObject({ haltKind: 'refused', haltReason: 'Gate refused slice 1: not enough margin' });
  });

  it('slice under minimum mid-run halts', async () => {
    const deal: TwapDealTemplate = {
      a: { symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY' },
      b: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL' },
      execution: 'maker',
      totalQty: '0.012',
      coin: 'BTC',
      rules: BTC_RULES,
    };
    const job = startJob(deal, { mark: 90_000 });
    for (let slice = 1; slice <= 6; slice += 1) {
      await advance(job, T0 + (slice - 1) * 5 * MIN);
      fill(childIdFor(job.id, slice, 1), '0.001', slice === 6 ? '40000' : '90000');
    }
    const read = await advance(job, T0 + 30 * MIN);
    expect(read).toMatchObject({ status: 'halted', haltKind: 'refused', haltReason: "Slice 7 is under Binance's $50 minimum" });
    expect(ids()).toHaveLength(6);
  });

  it('halted child halts the job with kind error', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    w.store.updatePair(`${job.id}-s1-1`, { mode: 'HALTED' });
    const read = await pass(job);
    expect(read).toMatchObject({ status: 'halted', haltKind: 'error', haltReason: 'Slice 1 stopped on an error. Check the orders, then resume or stop.' });
    expect(w.store.listAlerts({ unackedOnly: true }).map((row) => row.message)).toContain(read.haltReason);
    expect(transferLockFor({ rebalance: read, dealWorking: true })).toBe('twapError');
    expect(dealLockFor({ rebalance: read, dealId: 'plain-deal-1' })).toBe(LOCK_TEXT.twapError);
    read.status = 'running';
    read.haltKind = null;
    w.jobs.write(read);
    await pass(job);
    expect(w.store.getPair(`${job.id}-s1-1`)?.mode).toBe('STOPPING');
    expect(ids()).toHaveLength(1);
  });

  it('hedge refused for margin halts as hedge-margin', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    w.store.updatePair(`${job.id}-s1-1`, { mode: 'HALTED', haltKind: 'hedge-margin' });
    const read = await pass(job);
    expect(read).toMatchObject({ haltKind: 'hedge-margin', haltReason: 'Hyperliquid refused the hedge in slice 1' });
  });

  it('a create error halts with kind error and an alert', async () => {
    const job = startJob(ethOpen('60'));
    w.refuse = new CoreError('Size 5 is not a multiple of the lot');
    const read = await pass(job);
    expect(read.haltKind).toBe('error');
    expect(w.store.listAlerts().length).toBe(1);
  });
});

describe('twap locks', () => {
  it('refuses a plain deal while running and passes the child', async () => {
    const job = startJob(ethOpen('60'));
    expect(dealLockFor({ rebalance: job, dealId: 'plain-deal-1' })).toBe(LOCK_TEXT.twapRunning);
    expect(dealLockFor({ rebalance: job, dealId: `${job.id}-s3-1` })).toBeNull();
    expect(dealLockFor({ rebalance: job, dealId: `${job.id}-x` })).toBe(LOCK_TEXT.twapRunning);
    expect(transferLockFor({ rebalance: job, dealWorking: false })).toBe('twapRunning');
  });

  it('paused lets transfers through and refuses deals', () => {
    const job = startJob(ethOpen('60'));
    job.status = 'halted';
    job.paused = true;
    expect(transferLockFor({ rebalance: job, dealWorking: false })).toBeNull();
    expect(dealLockFor({ rebalance: job, dealId: 'plain-deal-1' })).toBe('A TWAP is paused. Orders wait until it ends.');
  });

  it('error halt blocks transfers while its child is live', () => {
    const job = startJob(ethOpen('60'));
    job.status = 'halted';
    job.haltKind = 'error';
    expect(transferLockFor({ rebalance: job, dealWorking: false, childLive: true })).toBe('twapError');
    expect(LOCK_TEXT.twapError).toBe('A TWAP stopped on an error. Orders and transfers wait until you resume or stop it.');
  });

  it('an ended twap locks nothing', () => {
    const job = startJob(ethOpen('60'));
    job.status = 'abandoned';
    expect(dealLockFor({ rebalance: job, dealId: 'plain-deal-1' })).toBeNull();
    expect(transferLockFor({ rebalance: job, dealWorking: false })).toBeNull();
  });
});

describe('twap job file', () => {
  it('reads a twap job back from disk', () => {
    const job = startJob(ethOpen('60'));
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'twap-file-'));
    new JobFile(dir, () => w.t).write(job);
    const read = new JobFile(dir, () => w.t).read();
    expect(read?.kind).toBe('twap');
    expect(read?.twap?.sliceQty).toBe('5');
    expect(read?.sleptFrom).toBeNull();
  });

  it('a child already posted is found by id and not posted twice', async () => {
    const post = w.deps.createChild;
    const sliceOnDisk: number[] = [];
    w.deps.createChild = async (req) => {
      sliceOnDisk.push((w.jobs.read() as Job).twap?.sliceIndex ?? -1);
      if (w.store.getPair(req.id)) {
        w.requests.push(req);
        return;
      }
      await post(req);
    };
    const job = startJob(ethOpen('60'));
    await pass(job);
    const crashed = w.jobs.read() as Job;
    crashed.twap!.sliceIndex = 0;
    crashed.twap!.nextAt = null;
    w.jobs.write(crashed);
    at(T0 + 30_000);
    const read = await pass(job);
    expect(sliceOnDisk).toEqual([1, 1]);
    expect(w.store.listPairs().map((pair) => pair.id).filter((id) => isChildOf(job.id, id))).toEqual([`${job.id}-s1-1`]);
    expect(w.store.listOrders(`${job.id}-s1-1`)).toHaveLength(0);
    expect(read).toMatchObject({ status: 'running', twap: { sliceIndex: 1 } });
    fill(`${job.id}-s1-1`, '5', '3000');
    await advance(job, T0 + 30_000 + 5 * MIN);
    expect(ids()).toEqual([`${job.id}-s1-1`, `${job.id}-s1-1`, `${job.id}-s2-1`]);
    expect(w.requests[2].qty).toBe('5');
  });
});

describe('borosShareOf', () => {
  it("boros share follows the smaller leg's fill", () => {
    expect(borosShareOf({ closeSize: 4.03, legFilled: [0.37, 0.37], legPlanned: [4.4, 4.03] })).toBeCloseTo(0.37, 10);
  });

  it('is zero with nothing filled and never over the close size', () => {
    expect(borosShareOf({ closeSize: 4.03, legFilled: [0, 0], legPlanned: [4.4, 4.03] })).toBe(0);
    expect(borosShareOf({ closeSize: 4.03, legFilled: [5, 5], legPlanned: [4.4, 4.03] })).toBe(4.03);
    expect(borosShareOf({ closeSize: 4.03, legFilled: [1, 1], legPlanned: [0, 0] })).toBe(0);
  });

  it.each([
    ['$50', '0.017', '0.006'],
    ['$5,000', '1.667', '0.667'],
    ['$100k', '33.334', '13.334'],
    ['$1M', '333.334', '133.334'],
    ['$6M', '2000', '800'],
  ])("boros share at %s follows the smaller leg's part fill and the last slice closes all", (_size, qty, part) => {
    const planned = Number(qty);
    const filled = Number(part);
    const bigger = planned * 1.25;
    const share = borosShareOf({ closeSize: planned, legFilled: [bigger, filled], legPlanned: [bigger, planned] });
    expect(Math.abs(share - filled)).toBeLessThanOrEqual(filled * 1e-12);
    expect(borosShareOf({ closeSize: planned, legFilled: [filled, bigger], legPlanned: [planned, bigger] })).toBe(share);
    expect(borosShareOf({ closeSize: planned, legFilled: [bigger, planned], legPlanned: [bigger, planned] })).toBe(planned);
    expect(borosShareOf({ closeSize: planned, legFilled: [bigger * 2, planned * 2], legPlanned: [bigger, planned] })).toBe(planned);
  });
});

const feeRow = (exchangeType: string, maker: string, taker: string): VenueFeeRow => ({ exchangeType, futureMakerFee: maker, futureTakerFee: taker });
const TIED_FEES = [feeRow('GATE', '0.0002', '0.0005'), feeRow('HYPERLIQUID', '0.0002', '0.0005')];
const HL_CHEAPER = [feeRow('GATE', '0.0002', '0.0005'), feeRow('HYPERLIQUID', '0.00015', '0.0005')];
const bookOf = (asks: [number, number][], bids: [number, number][]): NormalizedBook => ({ asks, bids, ts: 0 });
const THIN_ON_A_AT_SIZE = bookOf([[3000.5, 50], [3001, 50], [3015, 1_000_000]], [[2999.5, 1_000_000]]);
const EVEN_B = bookOf([[3001, 1_000_000]], [[2999, 1_000_000]]);
const sizedLeg = (symbol: string, book: NormalizedBook, qty: string) => ({ symbol, side: 'BUY' as const, book, mid: 3000, qty: Number(qty) });
const pickAt = (fees: VenueFeeRow[], a: NormalizedBook, b: NormalizedBook, qty: string) =>
  makerLegOf(fees, sizedLeg('GATE_FUTURE_ETH_USDT', a, qty), sizedLeg('HYPERLIQUID_FUTURE_ETH_USDC', b, qty));

describe('auto maker leg at size', () => {
  it.each([
    ['$50', '0.017', 'b'],
    ['$5,000', '1.667', 'b'],
    ['$100k', '33.334', 'b'],
    ['$1M', '333.334', 'a'],
    ['$6M', '2000', 'a'],
  ])('on a fee tie at %s the leg thinner at the full order size rests, and fees win first', (_size, qty, thinner) => {
    expect(pickAt(TIED_FEES, THIN_ON_A_AT_SIZE, EVEN_B, qty)).toEqual({ auto: thinner, why: 'book' });
    expect(pickAt(HL_CHEAPER, THIN_ON_A_AT_SIZE, EVEN_B, qty)).toEqual({ auto: 'b', why: 'fees' });
  });

  it.each([
    ['$1M', '333.334'],
    ['$6M', '2000'],
  ])('at %s a book that cannot fill the full order is the thinner one and rests', (_size, qty) => {
    const shallowA = bookOf([[3000.3, 100]], [[2999.7, 100]]);
    const deepB = bookOf([[3000.6, 10_000_000]], [[2999.4, 10_000_000]]);
    expect(pickAt(TIED_FEES, shallowA, deepB, qty)).toEqual({ auto: 'a', why: 'book' });
  });
});

describe('twapViewOf', () => {
  it('unread fee counts at the schedule', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    fill(`${job.id}-s1-1`, '5', '3000', { bPrice: '3003' });
    await advance(job, T0 + 5 * MIN);
    fill(`${job.id}-s2-1`, '5', '3000', { bPrice: '3003' });
    w.fees = { [`${job.id}-s2-1`]: 4.2 };
    const read = w.jobs.read() as Job;
    const view = twapViewOf(read, await loadTwapChildren(w.deps, read));
    expect(view.fees.readUsd).toBeCloseTo(4.2, 10);
    expect(view.fees.estUsd).toBeCloseTo(5 * 3000 * 0.0002 + 5 * 3003 * 0.0005, 10);
    expect(view.fees.est).toBe(true);
    expect(view.slippage?.usd).toBeCloseTo(30, 10);
    expect(view.slippage?.pct).toBeCloseTo(3 / 3001.5, 10);
    expect(view.legs.map((leg) => [leg.name, leg.side, leg.filledQty, leg.plannedQty])).toEqual([
      ['Gate', 'LONG', '10', '60'],
      ['Hyperliquid', 'SHORT', '10', '60'],
    ]);
    expect(view.orders.map((row) => row.slice)).toEqual([2, 2, 1, 1]);
    expect(view.orders[0].createdAt).toBeGreaterThanOrEqual(view.orders[3].createdAt);
    expect(view.twap).toMatchObject({ slice: 2, of: 12 });
    expect(view.child).toBeNull();
  });

  it('shows the live child against the best price', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    const read = w.jobs.read() as Job;
    const children = (await loadTwapChildren(w.deps, read)).map((row) => ({ ...row, bestPrice: '3003' }));
    const view = twapViewOf(read, children);
    expect(view.child).toMatchObject({ id: `${job.id}-s1-1`, slice: 1, side: 'BUY', restPrice: '3000', bestPrice: '3003', repegRefused: null });
    expect(view.child?.behindPct).toBeCloseTo(3 / 3003, 10);
  });

  it('says a re-peg was refused until a new maker order is accepted', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    const id = `${job.id}-s1-1`;
    const pair = w.store.getPair(id) as PairRow;
    const place = (price: string) =>
      w.store.insertPendingOrder({ pairId: id, leg: 'A', kind: 'maker', side: pair.a.side, qty: pair.targetQty, price, tif: 'poc', now: w.t });
    const refusal = async () => {
      const read = w.jobs.read() as Job;
      return twapViewOf(read, await loadTwapChildren(w.deps, read)).child?.repegRefused;
    };
    const first = place('3000');
    w.store.updateOrder(id, 'A', first.seq, { state: 'CLOSED', closeReason: 'cancelled', resolvedAt: w.t });
    expect(await refusal()).toBeNull();
    const refused = place('3001');
    w.store.updateOrder(id, 'A', refused.seq, { state: 'DEAD', closeReason: 'rejected:TRADE_HYPERLIQUID_ORDER_LIMIT_ERROR', resolvedAt: w.t + 500 });
    expect(await refusal()).toEqual({ kind: 'order-allowance', at: w.t + 500 });
    const retry = place('3000');
    expect(await refusal()).toEqual({ kind: 'order-allowance', at: w.t + 500 });
    w.store.updateOrder(id, 'A', retry.seq, { state: 'OPEN' });
    expect(await refusal()).toBeNull();
    w.store.updateOrder(id, 'A', retry.seq, { state: 'CLOSED', closeReason: 'cancelled', resolvedAt: w.t + 9_000 });
    const margin = place('3002');
    w.store.updateOrder(id, 'A', margin.seq, { state: 'DEAD', closeReason: 'rejected:INSUFFICIENT_MARGIN', resolvedAt: w.t + 9_500 });
    expect(await refusal()).toBeNull();
  });

  it('closes name each leg by the position it closes', () => {
    const job = startJob(ethClose('60'));
    expect(twapViewOf(job, []).legs.map((leg) => [leg.symbol, leg.side, leg.reduceOnly])).toEqual([
      ['GATE_FUTURE_ETH_USDT', 'LONG', true],
      ['HYPERLIQUID_FUTURE_ETH_USDC', 'SHORT', true],
    ]);
    expect(twapViewOf(startJob(ethOpen('60')), []).legs.map((leg) => leg.reduceOnly)).toEqual([false, false]);
  });
});

const btcOpen = (totalQty: string): TwapDealTemplate => ({
  a: { symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY' },
  b: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL' },
  execution: 'maker',
  totalQty,
  coin: 'BTC',
  rules: BTC_RULES,
});

async function unwindChild(job: Job, slice: number, qty: string): Promise<void> {
  const id = `${job.id}-f${slice}`;
  await w.deps.createChild({ id, a: { symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', reduceOnly: true }, b: null, qty, execution: 'taker' });
  fill(id, qty, '90000', { aKind: 'taker' });
  w.requests.pop();
}

function resume(): Job {
  const read = w.jobs.read() as Job;
  read.status = 'running';
  read.paused = false;
  read.haltKind = null;
  read.haltReason = null;
  w.jobs.write(read);
  return read;
}

describe('twap fixes', () => {
  it.each([
    ['$50', '0.002', '0.001', '0.001', '0.001'],
    ['$5k', '0.056', '0.028', '0.01', '0.028'],
    ['$100k', '1.111', '0.555', '0.3', '0.556'],
    ['$1M', '11.111', '5.555', '4', '5.556'],
    ['$6M', '66.6', '33.3', '20', '33.3'],
  ])('unwind at %s: the rest is the total minus the net opened', async (_size, total, sliceQty, slice2Fill, rest) => {
    const job = startJob(btcOpen(total), { slices: 2, mark: 90_000 });
    await pass(job);
    expect(w.requests[0].qty).toBe(sliceQty);
    fill(`${job.id}-s1-1`, sliceQty, '90000');
    await advance(job, T0 + 30 * MIN);
    fill(`${job.id}-s2-1`, slice2Fill, '90000', { mode: 'HALTED', filledB: '0' });
    w.store.updatePair(`${job.id}-s2-1`, { haltKind: 'hedge-margin' });
    const halted = await pass(job);
    expect(halted).toMatchObject({ status: 'halted', haltKind: 'hedge-margin' });
    await unwindChild(job, 2, slice2Fill);
    w.store.updatePair(`${job.id}-s2-1`, { mode: 'DONE' });
    resume();
    at(T0 + 31 * MIN);
    await pass(job);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s3-1`, qty: rest });
    const read = w.jobs.read() as Job;
    expect(twapViewOf(read, await loadTwapChildren(w.deps, read)).legs[0].filledQty).toBe(sliceQty);
  });

  it('market fix hedges the filled leg and the next slice takes the rest', async () => {
    const job = startJob(ethOpen('60'));
    await pass(job);
    const id = `${job.id}-s1-1`;
    w.store.updatePair(id, { mode: 'HALTED', haltKind: 'hedge-margin' });
    await pass(job);
    commands.resumeAfterHalt(w.store, id);
    expect(w.store.getPair(id)).toMatchObject({ mode: 'STOPPING', haltKind: null });
    fill(id, '2', '3000');
    resume();
    at(T0 + 5 * MIN);
    await pass(job);
    expect(w.requests.at(-1)).toMatchObject({ id: `${job.id}-s2-1`, qty: '5.272' });
  });
});

function deleverJob(twap: { durationSec: number; intervalSec: number; slices: number } | null): Job {
  const job = newJob(
    {
      route: 'loop',
      steps: [],
      amount: 0,
      costUsd: 0,
      target: [],
      userId: null,
      kind: 'delever',
      twap,
      delever: {
        makerLeg: 0,
        legs: [
          { symbol: 'GATE_FUTURE_BTC_USDT', exchange: 'GATE', base: 'BTC', side: 'LONG', before: 900, after: 870, closeQty: 30 },
          { symbol: 'BINANCE_FUTURE_BTC_USDT', exchange: 'BINANCE', base: 'BTC', side: 'SHORT', before: 900, after: 870, closeQty: 30 },
        ],
        boros: [{ marketId: 7, before: 900, after: 870, closeSize: 30 }],
      },
    },
    T0,
  );
  w.jobs.write(job);
  return job;
}

async function deleverChild(job: Job, slice: number): Promise<string> {
  const id = childIdFor(job.id, slice, 1);
  await w.deps.createChild({
    id,
    a: { symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', reduceOnly: true },
    b: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', reduceOnly: true },
    qty: '0.625',
    execution: 'maker',
    pricePolicy: 'touch',
    repegBehindBp: 5,
  });
  const step = job.steps[0];
  step.startedAt = T0;
  step.status = 'running';
  step.cut = { qty: 0.625, from: 0, at: w.t, ioc: false };
  step.lead = { text: id, venueId: null, sentAt: w.t, credited: 0, poc: true, price: null, side: 'SELL', mid: 90_000, entry: null };
  job.slice = { index: slice, count: 48, sizeUsd: 0 };
  w.jobs.write(job);
  return id;
}

describe('delever twap', () => {
  it('sleep stops the live slice and halts the delever twap', async () => {
    const job = deleverJob({ durationSec: 4 * 3600, intervalSec: 300, slices: 48 });
    const id = await deleverChild(job, 1);
    const slept = sleepHaltTwap(w.deps, w.jobs.read() as Job, { fromMs: T0 + MIN, toMs: T0 + 41 * MIN });
    expect(w.store.getPair(id)?.mode).toBe('STOPPING');
    expect(slept).toMatchObject({ status: 'halted', haltKind: 'sleep', sleptFrom: T0 + MIN, sleptTo: T0 + 41 * MIN });
    expect(slept.haltReason).toBe('This Mac slept during the TWAP. Nothing was sent while it slept. Press Resume.');
    expect((w.jobs.read() as Job).status).toBe('halted');
  });

  it('sleep stops the live slice and halts a realize twap', async () => {
    const job = deleverJob({ durationSec: 4 * 3600, intervalSec: 300, slices: 48 });
    const id = await deleverChild(job, 1);
    const realize = { ...(w.jobs.read() as Job), kind: 'realize' as const, delever: null };
    w.jobs.write(realize);
    const slept = sleepHaltTwap(w.deps, w.jobs.read() as Job, { fromMs: T0 + MIN, toMs: T0 + 41 * MIN });
    expect(w.store.getPair(id)?.mode).toBe('STOPPING');
    expect(slept).toMatchObject({ kind: 'realize', status: 'halted', haltKind: 'sleep' });
    expect(twapViewOf(slept, await loadTwapChildren(w.deps, slept)).twap).toMatchObject({ slice: 1, of: 48, intervalSec: 300 });
  });

  it('sleep leaves a realize without twap alone', async () => {
    const job = deleverJob(null);
    const id = await deleverChild(job, 1);
    w.jobs.write({ ...(w.jobs.read() as Job), kind: 'realize', delever: null });
    expect(sleepHaltTwap(w.deps, w.jobs.read() as Job, { fromMs: T0, toMs: T0 + 41 * MIN }).status).toBe('running');
    expect(w.store.getPair(id)?.mode).toBe('OPENING');
  });

  it('sleep leaves a delever without twap alone', async () => {
    const job = deleverJob(null);
    const id = await deleverChild(job, 1);
    const read = sleepHaltTwap(w.deps, w.jobs.read() as Job, { fromMs: T0, toMs: T0 + 41 * MIN });
    expect(read.status).toBe('running');
    expect(w.store.getPair(id)?.mode).toBe('OPENING');
  });

  it('fills twap, child and legs for a running delever twap', async () => {
    const job = deleverJob({ durationSec: 4 * 3600, intervalSec: 300, slices: 48 });
    at(T0 + 35 * MIN);
    const id = await deleverChild(job, 8);
    const read = w.jobs.read() as Job;
    const view = twapViewOf(read, await loadTwapChildren(w.deps, read));
    expect(view.twap).toMatchObject({ slice: 8, of: 48, nextAt: T0 + 40 * MIN, intervalSec: 300, makerLeg: 'a', repegBehindBp: 5, takerAfterSec: 240, startedAt: T0 });
    expect(view.child).toMatchObject({ id, slice: 8, makerLeg: 'a', side: 'SELL' });
    expect(view.legs.map((leg) => [leg.symbol, leg.side, leg.reduceOnly, leg.plannedQty])).toEqual([
      ['GATE_FUTURE_BTC_USDT', 'LONG', true, '30'],
      ['BINANCE_FUTURE_BTC_USDT', 'SHORT', true, '30'],
    ]);
    expect(view.boros).toMatchObject({ refused: false, slice: 8, leftYu: 0, beforeYu: 900, nowYu: 900 });
  });

  it('shows the Boros close a delever twap halted on', async () => {
    const job = deleverJob({ durationSec: 4 * 3600, intervalSec: 300, slices: 48 });
    const id = await deleverChild(job, 8);
    fill(id, '0.625', '90000');
    const read = w.jobs.read() as Job;
    read.steps[0].lead = null;
    read.delever!.boros[0].closed = 26.25;
    read.borosLeftYu = 3.75;
    read.status = 'halted';
    read.haltKind = 'boros';
    w.jobs.write(read);
    const view = twapViewOf(read, await loadTwapChildren(w.deps, read));
    expect(view.boros).toEqual({ refused: true, slice: 8, leftYu: 3.75, beforeYu: 900, nowYu: 873.75 });
    expect(view.twap?.nextAt).toBeNull();
    expect(view.child).toBeNull();
    expect(view.legs.map((leg) => leg.filledQty)).toEqual(['0.625', '0.625']);
  });

  it('shows each perp before the run and now, net of the filled close', async () => {
    const job = deleverJob({ durationSec: 4 * 3600, intervalSec: 300, slices: 48 });
    for (const leg of job.delever!.legs) leg.before = 1;
    const first = await deleverChild(job, 1);
    fill(first, '0.25', '90000');
    const second = await deleverChild(job, 2);
    fill(second, '0.25', '90000');
    const read = w.jobs.read() as Job;
    const view = twapViewOf(read, await loadTwapChildren(w.deps, read));
    expect(view.legs.map((leg) => [leg.filledQty, leg.beforeQty, leg.nowQty])).toEqual([
      ['0.5', '1', '0.5'],
      ['0.5', '1', '0.5'],
    ]);
  });
});
