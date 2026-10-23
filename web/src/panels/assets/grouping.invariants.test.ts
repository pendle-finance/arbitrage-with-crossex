import { describe, expect, it } from 'vitest';
import { generatedBooks, halfRollBooks } from '../../test/groupingBooks';
import { groupBook, type GroupInput, type GroupResult } from './grouping';
import { VENUES, cardKeyOf, cardsOf, otherWayOf, renameInput, renameResult, shuffle, ungroupedOf } from './grouping.cases';

const BOOKS = generatedBooks(1, 2_000);
const HALF_ROLLS = halfRollBooks(1, 500);
const PRICE = 2_500;
const DOLLAR_SCALE = 2_500;

const picture = (r: GroupResult) => ({ cards: cardsOf(r), ungrouped: ungroupedOf(r), otherWay: otherWayOf(r) });

const failuresOf = (books: GroupInput[], check: (input: GroupInput) => unknown): string[] => {
  const failures: string[] = [];
  books.forEach((input, index) => {
    const problem = check(input);
    if (problem) failures.push(`book ${index}: ${JSON.stringify(problem)}`);
  });
  return failures.slice(0, 2);
};

const differs = (a: unknown, b: unknown) => (JSON.stringify(a) === JSON.stringify(b) ? null : { a, b });

const renamed = Object.fromEntries(
  Object.values(VENUES)
    .sort()
    .map((v, i) => [v, `V${i + 1}`]),
);
const named = Object.fromEntries(Object.entries(renamed).map(([v, r]) => [r, v]));

function singlesInstead(input: GroupInput, replace: (position: GroupInput['boros'][number]) => boolean): GroupInput {
  return {
    ...input,
    boros: input.boros.flatMap((p) =>
      p.legs.length === 2 && replace(p)
        ? p.legs.map((leg, i) => ({ marketId: p.marketId * 100 + i + 1, legs: [leg], size: p.size, notionalUsd: p.notionalUsd, maturity: p.maturity }))
        : [p],
    ),
  };
}

const isLoneSpread = (input: GroupInput) => (p: GroupInput['boros'][number]) =>
  !input.boros.some((q) => q !== p && q.maturity === p.maturity && q.legs.some((l) => p.legs.some((m) => m.venue === l.venue)));

const hasWrongWaySpread = (input: GroupInput): boolean =>
  input.boros.some(
    (p) =>
      p.legs.length === 2 &&
      p.legs.some((leg) => {
        const rows = input.perps.filter((q) => q.venue === leg.venue);
        const net = rows.reduce((t, q) => t + (q.side === 'LONG' ? q.size : -q.size), 0);
        const size = rows.reduce((t, q) => t + q.size, 0);
        const price = size > 0 ? rows.reduce((t, q) => t + q.notionalUsd, 0) / size : 0;
        return Math.abs(net) * price >= 50 && (net > 0 ? 'LONG' : 'SHORT') !== leg.side;
      }),
  );

const kindsAndSizes = (r: GroupResult) => r.cards.map((c) => `${c.kind} ${c.size.toFixed(6)}`).sort();

const hedgedTotal = (r: GroupResult) => r.cards.reduce((t, c) => t + (c.kind === 'hedged' ? c.size : 0), 0);

function unshownLegs(input: GroupInput, r: GroupResult): string[] {
  const problems: string[] = [];
  const perpSizes = new Map<string, number>();
  for (const p of input.perps) perpSizes.set(`${p.venue}|${p.side}`, (perpSizes.get(`${p.venue}|${p.side}`) ?? 0) + p.size);
  for (const [key, size] of perpSizes) {
    const [venue, side] = key.split('|');
    const onCards = r.cards.reduce((t, c) => t + c.perps.filter((p) => p.venue === venue && p.side === side).reduce((u, p) => u + p.size, 0), 0);
    const loose = r.ungrouped.perps.filter((p) => p.venue === venue && p.side === side).reduce((t, p) => t + p.size, 0);
    if (Math.abs(onCards + loose - size) > 1e-9 * size) problems.push(`${key}: ${onCards + loose} of ${size}`);
  }
  for (const p of input.boros) {
    const onCards = r.cards.reduce((t, c) => t + c.boros.filter((b) => b.marketId === p.marketId).reduce((u, b) => u + b.size, 0), 0);
    const flipped = r.cards.some((c) => c.otherWay.some((o) => o.marketId === p.marketId)) ? p.size : 0;
    const loose = r.ungrouped.boros.filter((b) => b.marketId === p.marketId).reduce((t, b) => t + b.size, 0);
    if (Math.abs(onCards + flipped + loose - p.size) > 1e-9 * p.size) problems.push(`${p.marketId}: ${onCards + flipped + loose} of ${p.size}`);
  }
  return problems;
}

function scaledToDollars(input: GroupInput): GroupInput {
  return {
    ...input,
    perps: input.perps.map((p) => ({ ...p, size: p.size * DOLLAR_SCALE })),
    boros: input.boros.map((p) => ({
      ...p,
      size: p.size * DOLLAR_SCALE,
      legs: p.legs.map((l) => ({ ...l, size: l.size * DOLLAR_SCALE })),
    })),
  };
}

const keyedSizes = (r: GroupResult, scale: number) =>
  r.cards.map((c) => ({ key: cardKeyOf(c), size: c.size / scale })).sort((a, b) => (a.key === b.key ? a.size - b.size : a.key < b.key ? -1 : 1));

function sizeLegs(input: GroupInput) {
  const perps = new Map<string, number>();
  for (const p of input.perps) perps.set(`${p.venue}|${p.side}`, (perps.get(`${p.venue}|${p.side}`) ?? 0) + p.size);
  return { perps, boros: new Map(input.boros.map((p) => [p.marketId, p])) };
}

describe('groupBook on generated books', () => {
  it('the generator makes the books the invariants need', () => {
    expect(BOOKS).toHaveLength(2_000);
    expect(HALF_ROLLS).toHaveLength(500);
    expect(BOOKS.some((b) => b.boros.some((p) => p.legs.length === 2))).toBe(true);
    expect(HALF_ROLLS.every((b) => new Set(b.boros.map((p) => p.maturity)).size >= 2)).toBe(true);
  });

  it('venue names do not matter', () => {
    expect(
      failuresOf(BOOKS, (input) => differs(picture(groupBook(input)), picture(renameResult(groupBook(renameInput(input, renamed)), named)))),
    ).toEqual([]);
  });

  it('a lone spread and two singles group alike', () => {
    const eligible = BOOKS.filter((b) => !hasWrongWaySpread(b) && b.boros.some((p) => p.legs.length === 2 && isLoneSpread(b)(p)));
    expect(eligible.length).toBeGreaterThan(50);
    expect(
      failuresOf(eligible, (input) =>
        differs(kindsAndSizes(groupBook(input)), kindsAndSizes(groupBook(singlesInstead(input, isLoneSpread(input))))),
      ),
    ).toEqual([]);
  });

  it('spread or singles hedge the same', () => {
    expect(
      failuresOf(BOOKS.filter((b) => !hasWrongWaySpread(b)), (input) => {
        const before = hedgedTotal(groupBook(input));
        const after = hedgedTotal(groupBook(singlesInstead(input, () => true)));
        return Math.abs(before - after) > 1e-6 * Math.max(1, before) ? { before, after } : null;
      }),
    ).toEqual([]);
  });

  it('leg order does not matter', () => {
    expect(
      failuresOf(BOOKS, (input) => {
        const want = picture(groupBook(input));
        for (const seed of [1, 2, 3]) {
          const shuffled = groupBook({ ...input, perps: shuffle(input.perps, seed), boros: shuffle(input.boros, seed + 7) });
          const problem = differs(want, picture(shuffled));
          if (problem) return { seed, ...problem };
        }
        return null;
      }),
    ).toEqual([]);
  });

  it('every leg shows exactly once', () => {
    expect(failuresOf([...BOOKS, ...HALF_ROLLS], (input) => {
      const problems = unshownLegs(input, groupBook(input));
      return problems.length > 0 ? problems : null;
    })).toEqual([]);
  });

  it('no card under $50', () => {
    expect(
      failuresOf(BOOKS, (input) => {
        const small = groupBook(input).cards.filter((c) => c.perps.length > 0 && 2 * c.size * PRICE < 50 - 1e-9);
        return small.length > 0 ? small.map((c) => `${cardKeyOf(c)} ${c.size}`) : null;
      }),
    ).toEqual([]);
  });

  it('no card under 0.1%', () => {
    expect(
      failuresOf(BOOKS, (input) => {
        const { perps, boros } = sizeLegs(input);
        const tiny = groupBook(input).cards.filter((c) => {
          const legSizes = [
            ...c.perps.map((p) => perps.get(`${p.venue}|${p.side}`) ?? 0),
            ...c.boros.map((b) => boros.get(b.marketId)?.size ?? 0),
          ];
          return legSizes.every((size) => c.size < 0.001 * size * (1 - 1e-9));
        });
        return tiny.length > 0 ? tiny.map((c) => `${cardKeyOf(c)} ${c.size}`) : null;
      }),
    ).toEqual([]);
  });

  it('a card holds one date', () => {
    expect(
      failuresOf([...BOOKS, ...HALF_ROLLS], (input) => {
        const maturityOf = new Map(input.boros.map((p) => [p.marketId, p.maturity]));
        const mixed = groupBook(input).cards.filter((c) => new Set(c.boros.map((b) => maturityOf.get(b.marketId))).size > 1);
        return mixed.length > 0 ? mixed.map(cardKeyOf) : null;
      }),
    ).toEqual([]);
  });

  it('dollar sizes group as coin sizes', () => {
    expect(
      failuresOf(BOOKS, (input) => {
        const coin = keyedSizes(groupBook(input), 1);
        const dollar = keyedSizes(groupBook(scaledToDollars(input)), DOLLAR_SCALE);
        const same =
          coin.length === dollar.length &&
          coin.every((c, i) => c.key === dollar[i].key && Math.abs(c.size - dollar[i].size) <= 1e-6 * Math.max(1, c.size));
        return same ? null : { coin, dollar };
      }),
    ).toEqual([]);
  });
});
