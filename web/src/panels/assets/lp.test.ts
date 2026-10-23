import { describe, expect, it } from 'vitest';
import { maximize } from './lp';

describe('maximize', () => {
  it('B1 solves a small program', () => {
    const x = maximize([3, 2], [[1, 1], [1, 3]], [4, 6]);
    expect(x[0]).toBeCloseTo(4, 12);
    expect(x[1]).toBeCloseTo(0, 12);
  });

  it('B2 a tie goes to the first column', () => {
    expect(maximize([1, 1], [[1, 1]], [1])).toEqual([1, 0]);
  });

  it('a column no row limits never enters when its weight is zero', () => {
    expect(maximize([0, 1], [[0, 1]], [2])).toEqual([0, 2]);
  });

  it('solves the same program at $50 and at $6M sizes', () => {
    for (const k of [0.02, 2_400]) {
      const x = maximize([14, 3, 3], [[1, 1, 0], [1, 0, 1], [1, 1, 0], [1, 0, 1]], [10 * k, 10 * k, 6 * k, 6 * k]);
      expect(x[0] / k).toBeCloseTo(6, 9);
      expect(x[1] / k).toBeCloseTo(0, 9);
    }
  });

  it('B35 pivot cap throws', () => {
    const columns = 6_000;
    const c = Array.from({ length: columns }, (_, j) => j + 1);
    expect(() => maximize(c, [Array<number>(columns).fill(1)], [1])).toThrow(new Error('grouping: solve did not finish'));
  });

  it('a program just under the pivot cap still solves', () => {
    const columns = 4_000;
    const c = Array.from({ length: columns }, (_, j) => j + 1);
    const x = maximize(c, [Array<number>(columns).fill(1)], [1]);
    expect(x[columns - 1]).toBe(1);
    expect(x.slice(0, -1).every((v) => v === 0)).toBe(true);
  });
});
