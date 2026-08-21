/**
 * The opportunities list is a flat list of PAIRS, not one card per group. A
 * group with three markets offers three different venue combinations, each its
 * own executable trade at its own APR — collapsing them to the group's best hid
 * every runner-up, including ones on venues the reader can actually reach.
 *
 * This module owns the flattening, the viability rule (a card must price a
 * non-negative net APR on capital) and the facet filtering the bar drives. All
 * pure, so the panel stays a rendering concern.
 */
import type { OpportunityGroup, OpportunityPair } from '../api/types';

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
  maturity: number;
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
        maturity: group.maturity,
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
  /** Group maturities, unix seconds. */
  maturities: number[];
  /** Raw field text, in PERCENT ("5" means 5% APR); '' = no floor. */
  minAprPct: string;
}

export const NO_FILTERS: OpportunityFilters = {
  assets: [],
  venues: [],
  maturities: [],
  minAprPct: '',
};

/** A plain decimal, and nothing else. `Number()` alone also takes `0x10`,
 * `0o17`, `0b11`, `1e3` and a leading sign — each of which would land as a
 * silently wrong floor that `Number.isFinite` is perfectly happy with. A
 * negative floor is rejected too: no row is ever below zero by more than the
 * hysteresis band, so it could only mislead. */
const DECIMAL_ONLY = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** The typed floor as a PERCENT, exactly as the user typed it; null when the
 * field is blank or holds something that isn't a plain decimal (a half-typed
 * "1.2e" must not blank the list). */
export function minAprPct(filters: OpportunityFilters): number | null {
  const text = filters.minAprPct.trim();
  if (text === '' || !DECIMAL_ONLY.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** The same floor as a FRACTION, matching `OpportunityRow.apr`. */
export function minApr(filters: OpportunityFilters): number | null {
  const pct = minAprPct(filters);
  return pct === null ? null : pct / 100;
}

/** True once anything is narrowing the list — drives the Clear affordance. */
export const hasActiveFilter = (filters: OpportunityFilters): boolean =>
  filters.assets.length > 0 ||
  filters.venues.length > 0 ||
  filters.maturities.length > 0 ||
  minApr(filters) !== null;

/** Add or remove one value from a dimension's selection. */
export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// ---------------------------------------------------------------------------
// Applying + facet counts
// ---------------------------------------------------------------------------

/** The APR a card shows: one decimal place of percent (`OpportunitiesPanel`'s
 * `(apr * 100).toFixed(1)`). */
const displayPct = (apr: number): number => Number((apr * 100).toFixed(1));

type Dimension = 'assets' | 'venues' | 'maturities' | 'minApr';

const PREDICATES: Record<Dimension, (row: OpportunityRow, f: OpportunityFilters) => boolean> = {
  assets: (row, f) => f.assets.length === 0 || f.assets.includes(row.asset),
  venues: (row, f) => f.venues.length === 0 || row.venueKeys.some((v) => f.venues.includes(v)),
  maturities: (row, f) => f.maturities.length === 0 || f.maturities.includes(row.maturity),
  minApr: (row, f) => {
    const floor = minAprPct(f);
    // Against the APR the CARD PRINTS, not the raw fraction: 0.11996 renders
    // "12.0% APR", and a reader who types 12 to keep everything at 12%-or-better
    // must not watch that very card disappear.
    return floor === null || displayPct(row.apr) >= floor;
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
  maturities: FacetOption<number>[];
  /** Rows each dimension's counts were measured against. A dimension is only a
   * CHOICE when some option leaves fewer rows than this — counting options is
   * not enough, since every row contributes two venue keys, so a one-card list
   * always has two venue chips that between them exclude nothing. */
  poolSize: { assets: number; venues: number; maturities: number };
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

/** Commonest first, ties alphabetical — the reader scans the big venues first. */
const byFrequency = <T,>(a: { value: T; total: number }, b: { value: T; total: number }) =>
  b.total - a.total || String(a.value).localeCompare(String(b.value));

/** "GATE" → "Gate", "OKX" stays upper (fmt.prettyVenue's rule, on our keys). */
const venueLabel = (key: string): string =>
  key.length <= 3 ? key : key.charAt(0) + key.slice(1).toLowerCase();

export function facets(rows: OpportunityRow[], f: OpportunityFilters): OpportunityFacets {
  // One pass instead of a `rows.find` per maturity option.
  const daysByMaturity = new Map(rows.map((r) => [r.maturity, r.days]));
  const assetPool = rowsPassing(rows, f, 'assets');
  const venuePool = rowsPassing(rows, f, 'venues');
  const maturityPool = rowsPassing(rows, f, 'maturities');
  return {
    poolSize: {
      assets: assetPool.length,
      venues: venuePool.length,
      maturities: maturityPool.length,
    },
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
    maturities: facetOptions(
      rows,
      maturityPool,
      (row) => [row.maturity],
      // Chips read in the card's own unit; the exact date is the chip's title.
      (maturity) => `${daysByMaturity.get(maturity) ?? 0}d`,
      f.maturities,
      // Soonest first — maturity is a timeline, not a popularity contest.
      (a, b) => a.value - b.value,
    ),
  };
}
