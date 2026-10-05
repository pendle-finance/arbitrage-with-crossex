/**
 * GET /api/version — the GitHub update check. The route must be silent on
 * every failure (a check that can fail loudly is worse than no check), lazy
 * (no remote read until asked), cached, and provably network-free whenever
 * the local version is unknown or the check is disabled.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { JobFile, newJob, newTransferJob, TransferFile } from '../../src/server/rebalanceJob';
import { endUpdateWindow, isUpdating, startUpdate } from '../../src/server/updater';
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
const RAW = 'https://raw.githubusercontent.com';
const pinned = (file: string): string => `/pendle-finance/arbitrage-with-crossex/${MAIN_SHA}/${file}`;
const INSTALL_SH = '#!/bin/bash\n# Arbitrage with CrossEx — macOS installer (test fixture)\n';
const serveInstaller = (file = 'install.sh', body = INSTALL_SH): nock.Scope =>
  nock(RAW).get(pinned(file)).reply(200, body);

/** A stand-in for install.ps1, pointed at with BOROS_INSTALLER so the Windows
 * path stages from disk instead of the network. It only has to look enough like
 * the real thing to pass the captive-portal guard. */
function fakeInstaller(dir: string): string {
  const p = path.join(dir, 'fake-install.ps1');
  writeFileSync(p, '# Arbitrage with CrossEx - Windows installer (test fixture)\n');
  return p;
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
  afterEach(async () => {
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
  let realInstaller: string | undefined;

  beforeEach(() => {
    endUpdateWindow();
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    mocks.pending.mockClear();
    home = mkdtempSync(path.join(tmpdir(), 'upd-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    realInstaller = process.env.BOROS_INSTALLER;
    delete process.env.BOROS_INSTALLER;
  });
  afterEach(async () => {
    endUpdateWindow();
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realInstaller === undefined) delete process.env.BOROS_INSTALLER;
    else process.env.BOROS_INSTALLER = realInstaller;
    await app?.close();
  });

  const post = () => app.inject({ method: 'POST', url: '/api/version/update', headers: HOST });
  const getVersion = () => app.inject({ method: 'GET', url: '/api/version', headers: HOST });

  it('spawns the installer detached, returns its log path, and does not exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    serveInstaller();
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      started: true,
      logPath: path.join(home, 'Library', 'Logs', 'boros-crossex', 'update.log'),
      ref: MAIN_SHA,
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [cmd, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ];
    expect(cmd).toBe('/bin/bash');
    expect(opts.detached).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('refuses a second update while the first is still running', async () => {
    serveInstaller();
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    expect((await post()).statusCode).toBe(200);

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ category: 'validation', retryable: true });
    expect(res.json().error.message).toContain('already running');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
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

  it('refuses while a pay-down is still running, and names it', async () => {
    const jobs = new JobFile(mkdtempSync(path.join(tmpdir(), 'rebalance-')));
    app = makeTestApp({ install: INSTALLED, rebalance: { jobs } });
    await app.ready();
    jobs.write(
      newJob(
        {
          route: 'loop',
          steps: [{ round: 1, kind: 'round', buy: 12, move: 12, arrives: 11.95, borrowLeft: 0, seconds: 130, from: 'CROSSEX', to: 'HYPERLIQUID' }],
          amount: 12,
          costUsd: 0.05,
          target: [],
          userId: null,
        },
        Date.now(),
      ),
    );

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('a rebalance is still running. Wait for it to finish, then update.');
    expect(res.json().error.retryable).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses while a transfer is still moving, and names it', async () => {
    const transfers = new TransferFile(mkdtempSync(path.join(tmpdir(), 'transfer-')));
    app = makeTestApp({
      install: INSTALLED,
      transfer: { jobs: transfers, sleep: () => new Promise<void>(() => undefined) },
    });
    await app.ready();
    transfers.write(
      newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, Date.now()),
    );

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('A transfer is still moving. Wait for it to end, then update.');
    expect(res.json().error.retryable).toBe(true);
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

  it('installs the exact commit the modal advertised, with the install.sh of that commit', async () => {
    const installer = serveInstaller();
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });

    const res = await post();

    expect(res.json().data.ref).toBe(MAIN_SHA);
    const [, args, opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_REF).toBe(MAIN_SHA);
    expect(installer.isDone()).toBe(true);
    expect(args).toEqual(['-c', INSTALL_SH]);
  });

  it.each([
    [
      'HTTP 404',
      () => nock(RAW).get(pinned('install.sh')).reply(404, '404: Not Found'),
      /could not download the installer \(HTTP 404\)/,
    ],
    [
      'a network error',
      () =>
        nock(RAW)
          .get(pinned('install.sh'))
          .replyWithError('getaddrinfo ENOTFOUND raw.githubusercontent.com'),
      /could not download the installer \(getaddrinfo ENOTFOUND raw\.githubusercontent\.com\)/,
    ],
    [
      'a page that is not the installer',
      () => nock(RAW).get(pinned('install.sh')).reply(200, '<html>Sign in to the Wi-Fi</html>'),
      /does not look like install\.sh/,
    ],
  ])('macOS: a failed installer download (%s) reaches the dialog and never opens the window', async (_case, serve, why) => {
    serve();
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/^could not start the update: /);
    expect(res.json().error.message).toMatch(why);
    expect(res.json().error.retryable).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(isUpdating()).toBe(false);
  });

  it('never hands NODE_ENV to the installer', async () => {
    // The LaunchAgent runs the server with NODE_ENV=production. Yarn 1 reads
    // that as --production, skips devDependencies and still exits 0, so the
    // installer's `yarn build` loses vite and typescript and dies. Inheriting
    // the server's env wholesale makes every update from the button fail.
    const real = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      serveInstaller();
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
      expect(opts.env.BOROS_REF).toBe(MAIN_SHA);
      // No duplicate tab: the page the update was clicked on reloads itself.
      expect(opts.env.BOROS_NO_BROWSER).toBe('1');
    } finally {
      if (real === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = real;
    }
  });

  it('hands the installer no secrets from config/.env', async () => {
    // dotenv puts the live keys in process.env, and the installer's
    // `yarn install` runs every dependency's install scripts.
    const planted = {
      GATE_API_SECRET: 'gate-secret',
      BOROS_AGENT_PRIVATE_KEY: '0xagent',
      NODE_ENV: 'production',
      PATH: '/usr/bin:/bin',
    };
    const real = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      serveInstaller();
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
      expect('GATE_API_SECRET' in opts.env).toBe(false);
      expect('BOROS_AGENT_PRIVATE_KEY' in opts.env).toBe(false);
      expect('NODE_ENV' in opts.env).toBe(false);
      expect(opts.env.PATH).toBe('/usr/bin:/bin');
    } finally {
      for (const [k, v] of Object.entries(real)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('refuses when the update check is off, and says to update by hand', async () => {
    app = makeTestApp({ install: INSTALLED, updateCheck: { current: '1.0.0', disabled: true } });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/UPDATE_CHECK=0/);
    expect(res.json().error.retryable).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reads the commit again when the last check could not get it, and installs that one', async () => {
    let commitReads = 0;
    const ok = stub({ version: '1.1.0', highlights: [] });
    const versionFetch: FetchLike = async (url, init) =>
      url === COMMIT_URL && commitReads++ === 0
        ? { ok: false, status: 502, json: async () => ({}) }
        : ok(url, init);
    app = makeTestApp({ install: INSTALLED, updateCheck: { current: '1.0.0' }, versionFetch });
    expect((await getVersion()).json().data.latestCommit).toBeNull();
    serveInstaller();

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json().data.ref).toBe(MAIN_SHA);
    const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_REF).toBe(MAIN_SHA);
  });

  it('installs the cached commit without reading main again', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { calls }),
    });
    await getVersion();
    serveInstaller();

    const res = await post();

    expect(res.json().data.ref).toBe(MAIN_SHA);
    expect(calls.filter((u) => u === COMMIT_URL)).toHaveLength(1);
  });

  it('refuses when the commit is still unknown, and drops the cached null so the next check retries', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { sha: null, calls }),
    });
    await getVersion();

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ category: 'validation', retryable: true });
    expect(res.json().error.message).toContain('"Run it in my terminal"');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(isUpdating()).toBe(false);
    expect(calls.filter((u) => u === COMMIT_URL)).toHaveLength(2);

    await getVersion();
    expect(calls.filter((u) => u === COMMIT_URL)).toHaveLength(3);
  });

  it('on Windows the installer runs as its own scheduled task, outside the service job', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = fakeInstaller(home);
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    try {
      const res = await post();

      expect(res.json().data.logPath).toBe(path.join(home, 'logs', 'update.log'));
      expect(mocks.spawn).not.toHaveBeenCalled();
      const calls = mocks.execFileSync.mock.calls as unknown as [string, string[]][];
      expect(calls.map((c) => c[0])).toEqual(['schtasks', 'powershell', 'schtasks']);
      expect(calls[0][1]).toContain('/create');
      // schtasks-created tasks refuse to start on battery; the settings pass
      // between create and run is what makes the button work on a laptop.
      expect(calls[1][1].join(' ')).toContain('-AllowStartIfOnBatteries');
      expect(calls[1][1].join(' ')).toContain('-DontStopIfGoingOnBatteries');
      expect(calls[2][1]).toEqual(['/run', '/tn', 'BorosUpdate']);

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
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    try {
      await post();

      const args = (mocks.execFileSync.mock.calls as unknown as [string, string[]][])[0][1];
      const tr = args[args.indexOf('/tr') + 1];

      expect(tr).toBe(
        `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(home, 'update.ps1')}"`,
      );
      expect(tr).not.toMatch(/iex|Invoke-Expression|https?:|-Command/i);
      // The pin travels in the staged runner, never on the command line.
      expect(args.join(' ')).not.toContain(MAIN_SHA);
      const runner = readFileSync(path.join(home, 'update.ps1'), 'utf8');
      expect(runner).toContain(`$env:BOROS_REF = '${MAIN_SHA}'`);
      // The page reloads itself onto the new copy; the installer must not
      // open a second tab on top of it.
      expect(runner).toContain("$env:BOROS_NO_BROWSER = '1'");
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });

  it('on Windows the staged installer is the install.ps1 of the pinned commit', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    const script = '# Arbitrage with CrossEx - Windows installer (pinned fixture)\r\n';
    const installer = serveInstaller('install.ps1', script);
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    try {
      const res = await post();

      expect(res.statusCode).toBe(200);
      expect(installer.isDone()).toBe(true);
      expect(readFileSync(path.join(home, 'update-installer.ps1'), 'utf8')).toBe(script);
      expect(readFileSync(path.join(home, 'update.ps1'), 'utf8')).toContain(
        `$env:BOROS_REF = '${MAIN_SHA}'`,
      );
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
    }
  });

  it('reports a failed download in the dialog instead of scheduling a task that does nothing', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    process.env.BOROS_INSTALLER = path.join(home, 'does-not-exist.ps1');
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }),
    });
    try {
      const res = await post();

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/could not start the update: ENOENT/);
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
    // land in the real %LOCALAPPDATA% install. The darwin branch reads only
    // BOROS_INSTALLER, which keeps it off the network.
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
    await startUpdate(MAIN_SHA);

    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUpdating()).toBe(false);
  });

  it('closes when the installer fails to start, so orders are not refused forever', async () => {
    await startUpdate(MAIN_SHA);
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
    await startUpdate(MAIN_SHA);
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
    await startUpdate(MAIN_SHA);

    const handle = mocks.spawn.mock.results[0].value as { on: { mock: { calls: unknown[][] } } };
    const onExit = handle.on.mock.calls.find((c) => c[0] === 'exit')![1] as (
      c: number | null,
      s: string | null,
    ) => void;
    onExit(0, null);

    expect(isUpdating()).toBe(true);
  });

  it.each([undefined, null, 'main', "main'; rm -rf ~; echo '"])(
    'refuses %j as the commit, so nothing unpinned or unsafe reaches a shell',
    async (ref) => {
      await expect(startUpdate(ref)).rejects.toThrow('no release commit to install');

      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(isUpdating()).toBe(false);
    },
  );

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
      throw new Error('schtasks is not on this machine');
    });
    try {
      await expect(startUpdate(MAIN_SHA)).rejects.toThrow(/schtasks is not on this machine/);
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
      await expect(startUpdate(MAIN_SHA)).rejects.toThrow();
      expect(isUpdating()).toBe(false);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
      delete process.env.BOROS_INSTALLER;
    }
  });
});
