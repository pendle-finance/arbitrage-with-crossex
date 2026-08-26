import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.sh)"';
const INSTALL_CMD_WINDOWS =
  'irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1 | iex';

const TASK_NAME = 'BorosUpdate';

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

let updating = false;
export const isUpdating = (): boolean => updating;

export function startUpdate(): string {
  updating = true;
  const logPath = updateLogPath();

  if (process.platform === 'win32') {
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

  const log = fs.openSync(logPath, 'a');
  const child = spawn('/bin/bash', ['-c', INSTALL_CMD], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.on('error', (err) => {
    try {
      fs.appendFileSync(logPath, `\nfailed to start the installer: ${String(err)}\n`);
    } catch {
    }
  });
  child.unref();
  fs.closeSync(log);
  return logPath;
}
