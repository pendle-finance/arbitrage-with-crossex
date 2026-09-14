import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyGateError } from '../core/errors';
import type {
  Direction,
  GateAccount,
  PlannedStep,
  RouteName,
  TransferCoin,
  WalletAfter,
} from '../core/rebalance/plan';
import { restrictToOwner } from './secretFile';

export type { Direction, RouteName };
export type JobStatus = 'running' | 'halted' | 'done' | 'abandoned';
export type StepStatus = 'pending' | 'running' | 'done';
export type FundsAt = 'CROSSEX' | 'GATE' | 'SPOT' | 'HYPERLIQUID';

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
}

export interface Job {
  id: string;
  /** Gate user id the job was started on. A resume on another account is
   * refused; null on files written before this field existed. */
  userId: string | null;
  direction: Direction;
  route: RouteName;
  amount: number;
  costUsd: number | null;
  target: WalletAfter[] | null;
  status: JobStatus;
  stepIndex: number;
  steps: Step[];
  fundsAt: FundsAt;
  haltReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export const TO_USDC_STEPS = ['Buy USDC', 'To spot', 'To Hyperliquid'] as const;
export const CONVERT_STEPS = ['Convert'] as const;
export const TO_USDT_STEPS = ['From Hyperliquid', 'To Gate', 'Sell USDC'] as const;
export type StepName = (typeof TO_USDC_STEPS)[number] | (typeof CONVERT_STEPS)[number] | (typeof TO_USDT_STEPS)[number];
export const STEP_NAMES: readonly string[] = [...TO_USDC_STEPS, ...CONVERT_STEPS, ...TO_USDT_STEPS];

/** Names before 1.5.1. A job file written by that build must still resume. */
const LEGACY_DIRECTION: Record<string, Direction> = { payDown: 'toUsdc', pull: 'toUsdt' };
const LEGACY_STEP: Record<string, StepName> = { 'Pull from Hyperliquid': 'From Hyperliquid' };

const JOB_STATUSES: readonly string[] = ['running', 'halted', 'done', 'abandoned'];
const FUNDS_AT: readonly string[] = ['CROSSEX', 'GATE', 'SPOT', 'HYPERLIQUID'];
const IN_TRANSIT_STATUSES: readonly JobStatus[] = ['running', 'halted', 'abandoned'];
const TRANSFER_STATUSES: readonly string[] = ['moving', 'done', 'failed'];

export const HALT_TEXT = {
  restart: 'The app restarted during the run.',
  marginTooLow: 'Free margin is too low for the next round.',
  shortBuy: 'The USDC buy filled under 11 USDC.',
  poorQuote: 'Convert quote was more than 0.3% under market.',
  marginRefused: 'Gate refused the move: free margin is too low.',
  noRecord: 'Gate has no record of this transfer. Try again.',
  timeout: 'Gate took too long on this step.',
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

export const pendingStep = (name: StepName, plan: Pick<Step, 'round' | 'planned' | 'arrives' | 'borrowLeft'>): Step => ({
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

function stepsFor(direction: Direction, step: PlannedStep): Step[] {
  if (step.kind === 'convert') {
    return [pendingStep('Convert', { round: null, planned: step.move, arrives: null, borrowLeft: null })];
  }
  const { round } = step;
  if (direction === 'toUsdt') {
    return [
      pendingStep('From Hyperliquid', { round, planned: step.move, arrives: null, borrowLeft: null }),
      pendingStep('To Gate', { round, planned: step.arrives, arrives: null, borrowLeft: null }),
      pendingStep('Sell USDC', { round, planned: step.arrives, arrives: null, borrowLeft: step.borrowLeft }),
    ];
  }
  return [
    pendingStep('Buy USDC', { round, planned: step.buy, arrives: null, borrowLeft: null }),
    pendingStep('To spot', { round, planned: step.move, arrives: null, borrowLeft: null }),
    pendingStep('To Hyperliquid', { round, planned: step.move, arrives: step.arrives, borrowLeft: step.borrowLeft }),
  ];
}

export function newJob(
  input: {
    direction: Direction;
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
    direction: input.direction,
    route: input.route,
    amount: input.amount,
    costUsd: input.costUsd,
    target: input.target,
    status: 'running',
    stepIndex: 0,
    steps: input.steps.flatMap((step) => stepsFor(input.direction, step)),
    fundsAt: input.direction === 'toUsdt' ? 'HYPERLIQUID' : 'CROSSEX',
    haltReason: null,
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
  const classified = classifyGateError(err);
  if (classified.label === 'TRANSFER_AMOUNT_INSUFFICIENT') return HALT_TEXT.marginRefused;
  return classified.hint ? `${classified.message} ${classified.hint}` : classified.message;
}

export function transferFailText(reason: string): string {
  const trimmed = reason.trim().replace(/[\s.]+$/, '');
  return trimmed ? `Transfer failed: ${trimmed}.` : 'Transfer failed.';
}

export function inTransitOf(job: Job): { coin: 'USDC'; qty: number } | null {
  if (job.fundsAt !== 'SPOT' || !IN_TRANSIT_STATUSES.includes(job.status)) return null;
  const last = job.steps.filter((step) => step.status === 'done').at(-1);
  if (!last || last.qty === null) return null;
  return { coin: 'USDC', qty: last.qty };
}

export const formatMoney = (value: number): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function bannerFor(job: Job): string {
  const { round } = job.steps[job.stepIndex];
  if (round === null) return 'Rebalance stopped at Convert.';
  const stopped = `Rebalance stopped in round ${round}.`;
  const inTransit = inTransitOf(job);
  if (!inTransit) return stopped;
  return `${stopped} ${formatMoney(inTransit.qty)} ${inTransit.coin} is in Gate spot.`;
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
  if (job.direction === undefined) job.direction = 'toUsdc';
  if (typeof job.direction === 'string' && job.direction in LEGACY_DIRECTION) job.direction = LEGACY_DIRECTION[job.direction];
  if (job.userId === undefined) job.userId = null;
  if (job.costUsd === undefined) job.costUsd = null;
  if (job.target === undefined) job.target = null;
  if (job.direction !== 'toUsdc' && job.direction !== 'toUsdt') return null;
  if (!JOB_STATUSES.includes(String(job.status))) return null;
  if (!Array.isArray(job.steps) || job.steps.length === 0) return null;
  for (const step of job.steps as (Partial<Step> | null)[]) {
    if (typeof step !== 'object' || step === null) return null;
    if (typeof step.name === 'string' && step.name in LEGACY_STEP) step.name = LEGACY_STEP[step.name];
    if (step.round === undefined) step.round = step.name === 'Convert' ? null : 1;
    if (step.planned === undefined) step.planned = job.amount ?? null;
    if (step.arrives === undefined) step.arrives = null;
    if (step.borrowLeft === undefined) step.borrowLeft = null;
  }
  const index = job.stepIndex;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= job.steps.length) return null;
  if (!job.steps.every((step) => STEP_NAMES.includes(String(step.name)))) return null;
  if (!FUNDS_AT.includes(String(job.fundsAt))) return null;
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
