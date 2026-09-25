import { cleanup, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrossexPosition, PositionsResponse } from '../api/types';
import { accountBodies, accountHandler, agentStatus, baseHandlers, makeCrossexPosition } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { STRATEGY_STORAGE_KEY } from '../panels/HomeControls';
import { AccountHealthStrip } from './AccountHealthStrip';

vi.mock('../lib/useNow', () => ({ useNow: () => new Date(2026, 8, 21, 14, 32).getTime() + 4 * 3_600_000 + 12 * 60_000 }));

const STALE_AT = new Date(2026, 8, 21, 14, 32).getTime();

type Coin = { positions: CrossexPosition[]; exposure: PositionsResponse['exposure'][number] };

function coin(base: string, blind = false): Coin {
  const gate = `GATE_FUTURE_${base}_USDT`;
  const hyperliquid = `HYPERLIQUID_FUTURE_${base}_USDC`;
  return {
    positions: [
      makeCrossexPosition({
        symbol: gate, positionSide: 'LONG', positionValue: '2500', markPrice: '2300', maintenanceMargin: '12.5',
      }),
      makeCrossexPosition({
        symbol: hyperliquid, positionSide: 'SHORT', positionValue: '2500', maintenanceMargin: '12.5',
        markPrice: blind ? '' : '2300',
        ...(blind ? { markStaleSinceMs: STALE_AT } : {}),
      }),
    ],
    exposure: {
      base,
      legs: [
        { symbol: gate, exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 1.087, value: 2500 },
        { symbol: hyperliquid, exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 1.087, value: 2500 },
      ],
      longValue: 2500,
      shortValue: 2500,
      netValue: 0,
      grossValue: 5000,
      neutral: true,
      singleLeg: false,
    },
  };
}

function show(...coins: Coin[]) {
  const book: PositionsResponse = {
    positions: coins.flatMap((c) => c.positions),
    exposure: coins.map((c) => c.exposure),
  };
  server.use(
    accountHandler(accountBodies.accountA),
    http.get('/api/positions', () => HttpResponse.json(env(book))),
    ...baseHandlers(),
  );
  renderWithClient(<AccountHealthStrip />);
}

afterEach(cleanup);

describe('the account strip when Gate stops sending a mark', () => {
  it('keeps the nearest line and names the coin with no price after it', async () => {
    show(coin('ETH'), coin('HYPE', true));

    expect(
      await screen.findByTitle(
        /· Nearest liquidation: ETH .* HYPE\. No Hyperliquid price from Gate for 4h 12m\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the notice alone when every coin is blind', async () => {
    show(coin('ETH', true));

    expect(
      await screen.findByTitle(
        /· ETH\. No Hyperliquid price from Gate for 4h 12m\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/Nearest liquidation/)).toBeNull();
  });

  it('shows the nearest line alone when every coin has a price', async () => {
    show(coin('ETH'));

    expect(
      await screen.findByTitle(
        /· Nearest liquidation: ETH (rises|falls) to \$[\d,.]+ \([+-]\d+%\)\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/price from Gate/)).toBeNull();
  });
});

describe('the account strip while viewing a wallet that is not logged in', () => {
  it('hides the logged-in account figures', async () => {
    localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: `0x${'2'.repeat(40)}`, walletUpgraded: true }));
    const eth = coin('ETH');
    server.use(
      http.get('/api/boros/agent', () => HttpResponse.json(env(agentStatus({ configured: true, root: `0x${'1'.repeat(40)}` })))),
      accountHandler(accountBodies.accountA),
      http.get('/api/positions', () => HttpResponse.json(env({ positions: eth.positions, exposure: [eth.exposure] }))),
      ...baseHandlers(),
    );
    const { container } = renderWithClient(<AccountHealthStrip />);
    // Only the empty spacer is left once the viewed wallet reads as not logged in.
    await waitFor(() => expect(container.querySelector('div.ml-auto')?.childElementCount).toBe(0));
    expect(screen.queryByText('Avail')).toBeNull();
  });
});
