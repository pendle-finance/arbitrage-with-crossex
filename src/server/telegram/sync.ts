import * as path from 'node:path';
import type { CrossexAccount, CrossexPosition } from '../../../web/src/api/types';
import { buildTriggerCoins, type TriggerCoin, type TriggerRoll } from '../../core/alerts/triggers';
import type { Clients } from '../../core/clients';
import { computeExposure } from '../../core/positions';
import { TTL, type TtlCache } from '../cache';
import { marginTiersFor } from '../routes/positions';
import { readOwnerJson, writeOwnerOnlyJson } from '../secretFile';
import { BotAuthError, type BotClient } from './botClient';
import { readTelegramKey } from './keyFile';
import type { TelegramStatus } from './status';

const SYNC_EVERY_MS = 300_000;
const ROLL_FILE = 'roll-signals.json';
const MAX_ROLLS_PER_COIN = 16;

export type RollSignalInput = TriggerRoll & { coin: string };

export interface TelegramSync {
  start(): void;
  requestSync(reason: string): void;
  setRollSignals(signals: RollSignalInput[]): void;
  idle(): Promise<void>;
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
  const rows = positions.value as unknown as CrossexPosition[];
  const tiers = await marginTiersFor(
    deps.cache,
    rows.map((p) => p.symbol),
    false,
  );
  return buildTriggerCoins(
    account.value as unknown as CrossexAccount,
    { positions: rows, exposure: computeExposure(positions.value) },
    tiers,
  );
}

function parseRollTarget(raw: unknown): TriggerRoll['to'] {
  if (typeof raw !== 'object' || raw === null) return null;
  const { maturity, apr, currentApr } = raw as Record<string, unknown>;
  if (typeof maturity !== 'number' || !Number.isInteger(maturity)) return null;
  if (typeof apr !== 'number' || typeof currentApr !== 'number') return null;
  return { maturity, apr, currentApr };
}

function parseRollSignals(raw: unknown): RollSignalInput[] | null {
  if (!Array.isArray(raw)) return null;
  const signals: RollSignalInput[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { coin, longVenue, shortVenue, maturity, to } = item as Record<string, unknown>;
    if (typeof coin !== 'string' || typeof longVenue !== 'string' || typeof shortVenue !== 'string') return null;
    if (typeof maturity !== 'number' || !Number.isInteger(maturity)) return null;
    signals.push({ coin, longVenue, shortVenue, maturity, to: parseRollTarget(to) });
  }
  return signals;
}

function rollKeys(signals: RollSignalInput[]): Set<string> {
  const keys = new Set<string>();
  for (const signal of signals) {
    const coin = signal.coin.toUpperCase();
    keys.add(`${coin}:${signal.maturity}`);
    if (signal.to === null) continue;
    keys.add(`${coin}:${signal.longVenue}-${signal.shortVenue}:${signal.maturity}:${signal.to.maturity}`);
  }
  return keys;
}

export function createTelegramSync(opts: TelegramSyncOptions): TelegramSync {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const rollPath = path.join(opts.dataDir, ROLL_FILE);
  let rollSignals: RollSignalInput[] = readOwnerJson(rollPath, parseRollSignals) ?? [];
  let rollKeySet = rollKeys(rollSignals);

  const rollsFor = (coin: string, at: number): TriggerRoll[] =>
    rollSignals
      .filter((s) => s.coin.toUpperCase() === coin.toUpperCase() && s.maturity * 1_000 > at)
      .slice(0, MAX_ROLLS_PER_COIN)
      .map((s) => ({ longVenue: s.longVenue, shortVenue: s.shortVenue, maturity: s.maturity, to: s.to }));

  const syncOnce = async (): Promise<void> => {
    const key = readTelegramKey(opts.dataDir);
    if (key === null) return;
    const keyKept = (): boolean => readTelegramKey(opts.dataDir)?.keyHash === key.keyHash;
    try {
      const coins = await opts.readCoins();
      const syncedAt = opts.now();
      const settings = await opts.bot.putTriggers(key.key, {
        syncedAt: new Date(syncedAt).toISOString(),
        port: opts.port,
        version: opts.version,
        coins: coins.map((coin) => ({ ...coin, rolls: rollsFor(coin.coin, syncedAt) })),
      });
      if (keyKept()) opts.status.setSynced(syncedAt, settings);
    } catch (err) {
      if (!keyKept()) return;
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
    inFlight = syncOnce().finally(() => {
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
    setRollSignals(signals) {
      const next = signals.map((s) => ({
        coin: s.coin,
        longVenue: s.longVenue,
        shortVenue: s.shortVenue,
        maturity: s.maturity,
        to: s.to,
      }));
      const keys = rollKeys(next);
      const gained = [...keys].some((key) => !rollKeySet.has(key));
      const changed = JSON.stringify(next) !== JSON.stringify(rollSignals);
      rollSignals = next;
      rollKeySet = keys;
      if (changed) writeOwnerOnlyJson(rollPath, next);
      if (gained) run();
    },
    idle: () => inFlight,
    stop() {
      stopped = true;
      again = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
