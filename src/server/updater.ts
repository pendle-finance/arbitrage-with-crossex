import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"';
const INSTALLER_URL_WINDOWS =
  'https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1';
/** Dev/test override, same family as install.ps1's own BOROS_* knobs: a URL, or
 * a path to a local install.ps1 so the whole flow can be exercised offline. */
const INSTALLER_SOURCE_WINDOWS = (): string =>
  process.env.BOROS_INSTALLER ?? INSTALLER_URL_WINDOWS;

const TASK_NAME = 'BorosUpdate';
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 30_000;

function updateLogPath(): string {
  const dir =
    process.platform === 'win32'
      ? path.join(borosRoot(), 'logs')
      : path.join(os.homedir(), 'Library', 'Logs', 'boros-crossex');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'update.log');
}

const UPDATE_WINDOW_MS = 10 * 60_000;

let updating = false;
let startedAtMs: number | null = null;
let windowTimer: ReturnType<typeof setTimeout> | null = null;

export const isUpdating = (): boolean => updating;

/** Tail of the running installer's output, for the progress panel.
 *
 * The installer stops this server partway through, so the panel loses the feed
 * and picks it back up from the NEW server — which is why the log has to be the
 * source of truth rather than anything held in memory here. Both installers
 * print their steps as `==> …`, and both print the rollback banner on a
 * failure, so the text alone says where the update got to. */
export function updateProgress(): { startedAt: number | null; running: boolean; text: string } {
  const main = tail(updateLogPath());
  // Windows keeps native stderr in its own file; a failure that never reached
  // a `Say` line leaves its only explanation there.
  const err = process.platform === 'win32' ? tail(updateLogPath().replace(/\.log$/, '.err.log')) : '';
  return {
    startedAt: startedAtMs,
    running: updating,
    text: err.trim() ? `${main}\n${err}` : main,
  };
}

const TAIL_BYTES = 16_384;

function tail(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const take = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, size - take);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function endUpdateWindow(): void {
  updating = false;
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = null;
}

function beginUpdateWindow(): void {
  updating = true;
  startedAtMs = Date.now();
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = setTimeout(endUpdateWindow, UPDATE_WINDOW_MS);
  windowTimer.unref?.();
}

function borosRoot(): string {
  return (
    process.env.BOROS_ROOT ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'CrossEx-Boros')
  );
}

/**
 * ⚠ THE INSTALL COMMAND MUST NOT APPEAR ON THE SCHEDULED TASK'S COMMAND LINE.
 *
 * A /tr of `powershell -Command "& { irm <url> | iex } *> <log>"` is classified
 * by Microsoft Defender as Trojan:Win32/Commando.A!ml and the process creation
 * is DENIED, which Node reports as `spawnSync schtasks EPERM`. It is an ML
 * verdict, not a fixed signature, so it cannot be waited out.
 *
 * So the server downloads install.ps1 itself and the task only ever runs a
 * LOCAL file with -File. Downloading here also puts a failed download in the
 * update dialog rather than in a task that quietly does nothing.
 */
async function stageWindowsInstaller(logPath: string, pin: string | null): Promise<void> {
  const root = borosRoot();
  const installer = path.join(root, 'update-installer.ps1');
  const runner = path.join(root, 'update.ps1');

  const src = INSTALLER_SOURCE_WINDOWS();
  let script: string;
  if (/^https?:/i.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`could not download the installer (HTTP ${res.status})`);
    script = await res.text();
  } else {
    script = fs.readFileSync(src, 'utf8');
  }
  // A captive portal or an error page would otherwise be written out and run.
  if (!script.includes('Arbitrage with CrossEx')) {
    throw new Error('the downloaded installer does not look like install.ps1');
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(installer, script, 'utf8');

  // Start-Process truncates both files, but only once the task actually fires.
  // Until then the progress panel would be reading the LAST update's output —
  // and calling this one finished on the previous run's "Done!".
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(logPath.replace(/\.log$/, '.err.log'), '');

  // BOROS_REF can no longer travel on the command line, so the runner sets it.
  // `pin` is a validated 40-char sha and '' doubles PowerShell's quote escape.
  //
  // ⚠ Start-Process, NOT `& '<installer>' *> '<log>'`. Any `*>` redirection
  // makes PowerShell wrap the installer's native stderr into ErrorRecords, and
  // install.ps1 runs under $ErrorActionPreference='Stop' — so yarn's
  // unmet-peer-dependency warning, printed on every run, became a terminating
  // error and the update died at "Installing dependencies…". Start-Process
  // wires the real handles to the files instead; run-server.ps1 does the same,
  // for the same reason. Two files because it refuses to share one.
  //
  // Each ArgumentList element carries its own quotes: PowerShell 5.1 joins them
  // with spaces without quoting, so a root containing a space would split.
  const q = (s: string): string => s.replace(/'/g, "''");
  const wrapper = [
    '# Generated by the in-app updater on each run. Do not edit.',
    "$ErrorActionPreference = 'Continue'",
    ...(pin ? [`$env:BOROS_REF = '${q(pin)}'`] : []),
    // The update runs under a page that reloads itself onto the new copy;
    // the installer's parting Start-Process would open a duplicate tab.
    "$env:BOROS_NO_BROWSER = '1'",
    '$startArgs = @{',
    "  FilePath               = 'powershell.exe'",
    `  ArgumentList           = @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${installer}"')`,
    '  NoNewWindow            = $true',
    '  Wait                   = $true',
    `  RedirectStandardOutput = '${q(logPath)}'`,
    `  RedirectStandardError  = '${q(logPath.replace(/\.log$/, '.err.log'))}'`,
    '}',
    'Start-Process @startArgs',
    '',
  ].join('\r\n');
  fs.writeFileSync(runner, wrapper, 'utf8');
}

export async function startUpdate(ref?: string | null): Promise<string> {
  const pin = ref && COMMIT_SHA.test(ref) ? ref : null;
  const logPath = updateLogPath();

  if (process.platform === 'win32') {
    await stageWindowsInstaller(logPath, pin);
    const at = new Date(Date.now() + 60_000);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(borosRoot(), 'update.ps1')}"`,
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

  const log = fs.openSync(logPath, 'w');
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
    env: {
      ...installerEnv,
      ...(pin ? { BOROS_REF: pin } : {}),
      // Same duplicate-tab suppression as the Windows runner.
      BOROS_NO_BROWSER: '1',
    },
  });
  child.on('error', (err) => {
    endUpdateWindow();
    try {
      fs.appendFileSync(logPath, `\nfailed to start the installer: ${String(err)}\n`);
    } catch {
    }
  });
  /**
   * A NON-ZERO EXIT MEANS NOTHING IS COMING BACK.
   *
   * This never fires on a success: the installer stops this server before it
   * swaps the new copy in, so a completed update kills the parent first. It
   * fires when the installer starts and then dies — a failed build, an
   * unreachable download, a kill. Without it the window stays open for its
   * full ten minutes and every Boros write is refused, while the panel still
   * reads "comes back on its own".
   *
   * `code` is null when a signal killed it; that is not coming back either,
   * which is why the test is `!== 0` rather than `> 0`.
   */
  child.on('exit', (code) => {
    if (code !== 0) endUpdateWindow();
  });
  child.unref();
  fs.closeSync(log);
  beginUpdateWindow();
  return logPath;
}
