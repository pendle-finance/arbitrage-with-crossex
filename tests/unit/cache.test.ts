import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';

const rateLimited = () => ({ response: { status: 429, data: { label: 'TOO_MANY_REQUESTS' } } });

describe('TtlCache', () => {
  it('coalesces concurrent callers onto one fetch', async () => {
    const cache = new TtlCache();
    const fetch = vi.fn(async () => 'v');
    const [a, b] = await Promise.all([cache.get('k', 1000, fetch), cache.get('k', 1000, fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.value).toBe('v');
    expect(b.value).toBe('v');
  });

  it('a FRESH read does not ride a non-fresh in-flight fetch', async () => {
    // The in-flight fetch started BEFORE a write (cancel-and-close reads the
    // position after cancelling its orders); a fresh read that joined it
    // would answer with the pre-write state, which is what `fresh` refuses.
    const cache = new TtlCache();
    let resolveSlow!: (v: string) => void;
    const slow = new Promise<string>((res) => (resolveSlow = res));
    const stale = cache.get('k', 1000, () => slow);
    const fresh = cache.get('k', 1000, async () => 'after', { fresh: true });
    resolveSlow('before');
    expect((await fresh).value).toBe('after');
    expect((await stale).value).toBe('before');
    // And the cache keeps the fresher answer, whichever landed last.
    const later = await cache.get('k', 10_000, async () => 'unexpected');
    expect(later.value).toBe('after');
  });

  it('a fresh read DOES ride an in-flight fetch that is itself fresh', async () => {
    const cache = new TtlCache();
    const fetch = vi.fn(async () => 'v');
    const [a, b] = await Promise.all([
      cache.get('k', 1000, fetch, { fresh: true }),
      cache.get('k', 1000, fetch, { fresh: true }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.value).toBe('v');
    expect(b.value).toBe('v');
  });

  it('a superseded slow fetch never overwrites the fresher value', async () => {
    const cache = new TtlCache();
    let resolveSlow!: (v: string) => void;
    const slow = new Promise<string>((res) => (resolveSlow = res));
    const stale = cache.get('k', 10_000, () => slow);
    const fresh = await cache.get('k', 10_000, async () => 'after', { fresh: true });
    expect(fresh.value).toBe('after');
    resolveSlow('before'); // lands AFTER the fresh one
    expect((await stale).value).toBe('before');
    const later = await cache.get('k', 10_000, async () => 'unexpected');
    expect(later.value).toBe('after');
  });

  it('serves a fresh cache hit within TTL without refetching', async () => {
    const cache = new TtlCache();
    const fetch = vi.fn(async () => 'v');
    await cache.get('k', 10_000, fetch);
    const hit = await cache.get('k', 10_000, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hit.stale).toBe(false);
  });

  it('degrades a coalesced WAITER to stale on a 429 (not a thrown error)', async () => {
    const cache = new TtlCache();
    await cache.get('k', 0, async () => 'cached'); // prime, TTL 0 so next call refetches
    let reject!: (e: unknown) => void;
    const slow = new Promise<string>((_, rej) => (reject = rej));
    const fetch = vi.fn(() => slow);
    const primary = cache.get('k', 1000, fetch);
    const waiter = cache.get('k', 1000, fetch); // rides the same inflight
    reject(rateLimited());
    const [p, w] = await Promise.all([primary, waiter]);
    expect(p).toEqual({ value: 'cached', stale: true });
    expect(w).toEqual({ value: 'cached', stale: true }); // NOT a thrown 429
  });

  it('cooldown is per-key: a 429 on one key does not stall another', async () => {
    const cache = new TtlCache();
    await cache.get('a', 0, async () => 'a0'); // has a cached value
    await cache.get('a', 0, async () => Promise.reject(rateLimited())).catch(() => {}); // 429 → cooldown on 'a'
    // 'b' is unaffected — it fetches live.
    const b = await cache.get('b', 1000, async () => 'b0');
    expect(b).toEqual({ value: 'b0', stale: false });
    // 'a' within cooldown serves stale without calling fetch.
    const aFetch = vi.fn(async () => 'a-new');
    const a = await cache.get('a', 0, aFetch);
    expect(a.stale).toBe(true);
    expect(aFetch).not.toHaveBeenCalled();
  });

  it('fresh=1 bypasses the cooldown and attempts a live fetch', async () => {
    const cache = new TtlCache();
    await cache.get('a', 0, async () => 'a0');
    await cache.get('a', 0, async () => Promise.reject(rateLimited())).catch(() => {}); // cooldown on 'a'
    const freshFetch = vi.fn(async () => 'a-fresh');
    const a = await cache.get('a', 1000, freshFetch, { fresh: true });
    expect(freshFetch).toHaveBeenCalledTimes(1); // did NOT serve stale
    expect(a).toEqual({ value: 'a-fresh', stale: false });
  });

  it('bust(prefix) invalidates matching keys', async () => {
    const cache = new TtlCache();
    const f = vi.fn(async () => 'v');
    await cache.get('trades:1', 10_000, f);
    cache.bust('trades');
    await cache.get('trades:1', 10_000, f);
    expect(f).toHaveBeenCalledTimes(2); // busted → refetched
  });

  it('a bust during an inflight fetch is not undone when that fetch resolves', async () => {
    const cache = new TtlCache();
    let resolve!: (v: string) => void;
    const slow = new Promise<string>((res) => (resolve = res));
    const fetch = vi.fn().mockReturnValueOnce(slow).mockResolvedValueOnce('v2');
    const first = cache.get('account', 10_000, fetch);
    cache.bust('account');
    resolve('v1');
    expect((await first).value).toBe('v1');
    const second = await cache.get('account', 10_000, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ value: 'v2', stale: false });
  });

  it('caps entry count (no unbounded growth)', async () => {
    const cache = new TtlCache();
    for (let i = 0; i < 700; i++) await cache.get(`k${i}`, 10_000, async () => i);
    // @ts-expect-error — reach into the private map size for the memory-bound assertion.
    expect(cache.entries.size).toBeLessThanOrEqual(500);
  });
});
