import { describe, expect, it } from 'vitest';
import { doubledCover, type BorosOverlap } from './borosOverlap';

const OCT = 1_800_000_000;
const NOV = OCT + 28 * 86_400;
const DEC = NOV + 30 * 86_400;
const overlap = (room: number, legs: Array<[number, number]>): BorosOverlap => ({
  venue: 'HYPERLIQUID',
  side: 'SHORT',
  held: '',
  room,
  roomBase: room,
  legs: legs.map(([size, maturity]) => ({ size, sizeBase: size, maturity })),
});

describe('doubledCover', () => {
  it('a half roll: the whole open covers the perp twice until the old leg matures', () => {
    expect(doubledCover(overlap(0, [[10, OCT]]), 4, true, NOV)).toEqual({ size: 4, until: OCT });
  });

  it('only the part past the room counts', () => {
    expect(doubledCover(overlap(1, [[3, OCT]]), 3, false, DEC)).toEqual({ size: 2, until: OCT });
    expect(doubledCover(overlap(4, [[6, OCT]]), 4, true, NOV)).toBeNull();
  });

  it('two held dates: it ends when enough of them matured, not at the first', () => {
    expect(doubledCover(overlap(0, [[2, OCT], [3, NOV]]), 4, true, DEC)).toEqual({ size: 4, until: NOV });
    expect(doubledCover(overlap(0, [[2, OCT], [3, NOV]]), 2, true, DEC)).toEqual({ size: 2, until: OCT });
  });

  it('a held leg that outlives the new one: covered twice for the new leg’s whole term', () => {
    expect(doubledCover(overlap(0, [[10, DEC]]), 4, true, NOV)).toEqual({ size: 4, until: NOV });
  });

  it('past the held legs the rest is over the perp, not covered twice', () => {
    expect(doubledCover(overlap(0, [[3, OCT]]), 5, true, NOV)).toEqual({ size: 3, until: OCT });
  });

  it('no coin figures on a coin market: says nothing rather than guess', () => {
    const o = { ...overlap(0, [[10, OCT]]), roomBase: undefined };
    expect(doubledCover(o, 4, false, NOV)).toBeNull();
  });
});
