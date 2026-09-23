import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTelegramKey, readTelegramKey, writeTelegramKey } from '../../src/server/telegram/keyFile';
import { createTelegramLink } from '../../src/server/telegram/link';
import { TelegramStatus } from '../../src/server/telegram/status';
import { createTelegramSync } from '../../src/server/telegram/sync';
import { signWalletProof } from '../../src/server/telegram/walletProof';
import { BOT_URL, CROSSEX, ETH, makeBotStub, VIEW, type BotCall } from './helpers/telegram';
import { HOST, makeTestApp } from './helpers/gate-nock';

const AGENT_KEY = `0x${'11'.repeat(32)}` as const;
const ROOT = '0xAbCd00000000000000000000000000000000Ef12';
const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);

let dataDir: string;
let now: number;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'telegram-refused-'));
  now = T0;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const routeOf = (call: BotCall) => `${call.method} ${call.url.slice(CROSSEX.length)}`;

function refusingBot(opts: { refuseAlways?: boolean } = {}) {
  return makeBotStub(
    async (call) => {
      const route = routeOf(call);
      if (route === 'POST /link-requests') {
        return { status: 201, body: { code: 'c', expiresAt: new Date(now + 600_000).toISOString() } };
      }
      if (route === 'POST /terminal/wallets' || opts.refuseAlways) {
        return { status: 403, body: { reason: 'agent-not-approved' } };
      }
      if (call.headers['x-terminal-wallet']) return { status: 401, body: { reason: 'wallet-unlinked' } };
      if (route === 'DELETE /terminal') return { status: 200, body: { removed: true } };
      return { status: 200, body: { ...VIEW, settings: { ...VIEW.settings, ...(call.body as object) } } };
    },
    {
      wallet: () => ROOT,
      proveWallet: (keyHash, wallet) =>
        signWalletProof({ keyHash, wallet, agentPrivateKey: AGENT_KEY, nowMs: now }),
    },
  );
}

function boot(stub: ReturnType<typeof refusingBot>) {
  const status = new TelegramStatus();
  const sync = createTelegramSync({
    dataDir,
    bot: stub.bot,
    status,
    readCoins: async () => [ETH],
    port: 7788,
    version: '1.6.3',
    now: () => now,
  });
  const onConfirmed = vi.fn(() => status.setAuth('ok'));
  const link = createTelegramLink({
    dataDir,
    bot: stub.bot,
    pageUrl: `${BOT_URL}/alerts`,
    version: '1.6.3',
    now: () => now,
    status,
    onConfirmed,
  });
  const app = makeTestApp({ dataDir, telegram: { link, sync, status, bot: stub.bot } });
  cleanups.push(async () => {
    link.stop();
    sync.stop();
    await app.close();
  });
  return { status, link, app, onConfirmed };
}

const send = async (app: FastifyInstance, method: 'PATCH' | 'DELETE', url: string, payload?: object) => {
  const res = await app.inject({ method, url, headers: HOST, payload });
  return { code: res.statusCode, body: res.json() };
};

describe('confirming a link when the bot refuses the wallet proof', () => {
  it('the poll counts the key as linked and records the refused wallet', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { status, link, onConfirmed } = boot(refusingBot());
    await link.start();
    const key = readTelegramKey(dataDir);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(link.status().status).toBe('confirmed');
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(status.walletRefused).toBe(ROOT.toLowerCase());
    expect(readTelegramKey(dataDir)?.keyHash).toBe(key?.keyHash);
  });

  it('the check after a cancel keeps the new key instead of restoring the old one', async () => {
    const old = newTelegramKey(T0 - 1_000);
    writeTelegramKey(dataDir, old);
    const { status, link, onConfirmed } = boot(refusingBot());
    await link.start();
    const fresh = readTelegramKey(dataDir);
    expect(fresh?.keyHash).not.toBe(old.keyHash);

    await link.cancel();

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(readTelegramKey(dataDir)?.keyHash).toBe(fresh?.keyHash);
    expect(status.walletRefused).toBe(ROOT.toLowerCase());
  });
});

describe('Telegram routes when the bot refuses the wallet proof', () => {
  it('PATCH /telegram/settings retries once for the linked wallet and saves', async () => {
    writeTelegramKey(dataDir, newTelegramKey(T0));
    const stub = refusingBot();
    const { app } = boot(stub);

    const res = await send(app, 'PATCH', '/api/telegram/settings', { interest: false });

    expect(res.code).toBe(200);
    expect(res.body.data.settings.interest).toBe(false);
    const patches = stub.to('PATCH', '/terminal/settings');
    expect(patches).toHaveLength(2);
    expect(patches[0].headers['x-terminal-wallet']).toBe(ROOT.toLowerCase());
    expect(patches[1].headers).not.toHaveProperty('x-terminal-wallet');
  });

  it('DELETE /telegram retries once for the linked wallet and removes the key', async () => {
    writeTelegramKey(dataDir, newTelegramKey(T0));
    const stub = refusingBot();
    const { app } = boot(stub);

    const res = await send(app, 'DELETE', '/api/telegram');

    expect(res.code).toBe(200);
    expect(readTelegramKey(dataDir)).toBeNull();
    const deletes = stub.to('DELETE', '/terminal');
    expect(deletes).toHaveLength(2);
    expect(deletes[1].headers).not.toHaveProperty('x-terminal-wallet');
  });

  it.each([
    ['PATCH', '/api/telegram/settings', { interest: false }],
    ['DELETE', '/api/telegram', undefined],
  ] as const)('%s %s does not blame an unreachable bot when the refusal stays', async (method, url, payload) => {
    writeTelegramKey(dataDir, newTelegramKey(T0));
    const { app } = boot(refusingBot({ refuseAlways: true }));

    const res = await send(app, method, url, payload);

    expect(res.code).toBe(409);
    expect(res.body.error.message).not.toMatch(/reach|did not answer|not available/i);
    expect(res.body.error.message).toMatch(/refused the logged-in wallet/);
    expect(readTelegramKey(dataDir)).not.toBeNull();
  });
});
