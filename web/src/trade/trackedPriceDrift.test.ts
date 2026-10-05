import { describe, expect, it } from 'vitest';
import { TRACKED_PRICE_TOLERANCE, withinTrackedDrift } from './trackedPriceDrift';

const maker = (price: string, over: Record<string, unknown> = {}) => ({
  kind: 'open-limit',
  symbol: 'GATE_PERP_ETH_USDT',
  side: 'BUY',
  qty: '1',
  price,
  tif: 'POC',
  pairRole: 'maker',
  makerTimeoutSec: 300,
  pairGroupId: 'g',
  ...over,
});
const hedge = (over: Record<string, unknown> = {}) => ({
  kind: 'open-market',
  symbol: 'HYPERLIQUID_PERP_ETH_USDC',
  side: 'SELL',
  qty: '1',
  pairRole: 'hedge',
  pairGroupId: 'g',
  ...over,
});

describe('withinTrackedDrift', () => {
  it('keeps the preview for a tracked price that moved within 5 bps', () => {
    // His live log: 2675.72 → 2675.44 in one cycle, ~1 bp.
    expect(withinTrackedDrift([maker('2675.72'), hedge()], [maker('2675.44'), hedge()], TRACKED_PRICE_TOLERANCE)).toBe(true);
    // Key order is not part of the order.
    const { price, ...rest } = maker('2675.44');
    expect(withinTrackedDrift([maker('2675.72')], [{ price, ...rest }], TRACKED_PRICE_TOLERANCE)).toBe(true);
  });

  it('asks for a fresh preview once the price moved more than 5 bps', () => {
    // 2675.72 × (1 − 0.0006) ≈ 2674.11: 6 bps.
    expect(withinTrackedDrift([maker('2675.72'), hedge()], [maker('2674.11'), hedge()], TRACKED_PRICE_TOLERANCE)).toBe(false);
  });

  it('treats any other change as a new order, however small the price move', () => {
    expect(withinTrackedDrift([maker('2675'), hedge()], [maker('2675', { qty: '2' }), hedge({ qty: '2' })], TRACKED_PRICE_TOLERANCE)).toBe(false);
    expect(withinTrackedDrift([maker('2675'), hedge()], [maker('2675'), hedge({ symbol: 'OKX_PERP_ETH_USDT' })], TRACKED_PRICE_TOLERANCE)).toBe(false);
    expect(withinTrackedDrift([maker('2675')], [maker('2675', { makerTimeoutSec: 60 })], TRACKED_PRICE_TOLERANCE)).toBe(false);
  });

  it('never tolerates a price on anything but the maker leg', () => {
    const limit = (price: string) => ({ kind: 'open-limit', symbol: 'X', side: 'BUY', qty: '1', price });
    expect(withinTrackedDrift([limit('100')], [limit('100.01')], TRACKED_PRICE_TOLERANCE)).toBe(false);
  });

  it('refuses missing or unusable prices and mismatched shapes', () => {
    expect(withinTrackedDrift([maker('')], [maker('2675')], TRACKED_PRICE_TOLERANCE)).toBe(false);
    expect(withinTrackedDrift([maker('2675'), hedge()], [maker('2675')], TRACKED_PRICE_TOLERANCE)).toBe(false);
    expect(withinTrackedDrift([], [], TRACKED_PRICE_TOLERANCE)).toBe(false);
  });
});
