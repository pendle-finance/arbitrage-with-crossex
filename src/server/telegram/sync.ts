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
const ROLL_TARGET_TTL_MS = 60 * 60_000;
/** Reasons that ask the bot again for a wallet it last called unlinked. */
const RECHECK_REASONS = new Set(['settings', 'login', 'linked']);

/** A pair's targets as last probed, stamped when THAT probe ran: a pair
 * whose read failed keeps its older stamp, so its targets age out on their
 * own clock instead of being blanked or refreshed by a neighbour's probe. */
type StoredSignal = RollSignalInput & { at: number };

interface RollFile {
  at: number;
  /** The Boros wallet the signals were probed for, lower-cased; null when
   * unknown (a file written before the wallet was recorded). */
  wallet: string | null;
  signals: StoredSignal[];
}

export type RollSignalInput = TriggerRoll & {
  coin: string;
  /** The probe could not price this pair (a Boros 429, a book that did not
   * load). Its targets are unknown, not empty: keep the last ones. */
  unpriced?: boolean;
};

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
  probeRolls?: () => Promise<RollSignalInput[]>;
  wallet?: () => string | null;
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

function parseRollTargets(raw: unknown): TriggerRoll['targets'] {
  if (!Array.isArray(raw)) return [];
  const targets: TriggerRoll['targets'] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { maturity, apr, currentApr } = item as Record<string, unknown>;
    if (typeof maturity !== 'number' || !Number.isInteger(maturity)) continue;
    if (typeof apr !== 'number' || typeof currentApr !== 'number') continue;
    targets.push({ maturity, apr, currentApr });
  }
  return targets;
}

function parseRollSignals(raw: unknown, fileAt: number): StoredSignal[] | null {
  if (!Array.isArray(raw)) return null;
  const signals: StoredSignal[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { coin, longVenue, shortVenue, maturity, targets, at } = item as Record<string, unknown>;
    if (typeof coin !== 'string' || typeof longVenue !== 'string' || typeof shortVenue !== 'string') return null;
    if (typeof maturity !== 'number' || !Number.isInteger(maturity)) return null;
    signals.push({
      coin,
      longVenue,
      shortVenue,
      maturity,
      targets: parseRollTargets(targets),
      at: typeof at === 'number' && Number.isFinite(at) ? at : fileAt,
    });
  }
  return signals;
}

function parseRollFile(raw: unknown): RollFile | null {
  if (Array.isArray(raw)) {
    const signals = parseRollSignals(raw, 0);
    return signals && { at: 0, wallet: null, signals };
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { at, wallet, signals } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const parsed = parseRollSignals(signals, at);
  return parsed && { at, wallet: typeof wallet === 'string' ? wallet.toLowerCase() : null, signals: parsed };
}

const signalKey = (s: TriggerRoll & { coin: string }): string =>
  `${s.coin.toUpperCase()}:${s.longVenue}-${s.shortVenue}:${s.maturity}`;

function rollKeys(signals: RollSignalInput[]): Set<string> {
  const keys = new Set<string>();
  for (const signal of signals) {
    const coin = signal.coin.toUpperCase();
    keys.add(`${coin}:${signal.maturity}`);
    for (const target of signal.targets) {
      keys.add(`${coin}:${signal.longVenue}-${signal.shortVenue}:${signal.maturity}:${target.maturity}`);
    }
  }
  return keys;
}

export function createTelegramSync(opts: TelegramSyncOptions): TelegramSync {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  let againRecheck = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const rollPath = path.join(opts.dataDir, ROLL_FILE);
  const walletNow = (): string | null => opts.wallet?.()?.toLowerCase() ?? null;
  const stored = readOwnerJson(rollPath, parseRollFile);
  let rollSignals: StoredSignal[] = stored?.signals ?? [];
  // The wallet the stored signals belong to. A file from before the wallet
  // was recorded is trusted once; the next store stamps it.
  let rollWallet: string | null = stored?.wallet ?? walletNow();
  let rollKeySet = rollKeys(rollSignals);

  /** Signals probed for another wallet are that wallet's opportunities: a
   * login switch must not send them on for the new one. */
  const dropRollsOfOtherWallet = (): void => {
    const wallet = walletNow();
    if (wallet === rollWallet) return;
    rollWallet = wallet;
    rollSignals = [];
    rollKeySet = new Set();
    writeOwnerOnlyJson(rollPath, { at: opts.now(), wallet, signals: [] });
  };

  const rollsFor = (coin: string, at: number): TriggerRoll[] =>
    rollSignals
      .filter((s) => s.coin.toUpperCase() === coin.toUpperCase() && s.maturity * 1_000 > at)
      .slice(0, MAX_ROLLS_PER_COIN)
      .map((s) => ({
        longVenue: s.longVenue,
        shortVenue: s.shortVenue,
        maturity: s.maturity,
        targets: at - s.at <= ROLL_TARGET_TTL_MS ? s.targets : [],
      }));

  const storeRollSignals = (signals: RollSignalInput[]): boolean => {
    const at = opts.now();
    const previous = new Map(rollSignals.map((s) => [signalKey(s), s]));
    const next: StoredSignal[] = signals.map((s) => {
      const base = { coin: s.coin, longVenue: s.longVenue, shortVenue: s.shortVenue, maturity: s.maturity };
      // An unpriced pair keeps what it had, on its old stamp, so a read that
      // failed neither blanks a real target nor passes an old one off as new.
      const kept = s.unpriced ? previous.get(signalKey(s)) : undefined;
      return kept ? { ...base, targets: kept.targets, at: kept.at } : { ...base, targets: s.unpriced ? [] : s.targets, at };
    });
    const keys = rollKeys(next);
    const gained = [...keys].some((key) => !rollKeySet.has(key));
    rollSignals = next;
    rollKeySet = keys;
    writeOwnerOnlyJson(rollPath, { at, wallet: rollWallet, signals: next });
    return gained;
  };

  const probeRolls = async (): Promise<void> => {
    if (!opts.probeRolls) return;
    try {
      storeRollSignals(await opts.probeRolls());
    } catch (err) {
      console.warn(`Roll probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const syncOnce = async (recheck: boolean): Promise<void> => {
    const key = readTelegramKey(opts.dataDir);
    if (key === null) return;
    const keyKept = (): boolean => readTelegramKey(opts.dataDir)?.keyHash === key.keyHash;
    const wallet = opts.wallet?.()?.toLowerCase() ?? null;
    const unlinked = opts.status.unlinkedWallet;
    if (unlinked !== null && unlinked === wallet && !recheck) return;
    if (unlinked !== null && unlinked !== wallet) opts.status.setUnlinkedWallet(null);
    try {
      const coins = await opts.readCoins();
      dropRollsOfOtherWallet();
      await probeRolls();
      const syncedAt = opts.now();
      const reply = await opts.bot.putTriggers(key.key, {
        syncedAt: new Date(syncedAt).toISOString(),
        port: opts.port,
        version: opts.version,
        coins: coins.map((coin) => ({ ...coin, rolls: rollsFor(coin.coin, syncedAt) })),
      });
      if (keyKept()) opts.status.setSynced(syncedAt, reply.settings, reply.wallet ?? wallet);
    } catch (err) {
      if (!keyKept()) return;
      if (err instanceof BotAuthError && err.reason === 'wallet-unlinked' && wallet !== null) {
        opts.status.setUnlinkedWallet(wallet);
        return;
      }
      if (err instanceof BotAuthError) opts.status.setAuth(err.reason);
      opts.status.setSyncError(opts.now(), err instanceof Error ? err.message : String(err));
    }
  };

  const run = (recheck = false): void => {
    if (stopped) return;
    if (running) {
      again = true;
      againRecheck ||= recheck;
      return;
    }
    running = true;
    inFlight = syncOnce(recheck).finally(() => {
      running = false;
      if (!again) return;
      const next = againRecheck;
      again = false;
      againRecheck = false;
      run(next);
    });
  };

  return {
    start() {
      if (timer !== null || stopped) return;
      run();
      timer = setInterval(() => run(), opts.everyMs ?? SYNC_EVERY_MS);
    },
    requestSync: (reason) => run(RECHECK_REASONS.has(reason)),
    setRollSignals(signals) {
      dropRollsOfOtherWallet();
      if (storeRollSignals(signals)) run();
    },
    idle: () => inFlight,
    stop() {
      stopped = true;
      again = false;
      againRecheck = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
