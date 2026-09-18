import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

interface SymbolRow {
  symbol: string;
  base: string;
}

const row = (symbol: string, exchange: string) => ({
  symbol,
  exchange_type: exchange,
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
});

describe('GET /api/symbols — supported coins', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('keeps only the supported set', async () => {
    app = makeTestApp();
    mockGateGet('/rule/symbols', {
      body: [row('GATE_FUTURE_ETH_USDT', 'GATE'), row('GATE_FUTURE_BTC_USDT', 'GATE'), row('GATE_FUTURE_SOL_USDT', 'GATE')],
    });

    const res = await app.inject({ method: 'GET', url: '/api/symbols', headers: HOST });

    expect(res.statusCode).toBe(200);
    const rows: SymbolRow[] = res.json().data;
    expect(rows.map((r) => r.symbol).sort()).toEqual(['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_ETH_USDT']);
    expect(rows.every((r) => r.base !== 'SOL')).toBe(true);
  });
});
