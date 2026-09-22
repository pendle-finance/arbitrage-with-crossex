import type { FastifyInstance } from 'fastify';
import type { TelegramInfo } from '../../../web/src/api/types';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { refuse } from '../errorReply';
import { BotAuthError, botBaseUrl, type TelegramSettings } from '../telegram/botClient';
import { deleteTelegramKey, readTelegramKey } from '../telegram/keyFile';
import type { TelegramAuth } from '../telegram/status';
import type { RollSignalInput } from '../telegram/sync';

const BOT_NOT_AVAILABLE = 'Telegram alerts are not available yet. Try again later.';
const BOT_SILENT = 'The Telegram bot did not answer. Try again later.';
const NOT_CONNECTED = 'This terminal is not connected to Telegram alerts. Click Set up to connect it.';
const BOT_UNREACHABLE = 'Could not reach the bot. Try again, or remove this terminal on the Boros alerts page.';
const SETTING_NAMES = ['liquidation', 'interest', 'maturity', 'rollover'] as const;
const FIRST_SYNC_WAIT_MS = 5_000;
const MAX_ROLL_SIGNALS = 64;

type Telegram = NonNullable<AppDeps['telegram']>;

function stateOf(hasKey: boolean, linkPending: boolean, auth: TelegramAuth | null): TelegramInfo['state'] {
  if (!hasKey || linkPending || auth === 'pending') return 'none';
  if (auth === 'replaced') return 'replaced';
  if (auth === 'removed') return 'removed';
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
    throw new CoreError('Send liquidation, interest, maturity or rollover as true or false.', 'validation');
  }
  return settings;
}

const TARGETS_MAX = 8;

function parseRollTargets(raw: unknown, maturity: number): RollSignalInput['targets'] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new CoreError('targets must be a list.', 'validation');
  if (raw.length > TARGETS_MAX) throw new CoreError(`targets holds at most ${TARGETS_MAX} maturities.`, 'validation');
  const seen = new Set<number>();
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) throw new CoreError('Every target must be an object.', 'validation');
    const { maturity: to, apr, currentApr } = item as Record<string, unknown>;
    if (typeof to !== 'number' || !Number.isInteger(to) || to <= maturity) {
      throw new CoreError('targets[].maturity must be a whole number of seconds after maturity.', 'validation');
    }
    if (seen.has(to)) throw new CoreError('targets lists one maturity twice.', 'validation');
    seen.add(to);
    if (!Number.isFinite(apr) || !Number.isFinite(currentApr)) {
      throw new CoreError('targets[].apr and targets[].currentApr must be numbers.', 'validation');
    }
    return { maturity: to, apr: apr as number, currentApr: currentApr as number };
  });
}

function parseRollSignal(raw: unknown): RollSignalInput {
  if (typeof raw !== 'object' || raw === null) throw new CoreError('Every roll signal must be an object.', 'validation');
  const { coin, longVenue, shortVenue, maturity, targets } = raw as Record<string, unknown>;
  const names = [coin, longVenue, shortVenue];
  if (names.some((name) => typeof name !== 'string' || name.trim() === '')) {
    throw new CoreError('Every roll signal needs a coin, a longVenue and a shortVenue.', 'validation');
  }
  if (typeof maturity !== 'number' || !Number.isInteger(maturity) || maturity <= 0) {
    throw new CoreError('maturity must be a whole number of seconds.', 'validation');
  }
  return {
    coin: coin as string,
    longVenue: (longVenue as string).toUpperCase(),
    shortVenue: (shortVenue as string).toUpperCase(),
    maturity,
    targets: parseRollTargets(targets, maturity),
  };
}

function parseRollSignals(body: unknown): RollSignalInput[] {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).signals : undefined;
  if (!Array.isArray(raw)) throw new CoreError('Send signals as a list.', 'validation');
  if (raw.length > MAX_ROLL_SIGNALS) {
    throw new CoreError(`Send at most ${MAX_ROLL_SIGNALS} roll signals.`, 'validation');
  }
  return raw.map(parseRollSignal);
}

export function telegramRoutes(deps: AppDeps) {
  const telegram = (): Telegram => {
    if (!deps.telegram) throw new CoreError('Telegram alerts are not set up on this server.', 'not-configured');
    return deps.telegram;
  };

  const hasKey = (t: Telegram): boolean => {
    const check = t.link.checking();
    return check === null ? readTelegramKey(deps.dataDir) !== null : check.hadKey;
  };

  const awaitFirstSync = async (t: Telegram): Promise<void> => {
    if (t.status.auth !== null || t.status.lastSyncError !== null || !hasKey(t)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_SYNC_WAIT_MS);
    });
    await Promise.race([t.sync.idle(), cap]);
    clearTimeout(timer);
  };

  const info = (t: Telegram): TelegramInfo => {
    const linkPending = t.link.status().status === 'pending';
    const keyed = hasKey(t);
    const state = stateOf(keyed, linkPending, t.status.auth);
    const alertsPageUrl = `${botBaseUrl(process.env)}/alerts`;
    if (!keyed) return { connected: false, state, settings: null, lastSyncAt: null, lastSyncError: null, alertsPageUrl };
    return {
      connected: state === 'connected',
      state,
      settings: state === 'connected' ? t.status.settings : null,
      lastSyncAt: t.status.lastSyncAt,
      lastSyncError: t.status.lastSyncError,
      alertsPageUrl,
    };
  };

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/telegram', async (_req, reply) => {
      const t = telegram();
      await awaitFirstSync(t);
      return reply.ok(info(t));
    });

    app.post('/telegram/link', async (_req, reply) => {
      const t = telegram();
      try {
        return reply.ok(await t.link.start());
      } catch {
        return refuse(reply, { code: 503, category: 'network', message: BOT_NOT_AVAILABLE, retryable: true });
      }
    });

    app.get('/telegram/link', async (_req, reply) => reply.ok(telegram().link.status()));

    app.delete('/telegram/link', async (_req, reply) => {
      const t = telegram();
      await t.link.cancel();
      return reply.ok(t.link.status());
    });

    app.patch('/telegram/settings', async (req, reply) => {
      const t = telegram();
      const settings = parseSettings(req.body);
      const key = readTelegramKey(deps.dataDir);
      if (key === null) return refuse(reply, {
        code: 409,
        category: 'validation',
        message: NOT_CONNECTED,
        retryable: false,
      });
      try {
        t.status.setSettings(await t.bot.patchSettings(key.key, settings));
      } catch (err) {
        if (!(err instanceof BotAuthError)) return refuse(reply, {
          code: 503,
          category: 'network',
          message: BOT_SILENT,
          retryable: true,
        });
        t.status.setAuth(err.reason);
        return refuse(reply, { code: 409, category: 'validation', message: NOT_CONNECTED, retryable: false });
      }
      return reply.ok(info(t));
    });

    app.put('/telegram/roll-signals', async (req, reply) => {
      const t = telegram();
      const signals = parseRollSignals(req.body);
      t.sync.setRollSignals(signals);
      return reply.ok({ stored: signals.length });
    });

    app.delete('/telegram', async (_req, reply) => {
      const t = telegram();
      t.link.stop();
      await t.link.settled();
      const key = readTelegramKey(deps.dataDir);
      if (key !== null) {
        try {
          await t.bot.deleteTerminal(key.key);
        } catch (err) {
          if (!(err instanceof BotAuthError)) return refuse(reply, {
            code: 503,
            category: 'network',
            message: BOT_UNREACHABLE,
            retryable: true,
          });
        }
      }
      deleteTelegramKey(deps.dataDir);
      t.status.setAuth(null);
      t.status.setSettings(null);
      return reply.ok(info(t));
    });
  };
}
