/**
 * The app-wide roll banner: what it names, what it folds away, and the
 * order of its two controls. Signals are published straight into the
 * provider here — the cards' own arithmetic is covered where they live.
 */
import { screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '../test/utils';
import { RollOverBanner } from './RollOverBanner';
import { RollSignalProvider, useRollPublisher, type RollSignal } from './rollSignal';

const DAY = 86_400;
const NOW = () => Math.floor(Date.now() / 1000);

const signal = (asset: string, days: number, opportunity: RollSignal['opportunity'] = null): RollSignal => ({
  key: `${asset}:k`,
  asset,
  longVenue: 'GATE',
  shortVenue: 'HYPERLIQUID',
  maturity: NOW() + days * DAY,
  opportunity,
});

function Publish({ signals }: { signals: RollSignal[] }) {
  const publish = useRollPublisher();
  useEffect(() => {
    for (const s of signals) publish(s.key, s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const render = (signals: RollSignal[], onShow = () => {}) =>
  renderWithClient(
    <RollSignalProvider>
      <Publish signals={signals} />
      <RollOverBanner onShowPositions={onShow} />
    </RollSignalProvider>,
  );

describe('RollOverBanner', () => {
  it('names two pairs and folds the rest into "+N more", which still lists them on hover', async () => {
    const opp = { maturity: NOW() + 60 * DAY, rate: 0.2, current: 0.1, currentMaturity: NOW() + 5 * DAY };
    render([signal('ETH', 5, opp), signal('BTC', 4, opp), signal('SOL', 3, opp), signal('HYPE', 2, opp)]);

    const bar = await screen.findByRole('button', { name: /Roll over now/ });
    // Soonest first, so the two most urgent are named …
    expect(bar).toHaveTextContent('HYPE');
    expect(bar).toHaveTextContent('SOL');
    // … and the rest fold away rather than wrapping the bar.
    expect(bar).not.toHaveTextContent('ETH');
    expect(bar).not.toHaveTextContent('BTC');
    const more = within(bar).getByText('+2 more');
    expect(more.getAttribute('title')).toContain('BTC');
    expect(more.getAttribute('title')).toContain('ETH');
  });

  it('with two or fewer there is no overflow chip', async () => {
    render([signal('ETH', 5), signal('BTC', 4)]);
    const bar = await screen.findByRole('button', { name: /Roll over now/ });
    expect(within(bar).queryByText(/more$/)).not.toBeInTheDocument();
  });

  it('puts Show Me to the RIGHT of the explain pill, and it opens Positions', async () => {
    const seen: string[] = [];
    render([signal('ETH', 5)], () => seen.push('positions'));

    const explain = await screen.findByRole('button', { name: 'Explain rollover to me' });
    const show = screen.getByRole('button', { name: 'Show Me ›' });
    // Explain comes first in document order, Show Me last.
    expect(explain.compareDocumentPosition(show) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(show);
    expect(seen).toEqual(['positions']);
  });

  it('nothing published, nothing rendered', () => {
    render([]);
    expect(screen.queryByText(/Roll over now|can roll over/)).not.toBeInTheDocument();
  });
});
