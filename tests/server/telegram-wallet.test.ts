import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotAuthError } from '../../src/server/telegram/botClient';
import { newTelegramKey, readTelegramKey, writeTelegramKey } from '../../src/server/telegram/keyFile';
import { createTelegramLink } from '../../src/server/telegram/link';
import { TelegramStatus } from '../../src/server/telegram/status';
import { createTelegramSync } from '../../src/server/telegram/sync';
import { BOT_URL, ETH, makeBotStub, type BotAnswer, VIEW } from './helpers/telegram';

const ROOT = '0xAbCd00000000000000000000000000000000Ef12';
const OTHER = '0x1111000000000000000000000000000000002222';

const settingsBody = { status: 200, body: VIEW };
const unlinkedBody = { status: 401, body: { reason: 'wallet-unlinked' } };
const echoWallet = (wallet: string) => ({ status: 200, body: { ...VIEW, wallet: wallet.toLowerCase() } });
const linkBody = () => ({ status: 201, body: { code: 'the-code', expiresAt: new Date(Date.now() + 600_000).toISOString() } });

const stubWith = (answer: BotAnswer, wallet: () => string | null = () => ROOT) => makeBotStub(answer, { wallet });

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'telegram-wallet-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeSync(stub: ReturnType<typeof makeBotStub>, status: TelegramStatus, wallet: () => string | null) {
  return createTelegramSync({
    dataDir,
    bot: stub.bot,
    status,
    readCoins: async () => [ETH],
    port: 7788,
    version: '1.7.1',
    now: () => Date.now(),
    wallet,
  });
}

async function syncOnce(sync: ReturnType<typeof makeSync>): Promise<void> {
  sync.requestSync('test');
  await sync.idle();
}

describe('x-terminal-wallet header', () => {
  it('rides every keyed call, lowercase, when a root is configured', async () => {
    const stub = stubWith(async () => settingsBody);
    await stub.bot.getTerminal('k');
    await stub.bot.patchSettings('k', { liquidation: true });
    expect(stub.calls.map((c) => c.headers['x-terminal-wallet'])).toEqual([ROOT.toLowerCase(), ROOT.toLowerCase()]);
  });

  it('is absent with no root, and on the unkeyed link request', async () => {
    const none = stubWith(async () => settingsBody, () => null);
    await none.bot.getTerminal('k');
    expect(none.calls[0].headers).not.toHaveProperty('x-terminal-wallet');

    const link = stubWith(async () => linkBody());
    await link.bot.requestLink({ keyHash: 'h', version: '1' });
    expect(link.calls[0].headers).not.toHaveProperty('x-terminal-wallet');
    expect(link.calls[0].headers).not.toHaveProperty('x-terminal-key');
  });

  it('the link request names the wallet on screen, and no wallet when there is none', async () => {
    const named = stubWith(async () => linkBody());
    await named.bot.requestLink({ keyHash: 'h', version: '1' });
    expect(named.calls[0].body).toEqual({ keyHash: 'h', version: '1', wallet: ROOT.toLowerCase() });

    const none = stubWith(async () => linkBody(), () => null);
    await none.bot.requestLink({ keyHash: 'h', version: '1' });
    expect(none.calls[0].body).toEqual({ keyHash: 'h', version: '1' });
  });

  it('an older bot that refuses the wallet field gets the request again without it', async () => {
    const stub = stubWith(async (call) =>
      (call.body as { wallet?: string } | undefined)?.wallet
        ? { status: 400, body: { message: ['property wallet should not exist'], error: 'Bad Request', statusCode: 400 } }
        : linkBody(),
    );
    await expect(stub.bot.requestLink({ keyHash: 'h', version: '1' })).resolves.toMatchObject({ code: 'the-code' });
    expect(stub.calls.map((c) => c.body)).toEqual([
      { keyHash: 'h', version: '1', wallet: ROOT.toLowerCase() },
      { keyHash: 'h', version: '1' },
    ]);
  });

  it('any other 400 is not retried', async () => {
    const stub = stubWith(async () => ({ status: 400, body: { message: 'keyHash must be 64 lowercase hex characters' } }));
    await expect(stub.bot.requestLink({ keyHash: 'h', version: '1' })).rejects.toThrow();
    expect(stub.calls).toHaveLength(1);
  });

  it('a wallet-unlinked answer is thrown once, with no proof call', async () => {
    const stub = stubWith(async () => unlinkedBody);
    await expect(stub.bot.getTerminal('k')).rejects.toEqual(new BotAuthError('wallet-unlinked'));
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls.some((c) => c.url.endsWith('/terminal/wallets'))).toBe(false);
  });

  it('disconnect retries without the wallet when the active wallet is unlinked', async () => {
    const stub = stubWith(async (call) => (call.headers['x-terminal-wallet'] ? unlinkedBody : { status: 200, body: {} }));
    await stub.bot.deleteTerminal('k');
    expect(stub.to('DELETE', '/terminal').map((c) => c.headers['x-terminal-wallet'] ?? null)).toEqual([
      ROOT.toLowerCase(),
      null,
    ]);
    expect(stub.to('DELETE', '/terminal').every((c) => c.headers['x-terminal-key'] === 'k')).toBe(true);
  });
});

describe('sync and an unlinked wallet', () => {
  it('401 wallet-unlinked keeps the key and records the wallet', async () => {
    const key = newTelegramKey(Date.now());
    writeTelegramKey(dataDir, key);
    const stub = stubWith(async () => unlinkedBody);
    const status = new TelegramStatus();
    const sync = makeSync(stub, status, () => ROOT);
    await syncOnce(sync);
    sync.stop();
    expect(readTelegramKey(dataDir)).toEqual(key);
    expect(status.unlinkedWallet).toBe(ROOT.toLowerCase());
    expect(status.auth).toBeNull();
    expect(status.lastSyncError).toBeNull();
  });

  it('stops syncing that wallet, then syncs and clears it when the wallet changes', async () => {
    writeTelegramKey(dataDir, newTelegramKey(Date.now()));
    let wallet = ROOT;
    const stub = stubWith(
      async (call) => (call.headers['x-terminal-wallet'] === ROOT.toLowerCase() ? unlinkedBody : echoWallet(wallet)),
      () => wallet,
    );
    const status = new TelegramStatus();
    const sync = makeSync(stub, status, () => wallet);
    await syncOnce(sync);
    await syncOnce(sync);
    expect(stub.to('PUT', '/terminal/triggers')).toHaveLength(1);
    expect(status.unlinkedWallet).toBe(ROOT.toLowerCase());

    wallet = OTHER;
    await syncOnce(sync);
    sync.stop();
    expect(stub.to('PUT', '/terminal/triggers')).toHaveLength(2);
    expect(status.unlinkedWallet).toBeNull();
    expect(status.alertWallet).toBe(OTHER.toLowerCase());
    expect(status.auth).toBe('ok');
  });

  it('the timer and other reasons skip an unlinked wallet; settings, login and linked ask the bot again', async () => {
    writeTelegramKey(dataDir, newTelegramKey(Date.now()));
    let linkedNow = false;
    const stub = stubWith(async () => (linkedNow ? echoWallet(ROOT) : unlinkedBody));
    const status = new TelegramStatus();
    const sync = makeSync(stub, status, () => ROOT);
    await syncOnce(sync);
    expect(status.unlinkedWallet).toBe(ROOT.toLowerCase());

    for (const reason of ['deal', 'rebalance', 'transfer', 'restored']) sync.requestSync(reason);
    await sync.idle();
    expect(stub.to('PUT', '/terminal/triggers')).toHaveLength(1);

    for (const [i, reason] of ['settings', 'login', 'linked'].entries()) {
      sync.requestSync(reason);
      await sync.idle();
      expect(stub.to('PUT', '/terminal/triggers')).toHaveLength(2 + i);
      expect(status.unlinkedWallet).toBe(ROOT.toLowerCase());
    }

    linkedNow = true;
    sync.requestSync('settings');
    await sync.idle();
    sync.stop();
    expect(status.unlinkedWallet).toBeNull();
    expect(status.alertWallet).toBe(ROOT.toLowerCase());
  });

  it('records the wallet the bot names as the alert wallet, else the terminal wallet', async () => {
    writeTelegramKey(dataDir, newTelegramKey(Date.now()));
    let body: unknown = { ...VIEW, wallet: OTHER };
    const stub = stubWith(async () => ({ status: 200, body }));
    const status = new TelegramStatus();
    const sync = makeSync(stub, status, () => ROOT);
    await syncOnce(sync);
    expect(status.alertWallet).toBe(OTHER.toLowerCase());

    body = { settings: VIEW.settings };
    await syncOnce(sync);
    sync.stop();
    expect(status.alertWallet).toBe(ROOT.toLowerCase());
  });

  it('a successful sync clears the unlinked wallet', async () => {
    writeTelegramKey(dataDir, newTelegramKey(Date.now()));
    const stub = stubWith(async () => echoWallet(ROOT));
    const status = new TelegramStatus();
    status.setUnlinkedWallet(OTHER.toLowerCase());
    const sync = makeSync(stub, status, () => ROOT);
    await syncOnce(sync);
    sync.stop();
    expect(status.unlinkedWallet).toBeNull();
    expect(status.alertWallet).toBe(ROOT.toLowerCase());
  });
});

describe('add-wallet link', () => {
  it('sends the existing keyHash with the key header, writes no new key, and clears the wallet once linked', async () => {
    const key = newTelegramKey(Date.now());
    writeTelegramKey(dataDir, key);
    let linked = false;
    const stub = stubWith(async (call) => {
      if (call.url.endsWith('/link-requests')) return linkBody();
      return linked ? settingsBody : unlinkedBody;
    });
    const status = new TelegramStatus();
    status.setAuth('ok');
    status.setUnlinkedWallet(ROOT.toLowerCase());
    const onConfirmed = vi.fn();
    const link = createTelegramLink({
      dataDir,
      bot: stub.bot,
      pageUrl: `${BOT_URL}/alerts`,
      version: '1.7.1',
      now: () => Date.now(),
      status,
      onConfirmed,
      pollMs: 5,
    });

    const started = await link.start({ addWallet: true });
    expect(started.url).toBe(`${BOT_URL}/alerts?crossex=the-code`);
    const request = stub.to('POST', '/link-requests')[0];
    expect(request.body).toEqual({ keyHash: key.keyHash, version: '1.7.1', wallet: ROOT.toLowerCase() });
    expect(request.headers['x-terminal-key']).toBe(key.key);
    expect(request.headers).not.toHaveProperty('x-terminal-wallet');
    expect(readTelegramKey(dataDir)).toEqual(key);
    expect(fs.existsSync(path.join(dataDir, 'telegram-link'))).toBe(false);

    await vi.waitFor(() => expect(stub.to('GET', '/terminal').length).toBeGreaterThanOrEqual(2));
    expect(link.status().status).toBe('pending');
    expect(onConfirmed).not.toHaveBeenCalled();

    linked = true;
    await vi.waitFor(() => expect(link.status().status).toBe('confirmed'));
    link.stop();
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(status.unlinkedWallet).toBeNull();
    expect(readTelegramKey(dataDir)).toEqual(key);
  });

  it('keeps the key when the add-wallet link is cancelled', async () => {
    const key = newTelegramKey(Date.now());
    writeTelegramKey(dataDir, key);
    const stub = stubWith(async (call) => (call.url.endsWith('/link-requests') ? linkBody() : unlinkedBody));
    const status = new TelegramStatus();
    const link = createTelegramLink({
      dataDir,
      bot: stub.bot,
      pageUrl: `${BOT_URL}/alerts`,
      version: '1.7.1',
      now: () => Date.now(),
      status,
      onConfirmed: () => undefined,
      pollMs: 60_000,
    });
    await link.start({ addWallet: true });
    await link.cancel();
    expect(link.status().status).toBe('none');
    expect(readTelegramKey(dataDir)).toEqual(key);
    expect(stub.to('DELETE', '/terminal')).toHaveLength(0);
  });

  it('with no key, addWallet falls back to a new key', async () => {
    const stub = stubWith(async () => linkBody());
    const link = createTelegramLink({
      dataDir,
      bot: stub.bot,
      pageUrl: `${BOT_URL}/alerts`,
      version: '1.7.1',
      now: () => Date.now(),
      status: new TelegramStatus(),
      onConfirmed: () => undefined,
      pollMs: 60_000,
    });
    await link.start({ addWallet: true });
    link.stop();
    const written = readTelegramKey(dataDir);
    expect(written).not.toBeNull();
    const request = stub.to('POST', '/link-requests')[0];
    expect(request.body).toEqual({ keyHash: written?.keyHash, version: '1.7.1', wallet: ROOT.toLowerCase() });
    expect(request.headers).not.toHaveProperty('x-terminal-key');
  });
});
