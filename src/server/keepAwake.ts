import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { PairRow } from '../engine/types';
import type { Job } from './rebalanceJob';

export function needsAwake(pairs: PairRow[], job: Job | null): boolean {
  if (job?.status === 'running') return true;
  return pairs.some((pair) => pair.mode !== 'HALTED' && pair.mode !== 'DONE' && (pair.b !== null || pair.deadlineAt !== null || pair.mode !== 'OPENING'));
}

export interface KeepAwakeDeps {
  platform: NodeJS.Platform;
  pid: number;
  spawn: typeof nodeSpawn;
  isLive: () => boolean;
}

export function startKeepAwake(deps: KeepAwakeDeps): { update(): void; stop(): void } {
  let child: ChildProcess | null = null;

  function end(): void {
    const current = child;
    child = null;
    current?.kill();
  }

  function update(): void {
    if (deps.platform !== 'darwin') return;
    if (!deps.isLive()) {
      end();
      return;
    }
    if (child) return;
    const started = deps.spawn('/usr/bin/caffeinate', ['-i', '-w', String(deps.pid)], { stdio: 'ignore' });
    child = started;
    started.once('exit', () => {
      if (child === started) child = null;
    });
    started.once('error', () => {
      if (child === started) child = null;
    });
    started.unref();
  }

  return { update, stop: end };
}
