/**
 * GET /api/version — the GitHub update check. The route must be silent on
 * every failure (a check that can fail loudly is worse than no check), lazy
 * (no remote read until asked), cached, and provably network-free whenever
 * the local version is unknown or the check is disabled.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
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

  beforeEach(() => {
    mocks.spawn.mockClear();
    mocks.execFileSync.mockClear();
    mocks.pending.mockClear();
    home = mkdtempSync(path.join(tmpdir(), 'upd-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
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
      ref: null,
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

  it('installs the exact commit the modal advertised', async () => {
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
    expect(args[1]).toContain('/main/install.sh');
  });

  it('falls back to the branch when the commit is unknown', async () => {
    app = makeTestApp({
      install: INSTALLED,
      updateCheck: { current: '1.0.0' },
      versionFetch: stub({ version: '1.1.0', highlights: [] }, { sha: null }),
    });

    const res = await post();

    expect(res.json().data.ref).toBeNull();
    const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_REF).toBeUndefined();
  });

  it('on Windows the installer runs as its own scheduled task, outside the service job', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    app = makeTestApp({ install: INSTALLED });
    try {
      const res = await post();

      expect(res.json().data.logPath).toBe(path.join(home, 'logs', 'update.log'));
      expect(mocks.spawn).not.toHaveBeenCalled();
      const calls = mocks.execFileSync.mock.calls as unknown as [string, string[]][];
      expect(calls.map((c) => c[0])).toEqual(['schtasks', 'schtasks']);
      expect(calls[0][1]).toContain('/create');
      expect(calls[0][1].join(' ')).toContain('/main/install.ps1');
      expect(calls[1][1]).toEqual(['/run', '/tn', 'BorosUpdate']);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
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
  });
  afterEach(() => {
    vi.useRealTimers();
    endUpdateWindow();
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  it('opens on a launch that starts, then closes on its own after ten minutes', () => {
    vi.useFakeTimers();
    startUpdate();

    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(isUpdating()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUpdating()).toBe(false);
  });

  it('closes when the installer fails to start, so orders are not refused forever', () => {
    startUpdate();
    expect(isUpdating()).toBe(true);

    const handle = mocks.spawn.mock.results[0].value as { on: { mock: { calls: unknown[][] } } };
    const onError = handle.on.mock.calls.find((c) => c[0] === 'error')![1] as (e: Error) => void;
    onError(new Error('bash is missing'));

    expect(isUpdating()).toBe(false);
  });

  it('refuses a ref that is not a commit sha, rather than passing it to a shell', () => {
    startUpdate("main'; rm -rf ~; echo '");

    const [, , opts] = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(opts.env.BOROS_REF).toBeUndefined();
  });

  it('pins the scheduled task to the commit on Windows', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    try {
      startUpdate('3f7c1b9e2d4a6058cbe1740f9a2d5b83c6e0f1a4');

      const calls = mocks.execFileSync.mock.calls as unknown as [string, string[]][];
      expect(calls[0][1].join(' ')).toContain(
        "$env:BOROS_REF='3f7c1b9e2d4a6058cbe1740f9a2d5b83c6e0f1a4';",
      );
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
    }
  });

  it('never opens when the scheduled task cannot be created', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.BOROS_ROOT = home;
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('schtasks is not on this machine');
    });
    try {
      expect(() => startUpdate()).toThrow(/schtasks is not on this machine/);
      expect(isUpdating()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      delete process.env.BOROS_ROOT;
    }
  });
});
