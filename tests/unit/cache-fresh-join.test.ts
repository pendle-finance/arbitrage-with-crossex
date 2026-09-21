import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('a fresh read starts after the caller asks', () => {
  it.each([
    ['a plain read', {}],
    ['a fresh read', { fresh: true }],
  ])('never joins %s that was already in flight', async (_label, opts) => {
    const cache = new TtlCache();
    const before = deferred<string>();
    const fetch = vi.fn().mockReturnValueOnce(before.promise).mockResolvedValueOnce('after cancel');

    const older = cache.get('boros:collaterals:0xabc', 30_000, fetch, opts);
    const fresh = cache.get('boros:collaterals:0xabc', 30_000, fetch, { fresh: true });
    before.resolve('before cancel');

    expect(await fresh).toEqual({ value: 'after cancel', stale: false });
    expect(await older).toEqual({ value: 'before cancel', stale: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await cache.get('boros:collaterals:0xabc', 30_000, fetch)).toEqual({ value: 'after cancel', stale: false });
  });

  it('a plain read still joins the read in flight', async () => {
    const cache = new TtlCache();
    const fetch = vi.fn().mockResolvedValue('one read');
    const [a, b] = await Promise.all([cache.get('k', 30_000, fetch), cache.get('k', 30_000, fetch)]);
    expect([a.value, b.value]).toEqual(['one read', 'one read']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
