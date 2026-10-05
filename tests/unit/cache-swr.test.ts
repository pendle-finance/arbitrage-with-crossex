/** TtlCache stale-while-revalidate — strictly opt-in: display-only scan keys
 * serve the expired value instantly and refresh in the background, while the
 * default path still blocks on the refetch (live account state must). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';

afterEach(() => {
  vi.useRealTimers();
});

describe('TtlCache stale-while-revalidate', () => {
  it('serves the expired value immediately and refreshes in the background', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache();
    let calls = 0;
    let release!: (v: string) => void;
    const fetcher = (): Promise<string> => {
      calls += 1;
      return calls === 1 ? Promise.resolve('v1') : new Promise<string>((r) => (release = r));
    };

    expect(await cache.get('k', 1_000, fetcher, { staleWhileRevalidate: true })).toEqual({
      value: 'v1',
      stale: false,
    });
    vi.advanceTimersByTime(1_500); // expire

    // Expired: the stale value comes back instantly while the refresh runs.
    expect(await cache.get('k', 1_000, fetcher, { staleWhileRevalidate: true })).toEqual({
      value: 'v1',
      stale: true,
    });
    expect(calls).toBe(2);

    // A second caller mid-refresh rides the same inflight fetch — no third call.
    expect(await cache.get('k', 1_000, fetcher, { staleWhileRevalidate: true })).toEqual({
      value: 'v1',
      stale: true,
    });
    expect(calls).toBe(2);

    // Once the refresh lands, callers get the new value fresh.
    release('v2');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(await cache.get('k', 1_000, fetcher, { staleWhileRevalidate: true })).toEqual({
      value: 'v2',
      stale: false,
    });
    expect(calls).toBe(2);
  });

  it('without the flag an expired entry still blocks on the refetch', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache();
    let calls = 0;
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return `v${calls}`;
    };
    await cache.get('k', 1_000, fetcher);
    vi.advanceTimersByTime(1_500);
    expect(await cache.get('k', 1_000, fetcher)).toEqual({ value: 'v2', stale: false });
  });
  it('a background response cannot overwrite a newer explicit fresh read', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache();
    await cache.get('k', 1_000, async () => 'initial');
    vi.advanceTimersByTime(1_001);
    let release!: (value: string) => void;
    await cache.get('k', 1_000, () => new Promise<string>((r) => { release = r; }), {
      staleWhileRevalidate: true,
    });
    await cache.get('k', 1_000, async () => 'newer', { fresh: true });
    release('older');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(await cache.get('k', 1_000, async () => 'unexpected')).toEqual({
      value: 'newer', stale: false,
    });
  });

  it('a background response cannot resurrect a busted entry', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache();
    await cache.get('k', 1_000, async () => 'initial');
    vi.advanceTimersByTime(1_001);
    let release!: (value: string) => void;
    await cache.get('k', 1_000, () => new Promise<string>((r) => { release = r; }), {
      staleWhileRevalidate: true,
    });
    cache.bust('k');
    release('obsolete');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(await cache.get('k', 1_000, async () => 'reloaded')).toEqual({
      value: 'reloaded', stale: false,
    });
  });

});
