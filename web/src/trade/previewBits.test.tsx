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

  it.each([
    [50, 0.5],
    [500_000, 0.08],
    [6_000_000, 0.3],
  ])('a $%i pair adds the book impact of each leg that crosses (%f%%)', (usd, pct) => {
    const crossing = (impactPct: number) =>
      ({
        qty: '1',
        estNotional: usd,
        fees: { makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT', est: { taker: usd * 0.0005 } },
        fillEstimate: { qty: '1', avgPrice: usd * (1 + impactPct / 100), worstPrice: usd, midPrice: usd, slippagePct: impactPct, source: 'venue-orderbook', confidence: 'high', venue: 'GATE' },
      }) as unknown as PreviewResult;
    const thin = crossing(pct);
    const deep = crossing(0);
    const cost = pairModeFees([thin, deep], 1);
    expect(cost.market).toBeCloseTo(usd * 0.0005 * 2 + (usd * pct) / 100, 6);
    expect(cost.maker).toBeCloseTo(usd * 0.0005 + (usd * pct) / 100 + usd * 0.0002, 6);
    expect(pairModeFees([thin, deep], 0).maker).toBeCloseTo(usd * 0.0002 + usd * 0.0005, 6);
  });

  it.each([
    [500_000, 0.08, 0.3, 0.1],
    [3_000_000, 0.4, 0.2, 0.15],
  ])('with TWAP on, a $%i Limit + hedge counts the sliced impact of the hedge leg alone, and Market keeps one order', (usd, hedgePct, restPct, slicedPct) => {
    const crossing = (impactPct: number) =>
      ({
        qty: '1',
        estNotional: usd,
        fees: { makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT', est: { taker: usd * 0.0005 } },
        fillEstimate: { qty: '1', avgPrice: usd, worstPrice: usd, midPrice: usd, slippagePct: impactPct, source: 'venue-orderbook', confidence: 'high', venue: 'GATE' },
      }) as unknown as PreviewResult;
    const whole = (usd * (hedgePct + restPct)) / 100;
    const hedgeSliced = (usd * slicedPct) / 100;
    const restSliced = (usd * restPct) / 1000;
    const cost = pairModeFees([crossing(hedgePct), crossing(restPct)], 1, [hedgeSliced, restSliced]);
    expect(cost.maker).toBeCloseTo(usd * 0.0002 + usd * 0.0005 + hedgeSliced, 6);
    expect(cost.market).toBeCloseTo(usd * 0.0005 * 2 + whole, 6);
    expect(pairModeFees([crossing(hedgePct), crossing(restPct)], 0, [hedgeSliced, restSliced]).maker).toBeCloseTo(usd * 0.0002 + usd * 0.0005 + restSliced, 6);
  });

  it('a fill better than mid never lowers the cost below the fees', () => {
    const better = { ...hl, fillEstimate: { slippagePct: -0.2, midPrice: 10_000 } } as unknown as PreviewResult;
    expect(pairModeFees([better, gate], 1).market).toBeCloseTo(4.5 + 5, 9);
  });

  it('a missing leg or fee gives no figure', () => {
    expect(pairModeFees([hl, undefined], null)).toEqual({ maker: null, market: null });
    expect(pairModeFees(undefined, null)).toEqual({ maker: null, market: null });
  });
});
