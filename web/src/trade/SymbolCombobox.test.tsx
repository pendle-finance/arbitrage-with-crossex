import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { SymbolRule } from '../api/types';
import { BTC_BINANCE, ETH_GATE } from '../test/fixtures';
import { env, server } from '../test/server';
import { optionLabels, waitForOptions } from '../test/picker';
import { renderWithClient } from '../test/utils';
import { PairTicket } from './PairTicket';
import { SingleTicket } from './SingleTicket';

const HYPE_GATE: SymbolRule = { ...ETH_GATE, symbol: 'GATE_FUTURE_HYPE_USDT', base: 'HYPE' };
const HYPE_BINANCE: SymbolRule = { ...BTC_BINANCE, symbol: 'BINANCE_FUTURE_HYPE_USDT', base: 'HYPE' };

describe('quick-pick coins', () => {
  it('pair mode: clicking HYPE sets the coin and shows the venue rows', async () => {
    server.use(
      http.get('/api/symbols', ({ request }) => {
        const base = new URL(request.url).searchParams.get('base');
        return HttpResponse.json(env(base === 'HYPE' ? [HYPE_GATE, HYPE_BINANCE] : []));
      }),
    );
    renderWithClient(<PairTicket />);

    await userEvent.click(screen.getByRole('button', { name: 'HYPE' }));

    const user = userEvent.setup();
    await waitForOptions(user, 'Long venue');
    expect(await optionLabels(user, 'Long venue')).toEqual(['Gate', 'Binance']);
    expect(await optionLabels(user, 'Short venue')).toEqual(['Gate', 'Binance']);
    // The active quick-pick is marked as pressed.
    expect(screen.getByRole('button', { name: 'HYPE' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers only the supported coins as quick picks', () => {
    renderWithClient(<PairTicket />);

    const chips = within(screen.getByRole('group', { name: 'Coin' })).getAllByRole('button');
    expect(chips).toHaveLength(3);
    ['ETH', 'BTC', 'HYPE'].forEach((coin, i) => expect(chips[i]).toHaveAccessibleName(coin));
  });

  it("single mode: clicking ETH lists ETH's venues in the leg's venue box", async () => {
    server.use(http.get('/api/symbols', () => HttpResponse.json(env([ETH_GATE]))));
    renderWithClient(<SingleTicket />);

    await userEvent.click(screen.getByRole('button', { name: 'ETH' }));

    const user = userEvent.setup();
    await waitForOptions(user, 'Long venue');
    expect(await optionLabels(user, 'Long venue')).toEqual(['Gate']);
  });
});
