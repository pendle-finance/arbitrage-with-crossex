import { screen } from '@testing-library/react';
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

    expect(await screen.findByText('LONG venue')).toBeInTheDocument();
    expect(screen.getByText('SHORT venue')).toBeInTheDocument();
    // One venue chip per row for each fixture venue.
    expect(await screen.findAllByRole('button', { name: 'GATE' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'BINANCE' })).toHaveLength(2);
    // The active quick-pick is highlighted.
    expect(screen.getByRole('button', { name: 'HYPE' })).toHaveClass('text-cyan-300');
  });

  it("single mode: clicking ETH shows ETH's venue chips", async () => {
    server.use(http.get('/api/symbols', () => HttpResponse.json(env([ETH_GATE]))));
    renderWithClient(<SingleTicket />);

    await userEvent.click(screen.getByRole('button', { name: 'ETH' }));

    // Search opens on ETH → its venue chip is pickable.
    expect(await screen.findByRole('button', { name: 'GATE' })).toBeInTheDocument();
  });
});

describe('Recent symbols (coin allowlist)', () => {
  it('drops a recent symbol whose coin is no longer supported', async () => {
    window.localStorage.setItem(
      'crossex.recentSymbols.v1',
      JSON.stringify(['GATE_FUTURE_ETH_USDT', 'GATE_FUTURE_SOL_USDT']),
    );
    server.use(
      http.get('/api/symbols', ({ request }) =>
        HttpResponse.json(env(new URL(request.url).searchParams.has('q') ? [] : [ETH_GATE])),
      ),
    );
    renderWithClient(<SingleTicket />);

    expect(await screen.findByTitle('GATE_FUTURE_ETH_USDT')).toBeInTheDocument();
    expect(screen.queryByTitle('GATE_FUTURE_SOL_USDT')).not.toBeInTheDocument();
  });
});
