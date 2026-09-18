import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerStore } from '../../src/server/ledgerStore';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { pagedSettlementFetch, type SettlementPage } from '../helpers/settlement-pages';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ADDR = '0xb2684cd15b0cf17050531c51d581a9ddc365f1ef';
const CROSS_USDT = marketAcc(ADDR, 3);
const NOW = Math.floor(Date.now() / 1000);
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const borosBodies = (): Record<string, unknown> => ({
  '/apis/v1/markets': {
    results: [
      {
        marketId: 155,
        tokenId: 3,
        imData: { name: 'Hyperliquid ETH 31 Dec 2026', maturity: NOW + 90 * 86_400 },
        extConfig: { settleFeeRate: '0', paymentPeriod: 3600 },
        config: { status: 2 },
        platform: { platformId: 'Hyperliquid' },
        metadata: { underlyingSymbol: 'ETH' },
        data: { markApr: 0.07, floatingApr: 0.07, assetMarkPrice: 2400 },
      },
    ],
    total: 1,
    skip: 0,
  },
  '/apis/v1/accounts/market-acc-infos-by-root': { results: [] },
  '/apis/v1/accounts/active-positions': { results: [] },
  '/apis/v1/accounts/position-update-events': { results: [], resumeToken: null },
  '/apis/v1/accounts/settlement-events': { results: [], resumeToken: null },
});

const settlement = (id: string, iso: string) => ({
  id,
  marketAcc: CROSS_USDT,
  marketId: 155,
  timestamp: sec(iso),
  positionSize: raw(1000),
  settlement: raw(10),
  fee: '0',
  settlementRate: 0.07,
});

const ledgerRow = (id: string, iso: string) => ({
  id,
  marketAcc: CROSS_USDT,
  tokenId: 3,
  marketId: 155,
  timeSec: sec(iso),
  positionAbs: 1000,
  settlementToken: 10,
  feeToken: 0,
  settlementRate: 0.07,
});

type Page = SettlementPage;

const withSettlementPages = (pages: Record<string, () => Promise<Page>>, served: string[]) =>
  pagedSettlementFetch(borosStub(borosBodies()), pages, served);

const perp = (symbol: string, qty: string) => ({
  symbol,
  position_side: Number(qty) < 0 ? 'SHORT' : 'LONG',
  position_qty: qty,
  position_value: '1000',
  entry_price: '100',
  mark_price: '100',
  leverage: '5',
  upnl: '12',
  funding_fee: '0',
  fee: '0',
  initial_margin: '200',
  create_time: String((NOW - 3 * 86_400) * 1000),
  user_id: '1001',
});

const closedRow = (symbol: string) => ({
  symbol,
  position_id: `${symbol}-1`,
  closed_type: 'COMPLETE_CLOSED',
  closed_pnl: '-40',
  funding_fee: '0',
  fee: '0',
  liq_fee: '0',
  create_time: String((NOW - 9 * 86_400) * 1000),
  update_time: String((NOW - 8 * 86_400) * 1000),
  user_id: '1001',
});

function mockGate(positions: unknown[], history: unknown[]): void {
  mockGateGet('/positions', { body: positions }).persist();
  mockGateGet('/history_positions', { body: history }).persist();
  mockGateGet('/history_margin_interests', { body: [] }).persist();
  mockGateGet('/account_book', { body: [] }).persist();
  mockGateGet('/history_trades', { body: [] }).persist();
}

let app: FastifyInstance | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

const newDataDir = (): string => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-view-supported-'));
  return dataDir;
};

const get = (url: string) => app!.inject({ method: 'GET', url, headers: HOST });

describe('GET /api/asset-view/:address, supported coins and backfill', () => {
  it('returns the supported set', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), dataDir: newDataDir() });
    mockGate([], []);
    const res = await get(`/api/asset-view/${ADDR}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.supportedCoins).toEqual(['ETH', 'HYPE', 'BTC']);
  });

  it('drops a closed coin outside the set', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), dataDir: newDataDir() });
    mockGate([perp('HYPERLIQUID_FUTURE_ETH_USDC', '10')], [closedRow('GATE_FUTURE_XAU_USDT')]);
    const res = await get(`/api/asset-view/${ADDR}?since=0`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.assets.map((a: { base: string }) => a.base)).toEqual(['ETH']);
    expect(data.assets[0].supported).toBe(true);
  });

  it('keeps a held coin outside the set', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), dataDir: newDataDir() });
    mockGate(
      [perp('HYPERLIQUID_FUTURE_ETH_USDC', '10'), perp('HYPERLIQUID_FUTURE_SOL_USDC', '-5')],
      [closedRow('GATE_FUTURE_SOL_USDT')],
    );
    const res = await get(`/api/asset-view/${ADDR}?since=0`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const sol = data.assets.find((a: { base: string }) => a.base === 'SOL');
    expect(sol).toMatchObject({ supported: false });
    expect(sol.perpOpen).toHaveLength(1);
    expect(sol.perpOpen[0].upnlUsd).toBe(12);
    expect(sol.perpClosed[0].closedPnlUsd).toBe(-40);
    expect(data.assets.find((a: { base: string }) => a.base === 'ETH').supported).toBe(true);
  });

  it('flags backfilling', async () => {
    const dir = newDataDir();
    new LedgerStore(dir).write(ADDR, {
      rows: [ledgerRow('h', '2026-09-17T00:00:00Z'), ledgerRow('r', '2026-06-23T11:00:00Z')],
      coversFromSec: sec('2026-06-23T11:00:00Z'),
    });
    let release: () => void = () => undefined;
    const older = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served: string[] = [];
    app = makeTestApp({
      dataDir: dir,
      borosFetch: withSettlementPages(
        {
          head: async () => ({
            results: [settlement('h', '2026-09-17T00:00:00Z'), settlement('r', '2026-06-23T11:00:00Z')],
            resumeToken: 'p2',
          }),
          p2: async () => {
            await older;
            return { results: [settlement('f', '2026-02-15T00:00:00Z')], resumeToken: null };
          },
        },
        served,
      ),
    });
    mockGate([], []);

    const res = await get(`/api/asset-view/${ADDR}?since=${sec('2026-03-01T00:00:00Z')}`);
    expect(res.statusCode).toBe(200);
    const { coverage } = res.json().data;
    expect(coverage.backfilling).toBe(true);
    expect(coverage.settlementsFromSec).toBe(sec('2026-06-23T11:00:00Z'));
    expect(served).not.toContain('p2');

    const again = await get(`/api/asset-view/${ADDR}?since=${sec('2026-03-01T00:00:00Z')}`);
    expect(again.json().data.coverage.backfilling).toBe(true);

    release();
    await vi.waitFor(() => expect(served).toContain('p2'));
    expect(served.filter((t) => t === 'p2')).toHaveLength(1);
  });

  it('backfill fills the window', async () => {
    const dir = newDataDir();
    new LedgerStore(dir).write(ADDR, {
      rows: [ledgerRow('h', '2026-09-17T00:00:00Z'), ledgerRow('r', '2026-06-23T11:00:00Z')],
      coversFromSec: sec('2026-06-23T11:00:00Z'),
    });
    const served: string[] = [];
    app = makeTestApp({
      dataDir: dir,
      borosFetch: withSettlementPages(
        {
          head: async () => ({
            results: [settlement('h', '2026-09-17T00:00:00Z'), settlement('r', '2026-06-23T11:00:00Z')],
            resumeToken: 'p2',
          }),
          p2: async () => ({
            results: [settlement('m', '2026-05-01T00:00:00Z'), settlement('f', '2026-02-15T00:00:00Z')],
            resumeToken: 'p3',
          }),
        },
        served,
      ),
    });
    mockGate([], []);
    const since = sec('2026-03-01T00:00:00Z');

    const first = await get(`/api/asset-view/${ADDR}?since=${since}`);
    expect(first.json().data.coverage.backfilling).toBe(true);

    await vi.waitFor(async () => {
      const res = await get(`/api/asset-view/${ADDR}?since=${since}`);
      expect(res.json().data.coverage.backfilling).toBe(false);
    });
    const { data } = (await get(`/api/asset-view/${ADDR}?since=${since}`)).json();
    expect(data.coverage.backfilling).toBe(false);
    expect(data.coverage.settlementsFromSec).toBeLessThanOrEqual(since);
    const eth = data.assets.find((a: { base: string }) => a.base === 'ETH');
    expect(eth.borosHistory[0].settleUsd).toBeCloseTo(30, 9);
    expect(served).not.toContain('p3');
  });
});
