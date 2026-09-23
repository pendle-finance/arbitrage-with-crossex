import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotAuthError, BotWalletRefusedError } from '../../src/server/telegram/botClient';
import { hashKey, newTelegramKey, writeTelegramKey } from '../../src/server/telegram/keyFile';
import { TelegramStatus } from '../../src/server/telegram/status';
import { createTelegramSync } from '../../src/server/telegram/sync';
import { signWalletProof, walletProofMessage } from '../../src/server/telegram/walletProof';
import { ETH, makeBotStub, type BotAnswer, VIEW } from './helpers/telegram';

const AGENT_KEY = `0x${'11'.repeat(32)}` as const;
const AGENT = privateKeyToAccount(AGENT_KEY).address.toLowerCase();
const ROOT = '0xAbCd00000000000000000000000000000000Ef12';
const NOW_MS = 1_790_000_000_000;

const settingsBody = { status: 200, body: VIEW };
const proveWallet = (keyHash: string, wallet: string) =>
  signWalletProof({ keyHash, wallet, agentPrivateKey: AGENT_KEY, nowMs: NOW_MS });

const stubWith = (answer: BotAnswer, wallet: string | null = ROOT) =>
  makeBotStub(answer, { wallet: () => wallet, proveWallet });

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'telegram-wallet-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('x-terminal-wallet header', () => {
  it('rides every keyed call, lowercase, when a root is configured', async () => {
    const stub = stubWith(async () => settingsBody);
    await stub.bot.getTerminal('k');
    await stub.bot.patchSettings('k', { liquidation: true });
    expect(stub.calls.map((c) => c.headers['x-terminal-wallet'])).toEqual([ROOT.toLowerCase(), ROOT.toLowerCase()]);
  });

  it('is absent with no root, and on the unkeyed link request', async () => {
    const none = stubWith(async () => settingsBody, null);
    await none.bot.getTerminal('k');
    expect(none.calls[0].headers).not.toHaveProperty('x-terminal-wallet');

    const link = stubWith(async () => ({ status: 200, body: { code: 'c', expiresAt: '2026-09-23T00:00:00Z' } }));
    await link.bot.requestLink({ keyHash: 'h', version: '1' });
    expect(link.calls[0].headers).not.toHaveProperty('x-terminal-wallet');
  });
});

describe('wallet-unlinked', () => {
  it('follows the root with a signed proof, then retries the call once', async () => {
    let unlinked = true;
    const stub = stubWith(async (call) => {
      if (call.method === 'POST') {
        unlinked = false;
        return { status: 201, body: { ok: true } };
      }
      return unlinked ? { status: 401, body: { reason: 'wallet-unlinked' } } : settingsBody;
    });
    await stub.bot.getTerminal('the-key');

    expect(stub.calls.map((c) => `${c.method} ${c.url.split('/crossex')[1]}`)).toEqual([
      'GET /terminal',
      'POST /terminal/wallets',
      'GET /terminal',
    ]);
    const proof = stub.calls[1].body as { wallet: string; agent: string; signedAt: number; signature: `0x${string}` };
    expect(proof.wallet).toBe(ROOT.toLowerCase());
    expect(proof.agent).toBe(AGENT);
    expect(proof.signedAt).toBe(NOW_MS / 1000);
    expect(stub.calls[1].headers['x-terminal-key']).toBe('the-key');
  });

  it('retries at most once', async () => {
    const stub = stubWith(async (call) =>
      call.method === 'POST' ? { status: 201, body: {} } : { status: 401, body: { reason: 'wallet-unlinked' } },
    );
    await expect(stub.bot.getTerminal('k')).rejects.toEqual(new BotAuthError('wallet-unlinked'));
    expect(stub.calls).toHaveLength(3);
  });

  it('does not follow with no root', async () => {
    const stub = stubWith(async () => ({ status: 401, body: { reason: 'wallet-unlinked' } }), null);
    await expect(stub.bot.getTerminal('k')).rejects.toBeInstanceOf(BotAuthError);
    expect(stub.calls).toHaveLength(1);
  });

  it('surfaces agent-not-approved on the Telegram status', async () => {
    const stub = stubWith(async (call) =>
      call.method === 'POST'
        ? { status: 403, body: { reason: 'agent-not-approved' } }
        : { status: 401, body: { reason: 'wallet-unlinked' } },
    );
    await expect(stub.bot.getTerminal('k')).rejects.toBeInstanceOf(BotWalletRefusedError);

    writeTelegramKey(dataDir, newTelegramKey(Date.now()));
    const status = new TelegramStatus();
    const sync = createTelegramSync({
      dataDir,
      bot: stub.bot,
      status,
      readCoins: async () => [ETH],
      port: 7788,
      version: '1.7.1',
      now: () => Date.now(),
      wallet: () => ROOT,
    });
    sync.requestSync('test');
    await sync.idle();
    sync.stop();
    expect(status.walletRefused).toBe(ROOT.toLowerCase());
    expect(stub.to('POST', '/terminal/wallets')).toHaveLength(2);
    expect(stub.to('PUT', '/terminal/triggers')).toHaveLength(1);
  });

  it('records the wallet alerts follow after a clean sync', async () => {
    const stub = stubWith(async () => settingsBody);
    writeTelegramKey(dataDir, newTelegramKey(Date.now()));
    const status = new TelegramStatus();
    const sync = createTelegramSync({
      dataDir,
      bot: stub.bot,
      status,
      readCoins: async () => [ETH],
      port: 7788,
      version: '1.7.1',
      now: () => Date.now(),
      wallet: () => ROOT,
    });
    sync.requestSync('test');
    await sync.idle();
    sync.stop();
    expect(status.alertWallet).toBe(ROOT.toLowerCase());
    expect(status.walletRefused).toBeNull();
  });
});

describe('wallet proof', () => {
  it('signs the exact message with the agent key', async () => {
    const key = 'terminal-key';
    const proof = await signWalletProof({ keyHash: hashKey(key), wallet: ROOT, agentPrivateKey: AGENT_KEY, nowMs: NOW_MS });
    const message = `CrossEx terminal ${hashKey(key)} follows ${ROOT.toLowerCase()} at ${NOW_MS / 1000}`;
    expect(walletProofMessage(hashKey(key), ROOT.toLowerCase(), NOW_MS / 1000)).toBe(message);
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await verifyMessage({ address: AGENT as `0x${string}`, message, signature: proof.signature as `0x${string}` }),
    ).toBe(true);
  });
});
