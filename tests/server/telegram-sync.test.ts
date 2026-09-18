import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob, newTransferJob, TransferFile, type TransferJob } from '../../src/server/rebalanceJob';
import { runJob, runTransfer, tagFor } from '../../src/server/rebalanceRunner';
import { BotAuthError, botBaseUrl, BotUnavailableError, createBotClient } from '../../src/server/telegram/botClient';
import { deleteTelegramKey, newTelegramKey, readTelegramKey, writeTelegramKey } from '../../src/server/telegram/keyFile';
import { createTelegramLink } from '../../src/server/telegram/link';
import { TelegramStatus } from '../../src/server/telegram/status';
import {
  createTelegramSync,
  readTriggerCoins,
  type TelegramSync,
  type TelegramSyncOptions,
} from '../../src/server/telegram/sync';
import { clientsWith } from '../helpers/fake-clients';
import { A_CONTRACT, mkWorld } from '../unit/engine-sim';
import { BOT_URL, ETH, makeBotStub, type BotAnswer, VIEW } from './helpers/telegram';
import { HOST, makeTestApp, mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const FIVE_MIN = 300_000;

function botStub(answer: BotAnswer = async () => ({ status: 200, body: VIEW })) {
  const stub = makeBotStub(answer);
  return { calls: stub.calls, puts: () => stub.to('PUT', '/terminal/triggers'), bot: stub.bot };
}

let dataDir: string;
let sync: TelegramSync | null = null;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'telegram-'));
});

afterEach(() => {
  sync?.stop();
  sync = null;
  vi.useRealTimers();
  nock.cleanAll();
});

const link = (): void => writeTelegramKey(dataDir, newTelegramKey(Date.now()));

function makeSync(bot: ReturnType<typeof botStub>['bot'], over: Partial<TelegramSyncOptions> = {}) {
  const status = new TelegramStatus();
  const readCoins = vi.fn(async () => [ETH]);
  const created = createTelegramSync({
    dataDir,
    bot,
    status,
    readCoins,
    port: 7788,
    version: '1.6.3',
    now: () => Date.now(),
    ...over,
  });
  sync = created;
  return { sync: created, status, readCoins };
}

const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the Telegram key file', () => {
  it('writes the key owner-only and hashes the key string', () => {
    const key = newTelegramKey(1_000);
    writeTelegramKey(dataDir, key);

    expect(fs.statSync(path.join(dataDir, 'telegram-key')).mode & 0o777).toBe(0o600);
    expect(Buffer.from(key.key, 'base64url')).toHaveLength(32);
    expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readTelegramKey(dataDir)).toEqual(key);
    deleteTelegramKey(dataDir);
    expect(readTelegramKey(dataDir)).toBeNull();
  });

  it('a key file that does not parse reads as none', () => {
    fs.writeFileSync(path.join(dataDir, 'telegram-key'), '{"key":');
    expect(readTelegramKey(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'telegram-key'), JSON.stringify({ key: 'a', keyHash: 'b', createdAt: 1 }));
    expect(readTelegramKey(dataDir)).toBeNull();
  });
});

describe('the bot client', () => {
  it('a refused key throws its reason, and no answer is unavailable', async () => {
    const refused = botStub(async () => ({ status: 401, body: { reason: 'replaced' } }));
    await expect(refused.bot.getTerminal('k')).rejects.toEqual(new BotAuthError('replaced'));

    const down = createBotClient({ baseUrl: BOT_URL, fetchImpl: async () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(down.getTerminal('k')).rejects.toBeInstanceOf(BotUnavailableError);
    expect(botBaseUrl({ CROSSEX_BOT_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000');
  });
});

describe('the trigger sync', () => {
  it('syncs on boot', async () => {
    vi.useFakeTimers();
    link();
    const stub = botStub();
    const { sync, status } = makeSync(stub.bot);

    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FIVE_MIN - 1_000);

    expect(stub.puts()).toHaveLength(1);
    expect(stub.puts()[0].url).toBe(`${BOT_URL}/noti/boros/crossex/terminal/triggers`);
    expect(stub.puts()[0].headers['x-terminal-key']).toBe(readTelegramKey(dataDir)?.key);
    expect(status.auth).toBe('ok');
    expect(status.settings).toEqual({ liquidation: true, interest: true });
  });

  it('boot does not wait on the bot', async () => {
    link();
    const stub = botStub(() => new Promise(() => undefined));
    const { sync, status } = makeSync(stub.bot);
    const app = makeTestApp();

    sync.start();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: HOST });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(stub.puts()).toHaveLength(1));
    expect(status.lastSyncAt).toBeNull();
    await app.close();
  });

  it('syncs every 5 min', async () => {
    vi.useFakeTimers();
    link();
    const stub = botStub();
    const { sync, readCoins } = makeSync(stub.bot);

    sync.start();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);

    expect(stub.puts()).toHaveLength(4);
    expect(readCoins).toHaveBeenCalledTimes(4);
    expect(new Set(stub.puts().map((c) => JSON.stringify((c.body as { coins: unknown }).coins))).size).toBe(1);
  });

  it('deal finish syncs', async () => {
    link();
    const stub = botStub();
    const { sync, status } = makeSync(stub.bot);
    const w = mkWorld();
    const finished = vi.fn(() => sync.requestSync('deal'));
    w.deps.onFinish = finished;

    await w.step();
    const maker = w.venue.liveOrder(A_CONTRACT);
    if (!maker) throw new Error('no maker order');
    w.venue.fill(maker.clientText, '0.152');
    await w.step(6);

    expect(w.store.getPair(w.pairId)?.mode).toBe('DONE');
    expect(finished).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith(w.pairId);
    await vi.waitFor(() => expect(status.lastSyncAt).not.toBeNull());
    expect(stub.puts()).toHaveLength(1);
  });

  it('rebalance syncs', async () => {
    link();
    const stub = botStub();
    const { sync, status } = makeSync(stub.bot);
    let t = 1_000_000;
    const now = () => t;
    const jobs = new JobFile(dataDir, now);
    const job = newJob(
      {
        route: 'loop',
        steps: [
          { round: 1, kind: 'round', buy: 12, move: 12, arrives: 11.95, borrowLeft: 0, seconds: 130, from: 'CROSSEX', to: 'HYPERLIQUID' },
        ],
        amount: 12,
        costUsd: 0,
        target: [],
        userId: null,
      },
      t,
    );
    job.steps.slice(0, 2).forEach((step, i) =>
      Object.assign(step, { text: tagFor(job.id, i), venueId: `x${i}`, qty: 11.99, status: 'done', startedAt: t, doneAt: t }),
    );
    Object.assign(job.steps[2], { text: tagFor(job.id, 2), status: 'running', startedAt: t, venueId: '123' });
    Object.assign(job, { tagCount: 2, stepIndex: 2, fundsAt: 'SPOT' });
    jobs.write(job);
    const clients = clientsWith({
      listCrossexTransfers: async () => ({
        body: [{ id: 123, status: 'SUCCESS', amount: '11.99', actualReceive: '11.94' }],
      }),
    });
    const onDone = vi.fn(() => sync.requestSync('rebalance'));

    await runJob({
      clients: () => clients,
      jobs,
      cache: new TtlCache(),
      now,
      sleep: async (ms) => {
        t += ms;
      },
      onHalt: () => undefined,
      onDone,
    });

    expect(jobs.read()?.status).toBe('done');
    expect(onDone).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(status.lastSyncAt).not.toBeNull());
    expect(stub.puts()).toHaveLength(1);
  });

  it('transfer syncs', async () => {
    link();
    const stub = botStub();
    const { sync, status } = makeSync(stub.bot);
    let t = 1_000_000;
    const now = () => t;
    const transfers = new TransferFile(dataDir, now);
    const transfer: TransferJob = {
      ...newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, t),
      sentAt: t - 5_000,
      acceptedAt: t - 4_000,
      venueId: '123',
    };
    transfers.write(transfer);
    const clients = clientsWith({
      listCrossexTransfers: async () => ({
        body: [{ id: 123, status: 'SUCCESS', amount: '11.88', actualReceive: '10.88' }],
      }),
    });
    const onDone = vi.fn(() => sync.requestSync('transfer'));

    await runTransfer({
      clients: () => clients,
      transfers,
      cache: new TtlCache(),
      now,
      sleep: async (ms) => {
        t += ms;
      },
      onDone,
    });

    expect(transfers.read()?.status).toBe('done');
    expect(onDone).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(status.lastSyncAt).not.toBeNull());
    expect(stub.puts()).toHaveLength(1);
  });

  it('one sync at a time', async () => {
    link();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = botStub(async () => {
      const n = events.filter((e) => e.startsWith('start')).length + 1;
      events.push(`start ${n}`);
      if (n === 1) await held;
      events.push(`end ${n}`);
      return { status: 200, body: VIEW };
    });
    const { sync } = makeSync(stub.bot);

    sync.requestSync('deal');
    await vi.waitFor(() => expect(stub.puts()).toHaveLength(1));
    sync.requestSync('transfer');
    sync.requestSync('rebalance');
    await macrotask();
    expect(stub.puts()).toHaveLength(1);
    release();

    await vi.waitFor(() => expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2']));
    await macrotask();
    expect(stub.puts()).toHaveLength(2);
  });

  it('no sync from stale data', async () => {
    link();
    const stub = botStub();
    const cache = new TtlCache();
    await cache.get('account', 60_000, async () => ({ marginBalance: '1000' }));
    mockGateGet('/accounts', { status: 429, body: { label: 'TOO_MANY_REQUESTS', message: 'Too many requests' } });
    mockGateGet('/positions', { fixture: 'positions.pair-neutral.json' });
    const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
    const { sync, status } = makeSync(stub.bot, { readCoins: () => readTriggerCoins({ cache, getClients }), now: () => 5_000 });

    sync.requestSync('deal');

    await vi.waitFor(() => expect(status.lastSyncError).not.toBeNull());
    expect(status.lastSyncError?.at).toBe(5_000);
    expect(status.lastSyncAt).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it('sends the port', async () => {
    link();
    const stub = botStub();
    mockGateGet('/accounts', { fixture: 'account.json' });
    mockGateGet('/positions', { fixture: 'positions.pair-neutral.json' });
    const cache = new TtlCache();
    const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
    const at = Date.UTC(2026, 8, 18, 10, 0, 0);
    const { sync, status } = makeSync(stub.bot, { readCoins: () => readTriggerCoins({ cache, getClients }), now: () => at });

    sync.requestSync('deal');

    await vi.waitFor(() => expect(status.lastSyncAt).toBe(at));
    const body = stub.puts()[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['coins', 'port', 'syncedAt', 'version']);
    expect(body).toMatchObject({ syncedAt: '2026-09-18T10:00:00.000Z', port: 7788, version: '1.6.3' });
    expect(Array.isArray(body.coins)).toBe(true);
  });

  it('records a failed sync', async () => {
    link();
    let failing = false;
    const stub = botStub(async () =>
      failing ? { status: 500, body: { message: 'Internal server error' } } : { status: 200, body: VIEW },
    );
    let t = 1_000;
    const { sync, status } = makeSync(stub.bot, { now: () => t });
    const telegramLink = createTelegramLink({
      dataDir,
      bot: stub.bot,
      pageUrl: `${BOT_URL}/alerts`,
      version: '1.6.3',
      now: () => t,
      onConfirmed: () => undefined,
    });
    const app = makeTestApp({ dataDir, telegram: { link: telegramLink, sync, status, bot: stub.bot } });

    sync.requestSync('deal');
    await vi.waitFor(() => expect(status.lastSyncAt).toBe(1_000));
    t = 2_000;
    failing = true;
    sync.requestSync('deal');
    await vi.waitFor(() => expect(status.lastSyncError).not.toBeNull());
    const res = await app.inject({ method: 'GET', url: '/api/telegram', headers: HOST });
    await app.close();

    expect(res.json().data).toMatchObject({
      lastSyncAt: 1_000,
      lastSyncError: { at: 2_000, message: 'The Telegram bot answered 500.' },
    });
  });

  it('a bot answer with no settings records a failed sync', async () => {
    link();
    const stub = botStub(async () => ({ status: 200, body: { ...VIEW, settings: undefined } }));
    const { sync, status } = makeSync(stub.bot);

    sync.requestSync('deal');

    await vi.waitFor(() => expect(status.lastSyncError?.message).toBe('The Telegram bot answered with no alert settings.'));
    expect(status.lastSyncAt).toBeNull();
    expect(status.settings).toBeNull();
  });

  it('a refused key records the reason', async () => {
    link();
    const stub = botStub(async () => ({ status: 401, body: { reason: 'removed' } }));
    const { sync, status } = makeSync(stub.bot);

    sync.requestSync('deal');

    await vi.waitFor(() => expect(status.auth).toBe('removed'));
    expect(status.lastSyncError?.message).toContain('removed');
  });

  it('a key the bot no longer knows records unknown', async () => {
    link();
    const stub = botStub(async () => ({ status: 401, body: { reason: 'unknown' } }));
    const { sync, status } = makeSync(stub.bot);

    sync.requestSync('deal');

    await vi.waitFor(() => expect(status.auth).toBe('unknown'));
    expect(status.lastSyncError?.message).toContain('unknown');
  });

  it('no key, no sync', async () => {
    vi.useFakeTimers();
    const stub = botStub();
    const { sync, readCoins } = makeSync(stub.bot);

    sync.start();
    await vi.advanceTimersByTimeAsync(3 * FIVE_MIN);

    expect(stub.calls).toHaveLength(0);
    expect(readCoins).not.toHaveBeenCalled();
  });
});
