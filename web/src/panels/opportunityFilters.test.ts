/** The flattening + facet logic behind the opportunities list. The panel test
 * covers the wiring; these cover the rules — what counts as viable, how the two
 * legs feed one venue dimension, and what a facet count actually counts. */
import { describe, expect, it } from 'vitest';
import type { OpportunityGroup, OpportunityPair } from '../api/types';
import {
  makeOpportunityGroup,
  makeOpportunityLeg,
  makeOpportunityPair,
  OPP_MATURITY,
} from '../test/fixtures';

import {
  applyFilters,
  facets,
  hasActiveFilter,
  loadFilters,
  maxDays,
  NO_FILTERS,
  OPPORTUNITY_FILTERS_STORAGE_KEY,
  saveFilters,
  toggleValue,
  toRows,
  type OpportunityFilters,
} from './opportunityFilters';

/** Distinct id per (side, venue) — deriving ids from the venue NAME's length
 * collapsed two venues of equal length onto one id, and the two market ids are
 * the whole discriminator in a row's key. */
const marketIds = new Map<string, number>();
const marketIdFor = (side: 'short' | 'long', venue: string): number => {
  const k = `${side}:${venue}`;
  if (!marketIds.has(k)) marketIds.set(k, 1000 + marketIds.size);
  return marketIds.get(k) as number;
};

/** A pair pinned to an APR and a pair of venues. The legs' CrossEx mapping
 * tracks the venue: the server never pairs two markets that map to the SAME
 * CrossEx venue, so leaving both at the default would build a shape it cannot
 * emit. */
function pair(
  apr: number | null,
  shortVenue: string,
  longVenue: string,
  over: Partial<OpportunityPair> = {},
): OpportunityPair {
  const leg = (side: 'short' | 'long', venue: string) =>
    makeOpportunityLeg({
      marketId: marketIdFor(side, venue),
      venue,
      crossexVenue: venue,
      crossexSymbol: `${venue}_FUTURE_ETH_${venue === 'HYPERLIQUID' ? 'USDC' : 'USDT'}`,
    });
  return makeOpportunityPair({
    shortLeg: leg('short', shortVenue),
    longLeg: leg('long', longVenue),
    netFixedAprOnCapital: apr,
    ...over,
  });
}

const filters = (over: Partial<OpportunityFilters> = {}): OpportunityFilters => ({
  ...NO_FILTERS,
  ...over,
});

describe('toRows', () => {
  it('emits one row per pair, not one per group', () => {
    const group = makeOpportunityGroup({
      pairs: [
        pair(0.09, 'HYPERLIQUID', 'BINANCE'),
        pair(0.05, 'HYPERLIQUID', 'GATE'),
        pair(0.02, 'BYBIT', 'GATE'),
      ],
    });

    expect(toRows([group]).map((r) => r.apr)).toEqual([0.09, 0.05, 0.02]);
  });

  it('drops the pairs that price nothing or price a loss', () => {
    const group = makeOpportunityGroup({
      pairs: [
        pair(0.09, 'HYPERLIQUID', 'BINANCE'),
        pair(null, 'HYPERLIQUID', 'GATE'),
        pair(-0.01, 'BYBIT', 'GATE'),
        pair(Number.NaN, 'OKX', 'GATE'),
      ],
    });

    expect(toRows([group])).toHaveLength(1);
  });

  it('ranks across groups on the APR, not on the server’s per-group order', () => {
    const eth = makeOpportunityGroup({
      tokenId: 3,
      underlying: 'ETH',
      pairs: [pair(0.09, 'HYPERLIQUID', 'BINANCE'), pair(0.01, 'HYPERLIQUID', 'GATE')],
    });
    const btc = makeOpportunityGroup({
      tokenId: 4,
      underlying: 'BTC',
      pairs: [pair(0.05, 'BYBIT', 'GATE', { base: 'BTC' })],
    });

    expect(toRows([eth, btc]).map((r) => r.apr)).toEqual([0.09, 0.05, 0.01]);
  });

  it('keys rows per pair and normalizes both legs’ venues', () => {
    const rows = toRows([
      makeOpportunityGroup({ pairs: [pair(0.09, 'Hyperliquid', 'Binance')] }),
    ]);

    expect(rows[0].venueKeys).toEqual(['HYPERLIQUID', 'BINANCE']);
    expect(rows[0].asset).toBe('ETH');
    expect(rows[0].days).toBe(30);
    expect(rows[0].key).toContain(String(rows[0].pair.shortLeg.marketId));
  });

  it('keys the asset on the cohort underlying, never a leg ticker', () => {
    // A fungible cohort: the server collapses XAU into GOLD, so one of its
    // pairs reports base 'XAU' and another 'GOLD'. Both belong to ONE chip.
    const rows = toRows([
      makeOpportunityGroup({
        underlying: 'GOLD',
        pairs: [
          pair(0.09, 'HYPERLIQUID', 'BINANCE', { base: 'XAU' }),
          pair(0.04, 'HYPERLIQUID', 'GATE', { base: 'GOLD' }),
        ],
      }),
    ]);

    expect(rows.map((r) => r.asset)).toEqual(['GOLD', 'GOLD']);
  });
});

// A three-asset, four-venue book the filter rules can be read off directly.
function book(): OpportunityGroup[] {
  return [
    makeOpportunityGroup({
      tokenId: 3,
      underlying: 'ETH',
      pairs: [
        pair(0.12, 'HYPERLIQUID', 'BINANCE'),
        pair(0.04, 'HYPERLIQUID', 'GATE'),
      ],
    }),
    makeOpportunityGroup({
      tokenId: 4,
      underlying: 'BTC',
      maturity: OPP_MATURITY + 86_400 * 60,
      secondsToMaturity: 30 * 86_400 + 60 * 86_400,
      pairs: [pair(0.08, 'BYBIT', 'GATE', { base: 'BTC' })],
    }),
  ];
}

describe('applyFilters', () => {
  it('passes everything through when nothing is selected', () => {
    const rows = toRows(book());
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(3);
  });

  it('ORs within a dimension and ANDs across them', () => {
    const rows = toRows(book());

    expect(applyFilters(rows, filters({ assets: ['ETH'] }))).toHaveLength(2);
    expect(applyFilters(rows, filters({ assets: ['ETH', 'BTC'] }))).toHaveLength(3);
    // ETH ∩ Gate — the ETH/Gate pair only.
    expect(applyFilters(rows, filters({ assets: ['ETH'], venues: ['GATE'] }))).toHaveLength(1);
  });

  it('matches a venue on either leg', () => {
    const rows = toRows(book());
    // Gate is the LONG leg of ETH/Gate and of BTC/Gate.
    expect(applyFilters(rows, filters({ venues: ['GATE'] })).map((r) => r.apr)).toEqual([0.08, 0.04]);
    // Hyperliquid is the SHORT leg of both ETH pairs.
    expect(applyFilters(rows, filters({ venues: ['HYPERLIQUID'] }))).toHaveLength(2);
  });

  it('caps the tenor by DAYS, inclusive of the number the card prints', () => {
    const rows = toRows(book());
    // The book is two 30-day ETH rows and one 90-day BTC row.
    expect(rows.map((r) => r.days)).toEqual([30, 90, 30]);

    expect(applyFilters(rows, filters({ maxDaysText: '30' })).map((r) => r.days)).toEqual([30, 30]);
    expect(applyFilters(rows, filters({ maxDaysText: '90' }))).toHaveLength(3);
    expect(applyFilters(rows, filters({ maxDaysText: '29' }))).toHaveLength(0);
  });

  it('ignores a tenor cap it cannot parse', () => {
    const rows = toRows(book());
    // A half-typed entry must never blank the list.
    expect(applyFilters(rows, filters({ maxDaysText: '3e' }))).toHaveLength(3);
    expect(applyFilters(rows, filters({ maxDaysText: '  ' }))).toHaveLength(3);
  });

  it('rejects every numeric literal that is not a plain decimal', () => {
    const rows = toRows(book());
    // `Number()` alone happily reads all of these, each as a silently wrong
    // cap that Number.isFinite would wave through.
    for (const text of ['0x10', '0o17', '0b11', '+5', '-5', '1e3', 'Infinity']) {
      expect(maxDays(filters({ maxDaysText: text }))).toBeNull();
      expect(applyFilters(rows, filters({ maxDaysText: text }))).toHaveLength(3);
      expect(hasActiveFilter(filters({ maxDaysText: text }))).toBe(false);
    }
    // Plain numbers still read, in every shape a person types them.
    expect(maxDays(filters({ maxDaysText: '60' }))).toBe(60);
    expect(maxDays(filters({ maxDaysText: '.5' }))).toBeCloseTo(0.5, 12);
    expect(maxDays(filters({ maxDaysText: '30.' }))).toBe(30);
  });
});

describe('toRows ranking + hysteresis', () => {
  it('breaks an APR tie on the server\u2019s own secondary keys, across groups', () => {
    // Group A ranks first, but its 0.05 pair is strictly worse than group B's
    // 0.05 pair. Insertion order is group-major, so stability alone would put
    // the worse trade first.
    const eth = makeOpportunityGroup({
      tokenId: 3,
      underlying: 'ETH',
      pairs: [
        pair(0.1, 'HYPERLIQUID', 'BINANCE'),
        pair(0.05, 'HYPERLIQUID', 'GATE', { netFixedApr: 0.001 }),
      ],
    });
    const btc = makeOpportunityGroup({
      tokenId: 4,
      underlying: 'BTC',
      pairs: [pair(0.05, 'BYBIT', 'GATE', { netFixedApr: 0.049 })],
    });

    expect(toRows([eth, btc]).map((r) => r.pair.netFixedApr)).toEqual([
      makeOpportunityPair().netFixedApr,
      0.049,
      0.001,
    ]);
  });

  it('holds a row already on screen just below zero, but never admits a new one', () => {
    const groups = [makeOpportunityGroup({ pairs: [pair(-0.002, 'HYPERLIQUID', 'BINANCE')] })];

    // Nothing shown yet: a negative pair has to clear zero to earn a slot.
    expect(toRows(groups)).toHaveLength(0);

    // Already on screen: it holds its place rather than flickering out and
    // shifting every row below it under the reader's cursor.
    const key = toRows([makeOpportunityGroup({ pairs: [pair(0.01, 'HYPERLIQUID', 'BINANCE')] })])[0]
      .key;
    expect(toRows(groups, new Set([key]))).toHaveLength(1);

    // The band is not a licence to show real losses.
    const loss = [makeOpportunityGroup({ pairs: [pair(-0.03, 'HYPERLIQUID', 'BINANCE')] })];
    expect(toRows(loss, new Set([key]))).toHaveLength(0);
  });
});

describe('facets', () => {
  it('counts each option against the OTHER dimensions, never against its own', () => {
    const rows = toRows(book());
    // With ETH picked, the ASSET chips still count over every row (so BTC reads
    // 1, the cards it would add) while the VENUE chips count within ETH only.
    const f = facets(rows, filters({ assets: ['ETH'] }));

    expect(f.assets).toEqual([
      { value: 'ETH', label: 'ETH', count: 2, selected: true },
      { value: 'BTC', label: 'BTC', count: 1, selected: false },
    ]);
    expect(f.venues.find((o) => o.value === 'BYBIT')).toMatchObject({ count: 0, selected: false });
    expect(f.venues.find((o) => o.value === 'GATE')).toMatchObject({ count: 1, label: 'Gate' });
    expect(f.venues.find((o) => o.value === 'HYPERLIQUID')).toMatchObject({ count: 2 });
  });

  it('keeps a SELECTED value listed after it leaves the data entirely', () => {
    // The poll drops every BTC row while the BTC chip is still armed. Without
    // the chip there is nothing on screen saying why the list is narrowed, and
    // nothing to click to undo it.
    const rows = toRows([
      makeOpportunityGroup({ tokenId: 3, underlying: 'ETH', pairs: [pair(0.12, 'HYPERLIQUID', 'BINANCE')] }),
    ]);
    const f = facets(rows, filters({ assets: ['BTC'] }));

    expect(f.assets.find((o) => o.value === 'BTC')).toMatchObject({ count: 0, selected: true });
  });

  it('reports the pool each dimension is counted against', () => {
    const rows = toRows(book());
    const f = facets(rows, NO_FILTERS);

    expect(f.poolSize).toEqual({ assets: 3, venues: 3 });
    // Every row carries BOTH its venues, so no single venue chip excludes
    // anything in a one-row list — which is how the bar knows not to show it.
    const one = toRows([makeOpportunityGroup({ pairs: [pair(0.12, 'HYPERLIQUID', 'BINANCE')] })]);
    const g = facets(one, NO_FILTERS);
    expect(g.venues).toHaveLength(2);
    expect(g.venues.every((o) => o.count === g.poolSize.venues)).toBe(true);
  });

  it('lists every option even when a filter excludes it, so it stays releasable', () => {
    const rows = toRows(book());
    const f = facets(rows, filters({ maxDaysText: '0' }));

    expect(f.assets.map((o) => o.value)).toEqual(['ETH', 'BTC']);
    expect(f.assets.every((o) => o.count === 0)).toBe(true);
  });

  it('ranks venues by their overall frequency', () => {
    const rows = toRows(book());
    const f = facets(rows, NO_FILTERS);

    // Gate and Hyperliquid appear twice each (alphabetical tiebreak), then the
    // singletons.
    expect(f.venues.map((o) => o.value)).toEqual(['GATE', 'HYPERLIQUID', 'BINANCE', 'BYBIT']);
  });
});

describe('persistence', () => {
  it('round-trips a selection', () => {
    const chosen = filters({ assets: ['BTC'], venues: ['GATE'], maxDaysText: '60' });
    saveFilters(chosen);

    expect(loadFilters()).toEqual(chosen);
  });

  it('falls back to no filters on a missing, corrupt or foreign blob', () => {
    expect(loadFilters()).toEqual(NO_FILTERS);

    localStorage.setItem(OPPORTUNITY_FILTERS_STORAGE_KEY, '{not json');
    expect(loadFilters()).toEqual(NO_FILTERS);

    localStorage.setItem(OPPORTUNITY_FILTERS_STORAGE_KEY, JSON.stringify({ assets: 'ETH' }));
    expect(loadFilters()).toEqual(NO_FILTERS);

    // A v1 blob carrying the fields this version dropped keeps what it can.
    localStorage.setItem(
      OPPORTUNITY_FILTERS_STORAGE_KEY,
      JSON.stringify({ assets: ['ETH', 7, null], venues: ['GATE'], maturities: [123], minAprPct: '5' }),
    );
    expect(loadFilters()).toEqual(filters({ assets: ['ETH'], venues: ['GATE'] }));
  });

  it('re-normalizes venue keys and drops a tenor cap it could not parse', () => {
    localStorage.setItem(
      OPPORTUNITY_FILTERS_STORAGE_KEY,
      JSON.stringify({ assets: [], venues: ['Gate', 'hyperliquid'], maxDaysText: '0x10' }),
    );

    // Restored as a red field the reader never typed into would be worse than
    // restored as no cap at all.
    expect(loadFilters()).toEqual(filters({ venues: ['GATE', 'HYPERLIQUID'] }));
  });
});

describe('filter state helpers', () => {
  it('toggleValue adds then removes', () => {
    expect(toggleValue(['ETH'], 'BTC')).toEqual(['ETH', 'BTC']);
    expect(toggleValue(['ETH', 'BTC'], 'ETH')).toEqual(['BTC']);
  });

  it('maxDays reads the cap in the same unit the rows carry', () => {
    expect(maxDays(filters({ maxDaysText: '60' }))).toBe(60);
    expect(maxDays(NO_FILTERS)).toBeNull();
    expect(maxDays(filters({ maxDaysText: 'abc' }))).toBeNull();
  });

  it('hasActiveFilter ignores an unparseable tenor cap', () => {
    expect(hasActiveFilter(NO_FILTERS)).toBe(false);
    expect(hasActiveFilter(filters({ venues: ['GATE'] }))).toBe(true);
    expect(hasActiveFilter(filters({ maxDaysText: '0' }))).toBe(true);
    expect(hasActiveFilter(filters({ maxDaysText: 'x' }))).toBe(false);
  });
});
