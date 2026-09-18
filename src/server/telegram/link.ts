import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TelegramLinkStart, TelegramLinkStatus } from '../../../web/src/api/types';
import { readOwnerJson, writeOwnerOnlyJson } from '../secretFile';
import { BotAuthError, BotUnavailableError, type BotClient } from './botClient';
import { deleteTelegramKey, newTelegramKey, readTelegramKey, writeTelegramKey, type TelegramKey } from './keyFile';

const POLL_EVERY_MS = 5_000;
const SWAP_FILE = 'telegram-link';

export interface TelegramLink {
  start(): Promise<TelegramLinkStart>;
  status(): TelegramLinkStatus;
  cancel(): void;
  stop(): void;
}

export interface TelegramLinkOptions {
  dataDir: string;
  bot: BotClient;
  pageUrl: string;
  version: string;
  now: () => number;
  onConfirmed: () => void;
  pollMs?: number;
}

interface KeySwap {
  key: Pick<TelegramKey, 'keyHash'>;
  previous: TelegramKey | null;
}

interface PendingLink extends KeySwap {
  key: TelegramKey;
  url: string;
  expiresAt: number;
  state: 'pending' | 'confirmed' | 'expired';
  polling: boolean;
}

function parseSwap(value: unknown): KeySwap | null {
  const raw = value as Partial<KeySwap> | null;
  if (typeof raw?.key?.keyHash !== 'string') return null;
  return { key: { keyHash: raw.key.keyHash }, previous: raw.previous ?? null };
}

export function createTelegramLink(opts: TelegramLinkOptions): TelegramLink {
  let link: PendingLink | null = null;
  let starting: Promise<TelegramLinkStart> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const swapFile = path.join(opts.dataDir, SWAP_FILE);

  const stopPolling = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const restoreKey = (swap: KeySwap): void => {
    fs.rmSync(swapFile, { force: true });
    if (readTelegramKey(opts.dataDir)?.keyHash !== swap.key.keyHash) return;
    if (swap.previous === null) {
      deleteTelegramKey(opts.dataDir);
      return;
    }
    writeTelegramKey(opts.dataDir, swap.previous);
  };

  const unconfirmed = readOwnerJson(swapFile, parseSwap);
  if (unconfirmed !== null) restoreKey(unconfirmed);

  const settle = (current: PendingLink, state: 'confirmed' | 'expired'): void => {
    if (link !== current || current.state !== 'pending') return;
    current.state = state;
    stopPolling();
    if (state === 'expired') {
      restoreKey(current);
      return;
    }
    fs.rmSync(swapFile, { force: true });
    opts.onConfirmed();
  };

  const poll = async (current: PendingLink): Promise<void> => {
    if (current.polling || link !== current || current.state !== 'pending') return;
    if (opts.now() >= current.expiresAt) {
      settle(current, 'expired');
      return;
    }
    current.polling = true;
    try {
      await opts.bot.getTerminal(current.key.key);
      settle(current, 'confirmed');
    } catch (err) {
      if (err instanceof BotAuthError && err.reason !== 'pending') settle(current, 'expired');
    } finally {
      current.polling = false;
    }
  };

  const begin = async (): Promise<TelegramLinkStart> => {
    const swap = { key: newTelegramKey(opts.now()), previous: readTelegramKey(opts.dataDir) };
    writeOwnerOnlyJson(swapFile, { key: { keyHash: swap.key.keyHash }, previous: swap.previous });
    writeTelegramKey(opts.dataDir, swap.key);
    try {
      const answer = await opts.bot.requestLink({ keyHash: swap.key.keyHash, version: opts.version });
      const expiresAt = Date.parse(answer.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        throw new BotUnavailableError('The Telegram bot answered a link request with no expiry.');
      }
      const current: PendingLink = {
        ...swap,
        url: `${opts.pageUrl}?crossex=${encodeURIComponent(answer.code)}`,
        expiresAt,
        state: 'pending',
        polling: false,
      };
      stopPolling();
      link = current;
      timer = setInterval(() => {
        poll(current).catch(() => undefined);
      }, opts.pollMs ?? POLL_EVERY_MS);
      return { url: current.url, expiresAt };
    } catch (err) {
      restoreKey(swap);
      throw err;
    }
  };

  return {
    start() {
      if (starting !== null) return starting;
      if (link?.state === 'pending') {
        if (opts.now() < link.expiresAt) return Promise.resolve({ url: link.url, expiresAt: link.expiresAt });
        settle(link, 'expired');
      }
      starting = begin().finally(() => {
        starting = null;
      });
      return starting;
    },
    status() {
      if (link === null) return { status: 'none', url: null, expiresAt: null };
      if (link.state === 'pending' && opts.now() >= link.expiresAt) settle(link, 'expired');
      return { status: link.state, url: link.url, expiresAt: link.expiresAt };
    },
    cancel() {
      const current = link;
      if (current === null) return;
      stopPolling();
      link = null;
      if (current.state === 'pending') restoreKey(current);
    },
    stop() {
      stopPolling();
      link = null;
    },
  };
}
