import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBorosMarket, fetchBorosMarkets, type BorosMarket, type FetchLike } from '../../src/core/boros/client';
import { groupBorosMarkets } from '../../src/core/boros/opportunities';
import { findSpread, isSpreadMarket, knownRateOf, parseSpreadVenues, readSpreadSide } from '../../src/core/boros/spread';
import { spreadName, spreadPlatform } from '../../web/src/lib/spread';

type RawMarket = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
) as { results: RawMarket[] };

const NOW_MS = Date.UTC(2026, 9, 8);
const OCT_30 = 1793318400;
const NOV_27 = 1795737600;
const DEC_25 = 1798156800;
const BTC = 1;
const ETH = 2;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(() => vi.useRealTimers());

const serve =
  (results: RawMarket[]): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => ({ results }) });

function rowOf(marketId: number): RawMarket {
  const row = fixture.results.find((r) => r.marketId === marketId);
  if (!row) throw new Error(`fixture has no market ${marketId}`);
  return row;
}

const withPlatformId = (marketId: number, platformId: string): RawMarket => ({
  ...rowOf(59),
  marketId,
  platform: { name: 'HL-GATE', platformId },
});

const withFloating = (row: RawMarket, floatingApr: number): RawMarket => ({
  ...row,
  data: { ...(row.data as RawMarket), floatingApr },
});

const withMetadata = (row: RawMarket, over: RawMarket): RawMarket => ({
  ...row,
  metadata: { ...(row.metadata as RawMarket), ...over },
});

const withStatus = (row: RawMarket, status: number): RawMarket => ({
  ...row,
  config: { ...(row.config as RawMarket), status },
});

const byId = (markets: BorosMarket[], marketId: number): BorosMarket => {
  const found = markets.find((m) => m.marketId === marketId);
  if (!found) throw new Error(`market ${marketId} missing`);
  return found;
};

describe('spread markets', () => {
  it('parses spread venues', async () => {
    const markets = await fetchBorosMarkets(serve(fixture.results));

    expect(markets.map((m) => m.marketId)).toEqual([51, 58, 59, 60, 61, 62, 63, 64, 65]);
    expect(byId(markets, 59).spreadVenues).toEqual(['HYPERLIQUID', 'GATE']);
    expect(byId(markets, 58).spreadVenues).toEqual(['HYPERLIQUID', 'GATE']);
    expect(byId(markets, 63).spreadVenues).toEqual(['HYPERLIQUID', 'GATE']);
    expect(byId(markets, 51).spreadVenues).toBeNull();
    expect(byId(markets, 60).spreadVenues).toBeNull();
    expect(byId(markets, 59).venue).toBe('HL-GATE');
    expect(byId(markets, 51).venue).toBe('Hyperliquid');
    expect(byId(markets, 60).venue).toBe('Gate');
    expect(isSpreadMarket(byId(markets, 59))).toBe(true);
    expect(isSpreadMarket(byId(markets, 51))).toBe(false);
    expect(byId(markets, 59).takerFeeRate).toBeCloseTo(0.001, 12);
    expect(byId(markets, 59).settleFeeApr).toBeCloseTo(0.002, 12);
    expect(byId(markets, 59).paymentPeriod).toBe(28800);
    expect(parseSpreadVenues(false, 'hyperliquid-gate')).toBeNull();
  });

  it('names a spread from its two venues and keeps a single market on its Boros name', async () => {
    const markets = await fetchBorosMarkets(serve(fixture.results));

    expect(byId(markets, 59).name).toBe('ETH Spread HL-GATE 27 Nov 2026');
    expect(byId(markets, 58).name).toBe('BTC Spread HL-GATE 27 Nov 2026');
    expect(byId(markets, 63).name).toBe('ETH Spread HL-GATE 30 Oct 2026');
    expect(byId(markets, 51).name).toBe('Hyperliquid ETH 27 Nov 2026');
    expect(byId(markets, 60).name).toBe('Gate ETHUSDT 27 Nov 2026');
  });

  it('drops an unreadable spread', async () => {
    expect(parseSpreadVenues(true, 'hyperliquid-gate-okx')).toBeNull();
    expect(parseSpreadVenues(true, 'gate-')).toBeNull();
    expect(parseSpreadVenues(true, 'gate-gate')).toBeNull();
    expect(parseSpreadVenues(true, 'Gate-gate')).toBeNull();
    expect(parseSpreadVenues(true, 'hyperliquid gate')).toBeNull();
    expect(parseSpreadVenues(true, '')).toBeNull();

    const markets = await fetchBorosMarkets(
      serve([...fixture.results, withPlatformId(901, 'hyperliquid-gate-okx'), withPlatformId(902, 'gate-')]),
    );
    const ids = markets.map((m) => m.marketId);
    expect(ids).not.toContain(901);
    expect(ids).not.toContain(902);

    const grouped = groupBorosMarkets(markets, NOW_MS / 1000).flatMap((g) => g.markets.map((m) => m.marketId));
    expect(grouped).toEqual(expect.arrayContaining([51, 60]));
    expect(grouped).not.toContain(901);
    expect(grouped).not.toContain(902);

    const history = await fetchBorosMarket(serve([withPlatformId(901, 'hyperliquid-gate-okx')]), 901);
    expect(history.spreadVenues).toBeNull();
    expect(isSpreadMarket(history)).toBe(false);
  });

  it('reads any two venues in leg order, as the backend prices leg 1 − leg 2', async () => {
    expect(parseSpreadVenues(true, 'hyperliquid-gate')).toEqual(['HYPERLIQUID', 'GATE']);
    expect(parseSpreadVenues(true, 'Hyperliquid-Gate')).toEqual(['HYPERLIQUID', 'GATE']);
    expect(parseSpreadVenues(true, 'gate-hyperliquid')).toEqual(['GATE', 'HYPERLIQUID']);
    expect(parseSpreadVenues(true, 'binance-okx')).toEqual(['BINANCE', 'OKX']);

    // Priced Gate − HL, as its leg order says.
    const reversed = withFloating(withPlatformId(903, 'gate-hyperliquid'), -0.04324286399999999);
    const markets = await fetchBorosMarkets(serve([reversed, ...fixture.results.filter((r) => r.marketId !== 59)]));
    const held = byId(markets, 903);
    expect(held.spreadVenues).toEqual(['GATE', 'HYPERLIQUID']);
    expect(held.name).toBe('ETH Spread GATE-HL 27 Nov 2026');
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })?.marketId).toBe(903);
    // Short the spread = short leg 1, here Gate.
    expect(readSpreadSide(held.spreadVenues!, { GATE: 'SHORT', HYPERLIQUID: 'LONG' })).toBe('SHORT');
    expect(readSpreadSide(held.spreadVenues!, { HYPERLIQUID: 'SHORT', GATE: 'LONG' })).toBe('LONG');

    const other = await fetchBorosMarkets(serve([withPlatformId(904, 'binance-okx')]));
    expect(byId(other, 904).spreadVenues).toEqual(['BINANCE', 'OKX']);
    expect(byId(other, 904).name).toBe('ETH Spread BINANCE-OKX 27 Nov 2026');
    expect(byId(other, 904).venue).toBe('BINANCE-OKX');
  });

  it('a spread Boros lists as a dev test takes no opens, but a held one still closes', async () => {
    const results = fixture.results.map((r) => (r.marketId === 59 ? withMetadata(r, { isUiWhitelisted: false }) : r));
    const markets = await fetchBorosMarkets(serve(results));
    expect(byId(markets, 59).state).toBe('CloseOnly');
    expect(byId(markets, 58).state).toBe('Normal');
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })).toBeNull();
    // A dev-test single keeps its state, as in 1.7.4.
    const single = fixture.results.map((r) => (r.marketId === 51 ? withMetadata(r, { isUiWhitelisted: false }) : r));
    expect(byId(await fetchBorosMarkets(serve(single)), 51).state).toBe('Normal');
    // A paused dev-test spread stays paused.
    const paused = fixture.results.map((r) =>
      r.marketId === 59 ? withStatus(withMetadata(r, { isUiWhitelisted: false }), 0) : r,
    );
    expect(byId(await fetchBorosMarkets(serve(paused)), 59).state).toBe('Paused');
  });

  it('finds the Normal spread for two venues in either order', async () => {
    const markets = await fetchBorosMarkets(serve(fixture.results));

    expect(findSpread({ markets, venues: ['GATE', 'HYPERLIQUID'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })?.marketId).toBe(59);
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })?.marketId).toBe(59);
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: NOV_27, tokenId: BTC, base: 'BTC' })?.marketId).toBe(58);
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: OCT_30, tokenId: ETH, base: 'ETH' })?.marketId).toBe(63);
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: DEC_25, tokenId: ETH, base: 'ETH' })).toBeNull();
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: NOV_27, tokenId: 3, base: 'ETH' })).toBeNull();
    expect(findSpread({ markets, venues: ['HYPERLIQUID', 'BINANCE'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })).toBeNull();
    expect(findSpread({ markets, venues: ['GATE', 'GATE'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })).toBeNull();
  });

  it('keeps two spreads with the same venues, maturity and collateral apart by base', async () => {
    const btcRow = {
      ...rowOf(59),
      marketId: 90,
      metadata: { ...(rowOf(59).metadata as RawMarket), underlyingSymbol: 'BTC' },
    };
    const markets = await fetchBorosMarkets(serve([...fixture.results, btcRow]));
    const venues = ['HYPERLIQUID', 'GATE'] as const;

    expect(byId(markets, 90).base).toBe('BTC');
    expect(findSpread({ markets, venues, maturity: NOV_27, tokenId: ETH, base: 'BTC' })?.marketId).toBe(90);
    expect(findSpread({ markets, venues, maturity: NOV_27, tokenId: ETH, base: 'ETH' })?.marketId).toBe(59);
  });

  it('refuses a paused or close-only spread', async () => {
    for (const [status, state] of [
      [0, 'Paused'],
      [1, 'CloseOnly'],
    ] as const) {
      const rows = fixture.results.map((r) => (r.marketId === 59 ? withStatus(r, status) : r));
      const markets = await fetchBorosMarkets(serve(rows));
      expect(byId(markets, 59).state).toBe(state);
      expect(findSpread({ markets, venues: ['HYPERLIQUID', 'GATE'], maturity: NOV_27, tokenId: ETH, base: 'ETH' })).toBeNull();
    }
  });

  it('reads a spread at 0 as a real rate, and a single at 0 as none', () => {
    const spread = { spreadVenues: ['HYPERLIQUID', 'GATE'] as [string, string] };
    const single = { spreadVenues: null };
    expect(knownRateOf(spread, 0)).toBe(true);
    expect(knownRateOf(spread, -0.01)).toBe(true);
    expect(knownRateOf(spread, Number.NaN)).toBe(false);
    expect(knownRateOf(single, 0)).toBe(false);
    expect(knownRateOf(single, -0.01)).toBe(true);
  });

  it('a spread with no mid falls back to its mark', async () => {
    const results = fixture.results.map((r) =>
      r.marketId === 59 ? { ...r, data: { ...(r.data as object), midApr: undefined, markApr: 0.012 } } : r,
    );
    const markets = await fetchBorosMarkets((async () => ({ ok: true, status: 200, json: async () => ({ results }) })) as unknown as FetchLike);
    expect(markets.find((m) => m.marketId === 59)?.midApr).toBe(0.012);
    expect(markets.find((m) => m.marketId === 51)?.midApr).not.toBe(0.012);
  });

  it('picks the spread side from the perps', () => {
    const venues = ['HYPERLIQUID', 'GATE'] as const;
    expect(readSpreadSide(venues, { GATE: 'LONG', HYPERLIQUID: 'SHORT' })).toBe('SHORT');
    expect(readSpreadSide(venues, { HYPERLIQUID: 'LONG', GATE: 'SHORT' })).toBe('LONG');
    expect(readSpreadSide(venues, { HYPERLIQUID: 'SHORT', GATE: 'SHORT' })).toBeNull();
    expect(readSpreadSide(venues, { HYPERLIQUID: 'SHORT', BINANCE: 'LONG' })).toBeNull();
    expect(readSpreadSide(venues, {})).toBeNull();
  });

  it('names the spread as the Boros app does', () => {
    expect(spreadPlatform(['HYPERLIQUID', 'GATE'])).toBe('HL-GATE');
    expect(spreadPlatform(['GATE', 'HYPERLIQUID'])).toBe('GATE-HL');
    expect(spreadPlatform(['BINANCE', 'OKX'])).toBe('BINANCE-OKX');
    expect(spreadName('ETH', ['HYPERLIQUID', 'GATE'])).toBe('ETH Spread HL-GATE');
  });
});
