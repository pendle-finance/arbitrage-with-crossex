/**
 * In-memory TTL cache for Gate reads. Coalesces concurrent callers onto one
 * inflight fetch, and on a 429 enters a short PER-KEY cooldown during which cached
 * values (even expired) are served as `stale` instead of hammering the API again.
 * A `fresh` request bypasses both the TTL and the cooldown (it still rides an
 * inflight fetch and still degrades to stale if its own fetch 429s). Entry count is
 * LRU-capped so a long-running server with high-cardinality keys can't leak memory.
 * Uses Date.now() directly so tests can drive it with fake time.
 */
import { classifyGateError } from '../core/errors';

interface Entry {
  value?: unknown;
  /** Only meaningful once a fetch has succeeded (`has` true). */
  expiresAt: number;
  has: boolean;
  /** Per-key rate-limit cooldown — a 429 on one key must not stall unrelated keys. */
  cooldownUntil: number;
  inflight?: Promise<unknown>;
}

const COOLDOWN_MS = 2000;
const MAX_ENTRIES = 500;

/** Cache TTLs per data class — the single source of truth for how long each Gate
 * read is reused. Live account state is short; static rule/fee data is long. */
export const TTL = {
  /** Account, positions, open orders — fast-moving live state. */
  live: 2_000,
  /** Recent trades. */
  trades: 5_000,
  /** History-orders page used only to label trades. */
  historyOrders: 30_000,
  /** Boros backend reads (markets, collaterals, txn history) — settlement
   * cadence is hourly at the fastest; 30s keeps the card feeling live. */
  boros: 30_000,
  /** Boros order books — the levels the scan's DISPLAYED quote walks. Nothing
   * places an order off THIS key (the two-leg Boros panel has its own,
   * `borosBookTrade`; the CrossEx engine never reads Boros books at all, and settlement
   * cadence on Boros is hourly). At 5s this was ~97% of all Boros traffic: the
   * dashboard polls every 12s, so every poll re-fetched every mapped market's
   * book (25 books × 300 polls ≈ 7.5k req/h from one open tab, measured
   * 2026-07-29). Books now ride the same 30s cadence as every other Boros
   * read; a scan quote up to ~30s old ranks identically. */
  borosBook: 30_000,
  /** Boros books that back an ORDER rather than a displayed quote — the
   * two-leg market panel's simulate/execute path. `borosBook`'s 30s is chosen
   * for a scan whose quote "up to ~30s old ranks identically"; that reasoning
   * does not survive contact with a market order, where a 30s-old book sets
   * the rate bound the order actually carries. Deliberately its own key, so
   * the scan can never serve this path a stale entry (or vice versa). Kept
   * comfortably under `SIMULATION_MAX_AGE_MS`, which refuses a confirm behind
   * a quote older than 12s. */
  borosBookTrade: 3_000,
  /** Public venue-book touch for the re-peg UI — price display, not a feed. */
  book: 2_000,
  /** Fee rates, symbol rules, risk limits — effectively static. */
  static: 600_000,
  /** Executed fills, read to split a shared venue leg between strategies. A
   * past fill never changes and a new one only matters once its position
   * shows up, so re-paginating this on the 30s strategy poll is pure waste —
   * at 10 pages a tick it is also the fastest way into a 429 cooldown. */
  fills: 300_000,
  /** GitHub version.json update check — hours, not minutes: releases are
   * hand-bumped and rare, and a FAILED fetch is cached as null for the same
   * window (one quiet retry per window, silent by design). */
  version: 21_600_000,
  /** Short-link creation for the share modal. The backend is idempotent per
   * payload (content-addressed), so reopening the modal within the window
   * reuses the code without another round-trip. */
  shareLink: 300_000,
} as const;

export class TtlCache {
  private entries = new Map<string, Entry>();

  async get<T>(
    key: string,
    ttlMs: number,
    fetch: () => Promise<T>,
    opts?: { fresh?: boolean },
  ): Promise<{ value: T; stale: boolean }> {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (entry?.has && !opts?.fresh && now < entry.expiresAt) {
      this.touch(key, entry);
      return { value: entry.value as T, stale: false };
    }
    // Rate-limit cooldown (per key): serve whatever we have rather than refetch.
    // A `fresh` request bypasses this and attempts a live read anyway.
    if (entry?.has && !opts?.fresh && now < entry.cooldownUntil) {
      return { value: entry.value as T, stale: true };
    }
    // `fresh` bypasses the TTL/cooldown but still rides an already-inflight fetch —
    // and degrades like the primary caller if that shared fetch 429s (fix: a waiter
    // must not get a raw 429 thrown while the primary is served stale).
    if (entry?.inflight) {
      try {
        return { value: (await entry.inflight) as T, stale: false };
      } catch (err) {
        if (entry.has && classifyGateError(err).category === 'rate-limited') {
          return { value: entry.value as T, stale: true };
        }
        throw err;
      }
    }

    if (!entry) {
      entry = { expiresAt: 0, has: false, cooldownUntil: 0 };
      this.entries.set(key, entry);
    }
    const inflight = fetch();
    entry.inflight = inflight;
    try {
      const value = await inflight;
      entry.value = value;
      entry.has = true;
      entry.expiresAt = Date.now() + ttlMs;
      this.touch(key, entry);
      this.evictIfNeeded();
      return { value, stale: false };
    } catch (err) {
      if (classifyGateError(err).category === 'rate-limited') {
        entry.cooldownUntil = Date.now() + COOLDOWN_MS;
        if (entry.has) return { value: entry.value as T, stale: true };
      }
      throw err;
    } finally {
      if (entry.inflight === inflight) entry.inflight = undefined;
    }
  }

  /** Invalidate every key starting with `prefix` (e.g. after a cancel/leverage write). */
  bust(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Move a key to the most-recently-used end (Map preserves insertion order). */
  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /** Bound memory: drop the oldest entries with no inflight fetch once over the cap. */
  private evictIfNeeded(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [key, e] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (!e.inflight) this.entries.delete(key);
    }
  }
}
