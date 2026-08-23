import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadOverrides,
  overrideFor,
  overrunsVenue,
  reconcileEntries,
  saveOverrides,
  withOverride,
  type EntryClaim,
  type EntryOverride,
} from './entryOverrideStore';

const perp = (symbol: string) => ({ kind: 'perp' as const, symbol });
const boros = (marketId: number) => ({ kind: 'boros' as const, marketId });
const NOW = 1_787_000_000;

beforeEach(() => localStorage.clear());

describe('entryOverrideStore — persistence', () => {
  it('round-trips an assertion, scoped per book', () => {
    const rows: EntryOverride[] = [{ positionId: 'a1', leg: perp('BINANCE_ETH'), value: 2457.77 }];
    saveOverrides('book-1', rows, NOW);
    expect(loadOverrides('book-1')).toEqual(rows);
    // A different book must not see it — assertions never leak across a
    // credential swap.
    expect(loadOverrides('book-2')).toEqual([]);
  });

  it('drops the key entirely when the last assertion is cleared', () => {
    saveOverrides('b', [{ positionId: 'a1', leg: boros(190), value: 0.08 }], NOW);
    saveOverrides('b', [], NOW);
    expect(localStorage.getItem('crossex.entryOverride.v1')).not.toContain('a1');
  });

  it('prunes entries older than the max age on the next write', () => {
    saveOverrides('old', [{ positionId: 'a1', leg: perp('X'), value: 1 }], NOW);
    saveOverrides('new', [{ positionId: 'a2', leg: perp('Y'), value: 2 }], NOW + 181 * 24 * 3600);
    expect(loadOverrides('old')).toEqual([]);
    expect(loadOverrides('new')).toHaveLength(1);
  });

  it('ignores malformed stored rows rather than throwing', () => {
    localStorage.setItem(
      'crossex.entryOverride.v1',
      JSON.stringify({ b: { rows: [{ positionId: 'a', leg: { kind: 'nope' }, value: 1 }], savedAtSec: NOW } }),
    );
    expect(loadOverrides('b')).toEqual([]);
  });
});

describe('entryOverrideStore — withOverride', () => {
  it('replaces the same position+leg rather than appending', () => {
    let rows = withOverride([], 'a1', perp('E'), 100);
    rows = withOverride(rows, 'a1', perp('E'), 200);
    expect(rows).toHaveLength(1);
    expect(overrideFor(rows, 'a1', perp('E'))).toBe(200);
  });

  it('REPLACES another position\'s assertion on the same leg — one per leg', () => {
    // With the venue total fixed, a leg split N ways has N-1 degrees of
    // freedom. Two stored assertions on one leg are over-determined: the
    // second cannot be honoured without breaking conservation or silently
    // overriding the first, which is what used to happen — whoever asserted
    // first kept their number forever while everyone else re-balanced.
    let rows = withOverride([], 'a1', perp('E'), 100);
    rows = withOverride(rows, 'a2', perp('E'), 300);
    expect(rows).toHaveLength(1);
    expect(overrideFor(rows, 'a1', perp('E'))).toBeNull();
    expect(overrideFor(rows, 'a2', perp('E'))).toBe(300);
  });

  it('leaves assertions on OTHER legs alone', () => {
    let rows = withOverride([], 'a1', perp('E'), 100);
    rows = withOverride(rows, 'a1', perp('OTHER'), 200);
    rows = withOverride(rows, 'a2', perp('E'), 300);
    expect(overrideFor(rows, 'a1', perp('OTHER'))).toBe(200);
    expect(overrideFor(rows, 'a2', perp('E'))).toBe(300);
  });

  it('clears with null, and treats a non-finite value as a clear', () => {
    const rows = withOverride([], 'a1', perp('E'), 100);
    expect(withOverride(rows, 'a1', perp('E'), null)).toEqual([]);
    expect(withOverride(rows, 'a1', perp('E'), Number.NaN)).toEqual([]);
  });

  it('distinguishes a perp leg from a Boros leg', () => {
    let rows = withOverride([], 'a1', perp('E'), 100);
    rows = withOverride(rows, 'a1', boros(7), 0.05);
    expect(overrideFor(rows, 'a1', perp('E'))).toBe(100);
    expect(overrideFor(rows, 'a1', boros(7))).toBe(0.05);
  });
});

describe('reconcileEntries — the venue average is conserved', () => {
  /** Σ(qty·entry) over every claim must equal the venue's own total. */
  const totalOf = (claims: readonly EntryClaim[], got: Map<string, number | null>) =>
    claims.reduce((s, c) => s + c.qty * (got.get(c.positionId) as number), 0);

  it('gives the asserting strategy its number and implies the rest', () => {
    // Venue: 0.02 ETH at a blended 2440. One strategy says it actually paid
    // 2457.77 for its half — the other half must absorb the difference.
    const claims: EntryClaim[] = [
      { positionId: 'a', qty: 0.01, asserted: 2457.77 },
      { positionId: 'b', qty: 0.01, asserted: null },
    ];
    const got = reconcileEntries(claims, 2440, 0.02);
    expect(got.get('a')).toBeCloseTo(2457.77, 10);
    expect(got.get('b')).toBeCloseTo(2422.23, 10);
    expect(totalOf(claims, got)).toBeCloseTo(2440 * 0.02, 10);
  });

  it('splits the remainder by SIZE, not evenly, when shares differ', () => {
    const claims: EntryClaim[] = [
      { positionId: 'a', qty: 0.03, asserted: 100 },
      { positionId: 'b', qty: 0.01, asserted: null },
      { positionId: 'c', qty: 0.01, asserted: null },
    ];
    const got = reconcileEntries(claims, 120, 0.05);
    // (120*0.05 − 100*0.03) / 0.02 = 150 for both un-asserted claims.
    expect(got.get('b')).toBeCloseTo(150, 10);
    expect(got.get('c')).toBeCloseTo(150, 10);
    expect(totalOf(claims, got)).toBeCloseTo(120 * 0.05, 10);
  });

  it('hands everyone the venue entry when nobody has asserted', () => {
    const claims: EntryClaim[] = [
      { positionId: 'a', qty: 0.01, asserted: null },
      { positionId: 'b', qty: 0.01, asserted: null },
    ];
    const got = reconcileEntries(claims, 2440, 0.02);
    expect(got.get('a')).toBeCloseTo(2440, 10);
    expect(got.get('b')).toBeCloseTo(2440, 10);
  });

  it('accounts for venue size no strategy claims', () => {
    // Venue holds 0.04; the strategies only claim 0.02. The unclaimed size is
    // still part of the average being divided, so the implied price for the
    // un-asserted claim must use the venue's whole position.
    const claims: EntryClaim[] = [
      { positionId: 'a', qty: 0.01, asserted: 110 },
      { positionId: 'b', qty: 0.01, asserted: null },
    ];
    const got = reconcileEntries(claims, 100, 0.04);
    // (100*0.04 − 110*0.01) / 0.03 = 2.9/0.03 = 96.666…
    expect(got.get('b')).toBeCloseTo(96.6666666667, 8);
  });

  it('reports null for the remainder when assertions imply a negative price', () => {
    const claims: EntryClaim[] = [
      { positionId: 'a', qty: 0.01, asserted: 10_000 },
      { positionId: 'b', qty: 0.01, asserted: null },
    ];
    const got = reconcileEntries(claims, 100, 0.02);
    expect(got.get('a')).toBe(10_000); // what they said stands
    expect(got.get('b')).toBeNull(); // but the rest cannot be priced
  });

  it('passes assertions through untouched when the venue entry is unusable', () => {
    const claims: EntryClaim[] = [{ positionId: 'a', qty: 0.01, asserted: 123 }];
    expect(reconcileEntries(claims, Number.NaN, 0.02).get('a')).toBe(123);
    expect(reconcileEntries(claims, 100, 0).get('a')).toBe(123);
  });

  it('works the same for a Boros RATE as for a perp price', () => {
    // Rates are just a different unit — 8% blended, one leg says it locked 9%.
    const claims: EntryClaim[] = [
      { positionId: 'a', qty: 100, asserted: 0.09 },
      { positionId: 'b', qty: 100, asserted: null },
    ];
    const got = reconcileEntries(claims, 0.08, 200);
    expect(got.get('b')).toBeCloseTo(0.07, 12);
    expect(totalOf(claims, got)).toBeCloseTo(0.08 * 200, 12);
  });
});

describe('overrunsVenue', () => {
  const claims = (a: number | null, b: number | null): EntryClaim[] => [
    { positionId: 'a', qty: 0.01, asserted: a },
    { positionId: 'b', qty: 0.01, asserted: b },
  ];

  it('is false when nothing is asserted', () => {
    expect(overrunsVenue(claims(null, null), 2440, 0.02)).toBe(false);
  });

  it('is false for an assertion the remainder can absorb', () => {
    expect(overrunsVenue(claims(2457.77, null), 2440, 0.02)).toBe(false);
  });

  it('is true when an assertion leaves the rest impossible', () => {
    expect(overrunsVenue(claims(10_000, null), 100, 0.02)).toBe(true);
  });

  it('is true when every claim is asserted and they do not sum to the venue', () => {
    expect(overrunsVenue(claims(100, 100), 120, 0.02)).toBe(true);
  });

  it('is false when every claim is asserted and they DO sum to the venue', () => {
    expect(overrunsVenue(claims(110, 130), 120, 0.02)).toBe(false);
  });

  it('is true when the claims assert more size than the venue holds', () => {
    expect(overrunsVenue(claims(100, 100), 100, 0.005)).toBe(true);
  });
});
