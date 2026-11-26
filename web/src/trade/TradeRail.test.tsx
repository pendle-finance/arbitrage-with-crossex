import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { baseHandlers } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { TradeRail, TradeRailTabs, type Venue } from './TradeRail';

function Harness() {
  const [venue, setVenue] = useState<Venue>('perp');
  return (
    <>
      <TradeRailTabs venue={venue} onChange={setVenue} />
      <TradeRail venue={venue} onVenueChange={setVenue} />
    </>
  );
}

describe('TradeRail', () => {
  it('header tabs', () => {
    server.use(...baseHandlers());
    renderWithClient(<Harness />);

    const venue = within(screen.getByRole('radiogroup', { name: 'Venue' }));
    expect(venue.getAllByRole('radio').map((r) => r.textContent)).toEqual(['CrossEx perps', 'Boros rates']);
    expect(venue.getByRole('radio', { name: 'CrossEx perps' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('group', { name: 'Coin' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Symbol search')).not.toBeInTheDocument();
  });

  it('one pair single toggle on both tabs', async () => {
    server.use(...baseHandlers());
    renderWithClient(<Harness />);

    const toggle = () => within(screen.getByRole('radiogroup', { name: 'Ticket kind' }));
    expect(toggle().getAllByRole('radio').map((r) => r.textContent)).toEqual(['Pair', 'Single']);
    expect(toggle().getByRole('radio', { name: 'Pair' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: 'Boros rates' }));
    expect(screen.getAllByRole('radio', { name: 'Pair' })).toHaveLength(1);
    expect(screen.getAllByRole('radio', { name: 'Single' })).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: 'Perp ticket mode' })).not.toBeInTheDocument();

    await userEvent.click(toggle().getByRole('radio', { name: 'Single' }));
    expect(toggle().getByRole('radio', { name: 'Single' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: 'CrossEx perps' }));
    expect(toggle().getByRole('radio', { name: 'Single' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('This leg is not hedged.')).toBeInTheDocument();
  });

  it('no title or caption', async () => {
    server.use(...baseHandlers());
    renderWithClient(<Harness />);

    expect(screen.queryByText('Order ticket')).not.toBeInTheDocument();
    expect(screen.queryByText(/Opens perp positions on Gate CrossEx/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Boros rates' }));
    expect(screen.queryByText(/Opens fixed-rate positions on Boros/i)).not.toBeInTheDocument();
  });
});
