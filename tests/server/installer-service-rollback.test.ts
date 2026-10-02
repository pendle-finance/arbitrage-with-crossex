import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';

function shFunction(sh: string, name: string): string {
  const start = sh.indexOf(`\n${name}() {`);
  expect(start, `${name} is gone from install.sh`).toBeGreaterThan(0);
  return sh.slice(start, sh.indexOf('\n}', start) + 2);
}

function shLine(sh: string, name: string): string {
  const line = sh.split('\n').find((l) => l.startsWith(`${name}()`));
  expect(line, `${name} is gone from install.sh`).toBeDefined();
  return line as string;
}

function psFunction(ps: string, name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone from install.ps1`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  bootstrapFails?: number;
  plutilFails?: number;
  healthy?: string[];
  failMv?: [string, string];
  fastHealth?: boolean;
  plist?: string;
  run?: string;
}

interface Result {
  status: number | null;
  out: string;
  err: string;
  ms: number;
  root: string;
  calls: (tool: string) => string[];
  version: (folder: string) => string | null;
  loaded: () => string | null;
}

function stub(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function runInstaller(setup: Setup): Result {
  const t = mkdtempSync(join(tmpdir(), 'boros-c1-'));
  dirs.push(t);
  const root = join(t, 'root');
  const bin = join(t, 'bin');
  for (const d of [bin, join(t, 'logs'), join(t, 'LaunchAgents'), join(root, 'app'), join(root, 'app.new')]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(root, 'app', 'VERSION'), 'old');
  writeFileSync(join(root, 'app.new', 'VERSION'), 'new');

  stub(
    bin,
    'launchctl',
    [
      `echo "$*" >> '${t}/launchctl.calls'`,
      'case "$1" in',
      `  bootout) rm -f '${t}/loaded' ;;`,
      `  print) [ -f '${t}/loaded' ] || exit 113 ;;`,
      '  bootstrap)',
      `    n=$(grep -c '^bootstrap' '${t}/launchctl.calls')`,
      `    if [ "$n" -le ${setup.bootstrapFails ?? 0} ]; then echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi`,
      `    cat '${root}/app/VERSION' > '${t}/loaded' ;;`,
      'esac',
      'exit 0',
    ].join('\n'),
  );
  stub(
    bin,
    'plutil',
    [
      `echo "$*" >> '${t}/plutil.calls'`,
      `[ "$(grep -c . '${t}/plutil.calls')" -gt ${setup.plutilFails ?? 0} ] || exit 1`,
    ].join('\n'),
  );
  stub(
    bin,
    'curl',
    [
      `echo "$*" >> '${t}/curl.calls'`,
      `v=$(cat '${t}/loaded' 2>/dev/null) || exit 7`,
      `case " ${(setup.healthy ?? ['old', 'new']).join(' ')} " in *" $v "*) echo '{"status":"ok"}'; exit 0 ;; esac`,
      'exit 7',
    ].join('\n'),
  );
  stub(bin, 'lsof', 'exit 1');
  stub(bin, 'pgrep', 'exit 1');
  stub(bin, 'id', 'echo 501');
  if (setup.failMv) {
    const [from, to] = setup.failMv;
    stub(
      bin,
      'mv',
      [
        `if [ "$1|$2" = '${root}/${from}|${root}/${to}' ]; then echo 'mv: forced failure' >&2; exit 1; fi`,
        'exec /bin/mv "$@"',
      ].join('\n'),
    );
  }
  if (setup.fastHealth) stub(bin, 'seq', 'echo 1; echo 2; echo 3');

  const sh = read('install.sh');
  const script = [
    'set -euo pipefail',
    `export PATH='${bin}':"$PATH"`,
    'for c in launchctl plutil curl lsof pgrep id; do',
    `  [ "$(command -v "$c")" = '${bin}'/"$c" ] || { echo "stub missing: $c" >&2; exit 99; }`,
    'done',
    `ROOT='${root}'`,
    'PORT=7791',
    "LABEL='com.boros.crossex-terminal.c1-test'",
    "APP_TITLE='Arbitrage with CrossEx'",
    `LOG_DIR='${t}/logs'`,
    `PLIST='${setup.plist ?? `${t}/LaunchAgents/c1-test.plist`}'`,
    shLine(sh, 'say'),
    shLine(sh, 'fail'),
    shLine(sh, 'remove_old_app'),
    'preflight() { :; }',
    'install_node() { :; }',
    'install_yarn() { :; }',
    'fetch_app() { :; }',
    'build_app() { :; }',
    'make_launcher() { :; }',
    'open() { :; }',
    ...[
      'swap_app',
      'restore_app',
      'fail_not_restored',
      'server_pids',
      'stop_stale_server',
      'port_in_use_by_other_app',
      'write_plist',
      'install_service',
      'wait_for_server',
      'main',
    ].map((f) => shFunction(sh, f)),
    setup.run ?? 'main',
  ].join('\n');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('BOROS_')) env[k] = v;
  }
  env.HOME = t;
  env.BOROS_NO_BROWSER = '1';
  const started = Date.now();
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', env, timeout: 25_000 });
  const ms = Date.now() - started;
  expect(r.error, 'the run was killed (it waited too long)').toBeUndefined();
  expect(r.stderr).not.toContain('stub missing');

  const lines = (f: string): string[] =>
    existsSync(join(t, f)) ? readFileSync(join(t, f), 'utf8').split('\n').filter(Boolean) : [];
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    ms,
    root,
    calls: (tool) => lines(`${tool}.calls`),
    version: (folder) => (existsSync(join(root, folder, 'VERSION')) ? readFileSync(join(root, folder, 'VERSION'), 'utf8') : null),
    loaded: () => (existsSync(join(t, 'loaded')) ? readFileSync(join(t, 'loaded'), 'utf8') : null),
  };
}

const bootstraps = (r: Result): string[] => r.calls('launchctl').filter((c) => c.startsWith('bootstrap'));

describe('install.sh rolls back when the background service cannot be registered', { timeout: 30_000 }, () => {
  it('retries a failed bootstrap once after 2 s and keeps the new version', () => {
    const r = runInstaller({ bootstrapFails: 1 });
    expect(r.status).toBe(0);
    expect(bootstraps(r)).toHaveLength(2);
    expect(r.ms).toBeGreaterThanOrEqual(1900);
    expect(r.err).not.toContain('Rolling back');
    expect(r.out).toContain('Done!');
    expect(r.version('app')).toBe('new');
    expect(existsSync(join(r.root, 'app.old'))).toBe(false);
  });

  it('puts the old version back on disk and says no server runs when bootstrap keeps failing', () => {
    const r = runInstaller({ bootstrapFails: 99 });
    expect(r.status).toBe(1);
    expect(r.err).toContain('Rolling back to the previous version');
    expect(r.err).toContain('could not register the background service, and the previous version could not be restored.');
    expect(r.err).toContain('NO SERVER IS RUNNING');
    expect(r.err).toContain('Open deals are not being watched');
    expect(bootstraps(r)).toHaveLength(4);
    expect(r.calls('curl')).toEqual([]);
    expect(r.ms).toBeLessThan(15_000);
    expect(r.version('app')).toBe('old');
    expect(r.version('app.failed')).toBe('new');
    expect(r.loaded()).toBeNull();
  });

  it('runs the previous version when only the restore can register the service', () => {
    const r = runInstaller({ bootstrapFails: 2 });
    expect(r.status).toBe(1);
    expect(bootstraps(r)).toHaveLength(3);
    expect(r.err).toContain('the previous version is running again at http://localhost:7791');
    expect(r.err).toContain('could not register the background service, so the previous version was put back and is running.');
    expect(r.err).not.toContain('NO SERVER IS RUNNING');
    expect(r.version('app')).toBe('old');
    expect(r.version('app.failed')).toBe('new');
  });

  it('does not say no server runs when the restored version is registered but does not answer', () => {
    const r = runInstaller({ bootstrapFails: 2, healthy: ['none'], fastHealth: true });
    expect(r.status).toBe(1);
    expect(bootstraps(r)).toHaveLength(3);
    expect(r.calls('curl').length).toBeGreaterThan(0);
    expect(r.err).toContain('could not register the background service, and the rollback did not finish.');
    expect(r.err).toContain('A background service is still registered');
    expect(r.err).not.toContain('NO SERVER IS RUNNING');
    expect(r.err).not.toContain('is running again');
    expect(r.err).not.toContain('put back and is running');
    expect(r.loaded()).toBe('old');
  });

  it('says the old version is still registered when the health-check rollback cannot confirm it', () => {
    const r = runInstaller({ healthy: ['none'], fastHealth: true });
    expect(r.status).toBe(1);
    expect(bootstraps(r)).toHaveLength(2);
    expect(r.err).toContain('the new version did not start, and the rollback did not finish.');
    expect(r.err).not.toContain('NO SERVER IS RUNNING');
    expect(r.loaded()).toBe('old');
  });

  it('rolls back a plist that fails validation after the swap', () => {
    const r = runInstaller({ plutilFails: 1 });
    expect(r.status).toBe(1);
    expect(r.err).toContain('generated LaunchAgent plist failed validation.');
    expect(r.err).toContain('so the previous version was put back and is running.');
    expect(bootstraps(r)).toHaveLength(1);
    expect(r.version('app')).toBe('old');
  });

  it('write_plist returns non-zero when the plist cannot be written', () => {
    const r = runInstaller({ plist: '/nonexistent-c1-dir/c1-test.plist', run: 'if ! write_plist; then echo WRITE-FAILED; fi' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('WRITE-FAILED');
    expect(r.calls('plutil')).toEqual([]);
  });

  it.each([
    ['app', 'app.failed'],
    ['app.old', 'app'],
  ] as [string, string][])('the restore stops when it cannot move %s to %s', (from, to) => {
    const r = runInstaller({ bootstrapFails: 99, failMv: [from, to] });
    expect(r.status).toBe(1);
    expect(r.err).toContain('NO SERVER IS RUNNING');
    expect(bootstraps(r)).toHaveLength(2);
    expect(existsSync(join(r.root, 'app', 'app.old'))).toBe(false);
  });

  it('keeps the health-check rollback and its messages', () => {
    const r = runInstaller({ healthy: ['old'], fastHealth: true });
    expect(r.status).toBe(1);
    expect(r.err).toContain('Note: the app did not answer on port 7791.');
    expect(r.err).toContain('the new version did not start, so the previous one was put back and is running.');
    expect(r.err).toContain('Why the new version failed:');
    expect(bootstraps(r)).toHaveLength(2);
    expect(r.version('app')).toBe('old');
    expect(r.version('app.failed')).toBe('new');
  });
});

describe('install.ps1 rolls back when the background service cannot be registered', () => {
  const ps = read('install.ps1');
  const main = ps.slice(ps.lastIndexOf('\ntry {'));
  const retried = /try\s*\{\s*Invoke-WithRetry\s*\{\s*Install-Service\s*\}\s*-Tries\s+2\s+-DelayMs\s+2000\s*\}\s*catch\s*\{/;

  it('retries the service step once, after the swap and before the health check', () => {
    const m = retried.exec(main);
    expect(m, 'the main Install-Service call has no retry and no catch').not.toBeNull();
    const at = (m as RegExpExecArray).index;
    expect(main.indexOf('Swap-App')).toBeLessThan(at);
    expect(at).toBeLessThan(main.indexOf('Wait-ForServer'));
  });

  it('runs Restore-App inside its own guard, then fails with a plain message', () => {
    const m = retried.exec(main);
    expect(m).not.toBeNull();
    const { index, 0: head } = m as RegExpExecArray;
    const handler = main.slice(index + head.length, main.indexOf('Wait-ForServer'));
    const restore = handler.indexOf('Restore-App');
    expect(restore, 'the catch path does not call Restore-App').toBeGreaterThan(0);
    expect(handler.slice(0, restore)).toMatch(/try\s*\{\s*(\$\w+\s*=\s*)?$/);
    const guardEnd = handler.slice(restore).search(/\}\s*catch\s*\{/);
    expect(guardEnd, 'Restore-App has no catch').toBeGreaterThan(0);
    expect(handler.slice(restore, restore + guardEnd)).not.toMatch(/\bFail\b/);
    const after = handler.slice(restore + guardEnd).replace(/\s+/g, ' ');
    expect(after).toMatch(/Fail "could not register the background service \(\$why\), so the previous version was put back and is running\./);
    expect(after).toContain('Fail-NotRestored "could not register the background service ($why)"');
  });

  it('says no server runs only when no task is left to start one', () => {
    const fn = psFunction(ps, 'Fail-NotRestored').replace(/\s+/g, ' ');
    const check = fn.search(/if \(Get-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue\) \{ Fail @"/);
    expect(check, 'no task check before the NO SERVER message').toBeGreaterThan(0);
    const registered = fn.indexOf('$What, and the rollback did not finish. A background task is still registered');
    const none = fn.indexOf('$What, and the previous version could not be restored. NO SERVER IS RUNNING, and nothing starts it');
    expect(check).toBeLessThan(registered);
    expect(registered).toBeLessThan(none);
    expect(fn).toContain('Open deals are not being watched.');
  });

  it('ends every failed rollback in Fail-NotRestored', () => {
    expect(main).toContain('Fail-NotRestored "could not register the background service ($why)"');
    expect(main).toContain("Fail-NotRestored 'the new version did not start'");
    expect(main).not.toContain('NO SERVER IS RUNNING');
  });

  it('clears a stale app.old before anything is stopped, and never deletes the only copy', () => {
    const getApp = psFunction(ps, 'Get-App');
    expect(getApp).toMatch(/if \(\(Test-Path \$old\) -and \(Test-Path \(Join-Path \$Root 'app'\)\)\) \{ Invoke-WithRetry \{ Remove-Item -Recurse -Force \$old \} \}/);
    expect(main.indexOf('Get-App')).toBeLessThan(main.indexOf('Stop-RunningService'));
    expect(psFunction(ps, 'Swap-App')).toMatch(/if \(\(Test-Path \$old\) -and \(Test-Path \$app\)\) \{ Invoke-WithRetry \{ Remove-Item -Recurse -Force \$old \} \}/);
  });

  it("Restore-App returns $false when its own service step throws", () => {
    const fn = psFunction(ps, 'Restore-App');
    const m = /try\s*\{\s*Install-Service\s*\}\s*catch\s*\{([^}]*)\}/.exec(fn);
    expect(m, "Restore-App's Install-Service is not inside try/catch").not.toBeNull();
    const [whole, body] = m as RegExpExecArray;
    expect(body).toMatch(/return\s+\$false/);
    expect(fn.indexOf('Wait-ForServer')).toBeGreaterThan((m as RegExpExecArray).index);
    const code = fn
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code.replace(whole, '')).not.toContain('Install-Service');
  });

  it('makes a failed registration throw even when the script runs with -File', () => {
    const fn = psFunction(ps, 'Install-Service');
    const register = fn.slice(fn.indexOf('Register-ScheduledTask'), fn.indexOf('| Out-Null', fn.indexOf('Register-ScheduledTask')));
    expect(register).toContain('-ErrorAction Stop');
    expect(fn).toMatch(/Start-ScheduledTask -TaskName \$TaskName -ErrorAction Stop/);
  });
});
