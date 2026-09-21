import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { LedgerStore } from '../../src/server/ledgerStore';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { pagedSettlementFetch, type SettlementPage } from '../helpers/settlement-pages';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ADDR = '0xb2684cd15b0cf17050531c51d581a9ddc365f1ef';
const CROSS_USDT = marketAcc(ADDR, 3);
const NOW = Math.floor(Date.now() / 1000);
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const SINCE = sec('2026-03-01T00:00:00Z');

const rest = borosStub({
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

const feed = (pages: Record<string, () => Promise<Page>>, served: string[]) => pagedSettlementFetch(rest, pages, served);

function mockGate(): void {
  mockGateGet('/positions', { body: [] }).persist();
  mockGateGet('/history_positions', { body: [] }).persist();
  mockGateGet('/history_margin_interests', { body: [] }).persist();
}

const apps: FastifyInstance[] = [];
let dataDir = '';
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = '';
});

function newApp(borosFetch: FetchLike): FastifyInstance {
  const app = makeTestApp({ borosFetch, dataDir });
  apps.push(app);
  return app;
}

const view = async (app: FastifyInstance, since: number) => {
  const res = await app.inject({ method: 'GET', url: `/api/asset-view/${ADDR}?since=${since}`, headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const ethSettleUsd = (data: { assets: Array<{ base: string; borosHistory: Array<{ settleUsd: number }> }> }) =>
  data.assets.find((a) => a.base === 'ETH')?.borosHistory[0]?.settleUsd;

describe('the Boros settlement ledger on disk', () => {
  it('restart reads only new rows', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-'));
    new LedgerStore(dataDir).write(ADDR, {
      rows: [ledgerRow('h', '2026-09-10T00:00:00Z'), ledgerRow('r', '2026-09-01T00:00:00Z')],
      coversFromSec: 0,
    });
    const served: string[] = [];
    const app = newApp(
      feed(
        {
          head: async () => ({
            results: [
              settlement('n', '2026-09-17T00:00:00Z'),
              settlement('h', '2026-09-10T00:00:00Z'),
              settlement('r', '2026-09-01T00:00:00Z'),
            ],
            resumeToken: 'p2',
          }),
        },
        served,
      ),
    );
    mockGate();

    const data = await view(app, 0);
    expect(served).toEqual(['head']);
    expect(data.coverage.backfilling).toBe(false);
    expect(ethSettleUsd(data)).toBeCloseTo(30, 9);
    expect(new LedgerStore(dataDir).read(ADDR)?.rows.map((r) => r.id)).toEqual(['n', 'h', 'r']);
  });

  it('no row twice after a restart', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-'));
    new LedgerStore(dataDir).write(ADDR, {
      rows: [ledgerRow('h', '2026-09-10T00:00:00Z'), ledgerRow('r', '2026-06-23T11:00:00Z')],
      coversFromSec: sec('2026-06-23T11:00:00Z'),
    });
    mockGate();
    const headPage = async (): Promise<Page> => ({
      results: [settlement('h', '2026-09-10T00:00:00Z'), settlement('r', '2026-06-23T11:00:00Z')],
      resumeToken: 'p2',
    });

    const beforeServed: string[] = [];
    const before = newApp(feed({ head: headPage, p2: () => new Promise<Page>(() => undefined) }, beforeServed));
    expect((await view(before, SINCE)).coverage.backfilling).toBe(true);

    const served: string[] = [];
    const after = newApp(
      feed(
        {
          head: async () => ({
            results: [settlement('n', '2026-09-17T00:00:00Z'), ...(await headPage()).results],
            resumeToken: 'p2',
          }),
          p2: async () => ({
            results: [settlement('m', '2026-05-01T00:00:00Z'), settlement('f', '2026-02-15T00:00:00Z')],
            resumeToken: null,
          }),
        },
        served,
      ),
    );
    expect((await view(after, SINCE)).coverage.backfilling).toBe(true);
    await vi.waitFor(async () => expect((await view(after, SINCE)).coverage.backfilling).toBe(false));

    const ids = new LedgerStore(dataDir).read(ADDR)?.rows.map((r) => r.id) ?? [];
    expect(ids).toEqual(['n', 'h', 'r', 'm', 'f']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ethSettleUsd(await view(after, SINCE))).toBeCloseTo(40, 9);
  });

  it('bad file starts over', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-'));
    fs.writeFileSync(path.join(dataDir, `boros-ledger-${ADDR}.json`), '{"rows": [ {"id": 1');
    expect(new LedgerStore(dataDir).read(ADDR)).toBeNull();
    const served: string[] = [];
    const app = newApp(
      feed(
        {
          head: async () => ({
            results: [settlement('h', '2026-09-10T00:00:00Z'), settlement('r', '2026-09-01T00:00:00Z')],
            resumeToken: null,
          }),
        },
        served,
      ),
    );
    mockGate();

    const data = await view(app, 0);
    expect(served).toEqual(['head']);
    expect(ethSettleUsd(data)).toBeCloseTo(20, 9);
    expect(new LedgerStore(dataDir).read(ADDR)).toMatchObject({ coversFromSec: 0 });
    expect(new LedgerStore(dataDir).read(ADDR)?.rows).toHaveLength(2);
  });
});
