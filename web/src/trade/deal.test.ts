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

describe('dealFromActions — maker + hedge close', () => {
  const close = (symbol: string, over: Partial<Extract<ActionInput, { kind: 'close-position' }>> = {}): ActionInput => ({
    kind: 'close-position',
    symbol,
    slippagePct: 1,
    ...over,
  });

  it('maps the roles onto a reduce-only maker deal, resting leg first', () => {
    const actions = [
      close('GATE_FUTURE_ETH_USDT', { pairRole: 'hedge', maxClip: '40' }),
      close('HYPERLIQUID_FUTURE_ETH_USDC', { pairRole: 'maker', makerPrice: '2500', makerTimeoutSec: 60, maxClip: '40' }),
    ];
    const deal = dealFromActions('d1', actions, actions.map((a) => previewFor(a)));
    expect(deal).toEqual({
      id: 'd1',
      a: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'SELL', reduceOnly: true },
      b: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', reduceOnly: true },
      qty: '0.05',
      execution: 'maker',
      price: '2500',
      pricePolicy: 'touch',
      timeoutSec: 60,
      clipBandPct: 1,
      maxClip: '40',
    });
  });

  it('refuses a maker close with no starting price or no hedge role', () => {
    const noPrice = [close('A_X', { pairRole: 'maker' }), close('B_X', { pairRole: 'hedge' })];
    expect(dealFromActions('d1', noPrice, noPrice.map((a) => previewFor(a)))).toBeNull();
    const noHedge = [close('A_X', { pairRole: 'maker', makerPrice: '1' }), close('B_X')];
    expect(dealFromActions('d1', noHedge, noHedge.map((a) => previewFor(a)))).toBeNull();
  });

  it('a close without roles stays a taker close', () => {
    const actions = [close('GATE_FUTURE_ETH_USDT'), close('HYPERLIQUID_FUTURE_ETH_USDC')];
    expect(dealFromActions('d1', actions, actions.map((a) => previewFor(a)))?.execution).toBe('taker');
  });
});
