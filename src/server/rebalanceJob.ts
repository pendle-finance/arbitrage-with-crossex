import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyGateError, plainErrorFor } from '../core/errors';
import { CONVERT_MAX, CONVERT_RATE, floorCents, PAIR_CONVERT_MAX, POOLS, spotArrivalFor } from '../core/rebalance/plan';
import type { GateAccount, PlannedStep, Pool, RouteName, TransferCoin, Venue, WalletAfter } from '../core/rebalance/plan';
import { restrictToOwner } from './secretFile';

export type { Pool, RouteName };
export type JobStatus = 'running' | 'halted' | 'done' | 'abandoned';
export type StepStatus = 'pending' | 'running' | 'done';
export type FundsAt = 'CROSSEX' | 'GATE' | 'SPOT' | 'HYPERLIQUID' | 'LIGHTER';

export interface Step {
  name: string;
  text: string | null;
  quoteId: string | null;
  venueId: string | null;
  qty: number | null;
  attempt: number;
  status: StepStatus;
  startedAt: number | null;
  doneAt: number | null;
  round: number | null;
  planned: number | null;
  arrives: number | null;
  borrowLeft: number | null;
  from: Pool;
  to: Pool;
  cashBefore?: number;
  sentAt?: number;
}

export interface Job {
  id: string;
  /** Gate user id the job was started on. A resume on another account is
   * refused; null on files written before this field existed. */
  userId: string | null;
  route: RouteName;
  amount: number;
  costUsd: number | null;
  target: WalletAfter[] | null;
  status: JobStatus;
  stepIndex: number;
  steps: Step[];
  fundsAt: FundsAt;
  haltReason: string | null;
  tagCount: number;
  createdAt: number;
  updatedAt: number;
}

export const TO_VENUE_STEP = { HYPERLIQUID: 'To Hyperliquid', LIGHTER: 'To Lighter' } as const;
export const FROM_VENUE_STEP = { HYPERLIQUID: 'From Hyperliquid', LIGHTER: 'From Lighter' } as const;
export const TO_USDC_STEPS = ['Buy USDC', 'To spot', TO_VENUE_STEP.HYPERLIQUID] as const;
export const TO_USDT_STEPS = [FROM_VENUE_STEP.HYPERLIQUID, 'To Gate', 'Sell USDC'] as const;
export const CONVERT_STEPS = ['Convert', 'Convert to USDT', 'Convert to USDC'] as const;
export type StepName =
  | 'Buy USDC'
  | 'To spot'
  | 'To Gate'
  | 'Sell USDC'
  | (typeof TO_VENUE_STEP)[Venue]
  | (typeof FROM_VENUE_STEP)[Venue]
  | (typeof CONVERT_STEPS)[number];
export const STEP_NAMES: readonly string[] = [
  'Buy USDC',
  'To spot',
  'To Gate',
  'Sell USDC',
  ...Object.values(TO_VENUE_STEP),
  ...Object.values(FROM_VENUE_STEP),
  ...CONVERT_STEPS,
];

export function roundStepNames(from: Pool, to: Pool): StepName[] {
  if (from === 'CROSSEX') return ['Buy USDC', 'To spot', TO_VENUE_STEP[to as Venue]];
  if (to === 'CROSSEX') return [FROM_VENUE_STEP[from], 'To Gate', 'Sell USDC'];
  return [FROM_VENUE_STEP[from], TO_VENUE_STEP[to]];
}

const LEGACY_MOVE: Record<string, { from: Pool; to: Pool }> = {
  toUsdc: { from: 'CROSSEX', to: 'HYPERLIQUID' },
  toUsdt: { from: 'HYPERLIQUID', to: 'CROSSEX' },
  payDown: { from: 'CROSSEX', to: 'HYPERLIQUID' },
  pull: { from: 'HYPERLIQUID', to: 'CROSSEX' },
};
const LEGACY_STEP: Record<string, StepName> = { 'Pull from Hyperliquid': 'From Hyperliquid' };

const JOB_STATUSES: readonly string[] = ['running', 'halted', 'done', 'abandoned'];
const FUNDS_AT: readonly string[] = ['CROSSEX', 'GATE', 'SPOT', 'HYPERLIQUID', 'LIGHTER'];
const IN_TRANSIT_STATUSES: readonly JobStatus[] = ['running', 'halted', 'abandoned'];
const MOVES_TO: Record<string, string> = {
  'To spot': 'Gate spot',
  'From Hyperliquid': 'Gate spot',
  'From Lighter': 'Gate spot',
  'To Hyperliquid': 'USDC · Hyperliquid',
  'To Lighter': 'USDC · Lighter',
  'To Gate': 'USDC · Gate',
};
const SENDS_WHAT_ARRIVED: readonly string[] = ['To Hyperliquid', 'To Lighter', 'To Gate'];
const TRANSFER_STATUSES: readonly string[] = ['moving', 'done', 'failed'];

export const HALT_TEXT = {
  restart: 'The app restarted during the run. Nothing failed. Press Resume.',
  marginTooLow: 'Free margin is too low for the next round.',
  cashTooLow: 'Not enough cash for an 11 USDC round.',
  unconfirmed: 'Gate did not confirm the last order. Press Resume to check again.',
  shortBuy: 'The USDC buy filled under 11 USDC.',
  poorQuote: 'Convert quote was more than 0.3% under the Gate spot price.',
  convertTooBig: 'Gate takes at most 500,000 in one Convert. Abandon this rebalance and start a new one.',
  marginRefused: 'Gate refused the move: free margin or wallet cash is too low.',
  noRecord: 'Gate has no record of this transfer. Try again.',
  timeout: 'Gate took too long on this step. Press Resume to check again.',
  rateLimited: 'Gate is rate-limiting this account. Nothing was sent. Press Resume in a few minutes.',
  nothingFilled: 'Gate closed the order with nothing filled. Nothing moved. Press Resume to try again.',
  nothingReceived: 'Gate shows this transfer as done, but nothing arrived. Check your Gate wallets.',
  usdtBelowZero: 'A Convert between Hyperliquid and Lighter needs more USDT · CrossEx cash.',
  sellStuck: 'Gate did not sell all the USDC in USDC · Gate. Press Resume to sell the rest.',
  noPrice: 'Could not read the Gate spot price to check the Convert quote. Press Resume to try again.',
  notListed: 'Gate does not show the last step after 2 min. Press Resume to check again. If Gate still does not show it, Resume sends it again.',
} as const;

export const LOCK_TEXT = {
  halted: 'Transfers wait until you resume or abandon the rebalance.',
  rebalance: 'Transfers wait until the rebalance ends.',
  deal: 'Transfers wait until the deal ends.',
  moving: 'A transfer is still moving.',
  rebalanceWaits: 'Rebalance waits until the transfer ends.',
} as const;

export type TransferLock = 'rebalance' | 'halted' | 'deal';

export interface TransferJob {
  id: string;
  userId: string | null;
  coin: TransferCoin;
  from: GateAccount;
  to: GateAccount;
  amount: number;
  status: 'moving' | 'done' | 'failed';
  text: string;
  venueId: string | null;
  sentAt: number | null;
  acceptedAt: number | null;
  received: number | null;
  failText: string | null;
  createdAt: number;
  doneAt: number | null;
  updatedAt: number;
}

export const pendingStep = (
  name: StepName,
  plan: Pick<Step, 'round' | 'planned' | 'arrives' | 'borrowLeft' | 'from' | 'to'>,
): Step => ({
  name,
  text: null,
  quoteId: null,
  venueId: null,
  qty: null,
  attempt: 0,
  status: 'pending',
  startedAt: null,
  doneAt: null,
  ...plan,
});

export function convertSteps(from: Pool, to: Pool, amount: number): Step[] {
  const move = { from, to, round: null, arrives: null, borrowLeft: null };
  const crossex = from === 'CROSSEX' || to === 'CROSSEX';
  const cap = crossex ? CONVERT_MAX : PAIR_CONVERT_MAX;
  const cents = Math.round(floorCents(amount) * 100);
  const count = amount > cap ? Math.max(1, Math.ceil(cents / (cap * 100))) : 1;
  const base = Math.floor(cents / count);
  const extra = cents - base * count;
  const chunks = count === 1 ? [amount] : Array.from({ length: count }, (_, index) => (base + (index < extra ? 1 : 0)) / 100);
  if (crossex) return chunks.map((planned) => pendingStep('Convert', { ...move, planned }));
  return chunks.flatMap((planned) => [
    pendingStep('Convert to USDT', { ...move, planned }),
    pendingStep('Convert to USDC', { ...move, planned: floorCents(planned * (1 - CONVERT_RATE)) }),
  ]);
}

function stepsFor(step: PlannedStep): Step[] {
  const { from, to, round } = step;
  if (step.kind === 'convert') return convertSteps(from, to, step.move);
  const figures = { from, to, round, arrives: null, borrowLeft: null };
  if (from === 'CROSSEX') {
    return [
      pendingStep('Buy USDC', { ...figures, planned: step.buy }),
      pendingStep('To spot', { ...figures, planned: step.move }),
      pendingStep(TO_VENUE_STEP[to as Venue], { ...figures, planned: step.move, arrives: step.arrives, borrowLeft: step.borrowLeft }),
    ];
  }
  if (to === 'CROSSEX') {
    return [
      pendingStep(FROM_VENUE_STEP[from], { ...figures, planned: step.move }),
      pendingStep('To Gate', { ...figures, planned: step.arrives }),
      pendingStep('Sell USDC', { ...figures, planned: step.arrives, borrowLeft: step.borrowLeft }),
    ];
  }
  return [
    pendingStep(FROM_VENUE_STEP[from], { ...figures, planned: step.move }),
    pendingStep(TO_VENUE_STEP[to], {
      ...figures,
      planned: spotArrivalFor(from, step.move),
      arrives: step.arrives,
      borrowLeft: step.borrowLeft,
    }),
  ];
}

export function newJob(
  input: {
    route: RouteName;
    steps: PlannedStep[];
    amount: number;
    costUsd: number;
    target: WalletAfter[];
    userId: string | null;
  },
  now: number,
): Job {
  return {
    id: now.toString(36),
    userId: input.userId,
    route: input.route,
    amount: input.amount,
    costUsd: input.costUsd,
    target: input.target,
    status: 'running',
    stepIndex: 0,
    steps: input.steps.flatMap(stepsFor),
    fundsAt: input.steps[0]?.from ?? 'CROSSEX',
    haltReason: null,
    tagCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function newTransferJob(
  input: { coin: TransferCoin; from: GateAccount; to: GateAccount; amount: number; userId: string | null },
  now: number,
): TransferJob {
  const id = now.toString(36);
  return {
    id,
    userId: input.userId,
    coin: input.coin,
    from: input.from,
    to: input.to,
    amount: input.amount,
    status: 'moving',
    text: `t-tr${id}`,
    venueId: null,
    sentAt: null,
    acceptedAt: null,
    received: null,
    failText: null,
    createdAt: now,
    doneAt: null,
    updatedAt: now,
  };
}

export function haltReasonFor(err: unknown): string {
  if (classifyGateError(err).label === 'TRANSFER_AMOUNT_INSUFFICIENT') return HALT_TEXT.marginRefused;
  const plain = plainErrorFor(err);
  if (!plain.hint) return plain.message;
  const message = /[.!?]$/.test(plain.message) ? plain.message : `${plain.message}.`;
  return `${message} ${plain.hint}`;
}

export function transferFailText(reason: string): string {
  const trimmed = reason.trim().replace(/[\s.]+$/, '');
  return trimmed ? `Transfer failed: ${trimmed}.` : 'Transfer failed.';
}

export function spotShortfallFailText(message: string, coin: TransferCoin, amount: number): string {
  const match = message.match(/transferAvailable:\s*(-?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?)/i);
  const available = match ? Number(match[1].replaceAll(',', '')) : NaN;
  if (!Number.isFinite(available)) return `Gate spot does not have ${formatMoney(amount)} ${coin}.`;
  if (available <= 0) return `Gate spot has no ${coin}.`;
  const cents = floorCents(available);
  if (cents <= 0) return `Gate spot has less than 0.01 ${coin}.`;
  return `Gate spot has only ${formatMoney(cents)} ${coin}.`;
}

const movingStep = (job: Job): Step | null => {
  const step = job.steps[job.stepIndex];
  return step && Object.hasOwn(MOVES_TO, step.name) && step.venueId !== null && step.status !== 'done' ? step : null;
};

export function inTransitOf(job: Job): { coin: 'USDC'; qty: number; at: 'SPOT' | 'MOVING' } | null {
  if (!IN_TRANSIT_STATUSES.includes(job.status)) return null;
  const moving = movingStep(job);
  if (moving) {
    const sent = SENDS_WHAT_ARRIVED.includes(moving.name) ? job.steps[job.stepIndex - 1]?.qty : moving.planned;
    return sent ? { coin: 'USDC', qty: sent, at: 'MOVING' } : null;
  }
  if (job.fundsAt !== 'SPOT') return null;
  const last = job.steps.filter((step) => step.status === 'done').at(-1);
  if (!last || last.qty === null) return null;
  return { coin: 'USDC', qty: last.qty, at: 'SPOT' };
}

export const formatMoney = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function bannerFor(job: Job): string {
  const step = job.steps[job.stepIndex];
  if (!step) return 'Rebalance stopped.';
  const { round } = step;
  if (round === null) return `Rebalance stopped at ${step.name}.`;
  const stopped = `Rebalance stopped in round ${round}.`;
  const inTransit = inTransitOf(job);
  if (!inTransit) return stopped;
  const amount = `${formatMoney(inTransit.qty)} ${inTransit.coin}`;
  if (inTransit.at === 'SPOT') return `${stopped} ${amount} is in Gate spot.`;
  return `${stopped} ${amount} is on the way to ${MOVES_TO[step.name]}.`;
}

export function transferLockFor(input: { rebalance: Job | null; dealWorking: boolean }): TransferLock | null {
  if (input.rebalance?.status === 'halted') return 'halted';
  if (input.rebalance?.status === 'running') return 'rebalance';
  return input.dealWorking ? 'deal' : null;
}

export type MoneyLock = { kind: TransferLock; id: string } | { kind: 'moving' };

export function moneyLockFor(input: {
  rebalance: Job | null;
  transfer: TransferJob | null;
  dealId: string | null;
}): MoneyLock | null {
  const { rebalance, transfer, dealId } = input;
  const lock = transferLockFor({ rebalance, dealWorking: dealId !== null });
  if (lock === 'deal' && dealId !== null) return { kind: lock, id: dealId };
  if (lock !== null && rebalance !== null) return { kind: lock, id: rebalance.id };
  return transfer?.status === 'moving' ? { kind: 'moving' } : null;
}

function parseJob(value: unknown): Job | null {
  const job = value as Partial<Job> | null;
  if (typeof job !== 'object' || job === null) return null;
  const { direction = 'toUsdc' } = job as { direction?: unknown };
  const legacy = Object.hasOwn(LEGACY_MOVE, String(direction)) ? LEGACY_MOVE[String(direction)] : null;
  delete (job as { direction?: unknown }).direction;
  if (job.userId === undefined) job.userId = null;
  if (job.costUsd === undefined) job.costUsd = null;
  if (job.target === undefined) job.target = null;
  if (!JOB_STATUSES.includes(String(job.status))) return null;
  if (!Array.isArray(job.steps) || job.steps.length === 0) return null;
  for (const step of job.steps as (Partial<Step> | null)[]) {
    if (typeof step !== 'object' || step === null) return null;
    if (typeof step.name === 'string' && step.name in LEGACY_STEP) step.name = LEGACY_STEP[step.name];
    if (step.round === undefined) step.round = step.name === 'Convert' ? null : 1;
    if (step.planned === undefined) step.planned = job.amount ?? null;
    if (step.arrives === undefined) step.arrives = null;
    if (step.borrowLeft === undefined) step.borrowLeft = null;
    if (step.cashBefore !== undefined && !Number.isFinite(step.cashBefore)) delete step.cashBefore;
    if (step.sentAt !== undefined && !Number.isFinite(step.sentAt)) delete step.sentAt;
    if (step.from === undefined && step.to === undefined && legacy) Object.assign(step, legacy);
    if (!POOLS.includes(step.from as Pool) || !POOLS.includes(step.to as Pool) || step.from === step.to) return null;
  }
  const index = job.stepIndex;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= job.steps.length) return null;
  if (!job.steps.every((step) => STEP_NAMES.includes(String(step.name)))) return null;
  if (!FUNDS_AT.includes(String(job.fundsAt))) return null;
  if (job.tagCount === undefined) job.tagCount = job.steps.length;
  if (!Number.isInteger(job.tagCount) || (job.tagCount as number) < 0) return null;
  return job as Job;
}

function parseTransfer(value: unknown): TransferJob | null {
  const transfer = value as Partial<TransferJob> | null;
  if (typeof transfer !== 'object' || transfer === null) return null;
  if (typeof transfer.id !== 'string' || typeof transfer.text !== 'string') return null;
  if (typeof transfer.coin !== 'string' || typeof transfer.from !== 'string' || typeof transfer.to !== 'string') return null;
  if (typeof transfer.amount !== 'number' || !Number.isFinite(transfer.amount)) return null;
  if (!TRANSFER_STATUSES.includes(String(transfer.status))) return null;
  return transfer as TransferJob;
}

class RecordFile<T extends { updatedAt: number }> {
  private record: T | null | undefined;

  constructor(
    private readonly file: string,
    private readonly parse: (value: unknown) => T | null,
    private readonly now: () => number,
  ) {}

  read(): T | null {
    if (this.record !== undefined) return this.record;
    this.record = null;
    if (!fs.existsSync(this.file)) return null;
    try {
      this.record = this.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
    if (this.record === null) console.error(`${path.basename(this.file)} at ${this.file} is unreadable; treating as no job`);
    return this.record;
  }

  write(record: T): void {
    record.updatedAt = this.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    restrictToOwner(this.file);
    this.record = record;
  }
}

export class JobFile extends RecordFile<Job> {
  constructor(dataDir: string, now: () => number = Date.now) {
    super(path.join(dataDir, 'rebalance.json'), parseJob, now);
  }

  haltIfRunning(): boolean {
    const job = this.read();
    if (job?.status !== 'running') return false;
    job.status = 'halted';
    job.haltReason = HALT_TEXT.restart;
    this.write(job);
    return true;
  }
}

export class TransferFile extends RecordFile<TransferJob> {
  constructor(dataDir: string, now: () => number = Date.now) {
    super(path.join(dataDir, 'transfer.json'), parseTransfer, now);
  }
}
