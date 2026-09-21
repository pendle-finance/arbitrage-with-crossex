import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { PositionsResponse } from '../api/types';
import { accountBodies, accountHandler, baseHandlers, makeCrossexPosition } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { AccountHealthStrip } from './AccountHealthStrip';

const STALE_AT = new Date(2026, 8, 21, 14, 32).getTime();

const blindBook: PositionsResponse = {
  positions: [
    makeCrossexPosition({
      symbol: 'GATE_FUTURE_ETH_USDT',
      positionSide: 'LONG',
      positionValue: '250000',
      markPrice: '2300',
      maintenanceMargin: '1250',
    }),
    makeCrossexPosition({
      symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
      positionSide: 'SHORT',
      positionValue: '250000',
      markPrice: '',
      maintenanceMargin: '1250',
      markStaleSinceMs: STALE_AT,
    }),
  ],
  exposure: [
    {
      base: 'ETH',
      legs: [
        { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 108.7, value: 250000 },
        {
          symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 108.7,
          value: 250000,
        },
      ],
      longValue: 250000,
      shortValue: 250000,
      netValue: 0,
      grossValue: 500000,
      neutral: true,
      singleLeg: false,
    },
  ],
};

describe('the account strip when Gate stops sending a mark', () => {
  it('names the coin with no price instead of a line from another coin', async () => {
    server.use(
      accountHandler(accountBodies.accountA),
      http.get('/api/positions', () => HttpResponse.json(env(blindBook))),
      ...baseHandlers(),
    );

    renderWithClient(<AccountHealthStrip />);

    expect(
      await screen.findByTitle(
        /ETH\. No liquidation estimate: Gate has not sent a price for the Hyperliquid leg since 14:32\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/Nearest liquidation/)).toBeNull();
  });
});
