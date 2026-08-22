import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

interface SymbolRow {
  symbol: string;
  exchange: string;
  base: string;
  quote: string;
  tickSize: string;
}

describe('GET /api/symbols', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('?q=eth matches base case-insensitively (live FUTURE rows only)', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });

    const res = await app.inject({ method: 'GET', url: '/api/symbols?q=eth', headers: HOST });

    expect(res.statusCode).toBe(200);
    const rows: SymbolRow[] = res.json().data;
    expect(rows.map((r) => r.symbol).sort()).toEqual([
      'BINANCE_FUTURE_ETH_USDT',
      'BYBIT_FUTURE_ETH_USDT',
      'GATE_FUTURE_ETH_USDT',
      'OKX_FUTURE_ETH_USDT',
    ]); // GATE_SPOT_ETH_USDT is filtered out (not FUTURE)
    expect(rows.every((r) => r.base === 'ETH')).toBe(true);
  });

  it('?exchange=GATE matches exactly; delisting symbols are excluded', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });

    const res = await app.inject({ method: 'GET', url: '/api/symbols?exchange=GATE', headers: HOST });

    const rows: SymbolRow[] = res.json().data;
    expect(rows.map((r) => r.symbol).sort()).toEqual(['GATE_FUTURE_ETH_USDT', 'GATE_FUTURE_SOL_USDT']);
    // GATE_FUTURE_DOGE_USDT (state=delisting) never appears.
  });

  it('?multiOnly=1 keeps multi-venue bases and drops singles', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });

    const res = await app.inject({ method: 'GET', url: '/api/symbols?multiOnly=1', headers: HOST });

    const rows: SymbolRow[] = res.json().data;
    const bases = new Set(rows.map((r) => r.base));
    expect(bases.has('ETH')).toBe(true); // 4 venues
    expect(bases.has('BTC')).toBe(true); // HYPERLIQUID + KRAKEN — cross-quote still one base
    expect(bases.has('SOL')).toBe(false); // GATE only
  });

  it('GET /api/symbols/:symbol merges the rule with leverageMax from risk limits', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/symbols/GATE_FUTURE_ETH_USDT',
      headers: HOST,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.symbol).toBe('GATE_FUTURE_ETH_USDT');
    expect(data.exchange).toBe('GATE');
    expect(data.tickSize).toBe('0.01');
    expect(data.leverageMax).toBe(50); // max over the tiers' leverage_max (50, 20)
  });

  it('GET /api/symbols/:symbol stays available with max 0 for tierless risk data', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });
    mockGateGet('/rule/risk_limits', {
      body: [{ symbol: 'GATE_FUTURE_ETH_USDT', tiers: [] }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/symbols/GATE_FUTURE_ETH_USDT',
      headers: HOST,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.leverageMax).toBe(0);
  });

  it('GET /api/symbols/:symbol unknown → 400 symbol-invalid envelope', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', { fixture: 'rule-symbols.json' });

    const res = await app.inject({ method: 'GET', url: '/api/symbols/NOPE_FUTURE_X_USDT', headers: HOST });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.category).toBe('symbol-invalid');
  });
});

describe('excluded USDC twins', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const row = (symbol: string, over: Record<string, unknown> = {}) => ({
    symbol,
    exchange_type: symbol.split('_')[0],
    business_type: 'FUTURE',
    state: 'live',
    min_size: '0.01',
    min_notional: '5',
    lot_size: '0.01',
    tick_size: '0.01',
    max_num_orders: '100',
    max_market_size: '10000',
    max_limit_size: '100000',
    contract_size: '1',
    liquidation_fee: '0.001',
    delist_time: '0',
    ...over,
  });

  // BINANCE/OKX/BYBIT list a USDC-quoted twin of their primary USDT contract —
  // a different book with independently-settled funding, unhedgeable through
  // the Boros markets this terminal tracks. They must not appear in the venue
  // pickers as "the same venue, again". Hyperliquid's USDC is its ONLY quote,
  // not a twin — it stays.
  it('drops BINANCE/OKX/BYBIT USDC twins from the listing but keeps Hyperliquid', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', {
      body: [
        row('BINANCE_FUTURE_BTC_USDT'),
        row('BINANCE_FUTURE_BTC_USDC'),
        row('OKX_FUTURE_BTC_USDC'),
        row('BYBIT_FUTURE_BTC_USDC'),
        row('HYPERLIQUID_FUTURE_BTC_USDC'),
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/symbols', headers: HOST });
    const rows: SymbolRow[] = res.json().data;
    expect(rows.map((r) => r.symbol).sort()).toEqual([
      'BINANCE_FUTURE_BTC_USDT',
      'HYPERLIQUID_FUTURE_BTC_USDC',
    ]);
  });

  it('a twin base does not count toward multiOnly venue counts', async () => {
    app = makeTestApp();
    // SOL exists on BINANCE only via the USDC twin: after exclusion it is a
    // single-venue base and must vanish under ?multiOnly=1.
    mockGateGet('/rule/symbols', {
      body: [
        row('GATE_FUTURE_SOL_USDT'),
        row('BINANCE_FUTURE_SOL_USDC'),
        row('GATE_FUTURE_ETH_USDT'),
        row('BINANCE_FUTURE_ETH_USDT'),
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/symbols?multiOnly=1', headers: HOST });
    const rows: SymbolRow[] = res.json().data;
    expect(rows.every((r) => r.base === 'ETH')).toBe(true);
  });

  it('the by-symbol detail agrees: an excluded twin is not found', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', {
      body: [row('BINANCE_FUTURE_BTC_USDT'), row('BINANCE_FUTURE_BTC_USDC')],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/symbols/BINANCE_FUTURE_BTC_USDC',
      headers: HOST,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.category).toBe('symbol-invalid');
  });
});
