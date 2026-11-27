/**
 * POST /api/preview via makeTestApp + nock. Venue orderbooks are NOT mocked, so
 * fetchVenueBook fails against the disabled network and estimateFill degrades to the
 * reference+spread fallback — which we drive by mocking the Gate spot ticker
 * (resolveReferencePrice → /spot/tickers). Covers fill/fee estimates, an inline
 * (non-400) violation, and shared pair sizing.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import type { PreviewResult } from '../../src/core/actions';
import type { TwapPreview } from '../../src/core/preview';
import { gate, HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const RULES = 'rule-symbols.json';
type TwapResponse = TwapPreview & { previews: PreviewResult[] };
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  nock.cleanAll();
});

/** Gate spot ticker for `pair` → drives resolveReferencePrice (times to absorb retries). */
function mockSpotTicker(pair: string, last: string): void {
  gate().get('/api/v4/spot/tickers').query(true).times(4).reply(200, [{ currency_pair: pair, last }]);
}

async function preview(actions: unknown[]): Promise<{ status: number; previews: PreviewResult[] }> {
  const res = await app.inject({ method: 'POST', url: '/api/preview', headers: HOST, payload: { actions } });
  return { status: res.statusCode, previews: res.json().data?.previews as PreviewResult[] };
}

describe('POST /api/preview', () => {
  it('a market action gets a fillEstimate (reference+spread fallback) and a taker fee estimate', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: RULES });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('ETH_USDT', '2000');

    const { status, previews } = await preview([
      { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '0.05' },
    ]);

    expect(status).toBe(200);
    const p = previews[0];
    expect(p.fillEstimate).toMatchObject({ source: 'reference+spread', confidence: 'low', venue: 'GATE' });
    expect(p.fillEstimate!.avgPrice).toBeCloseTo(2000 * 1.001, 4); // BUY + 10bps default spread
    // GATE future taker rate 0.00048; notional ≈ 0.05 × 2002.
    expect(p.fees?.takerRate).toBe(0.00048);
    expect(p.fees?.est.taker).toBeCloseTo(0.05 * (2000 * 1.001) * 0.00048, 6);
  });

  it('an open that takes the position past the largest CrossEx takes is a violation', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: RULES });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('ETH_USDT', '2000');
    // 25x to $50M (5x past it, never reached). Holding 20,000 long = $40M.
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });
    mockGateGet('/positions', { body: [{ symbol: 'GATE_FUTURE_ETH_USDT', position_qty: '20000' }] });

    const { previews } = await preview([
      { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '6000', leverage: 25 },
      { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', qty: '6000', leverage: 25 },
    ]);

    const [buy, sell] = previews.map((p) => p.violations.map((v) => v.code));
    expect(buy).toContain('exceeds-max-position');
    expect(previews[0].violations.find((v) => v.code === 'exceeds-max-position')?.message).toMatch(
      /^This open takes GATE_FUTURE_ETH_USDT to \$52,\d{3},\d{3}, above its limit of \$49,000,000 \(2% under the CrossEx risk-limit cap\)$/,
    );
    // Selling shrinks the long: no cap to pass.
    expect(sell).not.toContain('exceeds-max-position');
  });

  it('a sell that shrinks a position above the cap is no violation', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: RULES });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('ETH_USDT', '2000');
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });
    // Holding 26,000 long = $52M, above the $49M limit; selling 1,000 leaves $50M.
    mockGateGet('/positions', { body: [{ symbol: 'GATE_FUTURE_ETH_USDT', position_qty: '26000' }] });

    const { previews } = await preview([
      { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'SELL', qty: '1000', leverage: 25 },
    ]);

    expect(previews[0].violations.map((v) => v.code)).not.toContain('exceeds-max-position');
  });

  it('a below-min-notional action returns a STRUCTURED violation inline, not a 400', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: RULES });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('ETH_USDT', '2000');

    // BINANCE_FUTURE_ETH_USDT: min_notional 20, lot/min_size 0.004 → 0.004×2000 = $8 < $20.
    const { status, previews } = await preview([
      { kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty: '0.004' },
    ]);

    expect(status).toBe(200); // preview never 400s on a per-action violation
    expect(previews[0].violations.map((v) => v.code)).toContain('below-min-notional');
    expect(previews[0].fillEstimate).toBeUndefined(); // estimates are skipped when a violation exists
  });

  it('a delta-neutral pair sized from notional resolves BOTH legs to the SAME shared qty', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: RULES });
    mockGateGet('/fee', { fixture: 'fee.json' });
    mockSpotTicker('ETH_USDT', '2000');

    const { status, previews } = await preview([
      { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', notional: '100', pairGroupId: 'pg' },
      { kind: 'open-market', symbol: 'BYBIT_FUTURE_ETH_USDT', side: 'SELL', notional: '100', pairGroupId: 'pg' },
    ]);

    expect(status).toBe(200);
    expect(previews[0].violations).toEqual([]);
    expect(previews[1].violations).toEqual([]);
    // 100 / 2000 = 0.05, on lot 0.01 for both legs.
    expect(previews[0].qty).toBe('0.05');
    expect(previews[1].qty).toBe(previews[0].qty); // shared sizing binds both legs
    expect(previews[0].fillEstimate?.source).toBe('reference+spread');
    expect(previews[1].fillEstimate?.source).toBe('reference+spread');
  });
});

type BookLevel = [string, string];

function mockGateBook(bids: BookLevel[], asks: BookLevel[]): void {
  const toGate = (levels: BookLevel[]) => levels.map(([p, qty]) => ({ p, s: Math.round(Number(qty) / 0.01) }));
  gate()
    .get(/\/api\/v4\/futures\/usdt\/contracts\//)
    .query(true)
    .reply(200, { quanto_multiplier: '0.01', order_price_round: '0.05' })
    .persist();
  gate()
    .get('/api/v4/futures/usdt/order_book')
    .query(true)
    .reply(200, { bids: toGate(bids), asks: toGate(asks) })
    .persist();
}

function mockBinanceBook(bids: BookLevel[], asks: BookLevel[]): void {
  nock('https://fapi.binance.com').get('/fapi/v1/depth').query(true).reply(200, { bids, asks }).persist();
}

function mockPairStack(): void {
  app = makeTestApp();
  mockGateGet('/rule/symbols', { fixture: RULES });
  mockGateGet('/fee', { fixture: 'fee.json' });
  mockSpotTicker('ETH_USDT', '2000');
  mockGateBook([['1999.5', '500']], [['2000.5', '1'], ['2001.5', '1']]);
  mockBinanceBook([['1999.5', '1'], ['1998.5', '1'], ['1997.5', '100']], [['2000.5', '100']]);
}

async function previewTwap(actions: unknown[], twap?: unknown): Promise<{ status: number; data: TwapResponse }> {
  const res = await app.inject({ method: 'POST', url: '/api/preview', headers: HOST, payload: { actions, twap } });
  return { status: res.statusCode, data: res.json().data as TwapResponse };
}

const pair = (qty: string) => [
  { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty },
  { kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL', qty },
];

describe('POST /api/preview with twap', () => {
  it('a pair gets the maker leg, the price impact and the default 1h 12 slice plan', async () => {
    mockPairStack();

    const { status, data } = await previewTwap(pair('1'));

    expect(status).toBe(200);
    expect(data.makerLeg).toEqual({ auto: 'a', why: 'book' });
    expect(data.twap).toEqual({
      plan: { slices: 12, sliceQty: '0.08', lastQty: '0.12', intervalSec: 300, durationSec: 3600, takerAfterSec: 240 },
      refusal: null,
    });
    expect(data.priceImpact?.whole).toBeCloseTo(1, 6);
    expect(data.priceImpact?.sliced).toBeCloseTo(1, 6);
  });

  it('twap whole-size impact past the book', async () => {
    mockPairStack();

    const { status, data } = await previewTwap(pair('3'), { durationSec: 3600, slices: 12 });

    expect(status).toBe(200);
    expect(data.makerLeg).toEqual({ auto: 'a', why: 'book' });
    expect(data.priceImpact?.whole).toBeNull();
    expect(data.priceImpact?.sliced).toBeCloseTo(3, 6);
    expect(data.priceImpact?.slicedLegs).toHaveLength(2);
    const [gateLeg, binanceLeg] = data.priceImpact?.slicedLegs ?? [];
    expect(gateLeg + binanceLeg).toBeCloseTo(3, 6);
    expect(data.twap?.plan).toMatchObject({ slices: 12, sliceQty: '0.24', lastQty: '0.36' });
    expect(data.twap?.refusal).toBeNull();
  });

  it('a single leg under one lot gets the venue minimum line, not a plan of nothing', async () => {
    mockPairStack();

    const { status, data } = await previewTwap([{ kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', notional: '1' }]);

    expect(status).toBe(200);
    expect(data.twap?.plan).toBeNull();
    expect(data.twap?.refusal?.field).toBe('sliceSize');
    expect(data.twap?.refusal?.text).toMatch(/^Too small for 2 slices: Binance takes at least \S+ ETH \(\$\S+\) a slice\.$/);
  });

  it('a single leg gets the plan and its price impact, and a slice past the book is refused with the largest that fits', async () => {
    mockPairStack();

    const { status, data } = await previewTwap(
      [{ kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '3' }],
      { intervalSec: 300, sliceQty: '2.5' },
    );

    expect(status).toBe(200);
    expect(data.makerLeg).toBeNull();
    expect(data.priceImpact?.whole).toBeNull();
    expect(data.priceImpact?.sliced).toBeCloseTo(3, 6);
    expect(data.twap?.refusal).toEqual({
      field: 'sliceSize',
      text: 'Book too thin for 2.5 ETH a slice.',
      fix: { label: 'Use 2 ETH', patch: { intervalSec: 300, sliceQty: '2' } },
    });
    expect(data.twapDefault?.on).toBe(true);
  });

  it('the TWAP default comes from the books even when TWAP is off', async () => {
    mockPairStack();

    const { data } = await previewTwap(pair('3'));

    expect(data.twapDefault?.on).toBe(true);
  });

  describe('close perps with unequal legs', () => {
    const rule = (symbol: string, lot: string) => ({
      symbol,
      exchange_type: symbol.split('_')[0],
      business_type: 'FUTURE',
      state: 'live',
      min_size: lot,
      min_notional: '10',
      lot_size: lot,
      tick_size: '0.1',
      max_num_orders: '100',
      max_market_size: null,
      max_limit_size: null,
      contract_size: '1',
      liquidation_fee: '0.001',
      delist_time: '0',
    });
    const position = (symbol: string, qty: string, mark: string) => ({
      symbol,
      position_side: Number(qty) < 0 ? 'SHORT' : 'LONG',
      position_qty: qty,
      position_value: '1000',
      entry_price: mark,
      mark_price: mark,
      leverage: '5',
      upnl: '0',
      funding_fee: '0',
      fee: '0',
      initial_margin: '200',
    });
    const closeStack = (coin: string, mark: string, held: Array<[string, string, string]>) => {
      app = makeTestApp();
      mockGateGet('/rule/symbols', { body: held.map(([symbol, , lot]) => rule(symbol, lot)), times: 10 });
      mockGateGet('/fee', { fixture: 'fee.json', times: 10 });
      mockGateGet('/positions', { body: held.map(([symbol, qty]) => position(symbol, qty, mark)), times: 10 });
      mockSpotTicker(`${coin}_USDT`, mark);
    };
    const close = (symbol: string, qty?: string) => ({ kind: 'close-position', symbol, slippagePct: 0.5, pairGroupId: 'pg', ...(qty ? { qty } : {}) });

    it('gate 4.40 against hyperliquid 4.03 btc plans 4.03 on both legs and leaves 0.37 on gate', async () => {
      closeStack('BTC', '90000', [
        ['GATE_FUTURE_BTC_USDT', '4.4', '0.0001'],
        ['HYPERLIQUID_FUTURE_BTC_USDC', '-4.03', '0.00001'],
      ]);

      const whole = await previewTwap([close('GATE_FUTURE_BTC_USDT'), close('HYPERLIQUID_FUTURE_BTC_USDC')]);
      expect(whole.data.twap).toBeNull();

      const { status, data } = await previewTwap([close('GATE_FUTURE_BTC_USDT', '4.03'), close('HYPERLIQUID_FUTURE_BTC_USDC')]);
      expect(status).toBe(200);
      expect(data.previews.map((p) => Number(p.qty))).toEqual([4.03, 4.03]);
      expect(data.previews.map((p) => p.reduceOnly)).toEqual([true, true]);
      expect(data.twap?.refusal).toBeNull();
      expect(data.twap?.plan).toMatchObject({ slices: 12, sliceQty: '0.3358', lastQty: '0.3362' });
      expect(Number(data.previews[0].closing?.positionQty) - Number(data.previews[0].qty)).toBeCloseTo(0.37, 12);
    });

    it('a $6M book of 1,000.37 against 1,000 eth plans 1000 on both legs', async () => {
      closeStack('ETH', '6000', [
        ['GATE_FUTURE_ETH_USDT', '1000.37', '0.001'],
        ['HYPERLIQUID_FUTURE_ETH_USDC', '-1000', '0.0001'],
      ]);

      const { status, data } = await previewTwap([close('GATE_FUTURE_ETH_USDT', '1000'), close('HYPERLIQUID_FUTURE_ETH_USDC')]);

      expect(status).toBe(200);
      expect(data.previews.map((p) => Number(p.qty))).toEqual([1000, 1000]);
      expect(data.twap?.refusal).toBeNull();
      expect(data.twap?.plan).toMatchObject({ slices: 12, sliceQty: '83.333', lastQty: '83.337' });
    });

    it('equal legs plan their whole size', async () => {
      closeStack('BTC', '90000', [
        ['GATE_FUTURE_BTC_USDT', '4.03', '0.0001'],
        ['HYPERLIQUID_FUTURE_BTC_USDC', '-4.03', '0.00001'],
      ]);

      const { data } = await previewTwap([close('GATE_FUTURE_BTC_USDT'), close('HYPERLIQUID_FUTURE_BTC_USDC')]);

      expect(data.twap?.plan).toMatchObject({ slices: 12, sliceQty: '0.3358', lastQty: '0.3362' });
    });
  });

  it('a twap with one field or a wrong type is a 400', async () => {
    mockPairStack();

    expect((await previewTwap(pair('1'), { durationSec: 3600 })).status).toBe(400);
    expect((await previewTwap(pair('1'), { durationSec: 3600, slices: '12' })).status).toBe(400);
  });
});
