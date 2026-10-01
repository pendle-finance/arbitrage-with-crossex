/**
 * GET /api/version — the GitHub update check. The route must be silent on
 * every failure (a check that can fail loudly is worse than no check), lazy
 * (no remote read until asked), cached, and provably network-free whenever
 * the local version is unknown or the check is disabled.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { JobFile, newJob, newTransferJob, TransferFile } from '../../src/server/rebalanceJob';
import { endUpdateWindow, isUpdating, startUpdate } from '../../src/server/updater';
import { compareVersions } from '../../src/server/version';
import { HOST, makeTestApp, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { assetUrl, LATEST_URL, RELEASE_COMMIT, RELEASE_FILES, RELEASES_URL, releaseFetch } from './helpers/release';

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

vi.mock('../../src/server/releaseKey', async () => ({
  RELEASE_PUBLIC_KEYS: [(await import('./helpers/release')).RELEASE_TEST_PEM],
}));

describe('GET /api/version', () => {
  let app: FastifyInstance;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    warn.mockRestore();
    await app?.close();
  });

  const get = () => app.inject({ method: 'GET', url: '/api/version', headers: HOST });

  it('announces a newer signed release with its highlights', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ version: '1.1.0', highlights: ['a', 'b'], calls }),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      current: '1.0.0',
      install: null,
      latest: '1.1.0',
      latestCommit: RELEASE_COMMIT,
      updateAvailable: true,
      highlights: ['a', 'b'],
    });
    expect(calls).toEqual([LATEST_URL, assetUrl('release.json'), assetUrl('release.json.sig')]);
  });

  it('equal versions: no update, no highlights, nothing downloaded', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.1.0' },
      versionFetch: releaseFetch({ version: '1.1.0', highlights: ['a'], calls }),
    });
    const { data } = (await get()).json();
    expect(data.updateAvailable).toBe(false);
    expect(data.highlights).toEqual([]);
    expect(calls).toEqual([LATEST_URL]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a locally-newer dev checkout never sees the banner', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.2.0' },
      versionFetch: releaseFetch({ version: '1.1.0' }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
  });

  it('network failure is silent: 200, no update — the route never throws', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ reject: true }),
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

  it('no Release yet (404) is no update and no error', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ status: 404 }),
    });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.updateAvailable).toBe(false);
    expect(res.json().data.latest).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('non-200 and malformed manifests are equally silent', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ status: 500 }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
    await app.close();

    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ manifest: { version: 42 } }),
    });
    expect((await get()).json().data.latest).toBeNull();
    await app.close();

    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ manifest: { version: '1.0.x' } }),
    });
    expect((await get()).json().data.updateAvailable).toBe(false);
  });

  it('a bad signature is no update, plus one log line with the reason', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ badSignature: true }),
    });
    const { data } = (await get()).json();
    expect(data.updateAvailable).toBe(false);
    expect(data.latest).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/release signature does not match — update refused/);
  });

  it('BOROS_RELEASE_TAG reads that tag, and every check still runs', async () => {
    process.env.BOROS_RELEASE_TAG = 'v1.1.0-rc.1';
    try {
      const calls: string[] = [];
      app = makeTestApp({
        updateCheck: { current: '1.0.0' },
        versionFetch: releaseFetch({ tag: 'v1.1.0-rc.1', calls }),
      });
      expect((await get()).json().data.updateAvailable).toBe(true);
      expect(calls[0]).toBe(`${RELEASES_URL}/tags/v1.1.0-rc.1`);
      await app.close();

      app = makeTestApp({
        updateCheck: { current: '1.0.0' },
        versionFetch: releaseFetch({ tag: 'v1.1.0-rc.1', badSignature: true }),
      });
      expect((await get()).json().data.updateAvailable).toBe(false);
    } finally {
      delete process.env.BOROS_RELEASE_TAG;
    }
  });

  it('caches the remote read — two requests, one fetch', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ version: '1.1.0', calls }),
    });
    await get();
    await get();
    expect(calls.filter((u) => u === LATEST_URL)).toHaveLength(1);
  });

  it('UPDATE_CHECK=0 (disabled) never touches the network', async () => {
    const calls: string[] = [];
    app = makeTestApp({
      updateCheck: { current: '1.0.0', disabled: true },
      versionFetch: releaseFetch({ version: '9.9.9', calls }),
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
    app = makeTestApp({ versionFetch: releaseFetch({ version: '9.9.9', calls }) });
    const { data } = (await get()).json();
    expect(calls).toHaveLength(0);
    expect(data.current).toBeNull();
    expect(data.updateAvailable).toBe(false);
  });

  it('refuses a signed commit that is not 40 hex characters', async () => {
    app = makeTestApp({
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ manifest: { commit: 'main; rm -rf /' } }),
    });
    const { data } = (await get()).json();
    expect(data.latestCommit).toBeNull();
    expect(data.updateAvailable).toBe(false);
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
    process.env.BOROS_ROOT = home;
  });
  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    delete process.env.BOROS_ROOT;
    await app?.close();
  });

  const post = () => app.inject({ method: 'POST', url: '/api/version/update', headers: HOST });
  const SIGNED = { updateCheck: { current: '1.0.0' }, versionFetch: releaseFetch() };

  it('runs the saved, hash-checked installer detached, returns its log path, and does not exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    app = makeTestApp({ install: INSTALLED, ...SIGNED });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      started: true,
      logPath: path.join(home, 'Library', 'Logs', 'boros-crossex', 'update.log'),
      ref: RELEASE_COMMIT,
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; env: Record<string, string> },
    ];
    expect(cmd).toBe('/bin/bash');
    expect(args).toEqual([path.join(home, 'update', 'install.sh')]);
    expect(readFileSync(args[0])).toEqual(RELEASE_FILES['install.sh']);
    expect(opts.env.BOROS_TARBALL).toBe(path.join(home, 'update', 'app.tar.gz'));
    expect(readFileSync(opts.env.BOROS_TARBALL)).toEqual(RELEASE_FILES['app.tar.gz']);
    expect(opts.detached).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('refuses a file that does not match the signed release, and runs nothing', async () => {
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ served: { 'app.tar.gz': Buffer.from('tampered') } }),
    });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(
      'could not start the update: app.tar.gz does not match the signed release — update refused',
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(existsSync(path.join(home, 'update', 'install.sh'))).toBe(false);
  });

  it('re-checks the signature on Update, and runs nothing when it does not match', async () => {
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ badSignature: true }),
    });

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/release signature does not match — update refused/);
    expect(mocks.spawn).not.toHaveBeenCalled();
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

  it('never hands NODE_ENV to the installer', async () => {
    // The LaunchAgent runs the server with NODE_ENV=production. Yarn 1 reads
    // that as --production, skips devDependencies and still exits 0, so the
    // installer's `yarn build` loses vite and typescript and dies. Inheriting
    // the server's env wholesale makes every update from the button fail.
    const real = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      app = makeTestApp({ install: INSTALLED, ...SIGNED });

      await post();

      const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect('NODE_ENV' in opts.env).toBe(false);
      // The rest of the environment still goes through — PATH above all.
      expect(opts.env.BOROS_TARBALL).toBe(path.join(home, 'update', 'app.tar.gz'));
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
      app = makeTestApp({ install: INSTALLED, ...SIGNED });

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

  it('on Windows the installer runs as its own scheduled task, outside the service job', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    app = makeTestApp({ install: INSTALLED, ...SIGNED });
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
      expect(readFileSync(path.join(home, 'update', 'install.ps1'))).toEqual(RELEASE_FILES['install.ps1']);
      expect(readFileSync(path.join(home, 'update', 'app.zip'))).toEqual(RELEASE_FILES['app.zip']);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  /** The bug that made the button dead on Windows: a /tr carrying
   * `irm <url> | iex` is detected as Trojan:Win32/Commando.A!ml and the process
   * creation denied (`spawnSync schtasks EPERM`). Only a local path may reach
   * that command line. */
  it('puts no download-and-execute on the scheduled task command line', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    app = makeTestApp({ install: INSTALLED, ...SIGNED });
    try {
      await post();

      const args = (mocks.execFileSync.mock.calls as unknown as [string, string[]][])[0][1];
      const tr = args[args.indexOf('/tr') + 1];

      expect(tr).toBe(
        `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(home, 'update.ps1')}"`,
      );
      expect(tr).not.toMatch(/iex|Invoke-Expression|https?:|-Command/i);
      // The archive travels in the staged runner, never on the command line.
      expect(args.join(' ')).not.toContain('app.zip');
      const runner = readFileSync(path.join(home, 'update.ps1'), 'utf8');
      expect(runner).toContain(`$env:BOROS_ZIP = '${path.join(home, 'update', 'app.zip')}'`);
      expect(runner).toContain(`'"${path.join(home, 'update', 'install.ps1')}"'`);
      expect(runner).not.toContain('BOROS_REF');
      // The page reloads itself onto the new copy; the installer must not
      // open a second tab on top of it.
      expect(runner).toContain("$env:BOROS_NO_BROWSER = '1'");
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  it('reports a failed download in the dialog instead of scheduling a task that does nothing', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: releaseFetch({ assetStatus: { 'app.zip': 500 } }),
    });
    try {
      const res = await post();

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('could not start the update: could not download app.zip (HTTP 500)');
      expect(res.json().error.retryable).toBe(true);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
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
    // mechanism, so they run on whatever host they are on. Both stage the
    // release under BOROS_ROOT, which would otherwise land in the real install.
    process.env.BOROS_ROOT = home;
  });
  afterEach(() => {
    vi.useRealTimers();
    endUpdateWindow();
    delete process.env.BOROS_ROOT;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  const start = (fetchImpl = releaseFetch()) => startUpdate(fetchImpl, '1.0.0');

  it('opens on a launch that starts, then closes on its own after ten minutes', async () => {
    vi.useFakeTimers();
    await start();

    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUpdating()).toBe(false);
  });

  it('closes when the installer fails to start, so orders are not refused forever', async () => {
    await start();
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
    await start();
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
    await start();

    const handle = mocks.spawn.mock.results[0].value as { on: { mock: { calls: unknown[][] } } };
    const onExit = handle.on.mock.calls.find((c) => c[0] === 'exit')![1] as (
      c: number | null,
      s: string | null,
    ) => void;
    onExit(0, null);

    expect(isUpdating()).toBe(true);
  });

  it('never opens when the scheduled task cannot be created', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('schtasks is not on this machine');
    });
    try {
      await expect(start()).rejects.toThrow(/schtasks is not on this machine/);
      expect(isUpdating()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  it('never opens when the installer cannot be staged', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await expect(start(releaseFetch({ served: { 'install.ps1': Buffer.from('changed') } }))).rejects.toThrow(
        'install.ps1 does not match the signed release — update refused',
      );
      expect(isUpdating()).toBe(false);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });
});
