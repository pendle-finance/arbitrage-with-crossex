import { describe, expect, it } from 'vitest';
import '../i18n';
import type { PreviewResult } from '../api/types';
import { feeAmount, feeText, pairModeFees } from './previewBits';

const fees = (est: { taker?: number; maker?: number }) => ({ makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT', est });

describe('ticket fee text at $6M', () => {
  it('groups a taker fee of 2866.53 USDT as 2,866.53', () => {
    expect(feeAmount(fees({ taker: 2866.53 }))).toBe('2,866.53 USDT');
    expect(feeText(fees({ taker: 2866.53 }))).toContain('2,866.53');
  });

  it('groups both ends of a maker to taker range', () => {
    expect(feeAmount(fees({ maker: 1146.91, taker: 2866.53 }))).toBe('1,146.91–2,866.53 USDT');
  });

  it('keeps a small fee as it was', () => {
    expect(feeAmount(fees({ taker: 0.0488 }))).toBe('0.0488 USDT');
  });
});

describe('pair fee for each order choice', () => {
  const leg = (makerRate: number, takerRate: number, est: { maker?: number; taker?: number }) =>
    ({ qty: '1', estNotional: 10_000, fees: { makerRate, takerRate, specialOverride: false, quote: 'USDT', est } }) as unknown as PreviewResult;
  const hl = leg(0.00015, 0.00045, { taker: 4.5 });
  const gate = leg(0.0002, 0.0005, { maker: 2 });

  it('market pays both taker fees; limit + hedge pays the resting leg at maker', () => {
    const gateRests = pairModeFees([hl, gate], 1);
    expect(gateRests.maker).toBeCloseTo(4.5 + 2, 9);
    expect(gateRests.market).toBeCloseTo(4.5 + 5, 9);
    expect(pairModeFees([hl, gate], 0).maker).toBeCloseTo(1.5 + 5, 9);
  });

  it('an auto pick not yet known takes the cheaper resting leg', () => {
    const a = leg(0, 0.0005, { taker: 5 });
    const b = leg(0.0002, 0.0005, { taker: 5 });
    expect(pairModeFees([a, b], null).maker).toBe(5);
  });

  it('a missing leg or fee gives no figure', () => {
    expect(pairModeFees([hl, undefined], null)).toEqual({ maker: null, market: null });
    expect(pairModeFees(undefined, null)).toEqual({ maker: null, market: null });
  });
});
