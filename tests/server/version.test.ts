/**
 * GET /api/version — the GitHub update check. The route must be silent on
 * every failure (a check that can fail loudly is worse than no check), lazy
 * (no remote read until asked), cached, and provably network-free whenever
 * the local version is unknown or the check is disabled.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { endUpdateWindow, installRoot, isUpdating, startUpdate } from '../../src/server/updater';
import { COMMIT_URL, compareVersions, VERSION_URL } from '../../src/server/version';
import { HOST, makeTestApp, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
  execFileSync: vi.fn(),
  pending: vi.fn(() => 0),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFileSync: mocks.execFileSync,
}));

vi.mock('../../src/server/routes/borosPair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/routes/borosPair')>()),
  borosExecutionsPending: mocks.pending,
}));

const MAIN_SHA = '3f7c1b9e2d4a6058cbe1740f9a2d5b83c6e0f1a4';

/** A stand-in for install.ps1, pointed at with BOROS_INSTALLER so the Windows
 * path stages from disk instead of the network. It only has to look enough like
 * the real thing to pass the captive-portal guard. */
function fakeInstaller(dir: string): string {
  const p = path.join(dir, 'fake-install.ps1');
  writeFileSync(p, '# Arbitrage with CrossEx - Windows installer (test fixture)\n');
  return p;
}

/** The first two bytes each platform's package must start with. A staged file
 * that fails them is a captive portal's HTML, not a release. */
const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function stagePackage(root: string, name: string, body: Buffer | string): string {
  const file = path.join(root, 'pkg', name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

/** Minimal FetchLike stub in the boros-stub style. */
function stub(
  body: unknown,
  opts: { status?: number; reject?: boolean; calls?: string[]; sha?: string | null } = {},
): FetchLike {
  return async (url) => {
    opts.calls?.push(url);
    if (opts.reject) throw new Error('network down');
    if (url === COMMIT_URL) {
      const sha = opts.sha === undefined ? MAIN_SHA : opts.sha;
      if (sha === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ object: { sha } }) };
    }
    const status = opts.status ?? 200;
    return { ok: status < 400, status, json: async () => body };
  };
}

describe('GET /api/version', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(() => {
    // The route stages the package under the install root, so a root that is
    // not pointed somewhere disposable writes next to the checkout.
    root = mkdtempSync(path.join(tmpdir(), 'ver-'));
    process.env.BOROS_ROOT = root;
  });
  afterEach(async () => {
    delete process.env.BOROS_ROOT;
    await app?.close();
  });

  const get = () => app.inject({ method: 'GET', url: '/api/version', headers: HOST });

  it('announces a newer remote with its highlights', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: ['a', 'b'] }, { calls }),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      current: '1.0.0',
      install: null,
      latest: '1.1.0',
      latestCommit: MAIN_SHA,
      updateAvailable: true,
      packageReady: false,
      highlights: ['a', 'b'],
    });
    expect(calls).toEqual([VERSION_URL, COMMIT_URL]);
  });

  it('equal versions: no update, no highlights', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.1.0' },
      versionFetch: stub({ version: '1.1.0', highlights: ['a'] }),
    });
    const { data } = (await get()).json();
    expect(data.updateAvailable).toBe(false);
    expect(data.highlights).toEqual([]);
  });

  it('a locally-newer dev checkout never sees the banner', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.2.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
  });

  it('network failure is silent: 200, no update — the route never throws', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub(null, { reject: true }),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      current: '1.0.0',
      install: null,
      latest: null,
      latestCommit: null,
      updateAvailable: false,
      packageReady: false,
      highlights: [],
    });
  });

  it('non-200 and malformed bodies are equally silent', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0' }, { status: 404 }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
    await app.close();

    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: 42 }),
    });
    expect((await get()).json().data.latest).toBeNull();
    await app.close();

    // Unparseable remote version → null compare → "not newer".
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.0.x' }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
  });

  it('caches the remote read — two requests, one fetch', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { calls }),
    });
    await get();
    await get();
    expect(calls.filter((u) => u === VERSION_URL)).toHaveLength(1);
    expect(calls.filter((u) => u === COMMIT_URL)).toHaveLength(1);
  });

  it('UPDATE_CHECK=0 (disabled) never touches the network', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0', disabled: true },
      versionFetch: stub({ version: '9.9.9', highlights: [] }, { calls }),
    });
    const { data } = (await get()).json();
    expect(calls).toHaveLength(0);
    expect(data).toEqual({
      current: '1.0.0',
      install: null,
      latest: null,
      latestCommit: null,
      updateAvailable: false,
      packageReady: false,
      highlights: [],
    });
  });

  it('an unknown local version (the makeTestApp default) is network-free too', async () => {
    // Every existing test app omits updateCheck — this pins that none of them
    // can escape nock through the update check's global-fetch default.
    const calls: string[] = [];
    app = makeTestApp({ versionFetch: stub({ version: '9.9.9', highlights: [] }, { calls }) });
    const { data } = (await get()).json();
    expect(calls).toHaveLength(0);
    expect(data.current).toBeNull();
    expect(data.updateAvailable).toBe(false);
  });

  it('a sha read that fails still announces the update, unpinned', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { sha: null }),
    });
    const { data } = (await get()).json();
    expect(data.updateAvailable).toBe(true);
    expect(data.latestCommit).toBeNull();
  });

  it('refuses a sha that is not 40 hex characters', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { sha: 'main; rm -rf /' }),
    });
    expect((await get()).json().data.latestCommit).toBeNull();
  });

  it('reports a staged package, and does not count a captive-portal page as one', async () => {
    const staged = stagePackage(root, 'crossex-1.1.0.tar.gz', GZIP);
    const make = () =>
      makeTestApp({
        updateCheck: { current: '1.0.0' },
        versionFetch: stub({ version: '1.1.0', highlights: [] }),
      });
    app = make();
    expect((await get()).json().data.packageReady).toBe(true);
    await app.close();

    // A captive portal answers 200 with an HTML page. Counting that as ready
    // would move the failure from before the update into the middle of it.
    writeFileSync(staged, '<html>sign in to continue</html>');
    app = make();
    expect((await get()).json().data.packageReady).toBe(false);
  });

  it('sweeps a stale package but keeps the staged installer', async () => {
    stagePackage(root, 'install.sh', '#!/bin/bash\n# Arbitrage with CrossEx\n');
    const stale = stagePackage(root, 'crossex-1.0.9.tar.gz', GZIP);
    // A version no other case here uses: the sweep runs once per version, and
    // a repeat of one already prefetched in this process is a no-op.
    app = makeTestApp({
      // Prefetch runs only for an installed copy. A source checkout resolves
      // its root to the checkout's PARENT, and must never stage anything there.
      install: {
        repo: 'pendle-finance/arbitrage-with-crossex',
        requestedRef: 'v1.0.0',
        commit: MAIN_SHA,
        source: 'release-package',
        installedAt: '2026-08-01T10:00:00Z',
      },
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.2.5', highlights: [] }),
    });

    await get();

    // Only one package is kept. The installer is not version-specific, so a
    // sweep that took it would put the network back in the update.
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(root, 'pkg', 'install.sh'))).toBe(true);
  });

  it('echoes the installer provenance so the UI can show which commit runs', async () => {
    const install = {
      repo: 'pendle-finance/arbitrage-with-crossex',
      requestedRef: 'refs/heads/main',
      commit: 'f4f681af8b36c1bddc98048f214ff1405d56ca73',
      source: 'github-archive',
      installedAt: '2026-07-30T10:00:00Z',
    };
    app = makeTestApp({ updateCheck: { current: '1.0.0', disabled: true }, install });
    expect((await get()).json().data.install).toEqual(install);
  });
});

describe('compareVersions', () => {
  it('compares piecewise numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')!).toBeGreaterThan(0);
    expect(compareVersions('1.9.9', '1.10.0')!).toBeLessThan(0);
  });

  it('tolerates a v prefix and differing segment counts', () => {
    expect(compareVersions('v1.1.0', '1.1')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')!).toBeGreaterThan(0);
  });

  it('returns null on garbage — treated as "not newer" by callers', () => {
    expect(compareVersions('1.0.x', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', '')).toBeNull();
    expect(compareVersions('main', '1.0.0')).toBeNull();
  });
});

describe('POST /api/version/update', () => {
  const INSTALLED = {
    repo: 'pendle-finance/arbitrage-with-crossex',
    requestedRef: 'refs/heads/main',
    commit: 'f4f681af8b36c1bddc98048f214ff1405d56ca73',
    source: 'github-archive',
    installedAt: '2026-07-30T10:00:00Z',
  };

  let app: FastifyInstance;
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    mocks.pending.mockClear();
    home = mkdtempSync(path.join(tmpdir(), 'upd-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    // The default macOS root, under this HOME. The log, the staged installer
    // and the staged package all live under the root, and none of them may
    // land in the real install.
    process.env.BOROS_ROOT = path.join(home, '.boros-crossex');
  });
  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    delete process.env.BOROS_ROOT;
    await app?.close();
  });

  const post = () => app.inject({ method: 'POST', url: '/api/version/update', headers: HOST });

  it('spawns the installer detached, returns its log path, and does not exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    app = makeTestApp({ install: INSTALLED });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      started: true,
      logPath: path.join(home, 'Library', 'Logs', 'boros-crossex', 'update.log'),
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ];
    expect(cmd).toBe('/bin/bash');
    expect(args[1]).toContain('/main/install.sh');
    expect(opts.detached).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('refuses while a deal is still working, and names it', async () => {
    const store = new Store(':memory:');
    store.createPair({
      id: 'busy-deal-update',
      mode: 'OPENING',
      a: { contract: 'GATE_FUTURE_ETH_USDT', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
      b: null,
      targetQty: '0.05',
      limitPrice: '2500',
      pricePolicy: 'fixed',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      haltReason: null,
      reportJson: null,
      createdAt: Date.now(),
    });
    const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
    app = makeTestApp({
      install: INSTALLED,
      engine: { store, venue: gateVenue(() => clients), clock: { now: () => Date.now() } },
    });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ category: 'validation', retryable: true });
    expect(res.json().error.message).toMatch(/deal is still working/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses while a Boros order may still be settling, and names it', async () => {
    mocks.pending.mockReturnValueOnce(1);
    app = makeTestApp({ install: INSTALLED });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Boros order may still be settling/);
    expect(res.json().error.retryable).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses on a source checkout, and says retrying will not help', async () => {
    app = makeTestApp({ install: null });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/source checkout/);
    expect(res.json().error.retryable).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('installs the published release, and pins no commit even when it knows one', async () => {
    // The release asset for the advertised version is the stronger pin: a
    // published asset cannot change under the installer, a branch can.
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });

    const res = await post();

    expect('ref' in res.json().data).toBe(false);
    const [, args, opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_REF).toBeUndefined();
    expect(args[1]).toContain('/main/install.sh');
  });

  it('never hands NODE_ENV to the installer', async () => {
    // The LaunchAgent runs the server with NODE_ENV=production. Yarn 1 reads
    // that as --production, skips devDependencies and still exits 0, so the
    // installer's `yarn build` loses vite and typescript and dies. Inheriting
    // the server's env wholesale makes every update from the button fail.
    const real = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      app = makeTestApp({
        install: INSTALLED,
        updateCheck: { current: '1.0.0' },
        versionFetch: stub({ version: '1.1.0', highlights: [] }),
      });

      await post();

      const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect('NODE_ENV' in opts.env).toBe(false);
      // The rest of the environment still goes through — PATH above all.
      expect(opts.env.PATH).toBe(process.env.PATH);
    } finally {
      if (real === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = real;
    }
  });

  it('updates the install the server runs from, not a second copy in the default root', async () => {
    // Without BOROS_ROOT the installer resolves the DEFAULT root, so a
    // custom-root user was given a second install with an empty config and an
    // empty ledger while their keys stayed in the old folder.
    const custom = path.join(home, 'custom-root');
    process.env.BOROS_ROOT = custom;
    app = makeTestApp({ install: INSTALLED });

    const res = await post();

    expect(res.json().data.logPath).toBe(path.join(custom, 'logs', 'update.log'));
    const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_ROOT).toBe(custom);
  });

  it('falls back to the folder the app runs from, not to a guessed home folder', async () => {
    delete process.env.BOROS_ROOT;
    // install.sh puts the app in <root>/app, so the root is the app folder's
    // parent. The old fallback was ~/CrossEx-Boros, which is nobody's install.
    expect(installRoot()).toBe(path.dirname(path.resolve(__dirname, '../..')));
  });

  it('hands the staged package to the installer, so the update needs no download', async () => {
    const staged = stagePackage(process.env.BOROS_ROOT!, 'crossex-1.1.0.tar.gz', GZIP);
    app = makeTestApp({ install: INSTALLED });

    await post();

    const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    // Handed over once, under a name stagedPackage() no longer returns: an
    // archive that will not extract must not come back on every later press.
    expect(opts.env.BOROS_TARBALL).toBe(`${staged}.used`);
    expect(existsSync(staged)).toBe(false);
  });

  it('runs the staged installer, so a click with no network still installs', async () => {
    // The package alone is not enough. INSTALL_CMD curls install.sh, so an
    // update with the cable out died on the script, not on the package.
    const installer = stagePackage(
      process.env.BOROS_ROOT!,
      'install.sh',
      '#!/bin/bash\n# Arbitrage with CrossEx\n',
    );
    app = makeTestApp({ install: INSTALLED });

    await post();

    const [file, args] = mocks.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('/bin/bash');
    expect(args).toEqual([installer]);
    expect(args.join(' ')).not.toContain('curl');
  });

  it('falls back to the published command when nothing is staged', async () => {
    app = makeTestApp({ install: INSTALLED });

    await post();

    const [, args] = mocks.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('install.sh');
  });


  it("carries the server's own port, and carries none when the server has none", async () => {
    // install.sh reads BOROS_PORT, but the LaunchAgent exports PORT. A server
    // on 6699 would otherwise be updated as an install on 6688 and fail the
    // port check the default install holds.
    const realPort = process.env.PORT;
    app = makeTestApp({ install: INSTALLED });
    try {
      process.env.PORT = '6699';
      await post();
      delete process.env.PORT;
      await post();
    } finally {
      if (realPort === undefined) delete process.env.PORT;
      else process.env.PORT = realPort;
    }

    const envs = (
      mocks.spawn.mock.calls as unknown as [string, string[], { env: Record<string, string> }][]
    ).map((c) => c[2].env);
    expect(envs[0].BOROS_PORT).toBe('6699');
    // No port to pass means the installer keeps its own default.
    expect('BOROS_PORT' in envs[1]).toBe(false);
  });

  it('on Windows the installer runs as its own scheduled task, outside the service job', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    app = makeTestApp({ install: INSTALLED });
    try {
      const res = await post();

      expect(res.json().data.logPath).toBe(path.join(home, 'logs', 'update.log'));
      expect(mocks.spawn).not.toHaveBeenCalled();
      const calls = mocks.execFileSync.mock.calls as unknown as [string, string[]][];
      expect(calls.map((c) => c[0])).toEqual(['powershell']);
      const cmd = calls[0][1][calls[0][1].indexOf('-Command') + 1];
      // schtasks cannot register a task that runs on battery power, so a
      // laptop on battery never started the update at all.
      expect(cmd).toContain('-AllowStartIfOnBatteries');
      expect(cmd).toContain('-DontStopIfGoingOnBatteries');
      expect(cmd).toContain('Register-ScheduledTask -TaskName BorosUpdate');
      expect(cmd).toContain('-Force');
      // Registering without starting makes every update wait a minute.
      expect(cmd).toContain('Start-ScheduledTask -TaskName BorosUpdate');
      // The other two switches on install.ps1's settings call would re-run the
      // installer every minute, and run a missed update days later.
      expect(cmd).not.toMatch(/RestartCount|StartWhenAvailable/);

      // The task deletes itself, whether the install works, fails or rolls back.
      const runner = readFileSync(path.join(home, 'update.ps1'), 'utf8');
      expect(runner.trimEnd().endsWith('Unregister-ScheduledTask -TaskName BorosUpdate -Confirm:$false')).toBe(
        true,
      );

      // The installer is staged to disk and the task runs THAT.
      expect(readFileSync(path.join(home, 'update-installer.ps1'), 'utf8')).toContain(
        'Arbitrage with CrossEx',
      );
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });

  /** The bug that made the button dead on Windows: a /tr carrying
   * `irm <url> | iex` is detected as Trojan:Win32/Commando.A!ml and the process
   * creation denied (`spawnSync schtasks EPERM`). Only a local path may reach
   * that command line. */
  it('puts no download-and-execute on the scheduled task command line', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    app = makeTestApp({ install: INSTALLED });
    try {
      await post();

      const args = (mocks.execFileSync.mock.calls as unknown as [string, string[]][])[0][1];
      const cmd = args[args.indexOf('-Command') + 1];
      const taskArg = cmd.match(/-Argument '([^']*)'/)![1];

      expect(taskArg).toBe(
        `-NoProfile -ExecutionPolicy Bypass -File "${path.join(home, 'update.ps1')}"`,
      );
      expect(taskArg).not.toMatch(/iex|Invoke-Expression|https?:|-Command/i);
      // Everything the update needs travels in the staged runner on disk.
      expect(cmd).not.toMatch(/iex|Invoke-Expression|https?:/i);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });

  it('the staged runner carries the root, the port and the staged package', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const realPort = process.env.PORT;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    process.env.PORT = '6699';
    const staged = stagePackage(home, 'crossex-1.1.0.zip', ZIP);
    app = makeTestApp({ install: INSTALLED });
    try {
      await post();

      const runner = readFileSync(path.join(home, 'update.ps1'), 'utf8');
      expect(runner).toContain(`$env:BOROS_ROOT = '${home}'`);
      expect(runner).toContain("$env:BOROS_PORT = '6699'");
      expect(runner).toContain(`$env:BOROS_ZIP = '${staged}.used'`);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
      if (realPort === undefined) delete process.env.PORT;
      else process.env.PORT = realPort;
    }
  });

  it('reports a failed download in the dialog instead of scheduling a task that does nothing', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = path.join(home, 'does-not-exist.ps1');
    app = makeTestApp({ install: INSTALLED });
    try {
      const res = await post();

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/could not start the update/);
      expect(res.json().error.retryable).toBe(true);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });
});

describe('the window that refuses Boros orders while an update runs', () => {
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    endUpdateWindow();
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    home = mkdtempSync(path.join(tmpdir(), 'upd-win-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    // These cases cover the update WINDOW, not either platform's launch
    // mechanism, so they run on whatever host they are on. On Windows that
    // stages an installer and a log under BOROS_ROOT, which would otherwise
    // land in the real %LOCALAPPDATA% install. The darwin branch reads neither.
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    process.env.BOROS_ROOT = home;
  });
  afterEach(() => {
    vi.useRealTimers();
    endUpdateWindow();
    delete process.env.BOROS_INSTALLER;
    delete process.env.BOROS_ROOT;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  it('opens on a launch that starts, then closes on its own after ten minutes', async () => {
    vi.useFakeTimers();
    await startUpdate();

    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUpdating()).toBe(false);
  });

  it('closes when the installer fails to start, so orders are not refused forever', async () => {
    await startUpdate();
    expect(isUpdating()).toBe(true);

    const handle = mocks.spawn.mock.results[0].value as { on: { mock: { calls: unknown[][] } } };
    const onError = handle.on.mock.calls.find((c) => c[0] === 'error')![1] as (e: Error) => void;
    onError(new Error('bash is missing'));

    expect(isUpdating()).toBe(false);
  });

  it.each([
    ['a build that failed', 1, null],
    ['a kill', null, 'SIGTERM'],
  ])('closes when the installer dies after starting — %s', async (_case, code, signal) => {
    await startUpdate();
    expect(isUpdating()).toBe(true);

    const handle = mocks.spawn.mock.results[0].value as { on: { mock: { calls: unknown[][] } } };
    const onExit = handle.on.mock.calls.find((c) => c[0] === 'exit')![1] as (
      c: number | null,
      s: string | null,
    ) => void;
    onExit(code, signal);

    expect(isUpdating()).toBe(false);
  });

  it('leaves the window open while the installer is still working', async () => {
    await startUpdate();

    const handle = mocks.spawn.mock.results[0].value as { on: { mock: { calls: unknown[][] } } };
    const onExit = handle.on.mock.calls.find((c) => c[0] === 'exit')![1] as (
      c: number | null,
      s: string | null,
    ) => void;
    onExit(0, null);

    expect(isUpdating()).toBe(true);
  });

  it('refuses a ref that is not a commit sha, rather than passing it to a shell', async () => {
    await startUpdate("main'; rm -rf ~; echo '");

    const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_REF).toBeUndefined();
  });

  it('pins the update to the commit in the staged runner on Windows', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    try {
      await startUpdate(MAIN_SHA);

      expect(readFileSync(path.join(home, 'update.ps1'), 'utf8')).toContain(
        `$env:BOROS_REF = '${MAIN_SHA}'`,
      );
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });

  it('never opens when the scheduled task cannot be created', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('powershell is not on this machine');
    });
    try {
      await expect(startUpdate()).rejects.toThrow(/powershell is not on this machine/);
      expect(isUpdating()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });

  it('never opens when the installer cannot be staged', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = path.join(home, 'nope.ps1');
    try {
      await expect(startUpdate()).rejects.toThrow();
      expect(isUpdating()).toBe(false);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });
});
