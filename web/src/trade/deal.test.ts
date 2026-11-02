import { describe, expect, it } from 'vitest';
import type { ActionInput } from '../api/types';
import { previewFor } from '../test/fixtures';
import { dealFromActions } from './deal';

const open = (symbol: string, side: 'BUY' | 'SELL'): ActionInput => ({
  kind: 'open-market',
  symbol,
  side,
  qty: '0.05',
  leverage: 10,
});

describe('dealFromActions — both-market pair', () => {
  it('sends a Gate leg first, so a Gate cap refusal leaves nothing to hedge', () => {
    const actions = [open('HYPERLIQUID_FUTURE_ETH_USDC', 'BUY'), open('GATE_FUTURE_ETH_USDT', 'SELL')];
    const deal = dealFromActions('d1', actions, actions.map((a) => previewFor(a)));

    expect(deal?.a).toEqual({ symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL' });
    expect(deal?.b).toEqual({ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'BUY' });
  });

  it('keeps the ticket order when no leg is on Gate', () => {
    const actions = [open('HYPERLIQUID_FUTURE_ETH_USDC', 'BUY'), open('BINANCE_FUTURE_ETH_USDT', 'SELL')];
    const deal = dealFromActions('d1', actions, actions.map((a) => previewFor(a)));

    expect(deal?.a.symbol).toBe('HYPERLIQUID_FUTURE_ETH_USDC');
    expect(deal?.b?.symbol).toBe('BINANCE_FUTURE_ETH_USDT');
  });
});
