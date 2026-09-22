import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerCoin } from '../../src/core/alerts/triggers';
import type { BotAuthReason } from '../../src/server/telegram/botClient';
import { newTelegramKey, readTelegramKey, type TelegramKey, writeTelegramKey } from '../../src/server/telegram/keyFile';
import { createTelegramLink } from '../../src/server/telegram/link';
import { TelegramStatus } from '../../src/server/telegram/status';
import { createTelegramSync } from '../../src/server/telegram/sync';
import { BOT_URL, CROSSEX, ETH, makeBotStub, VIEW, type BotAnswer } from './helpers/telegram';
import { HOST, makeTestApp } from './helpers/gate-nock';

const CODE = 'q0Yx1dQ0bB8m8rP3nV2m4w';
const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);
const TEN_MIN = 600_000;
const DAY_SEC = 86_400;
const BOT_DOWN = 'Telegram alerts are not available yet. Try again later.';
const BOT_UNREACHABLE = 'Could not reach the bot. Try again, or remove this terminal on the Boros alerts page.';

interface BotBehaviour {
  down: 'refused' | number | null;
  reason: BotAuthReason | null;
  settings: { liquidation: boolean; interest: boolean; maturity: boolean; rollover: boolean };
  hold: Promise<void> | null;
  pendingKey: string | null;
}

let dataDir: string;
let now: number;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'telegram-routes-'));
  now = T0;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  delete process.env.CROSSEX_BOT_URL;
});

function makeBot() {
  const behaviour: BotBehaviour = { down: null, reason: null, settings: { liquidation: true, interest: true, maturity: true, rollover: true }, hold: null, pendingKey: null };
  const answer: BotAnswer = (call) => {
    if (typeof behaviour.down === 'number') return { status: behaviour.down, body: { message: 'Cannot answer' } };
    const route = `${call.method} ${call.url.slice(CROSSEX.length)}`;
    if (route === 'POST /link-requests') {
      return { status: 201, body: { code: CODE, expiresAt: new Date(now + TEN_MIN).toISOString() } };
    }
    if (behaviour.reason !== null) return { status: 401, body: { reason: behaviour.reason } };
    if (call.headers['x-terminal-key'] === behaviour.pendingKey) return { status: 401, body: { reason: 'pending' } };
    if (route === 'DELETE /terminal') return { status: 200, body: { removed: true } };
    if (route === 'PATCH /terminal/settings') Object.assign(behaviour.settings, call.body);
    return { status: 200, body: { ...VIEW, settings: { ...behaviour.settings } } };
  };
  const stub = makeBotStub(async (call) => {
    if (behaviour.down === 'refused') throw new Error('connect ECONNREFUSED');
    if (behaviour.hold !== null && call.method === 'GET') await behaviour.hold;
    return answer(call);
  });
  return { ...stub, behaviour };
}

type Bot = ReturnType<typeof makeBot>;

function holdChecks(bot: Bot): () => void {
  let release = (): void => undefined;
  bot.behaviour.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

const NONE = {
  connected: false,
  state: 'none',
  settings: null,
  lastSyncAt: null,
  lastSyncError: null,
  alertsPageUrl: `${BOT_URL}/alerts`,
};

function boot(bot: Bot = makeBot()) {
  const status = new TelegramStatus();
  const readCoins = vi.fn(async () => [ETH]);
  const clock = () => now;
  const sync = createTelegramSync({ dataDir, bot: bot.bot, status, readCoins, port: 7788, version: '1.6.3', now: clock });
  const link = createTelegramLink({
    dataDir,
    bot: bot.bot,
    pageUrl: `${BOT_URL}/alerts`,
    version: '1.6.3',
    now: clock,
    status,
    onConfirmed: () => {
      status.setAuth('ok');
      sync.requestSync('linked');
    },
    onRestored: () => sync.requestSync('restored'),
  });
  const app = makeTestApp({ dataDir, telegram: { link, sync, status, bot: bot.bot } });
  cleanups.push(async () => {
    link.stop();
    sync.stop();
    await app.close();
  });
  return { bot, status, sync, link, app, readCoins };
}

async function send(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const res = await app.inject({ method, url, headers: HOST, payload });
  return { code: res.statusCode, body: res.json() };
}

function linked(): TelegramKey {
  const key = newTelegramKey(T0);
  writeTelegramKey(dataDir, key);
  return key;
}

function keyOnDisk(): TelegramKey {
  const key = readTelegramKey(dataDir);
  if (key === null) throw new Error('no telegram-key file');
  return key;
}

const fakeInterval = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

describe('Telegram link', () => {
  it('sends only the key hash', async () => {
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';

    const res = await send(app, 'POST', '/api/telegram/link');

    expect(res.code).toBe(200);
    const key = keyOnDisk();
    expect(Buffer.from(key.key, 'base64url')).toHaveLength(32);
    expect(fs.statSync(path.join(dataDir, 'telegram-key')).mode & 0o777).toBe(0o600);
    const requests = bot.to('POST', '/link-requests');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      keyHash: createHash('sha256').update(key.key, 'utf8').digest('hex'),
      version: '1.6.3',
    });
    expect(JSON.stringify(bot.calls)).not.toContain(key.key);
  });

  it('starts a link', async () => {
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';

    const res = await send(app, 'POST', '/api/telegram/link');

    const url = `${BOT_URL}/alerts?crossex=${CODE}`;
    expect(res.body.data).toEqual({ url, expiresAt: T0 + TEN_MIN });
    expect((await send(app, 'GET', '/api/telegram/link')).body.data).toEqual({
      status: 'pending',
      url,
      expiresAt: T0 + TEN_MIN,
    });
  });

  it('one pending link', async () => {
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';

    const [a, b] = await Promise.all([send(app, 'POST', '/api/telegram/link'), send(app, 'POST', '/api/telegram/link')]);
    now += 60_000;
    const c = await send(app, 'POST', '/api/telegram/link');

    expect(b.body.data).toEqual(a.body.data);
    expect(c.body.data).toEqual(a.body.data);
    expect(bot.to('POST', '/link-requests')).toHaveLength(1);
  });

  it('polls the bot every 5 s', async () => {
    fakeInterval();
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    const polls = () => bot.to('GET', '/terminal');

    await vi.advanceTimersByTimeAsync(4_999);
    expect(polls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(polls()).toHaveLength(3);
    expect(polls()[0].headers['x-terminal-key']).toBe(keyOnDisk().key);
    expect((await send(app, 'GET', '/api/telegram/link')).body.data.status).toBe('pending');
  });

  it('confirm syncs at once', async () => {
    fakeInterval();
    const { app, bot, readCoins } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.reason = null;

    await vi.advanceTimersByTimeAsync(5_000);

    expect((await send(app, 'GET', '/api/telegram/link')).body.data.status).toBe('confirmed');
    await vi.waitFor(() => expect(bot.to('PUT', '/terminal/triggers')).toHaveLength(1));
    expect(readCoins).toHaveBeenCalledOnce();
    expect(bot.to('PUT', '/terminal/triggers')[0].headers['x-terminal-key']).toBe(keyOnDisk().key);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(bot.to('GET', '/terminal')).toHaveLength(1);
    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: true, state: 'connected' });
  });

  it('expired link', async () => {
    fakeInterval();
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.reason = 'unknown';

    await vi.advanceTimersByTimeAsync(5_000);

    expect((await send(app, 'GET', '/api/telegram/link')).body.data).toEqual({
      status: 'expired',
      url: `${BOT_URL}/alerts?crossex=${CODE}`,
      expiresAt: T0 + TEN_MIN,
    });
    expect(readTelegramKey(dataDir)).toBeNull();
    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: false, state: 'none' });
  });

  it('a link past its 10 min reads expired, and Set up asks again', async () => {
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    now += TEN_MIN;

    expect((await send(app, 'GET', '/api/telegram/link')).body.data.status).toBe('expired');
    expect(readTelegramKey(dataDir)).toBeNull();
    const again = await send(app, 'POST', '/api/telegram/link');

    expect(again.body.data.expiresAt).toBe(now + TEN_MIN);
    expect(bot.to('POST', '/link-requests')).toHaveLength(2);
  });

  it('a read that is the first to see a first link expired says none', async () => {
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    now += TEN_MIN;

    expect((await send(app, 'GET', '/api/telegram')).body.data).toEqual(NONE);
    expect(readTelegramKey(dataDir)).toBeNull();
  });

  it('restart drops the link', async () => {
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');

    const second = boot(first.bot);

    expect((await send(second.app, 'GET', '/api/telegram/link')).body.data).toEqual({
      status: 'none',
      url: null,
      expiresAt: null,
    });
  });

  it('bot down', async () => {
    const { app, bot } = boot();
    bot.behaviour.down = 'refused';

    const refused = await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.down = 404;
    const missing = await send(app, 'POST', '/api/telegram/link');

    for (const res of [refused, missing]) {
      expect(res.code).toBe(503);
      expect(res.body.error.message).toBe(BOT_DOWN);
    }
    expect(readTelegramKey(dataDir)).toBeNull();
    expect((await send(app, 'GET', '/api/telegram/link')).body.data.status).toBe('none');
    expect((await send(app, 'GET', '/api/telegram')).body.data.connected).toBe(false);
  });

  it('a failed link keeps the key that was there', async () => {
    const before = linked();
    const { app, bot } = boot();
    bot.behaviour.down = 'refused';

    expect((await send(app, 'POST', '/api/telegram/link')).code).toBe(503);

    expect(readTelegramKey(dataDir)).toEqual(before);
  });

  it('cancel stops the link and restores the key that was there', async () => {
    fakeInterval();
    const before = linked();
    const { app, bot, link } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');

    const res = await app.inject({ method: 'DELETE', url: '/api/telegram/link', headers: HOST });
    await link.settled();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('none');
    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(bot.to('GET', '/terminal')).toHaveLength(1);
    expect((await send(app, 'GET', '/api/telegram/link')).body.data.status).toBe('none');
  });

  it('cancel after the user confirmed in the bot keeps the new key and finishes the link', async () => {
    fakeInterval();
    linked();
    const { app, bot, link, status } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    const key = keyOnDisk();
    bot.behaviour.reason = null;

    await app.inject({ method: 'DELETE', url: '/api/telegram/link', headers: HOST });
    await link.settled();

    expect(readTelegramKey(dataDir)).toEqual(key);
    expect(fs.existsSync(path.join(dataDir, 'telegram-link'))).toBe(false);
    expect(status.auth).toBe('ok');
  });

  it('cancel while the bot cannot be reached restores the key that was there', async () => {
    fakeInterval();
    const before = linked();
    const { app, bot, link, status } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.down = 'refused';

    await app.inject({ method: 'DELETE', url: '/api/telegram/link', headers: HOST });
    await link.settled();

    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(status.auth).toBeNull();
  });

  it('a cancel answers after the bot check, and no read says connected on the unconfirmed key', async () => {
    fakeInterval();
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    const release = holdChecks(bot);
    let answered = false;
    const cancel = send(app, 'DELETE', '/api/telegram/link').then((res) => {
      answered = true;
      return res;
    });
    await vi.waitFor(() => expect(bot.to('GET', '/terminal')).toHaveLength(1));

    const during = await send(app, 'GET', '/api/telegram');
    expect(during.body.data).toEqual(NONE);
    expect(answered).toBe(false);
    release();
    const res = await cancel;

    expect(res.body.data.status).toBe('none');
    expect(readTelegramKey(dataDir)).toBeNull();
    expect((await send(app, 'GET', '/api/telegram')).body.data).toEqual(NONE);
    expect(bot.to('PUT', '/terminal/triggers')).toHaveLength(0);
  });

  it('a cancelled relink reads connected on the old key at once, and syncs the old key', async () => {
    fakeInterval();
    const before = linked();
    const { app, bot, sync, status, readCoins } = boot();
    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('ok'));
    await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.pendingKey = keyOnDisk().key;
    sync.requestSync('deal');
    await vi.waitFor(() => expect(status.auth).toBe('pending'));
    let release = (): void => undefined;
    readCoins.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([ETH]);
        }),
    );

    await send(app, 'DELETE', '/api/telegram/link');
    const after = await send(app, 'GET', '/api/telegram');
    release();
    await vi.waitFor(() => expect(bot.to('PUT', '/terminal/triggers')).toHaveLength(3));
    await sync.idle();

    expect(after.body.data).toEqual({
      connected: true,
      state: 'connected',
      settings: { liquidation: true, interest: true, maturity: true, rollover: true },
      lastSyncAt: T0,
      lastSyncError: null,
      alertsPageUrl: `${BOT_URL}/alerts`,
    });
    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(bot.to('PUT', '/terminal/triggers')[2].headers['x-terminal-key']).toBe(before.key);
  });

  it('a relink cancelled while the old key already read removed still restores removed', async () => {
    fakeInterval();
    const before = linked();
    const { app, bot, sync, status } = boot();
    bot.behaviour.reason = 'removed';
    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('removed'));
    await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.reason = null;
    bot.behaviour.pendingKey = keyOnDisk().key;
    sync.requestSync('deal');
    await vi.waitFor(() => expect(status.auth).toBe('pending'));
    bot.behaviour.reason = 'removed';

    await send(app, 'DELETE', '/api/telegram/link');
    const after = await send(app, 'GET', '/api/telegram');
    await sync.idle();
    await sync.idle();
    const later = await send(app, 'GET', '/api/telegram');

    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(after.body.data.state).toBe('removed');
    expect(later.body.data.state).toBe('removed');
  });

  it('a relink cancelled after the old key was removed on the bot page reads connected, then removed once the restore sync lands', async () => {
    fakeInterval();
    const before = linked();
    const { app, bot, sync, status, readCoins } = boot();
    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('ok'));
    await send(app, 'POST', '/api/telegram/link');
    bot.behaviour.reason = 'removed';
    let release = (): void => undefined;
    readCoins.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([ETH]);
        }),
    );

    await send(app, 'DELETE', '/api/telegram/link');
    const after = await send(app, 'GET', '/api/telegram');
    release();
    await vi.waitFor(() => expect(status.auth).toBe('removed'));
    await sync.idle();
    const later = await send(app, 'GET', '/api/telegram');

    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(after.body.data.state).toBe('connected');
    expect(later.body.data.state).toBe('removed');
  });

  it('a new key sync that ends after a cancelled relink records nothing', async () => {
    fakeInterval();
    const before = linked();
    const { app, bot, sync, status, readCoins } = boot();
    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('ok'));
    await send(app, 'POST', '/api/telegram/link');
    const fresh = keyOnDisk();
    bot.behaviour.pendingKey = fresh.key;
    const releases: Array<() => void> = [];
    const held = (): Promise<TriggerCoin[]> =>
      new Promise((resolve) => {
        releases.push(() => resolve([ETH]));
      });
    readCoins.mockImplementationOnce(held).mockImplementationOnce(held);
    sync.requestSync('deal');
    await vi.waitFor(() => expect(readCoins).toHaveBeenCalledTimes(2));

    await send(app, 'DELETE', '/api/telegram/link');
    releases[0]();
    await vi.waitFor(() => expect(readCoins).toHaveBeenCalledTimes(3));
    const after = await send(app, 'GET', '/api/telegram');
    releases[1]();
    await vi.waitFor(() => expect(bot.to('PUT', '/terminal/triggers')).toHaveLength(3));
    await sync.idle();

    const puts = bot.to('PUT', '/terminal/triggers');
    expect(puts[1].headers['x-terminal-key']).toBe(fresh.key);
    expect(puts[2].headers['x-terminal-key']).toBe(before.key);
    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(after.body.data).toEqual({
      connected: true,
      state: 'connected',
      settings: { liquidation: true, interest: true, maturity: true, rollover: true },
      lastSyncAt: T0,
      lastSyncError: null,
      alertsPageUrl: `${BOT_URL}/alerts`,
    });
  });

  it('a cancel of a link the bot confirmed answers after the check, and then reads connected', async () => {
    fakeInterval();
    const { app, bot } = boot();
    bot.behaviour.reason = 'pending';
    await send(app, 'POST', '/api/telegram/link');
    const key = keyOnDisk();
    bot.behaviour.reason = null;
    const release = holdChecks(bot);
    let answered = false;
    const cancel = send(app, 'DELETE', '/api/telegram/link').then(() => {
      answered = true;
    });
    await vi.waitFor(() => expect(bot.to('GET', '/terminal')).toHaveLength(1));

    const during = await send(app, 'GET', '/api/telegram');
    expect(during.body.data).toEqual(NONE);
    expect(answered).toBe(false);
    release();
    await cancel;

    expect(readTelegramKey(dataDir)).toEqual(key);
    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: true, state: 'connected' });
  });

  it('a restart during linking restores the key that was there', async () => {
    const before = linked();
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');
    expect(keyOnDisk().keyHash).not.toBe(before.keyHash);

    await boot(first.bot).link.settled();

    expect(readTelegramKey(dataDir)).toEqual(before);
  });

  it('a restart after the user confirmed in the bot keeps the new key and finishes the link', async () => {
    linked();
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');
    const key = keyOnDisk();
    first.bot.behaviour.reason = null;

    const second = boot(first.bot);
    await second.link.settled();

    expect(readTelegramKey(dataDir)).toEqual(key);
    expect(fs.existsSync(path.join(dataDir, 'telegram-link'))).toBe(false);
    expect(second.status.auth).toBe('ok');
  });

  it('a restart while the bot cannot be reached restores the key that was there', async () => {
    const before = linked();
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');
    first.bot.behaviour.down = 'refused';

    const second = boot(first.bot);
    await second.link.settled();

    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(second.status.auth).toBeNull();
  });

  it('a restart that restores the key that was there sends one sync', async () => {
    const before = linked();
    const first = boot();
    await send(first.app, 'POST', '/api/telegram/link');
    first.bot.behaviour.pendingKey = keyOnDisk().key;

    const second = boot(first.bot);
    await second.link.settled();
    second.sync.start();
    await second.sync.idle();
    await second.sync.idle();

    expect(readTelegramKey(dataDir)).toEqual(before);
    expect(first.bot.to('PUT', '/terminal/triggers')).toHaveLength(1);
    expect(first.bot.to('PUT', '/terminal/triggers')[0].headers['x-terminal-key']).toBe(before.key);
    expect((await send(second.app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: true, state: 'connected' });
  });

  it('a restart during a first link leaves no key', async () => {
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');

    const second = boot(first.bot);
    await second.link.settled();

    expect(readTelegramKey(dataDir)).toBeNull();
    expect((await send(second.app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: false, state: 'none' });
  });

  it('a read during the restart check does not say connected on the unconfirmed key', async () => {
    fakeInterval();
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');
    const release = holdChecks(first.bot);

    const second = boot(first.bot);
    await vi.waitFor(() => expect(first.bot.to('GET', '/terminal')).toHaveLength(1));
    const during = await send(second.app, 'GET', '/api/telegram');
    release();
    await second.link.settled();

    expect(during.body.data).toEqual(NONE);
    expect(readTelegramKey(dataDir)).toBeNull();
  });

  it('a confirmed link keeps its key after a restart', async () => {
    fakeInterval();
    const first = boot();
    first.bot.behaviour.reason = 'pending';
    await send(first.app, 'POST', '/api/telegram/link');
    first.bot.behaviour.reason = null;
    await vi.advanceTimersByTimeAsync(5_000);
    const key = keyOnDisk();

    await boot(first.bot).link.settled();

    expect(readTelegramKey(dataDir)).toEqual(key);
  });
});

describe('Telegram settings', () => {
  it('reports state', async () => {
    linked();
    const { app, sync, status } = boot();

    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.lastSyncAt).toBe(T0));

    expect((await send(app, 'GET', '/api/telegram')).body.data).toEqual({
      connected: true,
      state: 'connected',
      settings: { liquidation: true, interest: true, maturity: true, rollover: true },
      lastSyncAt: T0,
      lastSyncError: null,
      alertsPageUrl: `${BOT_URL}/alerts`,
    });
  });

  it('saves a toggle on the bot', async () => {
    const key = linked();
    const { app, bot } = boot();

    const res = await send(app, 'PATCH', '/api/telegram/settings', { interest: false });

    expect(res.code).toBe(200);
    const patches = bot.to('PATCH', '/terminal/settings');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ interest: false });
    expect(patches[0].headers['x-terminal-key']).toBe(key.key);
    expect(res.body.data.settings).toEqual({ liquidation: true, interest: false, maturity: true, rollover: true });
  });

  it('refuses a setting that is not true or false', async () => {
    linked();
    const { app, bot } = boot();

    const res = await send(app, 'PATCH', '/api/telegram/settings', { interest: 'off' });

    expect(res.code).toBe(400);
    expect(bot.calls).toHaveLength(0);
  });

  it('disconnects', async () => {
    const key = linked();
    const { app, bot } = boot();

    const res = await send(app, 'DELETE', '/api/telegram');

    expect(res.code).toBe(200);
    expect(res.body.data.connected).toBe(false);
    const deletes = bot.to('DELETE', '/terminal');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].headers['x-terminal-key']).toBe(key.key);
    expect(fs.existsSync(path.join(dataDir, 'telegram-key'))).toBe(false);
    expect((await send(app, 'GET', '/api/telegram')).body.data).toEqual({
      connected: false,
      state: 'none',
      settings: null,
      lastSyncAt: null,
      lastSyncError: null,
      alertsPageUrl: `${BOT_URL}/alerts`,
    });
  });

  it('a disconnect the bot cannot answer keeps the key and stays connected', async () => {
    const key = linked();
    const { app, bot } = boot();
    bot.behaviour.down = 'refused';

    const res = await send(app, 'DELETE', '/api/telegram');

    expect(res.code).toBe(503);
    expect(res.body.error.message).toBe(BOT_UNREACHABLE);
    expect(keyOnDisk().key).toBe(key.key);
    bot.behaviour.down = null;
    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: true, state: 'connected' });
  });

  it('a disconnect the bot answers 404 keeps the key', async () => {
    const key = linked();
    const { app, bot } = boot();
    bot.behaviour.down = 404;

    const res = await send(app, 'DELETE', '/api/telegram');

    expect(res.code).toBe(503);
    expect(res.body.error.message).toBe(BOT_UNREACHABLE);
    expect(keyOnDisk().key).toBe(key.key);
  });

  it('a disconnect the bot refuses for a reason clears the key', async () => {
    linked();
    const { app, bot } = boot();
    bot.behaviour.reason = 'unknown';

    const res = await send(app, 'DELETE', '/api/telegram');

    expect(res.code).toBe(200);
    expect(res.body.data.connected).toBe(false);
    expect(readTelegramKey(dataDir)).toBeNull();
  });

  it('replaced by another terminal', async () => {
    linked();
    const { app, bot, sync, status } = boot();
    bot.behaviour.reason = 'replaced';

    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('replaced'));

    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: false, state: 'replaced' });
  });

  it('removed on the Boros page', async () => {
    linked();
    const { app, bot, sync, status } = boot();
    bot.behaviour.reason = 'removed';

    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('removed'));

    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: false, state: 'removed' });
  });

  it('a key the bot does not know reads as a failed sync', async () => {
    linked();
    const { app, bot, sync, status } = boot();
    bot.behaviour.reason = 'unknown';

    sync.requestSync('boot');
    await vi.waitFor(() => expect(status.auth).toBe('unknown'));

    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({
      connected: true,
      state: 'connected',
      lastSyncError: { at: T0 },
    });
  });

  it('after a restart, the state waits for the first sync', async () => {
    linked();
    const { app, bot, sync, readCoins } = boot();
    bot.behaviour.reason = 'replaced';
    readCoins.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([ETH]), 50)));

    sync.start();

    expect((await send(app, 'GET', '/api/telegram')).body.data).toMatchObject({ connected: false, state: 'replaced' });
  });

  it('a toggle while not connected names the fix', async () => {
    const { app } = boot();

    const res = await send(app, 'PATCH', '/api/telegram/settings', { interest: false });

    expect(res.code).toBe(409);
    expect(res.body.error.message).toBe('This terminal is not connected to Telegram alerts. Click Set up to connect it.');
  });

  it('bad key file', async () => {
    fs.writeFileSync(path.join(dataDir, 'telegram-key'), '{"key":');
    const { app, bot, sync } = boot();

    sync.requestSync('boot');
    const res = await send(app, 'GET', '/api/telegram');

    expect(res.body.data).toMatchObject({ connected: false, state: 'none' });
    expect(bot.calls).toHaveLength(0);
  });
});

describe('Telegram roll signals', () => {
  const FUTURE_SEC = Math.floor(T0 / 1_000) + 7 * DAY_SEC;
  const LATER_SEC = FUTURE_SEC + 30 * DAY_SEC;

  const rollBody = (over: Record<string, unknown> = {}) => ({
    signals: [
      {
        coin: 'ETH',
        longVenue: 'gate',
        shortVenue: 'hyperliquid',
        maturity: FUTURE_SEC,
        to: { maturity: LATER_SEC, apr: 0.124, currentApr: 0.091 },
        ...over,
      },
    ],
  });

  const rollsSent = (bot: Bot) => {
    const puts = bot.to('PUT', '/terminal/triggers');
    expect(puts).toHaveLength(1);
    return (puts[0].body as { coins: TriggerCoin[] }).coins[0].rolls;
  };

  it('stores a signal and the next sync carries it', async () => {
    linked();
    const { app, bot, sync } = boot();

    const res = await send(app, 'PUT', '/api/telegram/roll-signals', rollBody());
    await sync.idle();

    expect(res.code).toBe(200);
    expect(res.body.data).toEqual({ stored: 1 });
    expect(rollsSent(bot)).toEqual([
      {
        longVenue: 'GATE',
        shortVenue: 'HYPERLIQUID',
        maturity: FUTURE_SEC,
        to: { maturity: LATER_SEC, apr: 0.124, currentApr: 0.091 },
      },
    ]);
  });

  it('refuses a maturity that is not a whole number of seconds', async () => {
    linked();
    const { app, bot } = boot();

    const res = await send(app, 'PUT', '/api/telegram/roll-signals', rollBody({ maturity: FUTURE_SEC + 0.5 }));

    expect(res.code).toBe(400);
    expect(res.body.error.message).toBe('maturity must be a whole number of seconds.');
    expect(bot.calls).toHaveLength(0);
  });

  it('a coin the terminal does not hold is not sent', async () => {
    linked();
    const { app, bot, sync } = boot();

    await send(app, 'PUT', '/api/telegram/roll-signals', rollBody({ coin: 'BTC' }));
    await sync.idle();

    expect(rollsSent(bot)).toEqual([]);
  });

  it('a maturity that has passed is not sent', async () => {
    linked();
    const { app, bot, sync } = boot();

    await send(app, 'PUT', '/api/telegram/roll-signals', rollBody({ maturity: Math.floor(T0 / 1_000) - DAY_SEC }));
    await sync.idle();

    expect(rollsSent(bot)).toEqual([]);
  });
});

describe('Telegram alerts page URL', () => {
  it('is the production default with no bot base configured', async () => {
    const { app } = boot();

    expect((await send(app, 'GET', '/api/telegram')).body.data.alertsPageUrl).toBe(`${BOT_URL}/alerts`);
  });

  it('follows a staging bot base set through CROSSEX_BOT_URL', async () => {
    process.env.CROSSEX_BOT_URL = 'https://staging.boros-bot.example/';
    const { app } = boot();

    expect((await send(app, 'GET', '/api/telegram')).body.data.alertsPageUrl).toBe('https://staging.boros-bot.example/alerts');
  });
});
