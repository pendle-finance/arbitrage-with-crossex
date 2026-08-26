/**
 * Launch the installer that replaces this app, and return.
 *
 * The caller must NOT exit afterwards. The installer stops the server itself,
 * at the right moment: `stop_stale_server` SIGTERMs then SIGKILLs every server
 * under the install root (install.sh:236-250), called from `install_service`
 * (install.sh:319) AFTER the download and the build. Exiting sooner lets
 * KeepAlive restart the OLD build, which then trades for the several minutes
 * the install takes.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Mirrors of INSTALL_CMD / INSTALL_CMD_WINDOWS in web/src/lib/app.ts. They live
 * in the web bundle, so the server keeps its own copy — keep the two in step by
 * name. What the update pop-up shows has to be what runs here.
 *
 * The local install.sh is deliberately not used: it is the old version's copy,
 * so it is not the command the pop-up shows and it misses installer fixes.
 */
const INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"';
const INSTALL_CMD_WINDOWS =
  'irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1 | iex';

const TASK_NAME = 'BorosUpdate';

/**
 * Beside the server logs (install.sh:44, install.ps1:54) but a file of its own:
 * `install_service` truncates server.out.log and server.err.log mid-run
 * (install.sh:316), so the installer's output would land in a file that is
 * emptied underneath it.
 */
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

/**
 * True once the installer has been launched.
 *
 * The install takes MINUTES — the download and the build both finish before
 * `install_service` kills this server (install.sh:319). Refusing the update
 * while a deal is live buys nothing if a deal can start one second after the
 * spawn, so the write paths ask this and refuse for the rest of the process's
 * life. It is never cleared: the process is going to be killed.
 */
let updating = false;
export const isUpdating = (): boolean => updating;

/** Spawns the installer and returns the log file it writes to. */
export function startUpdate(): string {
  updating = true;
  const logPath = updateLogPath();

  if (process.platform === 'win32') {
    // `Unregister-ScheduledTask` ends the service task through its job object,
    // which kills the whole descendant tree, and node's `detached` does not set
    // CREATE_BREAKAWAY_FROM_JOB on Windows. A scheduled task of its own runs
    // outside that job, so the installer survives stopping the service it is
    // replacing. Single quotes in the path are doubled the way install.ps1:442
    // does it.
    const at = new Date(Date.now() + 60_000);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const command = `& { ${INSTALL_CMD_WINDOWS} } *> '${logPath.replace(/'/g, "''")}'`;
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
    return logPath;
  }

  // `detached` calls setsid, so the installer leaves the LaunchAgent session
  // before `launchctl bootout` fires (install.sh:318) and is not killed with it.
  const log = fs.openSync(logPath, 'a');
  const child = spawn('/bin/bash', ['-c', INSTALL_CMD], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  // `spawn` reports a missing binary asynchronously, not by throwing. With no
  // listener node raises "Unhandled 'error' event" and the SERVER exits — after
  // this route has already told the user the install started. Nothing here can
  // recover, so record it where the pop-up is already pointing the user.
  child.on('error', (err) => {
    try {
      fs.appendFileSync(logPath, `\nfailed to start the installer: ${String(err)}\n`);
    } catch {
      // The log was best-effort; losing it must not take the server with it.
    }
  });
  child.unref();
  fs.closeSync(log);
  return logPath;
}
