import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile } from './releaseVerify';
import { downloadAsset, fetchVerifiedRelease, type ReleaseFetch } from './version';

const TASK_NAME = 'BorosUpdate';
const INSTALLER_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'BOROS_ROOT',
  'BOROS_PORT',
  'BOROS_REPO',
  'BOROS_BRANCH',
  'BOROS_REF',
  'BOROS_TARBALL',
];
const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const FETCH_TIMEOUT_MS = 30_000;

function updateLogPath(appDir = APP_DIR): string {
  const dir =
    process.platform === 'win32'
      ? path.join(borosRoot(appDir), 'logs')
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

function installTarget(appDir: string): Record<string, string> {
  const root = fs.existsSync(path.join(appDir, 'install-info.json')) ? path.dirname(appDir) : null;
  const port = process.env.PORT;
  return {
    ...(root ? { BOROS_ROOT: root } : {}),
    ...(port && /^\d+$/.test(port) ? { BOROS_PORT: port } : {}),
  };
}

function borosRoot(appDir = APP_DIR): string {
  return (
    installTarget(appDir).BOROS_ROOT ??
    process.env.BOROS_ROOT ??
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'CrossEx-Boros')
      : path.join(os.homedir(), '.boros-crossex'))
  );
}

interface StagedRelease {
  commit: string;
  archive: string;
  installer: string;
}

async function stageRelease(fetchImpl: ReleaseFetch, current: string, appDir: string): Promise<StagedRelease> {
  const release = await fetchVerifiedRelease(fetchImpl, current);
  if (!release) throw new Error('no newer release is published — update refused');
  const names = process.platform === 'win32' ? ['app.zip', 'install.ps1'] : ['app.tar.gz', 'install.sh'];
  const files = await Promise.all(
    names.map(async (name) => {
      const bytes = await downloadAsset(fetchImpl, release.assets, name, FETCH_TIMEOUT_MS);
      checkFile(release.manifest, name, bytes);
      return { name, bytes };
    }),
  );
  const dir = path.join(borosRoot(appDir), 'update');
  fs.mkdirSync(dir, { recursive: true });
  const [archive, installer] = files.map(({ name, bytes }) => {
    fs.writeFileSync(path.join(dir, name), bytes);
    return path.join(dir, name);
  });
  return { commit: release.manifest.commit, archive, installer };
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
 * LOCAL file with -File. Downloading before the task exists also puts a failed
 * download in the update dialog rather than in a task that quietly does nothing.
 */
function stageWindowsInstaller(logPath: string, staged: StagedRelease, appDir: string): void {
  const runner = path.join(borosRoot(appDir), 'update.ps1');

  // Start-Process truncates both files, but only once the task actually fires.
  // Until then the progress panel would be reading the LAST update's output —
  // and calling this one finished on the previous run's "Done!".
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(logPath.replace(/\.log$/, '.err.log'), '');

  // BOROS_ZIP cannot travel on the command line, so the runner sets it.
  // '' doubles PowerShell's quote escape.
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
    `$env:BOROS_ZIP = '${q(staged.archive)}'`,
    ...Object.entries(installTarget(appDir)).map(([k, v]) => `$env:${k} = '${q(v)}'`),
    // The update runs under a page that reloads itself onto the new copy;
    // the installer's parting Start-Process would open a duplicate tab.
    "$env:BOROS_NO_BROWSER = '1'",
    '$startArgs = @{',
    "  FilePath               = 'powershell.exe'",
    `  ArgumentList           = @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${q(staged.installer)}"')`,
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

export async function startUpdate(
  fetchImpl: ReleaseFetch,
  current: string,
  appDir = APP_DIR,
): Promise<{ logPath: string; commit: string }> {
  const logPath = updateLogPath(appDir);
  const staged = await stageRelease(fetchImpl, current, appDir);

  if (process.platform === 'win32') {
    stageWindowsInstaller(logPath, staged, appDir);
    const at = new Date(Date.now() + 60_000);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      // conhost --headless, for the same reason install.ps1 uses it for the
      // service task: a bare powershell /tr opens a console window for the
      // whole install (Windows Terminal ignores -WindowStyle Hidden), and
      // closing that window kills the installer mid-swap.
      `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(borosRoot(appDir), 'update.ps1')}"`,
      '/sc',
      'once',
      '/st',
      hhmm,
      '/f',
    ]);
    /**
     * ⚠ A TASK MADE BY `schtasks /create` WILL NOT START ON BATTERY.
     *
     * The CLI has no flag for it, so the task inherits
     * DisallowStartIfOnBatteries=True — on a laptop on battery `/run` parks it
     * at "Queued" forever, no error anywhere, while the dialog says the install
     * is running and the badge survives every refresh. The installer already
     * registers the app's own task battery-safe (install.ps1, Register-
     * ScheduledTask with these same two settings); this task forgot.
     *
     * Deliberately NOT best-effort: if the settings cannot be applied the
     * throw reaches the dialog as "could not start the update", which beats
     * queuing a task that may never run.
     */
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Set-ScheduledTask -TaskName '${TASK_NAME}' -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null`,
    ]);
    execFileSync('schtasks', ['/run', '/tn', TASK_NAME]);
    beginUpdateWindow();
    return { logPath, commit: staged.commit };
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
   *
   * The same goes for everything else in the server's env: dotenv has loaded
   * config/.env into it (the Gate API secret, the Boros agent key), and the
   * installer's `yarn install` runs every dependency's install scripts. So
   * this is an allowlist, not a denylist — only the basics plus the BOROS_*
   * knobs install.sh reads.
   */
  const installerEnv = Object.fromEntries(
    INSTALLER_ENV.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  const child = spawn('/bin/bash', [staged.installer], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...installerEnv,
      ...installTarget(appDir),
      BOROS_TARBALL: staged.archive,
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
  return { logPath, commit: staged.commit };
}
