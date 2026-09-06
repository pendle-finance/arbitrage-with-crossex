/**
 * GET /api/asset-view/:address — grouping by underlying asset, the venue-
 * reported lifetime sums (open + closed, both sides), the `since` window,
 * and the degradation paths (Gate missing, history unreadable, unknown
 * markets). Boros is stubbed through the AppDeps.borosFetch seam; Gate via
 * nock — same harness as the strategy route tests.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import { raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ADDR = '0xB2684Cd15b0CF17050531C51d581A9dDc365f1ef';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** ETH book: SHORT HL / LONG OKX Boros pair (tokenId 3 = USDT, so token
 * amounts are dollars), plus settlement + fill history for both markets. */
function borosBodies(): Record<string, unknown> {
  const market = (marketId: number, platformName: string) => ({
    marketId,
    tokenId: 3,
    imData: { name: `${platformName} ETH 31 Jul 2026`, maturity: NOW + 15 * DAY },
    extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
    metadata: { platformName, assetSymbol: 'ETH' },
    data: { markApr: 0.076, floatingApr: 0.075, assetMarkPrice: 1880 },
  });
  return {
    '/core/v1/markets': {
      results: [market(155, 'Hyperliquid'), market(158, 'OKX')],
      total: 2,
      skip: 0,
    },
    '/core/v1/collaterals/summary': {
      collaterals: [
        {
          tokenId: 3,
          crossPosition: {
            isCross: true,
            netBalance: raw(20_000),
            marketPositions: [
              {
                marketId: 155,
                side: 1,
                notionalSize: raw(-1_000_000),
                fixedApr: 0.08,
                markApr: 0.076,
                pnl: { rateSettlementPnl: raw(3_205), unrealisedPnl: raw(820) },
                positionInitialMargin: raw(5_000),
              },
              {
                marketId: 158,
                side: 0,
                notionalSize: raw(1_000_000),
                fixedApr: 0.03,
                markApr: 0.032,
                pnl: { rateSettlementPnl: raw(1_120), unrealisedPnl: raw(-300) },
                positionInitialMargin: raw(5_000),
              },
            ],
          },
          isolatedPositions: [],
        },
      ],
    },
    '/core/v1/pnl/transactions': {
      results: [
        {
          marketId: 155,
          time: NOW - 12 * DAY,
          fee: raw(390),
          pnl: raw(-390),
          prevPositionS: '0',
          postPositionS: raw(-1_000_000),
        },
        {
          marketId: 158,
          time: NOW - 12 * DAY,
          fee: raw(300),
          pnl: raw(-300),
          prevPositionS: '0',
          postPositionS: raw(1_000_000),
        },
      ],
      total: 2,
      skip: 0,
    },
    '/apis/v1/accounts/settlement-events': {
      results: [
        {
          marketId: 155,
          timestamp: NOW - 2 * DAY,
          positionSize: raw(1_000_000),
          settlement: raw(100),
          fee: raw(2),
          settlementRate: 0.07,
        },
        {
          marketId: 155,
          timestamp: NOW - 10 * DAY,
          positionSize: raw(1_000_000),
          settlement: raw(100),
          fee: raw(2),
          settlementRate: 0.07,
        },
        {
          marketId: 158,
          timestamp: NOW - 2 * DAY,
          positionSize: raw(1_000_000),
          settlement: raw(-40),
          fee: raw(2),
          settlementRate: 0.07,
        },
      ],
      resumeToken: null,
    },
  };
}

const gatePositions = [
  {
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    position_side: 'SHORT',
    position_qty: '-531',
    position_value: '1000000',
    entry_price: '1883.0',
    mark_price: '1885.0',
    leverage: '10',
    upnl: '50',
    funding_fee: '3120',
    fee: '-210',
    initial_margin: '12500',
    create_time: String((NOW - 12 * DAY) * 1000),
  },
  {
    symbol: 'OKX_FUTURE_ETH_USDT',
    position_side: 'LONG',
    position_qty: '531',
    position_value: '1000000',
    entry_price: '1883.4',
    mark_price: '1885.0',
    leverage: '10',
    upnl: '-45',
    funding_fee: '-1940',
    fee: '-202',
    initial_margin: '12500',
    create_time: String((NOW - 12 * DAY) * 1000),
  },
];

const closedPositions = [
  {
    symbol: 'GATE_FUTURE_ETH_USDT',
    closed_pnl: '150',
    funding_fee: '30',
    fee: '-12',
    liq_fee: '0',
    update_time: String((NOW - 5 * DAY) * 1000),
    business_type: 'FUTURE',
  },
  {
    symbol: 'GATE_FUTURE_ETH_USDT',
    closed_pnl: '-20',
    funding_fee: '5',
    fee: '-3',
    liq_fee: '0',
    update_time: String((NOW - 4 * DAY) * 1000),
    business_type: 'FUTURE',
  },
  {
    symbol: 'OKX_FUTURE_BTC_USDT',
    closed_pnl: '77',
    funding_fee: '11',
    fee: '-6',
    liq_fee: '0',
    update_time: String((NOW - 6 * DAY) * 1000),
    business_type: 'FUTURE',
  },
];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (url: string) => app!.inject({ method: 'GET', url, headers: HOST });

describe('GET /api/asset-view/:address', () => {
  it('rejects a malformed address with a 400 validation envelope (no upstream calls)', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub({}, calls) });
    const res = await get('/api/asset-view/nonsense');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.category).toBe('validation');
    expect(calls).toHaveLength(0);
  });

  it('rejects a since in the future', async () => {
    app = makeTestApp({ borosFetch: borosStub({}) });
    const res = await get(`/api/asset-view/${ADDR}?since=${NOW + DAY}`);
    expect(res.statusCode).toBe(400);
  });

  it('groups both sides by asset with venue-reported lifetime numbers', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/history_positions', { body: closedPositions });

    const res = await get(`/api/asset-view/${ADDR}`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data.assets).toHaveLength(2);
    const eth = data.assets.find((a: { base: string }) => a.base === 'ETH');
    const btc = data.assets.find((a: { base: string }) => a.base === 'BTC');

    // ETH: two open perps, venue-normalized, with the venue's own numbers.
    expect(eth.perpOpen).toHaveLength(2);
    const hl = eth.perpOpen.find((l: { venue: string }) => l.venue === 'HYPERLIQUID');
    expect(hl).toMatchObject({
      side: 'SHORT',
      qty: 531,
      upnlUsd: 50,
      fundingUsd: 3120,
      feesUsd: 210,
      imUsd: 12500,
      openedAt: NOW - 12 * DAY,
    });

    // Closed perps aggregate per symbol (two GATE ETH rows fold into one).
    expect(eth.perpClosed).toHaveLength(1);
    expect(eth.perpClosed[0]).toMatchObject({
      symbol: 'GATE_FUTURE_ETH_USDT',
      venue: 'GATE',
      closedPnlUsd: 130,
      fundingUsd: 35,
      feesUsd: 15,
      count: 2,
      lastClosedAt: NOW - 4 * DAY,
    });

    // Open Boros legs: signed size → side, token amounts in USD (USDT zone).
    expect(eth.borosOpen).toHaveLength(2);
    const bHl = eth.borosOpen.find((l: { marketId: number }) => l.marketId === 155);
    expect(bHl).toMatchObject({
      venue: 'HYPERLIQUID',
      side: 'SHORT',
      sizeToken: 1_000_000,
      notionalUsd: 1_000_000,
    });
    expect(bHl.settleUsd).toBeCloseTo(3_205, 6);
    expect(bHl.mtmUsd).toBeCloseTo(820, 6);
    expect(bHl.imUsd).toBeCloseTo(5_000, 6);

    // History sums: settlements + fills per market, all-time (since=0).
    const h155 = eth.borosHistory.find((h: { marketId: number }) => h.marketId === 155);
    expect(h155.settleUsd).toBeCloseTo(200, 6);
    expect(h155.settleFeeUsd).toBeCloseTo(4, 6);
    expect(h155.tradePnlUsd).toBeCloseTo(-390, 6);
    expect(h155.tradeFeeUsd).toBeCloseTo(390, 6);
    const h158 = eth.borosHistory.find((h: { marketId: number }) => h.marketId === 158);
    expect(h158.settleUsd).toBeCloseTo(-40, 6);

    // BTC exists purely from closed history — no open legs.
    expect(btc.perpOpen).toHaveLength(0);
    expect(btc.borosOpen).toHaveLength(0);
    expect(btc.perpClosed[0].closedPnlUsd).toBe(77);
    expect(btc.earliestSec).toBe(NOW - 6 * DAY);

    // Clocks and coverage.
    expect(eth.earliestSec).toBe(NOW - 12 * DAY);
    expect(data.earliestSec).toBe(NOW - 12 * DAY);
    expect(data.coverage).toEqual({
      settlementsFromSec: 0,
      perpClosedFromSec: 0,
      borosTxnsComplete: true,
    });
    expect(data.warnings).toHaveLength(0);
  });

  it('windows history to ?since= (open positions stay whole by design)', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/history_positions', { body: closedPositions });

    // Between the NOW−5d and NOW−4d closed rows, and after every fill.
    const since = NOW - 4 * DAY - DAY / 2;
    const res = await get(`/api/asset-view/${ADDR}?since=${since}`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const eth = data.assets.find((a: { base: string }) => a.base === 'ETH');

    // Settlements: only the NOW−2d rows survive; fills (NOW−12d) drop out.
    const h155 = eth.borosHistory.find((h: { marketId: number }) => h.marketId === 155);
    expect(h155.settleUsd).toBeCloseTo(100, 6);
    expect(h155.tradePnlUsd).toBe(0);

    // Closed perps: only the NOW−4d row survives.
    expect(eth.perpClosed).toHaveLength(1);
    expect(eth.perpClosed[0].count).toBe(1);
    expect(eth.perpClosed[0].closedPnlUsd).toBe(-20);

    // BTC vanishes entirely: its only activity predates the window.
    expect(data.assets.find((a: { base: string }) => a.base === 'BTC')).toBeUndefined();

    // Open legs still whole; the ETH clock floors at the window start.
    expect(eth.perpOpen).toHaveLength(2);
    expect(data.sinceSec).toBe(since);
  });

  it('degrades to a Boros-only 200 when Gate is not configured, with no warning', async () => {
    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      getClients: () => {
        throw new CoreError('no credentials', 'not-configured');
      },
    });
    const res = await get(`/api/asset-view/${ADDR}`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const eth = data.assets.find((a: { base: string }) => a.base === 'ETH');
    expect(eth.perpOpen).toHaveLength(0);
    expect(eth.perpClosed).toHaveLength(0);
    expect(eth.borosOpen).toHaveLength(2);
    expect(data.warnings).toHaveLength(0);
  });

  it('keeps open positions and warns when closed-position history fails', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/positions', { body: gatePositions });
    mockGateGet('/history_positions', { status: 500, body: { label: 'INTERNAL' } });

    const res = await get(`/api/asset-view/${ADDR}`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const eth = data.assets.find((a: { base: string }) => a.base === 'ETH');
    expect(eth.perpOpen).toHaveLength(2);
    expect(eth.perpClosed).toHaveLength(0);
    expect(data.warnings.join(' ')).toMatch(/closed-position history/i);
  });

  it('resolves a MATURED (delisted) market by id so its history keeps its asset', async () => {
    const bodies = borosBodies();
    (bodies['/apis/v1/accounts/settlement-events'] as { results: unknown[] }).results.push({
      marketId: 42,
      timestamp: NOW - DAY,
      positionSize: raw(500),
      settlement: raw(75),
      fee: raw(1),
      settlementRate: 0.07,
    });
    // The by-id endpoint serves what the listing no longer carries — a raw
    // single-market object, not a results[] wrapper.
    bodies['/core/v1/markets/42'] = {
      marketId: 42,
      tokenId: 3,
      state: 'Matured',
      imData: { name: 'Binance BTC 31 Jul 2026', maturity: NOW - 30 * DAY },
      extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 28800 },
      metadata: { platformName: 'Binance', assetSymbol: 'BTC' },
      data: {},
      config: {},
    };
    app = makeTestApp({ borosFetch: borosStub(bodies) });
    mockGateGet('/positions', { body: [] });
    mockGateGet('/history_positions', { body: [] });

    const res = await get(`/api/asset-view/${ADDR}`);
    const { data } = res.json();
    const btc = data.assets.find((a: { base: string }) => a.base === 'BTC');
    expect(btc.borosHistory).toHaveLength(1);
    expect(btc.borosHistory[0]).toMatchObject({ marketId: 42, venue: 'BINANCE' });
    expect(btc.borosHistory[0].settleUsd).toBeCloseTo(75, 6);
    expect(data.warnings).toHaveLength(0);
  });

  it('excludes history rows on unlisted markets and says so', async () => {
    const bodies = borosBodies();
    (bodies['/apis/v1/accounts/settlement-events'] as { results: unknown[] }).results.push({
      marketId: 999,
      timestamp: NOW - DAY,
      positionSize: raw(500),
      settlement: raw(50),
      fee: raw(1),
      settlementRate: 0.07,
    });
    app = makeTestApp({ borosFetch: borosStub(bodies) });
    mockGateGet('/positions', { body: [] });
    mockGateGet('/history_positions', { body: [] });

    const res = await get(`/api/asset-view/${ADDR}`);
    const { data } = res.json();
    const allSettle = data.assets.flatMap((a: { borosHistory: Array<{ settleUsd: number }> }) =>
      a.borosHistory.map((h) => h.settleUsd),
    );
    expect(allSettle.reduce((s: number, v: number) => s + v, 0)).toBeCloseTo(160, 6);
    expect(data.warnings.join(' ')).toMatch(/no longer listed/);
  });
});
