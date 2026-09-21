import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { resetMarkMemory } from '../../src/core/marks';
import { TtlCache } from '../../src/server/cache';
import { readTriggerCoins } from '../../src/server/telegram/sync';
import type { CrossexAccount, PositionsResponse } from '../../web/src/api/types';
import { liquidationLines } from '../../web/src/lib/liquidation';
import { HOST, makeTestApp, mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const hypeBook = (markPrice: string) => [
  {
    symbol: 'GATE_FUTURE_HYPE_USDT',
    position_side: 'LONG',
    position_qty: '18750',
    position_value: '750000',
    entry_price: '40',
    mark_price: markPrice,
    leverage: '5',
    max_leverage: '25',
    upnl: '0',
    upnl_rate: '0',
    initial_margin: '150000',
    maintenance_margin: '15050',
    fee: '0',
    funding_fee: '0',
  },
  {
    symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
    position_side: 'SHORT',
    position_qty: '-18750',
    position_value: '750000',
    entry_price: '40',
    mark_price: markPrice,
    leverage: '5',
    max_leverage: '10',
    upnl: '0',
    upnl_rate: '0',
    initial_margin: '150000',
    maintenance_margin: '37500',
    fee: '0',
    funding_fee: '0',
  },
];

const hypeAccount = {
  user_id: '1234567',
  available_margin: '100000',
  margin_balance: '400000',
  initial_margin: '300000',
  maintenance_margin: '52550',
  assets: [
    { coin: 'USDT', exchange_type: 'CROSSEX', balance: '400000', equity: '400000', available_balance: '100000', upnl: '0', liability: '0' },
    { coin: 'USDC', exchange_type: 'HYPERLIQUID', balance: '0', equity: '0', available_balance: '0', upnl: '0', liability: '0' },
  ],
};

describe('GET /api/positions', () => {
  let app: FastifyInstance;
  beforeEach(resetMarkMemory);
  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  it("serves Gate's maintenance margin tiers for the symbols held", async () => {
    app = makeTestApp();
    mockGateGet('/positions', { body: hypeBook('40') });
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });

    const res = await app.inject({ method: 'GET', url: '/api/positions', headers: HOST });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.marginTiers.GATE_FUTURE_HYPE_USDT).toEqual([
      { from: 0, rate: 0.015, deduction: 0 },
      { from: 200_000, rate: 0.018, deduction: 600 },
      { from: 300_000, rate: 0.02, deduction: 1_200 },
      { from: 500_000, rate: 0.025, deduction: 3_700 },
      { from: 1_000_000, rate: 0.08, deduction: 58_700 },
      { from: 6_000_000, rate: 0.1, deduction: 178_700 },
    ]);
    expect(data.marginTiers.HYPERLIQUID_FUTURE_HYPE_USDC).toEqual([{ from: 0, rate: 0.05, deduction: 0 }]);
  });

  it('serves no tiers when Gate does not answer the risk-limit read', async () => {
    app = makeTestApp();
    mockGateGet('/positions', { body: hypeBook('40') });
    mockGateGet('/rule/risk_limits', { status: 500, body: { label: 'SERVER_ERROR' } });

    const res = await app.inject({ method: 'GET', url: '/api/positions', headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.marginTiers).toEqual({});
    expect(res.json().data.positions).toHaveLength(2);
  });

  it('holds the last mark for 60 seconds, then stamps when Gate stopped sending it', async () => {
    const t0 = Date.UTC(2026, 8, 21, 14, 32);
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    app = makeTestApp();
    mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json', times: 3 });
    mockGateGet('/positions', { body: hypeBook('40') });

    const first = await app.inject({ method: 'GET', url: '/api/positions?fresh=1', headers: HOST });
    expect(first.json().data.positions[0].markPrice).toBe('40');
    expect(first.json().data.positions[0].markStaleSinceMs).toBeUndefined();
    expect(first.json().data.positions[0].markHeldSinceMs).toBeUndefined();

    mockGateGet('/positions', { body: hypeBook(''), times: 2 });
    vi.setSystemTime(t0 + 59_000);
    const held = await app.inject({ method: 'GET', url: '/api/positions?fresh=1', headers: HOST });
    expect(held.json().data.positions[0].markPrice).toBe('40');
    expect(held.json().data.positions[0].markStaleSinceMs).toBeUndefined();
    expect(held.json().data.positions[0].markHeldSinceMs).toBe(t0);

    vi.setSystemTime(t0 + 61_000);
    const gone = await app.inject({ method: 'GET', url: '/api/positions?fresh=1', headers: HOST });
    expect(gone.json().data.positions[0].markStaleSinceMs).toBe(t0);
    expect(gone.json().data.positions[1].markStaleSinceMs).toBe(t0);
  });

  it('gives the card and the Telegram bot the same tiered line, from one risk-limit read', async () => {
    const cache = new TtlCache();
    app = makeTestApp({ cache });
    mockGateGet('/positions', { body: hypeBook('40'), times: 2 });
    mockGateGet('/accounts', { body: hypeAccount, times: 2 });
    const limits = mockGateGet('/rule/risk_limits', { fixture: 'risk-limits.json' });

    const payload = (await app.inject({ method: 'GET', url: '/api/positions', headers: HOST })).json()
      .data as PositionsResponse;
    const acc = (await app.inject({ method: 'GET', url: '/api/account', headers: HOST })).json().data as CrossexAccount;

    const flat = liquidationLines(acc, payload)!.lines[0];
    const card = liquidationLines(acc, payload, {}, payload.marginTiers)!.lines[0];
    expect(flat.price).toBeCloseTo(148.96, 1);
    expect(card.price).toBeCloseTo(123.76, 1);

    const coins = await readTriggerCoins({
      cache,
      getClients: () => makeClients({ key: TEST_KEY, secret: TEST_SECRET }),
    });
    expect(coins.find((c) => c.coin === 'HYPE')!.liquidation.up!.price).toBeCloseTo(card.price, 6);
    expect(limits.isDone()).toBe(true);
  });

  it('groups the cross-quote BTC pair into ONE neutral exposure group', async () => {
    app = makeTestApp();
    mockGateGet('/positions', { fixture: 'positions.pair-neutral.json' });

    const res = await app.inject({ method: 'GET', url: '/api/positions', headers: HOST });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.positions).toHaveLength(2);

    // The cross-quote grouping regression: USDC + USDT legs must land in one BTC group.
    expect(data.exposure).toHaveLength(1);
    const group = data.exposure[0];
    expect(group.base).toBe('BTC');
    expect(group.neutral).toBe(true);
    expect(group.singleLeg).toBe(false);
    expect(group.legs).toHaveLength(2);
    expect(group.legs.map((l: { quote: string }) => l.quote).sort()).toEqual(['USDC', 'USDT']);
    expect(group.legs.map((l: { side: string }) => l.side).sort()).toEqual(['LONG', 'SHORT']);
  });

  it('empty book → empty exposure', async () => {
    app = makeTestApp();
    mockGateGet('/positions', { fixture: 'positions.empty.json' });

    const res = await app.inject({ method: 'GET', url: '/api/positions', headers: HOST });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.positions).toEqual([]);
    expect(data.exposure).toEqual([]);
  });
});
