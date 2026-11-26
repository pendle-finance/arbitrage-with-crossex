import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { floorToStep } from '../../src/core/numbers';
import { marginPerConvertUsdc, realizeEstimateOf, type RealizeLeg, type RealizePlan } from '../../src/core/rebalance/realize';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { pickMakerLeg } from '../../src/core/estimate/makerLeg';
import type { DealRequest } from '../../src/engine/create';
import { Store } from '../../src/engine/db';
import { project } from '../../src/engine/decide';
import type { PairMode, PairRow } from '../../src/engine/types';
import { sleepHaltTwap, type TwapRunDeps } from '../../src/server/twapRun';
import { closeBorosLegs, MAY_HAVE_FILLED, type BorosCloseDeps, type BorosCloseInput } from '../../src/server/borosClose';
import { CoreError } from '../../src/core/errors';
import {
  bookLevels,
  buyableUsdc,
  buyCostUsdt,
  ceilCents,
  CONVERT_MAX,
  floorCents,
  nearestCents,
  PAIR_CONVERT_MAX,
  spotOrderMax,
  type PlannedStep,
} from '../../src/core/rebalance/plan';
import { TtlCache } from '../../src/server/cache';
import {
  convertSteps,
  HALT_TEXT,
  JobFile,
  newJob,
  REOPEN_HALT,
  TO_USDC_STEPS,
  ADD_BACK_FIRST,
  addBackPartText,
  borosPartText,
  borosWaitText,
  FIX_UNCONFIRMED,
  RETRY_CONVERT_CAP,
  type DeleverJobInput,
  type Job,
  type RouteName,
} from '../../src/server/rebalanceJob';
import {
  BALANCE_LAG_MS,
  CONVERT_GAP_MS,
  HL_TRANSFER_TIMEOUT_MS,
  LOOKUP_RETRY_MS,
  LOOKUP_WINDOW_MS,
  POLL_MS,
  QUOTE_FLOOR,
  QUOTE_RECHECK_MS,
  quoteFloor,
  applyFix,
  endHaltedChildren,
  BOROS_LATE_SEND_MS,
  cancelRestingLead,
  runJob,
  STEP_TIMEOUT_MS,
  tagFor,
} from '../../src/server/rebalanceRunner';
import { clientsWith } from '../helpers/fake-clients';

type Handler = (arg: never) => Promise<unknown>;

const borosSpy = vi.hoisted(() => ({ calls: [] as { input: unknown; gateCalls: number }[], gateCalls: (): number => 0 }));
vi.mock('../../src/server/borosClose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/borosClose')>()),
  closeBorosLegs: vi.fn(async (_deps: unknown, input: { legs: { marketId: number; size: number }[] }) => {
    borosSpy.calls.push({ input, gateCalls: borosSpy.gateCalls() });
    return { filled: input.legs, rest: input.legs.map((leg) => ({ marketId: leg.marketId, size: 0 })), held: [] };
  }),
}));
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

const INVALID_FROM = gateError(400, 'CONVERT_TRADE_QUOTE_FROM_AMOUNT_INVALID_ERROR', 'Invalid fromAmount');

function quotesAt(toAmount: (from: number) => number): Handler {
  let count = 0;
  return async (arg: RequestOf<'createCrossexConvertQuote'>) => {
    const { fromAmount } = arg.crossexConvertQuoteRequest;
    if (Number(fromAmount) > CONVERT_MAX) return INVALID_FROM();
    count += 1;
    return {
      body: { quoteId: `q${count}`, validMs: '5000', fromAmount, toAmount: String(toAmount(Number(fromAmount))), price: '0.998' },
    };
  };
}

function ordersInTurn(): Handler {
  let count = 0;
  return async (arg: RequestOf<'createCrossexConvertOrder'>) => {
    count += 1;
    return { body: { orderId: `c${count}`, text: arg.crossexConvertOrderRequest.quoteId } };
  };
}

const chunkCount = (amount: number, cap = CONVERT_MAX): number => Math.max(1, Math.ceil(floorCents(amount) / cap));
const firstChunk = (amount: number): number => floorCents(convertSteps('CROSSEX', 'HYPERLIQUID', amount)[0].planned ?? 0);

const account = (
  over: {
    marginBalance?: number;
    initialMargin?: number;
    usdt?: number;
    gate?: number;
    hyperliquid?: number;
    hyperliquidEquity?: number;
    lighter?: number;
    availableMargin?: number;
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
      availableMargin: String(over.availableMargin ?? 0),
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
  realize?: RealizePlan;
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
    if (name !== 'listTickers' && name !== 'listOrderBook') crossEx[name] = recorded(name, fn);
  }
  const spot = {
    listTickers: recorded('listTickers', handlers.listTickers ?? seq({ body: [{ highestBid: '0.9999', lowestAsk: '1.0001' }] })),
    ...(handlers.listOrderBook ? { listOrderBook: recorded('listOrderBook', handlers.listOrderBook) } : {}),
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
      realize: plan.realize ?? null,
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
    expect(job.haltReason).toBe('Not enough free margin for the next round.');
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
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('listTickers')).toBe(1);
    expect(h.sequence.indexOf('listTickers')).toBe(h.sequence.indexOf('createCrossexConvertQuote') - 1);
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
        getCrossexAccount: seq(account({ gate: 24.87 }), account({ gate: 0 })),
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
    const below = String(quoteFloor(12, 'USDC', { ask: 1.0001, bid: 0.9999 }) - 0.01);
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', below)),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Convert quote was more than 0.3% under the Gate spot price.');
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

  it('a lost Convert order Gate does not list for 2 min halts with the not-listed text, and a resume that misses again re-quotes and sends once more', async () => {
    const clock = fakeClock();
    const h = harness(clock, { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(quote('q1', '11.976'), quote('q2', '11.97')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c2', text: 'q2' } }),
      getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({ body: [convertRow('c0', 'q0', 'HYPERLIQUID_CONVERT_USDT_USDC', '5')] }),
    });

    await h.run();

    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed });
    expect(halted.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null, status: 'running' });
    expect(halted.steps[0]).not.toHaveProperty('sentAt');
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(h.calls.getCrossexOrder).toEqual(Array(LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1).fill('q1'));
    expect(h.onHalt).toHaveBeenCalledTimes(1);

    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, status: 'done' });
    expect(h.count('createCrossexConvertQuote')).toBe(2);
    expect(h.count('createCrossexConvertOrder')).toBe(2);
    expect(h.calls.getCrossexOrder).toEqual(Array(2 * (LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1)).fill('q1'));
    const history = { symbol: 'HYPERLIQUID_CONVERT_USDT_USDC', from: job.createdAt - 600_000, limit: 100, page: 1 };
    expect(h.calls.listCrossexHistoryOrders).toEqual([history, history]);
    expect(job.steps[0].doneAt! - job.steps[0].startedAt!).toBe(LOOKUP_WINDOW_MS);
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

  it('a refused Convert order clears its quote id and quoted amount, so a resume quotes again', async () => {
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
    expect(halted.steps[0]).toMatchObject({ quoteId: null, qty: null });

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

  it('a rate-limited Convert quote halts with the daily quote text and sends no order, and a resume quotes again', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(12)] }, {
      getCrossexAccount: seq(account()),
      createCrossexConvertQuote: seq(gateError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests'), quote('q2', '11.97')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c2', text: 'q2' } }),
    });

    await h.run();

    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.quotesUsed });
    expect(halted.haltReason).toBe(
      "Gate allows 100 Convert quotes a day, and this account has used them. Nothing was sent. Press Resume later. Gate's count clears within 24 hours.",
    );
    expect(halted.steps[0]).toMatchObject({ quoteId: null, venueId: null, qty: null });
    expect(halted.steps[0]).not.toHaveProperty('sentAt');
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);

    halted.status = 'running';
    halted.haltReason = null;
    h.jobs.write(halted);
    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, status: 'done' });
    expect(h.count('getCrossexOrder')).toBe(0);
    expect(h.count('createCrossexConvertQuote')).toBe(2);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
  });
});

describe('runJob paces Convert quotes', () => {
  const pacedConvert = (plan: PlanInput, account_: unknown) => {
    const clock = fakeClock();
    const quotedAt: number[] = [];
    const quotes = quotesAt((from) => floorCents(from * 0.998));
    let orders = 0;
    const h = harness(clock, plan, {
      getCrossexAccount: seq(account_),
      createCrossexConvertQuote: async (arg: RequestOf<'createCrossexConvertQuote'>) => {
        quotedAt.push(clock.now());
        return quotes(arg as never);
      },
      createCrossexConvertOrder: async () => {
        orders += 1;
        return { body: { orderId: `c${orders}`, text: `q${orders}` } };
      },
    });
    return { ...h, start: clock.now(), quotedAt };
  };

  const expectPaced = (quotedAt: number[]): void => {
    quotedAt.slice(1).forEach((at, index) => expect(at - quotedAt[index]).toBeGreaterThanOrEqual(CONVERT_GAP_MS));
    for (const at of quotedAt) expect(quotedAt.filter((other) => other >= at && other < at + 10_000).length).toBeLessThanOrEqual(5);
  };

  it.each(RUNGS)('a Convert of %d USDT asks for its first quote at once and each later part at least 2 s after the one before', async (amount) => {
    const h = pacedConvert({ route: 'convert', steps: [convert(amount)] }, account({ ...WHALE, usdt: 2 * amount }));

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(h.quotedAt).toHaveLength(chunkCount(amount));
    expect(h.quotedAt[0] - h.start).toBeLessThan(CONVERT_GAP_MS);
    expectPaced(h.quotedAt);
    expect(h.count('createCrossexConvertOrder')).toBe(chunkCount(amount));
  });

  it.each(RUNGS)('a Convert of %d USDC from Hyperliquid to Lighter paces each half, and each half still sends what the one before returned', async (amount) => {
    const h = pacedConvert(
      { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(amount))] },
      account({ ...WHALE, hyperliquid: 2 * amount }),
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(h.quotedAt).toHaveLength(job.steps.length);
    expect(h.quotedAt[0] - h.start).toBeLessThan(CONVERT_GAP_MS);
    expectPaced(h.quotedAt);
    job.steps.forEach((step, index) => {
      if (step.name !== 'Convert to USDC') return;
      expect(Number(h.sent('createCrossexConvertQuote')[index].crossexConvertQuoteRequest.fromAmount)).toBeLessThanOrEqual(job.steps[index - 1].qty!);
    });
  });
});

describe('runJob transfers', () => {
  it('no actualReceive takes off the fee', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { direction: 'toUsdt', route: 'loop', steps: [round(1, 11)] },
      {
        getCrossexAccount: seq(account()),
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
    expect(job.haltReason).toBe('Gate shows this transfer as done, but nothing arrived. Check your Gate wallets.');
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
    expect(job.steps[1]).not.toHaveProperty('sentAt');
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
    expect(job.haltReason).toBe('Gate refused the move: free margin or wallet cash is too low.');
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
    expect(job.haltReason).toBe('Gate closed the order with nothing filled. Nothing moved. Press Resume to try again.');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.stepIndex).toBe(0);
    expect(job.steps[0].venueId).toBeNull();
    expect(job.steps[0].text).toBeNull();
    expect(job.steps[0].status).toBe('running');
    expect(job.steps[0]).not.toHaveProperty('cashBefore');
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

  it('a rate-limited Buy USDC order halts with the rate-limit text, and a resume looks the tag up, then buys once', async () => {
    const clock = fakeClock();
    const h = harness(clock, oneRound, {
      ...happyLoop(),
      getCrossexAccount: seq(account({ gate: 0 }), account({ gate: 0 }), account({ gate: 11.99 })),
      createCrossexOrder: seq(gateError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests'), created('o1')),
      getCrossexOrder: seq(
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        gateError(404, 'ORDER_NOT_FOUND', 'order not found'),
        order('OPEN', '0'),
        order('FILLED', '11.99'),
      ),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({ body: [] }),
    });

    await h.run();

    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.rateLimited, stepIndex: 0 });
    expect(halted.steps[0]).toMatchObject({ text: tagFor(halted.id, 1), venueId: null });
    expect(halted.steps[0]).not.toHaveProperty('sentAt');
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(h.count('getCrossexOrder')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);

    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(job.steps[0]).toMatchObject({ venueId: 'o1', qty: 11.99, status: 'done' });
    expect(h.count('createCrossexOrder')).toBe(2);
    expect(h.sent('createCrossexOrder').map((arg) => arg.crossexOrderRequest.text)).toEqual([tagFor(job.id, 1), tagFor(job.id, 1)]);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
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

  it('a Buy step sent but not found for 2 min looks up every 10 s and halts, and a resume that misses again sends once', async () => {
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
        job.steps[0].sentAt = clock.now();
      },
    );
    const t0 = clock.now();
    const window = Array.from({ length: LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1 }, (_, i) => i * LOOKUP_RETRY_MS);

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed, stepIndex: 0 });
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('getCrossexAccount')).toBe(0);
    expect(lookups).toEqual(window.map((at) => t0 + at));
    const t1 = clock.now();

    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0].venueId).toBe('o1');
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(lookups).toEqual([...window.map((at) => t0 + at), ...window.map((at) => t1 + at)]);
    expect(sentAt).toBe(t1 + LOOKUP_WINDOW_MS);
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

  it('a Sell USDC step sent but not listed halts, and a resume that misses again sells only the cash left in USDC · Gate', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { direction: 'toUsdt', route: 'loop', steps: [round(1, 20)] },
      {
        getCrossexAccount: seq(account({ gate: 32.349 }), account({ gate: 0.009 })),
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
        job.steps[1].cashBefore = 20;
        Object.assign(job.steps[2], { text: tagFor(job.id, 2), status: 'running', startedAt: clock.now(), sentAt: clock.now() });
        job.tagCount = 2;
        job.stepIndex = 2;
        job.fundsAt = 'GATE';
      },
    );

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed, stepIndex: 2 });
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('getCrossexAccount')).toBe(0);

    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.sent('createCrossexOrder')).toHaveLength(1);
    expect(h.sent('createCrossexOrder')[0].crossexOrderRequest).toMatchObject({ side: 'SELL', qty: '32.34', text: tagFor(job.id, 2) });
    expect(h.count('listCrossexHistoryOrders')).toBe(2);
    const read = h.sequence.indexOf('getCrossexAccount');
    expect(read).toBeGreaterThan(h.sequence.lastIndexOf('listCrossexHistoryOrders'));
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

  it('a convert step sent with a quoteId Gate does not know halts, and a resume that misses again re-quotes and sends once', async () => {
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
        Object.assign(job.steps[0], {
          text: tagFor(job.id, 0),
          quoteId: 'q1',
          qty: 11.976,
          status: 'running',
          startedAt: clock.now(),
          sentAt: clock.now(),
        });
      },
    );

    await h.run();

    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed });
    expect(h.jobs.read()!.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null });
    expect(h.count('getCrossexAccount')).toBe(0);
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.count('createCrossexConvertOrder')).toBe(0);

    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, status: 'done' });
    expect(h.calls.getCrossexOrder).toEqual(Array(2 * (LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1)).fill('q1'));
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
      getCrossexAccount: seq(
        account({ lighter: 60 }),
        account({ lighter: 40, gate: 0 }),
        account({ lighter: 40, gate: 20 }),
        account({ lighter: 40, gate: 0 }),
      ),
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

  it('a Convert out of Lighter sizes from the digits of a 21-decimal Gate balance, never a cent above it', async () => {
    const read = account({ hyperliquid: 500 });
    read.body.assets[3].balance = '74.989999999999999999999';
    const h = harness(fakeClock(), { route: 'convert', steps: [between('LIGHTER', 'CROSSEX', convert(80))] }, {
      getCrossexAccount: seq(read),
      createCrossexConvertQuote: seq(quote('q1', '74.83')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe('74.98');
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

  it('a Convert under 1.01 between Hyperliquid and Lighter still sends its second half when USDT cash is above 0', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(0.9))] }, {
      getCrossexAccount: seq(account({ usdt: 100, hyperliquid: 100 }), account({ usdt: 100.89, hyperliquid: 99.1 })),
      createCrossexConvertQuote: seq(quote('q1', '0.8982'), quote('q2', '0.8882')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['0.9', '0.89']);
  });

  it('the Convert to USDC half sends what USDT cash holds when that cash is under 1 but above 0', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(1.2))] }, {
      getCrossexAccount: seq(account({ usdt: -0.5, hyperliquid: 100 }), account({ usdt: 0.69, hyperliquid: 98.8 })),
      createCrossexConvertQuote: seq(quote('q1', '1.1976'), quote('q2', '0.6886')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['1.2', '0.69']);
  });

  it('the Convert to USDC half of a 0.01 Convert finishes with 0 and never quotes 0', async () => {
    const h = harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(0.01))] }, {
      getCrossexAccount: seq(account({ usdt: 100, hyperliquid: 50 }), account({ usdt: 100, hyperliquid: 49.99 })),
      createCrossexConvertQuote: seq(quote('q1', '0.00998')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, qty }) => [name, qty])).toEqual([
      ['Convert to USDT', 0.00998],
      ['Convert to USDC', 0],
    ]);
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['0.01']);
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

const WHALE = { marginBalance: 100_000_000, initialMargin: 0 };
const LADDER = [50, 5_000, 100_000, 1_000_000, 6_000_000];
const HAIRS = [999_999.9991, 5_999_999.996];
const tickerAt = (bid: string, ask: string): Handler => seq({ body: [{ highestBid: bid, lowestAsk: ask }] });

function spotBook(start: number, fills: number[] = [], lost: number[] = []) {
  let cash = start;
  let sent = 0;
  const orders = new Map<string, { orderId: string; fill: number }>();
  const before: number[] = [];
  const handlers: Record<string, Handler> = {
    getCrossexAccount: async () => account({ ...WHALE, gate: cash }),
    createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
      const { qty, text } = arg.crossexOrderRequest;
      sent += 1;
      before.push(cash);
      const fill = floorCents(Number(qty) * (fills[sent - 1] ?? 1));
      const record = { orderId: `o${sent}`, fill };
      orders.set(record.orderId, record);
      orders.set(String(text), record);
      cash -= fill;
      if (lost.includes(sent)) networkError();
      return created(record.orderId);
    },
    getCrossexOrder: async (id: string) => {
      const record = orders.get(id);
      if (!record) return gateError(404, 'ORDER_NOT_FOUND', 'order not found')();
      const state = record.fill > 0 ? 'FILLED' : 'CANCELLED';
      return order(state, String(record.fill), record.orderId, { executedAmount: String(record.fill) });
    },
    listCrossexOpenOrders: seq({ body: [] }),
    listCrossexHistoryOrders: seq({ body: [] }),
  };
  return { handlers, cash: () => cash, before };
}

const WALLET_OF = { CROSSEX: 'usdt', HYPERLIQUID: 'hyperliquid', LIGHTER: 'lighter' } as const;

function convertBook(
  start: { usdt?: number; hyperliquid?: number; lighter?: number },
  lost: number[] = [],
  rates: { USDC?: number; USDT?: number } = {},
) {
  const cash = { usdt: 0, hyperliquid: 0, lighter: 0, ...start };
  const quotes = new Map<string, { exchangeType: string; fromCoin: string; from: number; to: number }>();
  const filled = new Map<string, { orderId: string; to: number }>();
  let orders = 0;
  const addQuote = (exchangeType: string, fromCoin: string, from: number) => {
    const quoteId = `q${quotes.size + 1}`;
    const to = Number((from * (fromCoin === 'USDC' ? (rates.USDC ?? 0.998) : (rates.USDT ?? 0.998))).toFixed(6));
    quotes.set(quoteId, { exchangeType, fromCoin, from, to });
    return { quoteId, to };
  };
  const fill = (quoteId: string): string => {
    const { exchangeType, fromCoin, from, to } = quotes.get(quoteId)!;
    const venue = exchangeType === 'LIGHTER' ? 'lighter' : 'hyperliquid';
    const gateDecimal = (value: number): number => Number(value.toFixed(8));
    if (fromCoin === 'USDT') {
      cash.usdt = gateDecimal(cash.usdt - from);
      cash[venue] = gateDecimal(cash[venue] + to);
    } else {
      cash[venue] = gateDecimal(cash[venue] - from);
      cash.usdt = gateDecimal(cash.usdt + to);
    }
    orders += 1;
    const record = { orderId: `c${orders}`, to };
    filled.set(record.orderId, record);
    filled.set(quoteId, record);
    return record.orderId;
  };
  const handlers: Record<string, Handler> = {
    getCrossexAccount: async () => account({ ...WHALE, ...cash }),
    createCrossexConvertQuote: async (arg: RequestOf<'createCrossexConvertQuote'>) => {
      const { exchangeType, fromCoin, fromAmount } = arg.crossexConvertQuoteRequest;
      if (Number(fromAmount) > CONVERT_MAX) return INVALID_FROM();
      const { quoteId, to } = addQuote(String(exchangeType), fromCoin, Number(fromAmount));
      return { body: { quoteId, validMs: '5000', fromAmount, toAmount: String(to), price: '0.998' } };
    },
    createCrossexConvertOrder: async (arg: RequestOf<'createCrossexConvertOrder'>) => {
      const { quoteId } = arg.crossexConvertOrderRequest;
      const orderId = fill(quoteId);
      if (lost.includes(orders)) networkError();
      return { body: { orderId, text: quoteId } };
    },
    getCrossexOrder: async (id: string) => {
      const record = filled.get(id);
      if (!record) return gateError(404, 'ORDER_NOT_FOUND', 'order not found')();
      return order('FILLED', '0', record.orderId, { executedAmount: String(record.to) });
    },
    listCrossexOpenOrders: seq({ body: [] }),
    listCrossexHistoryOrders: seq({ body: [] }),
  };
  const sentBefore = (fromCoin: string, from: number): string => {
    const { quoteId } = addQuote('HYPERLIQUID', fromCoin, from);
    fill(quoteId);
    return quoteId;
  };
  return { handlers, cash: () => ({ ...cash }), sentBefore };
}

function atRoundSell(clock: ReturnType<typeof fakeClock>, arrived: number) {
  return (job: Job): void => {
    doneStep(job, 0, { venueId: 'x1', qty: arrived + 1, at: clock.now() });
    doneStep(job, 1, { venueId: 'x2', qty: arrived, at: clock.now() });
    job.stepIndex = 2;
    job.fundsAt = 'GATE';
  };
}

async function resumeRun(h: ReturnType<typeof harness>, clock: ReturnType<typeof fakeClock>): Promise<void> {
  const job = h.jobs.read()!;
  job.status = 'running';
  job.haltReason = null;
  job.steps[job.stepIndex].startedAt = clock.now();
  h.jobs.write(job);
  await h.run();
}

function sellJob(amount: number, book: ReturnType<typeof spotBook>, extra: Record<string, Handler> = {}) {
  const clock = fakeClock();
  const h = harness(
    clock,
    { direction: 'toUsdt', route: 'loop', steps: [round(1, amount + 1)] },
    { listTickers: tickerAt('1.0006', '1.0007'), ...book.handlers, ...extra },
    atRoundSell(clock, amount),
  );
  const resume = () => resumeRun(h, clock);
  const qtys = () => h.sent('createCrossexOrder').map((arg) => Number(arg.crossexOrderRequest.qty));
  return { ...h, resume, qtys };
}

describe('runJob Sell USDC at size', () => {
  it.each([
    [50, 1],
    [5_000, 1],
    [100_000, 1],
    [1_000_000, 1],
    [4_896_572.39, 1],
    [4_896_572.4, 1],
    [4_896_575.39, 2],
    [6_000_000, 2],
  ])('a Sell of %d USDC sends %d orders, the first exactly the amount or the 4,896,572.39 cap at ask 1.0007, and leaves Gate under $1', async (amount, count) => {
    const book = spotBook(amount);
    const h = sellJob(amount, book);

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(h.qtys()).toHaveLength(count);
    expect(h.qtys()[0]).toBe(Math.min(amount, 4_896_572.39));
    for (const qty of h.qtys()) expect(qty).toBeLessThanOrEqual(4_896_572.39);
    expect(book.cash()).toBeLessThan(1);
    expect(job.steps.slice(2).map((step) => ({ name: step.name, round: step.round }))).toEqual(
      Array.from({ length: count }, () => ({ name: 'Sell USDC', round: 1 })),
    );
    expect(new Set(h.sent('createCrossexOrder').map((arg) => arg.crossexOrderRequest.text)).size).toBe(count);
  });

  it('a Sell of 6,000,000 USDC at ask 1.03 caps each order at 4,757,281.55', async () => {
    const book = spotBook(6_000_000);
    const h = sellJob(6_000_000, book, { listTickers: tickerAt('1.0006', '1.03') });

    await h.run();

    expect(h.jobs.read()!.status).toBe('done');
    expect(h.qtys()).toEqual([4_757_281.55, 1_242_718.45]);
    expect(book.cash()).toBeLessThan(1);
  });

  it('a Sell of 6,000,000 USDC under a CrossEx rule of 3,000,000 sends three orders of at most 2,940,000', async () => {
    const book = spotBook(6_000_000);
    const h = sellJob(6_000_000, book, {
      listCrossexRuleSymbols: seq({ body: [{ symbol: 'GATE_SPOT_USDC_USDT', maxMarketSize: '3000000' }] }),
    });

    await h.run();

    expect(h.jobs.read()!.status).toBe('done');
    expect(h.qtys()).toEqual([2_940_000, 2_940_000, 120_000]);
  });

  it.each(HAIRS)('a Sell of Gate cash %d never asks for more than the cash', async (cash) => {
    const book = spotBook(cash);
    const h = sellJob(cash, book);

    await h.run();

    expect(h.jobs.read()!.status).toBe('done');
    h.qtys().forEach((qty, index) => expect(qty).toBeLessThanOrEqual(book.before[index]));
    expect(book.cash()).toBeGreaterThanOrEqual(0);
    expect(book.cash()).toBeLessThan(1);
  });

  it.each([1_000_000, 6_000_000])(
    'a Sell of %d USDC that fills 60% adds one Sell for the rest, halts when the book fills 0%, and a resume sells only what is left',
    async (amount) => {
      const book = spotBook(amount, [0.6, 0, 1]);
      const h = sellJob(amount, book);

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.sellStuck, stepIndex: 3 });
      expect(job.haltReason).toBe('Gate did not sell all the USDC in USDC · Gate. Press Resume to sell the rest.');
      expect(job.steps).toHaveLength(4);
      expect(job.steps[3]).toMatchObject({ name: 'Sell USDC', round: 1, venueId: null, text: null });
      expect(h.qtys()).toHaveLength(2);
      const left = amount - floorCents(h.qtys()[0] * 0.6);
      expect(h.qtys()[1]).toBe(floorCents(left));
      expect(h.onHalt).toHaveBeenCalledTimes(1);

      await h.resume();

      job = h.jobs.read()!;
      expect(job.status).toBe('done');
      expect(h.qtys()).toHaveLength(3);
      expect(h.qtys()[2]).toBe(floorCents(left));
      h.qtys().forEach((qty, index) => expect(qty).toBeLessThanOrEqual(book.before[index]));
      const tags = h.sent('createCrossexOrder').map((arg) => arg.crossexOrderRequest.text);
      expect(new Set(tags).size).toBe(3);
      expect(book.cash()).toBeLessThan(1);
    },
  );

  it.each([
    [1_000_000, 3],
    [6_000_000, 4],
  ])('a Sell of %d USDC that keeps filling 60% halts after %d orders, and a resume sends one more for the cash left', async (amount, limit) => {
    const book = spotBook(amount, Array.from({ length: limit + 1 }, () => 0.6));
    const h = sellJob(amount, book);

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.sellStuck, stepIndex: 2 + limit });
    expect(job.steps[2 + limit]).toMatchObject({ name: 'Sell USDC', status: 'pending', text: null, venueId: null });
    expect(job.steps.slice(2, 2 + limit).every((step) => step.status === 'done')).toBe(true);
    expect(h.qtys()).toHaveLength(limit);
    const left = book.cash();

    await h.resume();

    expect(h.qtys()).toHaveLength(limit + 1);
    expect(h.qtys()[limit]).toBe(Number(floorToStep(left, '0.01')));
    expect(h.jobs.read()!).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.sellStuck });
  });

  it.each([1_000_000, 6_000_000])(
    'a follow-up Sell of %d USDC whose response was lost is found by its tag and never sent twice',
    async (amount) => {
      const book = spotBook(amount, [0.6, 1], [2]);
      const h = sellJob(amount, book);

      await h.run();

      expect(h.qtys()).toHaveLength(2);
      expect(h.jobs.read()!.status).toBe('done');
      expect(book.cash()).toBeLessThan(1);
      const tag = h.sent('createCrossexOrder')[1].crossexOrderRequest.text;
      expect(h.sent('getCrossexOrder')).toContain(tag);
    },
  );

  it('a follow-up Sell with a tag and no venue id after a restart adopts the order Gate has and sends nothing', async () => {
    const book = spotBook(1_000_000, [0.6, 0.6, 0.6, 1]);
    const h = sellJob(1_000_000, book);
    await h.run();
    const job = h.jobs.read()!;
    job.tagCount += 1;
    const text = tagFor(job.id, job.tagCount);
    Object.assign(job.steps[job.stepIndex], { text, status: 'running' });
    h.jobs.write(job);
    await book.handlers.createCrossexOrder({ crossexOrderRequest: { qty: String(floorCents(book.cash())), text } } as never);

    await h.resume();

    expect(h.qtys()).toHaveLength(3);
    expect(h.sent('getCrossexOrder')).toContain(text);
    expect(h.jobs.read()!.status).toBe('done');
    expect(book.cash()).toBeLessThan(1);
  });

  it.each([1_000_000, 6_000_000])('a Convert of %d USDC sells the Gate cash in capped orders first', async (amount) => {
    const book = spotBook(amount);
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'convert', steps: [convert(50)] }, {
      listTickers: tickerAt('1.0006', '1.0007'),
      ...book.handlers,
      getCrossexAccount: async () => account({ ...WHALE, gate: book.cash(), hyperliquid: 60 }),
      createCrossexConvertQuote: seq(quote('q1', '49.92')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    const sells = amount > 4_896_572.39 ? 2 : 1;
    expect(job.steps.map((step) => step.name)).toEqual([...Array.from({ length: sells }, () => 'Sell USDC'), 'Convert']);
    expect(job.steps.every((step) => step.round === null)).toBe(true);
    expect(h.sent('createCrossexOrder').map((arg) => Number(arg.crossexOrderRequest.qty))[0]).toBe(Math.min(amount, 4_896_572.39));
    for (const arg of h.sent('createCrossexOrder')) expect(Number(arg.crossexOrderRequest.qty)).toBeLessThanOrEqual(4_896_572.39);
    expect(book.cash()).toBeLessThan(1);
  });
});

describe('runJob Buy USDC at size', () => {
  const buyJob = (over: Parameters<typeof account>[0], planned: number, extra: Record<string, Handler> = {}) =>
    harness(fakeClock(), { route: 'loop', steps: [round(1, planned, planned)] }, {
      getCrossexAccount: seq(account({ ...WHALE, ...over })),
      listTickers: tickerAt('1.0006', '1.0007'),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('REJECT', '0')),
      ...extra,
    });
  const quoteQty = (h: ReturnType<typeof harness>) => Number(h.sent('createCrossexOrder')[0].crossexOrderRequest.quoteQty);

  it.each([
    [50, 50],
    [5_000, 5_000],
    [100_000, 100_000],
    [1_000_000, 1_000_000],
    [6_000_000, 4_800_000],
  ])('a Buy with USDT cash %d and a round of %d spends no more than that cash', async (usdt, planned) => {
    const h = buyJob({ usdt, gate: 0 }, planned);

    await h.run();

    expect(quoteQty(h)).toBeLessThanOrEqual(usdt);
    expect(quoteQty(h)).toBeGreaterThanOrEqual(3);
  });

  it.each(HAIRS)('a Buy with USDT cash %d and a round of the same size spends at most the cash', async (usdt) => {
    const h = buyJob({ usdt, gate: 0 }, usdt);

    await h.run();

    expect(quoteQty(h)).toBeLessThanOrEqual(usdt);
  });

  it('a Buy at the 6,000,000 rung with 4,500,000 USDT and 1,500,000 in USDC · Gate spends at most 4,500,000', async () => {
    const h = buyJob({ usdt: 4_500_000, gate: 1_500_000 }, 6_000_000);

    await h.run();

    expect(quoteQty(h)).toBeLessThanOrEqual(4_500_000);
    expect(quoteQty(h)).toBeGreaterThan(4_499_990);
  });

  it('a Buy at the 1,000,000 rung with 1,000,000 USDT spends at most 1,000,000, not 1,000,700', async () => {
    const h = buyJob({ usdt: 1_000_000, gate: 0 }, 1_000_000);

    await h.run();

    expect(quoteQty(h)).toBeLessThanOrEqual(1_000_000);
    expect(quoteQty(h)).toBeGreaterThan(999_990);
  });

  it.each([
    ['1.0007', 4_896_572.39],
    ['1.03', 4_757_281.55],
  ])('a Buy of 6,000,000 at ask %s under the CrossEx rule of 5,000,000 buys exactly the %d USDC cap in one order', async (ask, cap) => {
    const h = buyJob({ usdt: 7_000_000, gate: 0 }, 6_000_000, {
      listTickers: tickerAt('1.0006', ask),
      listCrossexRuleSymbols: seq({ body: [{ symbol: 'GATE_SPOT_USDC_USDT', maxMarketSize: '5000000' }] }),
    });

    await h.run();

    expect(spotOrderMax(Number(ask), 5_000_000)).toBe(cap);
    expect(h.count('listCrossexRuleSymbols')).toBe(1);
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(quoteQty(h)).toBe(ceilCents(cap * Number(ask)));
    expect(quoteQty(h)).toBe(4_900_000);
    expect(h.jobs.read()!.steps[1]).toMatchObject({ name: 'To spot', round: 1, planned: cap });
  });

  it('a loop Buy with under 3 USDT sends no order and halts with the cash text', async () => {
    const h = buyJob({ usdt: 2.5, gate: 9 }, 11);

    await h.run();

    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.jobs.read()!).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.cashTooLow });
  });

  it('a mix Buy with under 3 USDT sends no order and moves the round to the Convert', async () => {
    const h = harness(fakeClock(), { route: 'mix', steps: [round(1, 11, 11), convert(50)] }, {
      getCrossexAccount: seq(account({ ...WHALE, usdt: 2.5, gate: 0.5 })),
      createCrossexConvertQuote: seq(quote('q1', '2.495')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    expect(h.count('createCrossexOrder')).toBe(0);
    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps.map(({ name, planned }) => ({ name, planned }))).toEqual([{ name: 'Convert', planned: 61 }]);
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe('2.5');
  });

  it.each([30, 1_000_000, 6_000_000])('a round of %d with 15 USDC to send halts under a Gate minimum of 20 and sends nothing', async (planned) => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, planned)] }, {
      getCrossexAccount: seq(account({ ...WHALE, usdt: 0, gate: 15 })),
      listCrossexTransferCoins: seq({ body: [{ coin: 'USDT', minTransAmount: '1' }, { coin: 'USDC', minTransAmount: '20' }] }),
      createCrossexOrder: seq(created('o1')),
      createCrossexTransfer: seq(tx('x1')),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.cashTooLow });
    expect(h.count('createCrossexOrder') + h.count('createCrossexTransfer')).toBe(0);
    expect(h.count('listCrossexTransferCoins')).toBe(1);
  });

  it('a round with 15 USDC to send moves it under the minimum of 11 when Gate cannot list its coin rules', async () => {
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, 30)] }, {
      getCrossexAccount: seq(account({ ...WHALE, usdt: 0, gate: 15 })),
      listCrossexTransferCoins: seq(gateError(500, 'SERVER_ERROR', 'server error')),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.transfers().map((request) => request.amount)).toEqual(['15']);
  });

  it.each([1_000_000, 6_000_000])('a Buy of %d USDC that fills 60% moves what landed in its round and adds a round for the rest', async (planned) => {
    const first = Math.min(planned, spotOrderMax(1.0007));
    const bought = floorCents(first * 0.6);
    const h = harness(fakeClock(), { route: 'loop', steps: [round(1, planned, planned)] }, {
      getCrossexAccount: seq(account({ ...WHALE, usdt: 8_000_000, gate: 0 }), account({ ...WHALE, usdt: 2_000_000, gate: bought })),
      listTickers: tickerAt('1.0006', '1.0007'),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('FILLED', String(bought))),
      createCrossexTransfer: seq(tx('x1'), tx('x2')),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { actualReceive: String(bought) })),
        rows(row('x2', 'SUCCESS', { actualReceive: String(bought - 0.05) })),
      ),
    });

    await h.run();

    const cut = nearestCents(planned - first);
    const job = h.jobs.read()!;
    expect(h.transfers().slice(0, 2).map((request) => Number(request.amount))).toEqual([bought, bought]);
    expect(toSpot(job)).toEqual([bought, ...(cut > 0 ? [cut] : []), nearestCents(first - bought)]);
    expect(Math.abs(sum(toSpot(job)) - planned)).toBeLessThanOrEqual(0.01);
    expect(job.status).toBe('done');
    expect(h.count('createCrossexOrder')).toBe(1);
  });
});

describe('runJob sends no more than the balance at size', () => {
  it.each(HAIRS)('To spot with %d in USDC · Gate moves at most that', async (cash) => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'loop', steps: [round(1, cash, cash)] },
      {
        getCrossexAccount: seq(account({ ...WHALE, gate: cash })),
        createCrossexTransfer: seq(tx('x1')),
        listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
      },
      (job) => {
        doneStep(job, 0, { venueId: 'o1', qty: cash, at: clock.now() });
        job.stepIndex = 1;
        job.fundsAt = 'GATE';
      },
    );

    await h.run();

    const amount = Number(h.transfers()[0].amount);
    expect(amount).toBeLessThanOrEqual(cash);
    expect(amount).toBeGreaterThan(cash - 0.01);
  });

  it.each(HAIRS)('From Hyperliquid with %d in USDC · Hyperliquid moves at most that', async (cash) => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'loop', steps: [round(1, cash)] }, {
      getCrossexAccount: seq(account({ ...WHALE, hyperliquid: cash })),
      createCrossexTransfer: seq(tx('x1')),
      listCrossexTransfers: seq(rows(row('x1', 'FAILED'))),
    });

    await h.run();

    const amount = Number(h.transfers()[0].amount);
    expect(amount).toBeLessThanOrEqual(cash);
    expect(amount).toBeGreaterThan(cash - 0.01);
  });

  it.each(HAIRS)(
    'a Convert out of Hyperliquid planned at %d plus 1 sells at most the wallet in chunks of at most 500,000',
    async (cash) => {
      const book = convertBook({ hyperliquid: cash });
      const h = harness(fakeClock(), { direction: 'toUsdt', route: 'convert', steps: [convert(cash + 1)] }, book.handlers);

      await h.run();

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      const sold = h.sent('createCrossexConvertQuote').map((arg) => Number(arg.crossexConvertQuoteRequest.fromAmount));
      for (const amount of sold) expect(amount).toBeGreaterThan(0);
      for (const amount of sold) expect(amount).toBeLessThanOrEqual(CONVERT_MAX);
      expect(nearestCents(sum(sold))).toBe(floorCents(cash));
      expect(book.cash().hyperliquid).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(HAIRS)('both Convert halves from Hyperliquid to Lighter planned at %d plus 1 sell at most what each wallet holds', async (cash) => {
    const book = convertBook({ hyperliquid: cash });
    const h = harness(
      fakeClock(),
      { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(cash + 1))] },
      book.handlers,
    );

    await h.run();

    expect(h.jobs.read()!).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    const requests = h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest);
    const sold = requests.filter((q) => q.fromCoin === 'USDC').map((q) => Number(q.fromAmount));
    expect(requests).toHaveLength(2 * sold.length);
    for (const amount of sold) expect(amount).toBeLessThanOrEqual(PAIR_CONVERT_MAX);
    for (const q of requests) expect(Number(q.fromAmount)).toBeLessThanOrEqual(CONVERT_MAX);
    expect(nearestCents(sum(sold))).toBe(floorCents(cash));
    expect(book.cash().hyperliquid).toBeGreaterThanOrEqual(0);
    expect(book.cash().usdt).toBeGreaterThanOrEqual(0);
  });

  it.each([1_000_000, 6_000_000])('a From Hyperliquid move of %d that Gate refuses for its amount names free margin or wallet cash', async (amount) => {
    const h = harness(fakeClock(), { direction: 'toUsdt', route: 'loop', steps: [round(1, amount)] }, {
      getCrossexAccount: seq(account({ ...WHALE, hyperliquid: amount })),
      createCrossexTransfer: seq(
        gateError(422, 'TRANSFER_AMOUNT_INSUFFICIENT', `Insufficient transferAvailable, transferAvailable: ${amount - 0.5}`),
      ),
    });

    await h.run();

    expect(h.jobs.read()!).toMatchObject({
      status: 'halted',
      stepIndex: 0,
      haltReason: 'Gate refused the move: free margin or wallet cash is too low.',
    });
    expect(h.count('createCrossexTransfer')).toBe(1);
  });
});

describe('runJob Convert quote floor at size', () => {
  const convertJob = (amount: number, toAmount: (from: number) => number) =>
    harness(fakeClock(), { direction: 'toUsdt', route: 'convert', steps: [convert(amount)] }, {
      listTickers: tickerAt('1', '1'),
      getCrossexAccount: seq(account({ ...WHALE, hyperliquid: amount })),
      createCrossexConvertQuote: quotesAt(toAmount),
      createCrossexConvertOrder: ordersInTurn(),
    });

  it.each(LADDER.flatMap((amount) => [[amount, 0.997], [amount, 0.9975]]))(
    'a Convert of %d with every quote at %s of a spot price of 1 sends every chunk',
    async (amount, rate) => {
      const h = convertJob(amount, (from) => from * rate);

      await h.run();

      expect(h.jobs.read()!.status).toBe('done');
      expect(h.count('createCrossexConvertOrder')).toBe(chunkCount(amount));
    },
  );

  it.each(LADDER)('a Convert of %d with a quote one cent under 0.3%% below a spot price of 1 halts with the 0.3%% text and sends no order', async (amount) => {
    const h = convertJob(amount, (from) => nearestCents(from * 0.997) - 0.01);

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: 'Convert quote was more than 0.3% under the Gate spot price.' });
    expect(job.steps[0].quoteId).toBeNull();
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
  });

  it.each([1_000_000, 6_000_000])(
    'a Convert of %d from Hyperliquid to Lighter at a spot price of 1 halts on a poor second quote, keeps the USDT in USDT · CrossEx, and a resume sends nothing twice',
    async (amount) => {
      const clock = fakeClock();
      let quoted = 0;
      const h = harness(clock, { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(amount))] }, {
        listTickers: tickerAt('1', '1'),
        getCrossexAccount: seq(account({ ...WHALE, hyperliquid: amount, usdt: amount })),
        createCrossexConvertQuote: quotesAt((from) => {
          quoted += 1;
          return quoted === 2 ? from * 0.99699 : floorCents(from * 0.998);
        }),
        createCrossexConvertOrder: ordersInTurn(),
      });

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 1, fundsAt: 'CROSSEX', haltReason: HALT_TEXT.poorQuote });
      expect(job.steps[0]).toMatchObject({ status: 'done', venueId: 'c1' });
      expect(h.count('createCrossexConvertOrder')).toBe(1);

      await resumeRun(h, clock);

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
      const sent = h.sent('createCrossexConvertOrder').map((arg) => arg.crossexConvertOrderRequest.quoteId);
      expect(sent).toHaveLength(2 * chunkCount(amount, PAIR_CONVERT_MAX));
      expect(sent.slice(0, 2)).toEqual(['q1', 'q3']);
      expect(new Set(sent).size).toBe(sent.length);
      const coins = h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromCoin);
      expect(coins.slice(0, 4)).toEqual(['USDC', 'USDT', 'USDT', 'USDC']);
    },
  );
});

describe('runJob Convert quote floor at the Gate spot price', () => {
  const LIVE = { ask: 1.0009, bid: 1.0008 };
  const liveTicker = () => tickerAt('1.0008', '1.0009');
  const convertAt = (direction: Direction, amount: number, toAmount: string | ((from: number) => number), listTickers: Handler) =>
    harness(fakeClock(), { direction, route: 'convert', steps: [convert(amount)] }, {
      listTickers,
      getCrossexAccount: seq(account({ ...WHALE, usdt: amount, hyperliquid: amount })),
      createCrossexConvertQuote: quotesAt(typeof toAmount === 'string' ? () => Number(toAmount) : toAmount),
      createCrossexConvertOrder: ordersInTurn(),
    });
  const halves = (toAmounts: string[]) =>
    harness(fakeClock(), { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(12))] }, {
      listTickers: liveTicker(),
      getCrossexAccount: seq(account({ ...WHALE, hyperliquid: 12, usdt: 0 }), account({ ...WHALE, usdt: 11.98 })),
      createCrossexConvertQuote: seq(...toAmounts.map((toAmount, index) => quote(`q${index + 1}`, toAmount))),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }, { body: { orderId: 'c2', text: 'q2' } }),
    });
  const expectSent = (h: ReturnType<typeof harness>, amount = 12) => {
    expect(h.jobs.read()!.status).toBe('done');
    expect(h.count('createCrossexConvertOrder')).toBe(chunkCount(amount));
  };
  const expectHalted = (h: ReturnType<typeof harness>) => {
    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', haltReason: 'Convert quote was more than 0.3% under the Gate spot price.' });
    expect(job.steps[0]).toMatchObject({ quoteId: null, venueId: null });
    expect(h.count('createCrossexConvertOrder')).toBe(0);
  };

  it('the floor for 12 USDT toward USDC at ask 1.0009 is 12 / 1.0009 x 0.997 = 11.9532', () => {
    expect(quoteFloor(12, 'USDC', LIVE)).toBeCloseTo(11.9532, 4);
  });

  it('the floor for 12 USDC toward USDT at bid 1.0008 is 12 x 1.0008 x 0.997 = 11.9736, and at bid 0.999 it is 11.9520', () => {
    expect(quoteFloor(12, 'USDT', LIVE)).toBeCloseTo(11.9736, 4);
    expect(quoteFloor(12, 'USDT', { ask: 1.0001, bid: 0.999 })).toBeCloseTo(11.952, 4);
  });

  it.each([null, { ask: NaN, bid: NaN }, { ask: 0, bid: -1 }, { ask: Infinity, bid: Infinity }])(
    'with no usable ticker (%o) the floor is 12 x 0.997 both ways',
    (ticker) => {
      expect(QUOTE_FLOOR).toBe(0.997);
      expect(quoteFloor(12, 'USDC', ticker)).toBe(12 * QUOTE_FLOOR);
      expect(quoteFloor(12, 'USDT', ticker)).toBe(12 * QUOTE_FLOOR);
    },
  );

  it('toward USDC at ask 1.0009, a quote of 11.9664 for 12 USDT sends', async () => {
    const h = convertAt('toUsdc', 12, '11.9664', liveTicker());
    await h.run();
    expectSent(h);
    expect(h.sequence.slice(-3)).toEqual(['listTickers', 'createCrossexConvertQuote', 'createCrossexConvertOrder']);
  });

  it('toward USDC at ask 1.0009, a quote of 11.95 for 12 USDT halts with the spot price text and sends no order', async () => {
    const h = convertAt('toUsdc', 12, '11.95', liveTicker());
    await h.run();
    expectHalted(h);
  });

  it('toward USDT at bid 1.0008, a quote of 11.9856 for 12 USDC sends', async () => {
    const h = convertAt('toUsdt', 12, '11.9856', liveTicker());
    await h.run();
    expectSent(h);
  });

  it('toward USDT at bid 1.0008, a quote of 11.97 for 12 USDC halts and sends no order', async () => {
    const h = convertAt('toUsdt', 12, '11.97', liveTicker());
    await h.run();
    expectHalted(h);
  });

  it('toward USDT at bid 0.999, a quote of 11.96 for 12 USDC sends', async () => {
    const h = convertAt('toUsdt', 12, '11.96', tickerAt('0.999', '1.0001'));
    await h.run();
    expectSent(h);
  });

  it('toward USDC at ask 1.0009, a quote of 11.9592 for 12 USDT, 0.25% under spot, now sends', async () => {
    const h = convertAt('toUsdc', 12, '11.9592', liveTicker());
    await h.run();
    expectSent(h);
  });

  it('toward USDT at bid 1.0008, a quote of 11.9796 for 12 USDC, 0.25% under spot, now sends', async () => {
    const h = convertAt('toUsdt', 12, '11.9796', liveTicker());
    await h.run();
    expectSent(h);
  });

  it('toward USDT at bid 1.0008, a quote of 11.9735 for 12 USDC, just under the 0.3% floor of 11.9736, halts', async () => {
    const h = convertAt('toUsdt', 12, '11.9735', liveTicker());
    await h.run();
    expectHalted(h);
  });

  it('a first half from Hyperliquid is checked against the bid: 11.97 for 12 USDC halts under the bid floor of 11.9736, though it clears the ask floor of 11.9532', async () => {
    const h = halves(['11.97']);
    await h.run();
    expectHalted(h);
  });

  it('a second half into Lighter is checked against the ask: 11.95 for 11.98 USDT sends, though it is under the bid floor of 11.9536', async () => {
    const h = halves(['11.9856', '11.95']);
    await h.run();
    expect(h.jobs.read()!.status).toBe('done');
    expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['12', '11.98']);
    expect(h.count('createCrossexConvertOrder')).toBe(2);
  });

  it('a second half into Lighter at 11.93 for 11.98 USDT halts under the ask floor of 11.9333 and keeps the USDT', async () => {
    const h = halves(['11.9856', '11.93']);
    await h.run();
    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 1, fundsAt: 'CROSSEX', haltReason: HALT_TEXT.poorQuote });
    expect(job.steps[1]).toMatchObject({ quoteId: null, venueId: null });
    expect(h.count('createCrossexConvertOrder')).toBe(1);
  });

  const liveRow = { body: [{ highestBid: '1.0008', lowestAsk: '1.0009' }] };
  const overFloor =
    (direction: Direction, cents = 0.01) =>
    (from: number): number =>
      floorCents(quoteFloor(from, direction === 'toUsdc' ? 'USDC' : 'USDT', LIVE)) + cents;
  const expectNoPrice = (h: ReturnType<typeof harness>) => {
    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.noPrice });
    expect(job.haltReason).toBe('Could not read the Gate spot price to check the Convert quote. Press Resume to try again.');
    expect(job.steps[0]).toMatchObject({ quoteId: null, venueId: null, qty: null });
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
  };

  it.each(LADDER.flatMap((amount): [Direction, number][] => [['toUsdc', amount], ['toUsdt', amount]]))(
    'a Convert %s of %d whose first ticker read throws waits one poll, reads again, and converts each chunk once, 2 s apart',
    async (direction, amount) => {
      const h = convertAt(direction, amount, overFloor(direction), seq(networkError, liveRow));
      const sleep = vi.spyOn(h.deps, 'sleep');

      await h.run();

      expectSent(h, amount);
      expect(h.count('createCrossexConvertQuote')).toBe(chunkCount(amount));
      expect(sleep.mock.calls).toEqual([[POLL_MS], ...Array(chunkCount(amount) - 1).fill([CONVERT_GAP_MS])]);
      expect(h.sequence.filter((name) => name !== 'getCrossexAccount').slice(0, 4)).toEqual([
        'listTickers',
        'listTickers',
        'createCrossexConvertQuote',
        'createCrossexConvertOrder',
      ]);
    },
  );

  it.each(
    LADDER.flatMap((amount): [string, Direction, number, Handler][] => [
      ['throws', 'toUsdc', amount, seq(networkError)],
      ['throws', 'toUsdt', amount, seq(networkError)],
      ['has no row', 'toUsdc', amount, seq({ body: [] })],
      ['has no row', 'toUsdt', amount, seq({ body: [] })],
    ]),
  )('a ticker read that %s twice halts a Convert %s of %d with the price text and asks for no quote', async (_name, direction, amount, listTickers) => {
    const h = convertAt(direction, amount, overFloor(direction), listTickers);

    await h.run();

    expectNoPrice(h);
    expect(h.count('listTickers')).toBe(2);
  });

  it.each(
    LADDER.flatMap((amount): [Direction, number, string, string][] => [
      ['toUsdt', amount, 'NaN', '1.0009'],
      ['toUsdt', amount, '0', '1.0009'],
      ['toUsdc', amount, '1.0008', 'NaN'],
      ['toUsdc', amount, '1.0008', '-1'],
    ]),
  )('a Convert %s of %d halts with the price text when the price it needs is bad: bid %s, ask %s', async (direction, amount, bid, ask) => {
    const h = convertAt(direction, amount, overFloor(direction), tickerAt(bid, ask));

    await h.run();

    expectNoPrice(h);
  });

  it.each([
    ['toUsdc', 'NaN', '1.0009'],
    ['toUsdt', '1.0008', 'NaN'],
  ] as [Direction, string, string][])('a Convert %s of 6000000 does not need the other price: bid %s, ask %s converts each chunk once', async (direction, bid, ask) => {
    const h = convertAt(direction, 6_000_000, overFloor(direction), tickerAt(bid, ask));

    await h.run();

    expectSent(h, 6_000_000);
  });

  it.each(LADDER.flatMap((amount): [Direction, number][] => [['toUsdc', amount], ['toUsdt', amount]]))(
    'a Resume after the price halt on a Convert %s of %d reads the price again and converts each chunk once',
    async (direction, amount) => {
      const h = convertAt(direction, amount, overFloor(direction), seq(networkError, networkError, liveRow));
      await h.run();
      expectNoPrice(h);

      await resumeRun(h, { now: h.deps.now, sleep: h.deps.sleep });

      expectSent(h, amount);
      expect(h.count('createCrossexConvertQuote')).toBe(chunkCount(amount));
      expect(h.count('listTickers')).toBe(2 + chunkCount(amount));
      expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe(String(firstChunk(amount)));
    },
  );

  it.each([...LADDER, ...HAIRS].flatMap((amount): [Direction, number][] => [['toUsdc', amount], ['toUsdt', amount]]))(
    'a Convert %s of %d sends every chunk quoted a cent over the spot floor and halts the first chunk quoted a cent under it',
    async (direction, amount) => {
      const sent = floorCents(amount);
      const floor = quoteFloor(sent, direction === 'toUsdc' ? 'USDC' : 'USDT', LIVE);
      const formula = direction === 'toUsdc' ? (sent / 1.0009) * 0.997 : sent * 1.0008 * 0.997;
      expect(Math.abs(floor - formula)).toBeLessThan(0.01);
      const over = convertAt(direction, amount, overFloor(direction), liveTicker());
      await over.run();
      expectSent(over, amount);
      expect(Number(over.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount)).toBe(firstChunk(amount));
      const under = convertAt(direction, amount, overFloor(direction, -0.01), liveTicker());
      await under.run();
      expectHalted(under);
    },
  );
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

const BOOK_BODY = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/gate/spot-order-book-usdc-usdt.json'), 'utf8'),
) as unknown;
const BOOK_ASK = 1.0008;
const BOOK_DEPTH = { ask: BOOK_ASK, ...bookLevels(BOOK_BODY) };

const toSpot = (job: Job) => job.steps.filter((step) => step.name === 'To spot').map((step) => step.planned ?? 0);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe('runJob Buy USDC priced from the order book', () => {
  const bookJob = (
    steps: Planned[],
    over: Parameters<typeof account>[0],
    extra: Record<string, Handler> = {},
    clock = fakeClock(),
  ) =>
    harness(clock, { route: 'loop', steps }, {
      getCrossexAccount: seq(account({ ...WHALE, ...over })),
      listTickers: tickerAt('1.0007', '1.0008'),
      listOrderBook: seq({ body: BOOK_BODY }),
      createCrossexOrder: seq(created('o1')),
      getCrossexOrder: seq(order('REJECT', '0')),
      ...extra,
    });
  const quoteQty = (h: ReturnType<typeof harness>) => Number(h.sent('createCrossexOrder')[0].crossexOrderRequest.quoteQty);
  const sent = spotOrderMax(BOOK_ASK);

  it.each([
    [1_000_000, 1_000_000],
    [6_000_000, sent],
  ])('a Buy of %d USDC sends the walked cost of %d USDC and no more than the USDT cash', async (planned, bought) => {
    const h = bookJob([round(1, planned, planned)], { usdt: 7_000_000, gate: 0 });

    await h.run();

    expect(h.calls.listOrderBook).toEqual(['USDC_USDT']);
    expect(bought).toBeLessThanOrEqual(spotOrderMax(BOOK_ASK));
    expect(quoteQty(h)).toBe(ceilCents(buyCostUsdt(bought, BOOK_DEPTH)));
    expect(quoteQty(h)).toBeGreaterThanOrEqual(ceilCents(bought * BOOK_ASK));
    expect(quoteQty(h)).toBeLessThanOrEqual(7_000_000);
  });

  it('a Buy of 1,000,000 USDC pays the top ask, 1,000,800', async () => {
    const h = bookJob([round(1, 1_000_000, 1_000_000)], { usdt: 7_000_000, gate: 0 });

    await h.run();

    expect(quoteQty(h)).toBe(1_000_800);
  });

  it.each([1_000_000, 4_900_000])('a Buy of 6,000,000 with %d USDT spends at most the cash at the walked price', async (usdt) => {
    const h = bookJob([round(1, 6_000_000, 6_000_000)], { usdt, gate: 0 });

    await h.run();

    expect(quoteQty(h)).toBeLessThanOrEqual(usdt);
    expect(quoteQty(h)).toBeGreaterThan(usdt - 10);
    expect(buyableUsdc(quoteQty(h), BOOK_DEPTH)).toBeLessThanOrEqual(sent);
  });

  it.each([1_000_000, 6_000_000])('a Buy of %d USDC with the book read failing sends the USDC times the ask', async (planned) => {
    const h = bookJob([round(1, planned, planned)], { usdt: 7_000_000, gate: 0 }, {
      listOrderBook: seq(gateError(500, 'SERVER_ERROR', 'server error')),
    });

    await h.run();

    expect(h.count('listOrderBook')).toBe(1);
    expect(quoteQty(h)).toBe(ceilCents(Math.min(planned, sent) * BOOK_ASK));
  });

  it('a $6,000,000 plan made at ask 1.0007 and sent at ask 1.0008 adds a round of the cut before the send and moves the whole plan', async () => {
    const first = spotOrderMax(1.0007);
    const second = floorCents(6_000_000 - first);
    const cut = nearestCents(first - sent);
    let atSend: Job | null = null;
    const h = bookJob([round(1, first, first), round(2, second, second)], { usdt: 7_000_000, gate: 0 }, {
      createCrossexOrder: async () => {
        atSend = h.jobs.read();
        return created('o1');
      },
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(cut).toBeGreaterThanOrEqual(11);
    expect(toSpot(atSend!)).toEqual([sent, second, cut]);
    expect(toSpot(job)).toEqual([sent, second, cut]);
    expect(job.steps.map((step) => step.round)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(Math.abs(sum(toSpot(job)) - 6_000_000)).toBeLessThanOrEqual(0.01);
    expect(quoteQty(h)).toBe(ceilCents(buyCostUsdt(sent, BOOK_DEPTH)));
  });

  it('a cut of 5 USDC, under the round minimum, grows the Convert instead of adding a round', async () => {
    const planned = nearestCents(sent + 5);
    const h = bookJob([round(1, planned, planned)], { usdt: 7_000_000, gate: 0 });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.steps.map(({ name, round: n, planned: p }) => ({ name, round: n, planned: p }))).toEqual([
      { name: 'Buy USDC', round: 1, planned },
      { name: 'To spot', round: 1, planned: sent },
      { name: 'To Hyperliquid', round: 1, planned: sent },
      { name: 'Convert', round: null, planned: 5 },
    ]);
  });

  it('a resume after the added round sends no second Buy for the first round', async () => {
    const clock = fakeClock();
    const first = spotOrderMax(1.0007);
    const second = floorCents(6_000_000 - first);
    const h = bookJob([round(1, first, first), round(2, second, second)], { usdt: 7_000_000, gate: 0 }, {
      getCrossexOrder: seq(gateError(400, 'INVALID_PARAM_VALUE', 'refused by the test'), order('FILLED', String(sent))),
    }, clock);

    await h.run();
    expect(h.jobs.read()!).toMatchObject({ status: 'halted', stepIndex: 0 });
    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(job).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.timeout });
    expect(toSpot(job)).toEqual([sent, second, nearestCents(first - sent)]);
  });
});

describe('runJob Buy USDC that fills short', () => {
  const ASK = 1.0007;
  const plannedFor = (amount: number): Planned[] => {
    const first = Math.min(amount, spotOrderMax(ASK));
    const second = floorCents(amount - first);
    return second > 0 ? [round(1, first, first), round(2, second, second)] : [round(1, amount, amount)];
  };
  const usdcFor = (spend: number): number =>
    Math.floor((Math.round(spend * 100) * 10_000) / Math.round(ASK * 10_000)) / 100;
  const shortBy = (share: number) => (usdc: number, n: number): number => (n === 0 ? floorCents(usdc * share) : usdc);
  const missBy = (miss: number) => (usdc: number, n: number): number => (n === 0 ? nearestCents(usdc - miss) : usdc);
  const whole = (usdc: number): number => usdc;
  const named = (job: Job, name: string) => job.steps.filter((step) => step.name === name);
  const moved = (job: Job) => named(job, 'To spot').map((step) => step.qty ?? 0);
  type Lag = { lag?: number; hide?: number; failed?: number; held?: number; stale?: number };
  const roundsOf = (count: number) => Array.from({ length: count }, (_, index) => [index + 1, index + 1, index + 1]).flat();

  function gateFake(usdt: number, fill: (usdc: number, n: number) => number, over: Lag) {
    let cash = usdt;
    let gate = over.held ?? 0;
    let hidden = 0;
    let unseen = 0;
    let reads = 0;
    const orders = new Map<string, number>();
    const moves: { id: string; amount: number; ok: boolean }[] = [];
    const handlers: Record<string, Handler> = {
      listTickers: tickerAt('1.0006', String(ASK)),
      getCrossexAccount: async () => {
        unseen = Math.min(unseen, over.lag ?? 0);
        const seen = unseen > 0 ? nearestCents(gate - floorCents(hidden * (over.hide ?? 1))) : gate;
        const ghost = reads === 0 ? (over.stale ?? 0) : 0;
        reads += 1;
        unseen -= 1;
        return account({ ...WHALE, usdt: cash, gate: nearestCents(seen + ghost) });
      },
      createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
        const spend = Number(arg.crossexOrderRequest.quoteQty);
        const orderId = `o${orders.size + 1}`;
        hidden = fill(usdcFor(spend), orders.size);
        orders.set(orderId, hidden);
        cash = nearestCents(cash - spend);
        gate = nearestCents(gate + hidden);
        unseen = over.lag ?? 0;
        return created(orderId);
      },
      getCrossexOrder: async (id: string) => order('FILLED', String(orders.get(id)), id),
      createCrossexTransfer: async (arg: RequestOf<'createCrossexTransfer'>) => {
        const { amount, from } = arg.crossexTransferRequest;
        const ok = moves.length >= (over.failed ?? 0);
        moves.push({ id: `x${moves.length + 1}`, amount: Number(amount), ok });
        if (ok && from === 'CROSSEX_GATE') gate = nearestCents(gate - Number(amount));
        return tx(`x${moves.length}`);
      },
      listCrossexTransfers: async () =>
        rows(...moves.map((move) => row(move.id, move.ok ? 'SUCCESS' : 'FAILED', { actualReceive: String(move.amount) }))),
      createCrossexConvertQuote: async (arg: RequestOf<'createCrossexConvertQuote'>) =>
        quote('q1', String(Number(arg.crossexConvertQuoteRequest.fromAmount) * 0.998)),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    };
    return handlers;
  }

  const shortJob = (
    amount: number,
    fill: (usdc: number, n: number) => number,
    over: Lag = {},
    route: RouteName = 'loop',
    extra: Planned[] = [],
  ) => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const handlers = gateFake(2 * amount + 100, fill, over);
    const place = handlers.createCrossexOrder;
    const before: (number | undefined)[] = [];
    const h = harness({ now: clock.now, sleep }, { route, steps: [...plannedFor(amount), ...extra] }, {
      ...handlers,
      createCrossexOrder: async (arg: never) => {
        const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'rebalance.json'), 'utf8')) as Job;
        before.push(onDisk.steps[onDisk.stepIndex].cashBefore);
        return place(arg);
      },
    });
    const restart = async (edit: (job: Job) => void = () => undefined) => {
      const file = path.join(h.dir, 'rebalance.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Job;
      edit(raw);
      fs.writeFileSync(file, JSON.stringify(raw));
      const jobs = new JobFile(h.dir, clock.now);
      jobs.haltIfRunning();
      const loaded = structuredClone(jobs.read()!);
      const job = jobs.read()!;
      job.status = 'running';
      job.haltReason = null;
      job.steps[job.stepIndex].startedAt = clock.now();
      jobs.write(job);
      await runJob({ ...h.deps, jobs });
      return { loaded, jobs };
    };
    return { ...h, clock, sleep, over, before, restart, resume: () => resumeRun(h, clock) };
  };
  const heldFor = (amount: number, share: number): number => floorCents(plannedFor(amount)[0].move * share);

  it.each(LADDER)('a Buy of %d USDC that fills 60% adds a round for the missing 40%, and To spot moves the whole plan', async (amount) => {
    const h = shortJob(amount, shortBy(0.6));

    await h.run();

    const job = h.jobs.read()!;
    const rounds = plannedFor(amount);
    const landed = floorCents(rounds[0].move * 0.6);
    expect(job.status).toBe('done');
    expect(toSpot(job)).toEqual([landed, ...rounds.slice(1).map((step) => step.move), nearestCents(rounds[0].move - landed)]);
    expect(job.steps.map((step) => step.round)).toEqual(roundsOf(rounds.length + 1));
    expect(Math.abs(sum(toSpot(job)) - amount)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(sum(moved(job)) - amount)).toBeLessThanOrEqual(0.01);
    expect(h.count('createCrossexOrder')).toBe(rounds.length + 1);
    expect(h.count('createCrossexTransfer')).toBe(2 * (rounds.length + 1));
    expect(new Set(job.steps.map((step) => step.venueId)).size).toBe(job.steps.length);
  });

  it.each(LADDER)('a Buy of %d USDC that lands 11 USDC short, the round minimum, adds a round of 11', async (amount) => {
    const h = shortJob(amount, missBy(11));

    await h.run();

    const job = h.jobs.read()!;
    const rounds = plannedFor(amount);
    expect(job.status).toBe('done');
    expect(toSpot(job)).toEqual([nearestCents(rounds[0].move - 11), ...rounds.slice(1).map((step) => step.move), 11]);
    expect(named(job, 'Convert')).toHaveLength(0);
    expect(Math.abs(sum(moved(job)) - amount)).toBeLessThanOrEqual(0.01);
  });

  it.each(LADDER.flatMap((amount) => [[amount, 10.99], [amount, 5], [amount, 1]]))(
    'a Buy of %d USDC that lands %d USDC short, under the round minimum, grows the Convert by that',
    async (amount, miss) => {
      const h = shortJob(amount, missBy(miss));

      await h.run();

      const job = h.jobs.read()!;
      const rounds = plannedFor(amount);
      expect(job.status).toBe('done');
      expect(named(job, 'Buy USDC')).toHaveLength(rounds.length);
      expect(named(job, 'Convert').map((step) => step.planned)).toEqual([miss]);
      expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe(String(miss));
      expect(Math.abs(sum(moved(job)) + miss - amount)).toBeLessThanOrEqual(0.01);
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
    },
  );

  it.each(LADDER.flatMap((amount) => [[amount, 0.99], [amount, 0.01]]))(
    'a Buy of %d USDC that lands %d USDC short, under 1 USDC, sends what landed and adds nothing',
    async (amount, miss) => {
      const h = shortJob(amount, missBy(miss));

      await h.run();

      const job = h.jobs.read()!;
      const rounds = plannedFor(amount);
      expect(job.status).toBe('done');
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(toSpot(job)).toEqual([nearestCents(rounds[0].move - miss), ...rounds.slice(1).map((step) => step.move)]);
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
    },
  );

  it.each(LADDER.flatMap((amount) => [[amount, 1], [amount, 0.4]]))(
    'a Buy of %d USDC that Gate shows one read late, with a share of %d missing, adds no round, waits once, and moves it all',
    async (amount, hide) => {
      const h = shortJob(amount, whole, { lag: 1, hide });

      await h.run();

      const job = h.jobs.read()!;
      const rounds = plannedFor(amount).map((step) => step.move);
      expect(job.status).toBe('done');
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(toSpot(job)).toEqual(rounds);
      expect(moved(job)).toEqual(rounds);
      expect(h.sleep).toHaveBeenCalledTimes(rounds.length);
      expect(h.sleep).toHaveBeenCalledWith(POLL_MS);
    },
  );

  it.each(LADDER)('a Buy of %d USDC that Gate never shows halts To spot with the timeout text and sends nothing', async (amount) => {
    const h = shortJob(amount, whole, { lag: Infinity });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.timeout });
    expect(job.steps).toHaveLength(3 * plannedFor(amount).length);
    expect(toSpot(job)).toEqual(plannedFor(amount).map((step) => step.move));
    expect(named(job, 'Convert')).toHaveLength(0);
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it.each(LADDER.flatMap((amount) => [[amount, 0.5, 3], [amount, 0.9, 90], [amount, 0.6, 200]]))(
    'a Buy of %d USDC with a share of %d of the round already in USDC · Gate, shown %d s late, adds no round and moves the old cash and the fill',
    async (amount, share, lag) => {
      const held = heldFor(amount, share);
      const h = shortJob(amount, whole, { lag, held });

      await h.run();

      const job = h.jobs.read()!;
      const rounds = plannedFor(amount).map((step) => step.move);
      expect(job.status).toBe('done');
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(named(job, 'Convert')).toHaveLength(0);
      expect(toSpot(job)).toEqual(rounds);
      expect(moved(job)).toEqual(rounds);
      expect(h.transfers().map((request) => Number(request.amount))).toEqual(rounds.flatMap((move) => [move, move]));
      expect(named(job, 'Buy USDC')[0].qty).toBe(nearestCents(rounds[0] - held));
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
      expect(h.before).toEqual([held, ...rounds.slice(1).map(() => 0)]);
      expect(h.sleep).toHaveBeenCalledTimes(lag * rounds.length);
      expect(h.onHalt).not.toHaveBeenCalled();
    },
  );

  it.each(LADDER.flatMap((amount) => [[amount, 0.3], [amount, 11], [amount, 5]]))(
    'a Buy of %d USDC read with a stale %d extra in USDC · Gate waits 120 s, sends what is there, and moves the gap in one added round or the Convert',
    async (amount, extra) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const stale = extra < 1 ? floorCents(rounds[0] * extra) : extra;
      const held = heldFor(amount, 0.2);
      const h = shortJob(amount, whole, { held, stale });

      await h.run();

      const job = h.jobs.read()!;
      const added = stale >= 11 ? [stale] : [];
      expect(job.status).toBe('done');
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(h.before[0]).toBe(nearestCents(held + stale));
      expect(named(job, 'Buy USDC')[0].qty).toBe(nearestCents(rounds[0] - held - stale));
      expect(h.sleep).toHaveBeenCalledTimes(BALANCE_LAG_MS / POLL_MS);
      expect(toSpot(job)).toEqual([nearestCents(rounds[0] - stale), ...rounds.slice(1), ...added]);
      expect(Number(h.transfers()[0].amount)).toBe(nearestCents(rounds[0] - stale));
      expect(job.steps.map((step) => step.round)).toEqual([...roundsOf(rounds.length + added.length), ...(added.length ? [] : [null])]);
      expect(named(job, 'Convert').map((step) => step.planned)).toEqual(added.length ? [] : [stale]);
      expect(h.count('createCrossexOrder')).toBe(rounds.length + added.length);
      expect(Math.abs(sum(moved(job)) + (added.length ? 0 : stale) - amount)).toBeLessThanOrEqual(0.01);
    },
  );

  it.each(LADDER)(
    'a Buy of %d USDC with 60% already in USDC · Gate and 60% of the fill hidden for 121 s stops waiting at 120 s, adds a round for the hidden part, and that round buys nothing once Gate shows it',
    async (amount) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const held = heldFor(amount, 0.6);
      const cut = floorCents(nearestCents(rounds[0] - held) * 0.6);
      const h = shortJob(amount, whole, { lag: 121, hide: 0.6, held });

      await h.run();

      const job = h.jobs.read()!;
      const bought = sum(named(job, 'Buy USDC').map((step) => step.qty ?? 0));
      expect(job.status).toBe('done');
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(cut).toBeGreaterThanOrEqual(11);
      expect(toSpot(job)).toEqual([nearestCents(rounds[0] - cut), ...rounds.slice(1), cut]);
      expect(job.steps).toHaveLength(3 * (rounds.length + 1));
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
      expect(Math.abs(sum(moved(job)) - amount)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(held + bought - sum(moved(job)))).toBeLessThanOrEqual(0.01);
      expect(h.sleep.mock.calls.length).toBeGreaterThanOrEqual(BALANCE_LAG_MS / POLL_MS);
    },
  );

  it.each(LADDER.map((amount) => [amount, amount === 50 ? 'grows the Convert' : 'adds a round']))(
    'a Buy of %d USDC with 60% already in USDC · Gate and 40% of the fill hidden for 200 s stops waiting at 120 s and %s for the hidden part, which is then bought or converted twice and left in USDC · Gate: the limit that remains',
    async (amount) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const held = heldFor(amount, 0.6);
      const fill = nearestCents(rounds[0] - held);
      const h = shortJob(amount, whole, { lag: 200, hide: 0.4, held });

      await h.run();

      const job = h.jobs.read()!;
      const buys = named(job, 'Buy USDC').map((step) => step.qty ?? 0);
      const converted = sum(named(job, 'Convert').map((step) => step.planned ?? 0));
      const left = nearestCents(held + sum(buys) - sum(moved(job)));
      expect(job.status).toBe('done');
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(toSpot(job)[0]).toBe(nearestCents(rounds[0] - floorCents(fill * 0.4)));
      expect(Math.abs(sum(moved(job)) + converted - amount)).toBeLessThanOrEqual(0.01);
      expect(left).toBeGreaterThan(0);
      if (amount === 50) {
        expect(converted).toBe(floorCents(fill * 0.4));
        expect(left).toBe(converted);
        expect(h.count('createCrossexOrder')).toBe(rounds.length);
      } else {
        expect(converted).toBe(0);
        expect(left).toBe(buys.at(-1));
        expect(h.count('createCrossexOrder')).toBe(rounds.length + 1);
      }
    },
  );

  it.each(LADDER)(
    'a Buy of %d USDC with 60% of the round already in USDC · Gate that lands 11 USDC short, shown 3 reads late, adds one round of 11',
    async (amount) => {
      const held = heldFor(amount, 0.6);
      const h = shortJob(amount, missBy(11), { lag: 3, held });

      await h.run();

      const job = h.jobs.read()!;
      const rounds = plannedFor(amount).map((step) => step.move);
      expect(job.status).toBe('done');
      expect(toSpot(job)).toEqual([nearestCents(rounds[0] - 11), ...rounds.slice(1), 11]);
      expect(job.steps.map((step) => step.round)).toEqual(roundsOf(rounds.length + 1));
      expect(named(job, 'Convert')).toHaveLength(0);
      expect(h.count('createCrossexOrder')).toBe(rounds.length + 1);
      expect(Math.abs(sum(moved(job)) - amount)).toBeLessThanOrEqual(0.01);
      expect(h.before[0]).toBe(held);
      expect(h.sleep).toHaveBeenCalledTimes(3 * (rounds.length + 1));
    },
  );

  it.each(LADDER)(
    'a Buy of %d USDC with 60% of the round already in USDC · Gate that lands 5 USDC short, shown 3 reads late, grows the Convert by 5 once',
    async (amount) => {
      const held = heldFor(amount, 0.6);
      const h = shortJob(amount, missBy(5), { lag: 3, held });

      await h.run();

      const job = h.jobs.read()!;
      const rounds = plannedFor(amount).map((step) => step.move);
      expect(job.status).toBe('done');
      expect(toSpot(job)).toEqual([nearestCents(rounds[0] - 5), ...rounds.slice(1)]);
      expect(named(job, 'Convert').map((step) => step.planned)).toEqual([5]);
      expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(['5']);
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
      expect(Math.abs(sum(moved(job)) + 5 - amount)).toBeLessThanOrEqual(0.01);
      expect(h.sleep).toHaveBeenCalledTimes(3 * rounds.length);
    },
  );

  it.each(LADDER)(
    'a Buy of %d USDC with 60% already in USDC · Gate and a fill hidden past the step timeout halts with the timeout text, and a Resume waits again and moves the old cash and the fill with no second Buy',
    async (amount) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const held = heldFor(amount, 0.6);
      const h = shortJob(amount, whole, { lag: Infinity, held });
      await h.run();
      const halted = h.jobs.read()!;
      expect(halted).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.timeout });
      expect(halted.steps).toHaveLength(3 * rounds.length);
      expect(h.count('createCrossexTransfer')).toBe(0);
      const slept = h.sleep.mock.calls.length;
      h.over.lag = 50;

      await h.resume();

      const job = h.jobs.read()!;
      expect(job.status).toBe('done');
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(toSpot(job)).toEqual(rounds);
      expect(moved(job)).toEqual(rounds);
      expect(Number(h.transfers()[0].amount)).toBe(rounds[0]);
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
      expect(h.sleep.mock.calls.length - slept).toBe(50 * rounds.length);
      expect(h.onHalt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(LADDER)(
    'a Buy of %d USDC read with a stale extra equal to the fill waits to the step timeout and halts, and each Resume waits to the timeout and halts again with nothing sent',
    async (amount) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const stale = floorCents((rounds[0] - heldFor(amount, 0.2)) / 2);
      const held = nearestCents(rounds[0] - 2 * stale);
      const h = shortJob(amount, whole, { held, stale });

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.timeout });
      expect(job.steps[0]).toMatchObject({ qty: stale, cashBefore: nearestCents(held + stale) });
      expect(job.steps).toHaveLength(3 * rounds.length);

      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.timeout });
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(h.count('createCrossexOrder')).toBe(1);
      expect(h.count('createCrossexTransfer')).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(2);
    },
  );

  it.each(LADDER.flatMap((amount) => [[amount, 0.7, 0], [amount, 0.9, 0.2]]))(
    'a round of %d USDC whose Buy is skipped on a stale read, with %d of it really in USDC · Gate, moves that and adds the rest as a round or the Convert',
    async (amount, share, over) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const held = heldFor(amount, share);
      const stale = over > 0 ? floorCents(rounds[0] * over) : nearestCents(rounds[0] - held);
      const cut = nearestCents(rounds[0] - held);
      const added = cut >= 11 ? [cut] : [];
      const h = shortJob(amount, whole, { held, stale });

      await h.run();

      const job = h.jobs.read()!;
      const converted = sum(named(job, 'Convert').map((step) => step.planned ?? 0));
      expect(held + stale).toBeGreaterThanOrEqual(rounds[0]);
      expect(job.status).toBe('done');
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(job.steps[0]).toMatchObject({ name: 'Buy USDC', qty: 0, venueId: null, cashBefore: nearestCents(held + stale) });
      expect(toSpot(job)).toEqual([held, ...rounds.slice(1), ...added]);
      expect(converted).toBe(added.length ? 0 : cut);
      expect(h.count('createCrossexOrder')).toBe(rounds.length - 1 + added.length);
      expect(Math.abs(sum(moved(job)) + converted - amount)).toBeLessThanOrEqual(0.01);
      expect(h.sleep).not.toHaveBeenCalled();
    },
  );

  it.each(LADDER.flatMap((amount) => [[amount, 0.7, 0], [amount, 0.9, 0.2]]))(
    'a mix round of %d USDC whose Buy is skipped on a stale read, with %d of it really in USDC · Gate, moves that and grows the Convert by the rest',
    async (amount, share, over) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const held = heldFor(amount, share);
      const stale = over > 0 ? floorCents(rounds[0] * over) : nearestCents(rounds[0] - held);
      const grown = nearestCents(50 + rounds[0] - held);
      const h = shortJob(amount, whole, { held, stale }, 'mix', [convert(50)]);

      await h.run();

      const job = h.jobs.read()!;
      expect(held + stale).toBeGreaterThanOrEqual(rounds[0]);
      expect(job.status).toBe('done');
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(job.steps[0]).toMatchObject({ name: 'Buy USDC', qty: 0, venueId: null, cashBefore: nearestCents(held + stale) });
      expect(named(job, 'Buy USDC')).toHaveLength(rounds.length);
      expect(h.count('createCrossexOrder')).toBe(rounds.length - 1);
      expect(toSpot(job)).toEqual([held, ...rounds.slice(1)]);
      expect(moved(job)).toEqual([held, ...rounds.slice(1)]);
      const chunks = convertSteps('CROSSEX', 'HYPERLIQUID', grown).map((step) => step.planned);
      expect(named(job, 'Convert').map((step) => step.planned)).toEqual(chunks);
      expect(nearestCents(sum(chunks.map((chunk) => chunk ?? 0)))).toBe(grown);
      expect(h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount)).toEqual(chunks.map(String));
      expect(h.count('createCrossexConvertOrder')).toBe(chunkCount(grown));
      expect(Math.abs(sum(moved(job)) + grown - 50 - amount)).toBeLessThanOrEqual(0.01);
    },
  );

  it.each(LADDER)('a round of %d USDC whose Buy is skipped because USDC · Gate holds 120% of it moves the round and adds nothing', async (amount) => {
    const rounds = plannedFor(amount).map((step) => step.move);
    const h = shortJob(amount, whole, { held: heldFor(amount, 1.2) });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps).toHaveLength(3 * rounds.length);
    expect(job.steps[0]).toMatchObject({ name: 'Buy USDC', qty: 0, venueId: null });
    expect(toSpot(job)).toEqual(rounds);
    expect(moved(job)).toEqual(rounds);
    expect(named(job, 'Convert')).toHaveLength(0);
    expect(h.count('createCrossexOrder')).toBe(rounds.length - 1);
    expect(h.onHalt).not.toHaveBeenCalled();
  });

  it.each(LADDER)(
    'a job file of %d USDC written before the Buy kept its USDC · Gate cash resumes a late To spot as before: waits, then moves the fill',
    async (amount) => {
      const h = shortJob(amount, whole, { lag: Infinity });
      await h.run();
      expect(h.jobs.read()!).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.timeout });
      const slept = h.sleep.mock.calls.length;
      h.over.lag = 3;

      const { loaded, jobs } = await h.restart((raw) => {
        delete raw.steps[0].cashBefore;
      });

      const job = jobs.read()!;
      const rounds = plannedFor(amount).map((step) => step.move);
      expect(loaded.steps[0]).toMatchObject({ name: 'Buy USDC', status: 'done' });
      expect(loaded.steps[0]).not.toHaveProperty('cashBefore');
      expect(job.status).toBe('done');
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(toSpot(job)).toEqual(rounds);
      expect(moved(job)).toEqual(rounds);
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
      expect(h.sleep.mock.calls.length - slept).toBe(3 * rounds.length);
    },
  );

  it.each(LADDER)(
    'a restart of %d USDC 60 s into the wait for old USDC · Gate cash keeps that cash, counts 120 s from the resume, adds no round, and sends no second Buy',
    async (amount) => {
      const rounds = plannedFor(amount).map((step) => step.move);
      const held = heldFor(amount, 0.6);
      const h = shortJob(amount, whole, { lag: Infinity, held });
      let died = (): void => undefined;
      const dead = new Promise<void>((resolve) => {
        died = resolve;
      });
      h.sleep.mockImplementation(async (ms: number) => {
        if (h.sleep.mock.calls.length <= 60) return h.clock.sleep(ms);
        died();
        return new Promise<void>(() => undefined);
      });
      void h.run();
      await dead;
      const firstStart = h.jobs.read()!.steps[1].startedAt!;
      h.sleep.mockImplementation(h.clock.sleep);
      h.over.lag = 100;

      const { loaded, jobs } = await h.restart();

      const job = jobs.read()!;
      expect(loaded).toMatchObject({ status: 'halted', stepIndex: 1, haltReason: HALT_TEXT.restart });
      expect(loaded.steps[0]).toMatchObject({ name: 'Buy USDC', status: 'done', cashBefore: held });
      expect(loaded.steps[1]).toMatchObject({ name: 'To spot', status: 'running', startedAt: firstStart, venueId: null });
      expect(job.steps[1].startedAt! - firstStart).toBe(60 * POLL_MS);
      expect(job.status).toBe('done');
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(job.steps).toHaveLength(3 * rounds.length);
      expect(job.steps[0].cashBefore).toBe(held);
      expect(toSpot(job)).toEqual(rounds);
      expect(moved(job)).toEqual(rounds);
      expect(Number(h.transfers()[0].amount)).toBe(rounds[0]);
      expect(h.count('createCrossexOrder')).toBe(rounds.length);
      expect(h.sleep.mock.calls.length - 61).toBe(100 * rounds.length);
    },
  );

  it.each(LADDER)('a resume of %d USDC after a 60% fill and a failed To spot sends no second Buy and adds no second round', async (amount) => {
    const h = shortJob(amount, shortBy(0.6), { failed: 1 });

    await h.run();
    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', stepIndex: 1 });
    await h.resume();

    const job = h.jobs.read()!;
    const rounds = plannedFor(amount);
    const landed = floorCents(rounds[0].move * 0.6);
    expect(job.status).toBe('done');
    expect(toSpot(halted)).toEqual([landed, ...rounds.slice(1).map((step) => step.move), nearestCents(rounds[0].move - landed)]);
    expect(toSpot(job)).toEqual(toSpot(halted));
    expect(h.transfers().slice(0, 2).map((request) => Number(request.amount))).toEqual([landed, landed]);
    expect(h.count('createCrossexOrder')).toBe(rounds.length + 1);
    expect(Math.abs(sum(moved(job)) - amount)).toBeLessThanOrEqual(0.01);
  });

  it.each(LADDER)('a mix Buy of %d USDC that fills 60% grows the Convert by the missing 40%', async (amount) => {
    const h = shortJob(amount, shortBy(0.6), {}, 'mix', [convert(50)]);

    await h.run();

    const job = h.jobs.read()!;
    const rounds = plannedFor(amount);
    const landed = floorCents(rounds[0].move * 0.6);
    const grown = nearestCents(50 + rounds[0].move - landed);
    expect(job.status).toBe('done');
    expect(named(job, 'Buy USDC')).toHaveLength(rounds.length);
    const converts = named(job, 'Convert').map((step) => step.planned ?? 0);
    expect(converts).toEqual(convertSteps('CROSSEX', 'HYPERLIQUID', grown).map((step) => step.planned));
    for (const planned of converts) expect(planned).toBeLessThanOrEqual(CONVERT_MAX);
    expect(nearestCents(sum(converts))).toBe(grown);
    expect(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount).toBe(String(firstChunk(grown)));
    expect(Math.abs(sum(moved(job)) + grown - 50 - amount)).toBeLessThanOrEqual(0.01);
  });
});

const RUNGS = [50, 4_896_572.39];
const lookupWindow = LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1;
type DiskStep = Job['steps'][number];

const diskStep = (dir: string, index: number): DiskStep =>
  JSON.parse(fs.readFileSync(path.join(dir, 'rebalance.json'), 'utf8')).steps[index];

function lagJob(
  amount: number,
  held: number | undefined,
  at: 'To Gate' | 'Sell USDC',
  shows: (read: number, waited: number) => number,
  firstRead?: () => unknown,
) {
  const clock = fakeClock();
  const t0 = clock.now();
  const disk: DiskStep[] = [];
  let accountCalls = 0;
  let reads = 0;
  let sent = at === 'Sell USDC';
  let sold = 0;
  let last = 0;
  let orders = 0;
  const probe = (): void => {
    disk.push(diskStep(h.dir, h.jobs.read()!.stepIndex));
  };
  const h = harness(
    clock,
    { direction: 'toUsdt', route: 'loop', steps: [round(1, amount)] },
    {
      listTickers: tickerAt('1.0006', '1.0007'),
      getCrossexAccount: async () => {
        accountCalls += 1;
        if (accountCalls === 1 && firstRead) return firstRead();
        reads += 1;
        const arrived = sent ? shows(reads, clock.now() - t0) : 0;
        return account({ ...WHALE, gate: nearestCents((held ?? 0) + arrived - sold) });
      },
      createCrossexTransfer: async () => {
        probe();
        sent = true;
        reads = 0;
        return tx('x2');
      },
      listCrossexTransfers: seq(rows(row('x2', 'SUCCESS', { amount: String(amount), actualReceive: String(amount) }))),
      createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
        probe();
        orders += 1;
        last = Number(arg.crossexOrderRequest.qty);
        sold = nearestCents(sold + last);
        return created(`o${orders}`);
      },
      getCrossexOrder: async (id: string) => order('FILLED', String(last), id, { executedAmount: String(last) }),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({ body: [] }),
    },
    (job) => {
      doneStep(job, 0, { venueId: 'x1', qty: amount, at: clock.now() });
      job.stepIndex = 1;
      job.fundsAt = 'SPOT';
      if (at === 'To Gate') return;
      doneStep(job, 1, { venueId: 'x2', qty: amount, at: clock.now() });
      if (held !== undefined) job.steps[1].cashBefore = held;
      job.stepIndex = 2;
      job.fundsAt = 'GATE';
    },
  );
  const qtys = () => h.sent('createCrossexOrder').map((arg) => Number(arg.crossexOrderRequest.qty));
  const unsold = () => nearestCents((held ?? 0) + amount - sold);
  return { ...h, clock, t0, disk, qtys, unsold, resume: () => resumeRun(h, clock) };
}

describe('runJob Sell USDC waits for the To Gate amount', () => {
  it.each(RUNGS)('a Sell of %d USDC waits while USDC · Gate does not show the To Gate amount, then sells it in one order and ends done', async (amount) => {
    const h = lagJob(amount, undefined, 'Sell USDC', (read) => (read > 3 ? amount : 0));

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
    expect(h.qtys()).toEqual([amount]);
    expect(h.unsold()).toBe(0);
    expect(h.count('getCrossexAccount')).toBe(5);
    expect(job.steps[2].doneAt! - job.steps[2].startedAt!).toBe(3 * POLL_MS);
    expect(h.disk.map((step) => typeof step.sentAt)).toEqual(['number']);
    expect(h.onHalt).not.toHaveBeenCalled();
  });

  it.each(RUNGS)(
    'a Sell of %d USDC that USDC · Gate never shows halts at the step timeout with nothing sold, and after a resume it shows and one Sell follows',
    async (amount) => {
      let visible = false;
      const h = lagJob(amount, undefined, 'Sell USDC', () => (visible ? amount : 0));

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.timeout, stepIndex: 2, fundsAt: 'GATE' });
      expect(job.steps[2]).toMatchObject({ status: 'running', text: null, venueId: null, qty: null });
      expect(h.count('createCrossexOrder')).toBe(0);
      expect(h.clock.now() - job.steps[2].startedAt!).toBeGreaterThan(STEP_TIMEOUT_MS);
      expect(h.onHalt).toHaveBeenCalledTimes(1);

      visible = true;
      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(h.qtys()).toEqual([amount]);
      expect(h.unsold()).toBe(0);
    },
  );

  it.each(RUNGS.map((amount) => [amount, floorCents(amount * 0.6)]))(
    'a round of %d USDC with %d already in USDC · Gate records that cash before To Gate is sent, and sells held plus arrived once',
    async (amount, held) => {
      const h = lagJob(amount, held, 'To Gate', (read) => (read > 3 ? amount : 0));

      await h.run();

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(h.disk[0]).toMatchObject({ name: 'To Gate', cashBefore: held });
      expect(h.disk.every((step) => typeof step.sentAt === 'number')).toBe(true);
      const total = nearestCents(held + amount);
      expect(nearestCents(h.qtys().reduce((sum, qty) => sum + qty, 0))).toBe(total);
      expect(h.qtys()[0]).toBe(Math.min(total, 4_896_572.39));
      expect(h.qtys()).toHaveLength(total > 4_896_572.39 ? 2 : 1);
      expect(h.unsold()).toBe(0);
    },
  );

  it.each([
    [50, 0],
    [4_896_572.39, 0],
    [4_896_572.39, 1_000_000],
  ])(
    'the triage run B Sell of %d USDC with USDC · Gate showing %d, then 0, halts at the step timeout, sends no Sell and never ends done',
    async (amount, shown) => {
      const clock = fakeClock();
      const h = harness(
        clock,
        { direction: 'toUsdt', route: 'loop', steps: [round(1, amount)] },
        {
          getCrossexAccount: seq(account({ ...WHALE, usdt: 0, gate: shown }), account({ ...WHALE, usdt: shown, gate: 0 })),
          createCrossexOrder: seq(created('o1')),
          getCrossexOrder: seq(order('FILLED', String(shown), 'o1', { executedAmount: String(shown) })),
        },
        (job) => {
          doneStep(job, 0, { venueId: 'x0', qty: amount, at: 1 });
          doneStep(job, 1, { venueId: 'x1', qty: amount, at: 1 });
          job.stepIndex = 2;
          job.fundsAt = 'GATE';
        },
      );

      await h.run();

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.timeout, fundsAt: 'GATE', stepIndex: 2 });
      expect(job.steps[2]).toMatchObject({ name: 'Sell USDC', status: 'running', qty: null });
      expect(h.count('createCrossexOrder')).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(RUNGS.map((amount) => [amount, floorCents(amount * 0.6), nearestCents(amount - floorCents(amount * 0.6))]))(
    'known limit: a Sell of %d USDC with %d held before To Gate leaves the %d that Gate shows only after 200 s in USDC · Gate, and the job ends done',
    async (amount, held, rest) => {
      const part = nearestCents(amount - rest);
      const h = lagJob(amount, held, 'Sell USDC', (_, waited) => (waited >= 200_000 ? amount : part));

      await h.run();

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(nearestCents(h.qtys().reduce((sum, qty) => sum + qty, 0))).toBe(nearestCents(held + part));
      expect(job.steps[2].doneAt! - job.steps[2].startedAt!).toBeGreaterThanOrEqual(BALANCE_LAG_MS);
      expect(h.clock.now() - h.t0).toBeLessThan(200_000);
      expect(h.unsold()).toBe(rest);
      expect(h.unsold()).toBeGreaterThan(0);
    },
  );
});

function outOfHyperliquid(amount: number, first: () => unknown, taken: boolean) {
  const clock = fakeClock();
  const disk: DiskStep[] = [];
  const landed: { record: ReturnType<typeof row>; lost: boolean }[] = [];
  let calls = 0;
  let shown = false;
  let gate = 0;
  let last = 0;
  const h = harness(
    clock,
    { direction: 'toUsdt', route: 'loop', steps: [round(1, amount)] },
    {
      listTickers: tickerAt('1.0006', '1.0007'),
      getCrossexAccount: async () => account({ ...WHALE, hyperliquid: amount, gate }),
      createCrossexTransfer: async (arg: RequestOf<'createCrossexTransfer'>) => {
        disk.push(diskStep(h.dir, h.jobs.read()!.stepIndex));
        calls += 1;
        const lost = calls === 1;
        const { text, from, amount: sent } = arg.crossexTransferRequest;
        if (!lost || taken) landed.push({ record: row(`x${calls}`, 'SUCCESS', { text: String(text), amount: sent, actualReceive: sent }), lost });
        if (from === 'SPOT') gate = nearestCents(gate + Number(sent));
        return lost ? first() : tx(`x${calls}`);
      },
      listCrossexTransfers: async () => rows(...landed.filter((item) => shown || !item.lost).map((item) => item.record)),
      createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
        last = Number(arg.crossexOrderRequest.qty);
        gate = nearestCents(gate - last);
        return created('o1');
      },
      getCrossexOrder: async (id: string) => order('FILLED', String(last), id, { executedAmount: String(last) }),
    },
  );
  const fromVenue = () => h.transfers().filter((transfer) => transfer.from === 'CROSSEX_HYPERLIQUID');
  const qtys = () => h.sent('createCrossexOrder').map((arg) => Number(arg.crossexOrderRequest.qty));
  const show = (): void => {
    shown = true;
  };
  return { ...h, clock, disk, fromVenue, qtys, show, resume: () => resumeRun(h, clock) };
}

function convertOf(amount: number, orderCall: (index: number) => unknown, edit?: (job: Job, now: number) => void) {
  const clock = fakeClock();
  const first = firstChunk(amount);
  const firstTo = floorCents(first * 0.998);
  const disk: DiskStep[] = [];
  const h = harness(
    clock,
    { route: 'convert', steps: [convert(amount)] },
    {
      getCrossexAccount: seq(account({ ...WHALE, usdt: 2 * amount })),
      createCrossexConvertQuote: quotesAt((from) => floorCents(from * 0.998)),
      createCrossexConvertOrder: async () => {
        disk.push(diskStep(h.dir, h.jobs.read()!.stepIndex));
        return orderCall(disk.length);
      },
      getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
      listCrossexOpenOrders: seq({ body: [] }),
      listCrossexHistoryOrders: seq({ body: [] }),
    },
    edit && ((job) => edit(job, clock.now())),
  );
  const fromAmounts = () => h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount);
  return { ...h, clock, disk, first, firstTo, fromAmounts, resume: () => resumeRun(h, clock) };
}

describe('runJob sends no step a second time on its own after an unknown result', () => {
  it.each(RUNGS)(
    'a From Hyperliquid move of %d USDC with a network error at send and no record for 2 min halts with the not-listed text, and after a resume adopts the record and sends nothing twice',
    async (amount) => {
      const h = outOfHyperliquid(amount, networkError, true);

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed, stepIndex: 0 });
      expect(job.haltReason).toBe(
        'Gate does not show the last step after 2 min. Press Resume to check again. If Gate still does not show it, Resume sends it again.',
      );
      expect(job.steps[0]).toMatchObject({ text: tagFor(job.id, 1), venueId: null });
      expect(job.steps[0]).not.toHaveProperty('sentAt');
      expect(h.disk[0].sentAt).toBeTypeOf('number');
      expect(h.fromVenue()).toHaveLength(1);
      expect(h.count('listCrossexTransfers')).toBe(lookupWindow);
      expect(h.onHalt).toHaveBeenCalledTimes(1);

      h.show();
      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(job.steps[0]).toMatchObject({ venueId: 'x1', qty: amount, status: 'done' });
      expect(h.fromVenue()).toHaveLength(1);
      expect(h.fromVenue()[0].amount).toBe(String(amount));
      expect(h.qtys()).toEqual([amount]);
      expect(h.onHalt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(RUNGS)(
    'a Convert of %d USDT from a wallet holding twice that, with a lost order response and no record, halts, and a resume that misses again sends exactly one more Convert for that chunk',
    async (amount) => {
      const h = convertOf(amount, (index) => (index === 1 ? networkError() : { body: { orderId: `c${index}`, text: `q${index}` } }));

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed });
      expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null });
      expect(job.steps[0]).not.toHaveProperty('sentAt');
      expect(h.disk[0]).toMatchObject({ quoteId: 'q1', qty: h.firstTo });
      expect(h.disk[0].sentAt).toBeTypeOf('number');
      expect(h.count('createCrossexConvertOrder')).toBe(1);
      expect(h.calls.getCrossexOrder).toEqual(Array(lookupWindow).fill('q1'));

      await h.resume();

      job = h.jobs.read()!;
      const chunks = chunkCount(amount);
      expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
      expect(job.steps).toHaveLength(chunks);
      expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: h.firstTo, status: 'done' });
      expect(h.count('createCrossexConvertOrder')).toBe(chunks + 1);
      expect(h.disk.map((step) => step.quoteId)).toEqual(Array.from({ length: chunks + 1 }, (_, index) => `q${index + 1}`));
      expect(h.fromAmounts()).toEqual([String(h.first), ...job.steps.map((step) => String(step.planned))]);
      expect(h.calls.getCrossexOrder).toEqual(Array(2 * lookupWindow).fill('q1'));
    },
  );

  it.each(RUNGS)(
    'a From Hyperliquid move of %d USDC that Gate refuses at send halts with the refusal text, not the not-listed text, and a resume that misses sends it again',
    async (amount) => {
      const h = outOfHyperliquid(amount, gateError(400, 'TRANSFER_AMOUNT_INSUFFICIENT', 'insufficient'), false);

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.marginRefused, stepIndex: 0 });
      expect(job.steps[0]).toMatchObject({ text: tagFor(job.id, 1), venueId: null });
      expect(job.steps[0]).not.toHaveProperty('sentAt');
      expect(h.count('listCrossexTransfers')).toBe(0);

      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(h.onHalt).toHaveBeenCalledTimes(1);
      expect(h.fromVenue().map((transfer) => transfer.text)).toEqual([tagFor(job.id, 1), tagFor(job.id, 1)]);
      expect(h.qtys()).toEqual([amount]);
    },
  );

  it.each(RUNGS)(
    'a From Hyperliquid move of %d USDC rate-limited at send halts with the rate-limit text, and a resume that finds no record sends it once more',
    async (amount) => {
      const h = outOfHyperliquid(amount, gateError(429, 'TOO_MANY_REQUESTS', 'slow down'), false);

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.rateLimited, stepIndex: 0 });
      expect(job.steps[0]).toMatchObject({ text: tagFor(job.id, 1), venueId: null });
      expect(job.steps[0]).not.toHaveProperty('sentAt');
      expect(h.disk[0].sentAt).toBeTypeOf('number');
      expect(h.fromVenue()).toHaveLength(1);
      expect(h.count('listCrossexTransfers')).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(1);

      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(h.onHalt).toHaveBeenCalledTimes(1);
      expect(h.fromVenue().map((transfer) => transfer.text)).toEqual([tagFor(job.id, 1), tagFor(job.id, 1)]);
      expect(h.count('listCrossexTransfers')).toBeGreaterThanOrEqual(lookupWindow);
      expect(h.qtys()).toEqual([amount]);
    },
  );

  it.each(RUNGS)(
    'a Convert of %d USDT whose order Gate rate-limits halts with the rate-limit text, and a resume looks the quote id up, then sends exactly one more Convert for that chunk',
    async (amount) => {
      const h = convertOf(amount, (index) =>
        index === 1 ? gateError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests')() : { body: { orderId: `c${index}`, text: `q${index}` } },
      );

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.rateLimited, stepIndex: 0 });
      expect(job.haltReason).toBe('Gate is limiting requests from this account. Nothing was sent. Press Resume in a minute.');
      expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null, qty: null });
      expect(job.steps[0]).not.toHaveProperty('sentAt');
      expect(h.disk[0]).toMatchObject({ quoteId: 'q1', qty: h.firstTo });
      expect(h.disk[0].sentAt).toBeTypeOf('number');
      expect(h.count('createCrossexConvertQuote')).toBe(1);
      expect(h.count('createCrossexConvertOrder')).toBe(1);
      expect(h.count('getCrossexOrder')).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(1);

      await h.resume();

      job = h.jobs.read()!;
      const chunks = chunkCount(amount);
      expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
      expect(job.steps).toHaveLength(chunks);
      expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: h.firstTo, status: 'done' });
      expect(h.count('createCrossexConvertOrder')).toBe(chunks + 1);
      expect(h.calls.getCrossexOrder).toEqual(Array(lookupWindow).fill('q1'));
      expect(h.fromAmounts()).toEqual([String(h.first), ...job.steps.map((step) => String(step.planned))]);
      expect(h.onHalt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(RUNGS.flatMap((amount): [number, string, string][] => [[amount, 'set', HALT_TEXT.notListed], [amount, 'not set', HALT_TEXT.restart]]))(
    'a boot pass on a %d USDC Buy step with a tag, sentAt %s and no record halts with "%s" and sends nothing',
    async (amount, sentAt, text) => {
      const clock = fakeClock();
      const h = harness(
        clock,
        { route: 'loop', steps: [round(1, amount, amount)] },
        {
          getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
          listCrossexOpenOrders: seq({ body: [] }),
          listCrossexHistoryOrders: seq({ body: [] }),
        },
        (job) => {
          Object.assign(job.steps[0], { text: tagFor(job.id, 1), status: 'running', startedAt: clock.now() });
          if (sentAt === 'set') job.steps[0].sentAt = clock.now();
          job.tagCount = 1;
        },
      );

      await runJob({ ...h.deps, pollOnly: true });

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: text });
      expect(job.steps[0]).toMatchObject({ text: tagFor(job.id, 1), venueId: null });
      expect(job.steps[0]).not.toHaveProperty('sentAt');
      expect(h.count('getCrossexOrder')).toBe(lookupWindow);
      expect(h.count('getCrossexAccount')).toBe(0);
      expect(h.count('createCrossexOrder')).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(1);
    },
  );

  it.each([50, CONVERT_MAX])(
    'a 1.6.1 job file with a %d USDT Convert step, a quote id, no sentAt and no record re-quotes and sends once, as before',
    async (amount) => {
      const h = convertOf(amount, () => ({ body: { orderId: 'c2', text: 'q2' } }), (job, now) => {
        Object.assign(job.steps[0], { text: tagFor(job.id, 1), quoteId: 'q0', qty: amount, status: 'running', startedAt: now });
        job.tagCount = 1;
      });
      expect(diskStep(h.dir, 0)).not.toHaveProperty('sentAt');
      const jobs = new JobFile(h.dir, h.clock.now);

      await runJob({ ...h.deps, jobs });

      const job = jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
      expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: 'c2', status: 'done' });
      expect(h.calls.getCrossexOrder).toEqual(Array(lookupWindow).fill('q0'));
      expect(h.count('createCrossexConvertQuote')).toBe(1);
      expect(h.count('createCrossexConvertOrder')).toBe(1);
      expect(h.fromAmounts()).toEqual([String(amount)]);
      expect(h.onHalt).not.toHaveBeenCalled();
    },
  );

  it.each([500_000.01, RUNGS[1]])(
    'a 1.6.1 job file with one %d USDT Convert step, a quote id, no sentAt and no record looks the quote id up, then halts with the too-big text and sends nothing',
    async (amount) => {
      const h = convertOf(amount, () => ({ body: { orderId: 'c2', text: 'q2' } }), (job, now) => {
        job.steps = [job.steps[0]];
        Object.assign(job.steps[0], { planned: amount, text: tagFor(job.id, 1), quoteId: 'q0', qty: amount, status: 'running', startedAt: now });
        job.tagCount = 1;
      });

      await h.run();

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.convertTooBig });
      expect(h.calls.getCrossexOrder).toEqual(Array(lookupWindow).fill('q0'));
      expect(h.count('createCrossexConvertQuote')).toBe(0);
      expect(h.count('createCrossexConvertOrder')).toBe(0);
    },
  );
});

function toGateSends(amount: number, held: number, spotStart: number, lostSends: number, hiddenReads?: number) {
  const clock = fakeClock();
  const disk: DiskStep[] = [];
  let gate = held;
  let pending = 0;
  let readsSinceListed = 0;
  let spot = spotStart;
  let listed = lostSends === 0;
  let taken = false;
  let lost = lostSends;
  let last = 0;
  let orders = 0;
  const h = harness(
    clock,
    { direction: 'toUsdt', route: 'loop', steps: [round(1, amount)] },
    {
      listTickers: tickerAt('1.0006', '1.0007'),
      getCrossexAccount: async () => {
        if (listed && pending > 0) {
          readsSinceListed += 1;
          if (readsSinceListed > (hiddenReads ?? 0)) {
            gate = nearestCents(gate + pending);
            pending = 0;
          }
        }
        return account({ ...WHALE, gate });
      },
      createCrossexTransfer: async (arg: RequestOf<'createCrossexTransfer'>) => {
        disk.push(diskStep(h.dir, 1));
        const sent = Number(arg.crossexTransferRequest.amount);
        if (sent > spot) return gateError(400, 'TRANSFER_AMOUNT_INSUFFICIENT', `transferAvailable: ${spot}`)();
        spot = nearestCents(spot - sent);
        if (hiddenReads === undefined) gate = nearestCents(gate + sent);
        else pending = nearestCents(pending + sent);
        taken = true;
        if (lost === 0) return tx('x2');
        lost -= 1;
        return networkError();
      },
      listCrossexTransfers: async () =>
        rows(
          ...(listed && taken
            ? [row('x2', 'SUCCESS', { text: tagFor(h.job.id, 1), amount: String(amount), actualReceive: String(amount) })]
            : []),
        ),
      createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
        orders += 1;
        last = Number(arg.crossexOrderRequest.qty);
        gate = nearestCents(gate - last);
        return created(`o${orders}`);
      },
      getCrossexOrder: async (id: string) => order('FILLED', String(last), id, { executedAmount: String(last) }),
    },
    (job) => {
      doneStep(job, 0, { venueId: 'x1', qty: amount, at: clock.now() });
      job.stepIndex = 1;
      job.fundsAt = 'SPOT';
    },
  );
  const qtys = () => h.sent('createCrossexOrder').map((arg) => Number(arg.crossexOrderRequest.qty));
  const soldTotal = () => nearestCents(qtys().reduce((sum, qty) => sum + qty, 0));
  const list = (): void => {
    listed = true;
  };
  const change = (cash: number): void => {
    gate = cash;
    spot = amount;
  };
  const gateTotal = () => nearestCents(gate + pending);
  return { ...h, clock, disk, qtys, soldTotal, list, change, gate: gateTotal, resume: () => resumeRun(h, clock) };
}

describe('runJob To Gate keeps the cash it read before a send Gate may have taken', () => {
  it.each(RUNGS.map((amount) => [amount, floorCents(amount * 0.6)]))(
    'a To Gate of %d USDC with %d held that Gate took but did not list keeps its first cashBefore through a refused second send, and once the first transfer is found the Sell sells held plus the amount once',
    async (amount, held) => {
      const h = toGateSends(amount, held, amount, 1);

      await h.run();

      expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed, stepIndex: 1 });
      expect(h.transfers()).toHaveLength(1);

      await h.resume();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: 'Gate spot has no USDC.', stepIndex: 1 });
      expect(h.transfers()).toHaveLength(2);
      expect(h.disk.map((step) => step.cashBefore)).toEqual([held, held]);
      expect(job.steps[1].cashBefore).toBe(held);
      expect(job.steps[1]).not.toHaveProperty('sentAt');

      h.list();
      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(job.steps[1]).toMatchObject({ venueId: 'x2', qty: amount, status: 'done' });
      expect(h.transfers()).toHaveLength(2);
      const total = nearestCents(held + amount);
      expect(h.soldTotal()).toBe(total);
      expect(h.qtys()).toHaveLength(total > 4_896_572.39 ? 2 : 1);
      expect(h.gate()).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(2);
    },
  );

  it.each(RUNGS.flatMap((amount): [number, number, number, string][] => [
    [amount, floorCents(amount * 0.6), -5, 'waits 120 s'],
    [amount, floorCents(amount * 0.6), 5, 'does not wait'],
  ]))(
    'a To Gate of %d USDC with %d held, refused for spot cash, keeps that read after USDC · Gate changes by %d before the Resume, and the Sell %s and sells all the cash once',
    async (amount, held, change) => {
      const h = toGateSends(amount, held, 0, 0);

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: 'Gate spot has no USDC.', stepIndex: 1 });
      expect(job.steps[1].cashBefore).toBe(held);
      expect(job.steps[1]).not.toHaveProperty('sentAt');

      h.change(nearestCents(held + change));
      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(h.disk.map((step) => step.cashBefore)).toEqual([held, held]);
      expect(h.transfers()).toHaveLength(2);
      expect(h.soldTotal()).toBe(nearestCents(held + change + amount));
      expect(h.gate()).toBe(0);
      expect(job.steps[2].doneAt! - job.steps[2].startedAt!).toBe(change < 0 ? BALANCE_LAG_MS : 0);
    },
  );

  it.each(RUNGS)(
    'a To Gate of %d USDC whose account read fails with an error that is not retried halts before any send, with no transfer call',
    async (amount) => {
      const h = lagJob(amount, undefined, 'To Gate', () => amount, () => ({ body: { marginBalance: 'x', initialMargin: '0', assets: [] } }));

      await h.run();

      const job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: 'account read has no margin balance', stepIndex: 1, fundsAt: 'SPOT' });
      expect(job.steps[1]).toMatchObject({ name: 'To Gate', text: null, venueId: null });
      expect(job.steps[1]).not.toHaveProperty('cashBefore');
      expect(job.steps[1]).not.toHaveProperty('sentAt');
      expect(h.count('getCrossexAccount')).toBe(1);
      expect(h.count('createCrossexTransfer')).toBe(0);
      expect(h.onHalt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(RUNGS)(
    'a To Gate of %d USDC whose account read hits a network error reads again, sends once, and the job ends done',
    async (amount) => {
      const h = lagJob(amount, undefined, 'To Gate', () => amount, networkError);

      await h.run();

      expect(h.jobs.read()).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(h.sequence.slice(0, 3)).toEqual(['getCrossexAccount', 'getCrossexAccount', 'createCrossexTransfer']);
      expect(h.transfers()).toHaveLength(1);
      expect(h.disk[0]).toMatchObject({ name: 'To Gate', cashBefore: 0 });
      expect(h.qtys()).toEqual([amount]);
      expect(h.onHalt).not.toHaveBeenCalled();
    },
  );

  it.each(RUNGS)(
    'known stall (Q8): a first Sell of %d USDC that Gate took and never lists halts with the not-listed text, then every Resume waits for USDC already sold and halts with the timeout text, with 1 order in total',
    async (amount) => {
      const clock = fakeClock();
      let gate = amount;
      const h = harness(
        clock,
        { direction: 'toUsdt', route: 'loop', steps: [round(1, amount)] },
        {
          listTickers: tickerAt('1.0006', '1.0007'),
          getCrossexAccount: async () => account({ ...WHALE, gate }),
          createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
            gate = nearestCents(gate - Number(arg.crossexOrderRequest.qty));
            return networkError();
          },
          getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found')),
          listCrossexOpenOrders: seq({ body: [] }),
          listCrossexHistoryOrders: seq({ body: [] }),
        },
        (job) => {
          doneStep(job, 0, { venueId: 'x1', qty: amount, at: clock.now() });
          doneStep(job, 1, { venueId: 'x2', qty: amount, at: clock.now() });
          job.steps[1].cashBefore = 0;
          job.stepIndex = 2;
          job.fundsAt = 'GATE';
        },
      );

      await h.run();

      expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed, stepIndex: 2 });
      expect(h.count('createCrossexOrder')).toBe(1);
      expect(gate).toBe(0);

      for (const pass of [1, 2]) {
        const resumedAt = clock.now();
        await resumeRun(h, clock);
        const job = h.jobs.read()!;
        expect(job, `Resume ${pass}`).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.timeout, stepIndex: 2 });
        expect(job.steps[2]).toMatchObject({ status: 'running', venueId: null, text: tagFor(job.id, 2) });
        expect(clock.now() - resumedAt).toBeGreaterThan(STEP_TIMEOUT_MS);
        expect(h.count('createCrossexOrder')).toBe(1);
      }
      expect(h.onHalt).toHaveBeenCalledTimes(3);
    },
  );
});

describe('runJob To Gate keeps its first cash read through a refused resend', () => {
  it.each(RUNGS.map((amount) => [amount, floorCents(amount * 1.2)]))(
    'a To Gate of %d USDC with %d held that Gate took, did not list and credits late keeps its first cashBefore through a refused second send, so the Sell waits for the credit and sells held plus the amount once',
    async (amount, held) => {
      const h = toGateSends(amount, held, amount, 1, 3);

      await h.run();

      expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.notListed, stepIndex: 1 });

      await h.resume();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', haltReason: 'Gate spot has no USDC.', stepIndex: 1 });
      expect(job.steps[1].cashBefore).toBe(held);
      expect(h.disk.map((step) => step.cashBefore)).toEqual([held, held]);

      h.list();
      await h.resume();

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'done', fundsAt: 'CROSSEX' });
      expect(job.steps[1]).toMatchObject({ venueId: 'x2', qty: amount, status: 'done' });
      const total = nearestCents(held + amount);
      expect(h.soldTotal()).toBe(total);
      expect(h.gate()).toBe(0);
      expect(h.qtys()).toHaveLength(Math.ceil(total / 4_896_572.39));
      for (const qty of h.qtys()) expect(qty).toBeLessThanOrEqual(4_896_572.39);
      expect(job.steps[2].doneAt! - job.steps[2].startedAt!).toBe(3 * POLL_MS);
      expect(h.transfers()).toHaveLength(2);
      expect(h.onHalt).toHaveBeenCalledTimes(2);
    },
  );
});

type ConvertCase = [PlannedStep['from'], PlannedStep['to'], number];
const CAP_EDGES = [499_999.99, 500_000, 500_000.01, 1_000_000.01];
const PAIR_CAP_EDGES = [494_999.99, 495_000, 495_000.01, 990_000.01, ...CAP_EDGES];
const CONVERT_CASES: ConvertCase[] = (
  [
    ['CROSSEX', 'HYPERLIQUID', CAP_EDGES],
    ['LIGHTER', 'CROSSEX', CAP_EDGES],
    ['HYPERLIQUID', 'LIGHTER', PAIR_CAP_EDGES],
  ] as const
).flatMap(([from, to, edges]) => [...LADDER, ...edges].map((amount): ConvertCase => [from, to, amount]));
const capOf = (from: PlannedStep['from'], to: PlannedStep['to']): number =>
  from === 'CROSSEX' || to === 'CROSSEX' ? CONVERT_MAX : PAIR_CONVERT_MAX;

describe('convertSteps under the 500,000 Convert cap', () => {
  it.each(CONVERT_CASES)(
    'from %s to %s, %d splits into first halves of at most 500,000 that sum to the amount, in order, with each pair together',
    (from, to, amount) => {
      const steps = convertSteps(from, to, amount);
      const paired = from !== 'CROSSEX' && to !== 'CROSSEX';
      const cap = capOf(from, to);
      const firsts = paired ? steps.filter((_, index) => index % 2 === 0) : steps;
      expect(firsts).toHaveLength(chunkCount(amount, cap));
      expect(steps.map((step) => step.name)).toEqual(
        firsts.flatMap(() => (paired ? ['Convert to USDT', 'Convert to USDC'] : ['Convert'])),
      );
      const chunks = firsts.map((step) => step.planned ?? 0);
      for (const chunk of chunks) expect(chunk).toBeLessThanOrEqual(cap);
      if (chunks.length >= 2) for (const chunk of chunks) expect(chunk).toBeGreaterThanOrEqual(cap / 2);
      for (const chunk of chunks.slice(1)) expect(nearestCents(chunks[0] - chunk)).toBeLessThanOrEqual(0.01);
      expect([...chunks].sort((a, b) => b - a)).toEqual(chunks);
      expect(nearestCents(sum(chunks))).toBe(amount);
      if (paired) {
        for (let index = 1; index < steps.length; index += 2) {
          expect(steps[index].planned).toBe(floorCents((steps[index - 1].planned ?? 0) * 0.998));
        }
      }
      for (const step of steps) expect(step).toMatchObject({ from, to, round: null, status: 'pending', text: null, quoteId: null });
    },
  );

  it.each([
    [50, [50]],
    [499_999.99, [499_999.99]],
    [500_000, [500_000]],
    [500_000.01, [250_000.01, 250_000]],
    [1_000_000, [500_000, 500_000]],
    [1_000_000.01, [333_333.34, 333_333.34, 333_333.33]],
    [1_200_000, [400_000, 400_000, 400_000]],
    [1_469_021.72, [489_673.91, 489_673.91, 489_673.9]],
    [1_499_999.99, [500_000, 500_000, 499_999.99]],
    [2_300_000, Array(5).fill(460_000)],
    [4_896_572.39, [...Array(9).fill(489_657.24), 489_657.23]],
    [6_000_000, Array(12).fill(500_000)],
  ])('a Convert of %d splits into %o', (amount, chunks) => {
    expect(convertSteps('CROSSEX', 'HYPERLIQUID', amount).map((step) => step.planned)).toEqual(chunks);
  });

  it.each([
    ['CROSSEX', 'HYPERLIQUID'],
    ['CROSSEX', 'LIGHTER'],
    ['HYPERLIQUID', 'CROSSEX'],
    ['LIGHTER', 'CROSSEX'],
  ] as [PlannedStep['from'], PlannedStep['to']][])('a Convert from %s to %s of 500,000 is still one Convert', (from, to) => {
    expect(convertSteps(from, to, 500_000).map(({ name, planned }) => [name, planned])).toEqual([['Convert', 500_000]]);
  });

  it.each([
    [494_999.99, [494_999.99]],
    [495_000, [495_000]],
    [495_000.01, [247_500.01, 247_500]],
    [500_000, [250_000, 250_000]],
    [500_000.01, [250_000.01, 250_000]],
    [990_000, [495_000, 495_000]],
    [1_000_000, [333_333.34, 333_333.33, 333_333.33]],
    [1_200_000, [400_000, 400_000, 400_000]],
    [6_000_000, [461_538.47, 461_538.47, ...Array(11).fill(461_538.46)]],
  ])('a Convert between Hyperliquid and Lighter of %d splits into pairs whose Convert to USDT halves are %o', (amount, chunks) => {
    for (const [from, to] of [
      ['HYPERLIQUID', 'LIGHTER'],
      ['LIGHTER', 'HYPERLIQUID'],
    ] as const) {
      const steps = convertSteps(from, to, amount);
      expect(steps.filter((step) => step.name === 'Convert to USDT').map((step) => step.planned)).toEqual(chunks);
      expect(steps.map((step) => step.name)).toEqual(chunks.flatMap(() => ['Convert to USDT', 'Convert to USDC']));
    }
  });
});

describe('runJob Convert over the 500,000 cap', () => {
  const quoteSizes = (h: ReturnType<typeof harness>) =>
    h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest.fromAmount);

  it('a Convert of 1,200,000 USDT into Hyperliquid quotes 400,000 three times, sends three orders, and ends done', async () => {
    const book = convertBook({ usdt: 1_200_000 });
    const h = harness(fakeClock(), { route: 'convert', steps: [convert(1_200_000)] }, book.handlers);

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(quoteSizes(h)).toEqual(['400000', '400000', '400000']);
    expect(h.sent('createCrossexConvertOrder').map((arg) => arg.crossexConvertOrderRequest.quoteId)).toEqual(['q1', 'q2', 'q3']);
    expect(job.steps.map(({ name, planned, qty, venueId, status }) => ({ name, planned, qty, venueId, status }))).toEqual([
      { name: 'Convert', planned: 400_000, qty: 399_200, venueId: 'c1', status: 'done' },
      { name: 'Convert', planned: 400_000, qty: 399_200, venueId: 'c2', status: 'done' },
      { name: 'Convert', planned: 400_000, qty: 399_200, venueId: 'c3', status: 'done' },
    ]);
    expect(book.cash()).toMatchObject({ usdt: 0, hyperliquid: 1_197_600 });
    expect(h.onHalt).not.toHaveBeenCalled();
  });

  it('a Convert of 1,200,000 USDC from Hyperliquid to Lighter runs three pairs, and each Convert to USDC sends what its own Convert to USDT returned', async () => {
    const book = convertBook({ hyperliquid: 1_200_000 });
    const h = harness(
      fakeClock(),
      { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(1_200_000))] },
      book.handlers,
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, planned, qty }) => ({ name, planned, qty }))).toEqual(
      Array.from({ length: 3 }, () => [
        { name: 'Convert to USDT', planned: 400_000, qty: 399_200 },
        { name: 'Convert to USDC', planned: 399_200, qty: 398_401.6 },
      ]).flat(),
    );
    const requests = h.sent('createCrossexConvertQuote').map(({ crossexConvertQuoteRequest: q }) => [q.exchangeType, q.fromCoin, q.fromAmount]);
    expect(requests).toEqual(
      Array.from({ length: 3 }, () => [
        ['HYPERLIQUID', 'USDC', '400000'],
        ['LIGHTER', 'USDT', '399200'],
      ]).flat(),
    );
    expect(h.count('createCrossexConvertOrder')).toBe(6);
    expect(book.cash()).toMatchObject({ usdt: 0, hyperliquid: 0 });
    expect(book.cash().lighter).toBeCloseTo(1_195_204.8, 6);
  });

  it.each(CONVERT_CASES)(
    'a Convert route from %s to %s of %d quotes at most 500,000 at a time and converts the whole amount',
    async (from, to, amount) => {
      const book = convertBook({ usdt: 0, hyperliquid: 0, lighter: 0, [WALLET_OF[from]]: amount });
      const h = harness(fakeClock(), { route: 'convert', steps: [between(from, to, convert(amount))] }, book.handlers);

      await h.run();

      const job = h.jobs.read()!;
      const paired = from !== 'CROSSEX' && to !== 'CROSSEX';
      const requests = h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest);
      const firstCoin = from === 'CROSSEX' ? 'USDT' : 'USDC';
      const firsts = requests.filter((_, index) => !paired || index % 2 === 0);
      expect(job.status).toBe('done');
      const cap = capOf(from, to);
      expect(job.steps).toHaveLength(chunkCount(amount, cap) * (paired ? 2 : 1));
      expect(firsts).toHaveLength(chunkCount(amount, cap));
      for (const q of firsts) expect(q.fromCoin).toBe(firstCoin);
      for (const q of firsts) expect(Number(q.fromAmount)).toBeLessThanOrEqual(cap);
      for (const q of requests) expect(Number(q.fromAmount)).toBeLessThanOrEqual(CONVERT_MAX);
      if (firsts.length >= 2) for (const q of firsts) expect(Number(q.fromAmount)).toBeGreaterThanOrEqual(cap / 2);
      expect(nearestCents(sum(firsts.map((q) => Number(q.fromAmount))))).toBe(amount);
      if (paired) {
        for (let index = 1; index < requests.length; index += 2) {
          expect(Number(requests[index].fromAmount)).toBe(floorCents(job.steps[index - 1].qty ?? 0));
        }
      }
      expect(Math.abs(book.cash()[WALLET_OF[from]])).toBeLessThan(0.005);
    },
  );

  it('a restart after the second 400,000 chunk of a 1,200,000 Convert was sent and its order response lost: Resume finds it by quote id, sends it no second time, then sends the third chunk', async () => {
    const clock = fakeClock();
    const book = convertBook({ usdt: 1_200_000 });
    const q1 = book.sentBefore('USDT', 400_000);
    const q2 = book.sentBefore('USDT', 400_000);
    const h = harness(clock, { route: 'convert', steps: [convert(1_200_000)] }, book.handlers, (job) => {
      doneStep(job, 0, { venueId: 'c1', qty: 399_200, at: clock.now() });
      job.steps[0].quoteId = q1;
      Object.assign(job.steps[1], {
        text: tagFor(job.id, 2),
        quoteId: q2,
        qty: 399_200,
        status: 'running',
        startedAt: clock.now(),
        sentAt: clock.now(),
      });
      job.tagCount = 2;
      job.stepIndex = 1;
      job.fundsAt = 'HYPERLIQUID';
    });
    expect(h.jobs.haltIfRunning()).toBe(true);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.restart });

    await resumeRun(h, clock);

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'HYPERLIQUID' });
    expect(job.steps.map(({ quoteId, venueId, qty, status }) => ({ quoteId, venueId, qty, status }))).toEqual([
      { quoteId: 'q1', venueId: 'c1', qty: 399_200, status: 'done' },
      { quoteId: 'q2', venueId: 'c2', qty: 399_200, status: 'done' },
      { quoteId: 'q3', venueId: 'c3', qty: 399_200, status: 'done' },
    ]);
    expect(h.calls.getCrossexOrder).toEqual(['q2', 'c2']);
    expect(quoteSizes(h)).toEqual(['400000']);
    expect(h.sent('createCrossexConvertOrder').map((arg) => arg.crossexConvertOrderRequest.quoteId)).toEqual(['q3']);
    expect(book.cash()).toMatchObject({ usdt: 0, hyperliquid: 1_197_600 });
  });

  it('a mix job that drops rounds worth 2,000,000 into a pending Convert of 300,000 rebuilds it as 460,000 five times', async () => {
    const h = harness(fakeClock(), { route: 'mix', steps: [round(1, 1_000_000), round(2, 1_000_000), convert(300_000)] }, {
      getCrossexAccount: seq(account({ marginBalance: 8, usdt: 2_300_000 })),
      createCrossexConvertQuote: quotesAt((from) => floorCents(from * 0.998)),
      createCrossexConvertOrder: ordersInTurn(),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps.map(({ name, round: r, planned }) => ({ name, round: r, planned }))).toEqual(
      Array.from({ length: 5 }, () => ({ name: 'Convert', round: null, planned: 460_000 })),
    );
    expect(quoteSizes(h)).toEqual(Array(5).fill('460000'));
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('a mix job that drops a 700,000 round into a 500,000 Convert between Hyperliquid and Lighter rebuilds it as three pairs of 400,000, next to each other', async () => {
    const across = (step: Planned) => between('HYPERLIQUID', 'LIGHTER', step);
    const h = harness(fakeClock(), { route: 'mix', steps: [across(round(1, 700_000)), across(convert(500_000))] }, {
      getCrossexAccount: seq(account({ marginBalance: 8, hyperliquid: 1_200_000, usdt: 1_200_000 })),
      createCrossexConvertQuote: quotesAt((from) => floorCents(from * 0.998)),
      createCrossexConvertOrder: ordersInTurn(),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    expect(job.steps.map(({ name, planned }) => [name, planned])).toEqual(
      Array.from({ length: 3 }, () => [
        ['Convert to USDT', 400_000],
        ['Convert to USDC', 399_200],
      ]).flat(),
    );
    for (const size of quoteSizes(h)) expect(Number(size)).toBeLessThanOrEqual(CONVERT_MAX);
  });

  it('a round dropped after both 500,000 chunks of its move were sent adds a new Convert after them and leaves the sent chunks alone', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      { route: 'mix', steps: [convert(1_000_000), round(1, 30)] },
      {
        getCrossexAccount: seq(account({ marginBalance: 8 })),
        createCrossexConvertQuote: quotesAt((from) => floorCents(from * 0.998)),
        createCrossexConvertOrder: ordersInTurn(),
      },
      (job) => {
        doneStep(job, 0, { venueId: 'c-a', qty: 499_000, at: clock.now() });
        doneStep(job, 1, { venueId: 'c-b', qty: 499_000, at: clock.now() });
        job.stepIndex = 2;
        job.fundsAt = 'HYPERLIQUID';
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps.map(({ name, planned, venueId, qty }) => [name, planned, venueId, qty])).toEqual([
      ['Convert', 500_000, 'c-a', 499_000],
      ['Convert', 500_000, 'c-b', 499_000],
      ['Convert', 30, 'c1', 29.94],
    ]);
    expect(quoteSizes(h)).toEqual(['30']);
  });

  it.each([
    ['HYPERLIQUID', 'CROSSEX', 1_000_000, 500_000],
    ['HYPERLIQUID', 'LIGHTER', 990_000, 495_000],
  ] as [PlannedStep['from'], PlannedStep['to'], number, number][])(
    'a Convert from %s to %s of %d with a wallet holding %d plus 0.004 sells that, and its empty second chunk ends at 0 with no quote',
    async (from, to, amount, held) => {
      const book = convertBook({ hyperliquid: held + 0.004 });
      const h = harness(fakeClock(), { route: 'convert', steps: [between(from, to, convert(amount))] }, book.handlers);

      await h.run();

      const job = h.jobs.read()!;
      const pair = to !== 'CROSSEX';
      const requests = h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest);
      expect(job).toMatchObject({ status: 'done', fundsAt: to });
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(requests.filter((q) => q.fromCoin === 'USDC').map((q) => q.fromAmount)).toEqual([String(held)]);
      for (const q of requests) expect(Number(q.fromAmount)).toBeGreaterThan(0);
      expect(job.steps).toHaveLength(pair ? 4 : 2);
      for (const step of job.steps.slice(pair ? 2 : 1)) expect(step).toMatchObject({ qty: 0, status: 'done', quoteId: null });
    },
  );

  it('a Convert of 990,000 from Hyperliquid to Lighter at a USDC bid of 1.0121 runs two pairs of 495,000, and no Convert to USDC sends over 500,000', async () => {
    const book = convertBook({ hyperliquid: 990_000 }, [], { USDC: 1.0121 * 0.998, USDT: 0.998 / 1.0121 });
    const h = harness(
      fakeClock(),
      { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(990_000))] },
      { ...book.handlers, listTickers: tickerAt('1.0121', '1.0122') },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', fundsAt: 'LIGHTER' });
    const requests = h.sent('createCrossexConvertQuote').map((arg) => arg.crossexConvertQuoteRequest);
    expect(requests.filter((q) => q.fromCoin === 'USDC').map((q) => q.fromAmount)).toEqual(['495000', '495000']);
    const seconds = requests.filter((q) => q.fromCoin === 'USDT').map((q) => Number(q.fromAmount));
    expect(seconds).toEqual([499_987.52, 499_987.52]);
    for (const amount of seconds) expect(amount).toBeLessThanOrEqual(CONVERT_MAX);
    expect(h.count('createCrossexConvertOrder')).toBe(4);
    expect(h.onHalt).not.toHaveBeenCalled();
  });

  it('a Convert of 990,000 from Hyperliquid to Lighter at a USDC bid of 1.0122 halts its first Convert to USDC with the too-big text and asks for no second quote', async () => {
    const book = convertBook({ hyperliquid: 990_000 }, [], { USDC: 1.0122 * 0.998, USDT: 0.998 / 1.0122 });
    const h = harness(
      fakeClock(),
      { route: 'convert', steps: [between('HYPERLIQUID', 'LIGHTER', convert(990_000))] },
      { ...book.handlers, listTickers: tickerAt('1.0122', '1.0123') },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', stepIndex: 1, fundsAt: 'CROSSEX', haltReason: HALT_TEXT.convertTooBig });
    expect(job.steps[0]).toMatchObject({ status: 'done', planned: 495_000 });
    expect(job.steps[0].qty).toBeGreaterThan(CONVERT_MAX);
    expect(job.steps[1]).toMatchObject({ quoteId: null, venueId: null, qty: null });
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(book.cash().usdt).toBeGreaterThan(CONVERT_MAX);
    expect(h.onHalt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CROSSEX', 'HYPERLIQUID', 500_000.01],
    ['CROSSEX', 'HYPERLIQUID', 6_000_000],
    ['HYPERLIQUID', 'CROSSEX', 1_000_000],
    ['HYPERLIQUID', 'LIGHTER', 500_000.01],
    ['HYPERLIQUID', 'LIGHTER', 6_000_000],
  ] as [PlannedStep['from'], PlannedStep['to'], number][])(
    'a job saved by an older version with one Convert from %s to %s of %d halts with the too-big text, asks for no quote, and a Resume halts the same way',
    async (from, to, amount) => {
      const clock = fakeClock();
      const book = convertBook({ usdt: 2 * amount, hyperliquid: 2 * amount });
      const legacy = (job: Job): void => {
        const pair = from !== 'CROSSEX' && to !== 'CROSSEX';
        job.steps = job.steps.slice(0, pair ? 2 : 1);
        job.steps[0].planned = amount;
        if (pair) job.steps[1].planned = floorCents(amount * 0.998);
      };
      const h = harness(clock, { route: 'convert', steps: [between(from, to, convert(amount))] }, book.handlers, legacy);

      await h.run();

      let job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.convertTooBig });
      expect(job.haltReason).toBe('Gate takes at most 500,000 in one Convert. Abandon this rebalance and start a new one.');
      expect(job.steps[0]).toMatchObject({ quoteId: null, venueId: null, qty: null });
      expect(h.onHalt).toHaveBeenCalledTimes(1);

      await resumeRun(h, clock);

      job = h.jobs.read()!;
      expect(job).toMatchObject({ status: 'halted', stepIndex: 0, haltReason: HALT_TEXT.convertTooBig });
      expect(h.count('createCrossexConvertQuote')).toBe(0);
      expect(h.count('createCrossexConvertOrder')).toBe(0);
      expect(h.count('listTickers')).toBe(0);
      expect(book.cash()).toMatchObject({ usdt: 2 * amount, hyperliquid: 2 * amount });
    },
  );
});

const HL_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
const GATE_ETH = 'GATE_FUTURE_ETH_USDT';

const realizeLeg = (over: Partial<RealizeLeg> = {}): RealizeLeg => ({
  pool: 'HYPERLIQUID',
  symbol: HL_ETH,
  exchange: 'HYPERLIQUID',
  base: 'ETH',
  side: 'SHORT',
  positionQty: 66,
  qty: 53.8,
  realizedUsd: 34_386,
  convert: { amount: 10_298, count: 1, feeUsd: 20.6 },
  closeFeeUsd: 51.2,
  reopenFeeUsd: 51.19,
  closeImpactUsd: 9.44,
  reopenImpactUsd: 9.44,
  impactBp: 1,
  closeMakerFeeUsd: 20.48,
  ...over,
});
const realizeOf = (...legs: RealizeLeg[]): RealizePlan => ({
  legs,
  refused: null,
  estimates: { maker: realizeEstimateOf({ legs }, 'maker'), market: realizeEstimateOf({ legs }, 'market') },
});
const heldShort = seq({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440' }] });

type OrderReq = RequestOf<'createCrossexOrder'>['crossexOrderRequest'];
type Fill = { state: string; executed: string; reason?: string };
type Outcome = Fill & { later?: Fill[] };
type Placed = { id: string; req: OrderReq; fill: Fill; later: Fill[] };

const bookAt = (bid: number, ask: number): NormalizedBook => ({ bids: [[bid, 1_000]], asks: [[ask, 1_000]], ts: 0 });
const BOOK = bookAt(2999.9, 3000.1);
const filled = (req: OrderReq): Outcome => ({ state: 'FILLED', executed: req.qty ?? '0' });

function sliceVenue(decide: (req: OrderReq, index: number) => Outcome | (() => never) = filled, accountBody = account({ hyperliquid: 1_000 })) {
  const placed: Placed[] = [];
  const cancels: string[] = [];
  const find = (key: string) => placed.find((p) => p.id === key || p.req.text === key);
  const handlers: Record<string, Handler> = {
    createCrossexOrder: async (arg: RequestOf<'createCrossexOrder'>) => {
      const req = arg.crossexOrderRequest;
      const out = decide(req, placed.length);
      if (typeof out === 'function') return out();
      const id = `o${placed.length + 1}`;
      placed.push({ id, req, fill: { state: out.state, executed: out.executed, reason: out.reason }, later: [...(out.later ?? [])] });
      return created(id);
    },
    getCrossexOrder: async (key: string) => {
      const p = find(key);
      if (!p) return gateError(404, 'ORDER_NOT_FOUND', 'Order not found')();
      const next = p.later.shift();
      if (next) p.fill = next;
      return { body: { orderId: p.id, text: p.req.text, state: p.fill.state, executedQty: p.fill.executed, reason: p.fill.reason ?? '', fee: '0' } };
    },
    cancelCrossexOrder: async (id: string) => {
      cancels.push(id);
      const p = find(id);
      if (p && !/FILLED|CANCEL/.test(p.fill.state)) {
        p.fill = { ...p.fill, state: 'CANCELLED' };
        p.later = [];
      }
      return { body: {} };
    },
    listCrossexRuleSymbols: seq({
      body: [HL_ETH, GATE_ETH].map((symbol) => ({ symbol, state: 'live', lotSize: '0.0001', minSize: '0.0001', tickSize: '0.1', businessType: 'FUTURE' })),
    }),
    getCrossexAccount: seq(accountBody),
    listCrossexPositions: heldShort,
    listCrossexOpenOrders: seq({ body: [] }),
    listCrossexHistoryOrders: seq({ body: [] }),
    createCrossexConvertQuote: quotesAt((from) => from * 0.998),
    createCrossexConvertOrder: ordersInTurn(),
  };
  const reqs = () => placed.map((p) => p.req);
  return { placed, cancels, handlers, reqs };
}

const sliceLeg = (over: Partial<RealizeLeg> = {}): RealizeLeg => realizeLeg({ qty: 10, positionQty: 66, convert: null, ...over });

function sliceRun(
  venue: ReturnType<typeof sliceVenue>,
  opts: { exec?: 'maker' | 'market'; sliceUsd?: number; leg?: Partial<RealizeLeg>; book?: () => NormalizedBook; delever?: DeleverJobInput; edit?: (job: Job) => void } = {},
) {
  const clock = fakeClock();
  const realize = realizeOf(sliceLeg(opts.leg));
  const h = harness(clock, { route: 'loop', steps: [] }, venue.handlers, (job) => {
    const sliced = newJob(
      {
        route: 'loop',
        steps: [],
        amount: 0,
        costUsd: 0,
        target: [],
        userId: null,
        kind: opts.delever ? 'delever' : 'realize',
        exec: opts.exec ?? 'maker',
        sliceUsd: opts.sliceUsd ?? 15_000,
        realize: opts.delever ? null : realize,
        delever: opts.delever ?? null,
      },
      clock.now(),
    );
    Object.assign(job, sliced);
    opts.edit?.(job);
  });
  Object.assign(h.deps, { book: async () => (opts.book ? opts.book() : BOOK) });
  borosSpy.gateCalls = () => h.sequence.length;
  const run = { ...h, clock, resume: () => resumeRun(h, clock) };
  childEngine(run);
  return run;
}

const hedgeRefused = (req: DealRequest): ChildOutcome => ({ a: req.qty, b: '0', mode: 'HALTED', haltKind: 'hedge-margin' });

describe('slices: the follow', () => {
  const marginRefusals = (accountBody = account({ hyperliquid: 1_000 })) => {
    const h = sliceRun(sliceVenue(filled, accountBody), { exec: 'market', sliceUsd: 3_000 });
    return { h, engine: childEngine(h, hedgeRefused) };
  };

  it('retry convert capped at 3 per job', async () => {
    const { h } = marginRefusals();
    await h.run();
    expect(h.count('createCrossexConvertOrder')).toBe(RETRY_CONVERT_CAP);
    expect(h.jobs.read()?.retryConverts).toBe(3);
  });

  it('counts each retry Convert in the cost so far', async () => {
    const { h } = marginRefusals();
    await h.run();
    const lost = h.sent('createCrossexConvertQuote').reduce((total, arg) => total + Number(arg.crossexConvertQuoteRequest.fromAmount) * 0.002, 0);
    expect(lost).toBeGreaterThan(0);
    expect(h.jobs.read()?.totalCostUsd).toBeCloseTo(lost, 1);
  });

  it('fourth margin refusal halts', async () => {
    const { h, engine } = marginRefusals();
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.convertCap, haltKind: 'margin' });
    expect(engine.requests).toHaveLength(4);
  });

  it('no convert at zero borrow', async () => {
    const body = account({ hyperliquid: 1_000 });
    body.body.assets[0] = { ...body.body.assets[0], liability: '0' } as (typeof body.body.assets)[number];
    const { h, engine } = marginRefusals(body);
    await h.run();
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(engine.requests).toHaveLength(1);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.noCash });
  });
});

describe('slices: retry Convert at size', () => {
  const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
  const OPEN_QTY = 10;
  const marginFor = (usd: number): number => Math.round(((usd * marginPerConvertUsdc) / 1.05) * 100) / 100;
  const sized = (marginUsd: number, cash: number, refusals = 1, liability?: string) => {
    const body = account({ hyperliquid: cash });
    if (liability !== undefined) body.body.assets[0] = { ...body.body.assets[0], liability } as (typeof body.body.assets)[number];
    const venue = sliceVenue(filled, body);
    venue.handlers.listCrossexPositions = seq({ body: [{ symbol: HL_ETH, positionQty: String(-OPEN_QTY), initialMargin: String(marginUsd) }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 30_000, leg: { qty: refusals > 1 ? 4 * OPEN_QTY : OPEN_QTY } });
    childEngine(h, (req, index) => (index < refusals ? hedgeRefused(req) : {}));
    return h;
  };
  const quoted = (h: ReturnType<typeof sliceRun>) => h.sent('createCrossexConvertQuote').map((arg) => Number(arg.crossexConvertQuoteRequest.fromAmount));
  const cents = (amounts: number[]) => amounts.reduce((total, amount) => total + Math.round(amount * 100), 0);
  const retryAmount = (h: ReturnType<typeof sliceRun>) => h.jobs.read()?.steps.find((step) => step.retry)?.retry?.convertAmount;

  it.each(RUNGS)('converts need over margin per USDC plus 5%%, to the cent (%d USD)', async (usd) => {
    const marginUsd = marginFor(usd);
    const expected = ceilCents(((OPEN_QTY * (marginUsd / OPEN_QTY)) / marginPerConvertUsdc) * 1.05);
    const h = sized(marginUsd, usd * 2);
    await h.run();
    expect(retryAmount(h)).toBe(expected);
    expect(Math.abs(expected - usd)).toBeLessThan(usd * 0.001 + 0.02);
    const amounts = quoted(h);
    expect(amounts).toHaveLength(chunkCount(expected));
    for (const amount of amounts) expect(amount).toBeLessThanOrEqual(CONVERT_MAX);
    expect(cents(amounts)).toBe(Math.round(expected * 100));
    if (usd === 6_000_000) expect(amounts.length).toBeGreaterThan(1);
    expect(h.jobs.read()).toMatchObject({ status: 'done', retryConverts: 1 });
  });

  it.each(RUNGS)('never converts past the cash in the wallet (%d USD)', async (usd) => {
    const cash = usd / 2 + 0.017;
    const h = sized(marginFor(usd), cash);
    await h.run();
    const kept = Math.round((usd / 2) * 100 + 1) / 100;
    expect(retryAmount(h)).toBe(kept);
    const amounts = quoted(h);
    for (const amount of amounts) expect(amount).toBeLessThanOrEqual(CONVERT_MAX);
    expect(cents(amounts)).toBe(Math.round(kept * 100));
    expect(cents(amounts)).toBeLessThanOrEqual(Math.round(cash * 100));
  });

  it.each([50, 6_000_000])('at most 3 retry Converts per job (%d USD)', async (usd) => {
    const marginUsd = marginFor(usd);
    const expected = ceilCents(((OPEN_QTY * (marginUsd / OPEN_QTY)) / marginPerConvertUsdc) * 1.05);
    const h = sized(marginUsd, usd * 2, Number.POSITIVE_INFINITY);
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.convertCap, haltKind: 'margin', retryConverts: RETRY_CONVERT_CAP });
    expect(h.count('createCrossexConvertOrder')).toBe(RETRY_CONVERT_CAP * chunkCount(expected));
  });

  it.each([50, 6_000_000])('no retry Convert once the To wallet borrow is 0 (%d USD)', async (usd) => {
    const h = sized(marginFor(usd), usd * 2, 1, '0');
    await h.run();
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.noCash, haltKind: 'margin', retryConverts: 0 });
  });
});

function requested(engine: ReturnType<typeof childEngine>, symbol: string): number {
  return engine.requests.reduce((total, req) => total + (req.a.symbol === symbol || req.b?.symbol === symbol ? Number(req.qty) : 0), 0);
}

function filledOn(engine: ReturnType<typeof childEngine>, symbol: string): number {
  return engine.store.listPairs().reduce((total, pair) => {
    const proj = project(pair, engine.store.listOrders(pair.id));
    return total + (pair.a.contract === symbol ? Number(proj.aFilled) : 0) + (pair.b?.contract === symbol ? Number(proj.bFilled) : 0);
  }, 0);
}

const deleverAt = (q: number, yu = 50): DeleverJobInput => ({
  makerLeg: 0,
  legs: [
    { symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', before: 2 * q, after: q, closeQty: q },
    { symbol: GATE_ETH, exchange: 'GATE', base: 'ETH', side: 'LONG', before: 2 * q, after: q, closeQty: q },
  ],
  boros: [{ marketId: 7, before: 2 * yu, after: yu, closeSize: yu }],
});

describe('slices: Boros part-fills after the last perp slice', () => {
  it.each([
    [5, 7_500, 50, 30],
    [2_000, 1_500_000, 1_000_000, 999_999.5],
  ])('%d ETH a leg: the Boros close fills part and the job halts on Boros', async (q, sliceUsd, yu, part) => {
    borosSpy.calls.length = 0;
    vi.mocked(closeBorosLegs).mockImplementationOnce(async (_deps, input) => {
      borosSpy.calls.push({ input, gateCalls: 0 });
      return { filled: input.legs.map((leg) => ({ marketId: leg.marketId, size: part })), rest: input.legs.map((leg) => ({ marketId: leg.marketId, size: leg.size - part })), held: [] };
    });
    const h = sliceRun(sliceVenue(), { delever: deleverAt(q, yu), sliceUsd });
    const engine = childEngine(h);
    Object.assign(h.deps, { boros: { deps: {} as BorosCloseDeps, address: '0x00000000000000000000000000000000000000a1' } });
    await h.run();
    expect(requested(engine, HL_ETH)).toBeCloseTo(q, 6);
    expect((borosSpy.calls[0].input as BorosCloseInput).legs).toEqual([{ marketId: 7, size: yu, keep: yu }]);
    expect(h.jobs.read()).toMatchObject({
      status: 'halted',
      haltKind: 'boros',
      haltReason: borosPartText(yu - part),
      borosLeftYu: yu - part,
      delever: { boros: [{ closed: part }] },
    });
    expect(h.onHalt).toHaveBeenCalled();
  });
});

describe('slices: a follow lot coarser than the lead lot', () => {
  const coarseRun = async (q: number, sliceUsd: number, followMinNotional = '0') => {
    const venue = sliceVenue();
    venue.handlers.listCrossexRuleSymbols = seq({
      body: [
        { symbol: HL_ETH, state: 'live', lotSize: '0.00001', minSize: '0.00001', tickSize: '0.1', businessType: 'FUTURE' },
        { symbol: GATE_ETH, state: 'live', lotSize: '0.001', minSize: '0.001', minNotional: followMinNotional, tickSize: '0.1', businessType: 'FUTURE' },
      ],
    });
    const h = sliceRun(venue, { delever: deleverAt(q), sliceUsd, exec: 'market' });
    const engine = childEngine(h);
    Object.assign(h.deps, { boros: { deps: {} as BorosCloseDeps, address: '0x00000000000000000000000000000000000000a1' } });
    await h.run();
    const wholeCoarseLots = engine.requests.every((req) => Number.isInteger(Math.round(Number(req.qty) * 1e6) / 1e3));
    return { h, engine, job: h.jobs.read(), wholeCoarseLots };
  };

  it.each([
    [50, 25_000, 0.0004],
    [6_000_000, 100_000, 0.0004],
    [50, 25_000, 0.0005],
    [6_000_000, 100_000, 0.0005],
  ])('a lead remainder under one follow lot never over-closes the follow and leaves both legs hedged (%d USD, %d slice, %d ETH)', async (usd, sliceUsd, rest) => {
    const followed = Number(floorToStep(usd / 3000, '0.001'));
    const { job, engine, h, wholeCoarseLots } = await coarseRun(followed + rest, sliceUsd);
    expect(requested(engine, HL_ETH)).toBeCloseTo(followed, 6);
    expect(requested(engine, GATE_ETH)).toBeCloseTo(followed, 6);
    expect(wholeCoarseLots).toBe(true);
    expect(job).toMatchObject({ status: 'done', haltReason: null });
    expect(job?.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(h.onHalt).not.toHaveBeenCalled();
    expect(job?.openGaps ?? []).toEqual([]);
  });

  it.each([
    [50, 25_000, 0],
    [100_000, 25_000, 2],
    [6_000_000, 100_000, 60],
  ])('a last lead slice between the lead and follow minimums still sends the follow (%d USD)', async (_usd, sliceUsd, slices) => {
    const q = Number((slices * Number(floorToStep(sliceUsd / 3000, '0.00001')) + 0.01).toFixed(5));
    const { job, engine, wholeCoarseLots } = await coarseRun(q, sliceUsd, '50');
    const followed = Number(floorToStep(q, '0.001'));
    expect(requested(engine, HL_ETH)).toBeCloseTo(followed, 6);
    expect(requested(engine, GATE_ETH)).toBeCloseTo(followed, 6);
    expect(wholeCoarseLots).toBe(true);
    expect(job?.status).toBe('done');
    expect(job?.steps.map((step) => step.status)).toEqual(['done', 'done']);
  });
});

describe('slices: pause, boot and fix', () => {
  it('pause halts after the current slice, with no alert', async () => {
    const h = sliceRun(sliceVenue(), { exec: 'market' });
    const live = liveJobOf(h);
    const engine = childEngine(h, (_req, index) => {
      if (index === 0) live().pauseRequested = true;
      return {};
    });
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', paused: true, pauseRequested: false, haltReason: null, haltKind: null, slice: { index: 1 } });
    expect(engine.requests).toHaveLength(1);
    expect(h.onHalt).not.toHaveBeenCalled();
    await h.resume();
    expect(engine.requests.map((req) => req.qty)).toEqual(['5', '5']);
    expect(h.jobs.read()).toMatchObject({ status: 'done', paused: false, slice: { index: 2 } });
  });

  const childAtBoot = async (pause: boolean, out: ChildOutcome) => {
    const h = sliceRun(sliceVenue(), { exec: 'market' });
    const engine = childEngine(h, (_req, index) => (index === 0 ? out : {}));
    const job = h.jobs.read()!;
    const id = `${job.id}-s1-1`;
    await (h.deps as unknown as { twap: TwapRunDeps }).twap.createChild({ id, a: { symbol: HL_ETH, side: 'BUY', reduceOnly: true }, b: { symbol: HL_ETH, side: 'SELL' }, qty: '5', execution: 'taker' } as DealRequest);
    job.steps[0].lead = { text: id, venueId: null, sentAt: h.clock.now(), credited: 0, poc: false, price: null };
    job.steps[0].cut = { qty: 5, from: 0, at: h.clock.now(), ioc: true };
    job.slice = { index: 1, count: 2, sizeUsd: 15_000 };
    job.pauseRequested = pause;
    if (out.mode === 'HALTED') {
      job.status = 'halted';
      job.haltKind = 'hedge-margin';
      job.haltReason = 'Hyperliquid refused the hedge in slice 1';
    }
    h.jobs.write(job);
    return { h, engine, id };
  };
  const resting: ChildOutcome = { a: '2', b: '0', mode: 'OPENING' };

  it('cancelRestingLead stops the live child, halts, and resume hedges what filled', async () => {
    const { h, engine, id } = await childAtBoot(false, resting);
    await cancelRestingLead(h.deps, h.jobs.read()!);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.restart, haltKind: 'restart' });
    expect(engine.store.getPair(id)?.mode).toBe('STOPPING');
    await h.resume();
    expect(engine.requests.map((req) => req.qty)).toEqual(['5', '5', '3']);
    expect(h.jobs.read()?.realize?.legs[0].filledQty).toBeCloseTo(10, 9);
    expect(h.jobs.read()?.status).toBe('done');
  });

  it('boot keeps a pause request', async () => {
    const { h, engine } = await childAtBoot(true, resting);
    await cancelRestingLead(h.deps, h.jobs.read()!);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', pauseRequested: true, paused: false });
    await h.resume();
    expect(engine.requests).toHaveLength(1);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', paused: true, slice: { index: 1 } });
    expect(h.jobs.read()?.realize?.legs[0].filledQty).toBeCloseTo(2, 9);
  });

  it('applyFix market resumes the halted child, which hedges what filled, and goes on', async () => {
    const { h, engine, id } = await childAtBoot(false, { a: '2', b: '0', mode: 'HALTED', haltKind: 'hedge-margin' });
    const job = await applyFix(h.deps, h.jobs.read()!, 'market');
    expect(engine.modes).toEqual([`${id}:STOPPING`]);
    expect(engine.store.getPair(id)?.mode).toBe('DONE');
    expect(job).toMatchObject({ status: 'running', haltReason: null, haltKind: null });
    expect(job.steps[0].qty).toBeCloseTo(2, 9);
  });

  it('a boot pass finishes the reopen after a retry Convert, then halts as a restart and starts no new slice', async () => {
    const { h, engine, id } = await childAtBoot(false, { a: '5', b: '0', mode: 'HALTED', haltKind: 'hedge-margin' });
    const job = h.jobs.read()!;
    Object.assign(job, { status: 'running', haltKind: null, haltReason: null });
    job.steps[0].retry = { reason: 'margin', convertAmount: 100 };
    h.jobs.write(job);
    await runJob({ ...h.deps, pollOnly: true });
    expect(engine.store.getPair(id)?.mode).toBe('DONE');
    expect(engine.requests).toHaveLength(1);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.restart, haltKind: 'restart' });
    expect(h.jobs.read()?.realize?.legs[0].filledQty).toBeCloseTo(5, 9);
  });

  it('Abandon ends a halted reopen child, so it never retries the hedge after the trader closes the gap', async () => {
    const { h, engine, id } = await childAtBoot(false, { a: '2', b: '0', mode: 'HALTED', haltKind: 'hedge-margin' });
    await endHaltedChildren(h.deps, h.jobs.read()!);
    const pair = engine.store.getPair(id);
    expect(pair?.mode).toBe('DONE');
    expect(pair?.hedgeNotBefore).toBe(Number.MAX_SAFE_INTEGER);
    expect(engine.store.listPairs({ activeOnly: true }).some((row) => row.id === id)).toBe(false);
  });
});

describe('slices: delever', () => {
  const makerLeg = pickMakerLeg({ makerRate: 0.0002, takerRate: 0.0005, slippagePct: 0 }, { makerRate: 0, takerRate: 0.00016, slippagePct: 0 }).leg === 'a' ? 0 : 1;
  const delever: DeleverJobInput = {
    makerLeg,
    legs: [
      { symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', before: 10, after: 5, closeQty: 5 },
      { symbol: GATE_ETH, exchange: 'GATE', base: 'ETH', side: 'LONG', before: 10, after: 5, closeQty: 5 },
    ],
    boros: [{ marketId: 7, before: 100, after: 50, closeSize: 50 }],
  };
  const closeSide = (side: 'LONG' | 'SHORT') => (side === 'LONG' ? 'SELL' : 'BUY');
  const deleverRun = (slippage?: number, script?: (req: DealRequest, index: number) => ChildOutcome) => {
    borosSpy.calls.length = 0;
    const venue = sliceVenue();
    const h = sliceRun(venue, { delever, sliceUsd: 7_500 });
    const engine = childEngine(h, script);
    const boros = { deps: {} as BorosCloseDeps, address: '0x00000000000000000000000000000000000000a1', ...(slippage === undefined ? {} : { slippagePct: async () => slippage }) };
    Object.assign(h.deps, { boros });
    return { venue, h, engine };
  };

  it('delever lead leg', async () => {
    const { h, engine } = deleverRun();
    await h.run();
    const lead = delever.legs[makerLeg];
    expect(engine.requests[0]).toMatchObject({ a: { symbol: lead.symbol, side: closeSide(lead.side), reduceOnly: true }, qty: '2.5', execution: 'maker' });
  });

  it('delever follow leg', async () => {
    const { h, engine } = deleverRun();
    await h.run();
    const other = delever.legs[makerLeg === 0 ? 1 : 0];
    expect(engine.requests[0]).toMatchObject({ b: { symbol: other.symbol, side: closeSide(other.side), reduceOnly: true }, qty: '2.5' });
    expect(h.jobs.read()).toMatchObject({ status: 'done', kind: 'delever', delever: { pct: 0.5 } });
  });

  it('boros after the perps', async () => {
    const seen: number[] = [];
    const { h, engine } = deleverRun(undefined, () => {
      seen.push(borosSpy.calls.length);
      return {};
    });
    await h.run();
    expect(engine.requests).toHaveLength(2);
    expect(seen).toEqual([0, 0]);
    expect(borosSpy.calls).toHaveLength(1);
  });

  it('boros close size and slippage', async () => {
    const { h } = deleverRun();
    await h.run();
    const input = borosSpy.calls[0].input as BorosCloseInput;
    expect(input).toMatchObject({ legs: [{ marketId: 7, size: 50 }], slippagePct: 1 });
    expect(input.clientOrderId).toMatch(/^t-[A-Za-z0-9]+$/);
    expect(h.jobs.read()?.delever?.boros[0].closed).toBe(50);
    const read = deleverRun(0.4);
    await read.h.run();
    expect((borosSpy.calls[0].input as BorosCloseInput).slippagePct).toBe(0.4);
  });

  it('a delever job keeps its start IM used after the end is written', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));
    const jobs = new JobFile(dir);
    const start = [{ account: 'CROSSEX' as const, pct: 0.42 }];
    const job = newJob({ route: 'loop', steps: [], amount: 0, costUsd: 0, target: [], userId: null, kind: 'delever', delever, imUsedStart: start }, 1_000_000);
    jobs.write(job);
    job.imUsedEnd = [{ account: 'CROSSEX', pct: 0.3 }];
    jobs.write(job);
    expect(new JobFile(dir).read()).toMatchObject({ imUsedStart: start, imUsedEnd: [{ account: 'CROSSEX', pct: 0.3 }] });
  });

  it('a hedge the follow venue refuses halts as hedge-margin and names the venue', async () => {
    const { h } = deleverRun(undefined, (req) => hedgeRefused(req));
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'hedge-margin' });
    expect(h.jobs.read()?.haltReason).toMatch(/refused the hedge in slice 1$/);
  });
});

describe('slices: fixes, cost and IM used', () => {
  const BOROS_A1 = '0x00000000000000000000000000000000000000a1';
  const withBoros = (h: ReturnType<typeof sliceRun>) => Object.assign(h.deps, { boros: { deps: {} as BorosCloseDeps, address: BOROS_A1 } });
  const borosLegs = () => borosSpy.calls.map((call) => (call.input as BorosCloseInput).legs);
  const atBorosPart = (q: number, script?: (req: DealRequest, index: number) => ChildOutcome) => {
    const h = sliceRun(sliceVenue(), {
      delever: deleverAt(q),
      edit: (job) => {
        job.steps[0].status = 'done';
        job.steps[0].qty = q;
        job.stepIndex = 1;
        job.status = 'halted';
        job.realize!.legs[0].filledQty = q;
        job.delever!.boros[0].closed = 20;
        job.borosLeftYu = 30;
        job.haltReason = borosPartText(30);
        job.haltKind = 'boros';
      },
    });
    return { h, engine: childEngine(h, script) };
  };
  const refuseOn = (symbol: string, times = Number.POSITIVE_INFINITY) => {
    let refused = 0;
    return (req: DealRequest): ChildOutcome => {
      if (req.a.symbol !== symbol || refused >= times) return {};
      refused += 1;
      return { refuse: new CoreError('busy', 'validation') };
    };
  };

  it.each([
    [0.0166, '0.0099'],
    [2_000, '1200'],
  ])('add back opens both perps by the Boros left share, %d ETH closed', async (q, qty) => {
    const { h, engine } = atBorosPart(q);
    const job = await applyFix(h.deps, h.jobs.read()!, 'add-back');
    expect(engine.requests.map(({ id, a, b, qty: sent }) => ({ id, symbol: a.symbol, side: a.side, reduceOnly: Boolean(a.reduceOnly), b, sent }))).toEqual([
      { id: expect.stringMatching(new RegExp(`^${job.id}-f\\d+$`)), symbol: HL_ETH, side: 'SELL', reduceOnly: false, b: null, sent: qty },
      { id: expect.stringMatching(new RegExp(`^${job.id}-f\\d+$`)), symbol: GATE_ETH, side: 'BUY', reduceOnly: false, b: null, sent: qty },
    ]);
    expect(job).toMatchObject({ status: 'done', borosLeftYu: 0, borosGapYu: 0, haltReason: null, haltKind: null });
    expect(job.steps[1].status).toBe('done');
    expect(job.imUsedEnd).toEqual([{ account: 'CROSSEX', pct: expect.any(Number) }]);
  });

  it('add back after a refused second perp sends only that perp', async () => {
    const { h, engine } = atBorosPart(5, refuseOn(GATE_ETH, 1));
    await expect(applyFix(h.deps, h.jobs.read()!, 'add-back')).rejects.toBeTruthy();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', borosLeftYu: 30 });
    const job = await applyFix(h.deps, h.jobs.read()!, 'add-back');
    expect(engine.requests.map((req) => req.a.symbol)).toEqual([HL_ETH, GATE_ETH, GATE_ETH]);
    expect(engine.store.listPairs()).toHaveLength(2);
    expect(job.status).toBe('done');
  });

  it('a Boros close with no answer halts on Boros with the gap set', async () => {
    vi.mocked(closeBorosLegs).mockImplementationOnce(async () => {
      throw new Error('Boros gave no answer');
    });
    const h = sliceRun(sliceVenue(), { delever: deleverAt(5), sliceUsd: 7_500 });
    withBoros(h);
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'boros', borosLeftYu: 50, borosGapYu: 50, delever: { boros: [{ closed: 0 }] } });
  });

  it.each([0.0166, 2_000])('boros retry credits a close the chain already shows and never closes past the share, %d ETH', async (q) => {
    borosSpy.calls.length = 0;
    vi.mocked(closeBorosLegs).mockImplementationOnce(async (_deps, input) => {
      borosSpy.calls.push({ input, gateCalls: 0 });
      const held = 70;
      const size = Math.min(input.legs[0].size, held - (input.legs[0].keep ?? 0));
      return { filled: [{ marketId: 7, size }], rest: [{ marketId: 7, size: 0 }], held: [{ marketId: 7, size: held }] };
    });
    const { h } = atBorosPart(q);
    withBoros(h);
    const job = await applyFix(h.deps, h.jobs.read()!, 'boros-retry');
    expect(borosLegs()).toEqual([[{ marketId: 7, size: 30, keep: 50 }]]);
    expect(job).toMatchObject({ status: 'done', borosLeftYu: 0, delever: { boros: [{ closed: 50 }] } });
  });

  it.each([0.0166, 2_000])('a Boros close that times out and lands later is never sent twice, %d ETH', async (q) => {
    borosSpy.calls.length = 0;
    vi.mocked(closeBorosLegs).mockImplementationOnce(async (_deps, input) => {
      borosSpy.calls.push({ input, gateCalls: 0 });
      input.onSend?.();
      throw new CoreError(`Boros timed out${MAY_HAVE_FILLED}`, 'network');
    });
    const { h } = atBorosPart(q);
    withBoros(h);
    const sentAt = h.clock.now();
    await expect(applyFix(h.deps, h.jobs.read()!, 'boros-retry')).rejects.toThrow(MAY_HAVE_FILLED);
    expect(h.jobs.read()?.delever?.boros[0].sent).toMatchObject({ size: 30, sentAt });

    await h.clock.sleep(BOROS_LATE_SEND_MS - 60_000);
    await expect(applyFix(h.deps, h.jobs.read()!, 'boros-retry')).rejects.toThrow(borosWaitText(60_000));
    expect(borosSpy.calls).toHaveLength(1);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', borosLeftYu: 30, delever: { boros: [{ closed: 20 }] } });

    await h.clock.sleep(60_000);
    vi.mocked(closeBorosLegs).mockImplementationOnce(async (_deps, input) => {
      borosSpy.calls.push({ input, gateCalls: 0 });
      const held = 50;
      const size = Math.min(input.legs[0].size, held - (input.legs[0].keep ?? 0));
      if (size > 0) input.onSend?.();
      return { filled: [{ marketId: 7, size }], rest: [{ marketId: 7, size: 0 }], held: [{ marketId: 7, size: held }] };
    });
    const job = await applyFix(h.deps, h.jobs.read()!, 'boros-retry');
    expect(borosLegs()).toEqual([[{ marketId: 7, size: 30, keep: 50 }], [{ marketId: 7, size: 30, keep: 50 }]]);
    expect(job).toMatchObject({ status: 'done', borosLeftYu: 0, delever: { boros: [{ closed: 50, sent: null }] } });
  });

  it('a restart inside the relayer window halts the Boros step with the wait line and sends nothing', async () => {
    borosSpy.calls.length = 0;
    const { h } = atBorosPart(5);
    withBoros(h);
    const job = h.jobs.read()!;
    job.delever!.boros[0].sent = { tag: tagFor(job.id, 9), size: 30, sentAt: h.clock.now() - 120_000 };
    job.status = 'running';
    job.haltReason = null;
    job.haltKind = null;
    h.jobs.write(job);
    await h.run();
    expect(borosSpy.calls).toHaveLength(0);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'boros', haltReason: borosWaitText(BOROS_LATE_SEND_MS - 120_000) });
  });

  it('boros retry is refused once one perp is added back, and the halt line names what was added', async () => {
    borosSpy.calls.length = 0;
    const { h } = atBorosPart(5, refuseOn(GATE_ETH));
    withBoros(h);
    await expect(applyFix(h.deps, h.jobs.read()!, 'add-back')).rejects.toBeTruthy();
    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', borosLeftYu: 30 });
    expect(halted.haltReason).toBe(
      addBackPartText([
        { exchange: 'HYPERLIQUID', base: 'ETH', filled: 3, qty: 3 },
        { exchange: 'GATE', base: 'ETH', filled: 0, qty: 3 },
      ]),
    );
    await expect(applyFix(h.deps, halted, 'boros-retry')).rejects.toThrow(ADD_BACK_FIRST);
    expect(borosSpy.calls).toHaveLength(0);
    expect(h.jobs.read()?.status).toBe('halted');
  });

  it.each([0.0166, 2_000])('an add back Gate refuses outright clears the add back, so boros retry closes the Boros rest, %d ETH', async (q) => {
    borosSpy.calls.length = 0;
    const { h, engine } = atBorosPart(q, refuseOn(HL_ETH));
    withBoros(h);
    await expect(applyFix(h.deps, h.jobs.read()!, 'add-back')).rejects.toBeTruthy();
    const halted = h.jobs.read()!;
    expect(halted).toMatchObject({ status: 'halted', borosLeftYu: 30, haltReason: borosPartText(30) });
    expect(halted.steps[1].addBack).toBeNull();
    expect(engine.requests.filter((req) => req.a.symbol === GATE_ETH)).toHaveLength(0);
    const job = await applyFix(h.deps, halted, 'boros-retry');
    expect(borosLegs()).toEqual([[{ marketId: 7, size: 30, keep: 50 }]]);
    expect(job).toMatchObject({ status: 'done', borosLeftYu: 0, delever: { boros: [{ closed: 50 }] } });
  });

  it('an add back with an order still open keeps the add back and refuses boros retry', async () => {
    borosSpy.calls.length = 0;
    const { h } = atBorosPart(5, (req) => (req.a.symbol === HL_ETH ? { a: '0', mode: 'OPENING' } : {}));
    withBoros(h);
    await expect(applyFix(h.deps, h.jobs.read()!, 'add-back')).rejects.toThrow(FIX_UNCONFIRMED);
    const halted = h.jobs.read()!;
    expect(halted.steps[1].addBack?.legs.map((leg) => leg.filled)).toEqual([0, 0]);
    expect(halted.steps[1].addBack?.legs[0].order).not.toBeNull();
    await expect(applyFix(h.deps, halted, 'boros-retry')).rejects.toThrow(ADD_BACK_FIRST);
    expect(borosSpy.calls).toHaveLength(0);
  });

  it.each([0.0166, 2_000])('an abandoned delever with one perp added back still closes the Boros rest on boros retry, %d ETH', async (q) => {
    borosSpy.calls.length = 0;
    const { h } = atBorosPart(q, refuseOn(GATE_ETH));
    withBoros(h);
    await expect(applyFix(h.deps, h.jobs.read()!, 'add-back')).rejects.toBeTruthy();
    expect(h.jobs.read()!.steps[1].addBack?.legs[0].filled).toBeGreaterThan(0);
    await expect(applyFix(h.deps, h.jobs.read()!, 'boros-retry')).rejects.toThrow(ADD_BACK_FIRST);
    const abandoned = h.jobs.read()!;
    abandoned.status = 'abandoned';
    h.jobs.write(abandoned);
    const job = await applyFix(h.deps, h.jobs.read()!, 'boros-retry');
    expect(borosLegs()).toEqual([[{ marketId: 7, size: 30, keep: 50 }]]);
    expect(job).toMatchObject({ status: 'abandoned', borosLeftYu: 0, delever: { boros: [{ closed: 50 }] } });
  });

  it('a delever with no Boros left to close finishes with no halt and no Boros wallet', async () => {
    borosSpy.calls.length = 0;
    const h = sliceRun(sliceVenue(), { delever: deleverAt(5), sliceUsd: 7_500, edit: (job) => void (job.delever!.boros[0].closed = 50) });
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'done', haltReason: null, haltKind: null });
    expect(h.onHalt).not.toHaveBeenCalled();
    expect(borosSpy.calls).toHaveLength(0);
  });

  const pausedAfterFirst = (venue = sliceVenue()) => {
    const h = sliceRun(venue, { delever: deleverAt(5), sliceUsd: 7_500 });
    const live = liveJobOf(h);
    const engine = childEngine(h, (_req, index) => {
      if (index === 0) live().pauseRequested = true;
      return {};
    });
    withBoros(h);
    return { h, engine };
  };

  it('boros retry on a paused delever closes only the gap and stays paused', async () => {
    borosSpy.calls.length = 0;
    const { h, engine } = pausedAfterFirst();
    await h.run();
    const fixed = await applyFix(h.deps, h.jobs.read()!, 'boros-retry');
    expect(borosLegs()).toEqual([[{ marketId: 7, size: 25, keep: 75 }]]);
    expect(fixed).toMatchObject({ status: 'halted', paused: true, stepIndex: 0, borosGapYu: 0, delever: { boros: [{ closed: 25 }] } });
    expect(fixed.steps[0].status).not.toBe('done');
    await h.resume();
    expect(engine.requests).toHaveLength(2);
    expect(borosLegs()).toEqual([[{ marketId: 7, size: 25, keep: 75 }], [{ marketId: 7, size: 25, keep: 50 }]]);
    expect(h.jobs.read()).toMatchObject({ status: 'done', delever: { boros: [{ closed: 50 }] } });
  });

  it('delever IM used after each slice and at the end', async () => {
    const at = (pct: number) => ({ body: { ...account({ hyperliquid: 1_000 }).body, marginBalance: '1000', initialMargin: String(pct * 1_000) } });
    const venue = sliceVenue();
    venue.handlers.getCrossexAccount = seq(at(0.6), at(0.5), at(0.45), at(0.3));
    const { h } = pausedAfterFirst(venue);
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', paused: true, imUsedNow: [{ account: 'CROSSEX', pct: 0.6 }], imUsedEnd: null });
    await h.resume();
    expect(h.jobs.read()).toMatchObject({ status: 'done', imUsedNow: [{ account: 'CROSSEX', pct: 0.5 }], imUsedEnd: [{ account: 'CROSSEX', pct: 0.45 }] });
  });

  it.each([
    [0.0166, 15_000],
    [2_000, 1_500_000],
  ])('realized and total cost come from the fills, %d ETH', async (qty, sliceUsd) => {
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = seq({ body: [{ symbol: HL_ETH, positionQty: String(-2 * qty), entryPrice: '3100' }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd, leg: { qty, positionQty: 2 * qty } });
    const engine = childEngine(h);
    Object.assign((h.deps as unknown as { twap: TwapRunDeps }).twap, { readFees: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, -0.5])) });
    await h.run();
    const job = h.jobs.read()!;
    const fees = engine.requests.length * 0.5;
    expect(job.status).toBe('done');
    expect(job.realize?.legs[0].realizedUsd).toBeCloseTo(qty * 100, 2);
    expect(job.feeSoFarUsd).toBeCloseTo(fees, 2);
    expect(job.totalCostUsd).toBeCloseTo(fees, 2);
  });
});

describe('job file defaults', () => {
  it('a job file without the new fields loads with defaults and keeps its realize legs', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));
    const job = newJob({ route: 'loop', steps: [], amount: 0, costUsd: 0, target: [], userId: null, realize: realizeOf(realizeLeg()) }, 1_000_000);
    const old: Record<string, unknown> = { ...job, status: 'halted' };
    for (const key of ['kind', 'exec', 'slice', 'notHedgedQty', 'followMisses', 'follow', 'borosGapYu', 'borosLeftYu', 'feeSoFarUsd', 'estimate', 'pauseRequested', 'paused', 'delever', 'imUsedNow', 'imUsedEnd', 'imUsedStart', 'totalCostUsd', 'retryConverts']) delete old[key];
    fs.writeFileSync(path.join(dir, 'rebalance.json'), JSON.stringify(old));
    expect(new JobFile(dir).read()).toMatchObject({
      status: 'halted',
      kind: 'realize',
      exec: 'market',
      slice: null,
      follow: null,
      pauseRequested: false,
      paused: false,
      delever: null,
      retryConverts: 0,
      imUsedStart: null,
    });
  });
});

describe('slices: a 100% Delever leaves no dust', () => {
  const BTC_RULES = {
    body: [
      { symbol: HL_ETH, state: 'live', lotSize: '0.00001', minSize: '0.00001', minNotional: '10', tickSize: '0.1', businessType: 'FUTURE' },
      { symbol: GATE_ETH, state: 'live', lotSize: '0.0001', minSize: '0.0001', minNotional: '0', tickSize: '0.1', businessType: 'FUTURE' },
    ],
  };
  const BTC_BOOK = bookAt(94_999.9, 95_000.1);
  const wholeAt = (hl: number, gate: number, makerLeg: 0 | 1 = 0): DeleverJobInput => {
    const closeQty = Number(floorToStep(Math.min(hl, gate), '0.0001'));
    return {
      makerLeg,
      legs: [
        { symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'BTC', side: 'LONG', before: hl, after: 0, closeQty, closeAll: true },
        { symbol: GATE_ETH, exchange: 'GATE', base: 'BTC', side: 'SHORT', before: gate, after: 0, closeQty, closeAll: true },
      ],
      boros: [{ marketId: 7, before: hl, after: 0, closeSize: hl }],
    };
  };
  const wholeRun = async (o: { hl: number; gate: number; sliceUsd: number; exec: 'maker' | 'market'; added?: number; makerLeg?: 0 | 1; script?: (req: DealRequest) => ChildOutcome }) => {
    const venue = sliceVenue();
    let engine: ReturnType<typeof childEngine> | null = null;
    const done = (symbol: string): number => (engine ? filledOn(engine, symbol) : 0);
    const live = { hl: () => o.hl + (o.added ?? 0) - done(HL_ETH), gate: () => o.gate - done(GATE_ETH) };
    venue.handlers.listCrossexRuleSymbols = seq(BTC_RULES);
    venue.handlers.listCrossexPositions = async () => ({
      body: [
        { symbol: HL_ETH, positionQty: String(live.hl()), initialMargin: '1' },
        { symbol: GATE_ETH, positionQty: String(-live.gate()), initialMargin: '1' },
      ],
    });
    const h = sliceRun(venue, { delever: wholeAt(o.hl, o.gate, o.makerLeg), sliceUsd: o.sliceUsd, exec: o.exec, book: () => BTC_BOOK });
    engine = childEngine(h, o.script);
    Object.assign(h.deps, { boros: { deps: {} as BorosCloseDeps, address: '0x00000000000000000000000000000000000000a1' } });
    borosSpy.calls.length = 0;
    await h.run();
    const pairQtys = engine.requests.filter((req) => req.b !== null).map((req) => Number(req.qty));
    return { h, job: h.jobs.read(), engine, live, pairQtys };
  };
  const CASES = [
    ['maker', 0.01659, 0.0166, 25_000],
    ['market', 0.01659, 0.0166, 25_000],
    ['maker', 63.15789, 63.1579, 100_000],
    ['market', 63.15789, 63.1579, 100_000],
  ] as const;

  it.each(CASES)('%s: %d BTC on Hyperliquid and %d BTC on Gate both end flat, with no gap and Boros closed in full', async (exec, hl, gate, sliceUsd) => {
    const { h, job, engine, live, pairQtys } = await wholeRun({ hl, gate, sliceUsd, exec });
    expect(job).toMatchObject({ status: 'done', haltReason: null, borosLeftYu: 0 });
    expect(h.onHalt).not.toHaveBeenCalled();
    expect(job?.openGaps ?? []).toHaveLength(0);
    expect(live.hl()).toBeCloseTo(0, 9);
    expect(live.gate()).toBeCloseTo(0, 9);
    expect(requested(engine, HL_ETH)).toBeCloseTo(hl, 9);
    expect(requested(engine, GATE_ETH)).toBeCloseTo(gate, 9);
    expect(pairQtys.every((qty) => qty <= sliceUsd / 95_000 + 0.0001)).toBe(true);
    expect(engine.requests.filter((req) => req.b === null).every((req) => req.a.reduceOnly === true && req.execution === 'taker')).toBe(true);
    expect(job?.delever?.boros[0].closed).toBeCloseTo(hl, 9);
  });

  it.each([
    [0.01659, 0.0166, 25_000, 0.005],
    [63.15789, 63.1579, 100_000, 0.5],
  ])('%d BTC: Hyperliquid reports less in the last slice, so the last order is the smaller live size', async (hl, gate, sliceUsd, less) => {
    const { job, engine, live } = await wholeRun({ hl, gate, sliceUsd, exec: 'market', added: -less });
    expect(requested(engine, HL_ETH)).toBeCloseTo(hl - less, 9);
    expect(live.hl()).toBeCloseTo(0, 9);
    expect(live.gate()).toBeCloseTo(0, 9);
    expect(job).toMatchObject({ status: 'done', borosLeftYu: 0 });
    expect(job?.openGaps ?? []).toHaveLength(0);
  });

  it.each([
    [0.01659, 0.0166, 25_000, 0.01],
    [63.15789, 63.1579, 100_000, 1],
  ])('%d BTC: Hyperliquid reports more in the last slice, so the last order stays at the planned whole size', async (hl, gate, sliceUsd, added) => {
    const { job, engine, live } = await wholeRun({ hl, gate, sliceUsd, exec: 'market', added });
    expect(requested(engine, HL_ETH)).toBeCloseTo(hl, 9);
    expect(live.hl()).toBeCloseTo(added, 9);
    expect(live.gate()).toBeCloseTo(0, 9);
    expect(job).toMatchObject({ status: 'done', borosLeftYu: 0 });
  });

  const LEAD_BIGGER = [
    ['Gate leads', 0.01659, 0.0166, 25_000, 1],
    ['Gate leads', 63.15789, 63.1579, 100_000, 1],
    ['Hyperliquid leads and is bigger', 0.01669, 0.0166, 25_000, 0],
    ['Hyperliquid leads and is bigger', 63.15799, 63.1579, 100_000, 0],
  ] as const;

  it.each(LEAD_BIGGER)('%s on %d BTC Hyperliquid and %d BTC Gate: both end flat with nothing left not hedged', async (_name, hl, gate, sliceUsd, makerLeg) => {
    for (const exec of ['maker', 'market'] as const) {
      const { h, job, engine, live } = await wholeRun({ hl, gate, sliceUsd, exec, makerLeg });
      expect(job).toMatchObject({ status: 'done', haltReason: null, borosLeftYu: 0 });
      expect(h.onHalt).not.toHaveBeenCalled();
      expect(job?.openGaps ?? []).toHaveLength(0);
      expect(live.hl()).toBeCloseTo(0, 9);
      expect(live.gate()).toBeCloseTo(0, 9);
      expect(requested(engine, HL_ETH)).toBeCloseTo(hl, 9);
      expect(requested(engine, GATE_ETH)).toBeCloseTo(gate, 9);
    }
  });

  const SWEEP_REFUSALS = [
    ['the engine', 0.01659, 0.0166, 25_000, { refuse: new CoreError(`Size 0.00009 is below ${HL_ETH}'s minimum order value (10 at ~95000). Increase the size.`) }],
    ['the engine', 63.15789, 63.1579, 100_000, { refuse: new CoreError(`Size 0.00009 is below ${HL_ETH}'s minimum order value (10 at ~95000). Increase the size.`) }],
    ['Gate', 0.01659, 0.0166, 25_000, { a: '0', reason: 'rejected:TRADE_ORDER_QUANTITY_MIN_ERROR' }],
    ['Gate', 63.15789, 63.1579, 100_000, { a: '0', reason: 'rejected:TRADE_ORDER_QUANTITY_MIN_ERROR' }],
  ] as const;

  it.each(SWEEP_REFUSALS)('%s refuses the follow sweep as too small on %d BTC Hyperliquid: the rest is a gap and the job ends done', async (_by, hl, gate, sliceUsd, refusal) => {
    const script = (req: DealRequest): ChildOutcome => (req.b === null && req.a.symbol === HL_ETH ? refusal : {});
    const { h, job, engine, live } = await wholeRun({ hl, gate, sliceUsd, exec: 'market', makerLeg: 1, script });
    expect(job).toMatchObject({ status: 'done', haltReason: null, borosLeftYu: 0 });
    expect(h.onHalt).not.toHaveBeenCalled();
    expect(job?.steps.every((step) => step.status === 'done')).toBe(true);
    expect(engine.requests.filter((req) => req.b === null && req.a.symbol === HL_ETH)).toHaveLength(1);
    expect(job?.openGaps).toHaveLength(1);
    expect(job?.openGaps?.[0]).toMatchObject({ leg: { symbol: GATE_ETH, side: 'SHORT' }, hedges: [{ symbol: HL_ETH, side: 'LONG', qty: hl }] });
    expect(job?.openGaps?.[0].qty).toBeCloseTo(live.hl(), 9);
    expect(live.gate()).toBeCloseTo(0, 9);
    expect(live.hl()).toBeCloseTo(0.00009, 9);
  });

  it('a sweep refusal that is not about size still halts', async () => {
    const script = (req: DealRequest): ChildOutcome => (req.b === null && req.a.symbol === HL_ETH ? { refuse: new CoreError('Gate refused the order', 'venue-rejected') } : {});
    const { h, job } = await wholeRun({ hl: 0.01659, gate: 0.0166, sliceUsd: 25_000, exec: 'market', makerLeg: 1, script });
    expect(job).toMatchObject({ status: 'halted', haltReason: 'Gate refused the order' });
    expect(h.onHalt).toHaveBeenCalled();
    expect(job?.openGaps ?? []).toHaveLength(0);
  });

  it.each(LEAD_BIGGER)('%s on %d BTC Hyperliquid and %d BTC Gate: a Boros halt after the perps offers no perp hold', async (_name, hl, gate, sliceUsd, makerLeg) => {
    vi.mocked(closeBorosLegs).mockImplementationOnce(async () => {
      throw new Error('Boros gave no answer');
    });
    const { job, live } = await wholeRun({ hl, gate, sliceUsd, exec: 'market', makerLeg });
    expect(job).toMatchObject({ status: 'halted', haltKind: 'boros' });
    expect(job?.openGaps ?? []).toHaveLength(0);
    expect(live.hl()).toBeCloseTo(0, 9);
    expect(live.gate()).toBeCloseTo(0, 9);
  });
});

type ChildOutcome = { a?: string; b?: string; mode?: PairMode; haltKind?: 'hedge-margin' | null; refuse?: unknown; reason?: string; kind?: 'maker' | 'taker' };

function childEngine(h: ReturnType<typeof sliceRun>, script: (req: DealRequest, index: number) => ChildOutcome = () => ({})) {
  const store = new Store(':memory:');
  const requests: DealRequest[] = [];
  const modes: string[] = [];
  const settle = (id: string, out: ChildOutcome): void => {
    const pair = store.getPair(id) as PairRow;
    const a = out.a ?? pair.targetQty;
    const orderA = store.insertPendingOrder({ pairId: id, leg: 'A', kind: out.kind ?? 'taker', side: pair.a.side, qty: pair.targetQty, price: null, tif: 'ioc', now: h.clock.now() });
    store.updateOrder(id, 'A', orderA.seq, { state: out.reason ? 'DEAD' : 'CLOSED', cumQty: a, avgFillPrice: a === '0' ? '0' : '3000', resolvedAt: h.clock.now(), ...(out.reason ? { closeReason: out.reason } : {}) });
    if (pair.b) {
      const b = out.b ?? a;
      const orderB = store.insertPendingOrder({ pairId: id, leg: 'B', kind: 'taker', side: pair.b.side, qty: b, price: null, tif: 'ioc', now: h.clock.now() });
      store.updateOrder(id, 'B', orderB.seq, { state: 'CLOSED', cumQty: b, avgFillPrice: b === '0' ? '0' : '3000', resolvedAt: h.clock.now() });
    }
    store.updatePair(id, { mode: out.mode ?? 'DONE', haltKind: out.haltKind ?? null });
  };
  const hedgeAll = (pair: PairRow): void => {
    const proj = project(pair, store.listOrders(pair.id));
    const gap = Number(proj.aFilled) - Number(proj.bFilled);
    if (pair.b && gap > 0) {
      const order = store.insertPendingOrder({ pairId: pair.id, leg: 'B', kind: 'taker', side: pair.b.side, qty: String(gap), price: null, tif: 'ioc', now: h.clock.now() });
      store.updateOrder(pair.id, 'B', order.seq, { state: 'CLOSED', cumQty: String(gap), avgFillPrice: '3000', resolvedAt: h.clock.now() });
    }
    store.updatePair(pair.id, { mode: 'DONE' });
  };
  const sleep = h.deps.sleep;
  Object.assign(h.deps, {
    sleep: async (ms: number) => {
      await sleep(ms);
      for (const pair of store.listPairs()) {
        if (pair.mode !== 'STOPPING') continue;
        modes.push(`${pair.id}:STOPPING`);
        hedgeAll(pair);
      }
    },
  });
  const twap: TwapRunDeps = {
    store,
    engineWake: () => undefined,
    now: h.clock.now,
    jobs: h.jobs,
    readFees: async () => ({}),
    createChild: async (req) => {
      if (store.getPair(req.id)) return;
      const out = script(req, requests.length);
      requests.push(req);
      if (out.refuse) throw out.refuse;
      const spec = (leg: { symbol: string; side: 'BUY' | 'SELL'; reduceOnly?: boolean }) => ({
        contract: leg.symbol,
        side: leg.side,
        lot: '0.0001',
        minSize: '0.0001',
        minNotional: '0',
        tick: '0.1',
        ...(leg.reduceOnly ? { reduceOnly: true } : {}),
      });
      store.createPair({
        id: req.id,
        mode: 'OPENING',
        a: spec(req.a),
        b: req.b ? spec(req.b) : null,
        targetQty: req.qty,
        limitPrice: '3000',
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
        createdAt: h.clock.now(),
      });
      settle(req.id, out);
    },
  };
  Object.assign(h.deps, { twap });
  return { store, requests, modes };
}

function liveJobOf(h: ReturnType<typeof sliceRun>): () => Job {
  const read = h.jobs.read.bind(h.jobs);
  let live: Job | null = null;
  h.jobs.read = () => (live ??= read());
  return () => live as Job;
}

describe('slices on engine children', () => {
  beforeEach(() => {
    vi.mocked(closeBorosLegs).mockReset();
  });
  const borosAt = (h: ReturnType<typeof sliceRun>, collateralUsd = 3000) =>
    Object.assign(h.deps, { boros: { deps: {} as BorosCloseDeps, address: '0x00000000000000000000000000000000000000a1', collateralUsd: async () => collateralUsd } });
  const borosSizes = (): number[] => borosSpy.calls.map((call) => (call.input as BorosCloseInput).legs[0].size);
  const whole = (lead: { symbol: string; side: 'LONG' | 'SHORT'; qty: number }, follow: { symbol: string; side: 'LONG' | 'SHORT'; qty: number }, yu: number): DeleverJobInput => ({
    makerLeg: 0,
    legs: [lead, follow].map((leg) => ({ symbol: leg.symbol, exchange: leg.symbol.split('_')[0], base: 'ETH', side: leg.side, before: leg.qty, after: 0, closeQty: leg.qty, closeAll: true })),
    boros: [{ marketId: 7, before: yu, after: 0, closeSize: yu }],
  });
  const held = (venue: ReturnType<typeof sliceVenue>, rows: [string, number][]) => {
    venue.handlers.listCrossexPositions = seq({ body: rows.map(([symbol, qty]) => ({ symbol, positionQty: String(qty), initialMargin: '100', entryPrice: '2900' })) });
  };
  const deleverRun = (input: DeleverJobInput, rows: [string, number][], slices: number | null, script?: (req: DealRequest, index: number) => ChildOutcome, collateralUsd = 3000) => {
    borosSpy.calls.length = 0;
    const venue = sliceVenue();
    held(venue, rows);
    const h = sliceRun(venue, {
      delever: input,
      sliceUsd: 7_500,
      edit: (job) => {
        job.deleverTwap = slices === null ? null : { durationSec: slices * 60, intervalSec: 60, slices };
      },
    });
    borosAt(h, collateralUsd);
    return { h, engine: childEngine(h, script) };
  };

  it('a coin-collateral boros share counts each YU at the coin price', async () => {
    const seen: number[] = [];
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, (_req, index) => {
      seen.push(borosSpy.calls.length);
      return index === 0 ? { a: '0.0002', b: '0.0002' } : {};
    }, 90_000);
    await run.h.run();
    expect(seen).toEqual([0, 1]);
    expect(borosSizes()[0]).toBeCloseTo(0.0002, 9);
  });

  it('a USD-collateral boros share counts each YU as one dollar', async () => {
    const seen: number[] = [];
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, () => {
      seen.push(borosSpy.calls.length);
      return {};
    }, 1);
    await run.h.run();
    expect(seen).toEqual([0, 0]);
    expect(borosSizes()).toEqual([7.5]);
  });

  it('twap closes boros after each slice', async () => {
    const seen: number[] = [];
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, () => {
      seen.push(borosSpy.calls.length);
      return {};
    });
    await run.h.run();
    expect(run.engine.requests.map((req) => req.qty)).toEqual(['3.75', '3.75']);
    expect(seen).toEqual([0, 1]);
    expect(borosSizes()).toEqual([3.75, 3.75]);
    expect(run.h.jobs.read()).toMatchObject({ status: 'done' });
  });

  it.each([
    [0.02, { takerAfterSec: 40, repegBehindBp: 2 as const }, { timeoutSec: 40, repegBehindBp: 2 }],
    [2_000, { takerAfterSec: null, repegBehindBp: null }, { timeoutSec: null, repegBehindBp: null }],
    [2_000, {}, { timeoutSec: 48 }],
  ])('a TWAP slice of %d ETH sends the taker-after and re-peg the run was started with', async (q, picked, sent) => {
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: q }, { symbol: GATE_ETH, side: 'LONG', qty: q }, q), [[HL_ETH, -q], [GATE_ETH, q]], 2);
    const job = run.h.jobs.read()!;
    job.deleverTwap = { ...job.deleverTwap!, ...picked };
    run.h.jobs.write(job);
    await run.h.run();
    expect(run.engine.requests).toHaveLength(2);
    for (const req of run.engine.requests) {
      expect(req).toMatchObject({ execution: 'maker', deadlineCapSec: 48, ...sent });
      if (!('repegBehindBp' in sent)) expect(req.repegBehindBp).toBeUndefined();
    }
  });

  it("boros share follows the smaller leg's fill", async () => {
    const run = deleverRun(whole({ symbol: GATE_ETH, side: 'LONG', qty: 4.4 }, { symbol: HL_ETH, side: 'SHORT', qty: 4.03 }, 4.03), [[GATE_ETH, 4.4], [HL_ETH, -4.03]], 11, (_req, index) => (index === 0 ? { a: '0.37', b: '0.37' } : {}));
    await run.h.run();
    expect(borosSizes()[0]).toBeCloseTo(0.37, 9);
    const last = run.engine.requests.at(-1) as DealRequest;
    expect(last).toMatchObject({ a: { symbol: GATE_ETH, side: 'SELL', reduceOnly: true }, b: null, qty: '0.37', execution: 'taker' });
    expect(run.h.jobs.read()?.delever?.boros[0].closed).toBeCloseTo(4.03, 9);
  });

  it('small boros share waits', async () => {
    const seen: number[] = [];
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, (_req, index) => {
      seen.push(borosSpy.calls.length);
      return index === 0 ? { a: '0.002', b: '0.002' } : {};
    });
    await run.h.run();
    expect(seen).toEqual([0, 0]);
    expect(borosSizes()).toEqual([7.5]);
  });

  it('last slice closes the whole boros share', async () => {
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, (_req, index) => (index === 0 ? { a: '3.748', b: '3.748' } : {}));
    await run.h.run();
    const sizes = borosSizes();
    expect(sizes).toHaveLength(2);
    expect(sizes[0]).toBeCloseTo(3.748, 9);
    expect(sizes[1]).toBeCloseTo(3.752, 9);
    const twoSlices = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, (req, index) => (index === 1 ? { a: '0.002', b: '0.002', mode: 'DONE' } : { a: String(Number(req.qty) * 2 - 0.002), b: String(Number(req.qty) * 2 - 0.002) }));
    await twoSlices.h.run();
    const tail = borosSizes();
    expect(tail).toHaveLength(2);
    expect(tail[1]).toBeCloseTo(0.002, 9);
    expect(twoSlices.h.jobs.read()).toMatchObject({ status: 'done', borosLeftYu: 0 });
  });

  it('boros refusal mid-run halts', async () => {
    vi.mocked(closeBorosLegs).mockRejectedValueOnce(new Error('Boros refused the close'));
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2);
    await run.h.run();
    expect(run.engine.requests).toHaveLength(1);
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'boros', borosLeftYu: 3.75 });
  });

  const borosChain = (yu: number, first: 'lost' | 'part') => {
    const chain = { held: yu, sends: [] as number[] };
    vi.mocked(closeBorosLegs).mockImplementation(async (_deps, input) => {
      borosSpy.calls.push({ input, gateCalls: 0 });
      const leg = input.legs[0];
      const before = chain.held;
      const size = Math.min(leg.size, Math.max(0, before - (leg.keep ?? 0)));
      const isFirst = chain.sends.length === 0;
      const filled = isFirst && first === 'part' ? size * 0.6 : size;
      if (size > 0) {
        input.onSend?.();
        chain.sends.push(filled);
        chain.held = before - filled;
        if (isFirst && first === 'lost') throw new CoreError(`Boros timed out${MAY_HAVE_FILLED}`, 'network');
      }
      return { filled: [{ marketId: leg.marketId, size: filled }], rest: [{ marketId: leg.marketId, size: size - filled }], held: [{ marketId: leg.marketId, size: before }] };
    });
    return chain;
  };
  const twoSliceRun = (q: number) => deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: q }, { symbol: GATE_ETH, side: 'LONG', qty: q }, q), [[HL_ETH, -q], [GATE_ETH, q]], 2);
  const expectAllClosedOnce = (run: ReturnType<typeof twoSliceRun>, chain: ReturnType<typeof borosChain>, q: number) => {
    expect(chain.sends).toHaveLength(2);
    expect(Math.abs(chain.sends.reduce((sum, size) => sum + size, 0) - q)).toBeLessThanOrEqual(q * 1e-12);
    expect(chain.held).toBeLessThanOrEqual(q * 1e-12);
    expect(run.engine.requests).toHaveLength(2);
    expect(run.h.jobs.read()).toMatchObject({ status: 'done', borosLeftYu: 0, delever: { boros: [{ sent: null }] } });
    expect(Math.abs((run.h.jobs.read()?.delever?.boros[0].closed ?? 0) - q)).toBeLessThanOrEqual(q * 1e-12);
  };

  it.each([0.0166, 2_000])('a Boros close is not sent twice after a resume mid-run, %d ETH', async (q) => {
    const chain = borosChain(q, 'lost');
    const run = twoSliceRun(q);
    await run.h.run();
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'boros' });
    expect(run.h.jobs.read()?.delever?.boros[0].sent?.size).toBeCloseTo(q / 2, 9);

    await run.h.clock.sleep(BOROS_LATE_SEND_MS - 60_000);
    await run.h.resume();
    expect(chain.sends).toHaveLength(1);
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'boros', haltReason: borosWaitText(60_000) });

    await run.h.clock.sleep(60_000);
    await run.h.resume();
    expectAllClosedOnce(run, chain, q);
  });

  it.each([0.0166, 2_000])('a Boros close finds its order after a restart mid-run, no second close, %d ETH', async (q) => {
    const chain = borosChain(q, 'lost');
    const run = twoSliceRun(q);
    await run.h.run();
    const crashed = run.h.jobs.read()!;
    Object.assign(crashed, { status: 'running', haltReason: null, haltKind: null });
    run.h.jobs.write(crashed);
    await cancelRestingLead(run.h.deps, run.h.jobs.read()!);
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'restart' });

    await run.h.resume();
    expect(chain.sends).toHaveLength(1);
    const sentAt = run.h.jobs.read()?.delever?.boros[0].sent?.sentAt ?? 0;
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'boros', haltReason: borosWaitText(sentAt + BOROS_LATE_SEND_MS - run.h.clock.now()) });

    await run.h.clock.sleep(BOROS_LATE_SEND_MS);
    await run.h.resume();
    expectAllClosedOnce(run, chain, q);
  });

  it.each([0.0166, 2_000])('a Boros close that part-fills mid-run carries the rest and the last slice closes all, %d ETH', async (q) => {
    const chain = borosChain(q, 'part');
    const run = twoSliceRun(q);
    await run.h.run();
    expect(Math.abs(chain.sends[0] - (q / 2) * 0.6)).toBeLessThanOrEqual(q * 1e-12);
    expect(run.engine.requests).toHaveLength(1);
    for (let i = 0; i < 3 && run.h.jobs.read()?.status === 'halted'; i += 1) {
      expect(run.h.jobs.read()).toMatchObject({ haltKind: 'boros' });
      await run.h.resume();
    }
    expect(Math.abs(chain.sends.reduce((sum, size) => sum + size, 0) - q)).toBeLessThanOrEqual(q * 1e-12);
    expect(chain.held).toBeLessThanOrEqual(q * 1e-12);
    expect(run.engine.requests).toHaveLength(2);
    expect(run.h.jobs.read()).toMatchObject({ status: 'done', borosLeftYu: 0 });
    expect(Math.abs((run.h.jobs.read()?.delever?.boros[0].closed ?? 0) - q)).toBeLessThanOrEqual(q * 1e-12);
  });

  it('twap off closes boros once', async () => {
    const seen: number[] = [];
    const input: DeleverJobInput = {
      makerLeg: 0,
      legs: [
        { symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', before: 10, after: 5, closeQty: 5 },
        { symbol: GATE_ETH, exchange: 'GATE', base: 'ETH', side: 'LONG', before: 10, after: 5, closeQty: 5 },
      ],
      boros: [{ marketId: 7, before: 100, after: 50, closeSize: 50 }],
    };
    const run = deleverRun(input, [[HL_ETH, -10], [GATE_ETH, 10]], null, () => {
      seen.push(borosSpy.calls.length);
      return {};
    });
    await run.h.run();
    expect(run.engine.requests.map((req) => req.qty)).toEqual(['2.5', '2.5']);
    expect(seen).toEqual([0, 0]);
    expect(borosSizes()).toEqual([50]);
  });

  it('delever twap pauses at once', async () => {
    let live: () => Job = () => ({}) as Job;
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2, () => {
      live().pauseRequested = true;
      return { a: '1', b: '0.5', mode: 'OPENING' };
    });
    live = liveJobOf(run.h);
    await run.h.run();
    expect(run.engine.modes).toEqual([`${run.engine.requests[0].id}:STOPPING`]);
    expect(run.engine.requests).toHaveLength(1);
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', paused: true, pauseRequested: false });
    expect(borosSizes()).toEqual([1]);
  });

  it('follow is a market order', async () => {
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2);
    await run.h.run();
    const first = run.engine.requests[0];
    expect(first).toMatchObject({ id: `${run.h.job.id}-s1-1`, a: { symbol: HL_ETH, side: 'BUY', reduceOnly: true }, b: { symbol: GATE_ETH, side: 'SELL', reduceOnly: true }, qty: '3.75' });
    expect(first.price).toBeUndefined();
    expect(first.clipBandPct).toBeUndefined();
  });

  it('realize reopen retries after convert', async () => {
    const venue = sliceVenue(filled, account({ hyperliquid: 1_000 }));
    venue.handlers.listCrossexPositions = seq({ body: [{ symbol: HL_ETH, positionQty: '-10', initialMargin: '2000', entryPrice: '3100' }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 30_000 });
    const engine = childEngine(h, (_req, index) => (index === 0 ? { a: '10', b: '0', mode: 'HALTED', haltKind: 'hedge-margin' } : {}));
    await h.run();
    const job = h.jobs.read() as Job;
    expect(job.retryConverts).toBe(1);
    expect(h.sent('createCrossexConvertOrder').length).toBeGreaterThan(0);
    expect(engine.modes).toEqual([`${engine.requests[0].id}:STOPPING`]);
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('DONE');
    expect(RETRY_CONVERT_CAP).toBe(3);
  });
  it('a sleep halt in the middle of a pass starts no new child', async () => {
    const run = deleverRun(whole({ symbol: HL_ETH, side: 'SHORT', qty: 7.5 }, { symbol: GATE_ETH, side: 'LONG', qty: 7.5 }, 7.5), [[HL_ETH, -7.5], [GATE_ETH, 7.5]], 2);
    const live = liveJobOf(run.h);
    Object.assign((run.h.deps as unknown as { twap: TwapRunDeps }).twap, {
      readFees: async () => {
        Object.assign(live(), { status: 'halted', haltKind: 'sleep' });
        return {};
      },
    });
    await run.h.run();
    expect(run.engine.requests).toHaveLength(1);
    expect(run.h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'sleep' });
  });
  it('a realize slice child closes reduce-only and reopens the same contract on the other side', async () => {
    const h = sliceRun(sliceVenue(), { exec: 'market' });
    const engine = childEngine(h);
    await h.run();
    const first = engine.requests[0];
    expect(first).toMatchObject({ a: { symbol: HL_ETH, side: 'BUY', reduceOnly: true }, b: { symbol: HL_ETH, side: 'SELL' }, execution: 'taker' });
    expect(first.b?.reduceOnly).toBeFalsy();
    expect(h.jobs.read()?.status).toBe('done');
  });
});

describe('realize slices: a child found again after a restart', () => {
  const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
  const MID = 3000;
  const lotted = (value: number): number => Math.floor(value / 0.0001 + 1e-9) * 0.0001;
  const first0 = (usd: number): number => Number(lotted(lotted(usd / MID) / 2).toFixed(4));

  const restarted = async (usd: number, firstOut: ChildOutcome) => {
    const total = Number(lotted(usd / MID).toFixed(4));
    const first = Number(lotted(total / 2).toFixed(4));
    const h = sliceRun(sliceVenue(), { exec: 'market', sliceUsd: usd / 2, leg: { qty: total, positionQty: total * 2 } });
    const posted: string[] = [];
    const engine = childEngine(h, (_req, index) => (index === 0 ? firstOut : {}));
    const twap = (h.deps as unknown as { twap: TwapRunDeps }).twap;
    const create = twap.createChild;
    twap.createChild = async (req) => {
      posted.push(req.id);
      return create(req);
    };
    const job = h.jobs.read()!;
    const id = `${job.id}-s1-1`;
    await twap.createChild({ id, a: { symbol: HL_ETH, side: 'BUY', reduceOnly: true }, b: { symbol: HL_ETH, side: 'SELL' }, qty: String(first), execution: 'taker' } as DealRequest);
    job.steps[0].lead = { text: id, venueId: null, sentAt: h.clock.now(), credited: 0, poc: false, price: null };
    job.steps[0].cut = { qty: first, from: 0, at: h.clock.now(), ioc: true };
    job.slice = { index: 1, count: 2, sizeUsd: usd / 2 };
    h.jobs.write(job);
    posted.length = 0;
    return { h, engine, id, total, first, posted };
  };

  it.each(RUNGS)('a Realize slice posted twice makes one reopen, at $%d', async (usd) => {
    const { h, engine, id, total, first, posted } = await restarted(usd, {});
    await h.resume();
    expect(posted).not.toContain(id);
    expect(posted.filter((sent) => sent === id.replace('-s1-1', '-s2-1'))).toHaveLength(1);
    expect(engine.store.listPairs().map((pair) => pair.id).sort()).toEqual([id, id.replace('-s1-1', '-s2-1')]);
    expect(Number(engine.requests.at(-1)?.qty)).toBeCloseTo(total - first, 4);
    expect(h.jobs.read()?.realize?.legs[0].filledQty).toBeCloseTo(total, 4);
    expect(h.jobs.read()?.status).toBe('done');
  });

  it.each(RUNGS)('a Realize reopen finds its resting close by tag after a restart, at $%d', async (usd) => {
    const { h, engine, id, posted } = await restarted(usd, { a: String(Number((first0(usd) * 0.6).toFixed(8))), b: '0', mode: 'OPENING' });
    const closesBefore = engine.store.listOrders(id).filter((order) => order.leg === 'A').length;
    await cancelRestingLead(h.deps, h.jobs.read()!);
    expect(engine.store.getPair(id)?.mode).toBe('STOPPING');
    await h.resume();
    expect(posted).not.toContain(id);
    expect(engine.store.listOrders(id).filter((order) => order.leg === 'A')).toHaveLength(closesBefore);
    expect(engine.modes).toContain(`${id}:STOPPING`);
    expect(engine.store.getPair(id)?.mode).toBe('DONE');
  });

  it.each(RUNGS)('a part-filled resting close cancels then reopens only the filled size, at $%d', async (usd) => {
    const part = Number((first0(usd) * 0.6).toFixed(8));
    const { h, engine, id, total } = await restarted(usd, { a: String(part), b: '0', mode: 'OPENING' });
    await cancelRestingLead(h.deps, h.jobs.read()!);
    await h.resume();
    const hedged = engine.store.listOrders(id).filter((order) => order.leg === 'B').reduce((sum, order) => sum + Number(order.cumQty), 0);
    expect(hedged).toBeCloseTo(part, 8);
    const later = engine.requests.slice(1).reduce((sum, req) => sum + Number(req.qty), 0);
    expect(later).toBeCloseTo(total - part, 4);
    expect(h.jobs.read()?.realize?.legs[0].filledQty).toBeCloseTo(total, 4);
    expect(h.jobs.read()?.status).toBe('done');
  });
});

describe('realize slices: guards before a close', () => {
  const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
  const MID = 3000;
  const DELISTED = { delistTime: '1764000000' };
  const lotted = (value: number): number => Number((Math.floor(value / 0.0001 + 1e-9) * 0.0001).toFixed(4));
  const ruleRows = (hl: Record<string, string>) => ({
    body: [HL_ETH, GATE_ETH].map((symbol) => ({ symbol, state: 'live', lotSize: '0.0001', minSize: '0.0001', tickSize: '0.1', businessType: 'FUTURE', ...(symbol === HL_ETH ? hl : {}) })),
  });
  const realizeAt = (usd: number, venue: ReturnType<typeof sliceVenue>, leg: Partial<RealizeLeg> = {}) => {
    const total = lotted(usd / MID);
    const h = sliceRun(venue, { exec: 'market', sliceUsd: usd / 2, leg: { qty: total, positionQty: total * 2, ...leg } });
    return { h, total };
  };
  const CONVERTS: [number, number][] = [
    [50, 11.37],
    [5_000, 1_000.01],
    [100_000, 20_000.03],
    [1_000_000, 200_000.07],
    [6_000_000, 1_200_000.07],
  ];
  const withConvert = (amount: number): Partial<RealizeLeg> => ({ convert: { amount, count: chunkCount(amount), feeUsd: 0 } });
  const firstConvertPlanned = (h: ReturnType<typeof sliceRun>): number =>
    h.jobs.read()!.steps.find((step) => step.name.startsWith('Convert'))?.planned ?? 0;

  it.each(RUNGS.flatMap((usd) => [[usd, 'a delist time', DELISTED], [usd, 'a state not live', { state: 'delisting' }]] as const))(
    'a $%d Realize on a contract with %s halts before any close',
    async (usd, _why, rule) => {
      const venue = sliceVenue();
      venue.handlers.listCrossexRuleSymbols = async () => ruleRows(rule);
      const { h } = realizeAt(usd, venue);
      const engine = childEngine(h);
      await h.run();
      const job = h.jobs.read()!;
      expect(engine.requests).toHaveLength(0);
      expect(venue.placed).toHaveLength(0);
      expect(job.realize?.legs[0].filledQty).toBe(0);
      expect(job).toMatchObject({ status: 'halted', haltKind: 'other' });
      expect(job.haltReason).toContain('Gate CrossEx takes no new orders on this contract.');
    },
  );

  it.each(RUNGS)('a delist between two $%d Realize slices halts before the next close with the leg whole', async (usd) => {
    let delisted = false;
    const venue = sliceVenue();
    venue.handlers.listCrossexRuleSymbols = async () => ruleRows(delisted ? DELISTED : {});
    const { h, total } = realizeAt(usd, venue);
    const engine = childEngine(h, () => {
      delisted = true;
      return {};
    });
    await h.run();
    const job = h.jobs.read()!;
    const first = Number(engine.requests[0]?.qty);
    expect(engine.requests).toHaveLength(1);
    expect(first).toBeLessThan(total);
    expect(job.realize?.legs[0].filledQty).toBeCloseTo(first, 8);
    expect(job.steps[0].qty).toBeCloseTo(first, 8);
    expect(job).toMatchObject({ status: 'halted', haltKind: 'other' });
  });

  it.each(CONVERTS)('a $%d Realize checks one quote of its first Convert of %d before the first close and never sends it', async (usd, amount) => {
    const venue = sliceVenue(filled, account({ hyperliquid: amount }));
    const { h } = realizeAt(usd, venue, withConvert(amount));
    const planned = firstConvertPlanned(h);
    const seen: [number, number][] = [];
    childEngine(h, (_req, index) => {
      if (index === 0) seen.push([h.count('createCrossexConvertQuote'), h.count('createCrossexConvertOrder')]);
      return {};
    });
    await h.run();
    expect(seen).toEqual([[1, 0]]);
    expect(Number(h.sent('createCrossexConvertQuote')[0].crossexConvertQuoteRequest.fromAmount)).toBeCloseTo(Math.min(planned, amount), 2);
  });

  it.each(CONVERTS)('a $%d Realize with the cash for its %d Convert not yet in the wallet closes without a check quote', async (usd, amount) => {
    const venue = sliceVenue(filled, account({ hyperliquid: 10 }));
    const { h } = realizeAt(usd, venue, withConvert(amount));
    const seen: number[] = [];
    const engine = childEngine(h, (_req, index) => {
      if (index === 0) seen.push(h.count('createCrossexConvertQuote'));
      return {};
    });
    await h.run();
    expect(seen).toEqual([0]);
    expect(engine.requests.length).toBeGreaterThan(0);
  });

  it.each(CONVERTS)("a $%d Realize with the day's Convert quotes used halts before any close, after one wait (Convert %d)", async (usd, amount) => {
    const venue = sliceVenue(filled, account({ hyperliquid: amount }));
    venue.handlers.createCrossexConvertQuote = seq(gateError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests'));
    const { h } = realizeAt(usd, venue, withConvert(amount));
    const engine = childEngine(h);
    const start = h.clock.now();
    await h.run();
    expect(engine.requests).toHaveLength(0);
    expect(venue.placed).toHaveLength(0);
    expect(h.count('createCrossexConvertQuote')).toBe(2);
    expect(h.clock.now() - start).toBeGreaterThanOrEqual(QUOTE_RECHECK_MS);
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'other', haltReason: HALT_TEXT.quotesUsed });
  });

  it.each(RUNGS)('a $%d Realize with no Convert asks Gate for no quote', async (usd) => {
    const venue = sliceVenue();
    const { h } = realizeAt(usd, venue);
    childEngine(h);
    await h.run();
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.jobs.read()?.status).toBe('done');
  });
});

function refuseReopens(h: ReturnType<typeof sliceRun>, engine: ReturnType<typeof childEngine>, refusing: () => boolean) {
  const tick = h.clock.sleep;
  Object.assign(h.deps, {
    sleep: async (ms: number) => {
      await tick(ms);
      for (const pair of engine.store.listPairs()) {
        if (pair.mode !== 'STOPPING' || !pair.b) continue;
        const proj = project(pair, engine.store.listOrders(pair.id));
        const gap = Number(proj.aFilled) - Number(proj.bFilled);
        if (!(gap > 0)) {
          engine.store.updatePair(pair.id, { mode: 'DONE' });
          continue;
        }
        const order = engine.store.insertPendingOrder({ pairId: pair.id, leg: 'B', kind: 'taker', side: pair.b.side, qty: String(gap), price: null, tif: 'ioc', now: h.clock.now() });
        if (refusing()) {
          engine.store.updateOrder(pair.id, 'B', order.seq, { state: 'DEAD', cumQty: '0', avgFillPrice: '0', resolvedAt: h.clock.now(), closeReason: 'rejected:INSUFFICIENT_MARGIN' });
          engine.store.updatePair(pair.id, { hedgeRejectStreak: pair.hedgeRejectStreak + 1 });
        } else {
          engine.store.updateOrder(pair.id, 'B', order.seq, { state: 'CLOSED', cumQty: String(gap), avgFillPrice: '3000', resolvedAt: h.clock.now() });
          engine.store.updatePair(pair.id, { mode: 'DONE' });
        }
      }
    },
  });
}

const marginRefusal = () => new CoreError('Not enough free margin', 'insufficient-margin');

describe('slices: a reopen Gate keeps refusing after a retry Convert', () => {
  const refusedRun = (stillRefusing: (h: ReturnType<typeof sliceRun>) => boolean) => {
    const h = sliceRun(sliceVenue(filled, account({ hyperliquid: 1_000 })), { exec: 'market', sliceUsd: 3_000, leg: { qty: 1 } });
    const engine = childEngine(h, (req, index) => (index === 0 ? hedgeRefused(req) : {}));
    refuseReopens(h, engine, () => stillRefusing(h));
    return { h, engine };
  };

  it('gets the next retry Convert each time, then halts not hedged at the cap', async () => {
    const { h, engine } = refusedRun(() => true);
    await h.run();
    const job = h.jobs.read()!;
    expect(h.count('createCrossexConvertOrder')).toBe(RETRY_CONVERT_CAP);
    expect(job).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.convertCap, haltKind: 'margin', retryConverts: RETRY_CONVERT_CAP, notHedgedQty: 1 });
    expect(job.follow).toEqual({ symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SELL', qty: 1, reduceOnly: false });
    expect(engine.requests).toHaveLength(1);
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
  });

  it('the unwind hold refuses before holding anything when the pair has no other perp', async () => {
    const { h, engine } = refusedRun(() => true);
    await h.run();
    await expect(applyFix(h.deps, h.jobs.read()!, 'unwind')).rejects.toThrow(REOPEN_HALT.noHedgePerp);
    expect(engine.requests).toHaveLength(1);
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
    expect(engine.store.getPair(engine.requests[0].id)?.hedgeNotBefore).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  it('the retry-reopen hold re-halts on a refusal instead of hanging', async () => {
    const { h, engine } = refusedRun(() => true);
    await h.run();
    await expect(applyFix(h.deps, h.jobs.read()!, 'market')).rejects.toThrow(REOPEN_HALT.noCash);
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
    expect(h.jobs.read()).toMatchObject({ status: 'halted', notHedgedQty: 1 });
  });

  it('ends done once a later retry Convert frees enough margin', async () => {
    const { h } = refusedRun((run) => run.count('createCrossexConvertOrder') < 2);
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'done', retryConverts: 2, notHedgedQty: 0 });
  });
});

describe('slices: margin top-up before a slice', () => {
  const OPEN_IM_PER_COIN = 120;
  const toppedUp = (usd: number, refusals: number) => {
    const qty = Number((usd / 3000).toFixed(4));
    const venue = sliceVenue(filled, account({ hyperliquid: 2 * usd + 100, availableMargin: 0 }));
    venue.handlers.listCrossexPositions = seq({ body: [{ symbol: HL_ETH, positionQty: String(-2 * qty), initialMargin: String(2 * qty * OPEN_IM_PER_COIN) }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: Math.min(usd, 100_000), leg: { qty, positionQty: 2 * qty } });
    const engine = childEngine(h, (_req, index) => (index < refusals ? { refuse: marginRefusal() } : {}));
    return { h, engine, qty };
  };
  const expectedTopUp = (tried: number, rest: number): number => {
    const need = tried * (OPEN_IM_PER_COIN * 0.05 + 2 * 3000 * 0.001);
    const drain = (rest * 3000 * 10) / 10_000;
    return Math.max(11, ceilCents(((need + drain) / marginPerConvertUsdc) * 1.05));
  };

  it.each([50, 6_000_000])('sizes one top-up for the rest of the run and leaves the retry cap alone (%d USD)', async (usd) => {
    const { h, engine, qty } = toppedUp(usd, 1);
    await h.run();
    const top = h.jobs.read()!.steps.find((step) => step.retry)?.retry?.convertAmount;
    expect(top).toBe(expectedTopUp(Number(engine.requests[0].qty), qty));
    expect(h.jobs.read()).toMatchObject({ status: 'done', retryConverts: 0 });
    expect(engine.requests[1].qty).toBe(engine.requests[0].qty);
  });

  it.each([50, 6_000_000])('a second refusal after the top-up halts with nothing open (%d USD)', async (usd) => {
    const { h, engine } = toppedUp(usd, Number.POSITIVE_INFINITY);
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.marginLow, haltKind: 'margin', retryConverts: 0, notHedgedQty: 0, topUps: 1 });
    expect(engine.requests).toHaveLength(2);
    expect(h.jobs.read()?.slice?.index).toBe(1);
  });

  it('a margin refusal at the top-up cap halts with the cap text and converts nothing', async () => {
    const { h, engine } = toppedUp(50, 1);
    const job = h.jobs.read()!;
    job.topUps = RETRY_CONVERT_CAP;
    h.jobs.write(job);
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: REOPEN_HALT.convertCap, haltKind: 'margin', topUps: RETRY_CONVERT_CAP });
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(engine.requests).toHaveLength(1);
  });

  it('a refused reopen after a top-up gets its own retry Convert', async () => {
    const h = sliceRun(sliceVenue(filled, account({ hyperliquid: 1_000 })), { exec: 'market', sliceUsd: 3_000, leg: { qty: 1 } });
    const engine = childEngine(h, (req, index) => (index === 0 ? { refuse: marginRefusal() } : index === 1 ? hedgeRefused(req) : {}));
    await h.run();
    expect(h.count('createCrossexConvertOrder')).toBe(2);
    expect(h.jobs.read()).toMatchObject({ status: 'done', retryConverts: 1 });
    expect(engine.requests).toHaveLength(2);
  });
});

describe('slices: realize TWAP', () => {
  const twapRun = (legs: RealizeLeg[], twap: NonNullable<Job['deleverTwap']>, venue = sliceVenue()) => {
    const h = sliceRun(venue, {
      exec: 'market',
      edit: (job) => {
        Object.assign(job, newJob({ route: 'loop', steps: [], amount: 0, costUsd: 0, target: [], userId: null, kind: 'realize', exec: 'market', sliceUsd: 3_000, realize: realizeOf(...legs), twap }, job.createdAt));
      },
    });
    const at: number[] = [];
    const engine = childEngine(h, () => {
      at.push(h.clock.now());
      return {};
    });
    return { h, engine, at };
  };
  const gaps = (at: number[]) => at.slice(1).map((t, index) => t - at[index]);

  it('waits the interval between slices', async () => {
    const { h, engine, at } = twapRun([sliceLeg({ qty: 1 })], { durationSec: 180, intervalSec: 60, slices: 3 });
    await h.run();
    expect(engine.requests.map((req) => req.qty)).toEqual(['0.3333', '0.3333', '0.3334']);
    for (const gap of gaps(at)) expect(gap).toBeGreaterThanOrEqual(60_000);
    expect(h.jobs.read()).toMatchObject({ status: 'done', slice: { index: 3, count: 3 } });
  });

  it('slices each leg on its own counter and keeps the interval across legs', async () => {
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = seq({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440' }, { symbol: GATE_ETH, positionQty: '-10', initialMargin: '2000' }] });
    const gate = sliceLeg({ symbol: GATE_ETH, exchange: 'GATE', pool: 'CROSSEX', qty: 3, positionQty: 10 });
    const twap = { durationSec: 300, intervalSec: 60, slices: 5, legs: [{ symbol: HL_ETH, slices: 2 }, { symbol: GATE_ETH, slices: 3 }] };
    const { h, engine, at } = twapRun([sliceLeg({ qty: 1 }), gate], twap, venue);
    await h.run();
    expect(engine.requests.map((req) => [req.a.symbol, req.qty])).toEqual([
      [HL_ETH, '0.5'],
      [HL_ETH, '0.5'],
      [GATE_ETH, '1'],
      [GATE_ETH, '1'],
      [GATE_ETH, '1'],
    ]);
    for (const gap of gaps(at)) expect(gap).toBeGreaterThanOrEqual(60_000);
    expect(h.jobs.read()).toMatchObject({ status: 'done', slice: { index: 5, count: 5 } });
  });

  it('respects the venue cap and minimum at run time', async () => {
    const capped = sliceVenue();
    capped.handlers.listCrossexRuleSymbols = seq({
      body: [{ symbol: HL_ETH, state: 'live', lotSize: '0.0001', minSize: '0.0001', tickSize: '0.1', businessType: 'FUTURE', maxMarketSize: '0.2' }],
    });
    const cap = twapRun([sliceLeg({ qty: 1 })], { durationSec: 120, intervalSec: 60, slices: 2 }, capped);
    await cap.h.run();
    expect(cap.engine.requests.map((req) => req.qty)).toEqual(['0.2', '0.2', '0.2', '0.2', '0.2']);

    const floored = sliceVenue();
    floored.handlers.listCrossexRuleSymbols = seq({
      body: [{ symbol: HL_ETH, state: 'live', lotSize: '0.0001', minSize: '0.3', tickSize: '0.1', businessType: 'FUTURE' }],
    });
    const min = twapRun([sliceLeg({ qty: 0.5 })], { durationSec: 120, intervalSec: 60, slices: 2 }, floored);
    await min.h.run();
    expect(min.engine.requests.map((req) => req.qty)).toEqual(['0.5']);
  });

  it('a one order job is held to the venue cap the start stored, which Gate rules do not carry', async () => {
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = async () => ({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440', entryPrice: '3003.1', markPrice: '3000' }] });
    const h = sliceRun(venue, {
      exec: 'market',
      sliceUsd: 0,
      leg: { qty: 3 },
      edit: (job) => {
        job.slice = { ...job.slice!, capsUsd: { [HL_ETH]: 3_000 } };
      },
    });
    const engine = childEngine(h);
    await h.run();
    expect(engine.requests.map((req) => Number(req.qty))).toEqual([1, 1, 1].map((qty) => expect.closeTo(qty, 2)));
    expect(h.jobs.read()).toMatchObject({ status: 'done' });
  });

  it('a one order job with no stored cap sends the whole size at once', async () => {
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = async () => ({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440', entryPrice: '3003.1', markPrice: '3000' }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 0, leg: { qty: 3 } });
    const engine = childEngine(h);
    await h.run();
    expect(engine.requests.map((req) => req.qty)).toEqual(['3']);
  });
});

describe('slices: profit check before each slice', () => {
  it('ends the leg as done once the next slice frees no cash after fees', async () => {
    let entry = '3100';
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = async () => ({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440', entryPrice: entry, markPrice: '3000' }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 3_000, leg: { qty: 3 } });
    const engine = childEngine(h, () => {
      entry = '3002.9';
      return {};
    });
    await h.run();
    const job = h.jobs.read()!;
    expect(engine.requests).toHaveLength(1);
    expect(job).toMatchObject({ status: 'done', haltReason: null });
    expect(job.profitStops).toEqual([{ symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', entry: 3002.9, mark: 3000, closedQty: 1, plannedQty: 3, at: expect.any(Number) }]);
  });

  it('keeps going while each slice still frees cash', async () => {
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = async () => ({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440', entryPrice: '3003.1', markPrice: '3000' }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 3_000, leg: { qty: 3 } });
    const engine = childEngine(h);
    await h.run();
    expect(engine.requests).toHaveLength(3);
    expect(h.jobs.read()).toMatchObject({ status: 'done', profitStops: [] });
  });
});

describe('slices: Convert quotes used up inside a slice', () => {
  it('halts not hedged and the holds still reach the halted child', async () => {
    const venue = sliceVenue(filled, account({ hyperliquid: 1_000 }));
    venue.handlers.createCrossexConvertQuote = gateError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests');
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 3_000, leg: { qty: 1 } });
    const engine = childEngine(h, (req, index) => (index === 0 ? hedgeRefused(req) : {}));
    await h.run();
    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'halted', haltKind: 'not-hedged', notHedgedQty: 1 });
    expect(job.haltReason).toContain("Gate's 100 Convert quotes for today are used up.");
    expect(job.steps[job.stepIndex].name).not.toBe('Slices');
    await expect(applyFix(h.deps, job, 'unwind')).rejects.toThrow(REOPEN_HALT.noHedgePerp);
    expect(job.steps[job.stepIndex].name).toBe('Slices');
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
  });

  it('a top-up Convert with nothing open halts with the plain quotes text, not a 0 ETH gap', async () => {
    const venue = sliceVenue(filled, account({ hyperliquid: 1_000 }));
    venue.handlers.createCrossexConvertQuote = gateError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests');
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 3_000, leg: { qty: 1 } });
    const engine = childEngine(h, (_req, index) => (index === 0 ? { refuse: marginRefusal() } : {}));
    await h.run();
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltReason: HALT_TEXT.quotesUsed, notHedgedQty: 0 });
    expect(engine.requests).toHaveLength(1);
  });
});

const withHedge = (job: Job): void => {
  job.before = { buckets: [], perps: [{ symbol: GATE_ETH, exchange: 'GATE', side: 'LONG', qty: 12.2 }] };
  if (job.realize) job.realize.legs[0].hedge = 'GATE';
};

describe('TWAP Close filled that fills part', () => {
  const twapAt = (unwindFills: string[]) => {
    const h = sliceRun(sliceVenue(), {
      exec: 'market',
      edit: (job) => {
        const leg = { contract: HL_ETH, side: 'BUY' as const, lot: '0.0001', minSize: '0.0001', minNotional: '0', tick: '0.1' };
        Object.assign(job, {
          kind: 'twap',
          steps: [],
          stepIndex: 0,
          realize: null,
          status: 'halted',
          haltKind: 'hedge-margin',
          haltReason: 'Hyperliquid refused the hedge in slice 1',
          twap: {
            deal: { a: { symbol: HL_ETH, side: 'BUY' }, b: { symbol: GATE_ETH, side: 'SELL' }, execution: 'taker', totalQty: '2', coin: 'ETH', rules: [leg, { ...leg, contract: GATE_ETH }] },
            durationSec: 600,
            intervalSec: 300,
            slices: 2,
            sliceQty: '1',
            sliceIndex: 1,
            nextAt: null,
            carryQty: '0',
            behindQty: '0',
            replan: false,
            makerLeg: 'a',
            repegBehindBp: null,
            takerAfterSec: null,
            clientId: 'c1',
            startedAt: 0,
          },
        });
      },
    });
    const engine = childEngine(h, (_req, index) => (index === 0 ? { a: '1', b: '0', mode: 'HALTED', haltKind: 'hedge-margin' } : { a: unwindFills[index - 1] }));
    return { h, engine };
  };
  const haltChild = async (h: ReturnType<typeof sliceRun>) => {
    const job = h.jobs.read()!;
    const id = `${job.id}-s1-1`;
    await (h.deps as unknown as { twap: TwapRunDeps }).twap.createChild({ id, a: { symbol: HL_ETH, side: 'BUY' }, b: { symbol: GATE_ETH, side: 'SELL' }, qty: '1', execution: 'taker' } as DealRequest);
    return job;
  };

  it('stays halted on the rest when the unwind fills part, and a second hold closes the rest', async () => {
    const { h, engine } = twapAt(['0.6', '0.4']);
    const job = await haltChild(h);
    const part = await applyFix(h.deps, job, 'unwind');
    expect(part).toMatchObject({ status: 'halted', paused: false, haltKind: 'hedge-margin', notHedgedQty: 0.4 });
    expect(part.unwindTarget).toMatchObject({ symbol: HL_ETH, side: 'SELL', qty: 0.4, reduceOnly: true });
    const rest = await applyFix(h.deps, part, 'unwind');
    expect(engine.requests.map((req) => [req.id, req.qty])).toEqual([
      [`${job.id}-s1-1`, '1'],
      [`${job.id}-f1`, '1'],
      [`${job.id}-f1-2`, '0.4'],
    ]);
    expect(rest).toMatchObject({ status: 'halted', paused: true, haltKind: null, notHedgedQty: 0, unwindTarget: null });
  });

  it('pauses when the unwind fills the whole gap', async () => {
    const { h } = twapAt(['1']);
    const job = await haltChild(h);
    expect(await applyFix(h.deps, job, 'unwind')).toMatchObject({ status: 'halted', paused: true, haltKind: null, notHedgedQty: 0 });
  });
});

describe('slices: holds on a not-hedged realize', () => {
  const gapRun = (script: (req: DealRequest, index: number) => ChildOutcome = (req, index) => (index === 0 ? hedgeRefused(req) : {})) => {
    const h = sliceRun(sliceVenue(filled, account({ hyperliquid: 1_000 })), { exec: 'market', sliceUsd: 3_000, leg: { qty: 1 }, edit: withHedge });
    const engine = childEngine(h, script);
    refuseReopens(h, engine, () => true);
    return { h, engine };
  };

  it('unwind closes the not-hedged qty on the other perp, reduce-only, at market', async () => {
    const { h, engine } = gapRun();
    await h.run();
    expect(h.jobs.read()?.unwindTarget).toEqual({ symbol: GATE_ETH, exchange: 'GATE', side: 'SELL', qty: 1, reduceOnly: true });
    const job = await applyFix(h.deps, h.jobs.read()!, 'unwind');
    expect(engine.requests[1]).toMatchObject({ a: { symbol: GATE_ETH, side: 'SELL', reduceOnly: true }, b: null, qty: '1' });
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('DONE');
    expect(job).toMatchObject({ paused: true, notHedgedQty: 0, follow: null, unwindTarget: null, haltKind: null });
  });

  it('a part-filled unwind keeps the rest not hedged with the holds, and the next unwind sends the rest', async () => {
    const { h, engine } = gapRun((req, index) => (index === 0 ? hedgeRefused(req) : index === 1 ? { a: '0.4' } : {}));
    await h.run();
    const part = await applyFix(h.deps, h.jobs.read()!, 'unwind');
    expect(part).toMatchObject({ status: 'halted', notHedgedQty: 0.6, follow: { qty: 0.6 }, unwindTarget: { symbol: GATE_ETH, qty: 0.6 } });
    const rest = await applyFix(h.deps, part, 'unwind');
    expect(engine.requests[2]).toMatchObject({ a: { symbol: GATE_ETH, side: 'SELL', reduceOnly: true }, qty: '0.6' });
    expect(rest).toMatchObject({ paused: true, notHedgedQty: 0 });
  });

  it.each(['market', 'limit'] as const)('%s with no halted child sends a one-leg order on the follow', async (action) => {
    const { h, engine } = gapRun((req, index) => (index === 0 ? hedgeRefused(req) : index === 1 ? { a: '0.4' } : {}));
    await h.run();
    const part = await applyFix(h.deps, h.jobs.read()!, 'unwind');
    const job = await applyFix(h.deps, part, action);
    expect(engine.requests[2]).toMatchObject({ a: { symbol: HL_ETH, side: 'SELL' }, b: null, qty: '0.6' });
    expect(job).toMatchObject({ status: 'running', notHedgedQty: 0, follow: null });
  });

  it('a hold wait that times out halts the stuck STOPPING child again', async () => {
    const { h, engine } = gapRun();
    await h.run();
    Object.assign(h.deps, { sleep: h.clock.sleep });
    await expect(applyFix(h.deps, h.jobs.read()!, 'market')).rejects.toThrow(FIX_UNCONFIRMED);
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
  });

  const haltedButRunning = async () => {
    const { h, engine } = gapRun();
    await h.run();
    const job = h.jobs.read()!;
    Object.assign(job, { status: 'running', haltKind: null, haltReason: null, notHedgedQty: 0, follow: null, unwindTarget: null });
    return { h, engine, job };
  };

  it('a sleep keeps the halted child and its not-hedged state, and unwind works after', async () => {
    const { h, engine, job } = await haltedButRunning();
    job.deleverTwap = { durationSec: 120, intervalSec: 60, slices: 2 };
    h.jobs.write(job);
    const slept = sleepHaltTwap((h.deps as unknown as { twap: TwapRunDeps }).twap, job, { fromMs: h.clock.now(), toMs: h.clock.now() + 60_000 });
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
    expect(slept).toMatchObject({ status: 'halted', haltKind: 'sleep', notHedgedQty: 1, follow: { symbol: HL_ETH, qty: 1 } });
    const fixed = await applyFix(h.deps, slept, 'unwind');
    expect(engine.requests[1]).toMatchObject({ a: { symbol: GATE_ETH, side: 'SELL', reduceOnly: true }, qty: '1' });
    expect(fixed).toMatchObject({ paused: true, notHedgedQty: 0 });
  });

  it('a restart keeps the halted child and its not-hedged state', async () => {
    const { h, engine, job } = await haltedButRunning();
    h.jobs.write(job);
    await cancelRestingLead(h.deps, job);
    expect(engine.store.getPair(engine.requests[0].id)?.mode).toBe('HALTED');
    expect(h.jobs.read()).toMatchObject({ status: 'halted', haltKind: 'restart', notHedgedQty: 1, unwindTarget: { symbol: GATE_ETH, qty: 1 } });
  });
});

describe('slices: Convert quote probe', () => {
  const network = (() => {
    try {
      networkError();
    } catch (err) {
      return err;
    }
  })();
  const probeRun = async (failures: number) => {
    const h = sliceRun(sliceVenue(), { exec: 'market', sliceUsd: 3_000, leg: { qty: 1, convert: { amount: 500, count: 1, feeUsd: 1 } } });
    const engine = childEngine(h, (_req, index) => (index < failures ? { refuse: network } : {}));
    await h.run();
    return { h, engine };
  };

  it('probes the quotes once per job, not on every retry of a failed first slice', async () => {
    const clean = await probeRun(0);
    const { h, engine } = await probeRun(4);
    expect(engine.requests.length).toBe(5);
    expect(clean.h.count('createCrossexConvertQuote')).toBeGreaterThan(0);
    expect(h.count('createCrossexConvertQuote')).toBe(clean.h.count('createCrossexConvertQuote'));
    expect(h.jobs.read()).toMatchObject({ status: 'done', quotesChecked: true });
  });
});

describe('slices: a profit stop trims the leg Convert', () => {
  const stopRun = (entryAtStart: string, amount: number) => {
    let entry = entryAtStart;
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = async () => ({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440', entryPrice: entry, markPrice: '3000' }] });
    const h = sliceRun(venue, { exec: 'market', sliceUsd: 3_000, leg: { qty: 3, convert: { amount, count: 1, feeUsd: amount * 0.002 } } });
    childEngine(h, () => {
      entry = '3002.9';
      return {};
    });
    return h;
  };
  const converts = (job: Job) => job.steps.filter((step) => step.name.startsWith('Convert'));

  it.each([50, 6_000_000])('cuts the Convert to the closed share (%d USD)', async (amount) => {
    const h = stopRun('3100', amount * 3);
    await h.run();
    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', haltReason: null });
    expect(job.profitStops).toHaveLength(1);
    const planned = converts(job).reduce((total, step) => total + Math.round((step.planned ?? 0) * 100), 0) / 100;
    expect(planned).toBe(amount);
    for (const step of converts(job)) expect(step.planned ?? 0).toBeLessThanOrEqual(CONVERT_MAX);
  });

  it('drops the Convert when the closed share is under $11, and ends done', async () => {
    const h = stopRun('3000', 3_000);
    await h.run();
    const job = h.jobs.read()!;
    expect(job).toMatchObject({ status: 'done', haltReason: null, profitStops: [{ closedQty: 0, plannedQty: 3 }] });
    expect(converts(job)).toHaveLength(0);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
  });
});

describe('slices: profit check after a Limit close fell back to market', () => {
  const limitRun = (kind: 'maker' | 'taker') => {
    const venue = sliceVenue();
    venue.handlers.listCrossexPositions = async () => ({ body: [{ symbol: HL_ETH, positionQty: '-12.2', initialMargin: '2440', entryPrice: '3002.5', markPrice: '3000' }] });
    const h = sliceRun(venue, { exec: 'maker', sliceUsd: 3_000, leg: { qty: 3 } });
    const engine = childEngine(h, () => ({ kind }));
    return { h, engine };
  };

  it('keeps going at the maker fee while the close rests as a maker', async () => {
    const { h, engine } = limitRun('maker');
    await h.run();
    expect(engine.requests).toHaveLength(3);
    expect(h.jobs.read()?.profitStops).toEqual([]);
  });

  it('stops at the taker fee once the close fell back to market', async () => {
    const { h, engine } = limitRun('taker');
    await h.run();
    expect(engine.requests).toHaveLength(1);
    expect(h.jobs.read()).toMatchObject({ status: 'done', profitStops: [{ closedQty: 1, plannedQty: 3 }] });
  });
});
