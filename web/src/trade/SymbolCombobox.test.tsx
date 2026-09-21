import { screen, waitFor } from '@testing-library/react';
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
  const storeRecents = () =>
    window.localStorage.setItem(
      'crossex.recentSymbols.v1',
      JSON.stringify(['GATE_FUTURE_ETH_USDT', 'GATE_FUTURE_SOL_USDT']),
    );

  it('shows every recent symbol while the coin list loads, then drops the unsupported one when it arrives', async () => {
    storeRecents();
    let release = () => {};
    const listed = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/symbols', async ({ request }) => {
        if (new URL(request.url).searchParams.has('q')) return HttpResponse.json(env([]));
        await listed;
        return HttpResponse.json(env([ETH_GATE]));
      }),
    );
    renderWithClient(<SingleTicket />);

    expect(await screen.findByTitle('GATE_FUTURE_ETH_USDT')).toBeInTheDocument();
    expect(screen.getByTitle('GATE_FUTURE_SOL_USDT')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByTitle('GATE_FUTURE_SOL_USDT')).not.toBeInTheDocument());
    expect(screen.getByTitle('GATE_FUTURE_ETH_USDT')).toBeInTheDocument();
  });

  it('keeps every recent symbol when the coin list fails to load', async () => {
    storeRecents();
    let failed = false;
    server.use(
      http.get('/api/symbols', () => {
        failed = true;
        return HttpResponse.json({ ok: false, error: { code: 'GATE_DOWN', message: 'Gate is down' } }, { status: 502 });
      }),
    );
    renderWithClient(<SingleTicket />);

    await waitFor(() => expect(failed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTitle('GATE_FUTURE_ETH_USDT')).toBeInTheDocument();
    expect(screen.getByTitle('GATE_FUTURE_SOL_USDT')).toBeInTheDocument();
  });

  it('drops a recent symbol whose coin is no longer supported', async () => {
    storeRecents();
    server.use(
      http.get('/api/symbols', ({ request }) =>
        HttpResponse.json(env(new URL(request.url).searchParams.has('q') ? [] : [ETH_GATE])),
      ),
    );
    renderWithClient(<SingleTicket />);

    expect(await screen.findByTitle('GATE_FUTURE_ETH_USDT')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTitle('GATE_FUTURE_SOL_USDT')).not.toBeInTheDocument());
  });
});
