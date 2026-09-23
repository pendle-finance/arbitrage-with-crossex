import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TelegramLinkStart, TelegramLinkStatus } from '../../../web/src/api/types';
import { readOwnerJson, writeOwnerOnlyJson } from '../secretFile';
import { BotAuthError, BotUnavailableError, type BotClient } from './botClient';
import { deleteTelegramKey, newTelegramKey, readTelegramKey, writeTelegramKey, type TelegramKey } from './keyFile';
import type { TelegramStatus } from './status';

const POLL_EVERY_MS = 5_000;
const SWAP_FILE = 'telegram-link';

export interface TelegramLink {
  start(options?: { addWallet?: boolean }): Promise<TelegramLinkStart>;
  status(): TelegramLinkStatus;
  checking(): { hadKey: boolean } | null;
  cancel(): Promise<void>;
  settled(): Promise<void>;
  stop(): void;
}

export interface TelegramLinkOptions {
  dataDir: string;
  bot: BotClient;
  pageUrl: string;
  version: string;
  now: () => number;
  status: TelegramStatus;
  onConfirmed: () => void;
  onRestored?: () => void;
  pollMs?: number;
}

interface KeySwap {
  key: Pick<TelegramKey, 'keyHash'>;
  previous: TelegramKey | null;
  previousStatus?: Pick<TelegramStatus, 'auth' | 'lastSyncError'>;
}

interface PendingLink extends KeySwap {
  key: TelegramKey;
  adding: boolean;
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
  let unsettled: KeySwap | null = null;
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
    if (swap.previousStatus === undefined) return;
    opts.status.setAuth(swap.previousStatus.auth);
    opts.status.lastSyncError = swap.previousStatus.lastSyncError;
    opts.onRestored?.();
  };

  const keepIfConfirmed = async (swap: KeySwap): Promise<void> => {
    const key = readTelegramKey(opts.dataDir);
    const confirmed =
      key !== null &&
      key.keyHash === swap.key.keyHash &&
      (await opts.bot.getTerminal(key.key).then(
        () => true,
        (err: unknown) => err instanceof BotAuthError && err.reason === 'wallet-unlinked',
      ));
    if (!confirmed) {
      restoreKey(swap);
      return;
    }
    fs.rmSync(swapFile, { force: true });
    opts.onConfirmed();
  };

  const check = (swap: KeySwap, after: Promise<void>): Promise<void> => {
    unsettled = swap;
    return after
      .then(() => keepIfConfirmed(swap))
      .catch(() => undefined)
      .finally(() => {
        if (unsettled === swap) unsettled = null;
      });
  };

  const unconfirmed = readOwnerJson(swapFile, parseSwap);
  let settling: Promise<void> = unconfirmed === null ? Promise.resolve() : check(unconfirmed, Promise.resolve());

  const settle = (current: PendingLink, state: 'confirmed' | 'expired'): void => {
    if (link !== current || current.state !== 'pending') return;
    current.state = state;
    stopPolling();
    if (state === 'expired') {
      if (!current.adding) restoreKey(current);
      return;
    }
    if (current.adding) opts.status.setUnlinkedWallet(null);
    else fs.rmSync(swapFile, { force: true });
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
      if (!(err instanceof BotAuthError) || err.reason === 'pending') return;
      if (err.reason !== 'wallet-unlinked') settle(current, 'expired');
      else if (!current.adding) settle(current, 'confirmed');
    } finally {
      current.polling = false;
    }
  };

  const follow = (
    pending: Pick<PendingLink, 'key' | 'previous' | 'previousStatus' | 'adding'>,
    answer: { code: string; expiresAt: string },
  ): TelegramLinkStart => {
    const expiresAt = Date.parse(answer.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new BotUnavailableError('The Telegram bot answered a link request with no expiry.');
    }
    const current: PendingLink = {
      ...pending,
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
  };

  const begin = async (addWallet: boolean): Promise<TelegramLinkStart> => {
    const existing = addWallet ? readTelegramKey(opts.dataDir) : null;
    if (existing !== null) {
      const answer = await opts.bot.requestLink({ keyHash: existing.keyHash, version: opts.version }, existing.key);
      return follow({ key: existing, previous: existing, adding: true }, answer);
    }
    const swap = {
      key: newTelegramKey(opts.now()),
      previous: readTelegramKey(opts.dataDir),
      previousStatus: { auth: opts.status.auth, lastSyncError: opts.status.lastSyncError },
    };
    writeOwnerOnlyJson(swapFile, { key: { keyHash: swap.key.keyHash }, previous: swap.previous });
    writeTelegramKey(opts.dataDir, swap.key);
    try {
      const answer = await opts.bot.requestLink({ keyHash: swap.key.keyHash, version: opts.version });
      return follow({ ...swap, adding: false }, answer);
    } catch (err) {
      restoreKey(swap);
      throw err;
    }
  };

  return {
    start(options) {
      if (starting !== null) return starting;
      if (link?.state === 'pending') {
        if (opts.now() < link.expiresAt) return Promise.resolve({ url: link.url, expiresAt: link.expiresAt });
        settle(link, 'expired');
      }
      starting = settling.then(() => begin(options?.addWallet === true)).finally(() => {
        starting = null;
      });
      return starting;
    },
    status() {
      if (link === null) return { status: 'none', url: null, expiresAt: null };
      if (link.state === 'pending' && opts.now() >= link.expiresAt) settle(link, 'expired');
      return { status: link.state, url: link.url, expiresAt: link.expiresAt };
    },
    checking() {
      return unsettled === null ? null : { hadKey: unsettled.previous !== null };
    },
    cancel() {
      const current = link;
      if (current === null) return settling;
      stopPolling();
      link = null;
      if (current.state === 'pending' && !current.adding) settling = check(current, settling);
      return settling;
    },
    settled() {
      return settling;
    },
    stop() {
      stopPolling();
      link = null;
    },
  };
}
