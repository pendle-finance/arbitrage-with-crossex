import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

function configBlock(): string {
  const sh = read('install.sh');
  const start = sh.indexOf('LABEL="com.boros.crossex-terminal"');
  const end = sh.indexOf('\n', sh.indexOf('ROOT="${BOROS_ROOT'));
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sh.slice(start, end);
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function fakeHome(plist?: { port: string; workdir: string }): string {
  const home = mkdtempSync(join(tmpdir(), 'boros-keep-'));
  homes.push(home);
  if (plist) {
    const dir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'com.boros.crossex-terminal.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.boros.crossex-terminal</string>
  <key>WorkingDirectory</key>
  <string>${plist.workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${plist.port}</string>
  </dict>
</dict>
</plist>
`,
    );
  }
  return home;
}

function runConfig(home: string, env: Record<string, string> = {}): { port: string; root: string } {
  const script = ['set -euo pipefail', configBlock(), 'printf "%s|%s" "$PORT" "$ROOT"'].join('\n');
  const { BOROS_PORT: _p, BOROS_ROOT: _r, ...clean } = process.env;
  const [port, root] = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...clean, HOME: home, ...env },
  }).split('|');
  return { port, root };
}

describe.runIf(process.platform === 'darwin')('install.sh keeps the port and folder of the existing install', () => {
  it('uses the defaults when there is no install', () => {
    const home = fakeHome();
    expect(runConfig(home)).toEqual({ port: '6688', root: `${home}/.boros-crossex` });
  });

  it('reads the port and folder from the existing LaunchAgent', () => {
    const home = fakeHome({ port: '7791', workdir: '/Users/x/custom-root/app' });
    expect(runConfig(home)).toEqual({ port: '7791', root: '/Users/x/custom-root' });
  });

  it('lets BOROS_PORT and BOROS_ROOT win over the existing LaunchAgent', () => {
    const home = fakeHome({ port: '7791', workdir: '/Users/x/custom-root/app' });
    expect(runConfig(home, { BOROS_PORT: '7000', BOROS_ROOT: '/Users/x/other' })).toEqual({
      port: '7000',
      root: '/Users/x/other',
    });
  });

  it('ignores values that the installer did not write', () => {
    const home = fakeHome({ port: 'abc', workdir: '/Users/x/elsewhere' });
    expect(runConfig(home)).toEqual({ port: '6688', root: `${home}/.boros-crossex` });
  });
});

describe('install.ps1 reads back what it wrote', () => {
  const ps = read('install.ps1');

  it('the port pattern matches the runner line the installer writes', () => {
    const template = ps.split('\n').find((l) => l.startsWith('`$env:PORT = '));
    expect(template).toBeDefined();
    const written = (template as string).replace('`$', '$').replace('$Port', '7791');
    const pattern = ps.match(/-Pattern '((?:[^']|'')+)'/)?.[1].replaceAll("''", "'");
    expect(pattern).toBeDefined();
    expect(new RegExp(pattern as string).exec(written)?.[1]).toBe('7791');
  });

  it('the runner pattern matches the task action the installer writes', () => {
    const argLine = ps.split('\n').find((l) => l.includes('-Argument "--headless powershell.exe'));
    expect(argLine).toBeDefined();
    const runner = 'C:\\Users\\x\\custom-root\\run-server.ps1';
    const written = (argLine as string).match(/-Argument "(.*)"$/)?.[1].replaceAll('`"', '"').replace('$runner', runner);
    const pattern = ps.match(/-match '([^']+run-server[^']+)'/)?.[1];
    expect(pattern).toBeDefined();
    expect(new RegExp(pattern as string).exec(written as string)?.[1]).toBe(runner);
  });
});
