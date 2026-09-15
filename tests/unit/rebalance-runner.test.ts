import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Clients } from '../../src/core/clients';
import type { PlannedStep } from '../../src/core/rebalance/plan';
import { TtlCache } from '../../src/server/cache';
import {
  HALT_TEXT,
  JobFile,
  newJob,
  TO_USDC_STEPS,
  type Job,
  type RouteName,
} from '../../src/server/rebalanceJob';
import {
  HL_TRANSFER_TIMEOUT_MS,
  LOOKUP_RETRY_MS,
  LOOKUP_WINDOW_MS,
  POLL_MS,
  QUOTE_FLOOR,
  runJob,
  STEP_TIMEOUT_MS,
  tagFor,
} from '../../src/server/rebalanceRunner';
import { clientsWith } from '../helpers/fake-clients';

type Handler = (arg: never) => Promise<unknown>;
type CrossExApi = Clients['crossEx'];
type RequestOf<K extends keyof CrossExApi> = CrossExApi[K] extends (...args: infer A) => unknown
  ? Required<NonNullable<A[0]>>
  : never;

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function seq(...items: unknown[]): Handler {
  let i = 0;
  return async () => {
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    return typeof item === 'function' ? item() : item;
  };
}

const gateError = (status: number, label: string, message: string) => () => {
  throw Object.assign(new Error(message), { response: { status, data: { label, message } } });
};

const created = (orderId: string) => ({ body: { orderId, text: 't' } });
const order = (state: string, executedQty: string, orderId = 'o1', extra: Record<string, string> = {}) => ({
  body: { orderId, state, executedQty, ...extra },
});
const networkError = () => {
  throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
};
const tx = (txId: string) => ({ body: { txId, text: 't' } });
const row = (id: string, status: string, extra: Record<string, string> = {}) => ({
  id,
  status,
  amount: '11.99000',
  ...extra,
});
const rows = (...list: unknown[]) => ({ body: list });
const quote = (quoteId: string, toAmount: string) => ({
  body: { quoteId, validMs: '5000', fromAmount: '12', toAmount, price: '0.998' },
});

const convertRow = (orderId: string, quoteId: string, symbol: string, executedAmount: string) => ({
  orderId,
  symbol,
  text: quoteId,
  side: 'SELL',
  state: 'FILLED',
  executedAmount,
});

const account = (
  over: {
    marginBalance?: number;
    initialMargin?: number;
    usdt?: number;
    gate?: number;
    hyperliquid?: number;
    hyperliquidEquity?: number;
    lighter?: number;
  } = {},
) => {
  const wallet = (coin: string, exchangeType: string, balance: number, equity = balance) => ({
    coin,
    exchangeType,
    balance: String(balance),
    equity: String(equity),
  });
  return {
    body: {
      availableMargin: '0',
      marginBalance: String(over.marginBalance ?? 10_000),
      initialMargin: String(over.initialMargin ?? 0),
      assets: [
        wallet('USDT', 'CROSSEX', over.usdt ?? 1_000),
        wallet('USDC', 'GATE', over.gate ?? 0),
        wallet('USDC', 'HYPERLIQUID', over.hyperliquid ?? 0, over.hyperliquidEquity),
        wallet('USDC', 'LIGHTER', over.lighter ?? 0),
      ],
    },
  };
};

type Direction = 'toUsdc' | 'toUsdt';
type Planned = Omit<PlannedStep, 'from' | 'to'>;
const MOVE: Record<Direction, Pick<PlannedStep, 'from' | 'to'>> = {
  toUsdc: { from: 'CROSSEX', to: 'HYPERLIQUID' },
  toUsdt: { from: 'HYPERLIQUID', to: 'CROSSEX' },
};

const accountA = account({ marginBalance: 57.45, initialMargin: 29.41, usdt: 92.54, gate: 111.96, hyperliquid: -147.05 });

const round = (n: number, move: number, buy = 0): Planned => ({
  round: n,
  kind: 'round',
  buy,
  move,
  arrives: move - 0.05,
  borrowLeft: 0,
  seconds: 130,
});
const convert = (move: number): Planned => ({
  round: null,
  kind: 'convert',
  buy: 0,
  move,
  arrives: move * 0.998,
  borrowLeft: 0,
  seconds: 0,
});

const accountALoop: Planned[] = [
  { round: 1, kind: 'round', buy: 0, move: 24.51, arrives: 24.46, borrowLeft: 122.59, seconds: 130 },
  { round: 2, kind: 'round', buy: 0, move: 29.93, arrives: 29.88, borrowLeft: 92.71, seconds: 130 },
  { round: 3, kind: 'round', buy: 0, move: 36.58, arrives: 36.53, borrowLeft: 56.19, seconds: 130 },
  { round: 4, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66, borrowLeft: 11.53, seconds: 130 },
  { round: 5, kind: 'round', buy: 40.15, move: 40.15, arrives: 40.1, borrowLeft: 0, seconds: 130 },
];

interface PlanInput {
  direction?: Direction;
  route: RouteName;
  steps: (Planned | PlannedStep)[];
}

const between = (from: PlannedStep['from'], to: PlannedStep['to'], step: Planned): PlannedStep => ({ ...step, from, to });

const oneRound: PlanInput = { route: 'loop', steps: [round(1, 12, 12)] };

function happyLoop(): Record<string, Handler> {
  const x1 = row('x1', 'SUCCESS', { actualReceive: '11.99' });
  return {
    getCrossexAccount: seq(account({ gate: 0 }), account({ gate: 11.99 })),
    createCrossexOrder: seq(created('o1')),
    getCrossexOrder: seq(order('OPEN', '0'), order('FILLED', '11.99')),
    createCrossexTransfer: seq(tx('x1'), tx('x2')),
    listCrossexTransfers: seq(
      rows(),
      rows(row('x1', 'PENDING')),
      rows(x1),
      rows(x1, row('x2', 'PENDING')),
      rows(x1, row('x2', 'SUCCESS', { actualReceive: '11.94' })),
    ),
  };
}

function harness(
  clock: ReturnType<typeof fakeClock>,
  plan: PlanInput,
  handlers: Record<string, Handler>,
  edit?: (job: Job) => void,
) {
  const calls: Record<string, unknown[]> = {};
  const sequence: string[] = [];
  const recorded = (name: string, fn: Handler): Handler => async (arg: never) => {
    (calls[name] ??= []).push(arg);
    sequence.push(name);
    return fn(arg);
  };
  const crossEx: Record<string, Handler> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    if (name !== 'listTickers') crossEx[name] = recorded(name, fn);
  }
  const spot = {
    listTickers: recorded('listTickers', handlers.listTickers ?? seq({ body: [{ highestBid: '0.9999', lowestAsk: '1.0001' }] })),
  };
  const clients = Object.assign(clientsWith(crossEx), { spot });
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  const jobs = new JobFile(dir, clock.now);
  const amount = plan.steps.reduce((total, step) => total + step.move, 0);
  const job = newJob(
    {
      route: plan.route,
      steps: plan.steps.map((step) => ({ ...MOVE[plan.direction ?? 'toUsdc'], ...step })),
      amount,
      costUsd: 0,
      target: [],
      userId: null,
    },
    clock.now(),
  );
  edit?.(job);
  jobs.write(job);
  const cache = new TtlCache();
  const onHalt = vi.fn();
  const deps = { clients: () => clients, jobs, cache, now: clock.now, sleep: clock.sleep, onHalt };
  const count = (name: string) => calls[name]?.length ?? 0;
  const sent = <K extends keyof CrossExApi & string>(name: K): RequestOf<K>[] => (calls[name] ?? []) as RequestOf<K>[];
  const transfers = () => sent('createCrossexTransfer').map((arg) => arg.crossexTransferRequest);
  return { dir, job, jobs, cache, calls, sequence, count, sent, transfers, deps, onHalt, run: () => runJob(deps) };
}

const doneStep = (job: Job, index: number, patch: { venueId: string; qty: number; at: number }): void => {
  job.tagCount = Math.max(job.tagCount, index);
  Object.assign(job.steps[index], {
    text: tagFor(job.id, index),
    venueId: patch.venueId,
    qty: patch.qty,
    status: 'done',
    startedAt: patch.at,
    doneAt: patch.at,
  });
};

function resumeAtLastTransfer(job: Job, at: number, patch: Partial<Job['steps'][number]>): void {
  doneStep(job, 0, { venueId: 'o1', qty: 11.99, at });
  doneStep(job, 1, { venueId: 'x1', qty: 11.99, at });
  Object.assign(job.steps[2], { text: tagFor(job.id, 2), status: 'running', startedAt: at, ...patch });
  job.tagCount = 2;
  job.stepIndex = 2;
  job.fundsAt = 'SPOT';
}

function atConvert(job: Job, at: number): void {
  doneStep(job, 0, { venueId: 'o1', qty: 0, at });
  doneStep(job, 1, { venueId: 'x1', qty: job.steps[1].planned ?? 0, at });
  doneStep(job, 2, { venueId: 'x2', qty: job.steps[2].planned ?? 0, at });
  job.stepIndex = 3;
  job.fundsAt = 'HYPERLIQUID';
}

describe('runJob rounds at the fresh fit', () => {
  it('A round 1 transfer fits Gate limit', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: accountALoop }, {
      getCrossexAccount: seq(accountA),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.transfers()[0]).toEqual({
      coin: 'USDC',
      amount: '24.51',
      from: 'CROSSEX_GATE',
      to: 'SPOT',
      text: tagFor(h.job.id, 1),
    });
    expect(Number(h.transfers()[0].amount)).toBeLessThan(25.08);
  });

  it('round shrinks to fresh fit', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ marginBalance: 20, gate: 111.96 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.transfers()).toHaveLength(1);
    expect(h.transfers()[0]).toMatchObject({ amount: '20', from: 'CROSSEX_GATE', to: 'SPOT' });
    expect(h.jobs.read()!.steps.slice(1, 3).map((s) => s.planned)).toEqual([20, 20]);
  });

  it('mix shrink goes to Convert', async () => {
    const h = harness(fakeClock(), { route: 'mix', steps: [round(1, 30), convert(50)] }, {
      getCrossexAccount: seq(
        account({ marginBalance: 20, gate: 20 }),
        account({ marginBalance: 20, gate: 20 }),
        account({ gate: 0 }),
      ),
      createCrossexTransfer: seq(tx('x1'), tx('x2')),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { actualReceive: '20' })),
        rows(row('x2', 'SUCCESS', { actualReceive: '19.95' })),
      ),
      createCrossexConvertQuote: seq(quote('q1', '59.88')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps.at(-1)).toMatchObject({ name: 'Convert', planned: 60 });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe('60');
    expect(h.transfers().map((t) => t.amount)).toEqual(['20', '20']);
  });

  it('loop shrink adds a round', async () => {
    const steps = [1, 2, 3, 4, 5].map((n) => round(n, 30));
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ marginBalance: 19, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps).toHaveLength(18);
    expect(job.steps.at(-1)!.round).toBe(6);
    expect(job.steps.slice(15).map(({ name, round: r, planned }) => ({ name, round: r, planned }))).toEqual(
      TO_USDC_STEPS.map((name) => ({ name, round: 6, planned: 11 })),
    );
    expect(h.transfers()[0]).toMatchObject({ amount: '19', from: 'CROSSEX_GATE', to: 'SPOT' });
  });

  it('loop shrink under 11 goes to Convert', async () => {
    const steps = [1, 2, 3, 4, 5].map((n) => round(n, 30));
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ marginBalance: 20, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps).toHaveLength(16);
    expect(job.steps.filter((step) => step.round === 6)).toEqual([]);
    expect(job.steps.at(-1)).toMatchObject({ name: 'Convert', round: null, planned: 10 });
    expect(h.transfers()[0]).toMatchObject({ amount: '20', from: 'CROSSEX_GATE', to: 'SPOT' });
  });

  it('loop shrink under 11 adds to the Convert it already has', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 30), convert(50)] }, {
      getCrossexAccount: seq(account({ marginBalance: 20, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps.map((step) => step.name)).toEqual([...TO_USDC_STEPS, 'Convert']);
    expect(job.steps.at(-1)).toMatchObject({ name: 'Convert', planned: 60 });
  });

  it('loop shrink under 1 adds no round', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ marginBalance: 29.5, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps).toHaveLength(3);
    expect(h.transfers()[0]).toMatchObject({ amount: '29.5', from: 'CROSSEX_GATE', to: 'SPOT' });
  });

  it('mix shrink under 1 leaves Convert alone', async () => {
    const h = harness(fakeClock(), { route: 'mix', steps: [round(1, 30), convert(50)] }, {
      getCrossexAccount: seq(account({ marginBalance: 29.5, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.jobs.read()!.steps.at(-1)).toMatchObject({ name: 'Convert', planned: 50 });
    expect(h.transfers()[0].amount).toBe('29.5');
  });

  it('shrink rewrites the round figures', async () => {
    const steps: Planned[] = [
      { round: 1, kind: 'round', buy: 0, move: 30, arrives: 29.95, borrowLeft: 40, seconds: 130 },
      { round: 2, kind: 'round', buy: 0, move: 30, arrives: 29.95, borrowLeft: 10, seconds: 130 },
    ];
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ marginBalance: 20, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const figures = h.jobs.read()!.steps.map(({ name, round: r, planned, arrives, borrowLeft }) => ({ name, round: r, planned, arrives, borrowLeft }));
    expect(figures).toEqual([
      { name: 'Buy USDC', round: 1, planned: 0, arrives: null, borrowLeft: null },
      { name: 'To spot', round: 1, planned: 20, arrives: null, borrowLeft: null },
      { name: 'To Hyperliquid', round: 1, planned: 20, arrives: 19.95, borrowLeft: null },
      { name: 'Buy USDC', round: 2, planned: 0, arrives: null, borrowLeft: null },
      { name: 'To spot', round: 2, planned: 30, arrives: null, borrowLeft: null },
      { name: 'To Hyperliquid', round: 2, planned: 30, arrives: 29.95, borrowLeft: null },
      { name: 'Convert', round: null, planned: 10, arrives: null, borrowLeft: null },
    ]);
  });

  it('a shrink toward USDT sets what arrives after the 1 USDC fee', async () => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ marginBalance: 20, hyperliquid: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const figures = h.jobs.read()!.steps.map(({ name, round: r, planned, borrowLeft }) => ({ name, round: r, planned, borrowLeft }));
    expect(figures).toEqual([
      { name: 'From Hyperliquid', round: 1, planned: 20, borrowLeft: null },
      { name: 'To Gate', round: 1, planned: 19, borrowLeft: null },
      { name: 'Sell USDC', round: 1, planned: 19, borrowLeft: null },
      { name: 'Convert', round: null, planned: 10, borrowLeft: null },
    ]);
    expect(h.transfers()[0]).toMatchObject({ amount: '20', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' });
  });

  it('a move that would open a borrow shrinks at the fresh check', async () => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ marginBalance: 32, hyperliquid: 30, hyperliquidEquity: 0 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.transfers()).toHaveLength(1);
    expect(h.transfers()[0]).toMatchObject({ amount: '26.14', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' });
    expect(h.jobs.read()!.steps.at(-1)).toMatchObject({ name: 'Convert', planned: 3.86 });
  });

  it('loop stops under 11', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 30), round(2, 30)] }, {
      getCrossexAccount: seq(account({ marginBalance: 8, gate: 200 })),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Free margin is too low for the next round.');
    expect(job.stepIndex).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
  });

  it('loop under 11 sends nothing', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'loop', steps: [round(1, 30), round(2, 30)] },
      {
        getCrossexAccount: seq(account({ marginBalance: 8, gate: 200 })),
        createCrossexOrder: seq(created('o9')),
        createCrossexTransfer: seq(tx('x9')),
        createCrossexConvertQuote: seq(quote('q9', '30')),
      },
      (job) => {
        for (const index of [0, 1, 2]) doneStep(job, index, { venueId: `v${index}`, qty: 30, at: clock.now() });
        job.stepIndex = 3;
        job.fundsAt = 'HYPERLIQUID';
      },
    );

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', stepIndex: 3, haltReason: HALT_TEXT.marginTooLow });
    expect(h.count('getCrossexAccount')).toBe(1);
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('createCrossexTransfer')).toBe(0);
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.jobs.read()!.steps[3].text).toBeNull();
  });

  it('a loop round short of cash halts with the cash text', async () => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ hyperliquid: 5 })),
      createCrossexTransfer: seq(tx('x1')),
    });

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: 'Not enough cash for an 11 USDC round.' });
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('mix under 11 drops the remaining rounds', async () => {
    const h = harness(fakeClock(), { route: 'mix', steps: [round(1, 30), round(2, 40), convert(50)] }, {
      getCrossexAccount: seq(account({ marginBalance: 8, gate: 0 })),
      createCrossexConvertQuote: seq(quote('q1', '119.8')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps.map((s) => s.name)).toEqual(['Convert']);
    expect(job.status).toBe('done');
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('mix under 11 converts the rest', async () => {
    const h = harness(fakeClock(), { route: 'mix', steps: [round(1, 30), round(2, 40), convert(50)] }, {
      getCrossexAccount: seq(account({ marginBalance: 8, gate: 0 })),
      createCrossexConvertQuote: seq(quote('q1', '119.8')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    expect(h.jobs.read()!.steps[0]).toMatchObject({ name: 'Convert', planned: 120, status: 'done' });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe('120');
  });

  it('sent step skips the fit check', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'loop', steps: [round(1, 24.51)] },
      {
        getCrossexAccount: seq(account({ marginBalance: 0 })),
        createCrossexTransfer: seq(tx('x2')),
        listCrossexTransfers: seq(
          rows(row('x1', 'SUCCESS', { actualReceive: '24.51' })),
          rows(row('x2', 'SUCCESS', { actualReceive: '24.46' })),
        ),
      },
      (job) => {
        doneStep(job, 0, { venueId: 'o1', qty: 0, at: clock.now() });
        Object.assign(job.steps[1], { text: tagFor(job.id, 1), venueId: 'x1', status: 'running', startedAt: clock.now() });
        job.stepIndex = 1;
        job.fundsAt = 'GATE';
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[1]).toMatchObject({ venueId: 'x1', qty: 24.51, status: 'done' });
    expect(h.count('getCrossexAccount')).toBe(0);
    expect(h.transfers()).toHaveLength(1);
  });

  it('buy under 11 sends no Hyperliquid transfer', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 11, 11)] }, {
      getCrossexAccount: seq(account({ gate: 0 }), account({ gate: 10.98 })),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('FILLED', '10.98')),
      createCrossexTransfer: seq(tx('x1')),
    });

    await h.run();

    expect(h.jobs.read()!.steps[0]).toMatchObject({ status: 'done', qty: 10.98 });
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('halt text for a short buy', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 11, 11)] }, {
      getCrossexAccount: seq(account({ gate: 0 }), account({ gate: 10.98 })),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('FILLED', '10.98')),
    });

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: 'The USDC buy filled under 11 USDC.' });
  });

  it('a buy that lands a cent short sends what landed and adds no round', async () => {
    const h = harness(fakeClock(), oneRound, happyLoop());

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps).toHaveLength(3);
    expect(job.steps.map((s) => s.planned)).toEqual([12, 11.99, 11.99]);
  });
});

describe('runJob Gate bucket', () => {
  it('Gate bucket first no buy', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: accountALoop }, {
      getCrossexAccount: seq(accountA),
      createCrossexOrder: seq(created('o1')),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.jobs.read()!.steps[0]).toMatchObject({ name: 'Buy USDC', status: 'done', qty: 0, venueId: null, text: null });
    expect(h.jobs.read()!.steps[0].doneAt).toBeTypeOf('number');
  });

  it('buy meets the quote minimum', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 11, 2)] }, {
      getCrossexAccount: seq(account({ gate: 9 }), account({ gate: 11.99 })),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('FILLED', '2.99')),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toEqual({
      symbol: 'GATE_SPOT_USDC_USDT',
      side: 'BUY',
      type: 'MARKET',
      quoteQty: '3',
      text: tagFor(h.job.id, 1),
    });
    expect(h.transfers()[0].amount).toBe('11');
  });

  it('buy covers the round at the ask', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 11, 11)] }, {
      getCrossexAccount: seq(account({ gate: 0 })),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('REJECT', '0')),
    });

    await h.run();

    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest.quoteQty).toBe('11.01');
    expect(h.calls.listTickers[0]).toEqual({ currencyPair: 'USDC_USDT' });
  });

  it('buy uses the rest when the ask is missing', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 11, 11)] }, {
      getCrossexAccount: seq(account({ gate: 0 })),
      listTickers: seq({ body: [] }),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('REJECT', '0')),
    });

    await h.run();

    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest.quoteQty).toBe('11');
  });

  it('sells Gate bucket before Convert', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'mix', steps: [round(1, 30), convert(50)] },
      {
        getCrossexAccount: seq(account({ gate: 20.93 }), account({ gate: 20.93 }), account({ gate: 0, usdt: 1_020.92 })),
        createCrossexOrder: seq(created('o5')),
        getCrossexOrder: seq(order('FILLED', '20.93', 'o5', { executedAmount: '20.92' })),
        createCrossexConvertQuote: seq(quote('q1', '49.9')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
      },
      (job) => atConvert(job, clock.now()),
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toEqual({
      symbol: 'GATE_SPOT_USDC_USDT',
      side: 'SELL',
      type: 'MARKET',
      qty: '20.93',
      text: tagFor(job.id, 3),
    });
    expect(h.sequence.indexOf('createCrossexOrder')).toBeLessThan(h.sequence.indexOf('createCrossexConvertQuote'));
    expect(job.steps.slice(3).map(({ name, round: r, planned, qty }) => ({ name, round: r, planned, qty }))).toEqual([
      { name: 'Sell USDC', round: null, planned: 20.93, qty: 20.92 },
      { name: 'Convert', round: null, planned: 50, qty: 49.9 },
    ]);
    expect(h.calls.listTickers[0]).toEqual({ currencyPair: 'USDC_USDT' });
  });

  it('no sell under the quote minimum', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'mix', steps: [round(1, 30), convert(50)] },
      {
        getCrossexAccount: seq(account({ gate: 2.5 })),
        createCrossexOrder: seq(created('o5')),
        createCrossexConvertQuote: seq(quote('q1', '49.9')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
      },
      (job) => atConvert(job, clock.now()),
    );

    await h.run();

    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.jobs.read()!.steps.map((s) => s.name)).toEqual(['Buy USDC', 'To spot', 'To Hyperliquid', 'Convert']);
  });

  it('never reads the bid for Gate bucket dust under 1', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'mix', steps: [round(1, 30), convert(50)] },
      {
        getCrossexAccount: seq(account({ gate: 0.29 })),
        createCrossexConvertQuote: seq(quote('q1', '49.9')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
      },
      (job) => atConvert(job, clock.now()),
    );

    await h.run();

    expect(h.jobs.read()!.status).toBe('done');
    expect(h.count('listTickers')).toBe(0);
  });

  it('sells Gate bucket before Convert toward USDT', async () => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'convert', steps: [convert(50)] }, {
      getCrossexAccount: seq(
        account({ gate: 20.93, hyperliquid: 60 }),
        account({ gate: 20.93, hyperliquid: 60 }),
        account({ gate: 0, hyperliquid: 60 }),
      ),
      createCrossexOrder: seq(created('o5')),
      getCrossexOrder: seq(order('FILLED', '20.93', 'o5', { executedAmount: '20.92' })),
      createCrossexConvertQuote: seq(quote('q1', '49.9')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(job.steps.map(({ name, round: r, planned, qty }) => ({ name, round: r, planned, qty }))).toEqual([
      { name: 'Sell USDC', round: null, planned: 20.93, qty: 20.92 },
      { name: 'Convert', round: null, planned: 50, qty: 49.9 },
    ]);
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toMatchObject({ side: 'SELL', qty: '20.93' });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest).toMatchObject({ fromCoin: 'USDC', fromAmount: '50' });
    expect(h.sequence.indexOf('createCrossexOrder')).toBeLessThan(h.sequence.indexOf('createCrossexConvertQuote'));
  });

  it('a round Sell USDC sells the whole Gate bucket', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { direction: 'toUsdt', route: 'loop', steps: [round(1, 20)] },
      {
        getCrossexAccount: seq(account({ gate: 24.87 })),
        createCrossexOrder: seq(created('o3')),
        getCrossexOrder: seq(order('FILLED', '24.87', 'o3', { executedAmount: '24.86' })),
      },
      (job) => {
        doneStep(job, 0, { venueId: 'x1', qty: 20, at: clock.now() });
        doneStep(job, 1, { venueId: 'x2', qty: 19, at: clock.now() });
        job.stepIndex = 2;
        job.fundsAt = 'GATE';
      },
    );

    await h.run();

    expect(h.sent('createCrossexOrder')).toHaveLength(1);
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toMatchObject({ side: 'SELL', qty: '24.87' });
    expect(h.jobs.read()).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
  });

  it('a Sell USDC inserted after dropped rounds gets a tag no earlier step had', async () => {
    const clock = fakeClock();
    const earlier: string[] = [];
    const h = harness(
      clock,
      { route: 'mix', steps: [round(1, 30), round(2, 30), convert(50)] },
      {
        getCrossexAccount: seq(account({ marginBalance: 8, gate: 20.93 })),
        createCrossexOrder: seq(created('o5')),
        getCrossexOrder: seq(order('REJECT', '0', 'o5')),
      },
      (job) => {
        for (const index of [0, 1, 2]) doneStep(job, index, { venueId: `v${index}`, qty: 30, at: clock.now() });
        job.tagCount = 3;
        earlier.push(...job.steps.slice(0, 3).map((step) => step.text!), tagFor(job.id, 3));
        Object.assign(job.steps[3], { attempt: 1, status: 'running', startedAt: clock.now() });
        job.stepIndex = 3;
        job.fundsAt = 'GATE';
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps.map((step) => step.name)).toEqual([...TO_USDC_STEPS, 'Sell USDC', 'Convert']);
    const tag = h.sent('createCrossexOrder')[0].crossexOrderRequest.text;
    expect(tag).toBe(tagFor(job.id, 4));
    expect(earlier).not.toContain(tag);
  });
});

describe('runJob Convert', () => {
  it('quote floor uses the step amount', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'mix', steps: [round(1, 316.19), convert(7_521.59)] },
      {
        getCrossexAccount: seq(account({ usdt: 12_081.77, gate: 0 })),
        createCrossexConvertQuote: seq(quote('q1', '7506.55')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
      },
      (job) => atConvert(job, clock.now()),
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.amount).toBeCloseTo(7_837.78, 2);
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe('7521.59');
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(job.status).toBe('done');
  });

  it('halt on a poor quote', async () => {
    const below = String(12 * QUOTE_FLOOR - 0.01);
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', below)),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Convert quote was more than 0.3% under market.');
    expect(job.steps[0].quoteId).toBeNull();
    expect(job.steps[0].venueId).toBeNull();
    expect(h.count('createCrossexConvertOrder')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
  });

  it('quotes, sends the order, and is done with one step', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });
    await h.cache.get('account', 60_000, async () => 'old');

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps).toHaveLength(1);
    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps[0]).toMatchObject({
      name: 'Convert',
      text: tagFor(job.id, 1),
      quoteId: 'q1',
      venueId: 'c1',
      qty: 11.976,
      status: 'done',
    });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest).toEqual({
      exchangeType: 'HYPERLIQUID',
      fromCoin: 'USDT',
      toCoin: 'USDC',
      fromAmount: '12',
    });
    expect(h.sent('createCrossexConvertOrder')[0].crossexConvertOrderRequest).toEqual({ quoteId: 'q1' });
    expect(h.count('getCrossexOrder')).toBe(0);
    const { value } = await h.cache.get('account', 60_000, async () => 'new');
    expect(value).toBe('new');
  });

  it('sends no more than the sending wallet cash, and floors the quote at what it sends', async () => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'convert', steps: [convert(50)] }, {
      getCrossexAccount: seq(account({ hyperliquid: 22.18 })),
      createCrossexConvertQuote: seq(quote('q1', '22.13')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest).toEqual({
      exchangeType: 'HYPERLIQUID',
      fromCoin: 'USDC',
      toCoin: 'USDT',
      fromAmount: '22.18',
    });
    expect(h.jobs.read()).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
  });

  it('holds the quote id on disk before the order call, so a lost response is found on Gate by that id and nothing is sent twice', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c9', text: 'q1' } }),
      getCrossexOrder: seq(order('FILLED', '12', 'c1', { executedAmount: '11.976' })),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: 'c1', qty: 11.976, status: 'done' });
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.calls.getCrossexOrder).toEqual(['q1', 'c1']);
    expect(job.steps[0].doneAt! - job.steps[0].startedAt!).toBe(POLL_MS);
  });

  it('re-quotes and sends once more when Gate does not know the quote id for 2 min', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976'), quote('q2', '11.97')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c2', text: 'q2' } }),
      getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({ body: [convertRow('c0', 'q0', 'HYPERLIQUID_CONVERT_USDT_USDC', '5')] }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, status: 'done' });
    expect(h.count('createCrossexConvertQuote')).toBe(2);
    expect(h.count('createCrossexConvertOrder')).toBe(2);
    expect(h.calls.getCrossexOrder).toEqual(Array(LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1).fill('q1'));
    expect(h.calls.listCrossexHistoryOrders).toEqual([
      { symbol: 'HYPERLIQUID_CONVERT_USDT_USDC', from: job.createdAt - 600_000, limit: 100, page: 1 },
    ]);
    expect(job.steps[0].doneAt! - job.steps[0].startedAt!).toBe(POLL_MS + LOOKUP_WINDOW_MS);
  });

  it('a Convert Gate lists in its order history by quote id is adopted and never sent twice', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976'), quote('q2', '11.97')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c2', text: 'q2' } }),
      getCrossexOrder: async (id: string) =>
        id === 'c1'
          ? order('FILLED', '12', 'c1', { executedAmount: '11.97' })
          : gateError(404, 'ORDER_NOT_FOUND', 'order not found')(),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({
        body: [
          convertRow('c0', 'q0', 'HYPERLIQUID_CONVERT_USDT_USDC', '5'),
          convertRow('c1', 'q1', 'HYPERLIQUID_CONVERT_USDT_USDC', '11.97'),
        ],
      }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: 'c1', qty: 11.97, status: 'done' });
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
  });

  it('a Convert halts and sends nothing when the order history cannot be read', async () => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'convert', steps: [convert(20)] }, {
      getCrossexAccount: seq(account({ hyperliquid: 60 })),
      createCrossexConvertQuote: seq(quote('q1', '19.96'), quote('q2', '19.95')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c2', text: 'q2' } }),
      getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: async (arg: { symbol: string }) => {
        if (arg.symbol === 'HYPERLIQUID_CONVERT_USDC_USDT') return networkError();
        return { body: [] };
      },
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.unconfirmed });
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null });
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(h.sent('listCrossexHistoryOrders').map((arg) => arg.symbol)).toEqual(['HYPERLIQUID_CONVERT_USDC_USDT']);
  });

  it('a refused Convert order clears its quote id, so a resume quotes again', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976'), quote('q2', '11.97')),
      createCrossexConvertOrder: seq(gateError(400, 'CONVERT_QUOTE_EXPIRED', 'quote expired'), {
        body: { orderId: 'c2', text: 'q2' },
      }),
    });

    await h.run();

    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', haltReason: 'Quote expired.' });
    expect(halted.steps[0].quoteId).toBeNull();

    halted.status = 'running';
    halted.haltReason = null;
    h.jobs.write(halted);
    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, status: 'done' });
    expect(h.count('getCrossexOrder')).toBe(0);
    expect(h.count('createCrossexConvertOrder')).toBe(2);
  });
});

describe('runJob transfers', () => {
  it('no actualReceive takes off the fee', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { direction: 'toUsdt', route: 'loop', steps: [round(1, 11)] },
      {
        createCrossexTransfer: seq(tx('x2')),
        listCrossexTransfers: seq(rows(row('x1', 'SUCCESS', { amount: '11' })), rows(row('x2', 'FAILED'))),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 0), venueId: 'x1', status: 'running', startedAt: clock.now() });
      },
    );

    await h.run();

    expect(h.jobs.read()!.steps[0]).toMatchObject({ name: 'From Hyperliquid', status: 'done', qty: 10 });
    expect(h.transfers()[0]).toMatchObject({ amount: '10', from: 'SPOT', to: 'CROSSEX_GATE' });
  });

  it('numeric id matches', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      { listCrossexTransfers: seq({ body: [{ id: 123, status: 'SUCCESS', amount: '11.99', actualReceive: '11.94' }] }) },
      (job) => resumeAtLastTransfer(job, clock.now(), { venueId: '123' }),
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps[2]).toMatchObject({ status: 'done', venueId: '123', qty: 11.94 });
    expect(job.status).toBe('done');
  });

  it('lookups run for 2 min', async () => {
    const clock = fakeClock();
    let sentAt = -1;
    const lookups: number[] = [];
    const h = harness(clock, { route: 'loop', steps: [round(1, 12)] }, {
      getCrossexAccount: seq(account({ gate: 200 })),
      createCrossexTransfer: async (arg: { crossexTransferRequest: { to: string } }) => {
        if (arg.crossexTransferRequest.to === 'SPOT') {
          sentAt = clock.now();
          return networkError();
        }
        return tx('x2');
      },
      listCrossexTransfers: async () => {
        lookups.push(clock.now());
        if (sentAt < 0 || clock.now() - sentAt < 60_000) return rows();
        return rows(
          row('x1', 'SUCCESS', { text: tagFor((1_000_000).toString(36), 1), actualReceive: '12' }),
          row('x2', 'SUCCESS', { actualReceive: '11.95' }),
        );
      },
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[1]).toMatchObject({ venueId: 'x1', qty: 12 });
    expect(h.transfers().filter((t) => t.text === tagFor(job.id, 1))).toHaveLength(1);
    const adoptedAt = lookups.findIndex((at) => at - sentAt >= 60_000);
    expect(lookups[adoptedAt] - sentAt).toBeGreaterThanOrEqual(60_000);
    expect(lookups[adoptedAt] - lookups[0]).toBeLessThan(LOOKUP_WINDOW_MS);
    expect(lookups[1] - lookups[0]).toBe(LOOKUP_RETRY_MS);
  });

  it('runs to done with three venue ids and the qty chain 12 → 11.99 → 11.99 → 11.94', async () => {
    const h = harness(fakeClock(), oneRound, happyLoop());
    await h.cache.get('account', 60_000, async () => 'old');

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.haltReason).toBeNull();
    expect(job.stepIndex).toBe(2);
    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps.map((s) => s.venueId)).toEqual(['o1', 'x1', 'x2']);
    expect(job.steps.map((s) => s.qty)).toEqual([11.99, 11.99, 11.94]);
    expect(job.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toEqual({
      symbol: 'GATE_SPOT_USDC_USDT',
      side: 'BUY',
      type: 'MARKET',
      quoteQty: '12.01',
      text: tagFor(job.id, 1),
    });
    expect(h.transfers()).toEqual([
      { coin: 'USDC', amount: '11.99', from: 'CROSSEX_GATE', to: 'SPOT', text: tagFor(job.id, 2) },
      { coin: 'USDC', amount: '11.99', from: 'SPOT', to: 'CROSSEX_HYPERLIQUID', text: tagFor(job.id, 3) },
    ]);
    expect(h.calls.listCrossexTransfers[0]).toEqual({ coin: 'USDC', limit: 100 });
    expect(h.onHalt).not.toHaveBeenCalled();

    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'rebalance.json'), 'utf8')) as Job;
    expect(onDisk.status).toBe('done');
    expect(onDisk.steps.map((s) => s.venueId)).toEqual(['o1', 'x1', 'x2']);

    const { value } = await h.cache.get('account', 60_000, async () => 'new');
    expect(value).toBe('new');
  });

  it('halts on a transfer SUCCESS that received nothing', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      listCrossexTransfers: seq(rows(row('x1', 'SUCCESS', { amount: '0' }))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('transfer SUCCESS with nothing received');
    expect(job.fundsAt).toBe('GATE');
    expect(job.steps[1].venueId).toBe('x1');
  });

  it('halts on a CANCELLED transfer and clears its ids for a fresh send', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      listCrossexTransfers: seq(rows(row('x1', 'CANCELLED'))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Transfer failed.');
    expect(job.steps[1].venueId).toBeNull();
    expect(job.steps[1].text).toBeNull();
  });

  it('adopts a transfer by tag on the next pass when the send response has no txId', async () => {
    const id = (1_000_000).toString(36);
    const x1 = row('x1', 'SUCCESS', { actualReceive: '11.99', text: tagFor(id, 2) });
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      createCrossexTransfer: seq({ body: { text: 't' } }, tx('x2')),
      listCrossexTransfers: seq(rows(x1), rows(x1), rows(x1, row('x2', 'SUCCESS', { actualReceive: '11.94' }))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.id).toBe(id);
    expect(job.status).toBe('done');
    expect(job.steps.map((s) => s.venueId)).toEqual(['o1', 'x1', 'x2']);
    expect(h.count('createCrossexTransfer')).toBe(2);
  });

  it('halts on a FAILED transfer with its reason and fundsAt GATE, and a resume sends one new transfer', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      createCrossexTransfer: seq(tx('x1'), tx('x2'), tx('x3')),
      listCrossexTransfers: seq(
        rows(row('x1', 'FAILED', { failReason: 'insufficient balance' })),
        rows(row('x2', 'SUCCESS', { actualReceive: '11.99' })),
        rows(row('x3', 'SUCCESS', { actualReceive: '11.94' })),
      ),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Transfer failed: insufficient balance.');
    expect(job.fundsAt).toBe('GATE');
    expect(job.stepIndex).toBe(1);
    expect(job.steps[0].status).toBe('done');
    expect(job.steps[1].venueId).toBeNull();
    expect(job.steps[1].text).toBeNull();
    expect(h.count('createCrossexTransfer')).toBe(1);
    expect(h.onHalt).toHaveBeenCalledTimes(1);

    job.status = 'running';
    job.haltReason = null;
    h.jobs.write(job);
    await h.run();

    const resumed = h.jobs.read()!;
    expect(resumed.steps[1].attempt).toBe(1);
    expect(h.transfers()[1].text).toBe(tagFor(job.id, 3));
    expect(resumed.status).toBe('done');
    expect(resumed.steps.map((s) => s.venueId)).toEqual(['o1', 'x2', 'x3']);
    expect(h.count('createCrossexTransfer')).toBe(3);
  });

  it('a refused To spot halts with the margin text', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: accountALoop }, {
      getCrossexAccount: seq(accountA),
      createCrossexTransfer: seq(
        gateError(422, 'TRANSFER_AMOUNT_INSUFFICIENT', 'Insufficient transferAvailable, transferAvailable: 25.08'),
      ),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 1, fundsAt: 'GATE' });
    expect(job.haltReason).toBe('Gate refused the move: free margin is too low.');
    expect(h.count('createCrossexTransfer')).toBe(1);
  });

  it('a spot step refused for spot balance names what Gate spot has', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      {
        createCrossexTransfer: seq(
          gateError(422, 'TRANSFER_AMOUNT_INSUFFICIENT', 'Insufficient transferAvailable, transferAvailable: 12.5'),
        ),
      },
      (job) => {
        doneStep(job, 0, { venueId: 'o1', qty: 13, at: clock.now() });
        doneStep(job, 1, { venueId: 'x1', qty: 13, at: clock.now() });
        job.stepIndex = 2;
        job.fundsAt = 'SPOT';
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 2, fundsAt: 'SPOT' });
    expect(job.steps[2].name).toBe('To Hyperliquid');
    expect(job.haltReason).toBe('Gate spot has only 12.50 USDC.');
    expect(h.transfers()).toEqual([
      { coin: 'USDC', amount: '13', from: 'SPOT', to: 'CROSSEX_HYPERLIQUID', text: tagFor(job.id, 2) },
    ]);
  });

  it('a transfer that rounds to 0 sends nothing and halts', async () => {
    const clock = fakeClock();
    const h = harness(clock, oneRound, happyLoop(), (job) => {
      doneStep(job, 0, { venueId: 'o1', qty: 11.99, at: clock.now() });
      doneStep(job, 1, { venueId: 'x1', qty: 0.000004, at: clock.now() });
      job.stepIndex = 2;
      job.fundsAt = 'SPOT';
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 2, haltReason: HALT_TEXT.cashTooLow });
    expect(job.steps[2].text).toBeNull();
    expect(h.count('createCrossexTransfer')).toBe(0);
  });
});

describe('runJob halts', () => {
  it('calls onHalt once, after the halted job is on disk', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ marginBalance: 8, gate: 200 })),
    });
    const seen: unknown[] = [];
    h.onHalt.mockImplementation((job: Job) => {
      const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'rebalance.json'), 'utf8')) as Job;
      seen.push({ status: job.status, onDisk: onDisk.status, reason: onDisk.haltReason });
    });

    await h.run();

    expect(seen).toEqual([{ status: 'halted', onDisk: 'halted', reason: HALT_TEXT.marginTooLow }]);
  });

  it('halts when the order ends terminal with nothing filled', async () => {
    const h = harness(fakeClock(), oneRound, { ...happyLoop(), getCrossexOrder: seq(order('REJECT', '0')) });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('order REJECT with nothing filled');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.stepIndex).toBe(0);
    expect(job.steps[0].venueId).toBeNull();
    expect(job.steps[0].text).toBeNull();
    expect(job.steps[0].status).toBe('running');
    expect(h.count('createCrossexTransfer')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, status: 'halted' }));
  });

  it('subtracts a USDC fee from the executed qty', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      getCrossexAccount: seq(account({ gate: 0 }), account({ gate: 11.978 })),
      getCrossexOrder: seq(order('FILLED', '11.99', 'o1', { feeCoin: 'USDC', fee: '0.012' })),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { actualReceive: '11.97' })),
        rows(row('x2', 'SUCCESS', { actualReceive: '11.92' })),
      ),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0].qty).toBe(11.978);
    expect(h.transfers()[0].amount).toBe('11.97');
  });

  it('keeps a USDT fee out of the executed qty', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      getCrossexOrder: seq(order('FILLED', '11.99', 'o1', { feeCoin: 'USDT', fee: '0.012' })),
    });

    await h.run();

    expect(h.jobs.read()!.steps[0].qty).toBe(11.99);
  });

  it('keeps polling through an ACTIVE state and finishes on FILLED', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      getCrossexOrder: seq(order('ACTIVE', '0'), order('ACTIVE', '0'), order('FILLED', '11.99')),
    });

    await h.run();

    expect(h.jobs.read()!.status).toBe('done');
    expect(h.count('getCrossexOrder')).toBe(3);
  });

  it('treats a 404 on a poll as transient and finishes on the next FILLED', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found'), order('FILLED', '11.99')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.haltReason).toBeNull();
    expect(h.count('getCrossexOrder')).toBe(2);
  });

  it('halts on a step name it does not know before any venue call', async () => {
    const h = harness(fakeClock(), oneRound, happyLoop(), (job) => {
      job.steps[0].name = 'Bogus';
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('unknown step Bogus');
    expect(h.count('getCrossexAccount')).toBe(0);
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('halts with the timeout text after 600 s without a terminal state', async () => {
    const clock = fakeClock();
    const h = harness(clock, oneRound, { ...happyLoop(), getCrossexOrder: seq(order('OPEN', '0')) });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Gate took too long on this step. Press Resume to check again.');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps[0].venueId).toBe('o1');
    expect(job.steps[0].text).toBe(tagFor(job.id, 1));
    expect(clock.now() - job.steps[0].startedAt!).toBe(STEP_TIMEOUT_MS + POLL_MS);
    expect(h.count('getCrossexOrder')).toBe(STEP_TIMEOUT_MS / POLL_MS + 1);
    expect(h.count('createCrossexOrder')).toBe(1);
  });

  it('halts on a 4xx label at send with the message and the hint', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      createCrossexOrder: seq(gateError(401, 'INVALID_KEY', 'invalid key')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Gate refused the API key. Check it in Settings.');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps[0].text).toBe(tagFor(job.id, 1));
    expect(job.steps[0].venueId).toBeNull();
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(h.count('getCrossexOrder')).toBe(0);
  });

  it('halts on a 4xx label without a hint with the message alone', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      createCrossexOrder: seq(gateError(400, 'TRADE_INVALID_QUOTE_ORDER_QTY', 'bad qty')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Bad qty.');
    expect(h.count('createCrossexOrder')).toBe(1);
  });

  it('waits one POLL_MS after a rate-limited poll and reads again with no state change', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      getCrossexOrder: seq(gateError(429, 'TOO_MANY_REQUESTS', 'slow down'), order('FILLED', '11.99')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.count('getCrossexOrder')).toBe(2);
    expect(job.steps[0].doneAt! - job.steps[0].startedAt!).toBe(POLL_MS);
  });

  it('halts when the account read has no margin balance and sends nothing', async () => {
    const h = harness(fakeClock(), oneRound, {
      ...happyLoop(),
      getCrossexAccount: seq({ body: { marginBalance: 'x', initialMargin: '0', assets: [] } }),
    });

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: 'account read has no margin balance' });
    expect(h.count('createCrossexOrder')).toBe(0);
  });

  it('finds the order by tag after a 5xx at send and does not send again', async () => {
    const clock = fakeClock();
    const lookups: number[] = [];
    const h = harness(clock, oneRound, {
      ...happyLoop(),
      createCrossexOrder: seq(gateError(500, 'INTERNAL', 'boom')),
      getCrossexOrder: async (id: string) => {
        if (id.startsWith('t-')) lookups.push(clock.now());
        return order('FILLED', '11.99');
      },
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(job.steps[0].venueId).toBe('o1');
    expect(lookups).toEqual([job.steps[0].startedAt! + POLL_MS]);
    expect(h.calls.getCrossexOrder[0]).toBe(tagFor(job.id, 1));
  });
});

describe('runJob resumed steps send nothing twice', () => {
  it('a step with a venueId makes one read and no send', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        listCrossexTransfers: seq(rows(row('x2', 'SUCCESS', { actualReceive: '11.94' }))),
      },
      (job) => resumeAtLastTransfer(job, clock.now(), { venueId: 'x2' }),
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps[2].qty).toBe(11.94);
    expect(h.count('listCrossexTransfers')).toBe(1);
    expect(h.count('createCrossexTransfer')).toBe(0);
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('getCrossexOrder')).toBe(0);
    expect(h.count('getCrossexAccount')).toBe(0);
  });

  it('a Buy step with text only, found on lookup, records the id and sends nothing', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      { ...happyLoop(), getCrossexAccount: seq(account({ gate: 11.99 })), getCrossexOrder: seq(order('FILLED', '11.99', 'o1')) },
      (job) => {
        job.steps[0].text = tagFor(job.id, 0);
        job.steps[0].status = 'running';
        job.steps[0].startedAt = clock.now();
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0].venueId).toBe('o1');
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.calls.getCrossexOrder).toEqual([tagFor(job.id, 0), 'o1']);
  });

  it('a transfer step with text only, found on lookup, records the id and sends nothing', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        listCrossexTransfers: seq(rows(row('x2', 'SUCCESS', { actualReceive: '11.94', text: 'tag2' }))),
      },
      (job) => resumeAtLastTransfer(job, clock.now(), { text: 'tag2' }),
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[2].venueId).toBe('x2');
    expect(job.steps[2].qty).toBe(11.94);
    expect(h.count('createCrossexTransfer')).toBe(0);
    expect(h.count('listCrossexTransfers')).toBe(2);
  });

  it('a Buy step not found for 2 min looks up every 10 s, then sends once', async () => {
    const clock = fakeClock();
    const lookups: number[] = [];
    let sentAt = -1;
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        createCrossexOrder: async () => {
          sentAt = clock.now();
          return created('o1');
        },
        getCrossexOrder: async (id: string) => {
          if (id === 'o1') return order('FILLED', '11.99');
          lookups.push(clock.now());
          return gateError(404, 'ORDER_NOT_FOUND', 'order not found')();
        },
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq({ body: [] }),
      },
      (job) => {
        job.steps[0].text = tagFor(job.id, 0);
        job.steps[0].status = 'running';
        job.steps[0].startedAt = clock.now();
      },
    );
    const t0 = clock.now();

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0].venueId).toBe('o1');
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(lookups).toEqual(Array.from({ length: LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1 }, (_, i) => t0 + i * LOOKUP_RETRY_MS));
    expect(sentAt).toBe(t0 + LOOKUP_WINDOW_MS);
  });

  it('a Buy step Gate lists in its order history is adopted and never sent twice', async () => {
    const clock = fakeClock();
    let tag = '';
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        getCrossexAccount: seq(account({ gate: 11.99 })),
        getCrossexOrder: async (id: string) =>
          id === 'o7' ? order('FILLED', '11.99', 'o7') : gateError(404, 'ORDER_NOT_FOUND', 'order not found')(),
        listCrossexOpenOrders: seq({ body: [{ orderId: 'o8', text: 't-other' }] }),
        listCrossexHistoryOrders: async () => ({ body: [{ orderId: 'o6', text: 't-other' }, { orderId: 'o7', text: tag }] }),
      },
      (job) => {
        tag = tagFor(job.id, 1);
        Object.assign(job.steps[0], { text: tag, status: 'running', startedAt: clock.now() });
        job.tagCount = 1;
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ venueId: 'o7', qty: 11.99, status: 'done' });
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.calls.listCrossexOpenOrders).toEqual([{ symbol: 'GATE_SPOT_USDC_USDT' }]);
    expect(h.calls.listCrossexHistoryOrders).toEqual([
      { symbol: 'GATE_SPOT_USDC_USDT', from: job.createdAt - 600_000, limit: 100, page: 1 },
    ]);
  });

  it('a Buy step missing from open orders and every history page is sent once', async () => {
    const clock = fakeClock();
    const others = Array.from({ length: 100 }, (_, i) => ({ orderId: `h${i}`, text: `t-other${i}` }));
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        getCrossexOrder: async (id: string) =>
          id === 'o1' ? order('FILLED', '11.99') : gateError(404, 'ORDER_NOT_FOUND', 'order not found')(),
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq({ body: others }, { body: others.slice(0, 3) }),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 1), status: 'running', startedAt: clock.now() });
        job.tagCount = 1;
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.sent('createCrossexOrder').map((arg) => arg.crossexOrderRequest.text)).toEqual([tagFor(job.id, 1)]);
    expect(h.sent('listCrossexHistoryOrders').map((arg) => arg.page)).toEqual([1, 2]);
  });

  it('a Buy step halts and sends nothing when the order history cannot be read', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq(networkError),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 1), status: 'running', startedAt: clock.now() });
        job.tagCount = 1;
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.unconfirmed });
    expect(job.steps[0]).toMatchObject({ text: tagFor(job.id, 1), venueId: null });
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
  });

  it('a Buy step halts and sends nothing when the order history runs past the page cap', async () => {
    const clock = fakeClock();
    const others = Array.from({ length: 100 }, (_, i) => ({ orderId: `h${i}`, text: `t-other${i}` }));
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq({ body: others }),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 1), status: 'running', startedAt: clock.now() });
        job.tagCount = 1;
      },
    );

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.unconfirmed });
    expect(h.count('listCrossexHistoryOrders')).toBe(50);
    expect(h.count('createCrossexOrder')).toBe(0);
  });

  it('a Sell USDC step sent again after its first sale landed sells only the cash left', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { direction: 'toUsdt', route: 'loop', steps: [round(1, 20)] },
      {
        getCrossexAccount: seq(account({ gate: 12.349 })),
        getCrossexOrder: async (id: string) =>
          id === 'o3'
            ? order('FILLED', '12.34', 'o3', { executedAmount: '12.33' })
            : gateError(404, 'ORDER_NOT_FOUND', 'order not found')(),
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq({ body: [] }),
        createCrossexOrder: seq(created('o3')),
      },
      (job) => {
        doneStep(job, 0, { venueId: 'x1', qty: 20, at: clock.now() });
        doneStep(job, 1, { venueId: 'x2', qty: 19, at: clock.now() });
        Object.assign(job.steps[2], { text: tagFor(job.id, 2), status: 'running', startedAt: clock.now() });
        job.tagCount = 2;
        job.stepIndex = 2;
        job.fundsAt = 'GATE';
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.sent('createCrossexOrder')).toHaveLength(1);
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toMatchObject({ side: 'SELL', qty: '12.34', text: tagFor(job.id, 2) });
    const read = h.sequence.indexOf('getCrossexAccount');
    expect(read).toBeGreaterThan(h.sequence.indexOf('listCrossexHistoryOrders'));
    expect(read).toBeLessThan(h.sequence.indexOf('createCrossexOrder'));
  });

  it('a convert step with a quoteId that Gate knows adopts the order and sends nothing', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'convert', steps: [convert(12)] },
      {
        getCrossexAccount: seq(account()),
        createCrossexConvertQuote: seq(quote('q2', '11.976')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c2', text: 'q2' } }),
        getCrossexOrder: seq(order('FILLED', '12', 'c1', { executedAmount: '11.97' })),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 0), quoteId: 'q1', qty: 11.976, status: 'running', startedAt: clock.now() });
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: 'c1', qty: 11.97, status: 'done' });
    expect(h.calls.getCrossexOrder).toEqual(['q1', 'c1']);
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
  });

  it('a convert step with a quoteId Gate does not know re-quotes and sends once', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'convert', steps: [convert(12)] },
      {
        getCrossexAccount: seq(account()),
        createCrossexConvertQuote: seq(quote('q2', '11.97')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c2', text: 'q2' } }),
        getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq({ body: [convertRow('c0', 'q0', 'HYPERLIQUID_CONVERT_USDT_USDC', '5')] }),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 0), quoteId: 'q1', qty: 11.976, status: 'running', startedAt: clock.now() });
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, status: 'done' });
    expect(h.calls.getCrossexOrder).toEqual(Array(LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1).fill('q1'));
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
  });

  it('a poll-only run adopts nothing new and halts before it would send', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      oneRound,
      {
        ...happyLoop(),
        getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
        listCrossexOpenOrders: seq({ body: [] }),
        listCrossexHistoryOrders: seq({ body: [] }),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 1), status: 'running', startedAt: clock.now() });
        job.tagCount = 1;
      },
    );

    await runJob({ ...h.deps, pollOnly: true });

    expect(h.jobs.read()).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.restart });
    expect(h.count('listCrossexHistoryOrders')).toBe(1);
    expect(h.count('getCrossexAccount')).toBe(0);
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
  });

  it('a poll-only run lands a sent step, then halts before the next send', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'loop', steps: [round(1, 12), round(2, 12)] },
      { listCrossexTransfers: seq(rows(row('x2', 'PENDING')), rows(row('x2', 'SUCCESS', { actualReceive: '11.94' }))) },
      (job) => resumeAtLastTransfer(job, clock.now(), { venueId: 'x2' }),
    );

    await runJob({ ...h.deps, pollOnly: true });

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 3, fundsAt: 'HYPERLIQUID', haltReason: HALT_TEXT.restart });
    expect(job.steps[2]).toMatchObject({ status: 'done', qty: 11.94 });
    expect(h.sequence).toEqual(['listCrossexTransfers', 'listCrossexTransfers']);
  });

  it('a convert step with a tag and no quoteId never reached Gate: it quotes and sends with no lookup', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'convert', steps: [convert(12)] },
      {
        getCrossexAccount: seq(account()),
        createCrossexConvertQuote: seq(quote('q1', '11.976')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
      },
      (job) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 0), status: 'running', startedAt: clock.now() });
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: 'c1', qty: 11.976, status: 'done' });
    expect(h.count('getCrossexOrder')).toBe(0);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
  });
});

describe('runJob Lighter and moves between venue wallets', () => {
  const intoLighter = (n: number, move: number, buy = 0): PlannedStep =>
    between('CROSSEX', 'LIGHTER', { ...round(n, move, buy), arrives: Math.round((move - 1.03) * 100) / 100, seconds: 235 });

  it('a round into Lighter sends To Lighter from Gate spot and takes off the 1.03 fee when Gate lists no actualReceive', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [intoLighter(1, 12)] }, {
      getCrossexAccount: seq(account({ gate: 12 })),
      createCrossexTransfer: seq(tx('x1'), tx('x2')),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { amount: '12', actualReceive: '12' })),
        rows(row('x2', 'SUCCESS', { amount: '12' })),
      ),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, qty }) => ({ name, qty }))).toEqual([
      { name: 'Buy USDC', qty: 0 },
      { name: 'To spot', qty: 12 },
      { name: 'To Lighter', qty: 10.97 },
    ]);
    expect(h.transfers()).toMatchObject([
      { coin: 'USDC', amount: '12', from: 'CROSSEX_GATE', to: 'SPOT' },
      { coin: 'USDC', amount: '12', from: 'SPOT', to: 'CROSSEX_LIGHTER' },
    ]);
    expect(h.count('createCrossexOrder')).toBe(0);
  });

  it('a round out of Lighter sends the Lighter wallet cash to Gate spot with no fee, then sells it on Gate', async () => {
    const steps = [between('LIGHTER', 'CROSSEX', { ...round(1, 20), arrives: 20, seconds: 185 })];
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ lighter: 60 }), account({ lighter: 40, gate: 20 })),
      createCrossexTransfer: seq(tx('x1'), tx('x2')),
      listCrossexTransfers: seq(rows(row('x1', 'SUCCESS', { amount: '20' })), rows(row('x2', 'SUCCESS', { amount: '20' }))),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('FILLED', '20', 'o1', { executedAmount: '19.99' })),
    });

    expect(h.job.fundsAt).toBe('LIGHTER');

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(job.steps.map(({ name, qty }) => ({ name, qty }))).toEqual([
      { name: 'From Lighter', qty: 20 },
      { name: 'To Gate', qty: 20 },
      { name: 'Sell USDC', qty: 19.99 },
    ]);
    expect(h.transfers()).toMatchObject([
      { coin: 'USDC', amount: '20', from: 'CROSSEX_LIGHTER', to: 'SPOT' },
      { coin: 'USDC', amount: '20', from: 'SPOT', to: 'CROSSEX_GATE' },
    ]);
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toMatchObject({ side: 'SELL' });
  });

  it('a move into Lighter waits 30 min before the timeout halt, as Hyperliquid does', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'loop', steps: [intoLighter(1, 12)] },
      { listCrossexTransfers: seq(rows(row('x2', 'PENDING'))) },
      (job) => {
        doneStep(job, 0, { venueId: 'o1', qty: 0, at: clock.now() });
        doneStep(job, 1, { venueId: 'x1', qty: 12, at: clock.now() });
        Object.assign(job.steps[2], { text: tagFor(job.id, 2), venueId: 'x2', status: 'running', startedAt: clock.now() });
        Object.assign(job, { stepIndex: 2, fundsAt: 'SPOT' });
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.timeout, fundsAt: 'SPOT' });
    expect(clock.now() - job.steps[2].startedAt!).toBe(HL_TRANSFER_TIMEOUT_MS + POLL_MS);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('a Convert into Lighter quotes on LIGHTER, and a lost order is found in the Lighter convert history and never sent twice', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('CROSSEX', 'LIGHTER', convert(12))] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976'), quote('q2', '11.97')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c2', text: 'q2' } }),
      getCrossexOrder: async (id: string) =>
        id === 'c1'
          ? order('FILLED', '12', 'c1', { executedAmount: '11.97' })
          : gateError(404, 'ORDER_NOT_FOUND', 'order not found')(),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({ body: [convertRow('c1', 'q1', 'LIGHTER_CONVERT_USDT_USDC', '11.97')] }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps[0]).toMatchObject({ name: 'Convert', quoteId: 'q1', venueId: 'c1', qty: 11.97 });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest).toEqual({
      exchangeType: 'LIGHTER',
      fromCoin: 'USDT',
      toCoin: 'USDC',
      fromAmount: '12',
    });
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(h.sent('listCrossexOpenOrders').map((arg) => arg.symbol)).toEqual(['LIGHTER_CONVERT_USDT_USDC']);
    expect(h.sent('listCrossexHistoryOrders').map((arg) => arg.symbol)).toEqual(['LIGHTER_CONVERT_USDT_USDC']);
  });

  it('a Convert out of Lighter sells USDC on LIGHTER, no more than the Lighter wallet cash', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('LIGHTER', 'CROSSEX', convert(50))] }, {
      getCrossexAccount: seq(account({ lighter: 30, hyperliquid: 500 })),
      createCrossexConvertQuote: seq(quote('q1', '29.95')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest).toEqual({
      exchangeType: 'LIGHTER',
      fromCoin: 'USDC',
      toCoin: 'USDT',
      fromAmount: '30',
    });
  });

  it('a move from Hyperliquid to Lighter sends From Hyperliquid, then To Lighter what reached Gate spot, with no spot order', async () => {
    const steps: PlannedStep[] = [
      { round: 1, kind: 'round', buy: 0, move: 401.01, arrives: 398.98, borrowLeft: 0, seconds: 625, from: 'HYPERLIQUID', to: 'LIGHTER' },
    ];
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ hyperliquid: 500 })),
      createCrossexTransfer: seq(tx('x1'), tx('x2')),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { amount: '401.01' })),
        rows(row('x2', 'SUCCESS', { amount: '400.01', actualReceive: '398.98' })),
      ),
    });

    expect(h.job.fundsAt).toBe('HYPERLIQUID');

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, planned, arrives, qty }) => ({ name, planned, arrives, qty }))).toEqual([
      { name: 'From Hyperliquid', planned: 401.01, arrives: null, qty: 400.01 },
      { name: 'To Lighter', planned: 400.01, arrives: 398.98, qty: 398.98 },
    ]);
    expect(h.transfers()).toMatchObject([
      { coin: 'USDC', amount: '401.01', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' },
      { coin: 'USDC', amount: '400.01', from: 'SPOT', to: 'CROSSEX_LIGHTER' },
    ]);
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('listTickers')).toBe(0);
  });

  it('a Hyperliquid to Lighter shrink sets To Lighter at what reaches Gate spot and what arrives after both fees', async () => {
    const steps: PlannedStep[] = [
      { round: 1, kind: 'round', buy: 0, move: 401.01, arrives: 398.98, borrowLeft: 0, seconds: 625, from: 'HYPERLIQUID', to: 'LIGHTER' },
    ];
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ marginBalance: 200, hyperliquid: 500 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const figures = h.jobs.read()!.steps.map(({ name, round: r, planned, arrives }) => ({ name, round: r, planned, arrives }));
    expect(figures).toEqual([
      { name: 'From Hyperliquid', round: 1, planned: 200, arrives: null },
      { name: 'To Lighter', round: 1, planned: 199, arrives: 197.97 },
      { name: 'From Hyperliquid', round: 2, planned: 201.01, arrives: null },
      { name: 'To Lighter', round: 2, planned: 200.01, arrives: 198.98 },
    ]);
    expect(h.transfers()[0]).toMatchObject({ amount: '200', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' });
  });

  it('a mix move from Hyperliquid to Lighter under the 12 USDC minimum drops its round into both Convert halves', async () => {
    const across = (step: Planned) => between('HYPERLIQUID', 'LIGHTER', step);
    const h = harness(fakeClock(), { route: 'mix', steps: [across(round(1, 30)), across(convert(50))] }, {
      getCrossexAccount: seq(account({ marginBalance: 11.5, hyperliquid: 100 })),
      createCrossexConvertQuote: seq(quote('q1', '79.84'), quote('q2', '79.68')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, round: r, planned, qty }) => ({ name, round: r, planned, qty }))).toEqual([
      { name: 'Convert to USDT', round: null, planned: 80, qty: 79.84 },
      { name: 'Convert to USDC', round: null, planned: 79.84, qty: 79.68 },
    ]);
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest)).toEqual([
      { exchangeType: 'HYPERLIQUID', fromCoin: 'USDC', toCoin: 'USDT', fromAmount: '80' },
      { exchangeType: 'LIGHTER', fromCoin: 'USDT', toCoin: 'USDC', fromAmount: '79.84' },
    ]);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('the Convert to USDC half sends no more than the USDT cash', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(40))] }, {
      getCrossexAccount: seq(account({ hyperliquid: 100 }), account({ usdt: 25, hyperliquid: 60 })),
      createCrossexConvertQuote: seq(quote('q1', '39.92'), quote('q2', '24.95')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['40', '25']);
  });

  it('a Convert from Hyperliquid to Lighter sends nothing while USDT cash is below 0', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(40))] }, {
      getCrossexAccount: seq(account({ usdt: -300, hyperliquid: 100 })),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.usdtBelowZero });
    expect(h.count('createCrossexConvertQuote')).toBe(0);
  });

  it('the Convert to USDC half never quotes 0 when USDT cash fell below 0', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(40))] }, {
      getCrossexAccount: seq(account({ usdt: 0, hyperliquid: 100 }), account({ usdt: -5, hyperliquid: 60 })),
      createCrossexConvertQuote: seq(quote('q1', '39.92')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.usdtBelowZero });
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['40']);
  });

  it('a mix job that drops the rounds of its second move still runs the Convert it adds', async () => {
    const steps = [between('CROSSEX', 'HYPERLIQUID', convert(50)), intoLighter(1, 30)];
    const h = harness(fakeClock(), { route: 'mix', steps }, {
      getCrossexAccount: seq(account(), account({ marginBalance: 8 }), account()),
      createCrossexConvertQuote: seq(quote('q1', '49.9'), quote('q2', '29.94')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, to, status }) => [name, to, status])).toEqual([
      ['Convert', 'HYPERLIQUID', 'done'],
      ['Convert', 'LIGHTER', 'done'],
    ]);
    expect(h.sent('createCrossexConvertQuote').map(({ crossexConvertQuoteRequest: q }) => [q.exchangeType, q.fromAmount])).toEqual([
      ['HYPERLIQUID', '50'],
      ['LIGHTER', '30'],
    ]);
  });

  it('a mix job with two moves drops only the rounds of the move that is short, and the next move runs as round 1', async () => {
    const toHyperliquid = (step: Planned) => between('CROSSEX', 'HYPERLIQUID', step);
    const toLighter = (step: Planned) => between('CROSSEX', 'LIGHTER', step);
    const steps = [toHyperliquid(round(1, 30)), toHyperliquid(convert(50)), intoLighter(2, 30), toLighter(convert(20))];
    const h = harness(fakeClock(), { route: 'mix', steps }, {
      getCrossexAccount: seq(account({ marginBalance: 8 }), account(), account({ gate: 30 }), account({ gate: 30 }), account()),
      createCrossexConvertQuote: seq(quote('q1', '79.84'), quote('q2', '19.96')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
      createCrossexTransfer: seq(tx('x1'), tx('x2')),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { amount: '30', actualReceive: '30' })),
        rows(row('x2', 'SUCCESS', { amount: '30' })),
      ),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, round: r, to, planned, qty }) => ({ name, round: r, to, planned, qty }))).toEqual([
      { name: 'Convert', round: null, to: 'HYPERLIQUID', planned: 80, qty: 79.84 },
      { name: 'Buy USDC', round: 1, to: 'LIGHTER', planned: 0, qty: 0 },
      { name: 'To spot', round: 1, to: 'LIGHTER', planned: 30, qty: 30 },
      { name: 'To Lighter', round: 1, to: 'LIGHTER', planned: 30, qty: 28.97 },
      { name: 'Convert', round: null, to: 'LIGHTER', planned: 20, qty: 19.96 },
    ]);
    expect(h.sent('createCrossexConvertQuote').map(({ crossexConvertQuoteRequest: q }) => [q.exchangeType, q.fromAmount])).toEqual([
      ['HYPERLIQUID', '80'],
      ['LIGHTER', '20'],
    ]);
    expect(h.transfers().map(({ from, to }) => [from, to])).toEqual([
      ['CROSSEX_GATE', 'SPOT'],
      ['SPOT', 'CROSSEX_LIGHTER'],
    ]);
  });

  it('a loop job with two moves adds the extra round after the short move and moves the later round up by one', async () => {
    const steps = [between('CROSSEX', 'HYPERLIQUID', round(1, 30)), intoLighter(2, 30)];
    const h = harness(fakeClock(), { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ marginBalance: 19, gate: 200 })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const figures = h.jobs.read()!.steps.map(({ name, round: r, to, planned, arrives }) => ({ name, round: r, to, planned, arrives }));
    expect(figures).toEqual([
      { name: 'Buy USDC', round: 1, to: 'HYPERLIQUID', planned: 0, arrives: null },
      { name: 'To spot', round: 1, to: 'HYPERLIQUID', planned: 19, arrives: null },
      { name: 'To Hyperliquid', round: 1, to: 'HYPERLIQUID', planned: 19, arrives: 18.95 },
      { name: 'Buy USDC', round: 2, to: 'HYPERLIQUID', planned: 11, arrives: null },
      { name: 'To spot', round: 2, to: 'HYPERLIQUID', planned: 11, arrives: null },
      { name: 'To Hyperliquid', round: 2, to: 'HYPERLIQUID', planned: 11, arrives: 10.95 },
      { name: 'Buy USDC', round: 3, to: 'LIGHTER', planned: 0, arrives: null },
      { name: 'To spot', round: 3, to: 'LIGHTER', planned: 30, arrives: null },
      { name: 'To Lighter', round: 3, to: 'LIGHTER', planned: 30, arrives: 28.97 },
    ]);
    expect(h.transfers()[0]).toMatchObject({ amount: '19', from: 'CROSSEX_GATE', to: 'SPOT' });
  });
});

describe('JobFile', () => {
  const dir = () => fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  const loopJob = () =>
    newJob(
      { route: 'loop', steps: [{ ...round(1, 12, 12), ...MOVE.toUsdc }], amount: 12, costUsd: 0, target: [], userId: null },
      1_000_000,
    );

  it('reads null when no file exists', () => {
    expect(new JobFile(dir()).read()).toBeNull();
  });

  it('reads null and says so once when the file is not a job', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const d = dir();
      const { steps: _steps, ...noSteps } = loopJob();
      fs.writeFileSync(path.join(d, 'rebalance.json'), JSON.stringify(noSteps));
      const jobs = new JobFile(d);
      expect(jobs.read()).toBeNull();
      expect(jobs.read()).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('treating as no job');

      fs.writeFileSync(path.join(d, 'rebalance.json'), '{not json');
      expect(new JobFile(d).read()).toBeNull();

      const bogus = loopJob();
      bogus.steps[1].name = 'Bogus';
      fs.writeFileSync(path.join(d, 'rebalance.json'), JSON.stringify(bogus));
      expect(new JobFile(d).read()).toBeNull();

      const wrongIndex = { ...loopJob(), stepIndex: 3 };
      fs.writeFileSync(path.join(d, 'rebalance.json'), JSON.stringify(wrongIndex));
      expect(new JobFile(d).read()).toBeNull();
      expect(error).toHaveBeenCalledTimes(4);
    } finally {
      error.mockRestore();
    }
  });
});
