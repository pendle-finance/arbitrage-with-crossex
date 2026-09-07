import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Direction } from '../core/rebalance/plan';
import { restrictToOwner } from './secretFile';

export type { Direction };
export type JobStatus = 'running' | 'halted' | 'done' | 'abandoned';
export type StepStatus = 'pending' | 'running' | 'done';
export type FundsAt = 'CROSSEX' | 'GATE' | 'SPOT' | 'HYPERLIQUID';
export type RouteName = 'loop' | 'convert';

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
}

export interface Job {
  id: string;
  /** Gate user id the job was started on. A resume on another account is
   * refused; null on files written before this field existed. */
  userId: string | null;
  direction: Direction;
  route: RouteName;
  amount: number;
  status: JobStatus;
  stepIndex: number;
  steps: Step[];
  fundsAt: FundsAt;
  haltReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export const LOOP_STEPS = ['Buy USDC', 'To spot', 'To Hyperliquid'] as const;
export const CONVERT_STEPS = ['Convert'] as const;
export const PULL_STEPS = ['Pull from Hyperliquid', 'To Gate', 'Sell USDC'] as const;
export type StepName = (typeof LOOP_STEPS)[number] | (typeof CONVERT_STEPS)[number] | (typeof PULL_STEPS)[number];
export const STEP_NAMES: readonly string[] = [...LOOP_STEPS, ...CONVERT_STEPS, ...PULL_STEPS];

const JOB_STATUSES: readonly string[] = ['running', 'halted', 'done', 'abandoned'];
const FUNDS_AT: readonly string[] = ['CROSSEX', 'GATE', 'SPOT', 'HYPERLIQUID'];

export function newJob(
  direction: Direction,
  route: RouteName,
  amount: number,
  now: number,
  userId: string | null = null,
): Job {
  const names: readonly string[] = route === 'convert' ? CONVERT_STEPS : direction === 'pull' ? PULL_STEPS : LOOP_STEPS;
  return {
    id: now.toString(36),
    userId,
    direction,
    route,
    amount,
    status: 'running',
    stepIndex: 0,
    steps: names.map((name) => ({
      name,
      text: null,
      quoteId: null,
      venueId: null,
      qty: null,
      attempt: 0,
      status: 'pending',
      startedAt: null,
      doneAt: null,
    })),
    fundsAt: direction === 'pull' ? 'HYPERLIQUID' : 'CROSSEX',
    haltReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function haltMessage(job: Job): string {
  const step = job.steps[job.stepIndex];
  return `rebalance ${job.id} halted at ${step.name}: ${job.haltReason}. Funds are in ${job.fundsAt}.`;
}

function parseJob(value: unknown): Job | null {
  const job = value as Partial<Job> | null;
  if (typeof job !== 'object' || job === null) return null;
  if (job.direction === undefined) job.direction = 'payDown';
  if (job.userId === undefined) job.userId = null;
  if (job.direction !== 'payDown' && job.direction !== 'pull') return null;
  if (!JOB_STATUSES.includes(String(job.status))) return null;
  if (!Array.isArray(job.steps) || job.steps.length === 0) return null;
  const index = job.stepIndex;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= job.steps.length) return null;
  if (!job.steps.every((step) => STEP_NAMES.includes(String((step as Partial<Step> | null)?.name)))) return null;
  if (!FUNDS_AT.includes(String(job.fundsAt))) return null;
  return job as Job;
}

export class JobFile {
  private readonly file: string;
  private job: Job | null | undefined;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, 'rebalance.json');
  }

  read(): Job | null {
    if (this.job !== undefined) return this.job;
    this.job = null;
    if (!fs.existsSync(this.file)) return null;
    try {
      this.job = parseJob(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
    if (this.job === null) console.error(`rebalance.json at ${this.file} is unreadable; treating as no job`);
    return this.job;
  }

  write(job: Job): void {
    job.updatedAt = this.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    restrictToOwner(this.file);
    this.job = job;
  }

  haltIfRunning(reason: string): boolean {
    const job = this.read();
    if (job?.status !== 'running') return false;
    job.status = 'halted';
    job.haltReason = reason;
    this.write(job);
    return true;
  }
}
