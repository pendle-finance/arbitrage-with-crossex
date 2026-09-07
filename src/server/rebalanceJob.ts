import * as fs from 'node:fs';
import * as path from 'node:path';
import { restrictToOwner } from './secretFile';

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
  balanceBefore: number | null;
  attempt: number;
  status: StepStatus;
  startedAt: number | null;
  doneAt: number | null;
}

export interface Job {
  id: string;
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
export const STEP_NAMES: readonly string[] = [...LOOP_STEPS, ...CONVERT_STEPS];

const JOB_STATUSES: readonly string[] = ['running', 'halted', 'done', 'abandoned'];
const FUNDS_AT: readonly string[] = ['CROSSEX', 'GATE', 'SPOT', 'HYPERLIQUID'];

export function newJob(route: RouteName, amount: number, now: number): Job {
  const names: readonly string[] = route === 'loop' ? LOOP_STEPS : CONVERT_STEPS;
  return {
    id: now.toString(36),
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
      balanceBefore: null,
      attempt: 0,
      status: 'pending',
      startedAt: null,
      doneAt: null,
    })),
    fundsAt: 'CROSSEX',
    haltReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function haltMessage(job: Job): string {
  const step = job.steps[job.stepIndex];
  return `rebalance ${job.id} halted at ${step.name}: ${job.haltReason}. Funds are in ${job.fundsAt}.`;
}

function isJob(value: unknown): value is Job {
  const job = value as Partial<Job> | null;
  if (typeof job !== 'object' || job === null) return false;
  if (!JOB_STATUSES.includes(String(job.status))) return false;
  if (!Array.isArray(job.steps) || job.steps.length === 0) return false;
  const index = job.stepIndex;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= job.steps.length) return false;
  if (!job.steps.every((step) => STEP_NAMES.includes(String((step as Partial<Step> | null)?.name)))) return false;
  return FUNDS_AT.includes(String(job.fundsAt));
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
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (isJob(parsed)) this.job = parsed;
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
