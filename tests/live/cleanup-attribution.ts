/**
 * Pure, importable attribution helpers extracted from cleanup.ts.
 *
 * cleanup.ts is a standalone tsx script that runs `main()` (and process.exit) on
 * import, so it can't be imported from a test. These helpers hold its decision
 * logic in ONE place — cleanup.ts imports them, and the unit tests import them
 * directly (see tests/unit/live-cleanup.test.ts).
 */
import type { CrossexOrder } from 'gate-api';
import type { Clients } from '../../src/core/clients';

/** State older than this is refused — inspect Gate manually instead of trusting it. */
export const MAX_STATE_AGE_MS = 24 * 60 * 60 * 1000;

/** createTime is a decimal string; Gate uses ms for CrossEx but be robust to s
 * (t < 1e12 ⇒ seconds ⇒ ×1000). Non-finite ⇒ 0. */
export function createTimeMs(o: CrossexOrder): number {
  const t = Number(o.createTime);
  if (!Number.isFinite(t)) return 0;
  return t < 1e12 ? t * 1000 : t;
}

/** Opening (non-reduce-only) orders on `symbol` created since the run started,
 * newest first. Server-side `from` narrows the page; client-side filter decides. */
export async function openingOrdersSince(
  clients: Clients,
  symbol: string,
  startedAtMs: number,
): Promise<CrossexOrder[]> {
  const from = Math.max(0, startedAtMs - 60_000);
  const { body } = await clients.crossEx.listCrossexHistoryOrders({ symbol, limit: 100, from });
  return (body ?? [])
    .filter((o) => createTimeMs(o) >= startedAtMs - 60_000)
    .filter((o) => String(o.reduceOnly ?? '').toLowerCase() !== 'true')
    .sort((a, b) => createTimeMs(b) - createTimeMs(a));
}

/** A position is attributable to the run iff the newest opening order since run
 * start carries the run's tag prefix. The tag prefix IS the attribution — nothing
 * else is ever closed. */
export function isAttributable(latest: CrossexOrder | undefined, tag: string): boolean {
  return Boolean(latest && String(latest.text ?? '').startsWith(tag));
}

/** True when the run-state file is older than MAX_STATE_AGE_MS (refuse to act). */
export function isStateStale(startedAtMs: number, now: number = Date.now()): boolean {
  return now - startedAtMs > MAX_STATE_AGE_MS;
}
