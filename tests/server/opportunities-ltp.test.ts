/**
 * GET /api/opportunities-ltp — param validation, tier/fee resolution (param >
 * account > VIP1 default), the gitignored ladder file, LTP-call caching, every
 * degradation path, and host authentication. Boros is stubbed through
 * AppDeps.borosFetch, the LTP client through AppDeps.getLtpClient (LtpReadClient is
 * an interface — a plain object stubs it), venue books via nock. Money pins
 * live in tests/unit/ltp-opportunities.test.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LtpReadClient as LtpClient } from '../../src/server/routes/opportunitiesLtp';
import { imInputs, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;

const HL_MARKET = 155;
const BINANCE_MARKET = 158;

/** Same ETH cohort as opportunities.test.ts: Hyperliquid rich at 9% (the SHORT
 * leg — DMA through LTP), Binance cheap at 4.5% (LONG — native RapidX). */
function borosBodies(): Record<string, unknown> {
  const market = (marketId: number, platformName: string, midApr: number, markApr: number) => ({
    marketId,
    tokenId: 3,
    state: 'Normal',
    imData: {
      name: `${platformName} ETH 30d`,
      maturity: MATURITY,
      iTickThresh: imInputs.imTickThresh,
      tickStep: imInputs.imTickStep,
    },
    extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
    platform: { platformId: platformName },
    metadata: { underlyingSymbol: 'ETH' },
    config: { status: 2, takerFee: '500000000000000', kIM: raw(imInputs.kIM), tThresh: imInputs.tThreshSec },
    data: { midApr, markApr, floatingApr: 0.05, notionalOI: 12_000_000, assetMarkPrice: 1900 },
  });
  const book = (bidTick: number, askTick: number) => ({
    long: { ia: [bidTick], sz: [raw(5_000_000)] },
    short: { ia: [askTick], sz: [raw(5_000_000)] },
  });
  return {
    '/apis/v1/markets': {
      results: [
        market(HL_MARKET, 'Hyperliquid', 0.09, 0.091),
        market(BINANCE_MARKET, 'Binance', 0.045, 0.044),
      ],
      total: 2,
      skip: 0,
    },
    [`/apis/v1/markets/order-book?marketId=${HL_MARKET}`]: book(899, 901),
    [`/apis/v1/markets/order-book?marketId=${BINANCE_MARKET}`]: book(449, 451),
  };
}

function mockVenueBooks(times = 1): void {
  // The route POSTs to the same HL endpoint twice over: {type:'meta'} for the
  // leverage caps and {type:'l2Book'} for the book — match bodies so the two
  // interceptors can't starve each other.
  nock('https://api.hyperliquid.xyz')
    .post('/info', (b: { type?: string }) => b?.type === 'meta')
    .times(times)
    .reply(200, { universe: [{ name: 'ETH', maxLeverage: 25 }] });
  nock('https://api.hyperliquid.xyz')
    .post('/info', (b: { type?: string }) => b?.type === 'l2Book')
    .times(times)
    .reply(200, { levels: [[{ px: '1899', sz: '5000' }], [{ px: '1901', sz: '5000' }]] });
  nock('https://fapi.binance.com')
    .get('/fapi/v1/depth')
    .query(true)
    .times(times)
    .reply(200, { bids: [['1899', '5000']], asks: [['1901', '5000']] });
}

/** A stub LTP client covering the two reads the route makes, with call
 * counters for the caching assertions. BINANCE taker deliberately differs from
 * the VIP1 ladder (0.0003 vs 0.00035) so account-vs-ladder pricing is
 * distinguishable in the fee lines. */
function stubLtp(over: Partial<LtpClient> = {}): { client: LtpClient; calls: Record<string, number> } {
  const calls = { getSymbolInfo: 0, getUserFeeRate: 0 };
  const client = {
    async getSymbolInfo() {
      calls.getSymbolInfo += 1;
      return [
        { sym: 'BINANCE_PERP_ETH_USDT', state: 'live' },
        { sym: 'HYPERLIQUID_PERP_ETH_USDT', state: 'live' },
      ];
    },
    async getUserFeeRate() {
      calls.getUserFeeRate += 1;
      return [
        {
          exchangeType: 'BINANCE',
          businessType: 'PERP',
          makerFeeRate: '0.0001',
          takerFeeRate: '0.0003',
          level: '1',
          groupList: [],
        },
        {
          exchangeType: 'BINANCE',
          businessType: 'SPOT',
          makerFeeRate: '0.0002',
          takerFeeRate: '0.00035',
          level: '1',
          groupList: [],
        },
      ];
    },
    ...over,
  } as unknown as LtpClient;
  return { client, calls };
}

let app: FastifyInstance | undefined;
beforeEach(() => {
  // Point the ladder loader at nothing: tests must not depend on the
  // operator's real gitignored fee-tiers.local.json.
  process.env.LTP_FEE_TIERS_PATH = path.join(os.tmpdir(), 'ltp-ladder-that-does-not-exist.json');
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.LTP_FEE_TIERS_PATH;
  nock.cleanAll();
});

describe('GET /api/opportunities-ltp', () => {
  it('prices end to end from the account schedule and echoes every knob in meta', async () => {
    const { client } = stubLtp();
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), getLtpClient: () => client });
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities-ltp?notionalUsd=10000&perpLeverage=5&borrowLeverage=2&loanRateApr=0.095',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data.meta).toMatchObject({
      notionalUsd: 10_000,
      borosEntry: 'market',
      entryMode: 'both-market',
      exitMode: 'close',
      perpLeverage: 5,
      borrowLeverage: 2,
      loanRateApr: 0.095,
      ltpTier: 'vip1', // detected from the account rows' level "1"
      tierSource: 'account',
    });

    const pair = data.groups[0].pairs[0];
    // Short the rich HL market (DMA), long Binance (RapidX).
    expect(pair.shortLeg.ltpVenue).toBe('HYPERLIQUID');
    expect(pair.shortLeg.ltpSym).toBe('HYPERLIQUID_PERP_ETH_USDT');
    expect(pair.shortLeg.venueAccess).toBe('dma');
    expect(pair.longLeg.ltpVenue).toBe('BINANCE');
    expect(pair.longLeg.venueAccess).toBe('rapidx');
    expect(pair.reasons.join(' ')).toMatch(/HYPERLIQUID leg executes via an LTP DMA sub-account/);

    // Fees: BINANCE from the ACCOUNT schedule (taker 0.0003), HYPERLIQUID from
    // the VIP1 ladder fallback (taker 0.00035) — both legs cross.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(10_000 * (0.0003 + 0.00035), 8);

    // Capital: C = 2·10k/5 = 4 000 → posted 2 000, borrowed 2 000; interest on
    // the borrowed half at 9.5% over the pair's actual duration.
    expect(pair.capital.perpCollateralRequiredUsd).toBeCloseTo(4_000, 10);
    expect(pair.capital.postedPerpCollateralUsd).toBeCloseTo(2_000, 10);
    expect(pair.capital.borrowedUsd).toBeCloseTo(2_000, 10);
    const years = pair.secondsToMaturity / (365 * DAY);
    expect(pair.costs.loanInterestUsd).toBeCloseTo(2_000 * 0.095 * years, 8);
    expect(pair.capitalUsd).toBeCloseTo(
      pair.capital.borosShortImUsd + pair.capital.borosLongImUsd + 2_000,
      8,
    );
    expect(typeof pair.netFixedAprOnCapital).toBe('number');
  });

  it('rejects every out-of-contract param with a 400 validation envelope', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    for (const qs of [
      'notionalUsd=999',
      'perpLeverage=0',
      'perpLeverage=51',
      'perpLeverage=abc',
      'borrowLeverage=0.5',
      'borrowLeverage=6',
      'loanRateApr=-0.1',
      'loanRateApr=1.5',
      'ltpTier=vip0',
      'ltpTier=vip6',
      'borosEntry=midpoint',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/opportunities-ltp?${qs}`,
        headers: HOST,
      });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.category, qs).toBe('validation');
    }
  });

  it('degrades without an LTP client: VIP1 assumption + unverified listings, still 200', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) }); // no getLtpClient at all
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities-ltp', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.meta.tierSource).toBe('default');
    expect(data.meta.ltpTier).toBe('vip1');
    expect(data.warnings.join(' ')).toMatch(/Perp fees assume the VIP 1 LTP schedule/);

    const pair = data.groups[0].pairs[0];
    // VIP1 ladder taker on BOTH legs now.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(10_000 * 0.0007, 8);
    expect(typeof pair.netFixedApr).toBe('number');
  });

  it('a fee schedule with no usable PERP row is NOT account pricing', async () => {
    // Empty rows (or SPOT-only) must fall to the honest default branch —
    // tierSource 'account' on ladder-filled fees would fake provenance and
    // suppress the assumption warning.
    const { client } = stubLtp({
      getUserFeeRate: async () => [
        {
          exchangeType: 'BINANCE',
          businessType: 'SPOT',
          makerFeeRate: '0.0002',
          takerFeeRate: '0.00035',
          level: '2',
          groupList: [],
        },
      ],
    } as never);
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), getLtpClient: () => client });
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities-ltp', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.meta.tierSource).toBe('default');
    expect(data.meta.ltpTier).toBe('vip1'); // never "detected" off a SPOT row
    expect(data.warnings.join(' ')).toMatch(/Perp fees assume the VIP 1 LTP schedule/);
  });

  it('an explicit ltpTier is a what-if that beats the account schedule', async () => {
    const { client } = stubLtp();
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), getLtpClient: () => client });
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities-ltp?ltpTier=vip1',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.meta.tierSource).toBe('param');
    // Ladder VIP1 on both legs — the account's 0.0003 BINANCE taker is ignored.
    expect(data.groups[0].pairs[0].costs.perpEntryFeesUsd).toBeCloseTo(10_000 * 0.0007, 8);
  });

  it("degrades a tier the server's ladder doesn't carry instead of 400ing", async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities-ltp?ltpTier=vip3',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.warnings.join(' ')).toMatch(/VIP 3 LTP fee ladder isn't configured on this server/);
    const pair = data.groups[0].pairs[0];
    expect(pair.costs.perpEntryFeesUsd).toBeNull();
    expect(pair.netFixedApr).toBeNull();
  });

  it('prices higher tiers from the operator-supplied ladder file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltp-ladder-'));
    const file = path.join(dir, 'ladder.json');
    fs.writeFileSync(file, JSON.stringify({ vip2: [0.00005, 0.00025] }));
    process.env.LTP_FEE_TIERS_PATH = file;

    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities-ltp?ltpTier=vip2',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.meta).toMatchObject({ ltpTier: 'vip2', tierSource: 'param' });
    expect(data.groups[0].pairs[0].costs.perpEntryFeesUsd).toBeCloseTo(10_000 * 0.0005, 8);
  });

  it('caches the LTP reads across polls and re-reads with ?fresh=1', async () => {
    const { client, calls } = stubLtp();
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), getLtpClient: () => client });
    mockVenueBooks(3);

    await app.inject({ method: 'GET', url: '/api/opportunities-ltp', headers: HOST });
    expect(calls.getSymbolInfo).toBe(1);
    expect(calls.getUserFeeRate).toBe(1);

    await app.inject({ method: 'GET', url: '/api/opportunities-ltp', headers: HOST });
    expect(calls.getSymbolInfo).toBe(1);
    expect(calls.getUserFeeRate).toBe(1);

    await app.inject({ method: 'GET', url: '/api/opportunities-ltp?fresh=1', headers: HOST });
    expect(calls.getSymbolInfo).toBe(2);
    expect(calls.getUserFeeRate).toBe(2);
  });

  it('an LTP client that throws degrades like an unconfigured one, still 200', async () => {
    const { client } = stubLtp({
      getSymbolInfo: async () => {
        throw new Error('LTP 500');
      },
      getUserFeeRate: async () => {
        throw new Error('LTP 500');
      },
    } as Partial<LtpClient>);
    app = makeTestApp({ borosFetch: borosStub(borosBodies()), getLtpClient: () => client });
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities-ltp', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.warnings.join(' ')).toMatch(/Couldn't load LTP's symbol universe/);
    expect(data.warnings.join(' ')).toMatch(/Perp fees assume the VIP 1 LTP schedule/);
    expect(typeof data.groups[0].pairs[0].netFixedApr).toBe('number');
  });

  it('accepts the host dashboard fee ladder without a local file or LTP keys', async () => {
    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      ltpLadder: { vip2: { makerRate: 0.00002, takerRate: 0.0002 } },
    });
    mockVenueBooks();
    const res = await app.inject({
      method: 'GET', url: '/api/opportunities-ltp?ltpTier=vip2', headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.groups[0].pairs[0].costs.perpEntryFeesUsd).toBeCloseTo(4, 8);
  });

  it('requires the same authentication as the host dashboard', async () => {
    app = makeTestApp();
    const res = await app.inject({
      method: 'GET', url: '/api/opportunities-ltp', headers: { host: 'localhost:6688' },
    });
    expect(res.statusCode).toBe(401);
  });
});
