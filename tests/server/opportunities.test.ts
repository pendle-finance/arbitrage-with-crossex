/**
 * GET /api/opportunities — param validation, the Boros-group → CrossEx join
 * through the full route, the `mark` short-circuit that consults no Boros book,
 * caching, and every degradation path (Gate down, one book missing, Boros down).
 * Boros is stubbed through the AppDeps.borosFetch seam; Gate and the public
 * venue books via nock. Money pins live in tests/unit/boros-opportunities.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from '../../src/core/errors';
import { imInputs, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;

const HL_MARKET = 155;
const BINANCE_MARKET = 158;

/** One ETH cohort on USDT collateral (tokenId 3 → price 1): Hyperliquid rich at
 * a 9% mid, Binance cheap at 4.5% — a 4.5pt gross spread to lock. */
function borosBodies(): Record<string, unknown> {
  const market = (
    marketId: number,
    platformName: string,
    midApr: number,
    markApr: number,
  ) => ({
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
    metadata: { platformName, assetSymbol: 'ETH' },
    config: { takerFee: '500000000000000', kIM: raw(imInputs.kIM), tThresh: imInputs.tThreshSec },
    data: {
      midApr,
      markApr,
      floatingApr: 0.05,
      notionalOI: 12_000_000,
      assetMarkPrice: 1900,
    },
  });
  // ia is the APR in whole 0.0001 ticks; sz is 18-dec collateral units. Wire
  // `long` = bids (hit to receive fixed), `short` = asks (lift to pay fixed).
  const book = (bidTick: number, askTick: number) => ({
    long: { ia: [bidTick], sz: [raw(5_000_000)] },
    short: { ia: [askTick], sz: [raw(5_000_000)] },
  });
  return {
    '/core/v1/markets': {
      results: [
        market(HL_MARKET, 'Hyperliquid', 0.09, 0.091),
        market(BINANCE_MARKET, 'Binance', 0.045, 0.044),
      ],
      total: 2,
      skip: 0,
    },
    [`/core/v1/order-books/${HL_MARKET}`]: book(899, 901),
    [`/core/v1/order-books/${BINANCE_MARKET}`]: book(449, 451),
  };
}

/** Raw snake_case rule rows: ETH on both venues, plus a USDC Hyperliquid twin
 * that the USDT-first quote preference must NOT pick for Binance. */
const ruleSymbols = [
  { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange_type: 'HYPERLIQUID', business_type: 'FUTURE', state: 'live' },
  { symbol: 'BINANCE_FUTURE_ETH_USDC', exchange_type: 'BINANCE', business_type: 'FUTURE', state: 'live' },
  { symbol: 'BINANCE_FUTURE_ETH_USDT', exchange_type: 'BINANCE', business_type: 'FUTURE', state: 'live' },
];

const feeRows = [
  { exchange_type: 'HYPERLIQUID', future_maker_fee: '0.0002', future_taker_fee: '0.00048' },
  { exchange_type: 'BINANCE', future_maker_fee: '0.0002', future_taker_fee: '0.00048' },
];

/** Risk-limit tiers behind the capital model's perp legs: the cap is the HIGHEST
 * `leverage_max` across a symbol's tiers, so Hyperliquid is 20x and Binance 25x. */
const riskLimits = [
  {
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    tiers: [{ leverage_max: '20' }, { leverage_max: '10' }],
  },
  { symbol: 'BINANCE_FUTURE_ETH_USDT', tiers: [{ leverage_max: '25' }] },
];

/** Deep, tight public books on both venues so slippage never blocks a quote. */
function mockVenueBooks(times = 1): void {
  nock('https://api.hyperliquid.xyz')
    .post('/info')
    .times(times)
    .reply(200, { levels: [[{ px: '1899', sz: '5000' }], [{ px: '1901', sz: '5000' }]] });
  nock('https://fapi.binance.com')
    .get('/fapi/v1/depth')
    .query(true)
    .times(times)
    .reply(200, { bids: [['1899', '5000']], asks: [['1901', '5000']] });
}

/** One risk-limits interceptor per request: `getLeverageMax` is comma-joined, so
 * the whole symbol universe must cost a single call — a per-symbol read would
 * miss the mock on its second hedge symbol. */
function mockGate(times = 1, limits: unknown = riskLimits): void {
  mockGatePublicRules(times, limits);
  mockGateGet('/fee', { body: feeRows, times });
}

/** Only the two endpoints Gate serves PUBLICLY — what an unconfigured server
 * can still read (no /fee: that one is auth-only). */
function mockGatePublicRules(times = 1, limits: unknown = riskLimits): void {
  mockGateGet('/rule/symbols', { body: ruleSymbols, times });
  mockGateGet('/rule/risk_limits', { body: limits, times });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/opportunities', () => {
  it('prices the arb group end to end and echoes the request params in meta', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGate();
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities?notionalUsd=25000&entryMode=maker-hedge&exitMode=roll',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    expect(data.meta).toMatchObject({
      notionalUsd: 25_000,
      borosEntry: 'market',
      entryMode: 'maker-hedge',
      exitMode: 'roll',
    });
    expect(data.groups).toHaveLength(1);
    const group = data.groups[0];
    expect(group.collateral).toBe('USDT');
    expect(group.collateralPriceUsd).toBe(1);
    expect(group.underlying).toBe('ETH');
    expect(group.markets).toHaveLength(2);
    expect(group.markets.every((m: { bookStatus: string }) => m.bookStatus === 'ok')).toBe(true);

    // The rich market is the SHORT-fixed leg; the hedge symbol is the venue's
    // USDT contract where it exists (Hyperliquid only lists USDC).
    const pair = group.bestPair;
    expect(pair.shortLeg.marketId).toBe(HL_MARKET);
    expect(pair.shortLeg.crossexSymbol).toBe('HYPERLIQUID_FUTURE_ETH_USDC');
    expect(pair.longLeg.marketId).toBe(BINANCE_MARKET);
    expect(pair.longLeg.crossexSymbol).toBe('BINANCE_FUTURE_ETH_USDT');
    // Gross = 9% − 4.5%; exec = best bid 8.99% − best ask 4.51% (both books deep
    // enough at $25k), so the Boros impact is exactly the two half-spreads.
    expect(pair.grossSpreadApr).toBeCloseTo(0.045, 10);
    expect(pair.execSpreadApr).toBeCloseTo(0.0448, 10);
    expect(pair.borosImpactApr).toBeCloseTo(0.0002, 10);
    // Boros carried fees: (5 + 5)bps taker and (10 + 10)bps settlement on
    // $25k × the duration. Take the duration from the response, not from the
    // module-load NOW — the route stamps its own clock when the request lands,
    // and the seconds elapsed in between are enough to miss the tolerance.
    expect(pair.secondsToMaturity).toBeLessThanOrEqual(MATURITY - NOW);
    const notionalYears = 25_000 * (pair.secondsToMaturity / (365 * DAY));
    expect(pair.costs.borosTakerFeeUsd).toBeCloseTo(0.001 * notionalYears, 6);
    expect(pair.costs.borosSettleFeeUsd).toBeCloseTo(0.002 * notionalYears, 6);
    expect(pair.costs.perpExitFeesUsd).toBe(0); // rolling — nothing is closed
    expect(pair.costs.perpExitSlippageUsd).toBe(0);
    // Fee rows and both public books resolved: the hedge is fully priced.
    expect(pair.makerLeg).not.toBeNull();
    expect(pair.costs.perpEntryFeesUsd).toBeGreaterThan(0);
    expect(pair.costs.perpEntrySlippageUsd).toBeGreaterThan(0);
    expect(typeof pair.netFixedApr).toBe('number');
    expect(pair.netFixedApr).toBeLessThan(pair.execSpreadApr);
    expect(data.warnings).toEqual([]);
  });

  it('models the capital each pair consumes and leads with the APR on it', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGate();
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(200);
    const pair = res.json().data.groups[0].bestPair;

    // Perp IM at each venue's max leverage on the default $10k/leg.
    expect(pair.capital.shortLeverageMax).toBe(20);
    expect(pair.capital.longLeverageMax).toBe(25);
    expect(pair.capital.perpShortImUsd).toBeCloseTo(500, 10);
    expect(pair.capital.perpLongImUsd).toBeCloseTo(400, 10);
    // Boros IM is small beside it: 30d at kIM 0.476, charged on 8.99% received
    // and — since 4.51% sits under it — on the 8.004% APR floor paid.
    expect(pair.capital.borosShortImUsd).toBeCloseTo(35.186, 2);
    expect(pair.capital.borosLongImUsd).toBeCloseTo(31.327, 2);
    expect(pair.capitalUsd).toBeCloseTo(500 + 400 + 35.186 + 31.327, 2);

    // The headline: the same locked dollars over capital instead of notional,
    // which is exactly the notional basis times the leverage that capital buys.
    const years = pair.secondsToMaturity / (365 * DAY);
    expect(pair.effectiveLeverage).toBeCloseTo(10_000 / pair.capitalUsd, 10);
    expect(pair.effectiveLeverage).toBeGreaterThan(10);
    expect(pair.netFixedAprOnCapital).toBeCloseTo(pair.netFixedApr * pair.effectiveLeverage, 10);
    expect(pair.netFixedAprOnCapital).toBeCloseTo(
      pair.estProfitUsd / (pair.capitalUsd * years),
      10,
    );
    expect(pair.reasons).toEqual([]);
  });

  it('degrades a pair whose venue has no risk-limit row to null capital only', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGate(1, [riskLimits[0]]); // Binance has no tiers to read
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(200);
    const group = res.json().data.groups[0];
    const pair = group.pairs[0];

    expect(pair.capital.shortLeverageMax).toBe(20);
    expect(pair.capital.perpShortImUsd).toBeCloseTo(500, 10);
    expect(pair.capital.longLeverageMax).toBeNull();
    expect(pair.capital.perpLongImUsd).toBeNull();
    expect(pair.capitalUsd).toBeNull();
    expect(pair.netFixedAprOnCapital).toBeNull();
    expect(pair.effectiveLeverage).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(/No max leverage for BINANCE BINANCE_FUTURE_ETH_USDT/);

    // Only the capital view is unknown — the notional basis still prices.
    expect(pair.execSpreadApr).toBeCloseTo(0.0448, 10);
    expect(typeof pair.netFixedApr).toBe('number');
    expect(typeof pair.estProfitUsd).toBe('number');
    // Ranking keys on the capital APR, so a pair without one is never best.
    expect(group.bestPair).toBeNull();
  });

  it('keeps the scan alive when the risk-limit read itself fails', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGateGet('/rule/symbols', { body: ruleSymbols });
    mockGateGet('/fee', { body: feeRows });
    mockGateGet('/rule/risk_limits', { status: 500, body: { label: 'SERVER_ERROR' } });
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(200);
    const pair = res.json().data.groups[0].pairs[0];

    expect(pair.capital.shortLeverageMax).toBeNull();
    expect(pair.capital.longLeverageMax).toBeNull();
    expect(pair.capitalUsd).toBeNull();
    expect(pair.netFixedAprOnCapital).toBeNull();
    expect(typeof pair.netFixedApr).toBe('number');
  });

  it('rejects every out-of-contract param with a 400 validation envelope', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    for (const qs of [
      'notionalUsd=abc',
      'notionalUsd=999',
      'notionalUsd=100000001',
      'borosEntry=midpoint',
      'entryMode=both',
      'exitMode=rollover',
    ]) {
      const res = await app.inject({ method: 'GET', url: `/api/opportunities?${qs}`, headers: HOST });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.category, qs).toBe('validation');
    }
  });

  it('borosEntry=mark quotes the mark APRs and never touches a Boros order book', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(borosBodies(), calls) });
    mockGate();
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities?borosEntry=mark',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.startsWith('/core/v1/order-books'))).toBe(false);

    const { data } = res.json();
    expect(data.meta.borosEntry).toBe('mark');
    const group = data.groups[0];
    expect(group.markets.every((m: { bookStatus: string }) => m.bookStatus === 'not-fetched')).toBe(true);
    // 9.1% − 4.4% mark spread, wider than the 4.5pt mid spread → negative impact.
    expect(group.bestPair.execSpreadApr).toBeCloseTo(0.047, 10);
    expect(group.bestPair.borosImpactApr).toBeCloseTo(-0.002, 10);
    expect(typeof group.bestPair.netFixedApr).toBe('number');
  });

  it('serves a repeat request from cache and re-reads upstream with ?fresh=1', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(borosBodies(), calls) });
    mockGate(2);
    mockVenueBooks(2);

    await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    const afterFirst = calls.length; // markets + both order books
    expect(afterFirst).toBe(3);

    await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(calls.length).toBe(afterFirst);

    await app.inject({ method: 'GET', url: '/api/opportunities?fresh=1', headers: HOST });
    expect(calls.length).toBe(afterFirst * 2);
  });

  it('a poll one dashboard-cadence later adds NO Boros calls; past 30s it re-reads', async () => {
    // Books must ride the same 30s cadence as every other Boros read. At the
    // old 5s book TTL, the dashboard's 12s poll missed the cache on EVERY poll
    // and re-fetched every mapped market's book — ~97% of all Boros traffic
    // (25 live books × 300 polls ≈ 7.5k req/h from one open tab, 2026-07-29).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const calls: string[] = [];
      app = makeTestApp({ borosFetch: borosStub(borosBodies(), calls) });
      mockGate(3);
      mockVenueBooks(3);

      await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
      const afterFirst = calls.length; // markets + both order books
      expect(afterFirst).toBe(3);

      vi.setSystemTime(Date.now() + 12_000); // the next dashboard poll
      await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
      expect(calls.length).toBe(afterFirst);

      vi.setSystemTime(Date.now() + 20_000); // 32s after the first fetch
      await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
      expect(calls.length).toBe(afterFirst * 2); // markets + books re-read together
    } finally {
      vi.useRealTimers();
    }
  });

  it('unconfigured still prices in full: public listings + leverage, only the fees assumed', async () => {
    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      getClients: () => {
        throw new CoreError('no credentials', 'not-configured');
      },
    });
    // /rule/symbols and /rule/risk_limits need no credentials; /fee does, and is
    // deliberately NOT mocked — the route must fall back to the VIP 0 schedule.
    mockGatePublicRules();
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.warnings.join(' ')).toMatch(/Perp fees assume the VIP 0 Gate CrossEx schedule/);
    // Never claims the listings or leverage are missing — they aren't.
    expect(data.warnings.join(' ')).not.toMatch(/symbol list/);

    // Real symbols, so the SAME shape a configured scan returns.
    const group = data.groups[0];
    const pair = group.bestPair;
    expect(pair).not.toBeNull();
    expect(pair.shortLeg.crossexSymbol).toBe('HYPERLIQUID_FUTURE_ETH_USDC');
    expect(pair.longLeg.crossexSymbol).toBe('BINANCE_FUTURE_ETH_USDT');
    // Capital and the APR on it now compute — the whole point of this path.
    expect(pair.capital.shortLeverageMax).toBe(20);
    expect(pair.capital.longLeverageMax).toBe(25);
    expect(pair.capitalUsd).toBeGreaterThan(0);
    expect(typeof pair.netFixedAprOnCapital).toBe('number');
    expect(typeof pair.estProfitUsd).toBe('number');
    // VIP 0 taker on both crossing legs.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(10_000 * (0.0005 + 0.0005), 8);
  });

  it('never 503s when even the public rule endpoints are unreachable', async () => {
    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      getClients: () => {
        throw new CoreError('no credentials', 'not-configured');
      },
    });
    // No Gate mocks at all: nock blocks the public reads too.
    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.warnings.join(' ')).toMatch(/Couldn't load the CrossEx symbol list right now/);
    // The Boros spread still prices; the perp side degrades to null.
    const group = data.groups[0];
    expect(group.pairs[0].grossSpreadApr).toBeGreaterThan(0);
    expect(group.pairs[0].capitalUsd).toBeNull();
    expect(group.bestPair).toBeNull();
  });

  it('prices from the VENUE:BASE fallback books when the symbol universe is unreachable', async () => {
    app = makeTestApp({
      borosFetch: borosStub(borosBodies()),
      getClients: () => {
        throw new CoreError('no credentials', 'not-configured');
      },
    });
    // No Gate mocks — only the PUBLIC venue books, fetched under the VENUE:BASE
    // fallback keys (Hyperliquid POST /info, Binance ETHUSDT depth).
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities?feeTier=vip0',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    const pair = data.groups[0].pairs[0];
    expect(pair.shortLeg.crossexSymbol).toBeNull();
    // VIP0 CrossEx futures: 0.02% maker / 0.05% taker on every venue — both
    // legs cross, so entry fees are $10k × (5bps + 5bps).
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(10_000 * (0.0005 + 0.0005), 8);
    expect(pair.costs.perpEntrySlippageUsd).toBeGreaterThan(0);
    expect(typeof pair.netFixedApr).toBe('number');
    expect(typeof pair.estProfitUsd).toBe('number');
    // Without the risk-limit table there is no leverage cap to size margin with.
    expect(pair.capitalUsd).toBeNull();
    expect(data.groups[0].bestPair).toBeNull();
  });

  it('a higher simulated tier charges lower fees than VIP0 on the same books', async () => {
    const run = async (tier: string) => {
      app = makeTestApp({
        borosFetch: borosStub(borosBodies()),
        getClients: () => {
          throw new CoreError('no credentials', 'not-configured');
        },
      });
      mockVenueBooks();
      const res = await app.inject({
        method: 'GET',
        url: `/api/opportunities?feeTier=${tier}`,
        headers: HOST,
      });
      expect(res.statusCode).toBe(200);
      const pair = res.json().data.groups[0].pairs[0];
      await app.close();
      app = undefined;
      return pair;
    };

    const vip0 = await run('vip0');
    const vip8 = await run('vip8');
    expect(vip8.costs.perpEntryFeesUsd).toBeLessThan(vip0.costs.perpEntryFeesUsd);
    expect(vip8.netFixedApr).toBeGreaterThan(vip0.netFixedApr);
  });

  it('feeTier overrides the live fee schedule when configured', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    mockGate();
    mockVenueBooks();

    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities?feeTier=vip0',
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const pair = res.json().data.groups[0].bestPair;
    // The account rows (0.048% taker, mocked) are ignored: VIP0 taker is 0.05%
    // on both legs, so $10k × 10bps of entry fees, not $10k × 9.6bps.
    expect(pair.costs.perpEntryFeesUsd).toBeCloseTo(10_000 * 0.001, 8);
  });

  it('rejects an unknown feeTier', async () => {
    app = makeTestApp({ borosFetch: borosStub(borosBodies()) });
    const res = await app.inject({
      method: 'GET',
      url: '/api/opportunities?feeTier=vip99',
      headers: HOST,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.category).toBe('validation');
  });

  it('maps a Boros /markets failure to a 502 network envelope', async () => {
    app = makeTestApp({
      borosFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.category).toBe('network');
  });

  it('degrades ONE missing Boros book to an unavailable market, not a failed request', async () => {
    const bodies = borosBodies();
    delete bodies[`/core/v1/order-books/${BINANCE_MARKET}`]; // stub 404s it
    app = makeTestApp({ borosFetch: borosStub(bodies) });
    mockGate();
    mockVenueBooks();

    const res = await app.inject({ method: 'GET', url: '/api/opportunities', headers: HOST });
    expect(res.statusCode).toBe(200);
    const group = res.json().data.groups[0];

    const byId = new Map<number, { bookStatus: string; execLongApr: number | null }>(
      group.markets.map((m: { marketId: number; bookStatus: string; execLongApr: number | null }) => [
        m.marketId,
        m,
      ]),
    );
    expect(byId.get(HL_MARKET)?.bookStatus).toBe('ok');
    expect(byId.get(BINANCE_MARKET)?.bookStatus).toBe('unavailable');
    expect(byId.get(BINANCE_MARKET)?.execLongApr).toBeNull();

    // The pair survives with a null rate and a sentence naming the missing book.
    const pair = group.pairs[0];
    expect(pair.execSpreadApr).toBeNull();
    expect(pair.netFixedApr).toBeNull();
    expect(pair.grossSpreadApr).toBeCloseTo(0.045, 10);
    expect(pair.reasons.join(' ')).toMatch(/No Boros order book for Binance ETH 30d/);
    expect(group.bestPair).toBeNull();

    // No lockable rate means no Boros IM either, so capital degrades with it —
    // and says so, rather than leaving the panel's "see the notes" pointing at
    // an explanation the pair never carries.
    expect(pair.capital.borosLongImUsd).toBeNull();
    expect(pair.capitalUsd).toBeNull();
    expect(pair.netFixedAprOnCapital).toBeNull();
    expect(pair.reasons.join(' ')).toMatch(
      /Binance ETH 30d \(market #\d+\) has no lockable rate at \$10,000 — its Boros initial margin can't be modelled/,
    );
  });
});
