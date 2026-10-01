import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endUpdateWindow, startUpdate } from '../../src/server/updater';
import { releaseFetch } from './helpers/release';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFileSync: mocks.execFileSync,
}));

vi.mock('../../src/server/releaseKey', async () => ({
  RELEASE_PUBLIC_KEYS: [(await import('./helpers/release')).RELEASE_TEST_PEM],
}));

const KEYS = ['HOME', 'PORT', 'BOROS_ROOT', 'BOROS_PORT', 'LOCALAPPDATA'] as const;

function installedApp(root: string): string {
  const appDir = path.join(root, 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'install-info.json'), '{"source":"github-archive"}');
  return appDir;
}

const update = (appDir: string) => startUpdate(releaseFetch(), '1.0.0', appDir);

function spawnEnv(): Record<string, string> {
  const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
  return opts.env;
}

describe('the update installs onto the port and folder this server runs from', () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  const onPlatform = (p: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };

  beforeEach(() => {
    endUpdateWindow();
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    home = mkdtempSync(path.join(tmpdir(), 'upd-target-'));
    process.env.HOME = home;
    process.env.LOCALAPPDATA = home;
    delete process.env.PORT;
    delete process.env.BOROS_ROOT;
    delete process.env.BOROS_PORT;
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    endUpdateWindow();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('macOS: hands the installer the server port and the installed folder', async () => {
    onPlatform('darwin');
    const root = path.join(home, 'custom-root');
    process.env.PORT = '7788';

    await update(installedApp(root));

    expect(spawnEnv().BOROS_PORT).toBe('7788');
    expect(spawnEnv().BOROS_ROOT).toBe(root);
    expect(spawnEnv().BOROS_TARBALL).toBe(path.join(root, 'update', 'app.tar.gz'));
    expect(spawnEnv().BOROS_NO_BROWSER).toBe('1');
    expect(mocks.spawn.mock.calls[0]).toContainEqual([path.join(root, 'update', 'install.sh')]);
  });

  it('macOS: the values the server derives win over the env', async () => {
    onPlatform('darwin');
    const root = path.join(home, 'custom-root');
    process.env.PORT = '7789';
    process.env.BOROS_PORT = '6688';
    process.env.BOROS_ROOT = path.join(home, '.boros-crossex');

    await update(installedApp(root));

    expect(spawnEnv().BOROS_PORT).toBe('7789');
    expect(spawnEnv().BOROS_ROOT).toBe(root);
  });

  it('macOS: a default install gets the same values install.sh defaults to', async () => {
    onPlatform('darwin');
    process.env.PORT = '6688';

    await update(installedApp(path.join(home, '.boros-crossex')));

    expect(spawnEnv().BOROS_PORT).toBe('6688');
    expect(spawnEnv().BOROS_ROOT).toBe(path.join(home, '.boros-crossex'));
  });

  it('macOS: a source checkout passes no folder', async () => {
    onPlatform('darwin');
    const checkout = path.join(home, 'checkout');
    mkdirSync(checkout);
    process.env.PORT = '7788';

    await update(checkout);

    expect('BOROS_ROOT' in spawnEnv()).toBe(false);
    expect(spawnEnv().BOROS_PORT).toBe('7788');
  });

  it.each(['abc', '7788; rm -rf ~', '', '77.88'])('macOS: a PORT of %j is not passed', async (port) => {
    onPlatform('darwin');
    process.env.PORT = port;

    await update(installedApp(path.join(home, 'custom-root')));

    expect('BOROS_PORT' in spawnEnv()).toBe(false);
  });

  it('Windows: the staged runner sets both, quoted for PowerShell', async () => {
    onPlatform('win32');
    const root = path.join(home, "O'Brien files", 'CrossEx-Boros');
    process.env.PORT = '7788';

    await update(installedApp(root));

    const runner = readFileSync(path.join(root, 'update.ps1'), 'utf8');
    const quoted = (s: string): string => s.replace(/'/g, "''");
    expect(runner).toContain(`$env:BOROS_ROOT = '${quoted(root)}'`);
    expect(runner).toContain("$env:BOROS_PORT = '7788'");
    expect(runner).toContain(`$env:BOROS_ZIP = '${quoted(path.join(root, 'update', 'app.zip'))}'`);
    expect(runner).toContain("$env:BOROS_NO_BROWSER = '1'");
    expect(runner).toContain(`'"${quoted(path.join(root, 'update', 'install.ps1'))}"'`);
    expect(runner.indexOf('$env:BOROS_ROOT')).toBeLessThan(runner.indexOf('Start-Process @startArgs'));

    const args = (mocks.execFileSync.mock.calls as unknown as [string, string[]][])[0][1];
    expect(args[args.indexOf('/tr') + 1]).toContain(`-File "${path.join(root, 'update.ps1')}"`);
  });
});
