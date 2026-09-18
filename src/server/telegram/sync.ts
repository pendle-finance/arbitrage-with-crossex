import type { CrossexAccount, CrossexPosition } from '../../../web/src/api/types';
import { buildTriggerCoins, type TriggerCoin } from '../../core/alerts/triggers';
import type { Clients } from '../../core/clients';
import { computeExposure } from '../../core/positions';
import { TTL, type TtlCache } from '../cache';
import { BotAuthError, type BotClient } from './botClient';
import { readTelegramKey } from './keyFile';
import type { TelegramStatus } from './status';

const SYNC_EVERY_MS = 300_000;

export interface TelegramSync {
  start(): void;
  requestSync(reason: string): void;
  stop(): void;
}

export interface TelegramSyncOptions {
  dataDir: string;
  bot: BotClient;
  status: TelegramStatus;
  readCoins: () => Promise<TriggerCoin[]>;
  port: number;
  version: string;
  now: () => number;
  everyMs?: number;
}

export async function readTriggerCoins(deps: { cache: TtlCache; getClients: () => Clients }): Promise<TriggerCoin[]> {
  const crossEx = deps.getClients().crossEx;
  const [account, positions] = await Promise.all([
    deps.cache.get('account', TTL.live, async () => (await crossEx.getCrossexAccount()).body, { fresh: true }),
    deps.cache.get('positions', TTL.live, async () => (await crossEx.listCrossexPositions()).body, { fresh: true }),
  ]);
  return buildTriggerCoins(account.value as unknown as CrossexAccount, {
    positions: positions.value as unknown as CrossexPosition[],
    exposure: computeExposure(positions.value),
  });
}

export function createTelegramSync(opts: TelegramSyncOptions): TelegramSync {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  let stopped = false;

  const syncOnce = async (): Promise<void> => {
    try {
      const key = readTelegramKey(opts.dataDir);
      if (key === null) return;
      const coins = await opts.readCoins();
      const syncedAt = opts.now();
      const view = await opts.bot.putTriggers(key.key, {
        syncedAt: new Date(syncedAt).toISOString(),
        port: opts.port,
        version: opts.version,
        coins,
      });
      opts.status.setSynced(syncedAt, view.settings);
    } catch (err) {
      if (err instanceof BotAuthError) opts.status.setAuth(err.reason);
      opts.status.setSyncError(opts.now(), err instanceof Error ? err.message : String(err));
    }
  };

  const run = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void syncOnce().finally(() => {
      running = false;
      if (!again) return;
      again = false;
      run();
    });
  };

  return {
    start() {
      if (timer !== null || stopped) return;
      run();
      timer = setInterval(run, opts.everyMs ?? SYNC_EVERY_MS);
    },
    requestSync: run,
    stop() {
      stopped = true;
      again = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
