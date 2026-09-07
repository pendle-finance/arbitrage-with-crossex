import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Trade, TradesResponse } from '../api/types';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { TradesPanel } from './TradesPanel';

const fills: Trade[] = [
  {
    transactionId: 'txn-1',
    orderId: 'ord-1',
    symbol: 'BINANCE_FUTURE_BTC_USDT',
    exchangeType: 'BINANCE',
    side: 'BUY',
    qty: '0.001',
    price: '65000',
    fee: '0.0046',
    feeCoin: 'USDT',
    feeRate: '0.0002',
    matchRole: 'TAKER',
    rpnl: '0',
    createTime: 1_751_500_000, // seconds epoch — must not crash the defensive toDate
    orderType: 'LIMIT',
    orderTif: 'IOC',
  },
  {
    transactionId: 'txn-2',
    orderId: 'ord-1',
    symbol: 'BINANCE_FUTURE_BTC_USDT',
    exchangeType: 'BINANCE',
    side: 'BUY',
    qty: '0.001',
    price: '65010',
    fee: '0.0047',
    feeCoin: 'USDT',
    feeRate: '0.0002',
    matchRole: 'TAKER',
    rpnl: '0',
    createTime: 1_751_500_001,
    orderType: 'LIMIT',
    orderTif: 'IOC',
  },
];

function mockTrades(trades: Trade[]) {
  server.use(
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades, page: 1, limit: 100, hasMore: false })),
    ),
  );
}

describe('TradesPanel (grouped by order, default ON)', () => {
  it('shows summed fee, taker chip, and "LMT IOC" on the group row', async () => {
    mockTrades(fills);
    renderWithClient(<TradesPanel />);

    // 0.0046 + 0.0047, formatted by sig() with the feeCoin appended.
    expect(await screen.findByText('0.0093 USDT')).toBeInTheDocument();
    expect(screen.getByText('taker')).toBeInTheDocument();
    expect(screen.getByText('LMT IOC')).toBeInTheDocument();
    // 2 fills grouped into one order row.
    expect(screen.queryByText('txn-1')).not.toBeInTheDocument();
  });

  it('expands a group to its fill rows with per-fill bps rates', async () => {
    mockTrades(fills);
    renderWithClient(<TradesPanel />);
    await screen.findByText('0.0093 USDT');

    await userEvent.click(screen.getByLabelText('toggle details'));

    expect(await screen.findByText('txn-1')).toBeInTheDocument();
    expect(screen.getByText('txn-2')).toBeInTheDocument();
    // Group row rate + two fill rows, all at 2.0 bps.
    expect(screen.getAllByText('2.0 bps')).toHaveLength(3);
    expect(screen.getAllByText('taker')).toHaveLength(3);
  });
});
