import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ADDR = '0xb2684cd15b0cf17050531c51d581a9ddc365f1ef';
const OWNER_FIRST_OPEN = '2026-06-23T10:51:08.679Z';
const ms = (iso: string): number => Date.parse(iso);
const DAY_MS = 86_400_000;

const borosBodies = {
  '/apis/v1/markets': { results: [], total: 0, skip: 0 },
  '/apis/v1/accounts/market-acc-infos-by-root': { results: [] },
  '/apis/v1/accounts/active-positions': { results: [] },
  '/apis/v1/accounts/position-update-events': { results: [], resumeToken: null },
  '/apis/v1/accounts/settlement-events': { results: [], resumeToken: null },
};

const perp = (symbol: string, openIso: string, userId = '1001') => ({
  symbol,
  position_side: 'LONG',
  position_qty: '1',
  position_value: '100',
  entry_price: '100',
  mark_price: '100',
  leverage: '5',
  upnl: '0',
  funding_fee: '0',
  fee: '0',
  initial_margin: '20',
  create_time: String(ms(openIso)),
  user_id: userId,
});

const closedRow = (symbol: string, createTime: string, userId = '1001') => ({
  symbol,
  position_id: `${symbol}-${createTime}`,
  closed_type: 'COMPLETE_CLOSED',
  closed_pnl: '1',
  funding_fee: '0',
  fee: '0',
  liq_fee: '0',
  create_time: createTime,
  update_time: String(Date.now() - DAY_MS),
  user_id: userId,
});

const opened = (symbol: string, iso: string, userId?: string) => closedRow(symbol, String(ms(iso)), userId);

function mockRest(): void {
  mockGateGet('/history_margin_interests', { body: [] }).persist();
  mockGateGet('/account_book', { body: [] }).persist();
  mockGateGet('/history_trades', { body: [] }).persist();
}

function mockGate(positions: unknown[], history: unknown[]): void {
  mockGateGet('/positions', { body: positions }).persist();
  mockGateGet('/history_positions', { body: history }).persist();
  mockRest();
}

let app: FastifyInstance | undefined;
let dataDir = '';
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = '';
});

function start(): void {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-start-'));
  app = makeTestApp({ borosFetch: borosStub(borosBodies), dataDir });
}

const startFile = (): string => path.join(dataDir, 'tracking-start.json');
const saved = (): unknown => JSON.parse(fs.readFileSync(startFile(), 'utf8'));
const get = async () => {
  const res = await app!.inject({ method: 'GET', url: `/api/asset-view/${ADDR}`, headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

describe('the default start date', () => {
  it('saves the earliest supported open time', async () => {
    start();
    mockGate(
      [perp('HYPERLIQUID_FUTURE_ETH_USDC', '2026-08-01T00:00:00Z')],
      [opened('GATE_FUTURE_ETH_USDT', '2026-07-01T00:00:00Z'), opened('HYPERLIQUID_FUTURE_HYPE_USDC', OWNER_FIRST_OPEN)],
    );
    await get();
    expect(saved()).toEqual({ userId: '1001', firstOpenMs: ms(OWNER_FIRST_OPEN) });
  });

  it('ignores coins outside the set', async () => {
    start();
    mockGate(
      [],
      [opened('GATE_FUTURE_BTC_USDT', '2026-06-30T00:00:00Z'), opened('HYPERLIQUID_FUTURE_SOL_USDC', '2026-05-01T00:00:00Z')],
    );
    await get();
    expect(saved()).toEqual({ userId: '1001', firstOpenMs: ms('2026-06-30T00:00:00Z') });
  });

  it('skips an empty time', async () => {
    start();
    mockGate([], [closedRow('GATE_FUTURE_ETH_USDT', ''), opened('GATE_FUTURE_ETH_USDT', '2026-07-02T00:00:00Z')]);
    const data = await get();
    expect(saved()).toEqual({ userId: '1001', firstOpenMs: ms('2026-07-02T00:00:00Z') });
    expect(data.defaultSinceSec).toBe(ms('2026-07-02T00:00:00Z') / 1000);
  });

  it('open legs count', async () => {
    start();
    mockGate(
      [perp('HYPERLIQUID_FUTURE_ETH_USDC', '2026-07-05T00:00:00Z'), perp('OKX_FUTURE_BTC_USDT', '2026-07-03T00:00:00Z')],
      [],
    );
    await get();
    expect(saved()).toEqual({ userId: '1001', firstOpenMs: ms('2026-07-03T00:00:00Z') });
  });

  it('returns defaultSinceSec', async () => {
    start();
    mockGate([perp('HYPERLIQUID_FUTURE_HYPE_USDC', OWNER_FIRST_OPEN)], []);
    const data = await get();
    expect(data.defaultSinceSec).toBe(Math.floor(ms(OWNER_FIRST_OPEN) / 1000));
    expect(data.sinceSec).toBe(data.defaultSinceSec);
  });

  it('saved date stays', async () => {
    start();
    fs.writeFileSync(startFile(), JSON.stringify({ userId: '1001', firstOpenMs: ms(OWNER_FIRST_OPEN) }));
    mockGate([perp('HYPERLIQUID_FUTURE_ETH_USDC', '2026-08-01T00:00:00Z')], []);
    const data = await get();
    expect(data.defaultSinceSec).toBe(Math.floor(ms(OWNER_FIRST_OPEN) / 1000));
    expect(saved()).toEqual({ userId: '1001', firstOpenMs: ms(OWNER_FIRST_OPEN) });
  });

  it('new Gate account', async () => {
    start();
    fs.writeFileSync(startFile(), JSON.stringify({ userId: '999', firstOpenMs: ms(OWNER_FIRST_OPEN) }));
    mockGate([perp('HYPERLIQUID_FUTURE_ETH_USDC', '2026-08-01T00:00:00Z', '1002')], []);
    const data = await get();
    expect(saved()).toEqual({ userId: '1002', firstOpenMs: ms('2026-08-01T00:00:00Z') });
    expect(data.defaultSinceSec).toBe(ms('2026-08-01T00:00:00Z') / 1000);
  });

  it('Gate error writes nothing', async () => {
    start();
    mockGateGet('/positions', { body: [perp('HYPERLIQUID_FUTURE_ETH_USDC', '2026-07-05T00:00:00Z')] }).persist();
    mockGateGet('/history_positions', { status: 500, body: { label: 'INTERNAL' } });
    mockGateGet('/history_positions', { body: [] });
    mockRest();

    const failed = await get();
    expect(failed.defaultSinceSec).toBeNull();
    expect(failed.sinceSec).toBe(0);
    expect(fs.existsSync(startFile())).toBe(false);

    const retried = await get();
    expect(retried.defaultSinceSec).toBe(ms('2026-07-05T00:00:00Z') / 1000);
    expect(saved()).toEqual({ userId: '1001', firstOpenMs: ms('2026-07-05T00:00:00Z') });
  });

  it('no position yet', async () => {
    start();
    mockGate([], [opened('HYPERLIQUID_FUTURE_SOL_USDC', '2026-05-01T00:00:00Z')]);
    const data = await get();
    expect(data.defaultSinceSec).toBeNull();
    expect(data.sinceSec).toBe(0);
    expect(fs.existsSync(startFile())).toBe(false);
  });

  it('stops paging the history a year back', async () => {
    start();
    const yearAgo = Date.now() - 400 * DAY_MS;
    const page = Array.from({ length: 1000 }, (_, i) => ({
      ...opened('GATE_FUTURE_ETH_USDT', '2026-07-01T00:00:00Z'),
      position_id: `p${i}`,
      update_time: String(i === 999 ? yearAgo : Date.now() - DAY_MS),
    }));
    mockGateGet('/positions', { body: [] }).persist();
    const history = mockGateGet('/history_positions', { body: page });
    mockRest();
    const data = await get();
    expect(history.isDone()).toBe(true);
    expect(data.warnings.join(' ')).not.toMatch(/closed-position history/);
    expect(data.coverage.perpClosedFromSec).toBe(Math.floor(yearAgo / 1000));
  });
});
