import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlannedStep, WalletAfter } from '../../src/core/rebalance/plan';
import { type RealizeLeg, realizeEstimateOf } from '../../src/core/rebalance/realize';
import {
  bannerFor,
  haltReasonFor,
  inTransitOf,
  JobFile,
  newJob,
  newTransferJob,
  pendingStep,
  REOPEN_HALT,
  spotShortfallFailText,
  transferFailText,
  TransferFile,
  transferLockFor,
  type Job,
} from '../../src/server/rebalanceJob';
import { tagFor } from '../../src/server/rebalanceRunner';

const dir = () => fs.mkdtempSync(path.join(tmpdir(), 'rebalance-'));

const gateError = (status: number, label: string, message: string) =>
  Object.assign(new Error(message), { response: { status, data: { label, message } } });

type Planned = Omit<PlannedStep, 'from' | 'to'>;
const TO_HYPERLIQUID = { from: 'CROSSEX', to: 'HYPERLIQUID' } as const;
const FROM_HYPERLIQUID = { from: 'HYPERLIQUID', to: 'CROSSEX' } as const;

const accountALoop: Planned[] = [
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

const exampleEMix: Planned[] = [
  { round: 1, kind: 'round', buy: 0, move: 745.44, arrives: 744.44, borrowLeft: 0, seconds: 400 },
  { round: null, kind: 'convert', buy: 0, move: 482.83, arrives: 481.86, borrowLeft: 0, seconds: 0 },
];

const accountAJob = (): Job =>
  newJob(
    {
      route: 'loop',
      steps: accountALoop.map((step) => ({ ...step, ...TO_HYPERLIQUID })),
      amount: 175.88,
      costUsd: 0.26,
      target: accountATarget,
      userId: '1',
    },
    1_000_000,
  );

const exampleEJob = (): Job =>
  newJob(
    {
      route: 'mix',
      steps: exampleEMix.map((step) => ({ ...step, ...FROM_HYPERLIQUID })),
      amount: 1228.27,
      costUsd: 2.04,
      target: [],
      userId: '1',
    },
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

    expect(haltReasonFor(refused)).toBe('Gate refused the move: free margin or wallet cash is too low.');
  });

  it('halt text for restart', () => {
    const d = dir();
    const jobs = new JobFile(d);
    jobs.write(accountAJob());

    expect(jobs.haltIfRunning()).toBe(true);

    expect(jobs.read()).toMatchObject({ status: 'halted', haltReason: 'The app restarted during the run. Nothing failed. Press Resume.' });
    expect(new JobFile(d).read()).toMatchObject({
      status: 'halted',
      haltReason: 'The app restarted during the run. Nothing failed. Press Resume.',
    });
    expect(jobs.haltIfRunning()).toBe(false);

    jobs.write({ ...accountAJob(), status: 'done' });
    expect(jobs.haltIfRunning()).toBe(false);
    expect(jobs.read()).toMatchObject({ status: 'done', haltReason: null });
    expect(new JobFile(dir()).haltIfRunning()).toBe(false);
  });

  it('any other error halts with its message, and the hint after it when there is one', () => {
    expect(haltReasonFor(gateError(400, 'TRADE_INVALID_QUOTE_ORDER_QTY', 'quote qty is required'))).toBe(
      'Quote qty is required.',
    );
    expect(haltReasonFor(gateError(401, 'INVALID_KEY', 'invalid key'))).toBe(
      'Gate refused the API key. Check it in Settings.',
    );
    expect(haltReasonFor(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('a refused key reads the same with or without a Gate label', () => {
    const bare401 = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });

    expect(haltReasonFor(bare401)).toBe('Gate refused the API key. Check it in Settings.');
    expect(haltReasonFor(gateError(400, 'INVALID_KEY', 'invalid key'))).toBe('Gate refused the API key. Check it in Settings.');
  });

  it('a message and its hint always have a period between them', () => {
    const bare403 = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });

    expect(haltReasonFor(bare403)).toBe('Request failed with status code 403. Check the Gate API key and secret in Settings.');
    expect(haltReasonFor(gateError(403, 'FORBIDDEN', 'forbidden.'))).toBe('Forbidden. Check the Gate API key and secret in Settings.');
  });

  it('no halt text carries the raw Gate error prefix', () => {
    const errors = [
      gateError(400, 'TRADE_INVALID_QUOTE_ORDER_QTY', 'quote qty is required'),
      gateError(401, 'INVALID_KEY', 'invalid key'),
      gateError(422, 'TRANSFER_AMOUNT_MINTRANS_INVALID_ERROR', 'The Minimum amount needs to be greater than 11.'),
      gateError(500, 'SERVER_ERROR', 'internal error'),
    ];

    for (const err of errors) expect(haltReasonFor(err)).not.toMatch(/Gate API error|HTTP \d|\[[A-Z_]+\]/);
  });

  it("a transfer below Gate's minimum halts with the minimum Gate sent", () => {
    const refused = gateError(422, 'TRANSFER_AMOUNT_MINTRANS_INVALID_ERROR', 'The Minimum amount needs to be greater than 11.');

    expect(haltReasonFor(refused)).toBe("Below Gate's minimum of 11.");
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

  it('shortfall text reads commas, exponents and sub-cent amounts', () => {
    const shortfall = (available: string): string =>
      spotShortfallFailText(`Insufficient transferAvailable, transferAvailable: ${available}`, 'USDT', 5000);

    expect(shortfall('1,234.56')).toBe('Gate spot has only 1,234.56 USDT.');
    expect(shortfall('1.2e-5')).toBe('Gate spot has less than 0.01 USDT.');
    expect(shortfall('0.004')).toBe('Gate spot has less than 0.01 USDT.');
  });
});

describe('newJob', () => {
  it('expands each round toward USDC into buy, to spot and to the Hyperliquid wallet', () => {
    const job = accountAJob();

    expect(job).toMatchObject({
      id: (1_000_000).toString(36),
      userId: '1',
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
      { name: 'Buy USDC', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: 4, planned: 23.77, arrives: null, borrowLeft: null, from: 'CROSSEX', to: 'HYPERLIQUID', phase: 'route' },
      { name: 'To spot', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: 4, planned: 44.71, arrives: null, borrowLeft: null, from: 'CROSSEX', to: 'HYPERLIQUID', phase: 'route' },
      { name: 'To Hyperliquid', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: 4, planned: 44.71, arrives: 44.66, borrowLeft: 11.53, from: 'CROSSEX', to: 'HYPERLIQUID', phase: 'route' },
    ]);
    expect(job.steps[0]).toMatchObject({ name: 'Buy USDC', planned: 0 });
  });

  it('expands a round toward USDT into out of the Hyperliquid wallet, to Gate and sell, then Convert', () => {
    const job = exampleEJob();

    expect(job).toMatchObject({ route: 'mix', amount: 1228.27, costUsd: 2.04, fundsAt: 'HYPERLIQUID' });
    expect(job.steps.every((step) => step.from === 'HYPERLIQUID' && step.to === 'CROSSEX')).toBe(true);
    expect(job.steps.map(({ name, round, planned, arrives, borrowLeft }) => ({ name, round, planned, arrives, borrowLeft }))).toEqual([
      { name: 'From Hyperliquid', round: 1, planned: 745.44, arrives: null, borrowLeft: null },
      { name: 'To Gate', round: 1, planned: 744.44, arrives: null, borrowLeft: null },
      { name: 'Sell USDC', round: 1, planned: 744.44, arrives: null, borrowLeft: 0 },
      { name: 'Convert', round: null, planned: 482.83, arrives: null, borrowLeft: null },
    ]);
  });

  it('a convert-only job is one Convert step', () => {
    const convert: PlannedStep = { round: null, kind: 'convert', buy: 0, move: 175.94, arrives: 175.58, borrowLeft: 0, seconds: 0, ...TO_HYPERLIQUID };

    const job = newJob({ route: 'convert', steps: [convert], amount: 175.94, costUsd: 0.36, target: [], userId: null }, 7);

    expect(job.steps).toEqual([
      { name: 'Convert', text: null, quoteId: null, venueId: null, qty: null, attempt: 0, status: 'pending', startedAt: null, doneAt: null, round: null, planned: 175.94, arrives: null, borrowLeft: null, from: 'CROSSEX', to: 'HYPERLIQUID', phase: 'route' },
    ]);
    expect(job.fundsAt).toBe('CROSSEX');
  });

  it('expands a move from Hyperliquid to Lighter into out of one wallet and into the other, and its Convert into two halves', () => {
    const across = { from: 'HYPERLIQUID', to: 'LIGHTER' } as const;
    const steps: PlannedStep[] = [
      { round: 1, kind: 'round', buy: 0, move: 401.01, arrives: 398.98, borrowLeft: 0, seconds: 625, ...across },
      { round: null, kind: 'convert', buy: 0, move: 400.8, arrives: 399.19, borrowLeft: 0, seconds: 0, ...across },
    ];

    const job = newJob({ route: 'mix', steps, amount: 801.81, costUsd: 3.63, target: [], userId: null }, 7);

    expect(job.fundsAt).toBe('HYPERLIQUID');
    expect(job.steps.every((step) => step.from === 'HYPERLIQUID' && step.to === 'LIGHTER')).toBe(true);
    expect(job.steps.map(({ name, round, planned, arrives, borrowLeft }) => ({ name, round, planned, arrives, borrowLeft }))).toEqual([
      { name: 'From Hyperliquid', round: 1, planned: 401.01, arrives: null, borrowLeft: null },
      { name: 'To Lighter', round: 1, planned: 400.01, arrives: 398.98, borrowLeft: 0 },
      { name: 'Convert to USDT', round: null, planned: 400.8, arrives: null, borrowLeft: null },
      { name: 'Convert to USDC', round: null, planned: 399.99, arrives: null, borrowLeft: null },
    ]);
  });

  it('expands a round into Lighter and a round out of Lighter through Gate spot', () => {
    const into: PlannedStep = { round: 1, kind: 'round', buy: 5, move: 30, arrives: 28.97, borrowLeft: 0, seconds: 235, from: 'CROSSEX', to: 'LIGHTER' };
    const out: PlannedStep = { round: 2, kind: 'round', buy: 0, move: 20, arrives: 20, borrowLeft: 0, seconds: 185, from: 'LIGHTER', to: 'CROSSEX' };

    const job = newJob({ route: 'loop', steps: [into, out], amount: 50, costUsd: 1.1, target: [], userId: null }, 7);

    expect(job.steps.map(({ name, round, planned, arrives, from, to }) => ({ name, round, planned, arrives, from, to }))).toEqual([
      { name: 'Buy USDC', round: 1, planned: 5, arrives: null, from: 'CROSSEX', to: 'LIGHTER' },
      { name: 'To spot', round: 1, planned: 30, arrives: null, from: 'CROSSEX', to: 'LIGHTER' },
      { name: 'To Lighter', round: 1, planned: 30, arrives: 28.97, from: 'CROSSEX', to: 'LIGHTER' },
      { name: 'From Lighter', round: 2, planned: 20, arrives: null, from: 'LIGHTER', to: 'CROSSEX' },
      { name: 'To Gate', round: 2, planned: 20, arrives: null, from: 'LIGHTER', to: 'CROSSEX' },
      { name: 'Sell USDC', round: 2, planned: 20, arrives: null, from: 'LIGHTER', to: 'CROSSEX' },
    ]);
  });
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
  realizedUsd: 34386,
  convert: { amount: 10298, count: 1, feeUsd: 20.6 },
  closeFeeUsd: 51.2,
  closeMakerFeeUsd: 21.94,
  reopenFeeUsd: 51.19,
  closeImpactUsd: 9.44,
  reopenImpactUsd: 9.44,
  impactBp: 1.9,
  ...over,
});

const gateLong = (over: Partial<RealizeLeg> = {}): RealizeLeg =>
  realizeLeg({ pool: 'CROSSEX', symbol: GATE_ETH, exchange: 'GATE', side: 'LONG', qty: 47.1, convert: { amount: 8000, count: 1, feeUsd: 16 }, ...over });

const ownerRoute: PlannedStep[] = [
  { round: 1, kind: 'round', buy: 0, move: 27228, arrives: 27200, borrowLeft: 0, seconds: 900, ...FROM_HYPERLIQUID },
];

const realizeJob = (legs: RealizeLeg[], steps: PlannedStep[] = ownerRoute): Job =>
  newJob(
    {
      route: 'loop',
      steps,
      amount: 37526,
      costUsd: 127.27,
      target: [],
      userId: '1',
      realize: {
        legs,
        refused: null,
        estimates: { maker: realizeEstimateOf({ legs }, 'maker'), market: realizeEstimateOf({ legs }, 'market') },
      },
    },
    4_000_000,
  );

const shape = (job: Job) => job.steps.map((step) => [step.name, step.from, step.to, step.planned]);

const closedAt = (job: Job, filled: number, stepIndex: number): Job => {
  Object.assign(job.steps[0], { status: 'done', qty: filled, text: 't-rb1', venueId: 'o1' });
  job.realize!.legs[0].filledQty = filled;
  return Object.assign(job, { status: 'halted', stepIndex });
};

describe('close and reopen job', () => {
  it('writes close, convert, reopen before the route', () => {
    const job = realizeJob([realizeLeg()]);

    expect(shape(job)).toEqual([
      ['Close', 'HYPERLIQUID', 'HYPERLIQUID', 53.8],
      ['Convert', 'HYPERLIQUID', 'CROSSEX', 10298],
      ['Reopen', 'HYPERLIQUID', 'HYPERLIQUID', 53.8],
      ['From Hyperliquid', 'HYPERLIQUID', 'CROSSEX', 27228],
      ['To Gate', 'HYPERLIQUID', 'CROSSEX', 27200],
      ['Sell USDC', 'HYPERLIQUID', 'CROSSEX', 27200],
    ]);
    expect(job.steps[0]).toMatchObject({
      round: null,
      status: 'pending',
      perp: { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'BUY', reduceOnly: true },
      nextTryAt: null,
      retry: null,
    });
    expect(job.steps[2]).toMatchObject({
      perp: { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SELL', reduceOnly: false },
      nextTryAt: null,
      retry: null,
    });
    expect(job.realize).toEqual({
      legs: [{ symbol: HL_ETH, base: 'ETH', exchange: 'HYPERLIQUID', pool: 'HYPERLIQUID', side: 'SHORT', positionQty: 66, qty: 53.8, filledQty: 0, realizedUsd: 0, hedge: null, closeFeeUsd: 51.2, reopenFeeUsd: 51.19, closeImpactUsd: 9.44, reopenImpactUsd: 9.44, convert: { amount: 10298, feeUsd: 20.6 } }],
      costUsd: 0,
    });
    expect(job).toMatchObject({ status: 'running', stepIndex: 0, fundsAt: 'HYPERLIQUID' });
  });

  it('a realize with no route steps is the leg alone, and no Convert when the leg needs none', () => {
    expect(shape(realizeJob([realizeLeg()], [])).map(([name]) => name)).toEqual(['Close', 'Convert', 'Reopen']);
    const small = realizeJob([realizeLeg({ positionQty: 0.05, qty: 0.02, realizedUsd: 12.4, convert: null })], []);

    expect(shape(small)).toEqual([
      ['Close', 'HYPERLIQUID', 'HYPERLIQUID', 0.02],
      ['Reopen', 'HYPERLIQUID', 'HYPERLIQUID', 0.02],
    ]);
    expect(small.fundsAt).toBe('HYPERLIQUID');
  });

  it('a Gate long closes with a sell, reopens with a buy, and converts toward USDC · Hyperliquid', () => {
    const job = realizeJob([gateLong()], []);

    expect(shape(job)).toEqual([
      ['Close', 'CROSSEX', 'CROSSEX', 47.1],
      ['Convert', 'CROSSEX', 'HYPERLIQUID', 8000],
      ['Reopen', 'CROSSEX', 'CROSSEX', 47.1],
    ]);
    expect(job.steps[0].perp).toEqual({ symbol: GATE_ETH, exchange: 'GATE', side: 'SELL', reduceOnly: true });
    expect(job.steps[2].perp).toEqual({ symbol: GATE_ETH, exchange: 'GATE', side: 'BUY', reduceOnly: false });
    expect(job.fundsAt).toBe('CROSSEX');
  });

  it('a $6M realize splits its Convert at 500,000, and each leg runs whole before the next', () => {
    const big = realizeLeg({ positionQty: 3300, qty: 3000, realizedUsd: 1_917_000, convert: { amount: 1_917_000, count: 4, feeUsd: 3834 } });
    const btc = realizeLeg({ symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', base: 'BTC', positionQty: 1.2, qty: 0.4, convert: null });

    const job = realizeJob([big, btc]);
    const converts = job.steps.filter((step) => step.name === 'Convert');

    expect(job.steps.map((step) => step.name)).toEqual([
      'Close', 'Convert', 'Convert', 'Convert', 'Convert', 'Reopen', 'Close', 'Reopen', 'From Hyperliquid', 'To Gate', 'Sell USDC',
    ]);
    expect(converts.every((step) => step.planned! <= 500_000)).toBe(true);
    expect(Math.round(converts.reduce((sum, step) => sum + step.planned!, 0) * 100)).toBe(191_700_000);
    expect(job.steps[6].perp?.symbol).toBe('HYPERLIQUID_FUTURE_BTC_USDC');
    expect(job.realize!.legs.map((leg) => [leg.symbol, leg.qty])).toEqual([[HL_ETH, 3000], ['HYPERLIQUID_FUTURE_BTC_USDC', 0.4]]);
  });

  it('survives write and read, with a filled close and a reopen retry on disk', () => {
    const d = dir();
    const job = closedAt(realizeJob([realizeLeg()]), 53.8, 2);
    Object.assign(job.steps[2], { attempt: 2, nextTryAt: 4_008_000, retry: { reason: 'margin', convertAmount: 1500 } });
    new JobFile(d).write(job);

    const read = new JobFile(d).read()!;

    expect(read).toMatchObject(JSON.parse(JSON.stringify(job)));
    expect(read.steps.slice(3).every((step) => step.perp === null && step.nextTryAt === null && step.retry === null)).toBe(true);
  });

  it('an old job file without realize still parses, with no perp, wait or retry on its steps', () => {
    const d = dir();
    const old: Partial<Job> = accountAJob();
    delete old.realize;
    writeRaw(d, 'rebalance.json', old);

    const read = new JobFile(d).read()!;

    expect(read.realize).toBeNull();
    expect(read.steps).toHaveLength(15);
    expect(read.steps.every((step) => step.perp === null && step.nextTryAt === null && step.retry === null)).toBe(true);
  });

  it('reads null for a same-wallet step that is not a close or reopen, a close with no perp, or a close with no realize', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bad: ((job: Job) => void)[] = [
        (job) => Object.assign(job.steps[1], { to: 'HYPERLIQUID' }),
        (job) => Object.assign(job.steps[0], { perp: null }),
        (job) => Object.assign(job, { realize: null }),
        (job) => Object.assign(job, { realize: { legs: 'ETH' } }),
      ];
      for (const edit of bad) {
        const job = realizeJob([realizeLeg()]);
        edit(job);
        const d = dir();
        writeRaw(d, 'rebalance.json', job);
        expect(new JobFile(d).read()).toBeNull();
      }
    } finally {
      error.mockRestore();
    }
  });
});

describe('reopen halt texts', () => {
  const leg = realizeLeg();

  it('stops the reopen on lost trade permission', () => {
    expect(REOPEN_HALT.tradePermission).toBe('The API key cannot trade. Fix it in Settings, then Resume.');
  });

  it('stops the reopen on a close-only contract', () => {
    expect(REOPEN_HALT.closeOnly(leg, 53.8)).toBe(
      'Gate CrossEx takes no new orders on this contract. Resume when it does, or close 53.8 ETH of the Gate long in Positions.',
    );
  });

  it('stops the reopen when no cash is left', () => {
    expect(REOPEN_HALT.noCash).toBe('Not enough margin, and no cash left to convert. Move USDT into USDT · CrossEx, then Resume.');
  });

  it('stops on the quote limit with the leg open', () => {
    expect(REOPEN_HALT.quotesUsedLegOpen(leg, 53.8)).toBe(
      "Gate's 100 Convert quotes for today are used up. The Hyperliquid short is 53.8 ETH smaller than the Gate long. Resume after Gate's count clears, within 24 hours, or close 53.8 ETH of the Gate long in Positions.",
    );
  });

  it('a Gate long names the Hyperliquid short, and a part reopen names what is left', () => {
    expect(REOPEN_HALT.closeOnly(gateLong(), 47.1)).toBe(
      'Gate CrossEx takes no new orders on this contract. Resume when it does, or close 47.1 ETH of the Hyperliquid short in Positions.',
    );
    expect(REOPEN_HALT.quotesUsedLegOpen(leg, 53.8 - 30)).toContain('The Hyperliquid short is 23.8 ETH smaller than the Gate long.');
    expect(REOPEN_HALT.closeOnly(realizeLeg({ base: 'ETH' }), 3300)).toContain('close 3,300 ETH of the Gate long');
  });
});

describe('1.6.2 job file', () => {
  const lighterJob = (): Job =>
    newJob(
      {
        route: 'loop',
        steps: [
          { round: 1, kind: 'round', buy: 0, move: 30, arrives: 28.97, borrowLeft: 0, seconds: 235, from: 'CROSSEX', to: 'LIGHTER' },
          { round: 2, kind: 'round', buy: 0, move: 20, arrives: 20, borrowLeft: 0, seconds: 185, from: 'LIGHTER', to: 'CROSSEX' },
        ],
        amount: 50,
        costUsd: 1.03,
        target: [],
        userId: '1',
      },
      3_000_000,
    );

  it('reads back a job with moves into and out of Lighter, funds at Lighter', () => {
    const d = dir();
    new JobFile(d).write(stopAt(lighterJob(), 3, { status: 'halted', fundsAt: 'LIGHTER' }));

    const job = new JobFile(d).read()!;

    expect(job).toMatchObject({ status: 'halted', stepIndex: 3, fundsAt: 'LIGHTER' });
    expect(job).not.toHaveProperty('direction');
    expect(job.steps.map((step) => [step.name, step.from, step.to])).toEqual([
      ['Buy USDC', 'CROSSEX', 'LIGHTER'],
      ['To spot', 'CROSSEX', 'LIGHTER'],
      ['To Lighter', 'CROSSEX', 'LIGHTER'],
      ['From Lighter', 'LIGHTER', 'CROSSEX'],
      ['To Gate', 'LIGHTER', 'CROSSEX'],
      ['Sell USDC', 'LIGHTER', 'CROSSEX'],
    ]);
  });

  it('reads null when a step lacks one wallet, names an unknown wallet, or has the same wallet at both ends', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bad = [
        { from: undefined },
        { from: 'CROSSEX', to: 'BINANCE' },
        { from: 'LIGHTER', to: 'LIGHTER' },
      ];
      for (const wallets of bad) {
        const job = lighterJob();
        Object.assign(job.steps[1], wallets);
        const d = dir();
        writeRaw(d, 'rebalance.json', job);
        expect(new JobFile(d).read()).toBeNull();
      }
    } finally {
      error.mockRestore();
    }
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

    expect(pulled).toMatchObject({ userId: null, costUsd: null, target: null });
    expect(pulled).not.toHaveProperty('direction');
    expect(pulled.steps.every((step) => step.from === 'HYPERLIQUID' && step.to === 'CROSSEX')).toBe(true);
    expect(pulled.steps.map((s) => [s.name, s.round, s.planned])).toEqual([
      ['From Hyperliquid', 1, 12],
      ['To Gate', 1, 12],
      ['Sell USDC', 1, 12],
    ]);

    const e = dir();
    writeRaw(e, 'rebalance.json', { ...JSON.parse(fs.readFileSync(path.join(d, 'rebalance.json'), 'utf8')), direction: 'payDown', steps: [step160('Convert')] });
    expect(new JobFile(e).read()!.steps[0]).toMatchObject({ name: 'Convert', from: 'CROSSEX', to: 'HYPERLIQUID' });
  });

  it('a file with no tag count starts past every tag the old scheme made', () => {
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
        step160('Buy USDC', { text: 't-rbmfhq1x2k0', venueId: 'o1', qty: 111.96, status: 'done' }),
        step160('To spot', { attempt: 1, status: 'running', startedAt: 1_757_700_003_000 }),
        step160('To Hyperliquid'),
      ],
      fundsAt: 'GATE',
      haltReason: 'Gate took too long on this step.',
      createdAt: 1_757_700_000_000,
      updatedAt: 1_757_700_004_000,
    });

    expect(new JobFile(d).read()!.tagCount).toBe(3);
    expect(accountAJob().tagCount).toBe(0);

    const { tagCount: _tagCount, ...fifteenSteps } = stopAt(accountAJob(), 14, { status: 'halted', fundsAt: 'SPOT' });
    const e = dir();
    writeRaw(e, 'rebalance.json', fifteenSteps);
    const old = new JobFile(e).read()!;
    const oldTags = old.steps.flatMap((_, index) =>
      [0, 1, 2, 3, 11].map((attempt) => (attempt > 0 ? `t-rb${old.id}${index}x${attempt}` : `t-rb${old.id}${index}`)),
    );
    const newTags = Array.from({ length: 200 }, (_, n) => tagFor(old.id, old.tagCount + 1 + n));
    expect(old.tagCount).toBe(15);
    expect(newTags.filter((tag) => oldTags.includes(tag))).toEqual([]);
  });

  it('reads null when the tag count is not a whole number of 0 or more', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const tagCount of [-1, 1.5, '2']) {
        const d = dir();
        writeRaw(d, 'rebalance.json', { ...accountAJob(), tagCount });
        expect(new JobFile(d).read()).toBeNull();
      }
    } finally {
      error.mockRestore();
    }
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

  it('says Sell USDC at a Sell USDC step put in before Convert', () => {
    const job = exampleEJob();
    job.steps.splice(3, 0, pendingStep('Sell USDC', { round: null, planned: 20.93, arrives: null, borrowLeft: null, ...FROM_HYPERLIQUID }));
    stopAt(job, 3, { status: 'halted', fundsAt: 'CROSSEX' });

    expect(bannerFor(job)).toBe('Rebalance stopped at Sell USDC.');
  });

  it('says where Gate is taking the USDC while a move is on the way', () => {
    const fromHyperliquid = stopAt(exampleEJob(), 0, { status: 'halted', fundsAt: 'HYPERLIQUID' });
    Object.assign(fromHyperliquid.steps[0], { venueId: 'x1', status: 'running' });
    const toHyperliquid = stopAt(accountAJob(), 8, { status: 'halted', fundsAt: 'SPOT' });
    Object.assign(toHyperliquid.steps[8], { venueId: 'x9', status: 'running' });
    const toGate = stopAt(exampleEJob(), 1, { status: 'halted', fundsAt: 'SPOT' });
    toGate.steps[0].qty = 744.44;
    Object.assign(toGate.steps[1], { venueId: 'x2', status: 'running' });

    expect(bannerFor(fromHyperliquid)).toBe('Rebalance stopped in round 1. 745.44 USDC is on the way to Gate spot.');
    expect(bannerFor(toHyperliquid)).toBe('Rebalance stopped in round 3. 36.58 USDC is on the way to USDC · Hyperliquid.');
    expect(bannerFor(toGate)).toBe('Rebalance stopped in round 1. 744.44 USDC is on the way to USDC · Gate.');
  });

  it('says Gate spot out of Lighter and USDC · Lighter into it', () => {
    const planned: PlannedStep[] = [
      { round: 1, kind: 'round', buy: 0, move: 401.01, arrives: 398.98, borrowLeft: 0, seconds: 625, from: 'HYPERLIQUID', to: 'LIGHTER' },
      { round: 2, kind: 'round', buy: 0, move: 60, arrives: 60, borrowLeft: 0, seconds: 305, from: 'LIGHTER', to: 'HYPERLIQUID' },
    ];
    const across = () => newJob({ route: 'loop', steps: planned, amount: 461.01, costUsd: 2.08, target: [], userId: null }, 9);
    const intoLighter = stopAt(across(), 1, { status: 'halted', fundsAt: 'SPOT' });
    Object.assign(intoLighter.steps[1], { venueId: 'x2', status: 'running' });
    const outOfLighter = stopAt(across(), 2, { status: 'halted', fundsAt: 'LIGHTER' });
    Object.assign(outOfLighter.steps[2], { venueId: 'x3', status: 'running' });

    expect(bannerFor(intoLighter)).toBe('Rebalance stopped in round 1. 401.01 USDC is on the way to USDC · Lighter.');
    expect(bannerFor(outOfLighter)).toBe('Rebalance stopped in round 2. 60.00 USDC is on the way to Gate spot.');
    expect(bannerFor(stopAt(across(), 2, { status: 'halted', fundsAt: 'LIGHTER' }))).toBe('Rebalance stopped in round 2.');
  });

  it('never throws on a job with no current step', () => {
    const job = { ...exampleEJob(), stepIndex: 4 };

    expect(bannerFor(job)).toBe('Rebalance stopped.');
    expect(bannerFor({ ...exampleEJob(), steps: [] })).toBe('Rebalance stopped.');
  });

  it('says it stopped before the close when no close was sent', () => {
    const job = Object.assign(realizeJob([realizeLeg()]), { status: 'halted' });

    expect(bannerFor(job)).toBe('Rebalance stopped before the close.');
  });

  it('says a sent close stopped at Close, since Gate may have filled it', () => {
    const job = Object.assign(realizeJob([realizeLeg()]), { status: 'halted' });
    Object.assign(job.steps[0], { status: 'running', text: 't-rb1' });

    expect(bannerFor(job)).toBe('Rebalance stopped at Close.');
  });

  it('names the leg gap at the reopen and at the Convert before it', () => {
    expect(bannerFor(closedAt(realizeJob([realizeLeg()]), 53.8, 2))).toBe(
      'Rebalance stopped. Hyperliquid short is 53.8 ETH smaller than the Gate long.',
    );
    expect(bannerFor(closedAt(realizeJob([realizeLeg()]), 30, 1))).toBe(
      'Rebalance stopped. Hyperliquid short is 30 ETH smaller than the Gate long.',
    );
    const part = closedAt(realizeJob([gateLong()]), 47.1, 2);
    Object.assign(part.steps[2], { status: 'running', qty: 20 });

    expect(bannerFor(part)).toBe('Rebalance stopped. Gate long is 27.1 ETH smaller than the Hyperliquid short.');
  });

  it('reads as a route stop once the reopen is done', () => {
    const job = closedAt(realizeJob([realizeLeg()]), 53.8, 3);
    for (const step of job.steps.slice(1, 3)) Object.assign(step, { status: 'done', qty: step.planned });

    expect(bannerFor(job)).toBe('Rebalance stopped in round 1.');
  });
});

describe('inTransitOf', () => {
  it('is the last done step qty while the money sits in Gate spot on a running, halted or abandoned job', () => {
    for (const status of ['running', 'halted', 'abandoned'] as const) {
      const job = stopAt(accountAJob(), 8, { status, fundsAt: 'SPOT' });
      expect(inTransitOf(job)).toEqual({ coin: 'USDC', qty: 36.58, at: 'SPOT' });
    }
  });

  it('toward USDT is the sent amount while Gate moves it out of the Hyperliquid wallet', () => {
    const job = stopAt(exampleEJob(), 0, { status: 'running', fundsAt: 'HYPERLIQUID' });
    Object.assign(job.steps[0], { venueId: 'x1', status: 'running' });

    expect(inTransitOf(job)).toEqual({ coin: 'USDC', qty: 745.44, at: 'MOVING' });
  });

  it('toward USDC is the sent amount while Gate moves it into the Hyperliquid wallet', () => {
    for (const status of ['running', 'halted', 'abandoned'] as const) {
      const job = stopAt(accountAJob(), 8, { status, fundsAt: 'SPOT' });
      Object.assign(job.steps[8], { venueId: 'x9', status: 'running' });

      expect(inTransitOf(job)).toEqual({ coin: 'USDC', qty: 36.58, at: 'MOVING' });
    }
  });

  it('is not on the way before Gate takes the move, and sits in Gate spot once it lands', () => {
    const sentNothing = stopAt(exampleEJob(), 0, { status: 'halted', fundsAt: 'HYPERLIQUID' });
    sentNothing.steps[0].text = 't-rbtag1';
    const landed = stopAt(exampleEJob(), 1, { status: 'halted', fundsAt: 'SPOT' });
    Object.assign(landed.steps[0], { venueId: 'x1', qty: 744.44 });

    expect(inTransitOf(sentNothing)).toBeNull();
    expect(inTransitOf(landed)).toEqual({ coin: 'USDC', qty: 744.44, at: 'SPOT' });
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
