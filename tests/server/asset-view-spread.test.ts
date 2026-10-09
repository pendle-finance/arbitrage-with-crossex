import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ADDR = '0xB2684Cd15b0CF17050531C51d581A9dDc365f1ef';
const CROSS_USDT = marketAcc(ADDR, 3);
const NOW_MS = Date.UTC(2026, 9, 8);
const NOW = NOW_MS / 1000;
const DAY = 86_400;

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
) as { results: Array<Record<string, unknown>> };
const spreadRow = { ...fixture.results.find((r) => r.marketId === 59)!, tokenId: 3 };

const bodies = (): Record<string, unknown> => ({
  '/apis/v1/markets': { results: [spreadRow], total: 1, skip: 0 },
  '/apis/v1/accounts/market-acc-infos-by-root': {
    results: [
      {
        marketAcc: CROSS_USDT,
        netBalance: raw(20_000),
        initialMargin: raw(1_000),
        availableInitialMargin: raw(19_000),
        positions: [
          { marketId: 59, signedSize: raw(-1_000), initialMargin: raw(500), maintMargin: raw(300), liquidationApr: raw(0.2), orders: [] },
        ],
      },
    ],
  },
  '/apis/v1/accounts/active-positions': {
    results: [
      {
        marketAcc: CROSS_USDT,
        marketId: 59,
        side: 1,
        fixedApr: 0.06,
        signedSize: raw(-1_000),
        unrealisedPnl: raw(1),
        settlementPnl: raw(2),
      },
    ],
  },
  '/apis/v1/accounts/position-update-events': { results: [], resumeToken: null },
  '/apis/v1/accounts/settlement-events': {
    results: [
      {
        marketAcc: CROSS_USDT,
        marketId: 59,
        timestamp: NOW - 2 * DAY,
        positionSize: raw(1_000),
        settlement: raw(3),
        fee: raw(1),
        settlementRate: 0.05,
      },
    ],
    resumeToken: null,
  },
});

let app: FastifyInstance | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
});

describe('GET /api/asset-view/:address on a spread market', () => {
  it('spread leg carries both venues', async () => {
    app = makeTestApp({ borosFetch: borosStub(bodies()) });
    mockGateGet('/positions', { body: [] });
    mockGateGet('/history_positions', { body: [] });
    mockGateGet('/history_margin_interests', { body: [] });
    mockGateGet('/account_book', { body: [] }).persist();

    const res = await app.inject({ method: 'GET', url: `/api/asset-view/${ADDR}?since=0`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const eth = res.json().data.assets.find((a: { base: string }) => a.base === 'ETH');
    expect(eth.borosOpen).toHaveLength(1);
    expect(eth.borosOpen[0]).toMatchObject({ marketId: 59, venue: 'HYPERLIQUID', spreadVenues: ['HYPERLIQUID', 'GATE'] });
    expect(eth.borosHistory).toHaveLength(1);
    expect(eth.borosHistory[0]).toMatchObject({ marketId: 59, venue: 'HYPERLIQUID', spreadVenues: ['HYPERLIQUID', 'GATE'] });
  });
});
