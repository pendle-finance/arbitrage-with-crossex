import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imInputs, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;

function market(
  marketId: number,
  platformName: string,
  underlyingSymbol: string,
  midApr: number,
): Record<string, unknown> {
  return {
    marketId,
    tokenId: 3,
    imData: {
      name: `${platformName} ${underlyingSymbol} 30d`,
      maturity: MATURITY,
      iTickThresh: imInputs.imTickThresh,
      tickStep: imInputs.imTickStep,
    },
    extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
    platform: { platformId: platformName },
    metadata: { underlyingSymbol },
    config: {
      status: 2,
      takerFee: '500000000000000',
      kIM: raw(imInputs.kIM),
      tThresh: imInputs.tThreshSec,
    },
    data: {
      midApr,
      markApr: midApr,
      floatingApr: 0.05,
      notionalOI: 12_000_000,
      assetMarkPrice: 1900,
    },
  };
}

function allowlistBodies(): Record<string, unknown> {
  return {
    '/apis/v1/markets': {
      results: [
        market(501, 'Hyperliquid', 'ETH', 0.09),
        market(502, 'Binance', 'ETH', 0.045),
        market(503, 'Hyperliquid', 'HYPE', 0.07),
        market(504, 'Binance', 'HYPE', 0.03),
        market(505, 'Hyperliquid', 'BTC', 0.05),
        market(506, 'Binance', 'BTC', 0.02),
        market(507, 'Hyperliquid', 'XAU', 0.04),
        market(508, 'Binance', 'GOLD', 0.015),
      ],
      total: 8,
      skip: 0,
    },
  };
}

const HL_MARKET = 155;
const BINANCE_MARKET = 158;

function ethBodies(): Record<string, unknown> {
  const book = (bidTick: number, askTick: number) => ({
    long: { ia: [bidTick], sz: [raw(5_000_000)] },
    short: { ia: [askTick], sz: [raw(5_000_000)] },
  });
  return {
    '/apis/v1/markets': {
      results: [market(HL_MARKET, 'Hyperliquid', 'ETH', 0.09), market(BINANCE_MARKET, 'Binance', 'ETH', 0.045)],
      total: 2,
      skip: 0,
    },
    [`/apis/v1/markets/order-book?marketId=${HL_MARKET}`]: book(899, 901),
    [`/apis/v1/markets/order-book?marketId=${BINANCE_MARKET}`]: book(449, 451),
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/opportunities — supported coins', () => {
  it('keeps only the supported set', async () => {
    app = makeTestApp({ borosFetch: borosStub(allowlistBodies()) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities?borosEntry=mark',
      headers: HOST,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const underlyings = data.groups.map((g: { underlying: string }) => g.underlying).sort();
    expect(underlyings).toEqual(['BTC', 'ETH', 'HYPE']);
  });

  it('books cached 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const calls: string[] = [];
      app = makeTestApp({ borosFetch: borosStub(ethBodies(), calls) });
      const bookCalls = () => calls.filter((c) => c.startsWith('/apis/v1/markets/order-book')).length;

      await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
      expect(bookCalls()).toBe(2);

      vi.setSystemTime(Date.now() + 59_000);
      await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
      expect(bookCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
