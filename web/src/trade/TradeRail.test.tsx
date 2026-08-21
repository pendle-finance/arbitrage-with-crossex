import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseHandlers } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { TradeRail } from './TradeRail';

describe('TradeRail', () => {
  it('defaults a fresh session to CrossEx perps, Pair ticket', () => {
    server.use(...baseHandlers()); // the ticket + ExecuteControl poll account + positions
    renderWithClient(<TradeRail />);

    const venue = within(screen.getByRole('radiogroup', { name: 'Venue' }));
    expect(venue.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'CrossEx perps',
      'Boros rates',
    ]);
    expect(venue.getByRole('radio', { name: 'CrossEx perps' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const mode = within(screen.getByRole('radiogroup', { name: 'Perp ticket mode' }));
    expect(mode.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Pair', 'Single']);
    expect(mode.getByRole('radio', { name: 'Pair' })).toHaveAttribute('aria-checked', 'true');

    // Pair ticket body renders (coin-first picker), not the single ticket.
    expect(screen.getByLabelText('Coin search')).toBeInTheDocument();
    expect(screen.queryByLabelText('Symbol search')).not.toBeInTheDocument();
  });

  it('states which venue each ticket touches instead of leaving it to be inferred', async () => {
    server.use(...baseHandlers());
    renderWithClient(<TradeRail />);

    expect(screen.getByText(/Opens perp positions on Gate CrossEx/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Boros rates' }));
    expect(screen.getByText(/Opens fixed-rate positions on Boros/i)).toBeInTheDocument();
  });

  it('nests execution style UNDER the venue, so the two market-order tickets are never siblings', async () => {
    server.use(...baseHandlers());
    renderWithClient(<TradeRail />);

    // Under perps: the perp execution modes are reachable.
    expect(screen.getByRole('radiogroup', { name: 'Pair execution mode' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Boros rates' }));
    // Switching venue takes the whole perp ticket away — its execution modes and
    // its coin picker included. Nothing perp-shaped sits beside the Boros ticket.
    expect(screen.queryByRole('radiogroup', { name: 'Pair execution mode' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Perp ticket mode' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Coin search')).not.toBeInTheDocument();
  });
});
