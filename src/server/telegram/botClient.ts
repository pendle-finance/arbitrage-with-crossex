import type { TriggerCoin } from '../../core/alerts/triggers';
import type { FetchLike } from '../../core/boros/client';

const DEFAULT_BOT_URL = 'https://boros-bot-notification.pendle.finance';
const BOT_PATH = '/noti/boros/crossex';
const BOT_TIMEOUT_MS = 5_000;
const AUTH_REASONS = ['pending', 'replaced', 'removed', 'wallet-unlinked', 'unknown'] as const;

export type BotAuthReason = (typeof AUTH_REASONS)[number];

export interface TelegramSettings {
  liquidation: boolean;
  interest: boolean;
  maturity: boolean;
  rollover: boolean;
}

export interface TerminalView {
  wallet: string;
  version: string;
  connectedAt: string;
  lastSyncAt: string | null;
  port: number | null;
  settings: TelegramSettings;
  coins: Array<TriggerCoin & { priceNow: number | null }>;
  active: boolean;
  alertTo: string | null;
}

export interface TriggerSync {
  syncedAt: string;
  port: number;
  version: string;
  coins: TriggerCoin[];
}

export interface BotClient {
  /** The bot links the code only for the wallet on screen, so the link names it. */
  requestLink(body: { keyHash: string; version: string }, key?: string): Promise<{ code: string; expiresAt: string }>;
  getTerminal(key: string): Promise<void>;
  /** `wallet` is the wallet the bot sends alerts for, when its reply names one. */
  putTriggers(key: string, body: TriggerSync): Promise<{ settings: TelegramSettings; wallet: string | null }>;
  patchSettings(key: string, body: Partial<TelegramSettings>): Promise<TelegramSettings>;
  deleteTerminal(key: string): Promise<void>;
}

/** How a bot without the link wallet check refuses the field (Nest's whitelist). */
const OLD_BOT_NO_WALLET = /property wallet should not exist/;

export class BotAuthError extends Error {
  constructor(readonly reason: BotAuthReason) {
    super(`The Telegram bot refused this terminal's key (${reason}).`);
    this.name = 'BotAuthError';
  }
}

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotUnavailableError';
  }
}

export function botBaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.CROSSEX_BOT_URL?.trim();
  return (url ? url : DEFAULT_BOT_URL).replace(/\/+$/, '');
}

function reasonOf(body: unknown): BotAuthReason {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return AUTH_REASONS.find((r) => r === reason) ?? 'unknown';
}

function messageOf(body: unknown, status: number): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return `The Telegram bot answered ${status}.`;
}

type SettingsBody = { liquidation?: unknown; interest?: unknown; maturity?: unknown; rollover?: unknown };

const flagOf = (value: unknown): boolean => (typeof value === 'boolean' ? value : false);

function settingsOf(body: unknown): TelegramSettings {
  const settings = (body as { settings?: SettingsBody } | null)?.settings;
  if (typeof settings?.liquidation !== 'boolean' || typeof settings.interest !== 'boolean') {
    throw new BotUnavailableError('The Telegram bot answered with no alert settings.');
  }
  return {
    liquidation: settings.liquidation,
    interest: settings.interest,
    maturity: flagOf(settings.maturity),
    rollover: flagOf(settings.rollover),
  };
}

function walletOf(body: unknown): string | null {
  const wallet = (body as { wallet?: unknown } | null)?.wallet;
  return typeof wallet === 'string' && wallet !== '' ? wallet.toLowerCase() : null;
}

export interface BotClientOptions {
  baseUrl: string;
  fetchImpl: FetchLike;
  wallet?: () => string | null;
}

export function createBotClient(opts: BotClientOptions): BotClient {
  type Init = { key?: string; body?: unknown; withoutWallet?: boolean };
  const call = async (method: string, route: string, init: Init = {}): Promise<unknown> => {
    const headers: Record<string, string> = {};
    if (init.key !== undefined) {
      headers['x-terminal-key'] = init.key;
      const wallet = init.withoutWallet ? null : (opts.wallet?.() ?? null);
      if (wallet !== null) headers['x-terminal-wallet'] = wallet.toLowerCase();
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await opts.fetchImpl(`${opts.baseUrl}${BOT_PATH}${route}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BotUnavailableError(`The Telegram bot did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 500) throw new BotUnavailableError(`The Telegram bot answered ${res.status}.`);
    const body = await res.json().catch(() => null);
    if (res.status === 401) throw new BotAuthError(reasonOf(body));
    if (!res.ok) throw new Error(messageOf(body, res.status));
    return body;
  };

  return {
    async requestLink(body, key) {
      const wallet = opts.wallet?.() ?? null;
      const send = (withWallet: boolean) =>
        call('POST', '/link-requests', {
          body: withWallet && wallet !== null ? { ...body, wallet: wallet.toLowerCase() } : body,
          key,
          withoutWallet: true,
        });
      // A bot older than the wallet check refuses the unknown field. Linking
      // without it still works there; that bot just does not check the wallet.
      const answer = await send(true).catch((err: unknown) => {
        if (wallet !== null && err instanceof Error && OLD_BOT_NO_WALLET.test(err.message)) return send(false);
        throw err;
      });
      const link = answer as { code?: unknown; expiresAt?: unknown } | null;
      if (typeof link?.code !== 'string' || typeof link.expiresAt !== 'string') {
        throw new BotUnavailableError('The Telegram bot answered a link request with no code.');
      }
      return { code: link.code, expiresAt: link.expiresAt };
    },
    async getTerminal(key) {
      await call('GET', '/terminal', { key });
    },
    async putTriggers(key, body) {
      const reply = await call('PUT', '/terminal/triggers', { key, body });
      return { settings: settingsOf(reply), wallet: walletOf(reply) };
    },
    async patchSettings(key, body) {
      return settingsOf(await call('PATCH', '/terminal/settings', { key, body }));
    },
    async deleteTerminal(key) {
      try {
        await call('DELETE', '/terminal', { key });
      } catch (err) {
        if (!(err instanceof BotAuthError) || err.reason !== 'wallet-unlinked') throw err;
        await call('DELETE', '/terminal', { key, withoutWallet: true });
      }
    },
  };
}
