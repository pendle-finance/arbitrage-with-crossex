import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../src/server/app';
import { feeReadWithin } from '../../src/server/dealFees';

const depsOf = (): AppDeps => ({}) as AppDeps;

describe('feeReadWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the read when it answers inside 1.5 s', async () => {
    const deps = depsOf();
    expect(await feeReadWithin(deps, { kind: 'read', work: async (): Promise<Record<string, number>> => ({ d1: 0.5 }), fallback: {} })).toEqual({ d1: 0.5 });
  });

  it('falls back after 1.5 s, then skips the read for 10 s, then reads again', async () => {
    vi.useFakeTimers();
    const deps = depsOf();
    let calls = 0;
    const slow = () => {
      calls += 1;
      return new Promise<Record<string, number>>((resolve) => setTimeout(() => resolve({ d1: 0.5 }), 8_000));
    };
    const first = feeReadWithin(deps, { kind: 'read', work: slow, fallback: {} });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await first).toEqual({});
    expect(await feeReadWithin(deps, { kind: 'read', work: slow, fallback: {} })).toEqual({});
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await feeReadWithin(deps, { kind: 'read', work: async (): Promise<Record<string, number>> => ({ d1: 0.5 }), fallback: {} })).toEqual({ d1: 0.5 });
  });

  it('keeps one failure memory per kind', async () => {
    vi.useFakeTimers();
    const deps = depsOf();
    const first = feeReadWithin(deps, { kind: 'rows', work: () => new Promise<number[]>(() => undefined), fallback: [] });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await first).toEqual([]);
    expect(await feeReadWithin(deps, { kind: 'read', work: async (): Promise<Record<string, number>> => ({ d1: 0.5 }), fallback: {} })).toEqual({ d1: 0.5 });
  });
});
