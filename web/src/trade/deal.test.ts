import { describe, expect, it } from 'vitest';
import type { ActionInput } from '../api/types';
import { previewFor } from '../test/fixtures';
import { dealFromActions, twapStartFrom } from './deal';

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

describe('dealFromActions with maker opts', () => {
  const opts = { makerLeg: 'auto' as const, repegBehindBp: 5 as const, timeoutSec: 240 };
  const long: ActionInput = { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '0.05', pairRole: 'hedge', leverage: 25 };
  const short = (over: Partial<Extract<ActionInput, { kind: 'open-limit' }>> = {}): ActionInput => ({
    kind: 'open-limit',
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    side: 'SELL',
    qty: '0.05',
    price: '2500',
    tif: 'POC',
    pairRole: 'maker',
    makerTimeoutSec: 300,
    pegToTouch: true,
    leverage: 20,
    ...over,
  });
  const map = (actions: ActionInput[], o: Parameters<typeof dealFromActions>[3]) =>
    dealFromActions('d1', actions, actions.map((a) => previewFor(a)), o);

  it('without opts a maker pair keeps maker first and its own timeout', () => {
    expect(map([long, short()], undefined)).toMatchObject({
      a: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' },
      b: { symbol: 'GATE_FUTURE_ETH_USDT' },
      timeoutSec: 300,
    });
    expect(map([long, short()], undefined)).not.toHaveProperty('makerLeg');
  });

  it('manual maker leg keeps the ticket order and names the resting leg', () => {
    expect(map([long, short()], { ...opts, makerLeg: 'b' })).toMatchObject({
      a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' },
      b: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'SELL' },
      makerLeg: 'b',
      execution: 'maker',
      pricePolicy: 'touch',
      repegBehindBp: 5,
      timeoutSec: 240,
      leverage: { a: 25, b: 20 },
    });
  });

  it('refuses a manual maker leg the roles do not match', () => {
    expect(map([long, short()], { ...opts, makerLeg: 'a' })).toBeNull();
  });

  it('auto with a tracked price lets the server pick, and Never sends a null timeout', () => {
    expect(map([long, short()], { ...opts, timeoutSec: null })).toMatchObject({ makerLeg: 'auto', timeoutSec: null });
  });

  it('typed price turns re-peg off and pins the leg the price was typed for', () => {
    expect(map([long, short({ pegToTouch: undefined })], opts)).toMatchObject({
      makerLeg: 'b',
      pricePolicy: 'fixed',
      price: '2500',
      repegBehindBp: null,
    });
  });

  it('twap on slices as reduce-only makers on a single close', () => {
    const close: ActionInput = { kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT', makerPrice: '2500', slippagePct: 1 };
    expect(map([close], { ...opts, timeoutSec: 144, clipBandPct: 0.5 })).toEqual({
      id: 'd1',
      a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', reduceOnly: true },
      qty: '0.05',
      execution: 'maker',
      price: '2500',
      pricePolicy: 'touch',
      timeoutSec: 144,
      repegBehindBp: 5,
      clipBandPct: 0.5,
    });
  });

  it('refuses a single maker close with no starting price', () => {
    expect(map([{ kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT' }], opts)).toBeNull();
  });

  it('without opts a single close stays a reduce-only taker', () => {
    expect(map([{ kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT', makerPrice: '2500' }], undefined)?.execution).toBe('taker');
  });

  it('market slippage goes as clipBandPct on a maker pair close', () => {
    const actions: ActionInput[] = [
      { kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT', pairRole: 'maker', makerPrice: '2500', slippagePct: 1 },
      { kind: 'close-position', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', pairRole: 'hedge', slippagePct: 1 },
    ];
    expect(map(actions, { ...opts, clipBandPct: 0.5 })).toMatchObject({
      a: { symbol: 'GATE_FUTURE_ETH_USDT', reduceOnly: true },
      b: { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', reduceOnly: true },
      makerLeg: 'auto',
      clipBandPct: 0.5,
      timeoutSec: 240,
      repegBehindBp: 5,
    });
  });

  it('a single limit with opts carries the taker after and re-peg', () => {
    const limit: ActionInput = { kind: 'open-limit', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '0.05', price: '2500', tif: 'POC', pegToTouch: true };
    expect(map([limit], { ...opts, timeoutSec: 120 })).toMatchObject({ pricePolicy: 'touch', timeoutSec: 120, repegBehindBp: 5 });
    expect(map([limit], undefined)).not.toHaveProperty('timeoutSec');
  });
});

describe('twapStartFrom', () => {
  it('wraps the deal body without its id', () => {
    const plan = { slices: 12, sliceQty: '57.803', lastQty: '57.807', intervalSec: 300, durationSec: 3600, takerAfterSec: 240 };
    const deal = { id: 'c1', a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' as const }, qty: '693.64', execution: 'maker' as const };
    expect(twapStartFrom(deal, plan, 'client-1')).toEqual({
      kind: 'twap',
      clientId: 'client-1',
      deal: { a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' }, qty: '693.64', execution: 'maker' },
      durationSec: 3600,
      slices: 12,
    });
  });
});
