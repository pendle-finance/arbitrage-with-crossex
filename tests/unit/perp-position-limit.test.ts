/**
 * The perp position limit, and the capital solve that sizes an Opportunities
 * pair with it, on the CrossEx tables for BTC and ETH recorded 2026-10-27 from
 * the public `/crossex/rule/risk_limits` endpoint.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import {
  buildOpportunities,
  notionalForCapital,
  type BuildOpportunitiesInput,
  type OpportunityPair,
} from '../../src/core/boros/opportunities';
import type { NormalizedBook } from '../../src/core/estimate/books';
import { positionLimitOf, type PositionLimit } from '../../src/core/positionLimit';
import { imInputs } from '../helpers/boros-fixtures';

interface RecordedRow {
  symbol: string;
  tiers: { max_risk_limit_value: string; leverage_max: string }[];
}

const recorded: RecordedRow[] = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/gate/risk-limits-btc-eth.json'), 'utf8'),
);
const LIMITS = new Map(
  recorded.map((r) => [
    r.symbol,
    positionLimitOf(r.tiers.map((t) => ({ maxRiskLimitValue: t.max_risk_limit_value, leverageMax: t.leverage_max })))!,
  ]),
);
const limitOf = (symbol: string): PositionLimit => LIMITS.get(symbol)!;

describe('positionLimitOf', () => {
  it('stops at the last tier that still allows the top leverage', () => {
    expect(limitOf('GATE_FUTURE_BTC_USDT')).toEqual({ leverage: 25, maxUsd: 50_000_000 });
    expect(limitOf('GATE_FUTURE_ETH_USDT')).toEqual({ leverage: 25, maxUsd: 50_000_000 });
    expect(limitOf('BINANCE_FUTURE_BTC_USDT')).toEqual({ leverage: 25, maxUsd: 350_000_000 });
    expect(limitOf('BINANCE_FUTURE_ETH_USDT')).toEqual({ leverage: 25, maxUsd: 250_000_000 });
  });

  it('takes a one-tier table whole', () => {
    expect(limitOf('HYPERLIQUID_FUTURE_BTC_USDC')).toEqual({ leverage: 40, maxUsd: 150_000_000 });
    expect(limitOf('HYPERLIQUID_FUTURE_ETH_USDC')).toEqual({ leverage: 25, maxUsd: 100_000_000 });
    expect(limitOf('LIGHTER_FUTURE_BTC_USDC')).toEqual({ leverage: 50, maxUsd: 999_999_999 });
  });

  it('reads no limit from a table with an unreadable tier', () => {
    expect(
      positionLimitOf([
        { maxRiskLimitValue: '1000', leverageMax: '25' },
        { maxRiskLimitValue: '', leverageMax: '25' },
      ]),
    ).toBeNull();
    expect(positionLimitOf([])).toBeNull();
    expect(positionLimitOf(undefined)).toBeNull();
  });
});

describe('notionalForCapital with a largest position', () => {
  const capitalAt = (n: number): number => n / 25;

  it('a target the cap does not reach solves exactly', () => {
    expect(notionalForCapital(capitalAt, 1_000_000, 50_000_000)).toBeCloseTo(25_000_000, 0);
  });

  it('a target past the cap stops at the cap', () => {
    expect(notionalForCapital(capitalAt, 5_000_000, 50_000_000)).toBe(50_000_000);
    expect(notionalForCapital(capitalAt, 100_000_000, 50_000_000)).toBe(50_000_000);
  });
});

// ---------------------------------------------------------------------------
// Pairs on each venue, sized to $100k, $1M, $10M and $50M of capital.
// ---------------------------------------------------------------------------

const NOW = 1_752_000_000;
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;

const VENUES = [
  { venue: 'Gate', crossex: 'GATE', symbol: (c: string) => `GATE_FUTURE_${c}_USDT` },
  { venue: 'Hyperliquid', crossex: 'HYPERLIQUID', symbol: (c: string) => `HYPERLIQUID_FUTURE_${c}_USDC` },
  { venue: 'Binance', crossex: 'BINANCE', symbol: (c: string) => `BINANCE_FUTURE_${c}_USDT` },
  { venue: 'Lighter', crossex: 'LIGHTER', symbol: (c: string) => `LIGHTER_FUTURE_${c}_USDC` },
] as const;
type Venue = (typeof VENUES)[number];

const market = (marketId: number, venue: Venue, coin: string, midApr: number): BorosMarket => ({
  maxRateDeviationApr: 0.016,
  spreadVenues: null,
  marketId,
  tokenId: 3,
  name: `${venue.venue} ${coin} 30 days`,
  venue: venue.venue,
  base: coin,
  maturity: MATURITY,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: midApr,
  floatingApr: midApr,
  midApr,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 1_000,
  ...imInputs,
});

/** Books deep enough for $2B, so only margin and the position cap limit size. */
const DEEP = 2_000_000_000;
const borosBook = (marketId: number, mid: number): BorosOrderBook => ({
  marketId,
  bids: [[mid - 0.0001, DEEP]],
  asks: [[mid + 0.0001, DEEP]],
});
const perpBook: NormalizedBook = { bids: [[999.9, DEEP / 1000]], asks: [[1000.1, DEEP / 1000]], ts: 0 };

type Limits = (symbol: string) => PositionLimit;

/** Rich market on `rich` (9%), cheap on `cheap` (4.5%): one pair, shorting `rich`. */
function pairInput(rich: Venue, cheap: Venue, coin: string, limits: Limits): BuildOpportunitiesInput {
  const symbols = [rich.symbol(coin), cheap.symbol(coin)];
  return {
    markets: [market(1, rich, coin, 0.09), market(2, cheap, coin, 0.045)],
    collateralPricesUsd: new Map([[3, 1]]),
    borosBooks: new Map([
      [1, borosBook(1, 0.09)],
      [2, borosBook(2, 0.045)],
    ]),
    venueBooks: new Map(symbols.map((s) => [s, perpBook])),
    symbolsByVenueBase: new Map([
      [`${rich.crossex}:${coin}`, symbols[0]],
      [`${cheap.crossex}:${coin}`, symbols[1]],
    ]),
    crossexVenues: new Set(VENUES.map((v) => v.crossex)),
    positionLimitBySymbol: new Map(symbols.map((s) => [s, limits(s)])),
    feeRows: VENUES.map((v) => ({ exchangeType: v.crossex, futureMakerFee: '0.0002', futureTakerFee: '0.0005' })),
    nowSec: NOW,
  };
}

const sizes = { borosEntry: 'market', entryMode: 'both-market', exitMode: 'close' } as const;

const priced = (rich: Venue, cheap: Venue, coin: string, capitalUsd: number, limits: Limits): OpportunityPair =>
  buildOpportunities(pairInput(rich, cheap, coin, limits), { ...sizes, notionalUsd: 0, capitalUsd }).groups[0]
    .pairs[0];

/** The model before the cap: the venue max leverage at every size. */
const uncapped: Limits = (s) => ({ ...limitOf(s), maxUsd: Infinity });

it('a notional past the largest position leaves capital unknown and says why', () => {
  const pair = buildOpportunities(pairInput(VENUES[1], VENUES[3], 'BTC', limitOf), { ...sizes, notionalUsd: 200_000_000 })
    .groups[0].pairs[0];
  expect(pair.capitalUsd).toBeNull();
  expect(pair.reasons).toContain(
    '$200,000,000 is above the largest HYPERLIQUID HYPERLIQUID_FUTURE_BTC_USDC position CrossEx takes ($150,000,000).',
  );
});

const CAPITALS = [100_000, 1_000_000, 10_000_000, 50_000_000];
const PAIRS = VENUES.flatMap((a, i) => VENUES.slice(i + 1).map((b) => [a, b] as const));

describe.each(['BTC', 'ETH'])('%s pairs sized by capital on the recorded limits', (coin) => {
  describe.each(PAIRS.map(([a, b]) => [`${a.venue}–${b.venue}`, a, b] as const))('%s', (_label, rich, cheap) => {
    it.each(CAPITALS)('$%d of capital', (capitalUsd) => {
      const before = priced(rich, cheap, coin, capitalUsd, uncapped);
      const after = priced(rich, cheap, coin, capitalUsd, limitOf);
      const short = limitOf(rich.symbol(coin));
      const long = limitOf(cheap.symbol(coin));
      const cap = Math.min(short.maxUsd, long.maxUsd);
      const n = after.notionalUsd;

      // Both perp legs post margin at the venue max leverage, and the size
      // never passes the smaller leg's largest position.
      expect(after.capital.shortLeverageMax).toBe(short.leverage);
      expect(after.capital.longLeverageMax).toBe(long.leverage);
      expect(after.capital.perpShortImUsd).toBeCloseTo(n / short.leverage, 2);
      expect(after.capital.perpLongImUsd).toBeCloseTo(n / long.leverage, 2);
      expect(n).toBeLessThanOrEqual(cap);

      if (before.notionalUsd <= cap) {
        // The cap does not bind: the solve is unchanged.
        expect(n).toBeCloseTo(before.notionalUsd, 0);
        expect(after.capitalUsd! / capitalUsd).toBeCloseTo(1, 6);
        expect(after.netFixedAprOnCapital!).toBeCloseTo(before.netFixedAprOnCapital!, 10);
      } else {
        // It binds: the pair stops at the cap, with less capital, and says so.
        expect(n).toBe(cap);
        expect(after.capitalUsd!).toBeLessThan(capitalUsd);
        expect(after.reasons.some((r) => r.startsWith('This pair takes at most'))).toBe(true);
      }
    });
  });
});
