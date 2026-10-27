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
import { gate, HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const RULES = 'rule-symbols.json';
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
      /^this open takes the GATE_FUTURE_ETH_USDT position to \$52,\d{3},\d{3}, above its \$49,000,000 limit \(2% under the CrossEx risk-limit cap\)$/,
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
