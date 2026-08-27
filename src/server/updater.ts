import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"';
const INSTALL_CMD_WINDOWS =
  'irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1 | iex';

const TASK_NAME = 'BorosUpdate';
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function updateLogPath(): string {
  const dir =
    process.platform === 'win32'
      ? path.join(
          process.env.BOROS_ROOT ??
            path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'CrossEx-Boros'),
          'logs',
        )
      : path.join(os.homedir(), 'Library', 'Logs', 'boros-crossex');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'update.log');
}

const UPDATE_WINDOW_MS = 10 * 60_000;

let updating = false;
let windowTimer: ReturnType<typeof setTimeout> | null = null;

export const isUpdating = (): boolean => updating;

export function endUpdateWindow(): void {
  updating = false;
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = null;
}

function beginUpdateWindow(): void {
  updating = true;
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = setTimeout(endUpdateWindow, UPDATE_WINDOW_MS);
  windowTimer.unref?.();
}

export function startUpdate(ref?: string | null): string {
  const pin = ref && COMMIT_SHA.test(ref) ? ref : null;
  const logPath = updateLogPath();

  if (process.platform === 'win32') {
    const at = new Date(Date.now() + 60_000);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const prefix = pin ? `$env:BOROS_REF='${pin}'; ` : '';
    const command = `${prefix}& { ${INSTALL_CMD_WINDOWS} } *> '${logPath.replace(/'/g, "''")}'`;
    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command}"`,
      '/sc',
      'once',
      '/st',
      hhmm,
      '/f',
    ]);
    execFileSync('schtasks', ['/run', '/tn', TASK_NAME]);
    beginUpdateWindow();
    return logPath;
  }

  const log = fs.openSync(logPath, 'a');
  /**
   * ⚠ NODE_ENV MUST NOT REACH THE INSTALLER.
   *
   * The LaunchAgent this app writes for itself sets NODE_ENV=production, so the
   * server always runs with it. Yarn 1 reads NODE_ENV=production as
   * `--production` and skips devDependencies — and still exits 0. `vite` and
   * `typescript` are devDependencies, so the installer's `yarn build` step then
   * has nothing to build with and dies. Inheriting the server's environment
   * wholesale makes every update from this button fail, every time.
   *
   * A user pasting the same command into a terminal has no NODE_ENV, which is
   * why the install works by hand and only ever fails from here.
   */
  const { NODE_ENV: _serviceEnv, ...installerEnv } = process.env;
  const child = spawn('/bin/bash', ['-c', INSTALL_CMD], {
    detached: true,
    stdio: ['ignore', log, log],
    env: pin ? { ...installerEnv, BOROS_REF: pin } : installerEnv,
  });
  child.on('error', (err) => {
    endUpdateWindow();
    try {
      fs.appendFileSync(logPath, `\nfailed to start the installer: ${String(err)}\n`);
    } catch {
    }
  });
  child.unref();
  fs.closeSync(log);
  beginUpdateWindow();
  return logPath;
}
