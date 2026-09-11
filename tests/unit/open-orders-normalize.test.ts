/**
 * Gate stringifies `reduceOnly`. `OpenOrder` types it `boolean`, and the body
 * reaches the web verbatim — so `"false"` was truthy and every resting order
 * wore the reduce-only badge, opening orders included.
 */
import { describe, expect, it } from 'vitest';
import { normalizeOpenOrders } from '../../src/server/routes/orders';

const order = (reduceOnly: unknown) => ({
  orderId: '2209629157209856',
  symbol: 'GATE_FUTURE_ETH_USDT',
  side: 'BUY',
  qty: '0.005',
  reduceOnly,
});

const first = (body: unknown) => (body as { reduceOnly: unknown }[])[0].reduceOnly;

describe('normalizeOpenOrders', () => {
  it('reads Gate\'s "false" as false, not as a truthy string', () => {
    expect(first(normalizeOpenOrders([order('false')]))).toBe(false);
  });

  it('reads "true" as true', () => {
    expect(first(normalizeOpenOrders([order('true')]))).toBe(true);
    expect(first(normalizeOpenOrders([order('True')]))).toBe(true);
  });

  it('passes a real boolean through unchanged', () => {
    expect(first(normalizeOpenOrders([order(true)]))).toBe(true);
    expect(first(normalizeOpenOrders([order(false)]))).toBe(false);
  });

  it('treats anything else as not reduce-only rather than guessing', () => {
    expect(first(normalizeOpenOrders([order(undefined)]))).toBe(false);
    expect(first(normalizeOpenOrders([order(null)]))).toBe(false);
    expect(first(normalizeOpenOrders([order('')]))).toBe(false);
  });

  it('leaves every other field alone', () => {
    const [out] = normalizeOpenOrders([order('false')]) as Record<string, unknown>[];
    expect(out.qty).toBe('0.005');
    expect(out.side).toBe('BUY');
    expect(out.orderId).toBe('2209629157209856');
  });

  it('passes a non-array body through untouched', () => {
    const body = { message: 'Route not found' };
    expect(normalizeOpenOrders(body)).toBe(body);
    expect(normalizeOpenOrders(null)).toBe(null);
  });

  it('skips entries with no reduceOnly field', () => {
    const rows = [{ orderId: '1' }, order('true')];
    const out = normalizeOpenOrders(rows) as Record<string, unknown>[];
    expect(out[0]).toEqual({ orderId: '1' });
    expect(out[1].reduceOnly).toBe(true);
  });
});
