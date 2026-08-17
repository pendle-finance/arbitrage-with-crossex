import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RATES_HASH, useHashRoute } from './useHashRoute';

/**
 * The landing's two views live in the URL hash, so the deep view is linkable
 * and the browser's own Back button behaves.
 *
 * The case worth pinning down is the HISTORY one: the in-page Back button must
 * POP the entry the hook pushed, not push a second. When it pushed, the
 * browser's Back button sent a visitor forward into the very view they had just
 * dismissed.
 */
async function settle() {
  // history.back() is async — it fires hashchange on a later task.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('useHashRoute', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('starts on overview with no hash, and reads #/rates on first render', () => {
    const a = renderHook(() => useHashRoute());
    expect(a.result.current[0]).toBe('overview');

    window.location.hash = RATES_HASH;
    const b = renderHook(() => useHashRoute());
    expect(b.result.current[0]).toBe('rates');
  });

  it('navigating to rates puts it in the URL', async () => {
    const { result } = renderHook(() => useHashRoute());
    act(() => result.current[1]('rates'));
    await settle();

    expect(window.location.hash).toBe(RATES_HASH);
    expect(result.current[0]).toBe('rates');
  });

  it('leaving rates POPS our own entry, so browser Back does not return to it', async () => {
    const { result } = renderHook(() => useHashRoute());
    const before = window.history.length;

    act(() => result.current[1]('rates'));
    await settle();
    act(() => result.current[1]('overview'));
    await settle();

    expect(result.current[0]).toBe('overview');
    expect(window.location.hash).toBe('');
    // The push was unwound rather than stacked on: one more entry would mean
    // the browser's Back button lands on #/rates again.
    expect(window.history.length).toBeLessThanOrEqual(before + 1);
  });

  it('responds to browser Back/Forward (a raw hashchange)', async () => {
    const { result } = renderHook(() => useHashRoute());

    act(() => {
      window.location.hash = RATES_HASH;
    });
    await settle();
    expect(result.current[0]).toBe('rates');

    act(() => {
      window.location.hash = '';
    });
    await settle();
    expect(result.current[0]).toBe('overview');
  });

  it('leaving rates on a DEEP LINK replaces the hash instead of pushing', async () => {
    // No entry of ours to pop: pushing '' here would make the browser's Back
    // button walk back into #/rates.
    window.location.hash = RATES_HASH;
    const { result } = renderHook(() => useHashRoute());
    expect(result.current[0]).toBe('rates');

    act(() => result.current[1]('overview'));
    await settle();

    expect(result.current[0]).toBe('overview');
    expect(window.location.hash).toBe('');
  });
});
