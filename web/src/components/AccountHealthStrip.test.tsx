import { cleanup, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrossexPosition, PositionsResponse } from '../api/types';
import { accountBodies, accountHandler, baseHandlers, makeCrossexPosition } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { AccountHealthStrip } from './AccountHealthStrip';

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
        /· Nearest liquidation: ETH\..* HYPE\. No liquidation estimate: Gate has not sent a price for the Hyperliquid leg since 14:32\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the notice alone when every coin is blind', async () => {
    show(coin('ETH', true));

    expect(
      await screen.findByTitle(
        /· ETH\. No liquidation estimate: Gate has not sent a price for the Hyperliquid leg since 14:32\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/Nearest liquidation/)).toBeNull();
  });

  it('shows the nearest line alone when every coin has a price', async () => {
    show(coin('ETH'));

    expect(
      await screen.findByTitle(
        /· Nearest liquidation: ETH\. Gate liquidates your account if ETH (rises|falls) to about \$[\d,.]+ \([+-]\d+%\)\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/No liquidation estimate/)).toBeNull();
  });
});
