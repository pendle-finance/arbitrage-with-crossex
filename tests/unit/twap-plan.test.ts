import { describe, expect, it } from 'vitest';
import { fx, fxStr } from '../../src/engine/fx';
import { planSlices, takerAfterCapSec, TWAP_LIMITS, type TwapInput, type TwapLegRule, type TwapPlan } from '../../src/core/twap';

const leg = (venue: string, coin: string, lot: string, minSize: string, minNotional: string, maxMarketSize: string | null, maxLimitSize: string | null): TwapLegRule => ({
  venue,
  coin,
  lot,
  minSize,
  minNotional,
  maxMarketSize,
  maxLimitSize,
});

const BTC = [leg('GATE', 'BTC', '0.0001', '0.0001', '0', '1200', '1200'), leg('BINANCE', 'BTC', '0.001', '0.001', '50', '120', '1000')];
const ETH = [leg('GATE', 'ETH', '0.001', '0.001', '0', '100000', '100000'), leg('BINANCE', 'ETH', '0.001', '0.001', '20', '2000', '10000')];
const ETH_HL = [leg('GATE', 'ETH', '0.001', '0.001', '0', '100000', '100000'), leg('HYPERLIQUID', 'ETH', '0.0001', '0.0001', '10', null, null)];
const BTC_MARK = 90_000;
const ETH_MARK = 1_730;

function expectWholeLots(plan: TwapPlan, total: string, lot: string): void {
  const step = fx(lot);
  expect(fx(plan.sliceQty) % step).toBe(0n);
  expect(fx(plan.lastQty) % step).toBe(0n);
  const sum = fx(plan.sliceQty) * BigInt(plan.slices - 1) + fx(plan.lastQty);
  expect(fxStr(sum)).toBe(fxStr((fx(total) / step) * step));
}

function okPlan(total: string, input: TwapInput, legs: TwapLegRule[], mark: number, book?: string | null): TwapPlan {
  const result = planSlices(total, input, legs, mark, book);
  if (!result.ok) throw new Error(`refused: ${result.refusal.text}`);
  return result.plan;
}

function refusalOf(total: string, input: TwapInput, legs: TwapLegRule[], mark: number, book?: string | null) {
  const result = planSlices(total, input, legs, mark, book);
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

describe('planSlices', () => {
  it('any two of three fixes the third', () => {
    const bySize = okPlan('693.64', { durationSec: 3600, sliceQty: '50' }, ETH, ETH_MARK);
    expect(bySize).toEqual({ slices: 14, sliceQty: '50', lastQty: '43.64', intervalSec: 257, durationSec: 3600, takerAfterSec: 205 });
    const byInterval = okPlan('693.64', { durationSec: 3600, intervalSec: 300 }, ETH, ETH_MARK);
    expect(byInterval.slices).toBe(12);
    expect(byInterval.intervalSec).toBe(300);
    const byIntervalAndSize = okPlan('693.64', { intervalSec: 300, sliceQty: '50' }, ETH, ETH_MARK);
    expect(byIntervalAndSize.slices).toBe(14);
    expect(byIntervalAndSize.durationSec).toBe(4200);
    expectWholeLots(byIntervalAndSize, '693.64', '0.001');
  });

  it('last slice takes the rest in whole lots', () => {
    const plan = okPlan('693.64', { durationSec: 3600, slices: 12 }, ETH, ETH_MARK);
    expect(plan).toEqual({ slices: 12, sliceQty: '57.803', lastQty: '57.807', intervalSec: 300, durationSec: 3600, takerAfterSec: 240 });
    expectWholeLots(plan, '693.64', '0.001');
  });

  it('a rest under the venue minimum joins the last slice', () => {
    const plan = okPlan('100.005', { durationSec: 3600, sliceQty: '10' }, ETH, ETH_MARK);
    expect(plan.slices).toBe(10);
    expect(plan.lastQty).toBe('10.005');
    expectWholeLots(plan, '100.005', '0.001');
  });

  it('names the minimum and the largest interval', () => {
    const result = refusalOf('0.003', { durationSec: 3600, intervalSec: 300 }, BTC, BTC_MARK);
    expect(result.refusal).toEqual({
      field: 'sliceSize',
      text: 'Binance takes at least 0.001 BTC ($90) a slice.',
      fix: { label: 'Use 20m interval', patch: { durationSec: 3600, intervalSec: 1200 } },
    });
    expect(result.plan).toBeNull();
    const fixed = okPlan('0.003', { durationSec: 3600, intervalSec: 1200 }, BTC, BTC_MARK);
    expect(fixed.slices).toBe(3);
    expect(fixed.sliceQty).toBe('0.001');
  });

  it('too small to split', () => {
    const result = refusalOf('0.00166', { durationSec: 3600, intervalSec: 300 }, BTC, BTC_MARK);
    expect(result.refusal).toEqual({
      field: 'sliceSize',
      text: 'Too small for 2 slices: Binance takes at least 0.001 BTC ($90) a slice.',
      fix: { label: 'Turn TWAP off', patch: {} },
    });
  });

  it('interval under a minute', () => {
    const result = refusalOf('693.64', { durationSec: 300, intervalSec: 30 }, ETH, ETH_MARK);
    expect(result.refusal).toEqual({
      field: 'interval',
      text: 'Interval at least 1m.',
      fix: { label: 'Use 1m', patch: { durationSec: 300, intervalSec: 60 } },
    });
  });

  it('more than 100 slices', () => {
    const result = refusalOf('693.64', { intervalSec: 300, sliceQty: '5' }, ETH, ETH_MARK);
    expect(result.refusal.field).toBe('sliceSize');
    expect(result.refusal.text).toBe('139 slices. Max 100: slice size at least 6.937 ETH.');
    expect(result.refusal.fix).toEqual({ label: 'Use 6.937 ETH', patch: { intervalSec: 300, sliceQty: '6.937' } });
    expect(okPlan('693.64', { intervalSec: 300, sliceQty: '6.937' }, ETH, ETH_MARK).slices).toBe(100);
    const typed = refusalOf('693.64', { durationSec: 86_400, slices: 101 }, ETH, ETH_MARK);
    expect(typed.refusal.text.startsWith('101 slices. Max 100')).toBe(true);
  });

  it('duration out of range', () => {
    const short = refusalOf('693.64', { durationSec: 240, intervalSec: 60 }, ETH, ETH_MARK);
    expect(short.refusal).toEqual({
      field: 'duration',
      text: 'Duration at least 5m.',
      fix: { label: 'Use 5m', patch: { durationSec: 300, intervalSec: 60 } },
    });
    const long = refusalOf('693.64', { durationSec: 90_000, slices: 12 }, ETH, ETH_MARK);
    expect(long.refusal).toEqual({
      field: 'duration',
      text: 'Duration at most 24h.',
      fix: { label: 'Use 24h', patch: { durationSec: 86_400, slices: 12 } },
    });
  });

  it('slice past the book', () => {
    const result = refusalOf('60', { durationSec: 3600, sliceQty: '15' }, BTC, BTC_MARK, '9');
    expect(result.refusal).toEqual({
      field: 'sliceSize',
      text: 'Book too thin for 15 BTC a slice.',
      fix: { label: 'Use 9 BTC', patch: { durationSec: 3600, sliceQty: '9' } },
    });
    expect(okPlan('60', { durationSec: 3600, sliceQty: '9' }, BTC, BTC_MARK, '9').slices).toBe(7);
  });

  it('a slice over a venue maximum moves to more slices', () => {
    const result = refusalOf('300', { durationSec: 3600, slices: 2 }, BTC, BTC_MARK);
    expect(result.refusal.text).toBe('Binance takes at most 120 BTC a slice.');
    expect(result.refusal.fix).toEqual({ label: 'Use 20m interval', patch: { durationSec: 3600, intervalSec: 1200 } });
  });

  it('one slice or none is refused with a fix', () => {
    const bySize = refusalOf('693.64', { durationSec: 3600, sliceQty: '800' }, ETH, ETH_MARK);
    expect(bySize.refusal.text).toBe('1 slice. Min 2: slice size at most 346.82 ETH.');
    expect(bySize.refusal.fix?.patch).toEqual({ durationSec: 3600, sliceQty: '346.82' });
    const byInterval = refusalOf('693.64', { durationSec: 3600, intervalSec: 7200 }, ETH, ETH_MARK);
    expect(byInterval.plan).toBeNull();
    expect(byInterval.refusal).toEqual({
      field: 'interval',
      text: 'Interval at most 30m.',
      fix: { label: 'Use 30m', patch: { durationSec: 3600, intervalSec: 1800 } },
    });
  });

  it('every fix it offers leads to a plan it accepts', () => {
    const inputs: TwapInput[] = [
      { durationSec: 3600, slices: 12 },
      { durationSec: 300, slices: 12 },
      { durationSec: 86_400, intervalSec: 30 },
      { durationSec: 600, intervalSec: 60 },
      { durationSec: 90_000, intervalSec: 300 },
      { durationSec: 3600, sliceQty: '0.0005' },
      { intervalSec: 3600, sliceQty: '0.001' },
      { intervalSec: 45, sliceQty: '1' },
    ];
    for (const total of ['0.0029', '0.0123', '1.5', '66.67', '700']) {
      for (const input of inputs) {
        const result = planSlices(total, input, BTC, BTC_MARK, '40');
        if (result.ok || !result.refusal.fix || result.refusal.fix.label === 'Turn TWAP off') continue;
        const fixed = planSlices(total, result.refusal.fix.patch, BTC, BTC_MARK, '40');
        expect(fixed.ok, `${total} ${JSON.stringify(input)}`).toBe(true);
      }
    }
  });

  it('plan at every rung from $50 to $6M', () => {
    const rungs = ['0.0289999999', '2.8999999999', '57.8039999999', '578.0349999999', '3467.9999999999'];
    for (const total of rungs) {
      for (const slices of [2, 12, 100]) {
        const result = planSlices(total, { durationSec: 86_400, slices }, ETH, ETH_MARK);
        const plan = result.ok ? result.plan : okPlan(total, result.refusal.fix?.patch ?? {}, ETH, ETH_MARK);
        expectWholeLots(plan, total, '0.001');
        expect(plan.slices).toBeGreaterThanOrEqual(TWAP_LIMITS.minSlices);
        expect(plan.slices).toBeLessThanOrEqual(TWAP_LIMITS.maxSlices);
        expect(fx(plan.sliceQty)).toBeGreaterThanOrEqual(fx('0.012'));
      }
    }
    const whale = okPlan('3468', { durationSec: 86_400, slices: 100 }, ETH, ETH_MARK);
    expect(whale).toMatchObject({ slices: 100, sliceQty: '34.68', lastQty: '34.68', intervalSec: 864 });
    const twoSlices = okPlan('3467.9999999999', { durationSec: 3600, slices: 2 }, ETH, ETH_MARK);
    expect(twoSlices).toMatchObject({ sliceQty: '1733.999', lastQty: '1734' });
    const tiny = refusalOf('0.0289999999', { durationSec: 3600, slices: 12 }, ETH, ETH_MARK);
    expect(tiny.refusal.text).toBe('Binance takes at least 0.012 ETH ($21) a slice.');
    expect(tiny.refusal.fix).toEqual({ label: 'Use 30m interval', patch: { durationSec: 3600, intervalSec: 1800 } });
    const hl = okPlan('3467.99999', { durationSec: 3600, slices: 12 }, ETH_HL, ETH_MARK);
    expectWholeLots(hl, '3467.99999', '0.001');
  });

  it('rule strings and sci-notation parse at the boundary', () => {
    const sci = [leg('GATE', 'BTC', '1e-4', '1e-04', '0', '1.2e3', '1200'), leg('BINANCE', 'BTC', '1e-3', '0.001', '5e1', '1.2E+2', '1e3')];
    const plain = planSlices('0.003', { durationSec: 3600, intervalSec: 300 }, BTC, BTC_MARK);
    expect(planSlices('3e-3', { durationSec: 3600, intervalSec: 300 }, sci, BTC_MARK)).toEqual(plain);
    expect(planSlices('6.9364e2', { durationSec: 3600, slices: 12 }, ETH, ETH_MARK)).toEqual(planSlices('693.64', { durationSec: 3600, slices: 12 }, ETH, ETH_MARK));
    const hlSci = [leg('GATE', 'ETH', '0.001', '0.001', '0', '100000', '100000'), leg('HYPERLIQUID', 'ETH', '1e-05', '1e-05', '10', null, null)];
    expect(okPlan('1', { durationSec: 3600, slices: 12 }, hlSci, ETH_MARK).sliceQty).toBe('0.083');
    expect(() => planSlices('1', { durationSec: 3600, slices: 12 }, [leg('GATE', 'ETH', 'abc', '0', '0', null, null)], ETH_MARK)).toThrow(/not a decimal/);
    expect(() => planSlices('1', { durationSec: 3600, slices: 12 }, ETH, 0)).toThrow(/mark/);
    expect(() => planSlices('1', { durationSec: 3600 }, ETH, ETH_MARK)).toThrow(/two of/);
  });
});

describe('takerAfterCapSec', () => {
  it('is 80% of the interval, floored to the second', () => {
    expect(takerAfterCapSec(300)).toBe(240);
    expect(takerAfterCapSec(720)).toBe(576);
    expect(takerAfterCapSec(257)).toBe(205);
    expect(takerAfterCapSec(60)).toBe(48);
  });
});
