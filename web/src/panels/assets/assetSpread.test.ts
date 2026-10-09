import { describe, expect, it } from 'vitest';
import type { AssetBorosHistory, AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { borosOnlyPairs, deriveAsset, pairBorosCloseLegs, pairLockedSpread, perpOnlyPairs } from './assetModel';

const NOW = 1_791_417_600;
const NOV27 = 1_795_737_600;
const PRICE = 2568;
const SPREAD: [string, string] = ['HYPERLIQUID', 'GATE'];

const perp = (venue: string, side: 'LONG' | 'SHORT', qty: number): AssetPerpOpen => ({
  symbol: `${venue}_FUTURE_ETH_USDT`,
  venue,
  side,
  qty,
  notionalUsd: qty * PRICE,
  entryPrice: PRICE,
  markPrice: PRICE,
  leverage: 25,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: (qty * PRICE) / 25,
  openedAt: NOW - 2 * 86_400,
});

const boros = (
  marketId: number,
  side: 'LONG' | 'SHORT',
  sizeToken: number,
  entryApr: number,
  spreadVenues: [string, string] | null,
  venue = spreadVenues ? spreadVenues[0] : 'HYPERLIQUID',
): AssetBorosOpen => ({
  marketId,
  venue,
  spreadVenues,
  maturity: NOV27,
  collateral: 'ETH',
  side,
  sizeToken,
  notionalUsd: sizeToken * PRICE,
  entryApr,
  markApr: entryApr,
  floatingApr: entryApr,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: sizeToken * 10,
  settleFeeApr: spreadVenues ? 0.002 : 0.001,
});

const history = (
  marketId: number,
  venue: string,
  spreadVenues: [string, string] | null,
  settleUsd: number,
  tradeFeeUsd: number,
): AssetBorosHistory => ({
  marketId,
  venue,
  spreadVenues,
  maturity: NOV27,
  settleUsd,
  settleFeeUsd: 0.01,
  tradePnlUsd: -tradeFeeUsd,
  tradeFeeUsd,
  firstEventSec: NOW - 86_400,
});

const group = (o: Partial<AssetGroup>): AssetGroup => ({
  base: 'ETH',
  supported: true,
  priceUsd: PRICE,
  earliestSec: NOW - 2 * 86_400,
  perpOpen: [],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
  ...o,
});

const ownerPerps = (qty = 0.555) => [perp('GATE', 'LONG', qty), perp('HYPERLIQUID', 'SHORT', qty)];

const mixedBook = (k = 1) => [
  boros(51, 'SHORT', 0.3 * k, 0.083, null, 'HYPERLIQUID'),
  boros(60, 'LONG', 0.3 * k, 0.0482, null, 'GATE'),
  boros(59, 'SHORT', 0.255 * k, 0.0352, SPREAD),
];

const venue = (d: ReturnType<typeof deriveAsset>, name: string) => d.venues.find((v) => v.venue === name);

describe('a spread leg in the Positions model', () => {
  it('spread hedges both venues', () => {
    const d = deriveAsset(group({ perpOpen: ownerPerps(), borosOpen: [boros(59, 'SHORT', 0.555, 0.0352, SPREAD)] }), {}, 0, NOW);
    expect(venue(d, 'HYPERLIQUID')?.gap).toBeCloseTo(0, 9);
    expect(venue(d, 'GATE')?.gap).toBeCloseTo(0, 9);
    expect(d.gaps).toEqual([]);
    expect(d.pairs).toHaveLength(1);
    const yu = d.pairs[0].legs.filter((l) => l.kind === 'yu');
    expect(yu).toHaveLength(1);
    expect(yu[0].spreadVenues).toEqual(SPREAD);
    expect(d.pairs[0].size).toBeCloseTo(0.555, 9);
    expect(d.unpairedPerps).toEqual([]);
    expect(d.pendingLegs).toEqual([]);
    expect(perpOnlyPairs(d.unpairedPerps, d.pendingLegs).pairs).toEqual([]);
    expect(pairLockedSpread(d.pairs[0])).toBeCloseTo(0.0352 - 0.002, 9);
    expect(d.lockedAprFwd).not.toBeNull();
  });

  it('mixed book is one book', () => {
    const d = deriveAsset(group({ perpOpen: ownerPerps(), borosOpen: mixedBook() }), {}, 0, NOW);
    expect(venue(d, 'HYPERLIQUID')?.borosSigned).toBeCloseTo(-0.555, 9);
    expect(venue(d, 'GATE')?.borosSigned).toBeCloseTo(0.555, 9);
    expect(d.gaps).toEqual([]);
    expect(d.pairs).toHaveLength(1);
    const pair = d.pairs[0];
    expect(pair.legs.filter((l) => l.kind === 'yu')).toHaveLength(3);
    expect(pair.size).toBeCloseTo(0.555, 9);
    expect(pairBorosCloseLegs(pair, group({ borosOpen: mixedBook() })).map((l) => l.notionalToken)).toEqual([
      expect.closeTo(0.3, 9),
      expect.closeTo(0.3, 9),
      expect.closeTo(0.255, 9),
    ]);
    const carry = (0.083 - 0.0482 - 0.002) * 0.3 + (0.0352 - 0.002) * 0.255;
    expect(pairLockedSpread(pair)).toBeCloseTo(carry / 0.555, 9);
  });

  it.each([
    ['$50', 50 / PRICE / 0.555],
    ['$6M', 6_000_000 / PRICE / 0.555],
  ])('mixed book is one book at %s', (_label, k) => {
    const d = deriveAsset(group({ perpOpen: ownerPerps(0.555 * k), borosOpen: mixedBook(k) }), {}, 0, NOW);
    expect(d.gaps).toEqual([]);
    expect(d.pairs).toHaveLength(1);
    expect(d.pairs[0].size).toBeCloseTo(0.555 * k, 9);
    expect(d.pendingLegs).toEqual([]);
    expect(d.unpairedPerps).toEqual([]);
  });

  it('spread counted once', () => {
    const d = deriveAsset(
      group({
        perpOpen: ownerPerps(),
        borosOpen: mixedBook(),
        borosHistory: [
          history(51, 'HYPERLIQUID', null, 0.4, 0.02),
          history(60, 'GATE', null, -0.2, 0.03),
          history(59, 'HYPERLIQUID', SPREAD, 0.05, 0.04),
        ],
      }),
      {},
      0,
      NOW,
    );
    expect(d.totals.breakdown.borosSettleUsd).toBeCloseTo(0.4 - 0.2 + 0.05, 9);
    expect(d.totals.breakdown.borosTradeFeeUsd).toBeCloseTo(0.09, 9);
    expect(d.pairs[0].borosFeesPaidUsd).toBeCloseTo(0.09, 9);
  });

  it('wrong-side spread stands alone', () => {
    const d = deriveAsset(group({ perpOpen: ownerPerps(), borosOpen: [boros(59, 'LONG', 0.555, 0.0352, SPREAD)] }), {}, 0, NOW);
    expect(d.pairs).toEqual([]);
    const perpOnly = perpOnlyPairs(d.unpairedPerps, d.pendingLegs);
    expect(perpOnly.pairs).toHaveLength(1);
    expect(perpOnly.pairs[0].longYu).toBeNull();
    expect(perpOnly.pairs[0].shortYu).toBeNull();
    expect(perpOnly.pairs[0].missingLong).toBeCloseTo(0.555, 9);
    expect(perpOnly.pairs[0].missingShort).toBeCloseTo(0.555, 9);
    const units = borosOnlyPairs(perpOnly.restPerps, perpOnly.restYus);
    expect(units.pairs).toHaveLength(1);
    expect(units.pairs[0].borosLegs).toHaveLength(1);
    expect(units.pairs[0].borosLegs[0]).toMatchObject({ marketId: 59, side: 'LONG', spreadVenues: SPREAD });
    expect(units.restYus).toEqual([]);
  });

  it('spread without perps', () => {
    const d = deriveAsset(group({ borosOpen: [boros(59, 'SHORT', 0.555, 0.0352, SPREAD)] }), {}, 0, NOW);
    expect(d.pairs).toEqual([]);
    const perpOnly = perpOnlyPairs(d.unpairedPerps, d.pendingLegs);
    expect(perpOnly.pairs).toEqual([]);
    const units = borosOnlyPairs(perpOnly.restPerps, perpOnly.restYus);
    expect(units.pairs).toHaveLength(1);
    const unit = units.pairs[0];
    expect(unit.borosLegs).toHaveLength(1);
    expect(unit.borosLegs[0]).toMatchObject({ marketId: 59, spreadVenues: SPREAD });
    expect(unit).toMatchObject({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', longYu: null, shortYu: null });
    expect(unit.size).toBeCloseTo(0.555, 9);
    expect(unit.missingLong).toBeCloseTo(0.555, 9);
    expect(unit.missingShort).toBeCloseTo(0.555, 9);
    expect(unit.lockedSpread).toBeCloseTo(0.0352 - 0.002, 9);
  });
});
