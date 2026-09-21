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
const DAY = 86_400;

const rest = () =>
  borosStub({
    '/apis/v1/markets': {
      results: [
        {
          marketId: 155,
          tokenId: 3,
          imData: { name: 'Hyperliquid ETH 31 Dec 2026', maturity: NOW + 90 * DAY },
          extConfig: { settleFeeRate: '0', paymentPeriod: 3600 },
          config: { status: 2 },
          platform: { platformId: 'Hyperliquid' },
          metadata: { underlyingSymbol: 'ETH' },
          data: { markApr: 0.07, floatingApr: 0.07, assetMarkPrice: 2400 },
        },
      ],
    },
    '/apis/v1/accounts/market-acc-infos-by-root': { results: [] },
    '/apis/v1/accounts/active-positions': { results: [] },
    '/apis/v1/accounts/position-update-events': { results: [], resumeToken: null },
    '/apis/v1/accounts/settlement-events': { results: [], resumeToken: null },
  });

const settlement = (id: string, timestamp: number) => ({
  id,
  marketAcc: CROSS_USDT,
  marketId: 155,
  timestamp,
  positionSize: raw(1000),
  settlement: raw(10),
  fee: '0',
  settlementRate: 0.07,
});

const ledgerRow = (id: string, timeSec: number) => ({
  id,
  marketAcc: CROSS_USDT,
  tokenId: 3,
  marketId: 155,
  timeSec,
  positionAbs: 1000,
  settlementToken: 10,
  feeToken: 0,
  settlementRate: 0.07,
});

type Pages = Record<string, () => Promise<SettlementPage>>;

function mockGate(positions: unknown[] = [], history: unknown[] = [], trades: unknown[] = []): void {
  mockGateGet('/positions', { body: positions }).persist();
  mockGateGet('/history_positions', { body: history }).persist();
  mockGateGet('/history_margin_interests', { body: [] }).persist();
  mockGateGet('/account_book', { body: [] }).persist();
  mockGateGet('/history_trades', { body: trades }).persist();
}

let app: FastifyInstance | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

function start(pages: Pages, served: string[]): string {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-view-backfill-'));
  app = makeTestApp({ dataDir, borosFetch: pagedSettlementFetch(rest(), pages, served) });
  return dataDir;
}

const view = async (since: number) => {
  const res = await app!.inject({ method: 'GET', url: `/api/asset-view/${ADDR}?since=${since}`, headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const ethSettleUsd = (data: { assets: Array<{ base: string; borosHistory: Array<{ settleUsd: number }> }> }) =>
  data.assets.find((a) => a.base === 'ETH')?.borosHistory[0]?.settleUsd;

describe('GET /api/asset-view/:address, Boros payments read in the background', () => {
  it('answers from the saved ledger while a long catch-up reads', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served: string[] = [];
    const h = NOW - 20 * DAY;
    const r = NOW - 30 * DAY;
    const dir = start(
      {
        head: async () => ({
          results: [settlement('n2', NOW - DAY), settlement('n1', NOW - 2 * DAY)],
          resumeToken: 'p2',
        }),
        p2: async () => {
          await held;
          return { results: [settlement('n0', NOW - 3 * DAY), settlement('h', h), settlement('r', r)], resumeToken: null };
        },
      },
      served,
    );
    new LedgerStore(dir).write(ADDR, { rows: [ledgerRow('h', h), ledgerRow('r', r)], coversFromSec: 0 });
    mockGate();

    const first = await view(0);
    expect(first.coverage.backfilling).toBe(true);
    expect(ethSettleUsd(first)).toBeCloseTo(20, 9);
    expect(served).not.toContain('p2');

    release();
    await vi.waitFor(async () => expect((await view(0)).coverage.backfilling).toBe(false));
    expect(ethSettleUsd(await view(0))).toBeCloseTo(50, 9);
    expect(new LedgerStore(dir).read(ADDR)?.rows.map((x) => x.id)).toEqual(['n2', 'n1', 'n0', 'h', 'r']);
  });

  it('moving the start one day back past the ledger reads one older page', async () => {
    const times = Array.from({ length: 40 }, (_, i) => NOW - (i + 1) * DAY);
    const oldestHeld = times[39]!;
    const pages: Pages = { head: async () => ({ results: [settlement('k1', times[0]!)], resumeToken: 'p2' }) };
    for (let i = 2; i <= 40; i += 1) {
      pages[`p${i}`] = async () => ({ results: [settlement(`k${i}`, times[i - 1]!)], resumeToken: `p${i + 1}` });
    }
    pages.p41 = async () => ({
      results: [settlement('o1', oldestHeld - DAY / 2), settlement('o2', oldestHeld - 2 * DAY)],
      resumeToken: 'p42',
    });
    const served: string[] = [];
    const dir = start(pages, served);
    new LedgerStore(dir).write(ADDR, {
      rows: times.map((t, i) => ledgerRow(`k${i + 1}`, t)),
      coversFromSec: oldestHeld,
      olderToken: 'p41',
    });
    mockGate();
    const since = oldestHeld - DAY;

    expect((await view(since)).coverage.backfilling).toBe(true);
    await vi.waitFor(async () => expect((await view(since)).coverage.backfilling).toBe(false));

    expect(served.filter((t) => t !== 'head')).toEqual(['p41']);
    expect(new LedgerStore(dir).read(ADDR)?.olderToken).toBe('p42');
    expect(ethSettleUsd(await view(since))).toBeCloseTo(410, 9);
  });

  it('a failed page keeps the rows read and the next read starts there', async () => {
    const h = NOW - 10 * DAY;
    const r = NOW - 20 * DAY;
    const m = NOW - 30 * DAY;
    const since = NOW - 40 * DAY;
    let isDown = true;
    const served: string[] = [];
    const dir = start(
      {
        head: async () => ({ results: [settlement('h', h), settlement('r', r)], resumeToken: 'p2' }),
        p2: async () => ({ results: [settlement('m', m)], resumeToken: 'p3' }),
        p3: async () => {
          if (isDown) throw new Error('Boros is down');
          return { results: [settlement('f', since - 5 * DAY)], resumeToken: null };
        },
      },
      served,
    );
    new LedgerStore(dir).write(ADDR, { rows: [ledgerRow('h', h), ledgerRow('r', r)], coversFromSec: r, olderToken: 'p2' });
    mockGate();

    await view(since);
    await vi.waitFor(async () => {
      await view(since);
      expect(new LedgerStore(dir).read(ADDR)).toMatchObject({ coversFromSec: m, olderToken: 'p3' });
    });

    isDown = false;
    await vi.waitFor(async () => {
      const data = await view(since);
      expect(data.coverage.backfilling).toBe(false);
      expect(data.coverage.settlementsFromSec).toBe(0);
    });
    expect(served.filter((t) => t === 'p2')).toHaveLength(1);
    expect(new LedgerStore(dir).read(ADDR)?.rows.map((x) => x.id)).toEqual(['h', 'r', 'm', 'f']);
    expect(ethSettleUsd(await view(since))).toBeCloseTo(30, 9);
  });

  it('reads at most 30 settlement pages a minute through the route', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const total = 70;
    const sentAt: number[] = [];
    const pages: Pages = {};
    for (let i = 1; i <= total; i += 1) {
      pages[i === 1 ? 'head' : `p${i}`] = async () => {
        sentAt.push(Date.now());
        return { results: [settlement(`s${i}`, NOW - i * 3600)], resumeToken: i < total ? `p${i + 1}` : null };
      };
    }
    start(pages, []);
    mockGate();

    expect((await view(0)).coverage.backfilling).toBe(true);
    for (let minute = 0; minute < 5 && sentAt.length < total + 1; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(sentAt).toHaveLength(total + 1);
    for (let i = 0; i + 30 < sentAt.length; i += 1) {
      expect(sentAt[i + 30]! - sentAt[i]!).toBeGreaterThanOrEqual(60_000);
    }
  });
});

describe('GET /api/asset-view/:address, perp fees since the start date', () => {
  it.each([
    ['a $50 account', 1],
    ['a $6M account', 50_000],
  ])('an open leg keeps its own fees beside a closed position on its symbol, %s', async (_label, scale) => {
    start({ head: async () => ({ results: [], resumeToken: null }) }, []);
    const symbol = 'OKX_FUTURE_ETH_USDT';
    const ms = (sec: number): string => String(sec * 1000);
    const usd = (v: number): string => String(v * scale);
    mockGate(
      [
        {
          symbol,
          position_id: 'open-1',
          position_side: 'LONG',
          position_qty: '1',
          position_value: usd(2400),
          entry_price: '2400',
          mark_price: '2400',
          leverage: '5',
          upnl: '0',
          funding_fee: '0',
          fee: usd(0.124232),
          initial_margin: usd(480),
          create_time: ms(NOW - 5 * DAY),
          user_id: '1001',
        },
      ],
      [
        {
          symbol,
          position_id: 'closed-1',
          closed_type: 'COMPLETE_CLOSED',
          closed_pnl: usd(3),
          funding_fee: '0',
          fee: usd(1.20829479),
          liq_fee: '0',
          create_time: ms(NOW - 20 * DAY),
          update_time: ms(NOW - 10 * DAY),
          user_id: '1001',
        },
      ],
      [
        { symbol, fee: usd(0.124232), create_time: ms(NOW - 5 * DAY) },
        { symbol, fee: usd(0.6), create_time: ms(NOW - 10 * DAY) },
        { symbol, fee: usd(0.60829479), create_time: ms(NOW - 20 * DAY) },
      ],
    );

    const eth = (await view(NOW - 30 * DAY)).assets.find((a: { base: string }) => a.base === 'ETH');
    expect(eth.perpOpen[0].feesUsd).toBeCloseTo(0.124232 * scale, 6);
    expect(eth.perpClosed[0].feesUsd).toBeCloseTo(1.20829479 * scale, 6);
    expect(eth.perpOpen[0].feesUsd + eth.perpClosed[0].feesUsd).toBeCloseTo(1.33252679 * scale, 6);
  });
});
