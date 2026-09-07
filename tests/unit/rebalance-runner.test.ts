import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob, type Job, type RouteName } from '../../src/server/rebalanceJob';
import {
  LOOKUP_RETRY_MS,
  POLL_MS,
  QUOTE_FLOOR,
  runJob,
  STEP_TIMEOUT_MS,
  tagFor,
} from '../../src/server/rebalanceRunner';
import { clientsWith } from '../helpers/fake-clients';

type Handler = (arg?: any) => Promise<unknown>;

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
const account = (usdcOnHl: string) => ({
  body: {
    assets: [
      { coin: 'USDT', exchangeType: 'CROSSEX', balance: '1200' },
      { coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: usdcOnHl },
    ],
  },
});
const quote = (quoteId: string, toAmount: string) => ({
  body: { quoteId, validMs: '5000', fromAmount: '12', toAmount, price: '0.998' },
});

function happyLoop(): Record<string, Handler> {
  const x1 = row('x1', 'SUCCESS', { actualReceive: '11.99' });
  return {
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
  route: RouteName,
  handlers: Record<string, Handler>,
  edit?: (job: Job) => void,
) {
  const calls: Record<string, any[]> = {};
  const crossEx: Record<string, Handler> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    crossEx[name] = async (arg?: unknown) => {
      (calls[name] ??= []).push(arg);
      return fn(arg);
    };
  }
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));
  const jobs = new JobFile(dir, clock.now);
  const job = newJob(route, 12, clock.now());
  edit?.(job);
  jobs.write(job);
  const cache = new TtlCache();
  const log = vi.fn();
  const deps = { clients: () => clientsWith(crossEx), jobs, cache, now: clock.now, sleep: clock.sleep, log };
  const count = (name: string) => calls[name]?.length ?? 0;
  return { dir, job, jobs, cache, calls, count, deps, log, run: () => runJob(deps) };
}

const doneStep = (name: string, tag: string, venueId: string, qty: number, at: number) => ({
  name,
  text: tag,
  quoteId: null,
  venueId,
  qty,
  balanceBefore: null,
  attempt: 0,
  status: 'done' as const,
  startedAt: at,
  doneAt: at,
});

function resumeAtLastTransfer(job: Job, at: number, patch: Partial<Job['steps'][number]>): void {
  job.steps[0] = doneStep('Buy USDC', tagFor(job.id, 0), 'o1', 11.99, at);
  job.steps[1] = doneStep('To spot', tagFor(job.id, 1), 'x1', 11.99, at);
  job.steps[2] = { ...job.steps[2], text: tagFor(job.id, 2), status: 'running', startedAt: at, ...patch };
  job.stepIndex = 2;
  job.fundsAt = 'SPOT';
}

describe('runJob loop route', () => {
  it('runs to done with three venue ids and the qty chain 12 → 11.99 → 11.99 → 11.94', async () => {
    const clock = fakeClock();
    const h = harness(clock, 'loop', happyLoop());
    await h.cache.get('account', 60_000, async () => 'old');

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.haltReason).toBeNull();
    expect(job.amount).toBe(12);
    expect(job.stepIndex).toBe(2);
    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps.map((s) => s.venueId)).toEqual(['o1', 'x1', 'x2']);
    expect(job.steps.map((s) => s.qty)).toEqual([11.99, 11.99, 11.94]);
    expect(job.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    for (const s of job.steps) {
      expect(s.startedAt).toBeTypeOf('number');
      expect(s.doneAt).toBeTypeOf('number');
      expect(s.quoteId).toBeNull();
      expect(s.balanceBefore).toBeNull();
    }

    expect(h.calls.createCrossexOrder[0].crossexOrderRequest).toEqual({
      symbol: 'GATE_SPOT_USDC_USDT',
      side: 'BUY',
      type: 'MARKET',
      quoteQty: '12',
      text: tagFor(job.id, 0),
    });
    expect(h.calls.createCrossexTransfer.map((a) => a.crossexTransferRequest)).toEqual([
      { coin: 'USDC', amount: '11.99000', from: 'CROSSEX_GATE', to: 'SPOT', text: tagFor(job.id, 1) },
      { coin: 'USDC', amount: '11.99000', from: 'SPOT', to: 'CROSSEX_HYPERLIQUID', text: tagFor(job.id, 2) },
    ]);
    expect(h.calls.listCrossexTransfers[0]).toEqual({ coin: 'USDC', limit: 100 });
    expect(h.log).not.toHaveBeenCalled();

    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'rebalance.json'), 'utf8')) as Job;
    expect(onDisk.status).toBe('done');
    expect(onDisk.steps.map((s) => s.venueId)).toEqual(['o1', 'x1', 'x2']);

    const { value } = await h.cache.get('account', 60_000, async () => 'new');
    expect(value).toBe('new');
  });

  it('halts when the order ends terminal with nothing filled', async () => {
    const h = harness(fakeClock(), 'loop', { ...happyLoop(), getCrossexOrder: seq(order('REJECT', '0')) });

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
    expect(h.log).toHaveBeenCalledWith(
      `rebalance ${job.id} halted at Buy USDC: order REJECT with nothing filled. Funds are in CROSSEX.`,
    );
  });

  it('subtracts a USDC fee from the executed qty', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      getCrossexOrder: seq(order('FILLED', '11.99', 'o1', { feeCoin: 'USDC', fee: '0.012' })),
      listCrossexTransfers: seq(
        rows(row('x1', 'SUCCESS', { actualReceive: '11.978' })),
        rows(row('x2', 'SUCCESS', { actualReceive: '11.928' })),
      ),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0].qty).toBe(11.978);
    expect(h.calls.createCrossexTransfer[0].crossexTransferRequest.amount).toBe('11.97800');
  });

  it('keeps a USDT fee out of the executed qty', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      getCrossexOrder: seq(order('FILLED', '11.99', 'o1', { feeCoin: 'USDT', fee: '0.012' })),
    });

    await h.run();

    expect(h.jobs.read()!.steps[0].qty).toBe(11.99);
  });

  it('keeps polling through an ACTIVE state and finishes on FILLED', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      getCrossexOrder: seq(order('ACTIVE', '0'), order('ACTIVE', '0'), order('FILLED', '11.99')),
    });

    await h.run();

    expect(h.jobs.read()!.status).toBe('done');
    expect(h.count('getCrossexOrder')).toBe(3);
  });

  it('treats a 404 on a poll as transient and finishes on the next FILLED', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      getCrossexOrder: seq(gateError(404, 'ORDER_NOT_FOUND', 'order not found'), order('FILLED', '11.99')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.haltReason).toBeNull();
    expect(h.count('getCrossexOrder')).toBe(2);
  });

  it('halts on a transfer SUCCESS that received nothing', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      listCrossexTransfers: seq(rows(row('x1', 'SUCCESS', { actualReceive: '0' }))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('transfer SUCCESS with nothing received');
    expect(job.fundsAt).toBe('GATE');
    expect(job.steps[1].venueId).toBe('x1');
  });

  it('halts on a CANCELLED transfer and clears its ids for a fresh send', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      listCrossexTransfers: seq(rows(row('x1', 'CANCELLED'))),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('transfer CANCELLED');
    expect(job.steps[1].venueId).toBeNull();
    expect(job.steps[1].text).toBeNull();
  });

  it('halts on a step name it does not know before any venue call', async () => {
    const h = harness(fakeClock(), 'loop', happyLoop(), (job) => {
      job.steps[0].name = 'Bogus';
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('unknown step Bogus');
    expect(h.count('createCrossexOrder')).toBe(0);
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('adopts a transfer by tag on the next pass when the send response has no txId', async () => {
    const id = (1_000_000).toString(36);
    const x1 = row('x1', 'SUCCESS', { actualReceive: '11.99', text: tagFor(id, 1) });
    const h = harness(fakeClock(), 'loop', {
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

  it('halts on a FAILED transfer with its failReason and fundsAt GATE, and a resume sends one new transfer', async () => {
    const h = harness(fakeClock(), 'loop', {
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
    expect(job.haltReason).toBe('insufficient balance');
    expect(job.fundsAt).toBe('GATE');
    expect(job.stepIndex).toBe(1);
    expect(job.steps[0].status).toBe('done');
    expect(job.steps[1].venueId).toBeNull();
    expect(job.steps[1].text).toBeNull();
    expect(h.count('createCrossexTransfer')).toBe(1);
    expect(h.log).toHaveBeenCalledWith(
      `rebalance ${job.id} halted at To spot: insufficient balance. Funds are in GATE.`,
    );

    job.status = 'running';
    job.haltReason = null;
    h.jobs.write(job);
    await h.run();

    const resumed = h.jobs.read()!;
    expect(resumed.steps[1].attempt).toBe(1);
    expect(h.calls.createCrossexTransfer[1].crossexTransferRequest.text).toBe(tagFor(job.id, 1, 1));
    expect(h.calls.createCrossexTransfer[1].crossexTransferRequest.text).not.toBe(h.calls.createCrossexTransfer[0].crossexTransferRequest.text);
    expect(resumed.status).toBe('done');
    expect(resumed.steps.map((s) => s.venueId)).toEqual(['o1', 'x2', 'x3']);
    expect(h.count('createCrossexTransfer')).toBe(3);
  });

  it('halts with timeout after 600 s without a terminal state', async () => {
    const clock = fakeClock();
    const h = harness(clock, 'loop', { ...happyLoop(), getCrossexOrder: seq(order('OPEN', '0')) });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('timeout');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps[0].venueId).toBe('o1');
    expect(job.steps[0].text).toBe(tagFor(job.id, 0));
    expect(clock.now() - job.steps[0].startedAt!).toBe(STEP_TIMEOUT_MS + POLL_MS);
    expect(h.count('getCrossexOrder')).toBe(STEP_TIMEOUT_MS / POLL_MS + 1);
    expect(h.count('createCrossexOrder')).toBe(1);
  });

  it('halts on a 4xx label at send with the message and the hint', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      createCrossexOrder: seq(gateError(401, 'INVALID_KEY', 'invalid key')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe(
      'Gate API error (HTTP 401) [INVALID_KEY]: invalid key Check the API key/secret in Settings.',
    );
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps[0].text).toBe(tagFor(job.id, 0));
    expect(job.steps[0].venueId).toBeNull();
    expect(h.count('createCrossexOrder')).toBe(1);
    expect(h.count('getCrossexOrder')).toBe(0);
  });

  it('halts on a 4xx label without a hint with the message alone', async () => {
    const h = harness(fakeClock(), 'loop', {
      ...happyLoop(),
      createCrossexOrder: seq(gateError(400, 'TRADE_INVALID_QUOTE_ORDER_QTY', 'bad qty')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('Gate API error (HTTP 400) [TRADE_INVALID_QUOTE_ORDER_QTY]: bad qty');
    expect(h.count('createCrossexOrder')).toBe(1);
  });

  it('waits one POLL_MS after a rate-limited poll and reads again with no state change', async () => {
    const clock = fakeClock();
    const h = harness(clock, 'loop', {
      ...happyLoop(),
      getCrossexOrder: seq(gateError(429, 'TOO_MANY_REQUESTS', 'slow down'), order('FILLED', '11.99')),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(h.count('getCrossexOrder')).toBe(2);
    expect(job.steps[0].doneAt! - job.steps[0].startedAt!).toBe(POLL_MS);
  });

  it('finds the order by tag after a 5xx at send and does not send again', async () => {
    const clock = fakeClock();
    const lookups: number[] = [];
    const h = harness(clock, 'loop', {
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
    expect(h.calls.getCrossexOrder[0]).toBe(tagFor(job.id, 0));
  });
});

describe('runJob convert route', () => {
  it('quotes, reads the balance, sends the order, and is done with one step', async () => {
    const h = harness(fakeClock(), 'convert', {
      createCrossexConvertQuote: seq(quote('q1', '11.976')),
      getCrossexAccount: seq(account('100')),
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
      text: tagFor(job.id, 0),
      quoteId: 'q1',
      venueId: 'c1',
      qty: 11.976,
      balanceBefore: 100,
      status: 'done',
    });
    expect(h.calls.createCrossexConvertQuote[0].crossexConvertQuoteRequest).toEqual({
      exchangeType: 'HYPERLIQUID',
      fromCoin: 'USDT',
      toCoin: 'USDC',
      fromAmount: '12',
    });
    expect(h.calls.createCrossexConvertOrder[0].crossexConvertOrderRequest).toEqual({ quoteId: 'q1' });
    expect(h.count('getCrossexAccount')).toBe(1);
    const { value } = await h.cache.get('account', 60_000, async () => 'new');
    expect(value).toBe('new');
  });

  it('halts on a quote below the floor and sends no order', async () => {
    const below = String(12 * QUOTE_FLOOR - 0.01);
    const h = harness(fakeClock(), 'convert', {
      createCrossexConvertQuote: seq(quote('q1', below)),
      getCrossexAccount: seq(account('100')),
      createCrossexConvertOrder: seq({ body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('halted');
    expect(job.haltReason).toBe('quote worse than 30 bps');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps[0].quoteId).toBeNull();
    expect(job.steps[0].venueId).toBeNull();
    expect(job.steps[0].balanceBefore).toBe(100);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
    expect(h.count('getCrossexAccount')).toBe(1);
  });

  it('sends one order when the order call times out and the balance then shows it landed', async () => {
    const clock = fakeClock();
    const h = harness(clock, 'convert', {
      createCrossexConvertQuote: seq(quote('q1', '11.976')),
      getCrossexAccount: seq(account('100'), account('100'), account('111.976')),
      createCrossexConvertOrder: seq(networkError, { body: { orderId: 'c1', text: 'q1' } }),
    });

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null, qty: 11.976, balanceBefore: 100, status: 'done' });
    expect(h.count('createCrossexConvertOrder')).toBe(1);
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('getCrossexAccount')).toBe(3);
    expect(job.steps[0].doneAt! - job.steps[0].startedAt!).toBe(POLL_MS + LOOKUP_RETRY_MS);
  });
});

describe('runJob resumed steps send nothing twice', () => {
  it('a step with a venueId makes one read and no send', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      'loop',
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
  });

  it('a Buy step with text only, found on lookup, records the id and sends nothing', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      'loop',
      { ...happyLoop(), getCrossexOrder: seq(order('FILLED', '11.99', 'o1')) },
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
      'loop',
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

  it('a Buy step not found twice waits 10 s between lookups, then sends once', async () => {
    const clock = fakeClock();
    const lookups: number[] = [];
    let sentAt = -1;
    const h = harness(
      clock,
      'loop',
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
    expect(lookups).toEqual([t0, t0 + LOOKUP_RETRY_MS]);
    expect(sentAt).toBe(t0 + LOOKUP_RETRY_MS);
  });

  it('a convert step with a quoteId is done with no send when the balance rose by the quote', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      'convert',
      {
        createCrossexConvertQuote: seq(quote('q2', '11.976')),
        getCrossexAccount: seq(account('111.97')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c2', text: 'q2' } }),
      },
      (job) => {
        Object.assign(job.steps[0], {
          text: tagFor(job.id, 0),
          quoteId: 'q1',
          qty: 11.976,
          balanceBefore: 100,
          status: 'running',
          startedAt: clock.now(),
        });
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q1', venueId: null, qty: 11.976, status: 'done' });
    expect(h.count('getCrossexAccount')).toBe(1);
    expect(h.count('createCrossexConvertQuote')).toBe(0);
    expect(h.count('createCrossexConvertOrder')).toBe(0);
  });

  it('a convert step with a quoteId re-quotes and sends once when the balance did not rise', async () => {
    const clock = fakeClock();
    const h = harness(
      clock,
      'convert',
      {
        createCrossexConvertQuote: seq(quote('q2', '11.97')),
        getCrossexAccount: seq(account('100')),
        createCrossexConvertOrder: seq({ body: { orderId: 'c2', text: 'q2' } }),
      },
      (job) => {
        Object.assign(job.steps[0], {
          text: tagFor(job.id, 0),
          quoteId: 'q1',
          qty: 11.976,
          balanceBefore: 100,
          status: 'running',
          startedAt: clock.now(),
        });
      },
    );

    await h.run();

    const job = h.jobs.read()!;
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ quoteId: 'q2', venueId: 'c2', qty: 11.97, balanceBefore: 100 });
    expect(h.count('getCrossexAccount')).toBe(2);
    expect(h.count('createCrossexConvertQuote')).toBe(1);
    expect(h.count('createCrossexConvertOrder')).toBe(1);
  });
});

describe('JobFile', () => {
  const dir = () => fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));

  it('reads null when no file exists', () => {
    expect(new JobFile(dir()).read()).toBeNull();
  });

  it('writes an owner-only file that a new JobFile reads back', () => {
    const d = dir();
    const job = newJob('loop', 12, 1_000_000);
    expect(job.id).toBe((1_000_000).toString(36));
    expect(job.steps.map((s) => s.name)).toEqual(['Buy USDC', 'To spot', 'To Hyperliquid']);
    expect(newJob('convert', 5, 7).steps.map((s) => s.name)).toEqual(['Convert']);

    new JobFile(d).write(job);

    const file = path.join(d, 'rebalance.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(d)).toEqual(['rebalance.json']);
    const back = new JobFile(d).read()!;
    expect(back).toEqual({ ...job, updatedAt: back.updatedAt });
    expect(back.updatedAt).toBeGreaterThan(job.createdAt);
  });

  it('reads null and says so once when the file is not a job', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const d = dir();
      const { steps: _steps, ...noSteps } = newJob('loop', 12, 1_000_000);
      fs.writeFileSync(path.join(d, 'rebalance.json'), JSON.stringify(noSteps));
      const jobs = new JobFile(d);
      expect(jobs.read()).toBeNull();
      expect(jobs.read()).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('treating as no job');

      fs.writeFileSync(path.join(d, 'rebalance.json'), '{not json');
      expect(new JobFile(d).read()).toBeNull();

      const bogus = newJob('loop', 12, 1_000_000);
      bogus.steps[1].name = 'Bogus';
      fs.writeFileSync(path.join(d, 'rebalance.json'), JSON.stringify(bogus));
      expect(new JobFile(d).read()).toBeNull();

      const wrongIndex = { ...newJob('loop', 12, 1_000_000), stepIndex: 3 };
      fs.writeFileSync(path.join(d, 'rebalance.json'), JSON.stringify(wrongIndex));
      expect(new JobFile(d).read()).toBeNull();
      expect(error).toHaveBeenCalledTimes(4);
    } finally {
      error.mockRestore();
    }
  });

  it('stamps updatedAt from the clock it was given', () => {
    const jobs = new JobFile(dir(), () => 42);
    const job = newJob('loop', 12, 1_000_000);
    jobs.write(job);
    expect(job.updatedAt).toBe(42);
  });

  it('haltIfRunning halts a running job with the reason and leaves other statuses alone', () => {
    const d = dir();
    const jobs = new JobFile(d);
    jobs.write(newJob('loop', 12, 1_000_000));

    expect(jobs.haltIfRunning('server restarted')).toBe(true);

    expect(jobs.read()).toMatchObject({ status: 'halted', haltReason: 'server restarted' });
    expect(new JobFile(d).read()).toMatchObject({ status: 'halted', haltReason: 'server restarted' });
    expect(jobs.haltIfRunning('server restarted')).toBe(false);

    const done = { ...newJob('loop', 12, 2_000_000), status: 'done' as const };
    jobs.write(done);
    expect(jobs.haltIfRunning('server restarted')).toBe(false);
    expect(jobs.read()).toMatchObject({ status: 'done', haltReason: null });

    expect(new JobFile(dir()).haltIfRunning('server restarted')).toBe(false);
  });
});
