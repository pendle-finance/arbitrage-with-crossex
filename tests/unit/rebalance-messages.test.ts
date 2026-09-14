import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlannedStep, WalletAfter } from '../../src/core/rebalance/plan';
import {
  bannerFor,
  haltReasonFor,
  inTransitOf,
  JobFile,
  newJob,
  newTransferJob,
  transferFailText,
  TransferFile,
  transferLockFor,
  type Job,
} from '../../src/server/rebalanceJob';

const dir = () => fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));

const gateError = (status: number, label: string, message: string) =>
  Object.assign(new Error(message), { response: { status, data: { label, message } } });

const accountALoop: PlannedStep[] = [
  { round: 1, kind: 'round', buy: 0, move: 24.51, arrives: 24.46, borrowLeft: 122.59, seconds: 130 },
  { round: 2, kind: 'round', buy: 0, move: 29.93, arrives: 29.88, borrowLeft: 92.71, seconds: 130 },
  { round: 3, kind: 'round', buy: 0, move: 36.58, arrives: 36.53, borrowLeft: 56.19, seconds: 130 },
  { round: 4, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66, borrowLeft: 11.53, seconds: 130 },
  { round: 5, kind: 'round', buy: 40.15, move: 40.15, arrives: 40.1, borrowLeft: 0, seconds: 130 },
];

const accountATarget: WalletAfter[] = [
  { coin: 'USDT', venue: 'CROSSEX', cash: 28.61, equity: 28.61 },
  { coin: 'USDC', venue: 'HYPERLIQUID', cash: 28.58, equity: 28.58 },
  { coin: 'USDC', venue: 'GATE', cash: 0, equity: 0 },
];

const exampleEMix: PlannedStep[] = [
  { round: 1, kind: 'round', buy: 0, move: 745.44, arrives: 744.44, borrowLeft: 0, seconds: 400 },
  { round: null, kind: 'convert', buy: 0, move: 482.83, arrives: 481.86, borrowLeft: 0, seconds: 0 },
];

const accountAJob = (): Job =>
  newJob(
    { direction: 'toUsdc', route: 'loop', steps: accountALoop, amount: 175.88, costUsd: 0.26, target: accountATarget, userId: '1' },
    1_000_000,
  );

const exampleEJob = (): Job =>
  newJob(
    { direction: 'toUsdt', route: 'mix', steps: exampleEMix, amount: 1228.27, costUsd: 2.04, target: [], userId: '1' },
    2_000_000,
  );

const stopAt = (job: Job, stepIndex: number, patch: Pick<Job, 'status' | 'fundsAt'>): Job => {
  for (const step of job.steps.slice(0, stepIndex)) Object.assign(step, { status: 'done', qty: step.planned });
  return Object.assign(job, { stepIndex, ...patch });
};

const writeRaw = (d: string, name: string, value: unknown): void =>
  fs.writeFileSync(path.join(d, name), typeof value === 'string' ? value : JSON.stringify(value));

describe('halt texts', () => {
  it('halt text for transfer amount insufficient', () => {
    const refused = gateError(
      422,
      'TRANSFER_AMOUNT_INSUFFICIENT',
      'Insufficient transferAvailable, transferAvailable: 11.858125309999999914046',
    );

    expect(haltReasonFor(refused)).toBe('Gate refused the move: free margin is too low.');
  });

  it('halt text for restart', () => {
    const d = dir();
    const jobs = new JobFile(d);
    jobs.write(accountAJob());

    expect(jobs.haltIfRunning()).toBe(true);

    expect(jobs.read()).toMatchObject({ status: 'halted', haltReason: 'The app restarted during the run.' });
    expect(new JobFile(d).read()).toMatchObject({ status: 'halted', haltReason: 'The app restarted during the run.' });
    expect(jobs.haltIfRunning()).toBe(false);

    jobs.write({ ...accountAJob(), status: 'done' });
    expect(jobs.haltIfRunning()).toBe(false);
    expect(jobs.read()).toMatchObject({ status: 'done', haltReason: null });
    expect(new JobFile(dir()).haltIfRunning()).toBe(false);
  });

  it('any other error halts with its message, and the hint after it when there is one', () => {
    expect(haltReasonFor(gateError(400, 'TRADE_INVALID_QUOTE_ORDER_QTY', 'quote qty is required'))).toBe(
      'Gate API error (HTTP 400) [TRADE_INVALID_QUOTE_ORDER_QTY]: quote qty is required',
    );
    expect(haltReasonFor(gateError(401, 'INVALID_KEY', 'invalid key'))).toBe(
      'Gate API error (HTTP 401) [INVALID_KEY]: invalid key Check the API key/secret in Settings.',
    );
    expect(haltReasonFor(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('transfer fail text ends in one period', () => {
    expect(transferFailText('x')).toBe('Transfer failed: x.');
    expect(transferFailText('x.')).toBe('Transfer failed: x.');
    expect(transferFailText(' withdraw paused. ')).toBe('Transfer failed: withdraw paused.');
  });

  it('transfer fail text with no reason has no colon', () => {
    expect(transferFailText('')).toBe('Transfer failed.');
    expect(transferFailText('   ')).toBe('Transfer failed.');
    expect(transferFailText(' . . ')).toBe('Transfer failed.');
  });
});

describe('newJob', () => {
  it('expands each round toward USDC into buy, to spot and to the Hyperliquid wallet', () => {
    const job = accountAJob();

    expect(job).toMatchObject({
      id: (1_000_000).toString(36),
      userId: '1',
      direction: 'toUsdc',
      route: 'loop',
      amount: 175.88,
      costUsd: 0.26,
      target: accountATarget,
      status: 'running',
      stepIndex: 0,
      fundsAt: 'CROSSEX',
      haltReason: null,
      createdAt: 1_000_000,
    });
    expect(job.steps).toHaveLength(15);
    expect(job.steps.map((s) => s.round)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
    expect(job.steps.slice(9, 12)).toEqual([
      { name: 'Buy USDC', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: 4, planned: 23.77, arrives: null, borrowLeft: null },
      { name: 'To spot', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: 4, planned: 44.71, arrives: null, borrowLeft: null },
      { name: 'To Hyperliquid', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: 4, planned: 44.71, arrives: 44.66, borrowLeft: 11.53 },
    ]);
    expect(job.steps[0]).toMatchObject({ name: 'Buy USDC', planned: 0 });
  });

  it('expands a round toward USDT into out of the Hyperliquid wallet, to Gate and sell, then Convert', () => {
    const job = exampleEJob();

    expect(job).toMatchObject({ direction: 'toUsdt', route: 'mix', amount: 1228.27, costUsd: 2.04, fundsAt: 'HYPERLIQUID' });
    expect(job.steps.map(({ name, round, planned, arrives, borrowLeft }) => ({ name, round, planned, arrives, borrowLeft }))).toEqual([
      { name: 'From Hyperliquid', round: 1, planned: 745.44, arrives: null, borrowLeft: null },
      { name: 'To Gate', round: 1, planned: 744.44, arrives: null, borrowLeft: null },
      { name: 'Sell USDC', round: 1, planned: 744.44, arrives: null, borrowLeft: 0 },
      { name: 'Convert', round: null, planned: 482.83, arrives: null, borrowLeft: null },
    ]);
  });

  it('a convert-only job is one Convert step', () => {
    const convert: PlannedStep = { round: null, kind: 'convert', buy: 0, move: 175.94, arrives: 175.58, borrowLeft: 0, seconds: 0 };

    const job = newJob({ direction: 'toUsdc', route: 'convert', steps: [convert], amount: 175.94, costUsd: 0.36, target: [], userId: null }, 7);

    expect(job.steps).toEqual([
      { name: 'Convert', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: null, planned: 175.94, arrives: null, borrowLeft: null },
    ]);
    expect(job.fundsAt).toBe('CROSSEX');
  });
});

describe('1.6.0 job file', () => {
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

  it('parses a halted loop job with planned at the job amount and round 1', () => {
    const d = dir();
    writeRaw(d, 'rebalance.json', {
      id: 'mfhq1x2k',
      userId: '1',
      direction: 'toUsdc',
      route: 'loop',
      amount: 111.96,
      status: 'halted',
      stepIndex: 1,
      steps: [
        step160('Buy USDC', { text: 't-rbmfhq1x2k0', venueId: 'o1', qty: 111.96, status: 'done', startedAt: 1_757_700_000_000, doneAt: 1_757_700_002_000 }),
        step160('To spot', { attempt: 1, status: 'running', startedAt: 1_757_700_003_000 }),
        step160('To Hyperliquid'),
      ],
      fundsAt: 'GATE',
      haltReason: 'Gate API error (HTTP 422) [TRANSFER_AMOUNT_INSUFFICIENT]: Insufficient transferAvailable, transferAvailable: 25.08',
      createdAt: 1_757_700_000_000,
      updatedAt: 1_757_700_004_000,
    });

    const job = new JobFile(d).read()!;

    expect(job).toMatchObject({ route: 'loop', amount: 111.96, status: 'halted', stepIndex: 1, fundsAt: 'GATE', costUsd: null, target: null });
    expect(job.steps[1].planned).toBe(111.96);
    expect(job.steps.map(({ round, planned, arrives, borrowLeft }) => ({ round, planned, arrives, borrowLeft }))).toEqual([
      { round: 1, planned: 111.96, arrives: null, borrowLeft: null },
      { round: 1, planned: 111.96, arrives: null, borrowLeft: null },
      { round: 1, planned: 111.96, arrives: null, borrowLeft: null },
    ]);
    expect(job.steps[0]).toMatchObject({ name: 'Buy USDC', venueId: 'o1', qty: 111.96, status: 'done' });
    expect(bannerFor(job)).toBe('Rebalance stopped in round 1.');
  });

  it('parses a done convert job with round null and no cost', () => {
    const d = dir();
    writeRaw(d, 'rebalance.json', {
      id: 'mfhq1x2k',
      userId: '1',
      direction: 'toUsdt',
      route: 'convert',
      amount: 12,
      status: 'done',
      stepIndex: 0,
      steps: [step160('Convert', { quoteId: 'q3', venueId: 'c3', qty: 11.98, status: 'done' })],
      fundsAt: 'CROSSEX',
      haltReason: null,
      createdAt: 1,
      updatedAt: 2,
    });

    const job = new JobFile(d).read()!;

    expect(job).toMatchObject({ route: 'convert', status: 'done', costUsd: null, target: null });
    expect(job.steps[0]).toMatchObject({ name: 'Convert', round: null, planned: 12, arrives: null, borrowLeft: null });
  });

  it('still parses the names from before 1.5.1: pull, payDown and Pull from Hyperliquid', () => {
    const d = dir();
    writeRaw(d, 'rebalance.json', {
      id: 'a',
      direction: 'pull',
      route: 'loop',
      amount: 12,
      status: 'halted',
      stepIndex: 0,
      steps: [step160('Pull from Hyperliquid'), step160('To Gate'), step160('Sell USDC')],
      fundsAt: 'HYPERLIQUID',
      haltReason: 'server restarted',
      createdAt: 1,
      updatedAt: 2,
    });

    const pulled = new JobFile(d).read()!;

    expect(pulled).toMatchObject({ userId: null, direction: 'toUsdt', costUsd: null, target: null });
    expect(pulled.steps.map((s) => [s.name, s.round, s.planned])).toEqual([
      ['From Hyperliquid', 1, 12],
      ['To Gate', 1, 12],
      ['Sell USDC', 1, 12],
    ]);

    const e = dir();
    writeRaw(e, 'rebalance.json', { ...JSON.parse(fs.readFileSync(path.join(d, 'rebalance.json'), 'utf8')), direction: 'payDown', steps: [step160('Convert')] });
    expect(new JobFile(e).read()).toMatchObject({ direction: 'toUsdc' });
  });

  it('reads null and says so once when a step is not an object', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const d = dir();
      writeRaw(d, 'rebalance.json', { ...accountAJob(), steps: [null] });
      const jobs = new JobFile(d);

      expect(jobs.read()).toBeNull();
      expect(jobs.read()).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('rebalance.json at');
    } finally {
      error.mockRestore();
    }
  });
});

describe('bannerFor', () => {
  it('says the round and the USDC in Gate spot', () => {
    const job = stopAt(accountAJob(), 8, { status: 'halted', fundsAt: 'SPOT' });

    expect(bannerFor(job)).toBe('Rebalance stopped in round 3. 36.58 USDC is in Gate spot.');
  });

  it('says the round alone when the money is inside CrossEx', () => {
    const job = stopAt(accountAJob(), 7, { status: 'halted', fundsAt: 'GATE' });

    expect(bannerFor(job)).toBe('Rebalance stopped in round 3.');
  });

  it('says what landed in Gate spot toward USDT', () => {
    const job = stopAt(exampleEJob(), 1, { status: 'halted', fundsAt: 'SPOT' });
    job.steps[0].qty = 744.44;

    expect(bannerFor(job)).toBe('Rebalance stopped in round 1. 744.44 USDC is in Gate spot.');
  });

  it('says Convert at a Convert step', () => {
    const job = stopAt(exampleEJob(), 3, { status: 'halted', fundsAt: 'CROSSEX' });

    expect(bannerFor(job)).toBe('Rebalance stopped at Convert.');
  });
});

describe('inTransitOf', () => {
  it('is the last done step qty while the money sits in Gate spot on a running, halted or abandoned job', () => {
    for (const status of ['running', 'halted', 'abandoned'] as const) {
      const job = stopAt(accountAJob(), 8, { status, fundsAt: 'SPOT' });
      expect(inTransitOf(job)).toEqual({ coin: 'USDC', qty: 36.58 });
    }
  });

  it('is null on a done job or with the money elsewhere', () => {
    expect(inTransitOf(stopAt(accountAJob(), 8, { status: 'done', fundsAt: 'SPOT' }))).toBeNull();
    expect(inTransitOf(stopAt(accountAJob(), 7, { status: 'halted', fundsAt: 'GATE' }))).toBeNull();
    expect(inTransitOf(accountAJob())).toBeNull();
  });
});

describe('transferLockFor', () => {
  it('a halted job locks as halted, a running job as rebalance, then a working deal', () => {
    const halted = { ...accountAJob(), status: 'halted' as const };
    const running = accountAJob();
    const abandoned = { ...accountAJob(), status: 'abandoned' as const };
    const done = { ...accountAJob(), status: 'done' as const };

    expect(transferLockFor({ rebalance: halted, dealWorking: true })).toBe('halted');
    expect(transferLockFor({ rebalance: running, dealWorking: true })).toBe('rebalance');
    expect(transferLockFor({ rebalance: done, dealWorking: true })).toBe('deal');
    expect(transferLockFor({ rebalance: null, dealWorking: true })).toBe('deal');
    expect(transferLockFor({ rebalance: abandoned, dealWorking: false })).toBeNull();
    expect(transferLockFor({ rebalance: null, dealWorking: false })).toBeNull();
  });
});

describe('TransferFile', () => {
  const moving = () =>
    newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, 1_000_000);

  it('a new transfer is moving with its tag and nothing sent', () => {
    const id = (1_000_000).toString(36);

    expect(moving()).toEqual({
      id,
      userId: '1',
      coin: 'USDC',
      from: 'CROSSEX_HYPERLIQUID',
      to: 'SPOT',
      amount: 11.88,
      status: 'moving',
      text: `t-tr${id}`,
      venueId: null,
      sentAt: null,
      acceptedAt: null,
      received: null,
      failText: null,
      createdAt: 1_000_000,
      doneAt: null,
      updatedAt: 1_000_000,
    });
  });

  it('writes an owner-only transfer.json beside rebalance.json that a new TransferFile reads back', () => {
    const d = dir();
    new JobFile(d).write(accountAJob());
    const transfers = new TransferFile(d, () => 42);
    const transfer = moving();

    transfers.write(transfer);

    const file = path.join(d, 'transfer.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(d).sort()).toEqual(['rebalance.json', 'transfer.json']);
    expect(transfer.updatedAt).toBe(42);
    expect(new TransferFile(d).read()).toEqual(transfer);
    expect(new JobFile(d).read()).toMatchObject({ route: 'loop' });
  });

  it('reads null when there is no file, and null once when the file is not a transfer', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(new TransferFile(dir()).read()).toBeNull();
      expect(error).not.toHaveBeenCalled();

      const d = dir();
      writeRaw(d, 'transfer.json', '{not json');
      const transfers = new TransferFile(d);
      expect(transfers.read()).toBeNull();
      expect(transfers.read()).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('transfer.json at');

      writeRaw(d, 'transfer.json', { ...moving(), status: 'sent' });
      expect(new TransferFile(d).read()).toBeNull();
      writeRaw(d, 'transfer.json', { ...moving(), amount: '11.88' });
      expect(new TransferFile(d).read()).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});
