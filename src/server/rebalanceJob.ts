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

export class JobFile {
  private readonly file: string;
  private job: Job | null | undefined;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'rebalance.json');
  }

  read(): Job | null {
    if (this.job === undefined) {
      try {
        this.job = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Job;
      } catch {
        this.job = null;
      }
    }
    return this.job;
  }

  write(job: Job): void {
    job.updatedAt = Date.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    restrictToOwner(this.file);
    this.job = job;
  }

  haltIfRunning(reason: string): void {
    const job = this.read();
    if (job?.status !== 'running') return;
    job.status = 'halted';
    job.haltReason = reason;
    this.write(job);
  }
}
