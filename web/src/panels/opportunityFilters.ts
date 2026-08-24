/**
 * The opportunities list is a flat list of PAIRS, not one card per group. A
 * group with three markets offers three different venue combinations, each its
 * own executable trade at its own APR — collapsing them to the group's best hid
 * every runner-up, including ones on venues the reader can actually reach.
 *
 * This module owns the flattening, the viability rule (a card must price a
 * non-negative net APR on capital) and the facet filtering the bar drives —
 * all pure, so the panel stays a rendering concern. The one exception is the
 * pair at the bottom that reads and writes the persisted selection.
 */
import type { OpportunityGroup, OpportunityPair } from '../api/types';
import { readJson, writeJson } from '../lib/storage';

/** One card's worth of data: the pair, plus the group context it renders in. */
export interface OpportunityRow {
  /** Stable per-pair identity — the group plus the two Boros markets it joins. */
  key: string;
  group: OpportunityGroup;
  pair: OpportunityPair;
  /** netFixedAprOnCapital — finite and ≥ 0 by construction of `toRows`. */
  apr: number;
  /** The asset traded (the group underlying when the legs' bases differ). */
  asset: string;
  /** Both Boros legs' venues, upper-cased and deduped: the filter's key space. */
  venueKeys: string[];
  /** Days to maturity, rounded exactly as the card's "(35 days)" is. */
  days: number;
}

/** Boros platformName → one venue key space ("Hyperliquid" and "HYPERLIQUID"
 * are the same venue to a filter). */
export const venueKey = (venue: string): string => venue.trim().toUpperCase();

/** Days to maturity as the cards show it, so a chip and a card never disagree. */
export const maturityDays = (secondsToMaturity: number): number =>
  Math.max(1, Math.round(secondsToMaturity / 86_400));

/** Once shown, a row survives this far below zero before it drops out. Without
 * the band a pair hovering at 0% flips in and out on every poll, and every row
 * below it shifts a full card — under the reader's cursor, mid-click. */
const HYSTERESIS_APR = -0.005;

/** Descending, nulls last — mirrors the server's own `byValueDesc`, so the flat
 * list reproduces its ranking instead of keeping only the primary key. */
const byValueDesc = (a: number | null, b: number | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

/**
 * Every viable pair across every group, best first.
 *
 * Viable means the pair prices a real, non-negative net APR on capital: the
 * server still serves pairs whose inputs degraded to null, and ones whose costs
 * swallow the whole spread, and neither belongs in a list of things worth
 * executing.
 *
 * The server ranks WITHIN a group; a flat list needs one order across ALL of
 * them, so the rows re-rank on the server's whole comparator, not just its
 * primary key. Stability alone would not do it: the pre-sort array is
 * group-major, so a cross-group tie on APR would break by GROUP rank rather
 * than by the pair-level tiebreak, ranking a strictly worse trade first.
 */
export function toRows(
  groups: OpportunityGroup[],
  /** Keys shown on the previous render — see `HYSTERESIS_APR`. */
  shownKeys?: ReadonlySet<string>,
): OpportunityRow[] {
  const rows: OpportunityRow[] = [];
  for (const group of groups) {
    for (const pair of group.pairs) {
      const apr = pair.netFixedAprOnCapital;
      if (apr === null || !Number.isFinite(apr)) continue;
      const key = `${group.tokenId}:${group.maturity}:${pair.shortLeg.marketId}:${pair.longLeg.marketId}`;
      // A pair already on screen holds its place down to the band; a new one
      // still has to clear zero to earn a slot.
      if (apr < (shownKeys?.has(key) ? HYSTERESIS_APR : 0)) continue;
      rows.push({
        key,
        group,
        pair,
        apr,
        // The COHORT's underlying, not the pair's `base`: the server collapses
        // fungible tickers (XAU into GOLD), and keying on the leg would split
        // one cohort across an "XAU" chip and a "GOLD" chip that no single
        // selection could reunite.
        asset: group.underlying,
        venueKeys: [...new Set([venueKey(pair.shortLeg.venue), venueKey(pair.longLeg.venue)])],
        days: maturityDays(group.secondsToMaturity),
      });
    }
  }
  return rows.sort(
    (x, y) =>
      y.apr - x.apr ||
      byValueDesc(x.pair.netFixedApr, y.pair.netFixedApr) ||
      byValueDesc(x.pair.execSpreadApr, y.pair.execSpreadApr) ||
      y.pair.grossSpreadApr - x.pair.grossSpreadApr,
  );
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

/** Each list is OR within its dimension and AND across dimensions; an empty
 * list is no constraint at all. */
export interface OpportunityFilters {
  assets: string[];
  /** Venue KEYS (see `venueKey`) — a row matches on either of its two legs. */
  venues: string[];
  /** Raw field text: the longest tenor to keep, in DAYS; '' = no cap. A tenor
   * is a span, so it takes a number rather than picking exact maturities — the
   * reader caps how long their capital is locked, and does not care that two
   * cohorts happen to settle on different dates inside that span. */
  maxDaysText: string;
}

export const NO_FILTERS: OpportunityFilters = {
  assets: [],
  venues: [],
  maxDaysText: '',
};

/** A plain decimal, and nothing else. `Number()` alone also takes `0x10`,
 * `0o17`, `0b11`, `1e3` and a leading sign — each of which would land as a
 * silently wrong cap that `Number.isFinite` is perfectly happy with. Negatives
 * are rejected too: no row has a tenor below one day, so a negative could only
 * blank the list without saying why. */
const DECIMAL_ONLY = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** The typed tenor cap in DAYS; null when the field is blank or holds something
 * that isn't a plain decimal (a half-typed "3e" must not blank the list). */
export function maxDays(filters: OpportunityFilters): number | null {
  const text = filters.maxDaysText.trim();
  if (text === '' || !DECIMAL_ONLY.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** True once anything is narrowing the list — drives the Clear affordance. */
export const hasActiveFilter = (filters: OpportunityFilters): boolean =>
  filters.assets.length > 0 || filters.venues.length > 0 || maxDays(filters) !== null;

/** Add or remove one value from a dimension's selection. */
export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// ---------------------------------------------------------------------------
// Applying + facet counts
// ---------------------------------------------------------------------------

type Dimension = 'assets' | 'venues' | 'maxDays';

const PREDICATES: Record<Dimension, (row: OpportunityRow, f: OpportunityFilters) => boolean> = {
  assets: (row, f) => f.assets.length === 0 || f.assets.includes(row.asset),
  venues: (row, f) => f.venues.length === 0 || row.venueKeys.some((v) => f.venues.includes(v)),
  maxDays: (row, f) => {
    const cap = maxDays(f);
    // Against the tenor the CARD PRINTS — `row.days` is `maturityDays`, the
    // same rounding behind "(35 days)" — so a card reading 35 survives a cap
    // of 35 rather than being cut by hours the reader never sees.
    return cap === null || row.days <= cap;
  },
};

const DIMENSIONS = Object.keys(PREDICATES) as Dimension[];

/** Rows passing every dimension but one. Facet counts answer "how many cards
 * would this chip leave standing", which is a question about the OTHER
 * filters — counting a dimension against itself would just echo the selection. */
const rowsPassing = (rows: OpportunityRow[], f: OpportunityFilters, except?: Dimension) =>
  rows.filter((row) => DIMENSIONS.every((d) => d === except || PREDICATES[d](row, f)));

export const applyFilters = (rows: OpportunityRow[], f: OpportunityFilters): OpportunityRow[] =>
  rowsPassing(rows, f);

export interface FacetOption<T> {
  value: T;
  label: string;
  /** Cards this option would show, given every OTHER active filter. */
  count: number;
  selected: boolean;
}

export interface OpportunityFacets {
  assets: FacetOption<string>[];
  venues: FacetOption<string>[];
  /** Rows each dimension's counts were measured against. A dimension is only a
   * CHOICE when some option leaves fewer rows than this — counting options is
   * not enough, since every row contributes two venue keys, so a one-card list
   * always has two venue chips that between them exclude nothing. */
  poolSize: { assets: number; venues: number };
}

/**
 * One dimension's chips. Options come from ALL viable rows plus every SELECTED
 * value, never the filtered pool: a selected chip has to stay listed to be
 * unselectable, and a chip that vanishes as you narrow can't be reasoned about.
 * Seeding the selection matters across refetches too — a value that drops out
 * of the response would otherwise take its chip with it and leave the filter
 * armed with nothing on screen to release it.
 */
function facetOptions<T>(
  all: OpportunityRow[],
  pool: OpportunityRow[],
  keysOf: (row: OpportunityRow) => T[],
  label: (value: T) => string,
  selected: T[],
  /** Ranks the chips over EVERY viable row, not the pool: the counts move as
   * filters change, and chips that reorder under the cursor are unclickable. */
  rank: (a: { value: T; total: number }, b: { value: T; total: number }) => number,
): FacetOption<T>[] {
  const tally = (rows: OpportunityRow[]) => {
    const counts = new Map<T, number>();
    for (const row of rows) {
      for (const key of keysOf(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const total = tally(all);
  for (const value of selected) if (!total.has(value)) total.set(value, 0);
  const count = tally(pool);
  return [...total.entries()]
    .map(([value, t]) => ({ value, total: t }))
    .sort(rank)
    .map(({ value }) => ({
      value,
      label: label(value),
      count: count.get(value) ?? 0,
      selected: selected.includes(value),
    }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const OPPORTUNITY_FILTERS_STORAGE_KEY = 'crossex.opportunities.filters.v1';

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The selection from last session.
 *
 * A restored filter is louder than a restored preference: it changes what is
 * MISSING from the list, and a forgotten one reads as "there are no BTC
 * opportunities today". Three things already standing keep that honest — the
 * asset chips wear a ✓, the icon carries a count for the folded refinements,
 * and a selection that now matches nothing still renders (at count 0) because
 * `facetOptions` seeds the selected values. Restoring is safe BECAUSE of those;
 * if any of them goes, this should go with it.
 */
export function loadFilters(): OpportunityFilters {
  return readJson<OpportunityFilters>(
    OPPORTUNITY_FILTERS_STORAGE_KEY,
    NO_FILTERS,
    (parsed) => {
      const p = parsed as { assets?: unknown; venues?: unknown; maxDaysText?: unknown } | null;
      return {
        assets: stringList(p?.assets),
        // Re-normalized on the way in: a blob written before `venueKey` existed
        // — or hand-edited — must not sit in the state space as "Gate".
        venues: stringList(p?.venues).map(venueKey),
        // Anything unparseable restores as no cap rather than as a red field
        // the reader never typed into.
        maxDaysText:
          typeof p?.maxDaysText === 'string' && maxDays({ ...NO_FILTERS, maxDaysText: p.maxDaysText }) !== null
            ? p.maxDaysText
            : '',
      };
    },
  );
}

export const saveFilters = (filters: OpportunityFilters): void =>
  writeJson(OPPORTUNITY_FILTERS_STORAGE_KEY, filters);

/** Commonest first, ties alphabetical — the reader scans the big venues first. */
const byFrequency = <T,>(a: { value: T; total: number }, b: { value: T; total: number }) =>
  b.total - a.total || String(a.value).localeCompare(String(b.value));

/** "GATE" → "Gate", "OKX" stays upper (fmt.prettyVenue's rule, on our keys). */
const venueLabel = (key: string): string =>
  key.length <= 3 ? key : key.charAt(0) + key.slice(1).toLowerCase();

export function facets(rows: OpportunityRow[], f: OpportunityFilters): OpportunityFacets {
  const assetPool = rowsPassing(rows, f, 'assets');
  const venuePool = rowsPassing(rows, f, 'venues');
  return {
    poolSize: { assets: assetPool.length, venues: venuePool.length },
    assets: facetOptions(
      rows,
      assetPool,
      (row) => [row.asset],
      (asset) => asset,
      f.assets,
      byFrequency,
    ),
    venues: facetOptions(
      rows,
      venuePool,
      (row) => row.venueKeys,
      venueLabel,
      f.venues,
      byFrequency,
    ),
  };
}
