import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ADDR = '0xB2684Cd15b0CF17050531C51d581A9dDc365f1ef';
const NOW = Math.floor(Date.now() / 1000);

const position = (symbol: string, qty: number, value: string) => ({
  symbol,
  position_side: 'LONG',
  position_qty: String(qty),
  position_value: value,
  entry_price: '1883',
  mark_price: '1885',
  leverage: '10',
  upnl: '0',
  funding_fee: '0',
  fee: '0',
  initial_margin: '100',
  create_time: String((NOW - 86_400) * 1000),
});

const borosBodies = {
  '/apis/v1/markets': { results: [], total: 0, skip: 0 },
  '/apis/v1/accounts/market-acc-infos-by-root': { results: [] },
  '/apis/v1/accounts/active-positions': { results: [] },
  '/apis/v1/accounts/position-update-events': { results: [], resumeToken: null },
  '/apis/v1/accounts/settlement-events': { results: [], resumeToken: null },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const quoteTwinBySymbol = async (value: string): Promise<Record<string, boolean>> => {
  app = makeTestApp({ borosFetch: borosStub(borosBodies) });
  const symbols = [
    'BINANCE_FUTURE_ETH_USDC',
    'BINANCE_FUTURE_ETH_USDT',
    'OKX_FUTURE_ETH_USDC',
    'OKX_FUTURE_ETH_USDT',
    'BYBIT_FUTURE_ETH_USDC',
    'BYBIT_FUTURE_ETH_USDT',
    'HYPERLIQUID_FUTURE_ETH_USDC',
    'LIGHTER_FUTURE_ETH_USDC',
  ];
  mockGateGet('/positions', { body: symbols.map((s) => position(s, 1, value)) });
  mockGateGet('/history_positions', { body: [] });
  mockGateGet('/history_margin_interests', { body: [] });
  mockGateGet('/account_book', { body: [] }).persist();
  const res = await app.inject({ method: 'GET', url: `/api/asset-view/${ADDR}?since=0`, headers: HOST });
  expect(res.statusCode).toBe(200);
  const eth = res.json().data.assets.find((a: { base: string }) => a.base === 'ETH');
  return Object.fromEntries(eth.perpOpen.map((l: { symbol: string; quoteTwin: boolean }) => [l.symbol, l.quoteTwin]));
};

describe('GET /api/asset-view/:address quote twins', () => {
  it.each([
    ['$50', '50'],
    ['$6M', '6000000'],
  ])('flags only the USDC perp of Binance, OKX and Bybit at %s', async (_label, value) => {
    expect(await quoteTwinBySymbol(value)).toEqual({
      BINANCE_FUTURE_ETH_USDC: true,
      BINANCE_FUTURE_ETH_USDT: false,
      OKX_FUTURE_ETH_USDC: true,
      OKX_FUTURE_ETH_USDT: false,
      BYBIT_FUTURE_ETH_USDC: true,
      BYBIT_FUTURE_ETH_USDT: false,
      HYPERLIQUID_FUTURE_ETH_USDC: false,
      LIGHTER_FUTURE_ETH_USDC: false,
    });
  });
});
