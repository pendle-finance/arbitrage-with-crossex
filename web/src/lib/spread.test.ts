import { describe, expect, it } from 'vitest';
import { venueLegsOf } from './spread';

describe('venueLegsOf', () => {
  it('single is one venue leg', () => {
    expect(venueLegsOf({ venue: 'GATE', side: 'LONG', spreadVenues: null }, 3)).toEqual([
      { venue: 'GATE', side: 'LONG', size: 3 },
    ]);
  });

  it('spread is two venue legs', () => {
    expect(venueLegsOf({ venue: 'SPREAD', side: 'SHORT', spreadVenues: ['HYPERLIQUID', 'GATE'] }, 0.555)).toEqual([
      { venue: 'HYPERLIQUID', side: 'SHORT', size: 0.555 },
      { venue: 'GATE', side: 'LONG', size: 0.555 },
    ]);
  });

  it('a long spread puts the second venue short', () => {
    expect(venueLegsOf({ venue: 'SPREAD', side: 'LONG', spreadVenues: ['HYPERLIQUID', 'GATE'] }, 2)).toEqual([
      { venue: 'HYPERLIQUID', side: 'LONG', size: 2 },
      { venue: 'GATE', side: 'SHORT', size: 2 },
    ]);
  });

  it('a count other than two returns the venues as given', () => {
    expect(venueLegsOf({ venue: 'X', side: 'LONG', spreadVenues: ['A', 'B', 'C'] }, 1).map((l) => l.venue)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});
