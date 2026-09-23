import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { SymbolRule } from '../api/types';
import { BTC_BINANCE, ETH_GATE } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { PairTicket } from './PairTicket';
import { SingleTicket } from './SingleTicket';

/** GATE lists ratio perps whose base is itself a pair — must be hidden. */
const ETHBTC_GATE: SymbolRule = { ...ETH_GATE, symbol: 'GATE_FUTURE_ETHBTC_USDT', base: 'ETHBTC' };
const SOL_GATE: SymbolRule = { ...ETH_GATE, symbol: 'GATE_FUTURE_SOL_USDT', base: 'SOL' };
const HYPE_GATE: SymbolRule = { ...ETH_GATE, symbol: 'GATE_FUTURE_HYPE_USDT', base: 'HYPE' };
const HYPE_BINANCE: SymbolRule = { ...BTC_BINANCE, symbol: 'BINANCE_FUTURE_HYPE_USDT', base: 'HYPE' };

describe('coin search (ratio-pair filter)', () => {
  it("typing 'eth' lists ETH but hides the ETHBTC ratio market", async () => {
    server.use(
      http.get('/api/symbols', () =>
        HttpResponse.json(env([ETH_GATE, BTC_BINANCE, ETHBTC_GATE, SOL_GATE])),
      ),
    );
    renderWithClient(<PairTicket />);

    await userEvent.type(screen.getByLabelText('Coin search'), 'eth');

    expect(await screen.findByText('ETH', { selector: '.w-14' })).toBeInTheDocument();
    expect(screen.queryByText('ETHBTC')).not.toBeInTheDocument();
  });
});

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

    expect(await screen.findByLabelText('LONG venue')).toBeInTheDocument();
    expect(screen.getByLabelText('SHORT venue')).toBeInTheDocument();
    // One venue option per dropdown for each fixture venue.
    expect(await screen.findAllByRole('option', { name: 'Gate' })).toHaveLength(2);
    expect(screen.getAllByRole('option', { name: 'Binance' })).toHaveLength(2);
    // The active quick-pick is marked as pressed.
    expect(screen.getByRole('button', { name: 'HYPE' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers only the supported coins as quick picks', () => {
    renderWithClient(<PairTicket />);

    const chips = within(screen.getByRole('group', { name: 'Quick pick coin' })).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['ETH', 'BTC', 'HYPE']);
  });

  it("single mode: clicking ETH shows ETH's venue chips", async () => {
    server.use(http.get('/api/symbols', () => HttpResponse.json(env([ETH_GATE]))));
    renderWithClient(<SingleTicket />);

    await userEvent.click(screen.getByRole('button', { name: 'ETH' }));

    // Search opens on ETH → its venue chip is pickable.
    expect(await screen.findByRole('button', { name: 'GATE' })).toBeInTheDocument();
  });
});
