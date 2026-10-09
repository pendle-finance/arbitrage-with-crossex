import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpportunitiesResult, OpportunityPair } from '../../src/core/boros/opportunities';
import { raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

type RawMarket = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
) as { results: RawMarket[] };

const NOW_MS = Date.UTC(2026, 9, 8);
const NOV_27 = 1795737600;
const DEC_25 = 1798156800;
const ETH_PRICE = 2571.7;
const NOTIONAL = 10_000;
const BTC = 1;
const ETH = 2;

const rowOf = (marketId: number): RawMarket => {
  const row = fixture.results.find((r) => r.marketId === marketId);
  if (!row) throw new Error(`fixture has no market ${marketId}`);
  return row;
};

const withRates = (row: RawMarket, midApr: number): RawMarket => ({
  ...row,
  data: { ...(row.data as RawMarket), midApr, markApr: midApr },
});

const withStatus = (row: RawMarket, status: number): RawMarket => ({
  ...row,
  config: { ...(row.config as RawMarket), status },
});

const onPlatform = (row: RawMarket, marketId: number, platformId: string): RawMarket => ({
  ...row,
  marketId,
  platform: { name: platformId, platformId },
});

const book = (bidTick: number, askTick: number, bidSize = 5_000) => ({
  long: { ia: [bidTick], sz: [raw(bidSize)] },
  short: { ia: [askTick], sz: [raw(5_000)] },
});

const ruleSymbols = [
  'HYPERLIQUID_FUTURE_ETH_USDC',
  'GATE_FUTURE_ETH_USDT',
  'OKX_FUTURE_ETH_USDT',
  'LIGHTER_FUTURE_ETH_USDC',
  'HYPERLIQUID_FUTURE_BTC_USDC',
  'GATE_FUTURE_BTC_USDT',
].map(
  (symbol) => ({ symbol, exchange_type: symbol.split('_')[0], business_type: 'FUTURE', state: 'live' }),
);
const feeRows = ['HYPERLIQUID', 'GATE', 'OKX', 'LIGHTER'].map((exchange_type) => ({
  exchange_type,
  future_maker_fee: '0.0002',
  future_taker_fee: '0.00048',
}));
const riskLimits = ruleSymbols.map(({ symbol }) => ({ symbol, tiers: [{ leverage_max: '20' }] }));

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
});

async function opportunities(
  results: RawMarket[],
  books: Record<number, ReturnType<typeof book>> = {},
  symbols: typeof ruleSymbols = ruleSymbols,
): Promise<OpportunitiesResult> {
  const bodies: Record<string, unknown> = {
    '/apis/v1/markets': { results, total: results.length, skip: 0 },
    '/apis/v1/markets/order-book': book(599, 601),
  };
  for (const [marketId, body] of Object.entries(books)) {
    bodies[`/apis/v1/markets/order-book?marketId=${marketId}`] = body;
  }
  app = makeTestApp({ borosFetch: borosStub(bodies) });
  mockGateGet('/rule/symbols', { body: symbols });
  mockGateGet('/rule/risk_limits', { body: riskLimits });
  mockGateGet('/fee', { body: feeRows });
  const res = await app.inject({ method: 'GET', url: `/api/opportunities?notionalUsd=${NOTIONAL}`, headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data as OpportunitiesResult;
}

const pairsAt = (data: OpportunitiesResult, maturity: number, tokenId = ETH): OpportunityPair[] =>
  data.groups.filter((g) => g.maturity === maturity && g.tokenId === tokenId).flatMap((g) => g.pairs);

const hlGatePair = (data: OpportunitiesResult, maturity: number, tokenId = ETH): OpportunityPair | undefined =>
  pairsAt(data, maturity, tokenId).find((p) =>
    [p.shortLeg.crossexVenue, p.longLeg.crossexVenue].sort().join('/') === 'GATE/HYPERLIQUID',
  );

describe('GET /api/opportunities with spread markets', () => {
  it('spread is not a venue', async () => {
    const data = await opportunities(fixture.results);
    const group = data.groups.find((g) => g.maturity === NOV_27 && g.tokenId === ETH);
    expect(group?.markets.map((m) => m.marketId)).toEqual([51, 60]);
    const warnings = [...data.warnings, ...data.groups.flatMap((g) => g.warnings)];
    expect(warnings.filter((w) => w.toLowerCase().includes('hyperliquid-gate'))).toEqual([]);
  });

  it('pair uses the spread', async () => {
    const data = await opportunities(fixture.results);
    const pair = hlGatePair(data, NOV_27);
    expect(pair?.shortLeg.venue).toBe('Hyperliquid');
    expect(pair?.shortLeg.crossexVenue).toBe('HYPERLIQUID');
    expect(pair?.longLeg.crossexVenue).toBe('GATE');
    expect(pair?.borosLegs).toHaveLength(1);
    expect(pair?.borosLegs[0]).toMatchObject({
      marketId: 59,
      side: 'SHORT',
      venue: 'HL-Gate',
      spreadVenues: ['HYPERLIQUID', 'GATE'],
    });
    expect(pair?.grossSpreadApr).toBeCloseTo(0.060003169697689526, 12);
    expect(pair?.execSpreadApr).toBeCloseTo(0.0599, 12);
    const ids = pairsAt(data, NOV_27).map((p) => p.borosLegs.map((l) => l.marketId).sort());
    expect(ids).not.toContainEqual([51, 60]);
  });

  it('direction follows the perps', async () => {
    const results = fixture.results.map((r) => (r.marketId === 59 ? withRates(r, -0.03) : r));
    const data = await opportunities(results, { 59: book(-301, -299) });
    const pair = hlGatePair(data, NOV_27);
    expect(pair?.shortLeg.crossexVenue).toBe('GATE');
    expect(pair?.longLeg.crossexVenue).toBe('HYPERLIQUID');
    expect(pair?.borosLegs).toHaveLength(1);
    expect(pair?.borosLegs[0]).toMatchObject({ marketId: 59, side: 'LONG' });
    expect(pair?.grossSpreadApr).toBeCloseTo(0.03, 12);
    expect(pair?.execSpreadApr).toBeCloseTo(0.0299, 12);
  });

  it('BTC spread with no singles makes a pair', async () => {
    const data = await opportunities(fixture.results);
    const group = data.groups.find((g) => g.maturity === NOV_27 && g.tokenId === BTC);
    expect(group?.markets).toEqual([]);
    expect(group?.pairs).toHaveLength(1);
    const pair = group?.pairs[0];
    expect(pair?.base).toBe('BTC');
    expect(pair?.shortLeg).toMatchObject({ crossexVenue: 'HYPERLIQUID', crossexSymbol: 'HYPERLIQUID_FUTURE_BTC_USDC' });
    expect(pair?.longLeg).toMatchObject({ crossexVenue: 'GATE', crossexSymbol: 'GATE_FUTURE_BTC_USDT' });
    expect(pair?.borosLegs.map((l) => [l.marketId, l.side])).toEqual([[58, 'SHORT']]);
    expect(pair?.capital.borosIms.map((l) => l.marketId)).toEqual([58]);
    expect(pair?.capitalUsd).not.toBeNull();
  });

  it('a spread perp with no CrossEx symbol warns like a single', async () => {
    const symbols = ruleSymbols.filter((s) => s.symbol !== 'GATE_FUTURE_BTC_USDT');
    const data = await opportunities(fixture.results, {}, symbols);
    const group = data.groups.find((g) => g.maturity === NOV_27 && g.tokenId === BTC);
    expect(group?.pairs[0]?.longLeg).toMatchObject({ crossexVenue: 'GATE', crossexSymbol: null });
    expect(group?.warnings.join(' ')).toMatch(/No live CrossEx GATE symbol for BTC/);
  });

  it('no spread keeps two legs', async () => {
    const results = [
      ...fixture.results,
      withRates(onPlatform(rowOf(64), 901, 'OKX'), 0.08),
      withRates(onPlatform(rowOf(65), 902, 'Lighter'), 0.05),
    ];
    const data = await opportunities(results);
    const pair = pairsAt(data, DEC_25).find(
      (p) => p.shortLeg.crossexVenue === 'OKX' && p.longLeg.crossexVenue === 'LIGHTER',
    );
    expect(pair?.borosLegs.map((l) => [l.marketId, l.side, l.spreadVenues])).toEqual([
      [901, 'SHORT', null],
      [902, 'LONG', null],
    ]);
    expect(pair?.capital.borosIms.map((l) => l.marketId)).toEqual([901, 902]);
    expect(pair?.grossSpreadApr).toBeCloseTo(0.03, 12);
  });

  it('paused spread hides the pair', async () => {
    for (const status of [0, 1]) {
      const results = fixture.results.map((r) => (r.marketId === 59 ? withStatus(r, status) : r));
      const data = await opportunities(results);
      expect(hlGatePair(data, NOV_27)).toBeUndefined();
      expect(pairsAt(data, NOV_27)).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('thin book still uses the spread', async () => {
    const data = await opportunities(fixture.results, { 59: book(599, 601, 50 / ETH_PRICE) });
    const pair = hlGatePair(data, NOV_27);
    expect(pair?.borosLegs.map((l) => l.marketId)).toEqual([59]);
    expect(pair?.execSpreadApr).toBeNull();
    expect(pair?.reasons).toContainEqual(
      expect.stringMatching(/market #59\) only has \$50 of receive-fixed depth — \$10,000 is needed/),
    );
  });

  it('one fee, one margin', async () => {
    const data = await opportunities(fixture.results);
    const pair = hlGatePair(data, NOV_27)!;
    const [leg] = pair.borosLegs;
    expect(leg.takerFeeRate).toBeCloseTo(0.001, 15);
    expect(leg.settleFeeApr).toBeCloseTo(0.002, 15);
    expect(pair.secondsToMaturity).toBe(50 * 86_400);
    const notionalYears = NOTIONAL * (50 / 365);
    expect(pair.costs.borosTakerFeeUsd).toBeCloseTo(0.001 * notionalYears, 9);
    expect(pair.costs.borosSettleFeeUsd).toBeCloseTo(0.002 * notionalYears, 9);
    const floor = 1.00005 ** (770 * 2) - 1;
    const kIM = 0.645161290322580645;
    expect(pair.capital.borosIms).toHaveLength(1);
    expect(pair.capital.borosIms[0].marketId).toBe(59);
    expect(pair.capital.borosIms[0].imUsd).toBeCloseTo(notionalYears * floor * kIM, 6);
    expect(pair.capitalUsd).toBeCloseTo(notionalYears * floor * kIM + 2 * (NOTIONAL / 20), 6);
  });
});
