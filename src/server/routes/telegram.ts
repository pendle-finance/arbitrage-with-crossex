import type { FastifyInstance } from 'fastify';
import type { TelegramInfo } from '../../../web/src/api/types';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { refuse } from '../errorReply';
import { BotAuthError, type TelegramSettings } from '../telegram/botClient';
import { deleteTelegramKey, readTelegramKey } from '../telegram/keyFile';
import type { TelegramAuth } from '../telegram/status';

const BOT_NOT_AVAILABLE = 'Telegram alerts are not available yet. Try again later.';
const BOT_SILENT = 'The Telegram bot did not answer. Try again later.';
const NOT_CONNECTED = 'This terminal is not connected to Telegram alerts.';
const SETTING_NAMES = ['liquidation', 'interest'] as const;

type Telegram = NonNullable<AppDeps['telegram']>;

function stateOf(hasKey: boolean, linkPending: boolean, auth: TelegramAuth | null): TelegramInfo['state'] {
  if (!hasKey || linkPending || auth === 'pending') return 'none';
  if (auth === 'replaced') return 'replaced';
  if (auth === 'removed' || auth === 'unknown') return 'removed';
  return 'connected';
}

function parseSettings(body: unknown): Partial<TelegramSettings> {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const settings: Partial<TelegramSettings> = {};
  for (const name of SETTING_NAMES) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new CoreError(`${name} must be true or false`, 'validation');
    settings[name] = value;
  }
  if (Object.keys(settings).length === 0) {
    throw new CoreError('Send liquidation or interest as true or false.', 'validation');
  }
  return settings;
}

export function telegramRoutes(deps: AppDeps) {
  const telegram = (): Telegram => {
    if (!deps.telegram) throw new CoreError('Telegram alerts are not set up on this server.', 'not-configured');
    return deps.telegram;
  };

  const info = (t: Telegram): TelegramInfo => {
    const hasKey = readTelegramKey(deps.dataDir) !== null;
    const state = stateOf(hasKey, t.link.status().status === 'pending', t.status.auth);
    if (!hasKey) return { connected: false, state, settings: null, lastSyncAt: null, lastSyncError: null };
    return {
      connected: state === 'connected',
      state,
      settings: state === 'connected' ? t.status.settings : null,
      lastSyncAt: t.status.lastSyncAt,
      lastSyncError: t.status.lastSyncError,
    };
  };

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/telegram', async (_req, reply) => reply.ok(info(telegram())));

    app.post('/telegram/link', async (_req, reply) => {
      const t = telegram();
      try {
        return reply.ok(await t.link.start());
      } catch {
        return refuse(reply, 503, 'network', BOT_NOT_AVAILABLE, true);
      }
    });

    app.get('/telegram/link', async (_req, reply) => reply.ok(telegram().link.status()));

    app.patch('/telegram/settings', async (req, reply) => {
      const t = telegram();
      const settings = parseSettings(req.body);
      const key = readTelegramKey(deps.dataDir);
      if (key === null) return refuse(reply, 409, 'validation', NOT_CONNECTED, false);
      try {
        const view = await t.bot.patchSettings(key.key, settings);
        t.status.setSettings(view.settings);
      } catch (err) {
        if (!(err instanceof BotAuthError)) return refuse(reply, 503, 'network', BOT_SILENT, true);
        t.status.setAuth(err.reason);
        return refuse(reply, 409, 'validation', NOT_CONNECTED, false);
      }
      return reply.ok(info(t));
    });

    app.delete('/telegram', async (_req, reply) => {
      const t = telegram();
      t.link.stop();
      const key = readTelegramKey(deps.dataDir);
      if (key !== null) await t.bot.deleteTerminal(key.key).catch(() => undefined);
      deleteTelegramKey(deps.dataDir);
      t.status.setAuth(null);
      t.status.setSettings(null);
      return reply.ok(info(t));
    });
  };
}
