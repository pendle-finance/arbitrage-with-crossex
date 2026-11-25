import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';

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
    const started = deps.spawn('caffeinate', ['-i', '-w', String(deps.pid)], { stdio: 'ignore' });
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
