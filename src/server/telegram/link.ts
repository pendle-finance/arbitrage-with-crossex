import type { TelegramLinkStart, TelegramLinkStatus } from '../../../web/src/api/types';
import { BotAuthError, BotUnavailableError, type BotClient } from './botClient';
import { deleteTelegramKey, newTelegramKey, readTelegramKey, writeTelegramKey, type TelegramKey } from './keyFile';

const POLL_EVERY_MS = 5_000;

export interface TelegramLink {
  start(): Promise<TelegramLinkStart>;
  status(): TelegramLinkStatus;
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
  key: TelegramKey;
  previous: TelegramKey | null;
}

interface PendingLink extends KeySwap {
  url: string;
  expiresAt: number;
  state: 'pending' | 'confirmed' | 'expired';
  polling: boolean;
}

export function createTelegramLink(opts: TelegramLinkOptions): TelegramLink {
  let link: PendingLink | null = null;
  let starting: Promise<TelegramLinkStart> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopPolling = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const restoreKey = (swap: KeySwap): void => {
    if (readTelegramKey(opts.dataDir)?.keyHash !== swap.key.keyHash) return;
    if (swap.previous === null) {
      deleteTelegramKey(opts.dataDir);
      return;
    }
    writeTelegramKey(opts.dataDir, swap.previous);
  };

  const settle = (current: PendingLink, state: 'confirmed' | 'expired'): void => {
    if (link !== current || current.state !== 'pending') return;
    current.state = state;
    stopPolling();
    if (state === 'expired') {
      restoreKey(current);
      return;
    }
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
    const swap: KeySwap = { key: newTelegramKey(opts.now()), previous: readTelegramKey(opts.dataDir) };
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
    stop() {
      stopPolling();
      link = null;
    },
  };
}
