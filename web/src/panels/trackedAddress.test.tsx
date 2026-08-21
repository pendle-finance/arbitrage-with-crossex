/**
 * The APR-clock override belongs to the WALLET it was set on.
 *
 * As a single scalar it survived a switch, so the next book's realized return
 * was measured from the previous book's start date — and if that date was
 * later than the new positions opened, `elapsedSeconds` floors at one second
 * and the APR explodes.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STRATEGY_STORAGE_KEY } from './HomeControls';
import { TrackedAddressProvider, useTrackedAddress } from './trackedAddress';

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);

let api: ReturnType<typeof useTrackedAddress>;
function Probe() {
  api = useTrackedAddress();
  return <span data-testid="since">{String(api.since)}</span>;
}
const mount = () =>
  render(
    <TrackedAddressProvider>
      <Probe />
    </TrackedAddressProvider>,
  );
const shown = () => screen.getByTestId('since').textContent;

describe('the APR-clock override is per wallet', () => {
  it('does not follow the user to the next wallet, and is still there on the way back', () => {
    mount();
    act(() => api.setAddress(A));
    act(() => api.setSince(1_750_000_000));
    expect(shown()).toBe('1750000000');

    act(() => api.setAddress(B));
    expect(shown()).toBe('null'); // B's clock is B's own

    act(() => api.setSince(1_760_000_000));
    expect(shown()).toBe('1760000000');

    act(() => api.setAddress(A));
    expect(shown()).toBe('1750000000');
  });

  it('clears only the wallet it was cleared on', () => {
    mount();
    act(() => api.setAddress(A));
    act(() => api.setSince(1_750_000_000));
    act(() => api.setAddress(B));
    act(() => api.setSince(1_760_000_000));

    act(() => api.setSince(null));
    expect(shown()).toBe('null');
    act(() => api.setAddress(A));
    expect(shown()).toBe('1750000000');
  });

  it('migrates a scalar `since` onto the address it was stored beside', () => {
    // Written by a build before the override was per-wallet. It belonged to
    // whichever wallet was tracked then — not to every wallet opened since.
    localStorage.setItem(
      STRATEGY_STORAGE_KEY,
      JSON.stringify({ address: A, since: 1_700_000_000, capitalBasis: 'balance' }),
    );
    mount();
    expect(shown()).toBe('1700000000');
    act(() => api.setAddress(B));
    expect(shown()).toBe('null');
  });

  it('ignores an override with no wallet to anchor it', () => {
    mount();
    act(() => api.setSince(1_750_000_000));
    expect(shown()).toBe('null');
  });
});
