import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RollSignalProvider, useRollPublisher, type RollSignal } from './rollSignal';

const { putJson } = vi.hoisted(() => ({ putJson: vi.fn(async () => ({})) }));
vi.mock('../api/client', () => ({ putJson }));

const SIGNAL: RollSignal = {
  key: 'ETH:GATE:HYPERLIQUID:1790294400',
  asset: 'ETH',
  longVenue: 'GATE',
  shortVenue: 'HYPERLIQUID',
  maturity: 1790294400,
  opportunity: { maturity: 1793318400, rate: 0.124, current: 0.091, currentMaturity: 1790294400 },
};

function Publisher() {
  const publish = useRollPublisher();
  useEffect(() => {
    publish(SIGNAL.key, SIGNAL);
  }, [publish]);
  return null;
}

describe('roll signals reach the terminal server', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putJson.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends once the signals settle, then again every 20 minutes', async () => {
    render(
      <RollSignalProvider>
        <Publisher />
      </RollSignalProvider>,
    );

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(putJson).toHaveBeenCalledTimes(1);
    expect(putJson.mock.calls[0]).toEqual([
      '/telegram/roll-signals',
      {
        signals: [
          {
            coin: 'ETH',
            longVenue: 'GATE',
            shortVenue: 'HYPERLIQUID',
            maturity: 1790294400,
            to: { maturity: 1793318400, apr: 0.124, currentApr: 0.091 },
          },
        ],
      },
    ]);

    await act(() => vi.advanceTimersByTimeAsync(20 * 60_000));
    expect(putJson).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(20 * 60_000));
    expect(putJson).toHaveBeenCalledTimes(3);
  });
});
