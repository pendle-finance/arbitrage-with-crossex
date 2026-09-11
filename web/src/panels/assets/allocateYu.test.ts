/**
 * The maturity-aware YU allocator, against the book shapes that break a
 * naive proportional split: ladders, one-sided maturities, missing legs,
 * and one venue laddered against several single-maturity venues.
 */
import { describe, expect, it } from 'vitest';
import { allocateYuByMaturity, type YuSlice } from './assetModel';

const SEP = 1_790_000_000;
const OCT = 1_793_000_000;
const DEC = 1_798_000_000;

/** Fresh "remaining" maps, as deriveAsset builds them once per asset. */
const rem = (legs: readonly YuSlice[]) => new Map(legs.map((l) => [l.marketId, l.size]));
const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('allocateYuByMaturity', () => {
  it("his book: OKX-Sept pairs whole, Gate takes the Sept remainder AND all of Oct", () => {
    // HL (short) is laddered 1665 Sept + 199.18 Oct; Gate 1340 Sept + 199.18
    // Oct; OKX 325 Sept only. Perp sizes: Gate 1539.103, OKX 324.866.
    const hl: YuSlice[] = [
      { marketId: 1, maturity: SEP, size: 1665 },
      { marketId: 2, maturity: OCT, size: 199.18017 },
    ];
    const gate: YuSlice[] = [
      { marketId: 3, maturity: SEP, size: 1340 },
      { marketId: 4, maturity: OCT, size: 199.18017 },
    ];
    const okx: YuSlice[] = [{ marketId: 5, maturity: SEP, size: 325 }];
    const rl = new Map([...rem(gate), ...rem(okx)]);
    const rs = rem(hl);

    // Gate/HL is the bigger pair and is allocated first.
    const a = allocateYuByMaturity(1539.103, gate, hl, rl, rs);
    // OKX/HL takes what is left.
    const b = allocateYuByMaturity(324.866, okx, hl, rl, rs);

    // Gate's Sept leg is matched whole; its Oct leg is claimed only as far
    // as the PERP size reaches (perp 1539.103 vs YU 1340 + 199.18017 =
    // 1539.18017), so 0.077 of Oct is left over — correct, not a rounding
    // slip: a pair may never claim more hedge than its perps carry.
    expect(a.long.get(3)).toBeCloseTo(1340, 6);
    expect(a.long.get(4)).toBeCloseTo(1539.103 - 1340, 6);
    // ...against HL's Sept and Oct in the SAME maturities, not blended.
    expect(a.short.get(1)).toBeCloseTo(1340, 6);
    expect(a.short.get(2)).toBeCloseTo(1539.103 - 1340, 6);

    // OKX pairs entirely within Sept — no Oct sliver, which was the bug.
    expect(b.long.get(5)).toBeCloseTo(324.866, 6);
    expect(b.short.get(1)).toBeCloseTo(324.866, 6);
    expect(b.short.has(2)).toBe(false);
  });

  it('one venue laddered vs several single-maturity venues on the other side', () => {
    // HL short: 100 Sept + 100 Oct. Two longs, each single-maturity.
    const hl: YuSlice[] = [
      { marketId: 1, maturity: SEP, size: 100 },
      { marketId: 2, maturity: OCT, size: 100 },
    ];
    const gate: YuSlice[] = [{ marketId: 3, maturity: SEP, size: 100 }];
    const okx: YuSlice[] = [{ marketId: 4, maturity: OCT, size: 100 }];
    const rl = new Map([...rem(gate), ...rem(okx)]);
    const rs = rem(hl);

    const g = allocateYuByMaturity(100, gate, hl, rl, rs);
    const o = allocateYuByMaturity(100, okx, hl, rl, rs);
    // Each long meets the HL leg of ITS OWN maturity, whole.
    expect(g.short.get(1)).toBeCloseTo(100, 6);
    expect(g.short.has(2)).toBe(false);
    expect(o.short.get(2)).toBeCloseTo(100, 6);
    expect(o.short.has(1)).toBe(false);
  });

  it('a maturity present on ONE side only allocates NOTHING (no unit exists)', () => {
    // Long has Dec, short has Sept: no shared maturity, so no 4-leg unit.
    // Both legs stay unallocated and surface as pending legs upstream —
    // blending them would claim a hedge that matures on a different day.
    const longLegs: YuSlice[] = [{ marketId: 1, maturity: DEC, size: 100 }];
    const shortLegs: YuSlice[] = [{ marketId: 2, maturity: SEP, size: 100 }];
    const rl = rem(longLegs);
    const rs = rem(shortLegs);
    const a = allocateYuByMaturity(100, longLegs, shortLegs, rl, rs);
    expect(sum(a.long)).toBe(0);
    expect(sum(a.short)).toBe(0);
    // Untouched, so the caller can report them as pending.
    expect(rl.get(1)).toBeCloseTo(100, 6);
    expect(rs.get(2)).toBeCloseTo(100, 6);
  });

  it('an INCOMPLETE side is capped by the thinner leg on BOTH sides', () => {
    // Short side only has 40 at Sept against a 100 long.
    const longLegs: YuSlice[] = [{ marketId: 1, maturity: SEP, size: 100 }];
    const shortLegs: YuSlice[] = [{ marketId: 2, maturity: SEP, size: 40 }];
    const rl = rem(longLegs);
    const a = allocateYuByMaturity(100, longLegs, shortLegs, rl, rem(shortLegs));
    // A unit is as big as its thinnest leg: 40 a side, not 100 long vs 40
    // short. The long's other 60 stays unallocated and reads as pending.
    expect(sum(a.long)).toBeCloseTo(40, 6);
    expect(sum(a.short)).toBeCloseTo(40, 6);
    expect(rl.get(1)).toBeCloseTo(60, 6);
  });

  it('never double-allocates: two pairs drawing on one shared short leg', () => {
    const shortLegs: YuSlice[] = [{ marketId: 1, maturity: SEP, size: 150 }];
    const a1: YuSlice[] = [{ marketId: 2, maturity: SEP, size: 100 }];
    const a2: YuSlice[] = [{ marketId: 3, maturity: SEP, size: 100 }];
    const rl = new Map([...rem(a1), ...rem(a2)]);
    const rs = rem(shortLegs);
    const p1 = allocateYuByMaturity(100, a1, shortLegs, rl, rs);
    const p2 = allocateYuByMaturity(100, a2, shortLegs, rl, rs);
    expect(sum(p1.short)).toBeCloseTo(100, 6);
    expect(sum(p2.short)).toBeCloseTo(50, 6); // only 50 was left
    expect(sum(p1.short) + sum(p2.short)).toBeCloseTo(150, 6); // exactly the leg
  });

  it('three maturities, partially matched, allocates each where it belongs', () => {
    const longLegs: YuSlice[] = [
      { marketId: 1, maturity: SEP, size: 50 },
      { marketId: 2, maturity: OCT, size: 50 },
      { marketId: 3, maturity: DEC, size: 50 },
    ];
    const shortLegs: YuSlice[] = [
      { marketId: 4, maturity: SEP, size: 50 },
      { marketId: 5, maturity: DEC, size: 50 },
    ];
    const rl = rem(longLegs);
    const a = allocateYuByMaturity(150, longLegs, shortLegs, rl, rem(shortLegs));
    // Sept and Dec match exactly; Oct has no counterpart on the short side,
    // so it is left alone rather than folded into another term's unit.
    expect(a.short.get(4)).toBeCloseTo(50, 6);
    expect(a.short.get(5)).toBeCloseTo(50, 6);
    expect(sum(a.short)).toBeCloseTo(100, 6);
    expect(sum(a.long)).toBeCloseTo(100, 6);
    expect(rl.get(2)).toBeCloseTo(50, 6); // the Oct leg, still pending
  });

  it('a zero or negative need allocates nothing', () => {
    const l: YuSlice[] = [{ marketId: 1, maturity: SEP, size: 100 }];
    const s: YuSlice[] = [{ marketId: 2, maturity: SEP, size: 100 }];
    expect(sum(allocateYuByMaturity(0, l, s, rem(l), rem(s)).long)).toBe(0);
    expect(sum(allocateYuByMaturity(-5, l, s, rem(l), rem(s)).short)).toBe(0);
  });

  it('a missing side (no YU legs at all) allocates nothing, without throwing', () => {
    const l: YuSlice[] = [{ marketId: 1, maturity: SEP, size: 100 }];
    const a = allocateYuByMaturity(100, l, [], rem(l), new Map());
    expect(sum(a.short)).toBe(0);
  });
});
