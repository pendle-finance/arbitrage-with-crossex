import { afterEach, describe, expect, it, vi } from 'vitest';
import { venueLegsOf } from '../../lib/spread';
import { maximize } from './lp';
import { groupBook, type GroupInput, type GroupResult } from './grouping';
import { CASES, DATES, type GroupCase, VENUES, bookOf, cardKeyOf, cardsOf, marketIdOf, offersOf, otherWayOf, rowsOf, ungroupedOf, renameInput, renameResult, shuffle } from './grouping.cases';

vi.mock('./lp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lp')>();
  return { maximize: vi.fn(actual.maximize) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const picture = (r: GroupResult) => ({ cards: cardsOf(r), ungrouped: ungroupedOf(r), otherWay: otherWayOf(r) });

function unshownLegs(input: GroupInput, r: GroupResult): string[] {
  const off = (shown: number, size: number) => Math.abs(shown - size) > 1e-9 * Math.max(1, size);
  const problems: string[] = [];
  const perpKeys = new Set(input.perps.map((p) => `${p.venue}|${p.side}|${p.quoteTwin}`));
  for (const key of perpKeys) {
    const [venue, side, twin] = key.split('|');
    const isTwin = twin === 'true';
    const size = input.perps.filter((p) => p.venue === venue && p.side === side && p.quoteTwin === isTwin).reduce((t, p) => t + p.size, 0);
    const onCards = isTwin
      ? 0
      : r.cards.reduce((t, c) => t + c.perps.filter((p) => p.venue === venue && p.side === side).reduce((u, p) => u + p.size, 0), 0);
    const loose = r.ungrouped.perps.filter((p) => p.venue === venue && p.side === side && p.quoteTwin === isTwin).reduce((t, p) => t + p.size, 0);
    if (off(onCards + loose, size)) problems.push(`${key}: ${onCards + loose} of ${size}`);
  }
  for (const p of input.boros) {
    const onCards = r.cards.reduce((t, c) => t + c.boros.filter((b) => b.marketId === p.marketId).reduce((u, b) => u + b.size, 0), 0);
    const flipped = r.cards.some((c) => c.otherWay.some((o) => o.marketId === p.marketId)) ? p.size : 0;
    const loose = r.ungrouped.boros.filter((b) => b.marketId === p.marketId).reduce((t, b) => t + b.size, 0);
    if (off(onCards + flipped + loose, p.size)) problems.push(`${p.marketId}: ${onCards + flipped + loose} of ${p.size}`);
  }
  return problems;
}

const renamed = Object.fromEntries(
  Object.values(VENUES)
    .sort()
    .map((v, i) => [v, `V${i + 1}`]),
);
const named = Object.fromEntries(Object.entries(renamed).map(([v, r]) => [r, v]));

describe('groupBook on the named books', () => {
  it.each(CASES.map((c): [string, GroupCase] => [c.title, c]))('%s', (_title, c) => {
    const input = bookOf(c.spec, c.opts);
    const result = groupBook(input);
    if (c.cards) expect(cardsOf(result)).toEqual([...c.cards].sort());
    expect(ungroupedOf(result)).toEqual([...(c.ug ?? [])].sort());
    if (c.ow) expect(otherWayOf(result)).toEqual([...c.ow].sort());
    for (const [key, offers] of Object.entries(c.offers ?? {})) {
      const card = result.cards.find((x) => cardKeyOf(x) === key);
      expect(card ? offersOf(card) : `no card ${key}`).toEqual(offers);
    }
    for (const [key, rows] of Object.entries(c.rows ?? {})) {
      const card = result.cards.find((x) => cardKeyOf(x) === key);
      expect(card ? rowsOf(card) : `no card ${key}`).toEqual(rows);
    }
    expect(unshownLegs(input, result)).toEqual([]);

    const want = picture(result);
    expect(picture(groupBook({ ...input, perps: [...input.perps].reverse(), boros: [...input.boros].reverse() }))).toEqual(want);
    for (const seed of [1, 2, 3]) {
      expect(picture(groupBook({ ...input, perps: shuffle(input.perps, seed), boros: shuffle(input.boros, seed + 7) }))).toEqual(want);
    }
    expect(picture(renameResult(groupBook(renameInput(input, renamed)), named))).toEqual(want);
  });
});

describe('groupBook', () => {
  it('G26 ED-6648 two longs, two shorts, a tie: either cross pairing', () => {
    const result = groupBook(
      bookOf(['G L 1', 'O L 1', 'H S 1', 'LI S 1', 'G LONG 1 N g', 'O LONG 1 N o', 'H SHORT 1 N h', 'LI SHORT 1 N l']),
    );
    expect([
      ['H G/H N 1', 'H O/LI N 1'],
      ['H G/LI N 1', 'H O/H N 1'],
    ]).toContainEqual(cardsOf(result));
  });

  it('the later date takes every perp on an exact tie', () => {
    const result = groupBook(bookOf(['G L 100', 'H S 110', 'G LONG 100 O a1', 'H SHORT 100 O b2', 'G LONG 100 N a11', 'H SHORT 100 N b12']));
    expect(cardsOf(result)).toEqual(['H G/H N 100', 'PM G/H O 100']);
    const old = result.cards.find((c) => cardKeyOf(c) === 'PM G/H O');
    expect(old?.perps).toEqual([{ venue: 'HYPERLIQUID', side: 'SHORT', symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', size: 10 }]);
  });

  it('A3 three venue legs go to Ungrouped', () => {
    const legs = venueLegsOf({ venue: 'HYPERLIQUID', side: 'SHORT', spreadVenues: ['HYPERLIQUID', 'GATE', 'OKX'] }, 2);
    const input = bookOf(['G L 2', 'H S 2']);
    input.boros.push({ marketId: marketIdOf('tri'), legs, size: 2, notionalUsd: 5_000, maturity: DATES.N });
    const result = groupBook(input);
    expect(result.cards.every((c) => c.boros.length === 0)).toBe(true);
    expect(ungroupedOf(result)).toEqual(['U tri 2']);
  });

  it('B28 unknown price keeps the cards: each leg brings its own notional', () => {
    const spec = ['G L 10', 'H S 10', 'G LONG 6 O g1', 'G LONG 4 N g2', 'H SHORT 10 O h'];
    const marks: Record<string, number> = { GATE: 2_499, HYPERLIQUID: 2_501 };
    const input = bookOf(spec);
    const own: GroupInput = {
      ...input,
      perps: input.perps.map((p) => ({ ...p, notionalUsd: p.size * marks[p.venue] })),
      boros: input.boros.map((p) => ({ ...p, notionalUsd: p.size * 2_480 })),
    };
    expect(picture(groupBook(own))).toEqual(picture(groupBook(input)));
    expect(cardsOf(groupBook(own))).toEqual(['BM G/H N holdsL 4', 'H G/H O 6']);
  });

  it('G27 ED-6648 entry rate does not change the cards: a Boros leg carries no rate', () => {
    const input = bookOf(['G L 10', 'H S 10', 'G LONG 6 O g1', 'G LONG 4 N g2', 'H SHORT 10 O h']);
    expect(Object.keys(input.boros[0]).sort()).toEqual(['legs', 'marketId', 'maturity', 'notionalUsd', 'size']);
    expect(cardsOf(groupBook(input))).toEqual(['BM G/H N holdsL 4', 'H G/H O 6']);
  });

  it('B30 stress book stays small', () => {
    const codes = ['B', 'G', 'H', 'LI', 'O'];
    const dates = ['O', 'N', 'D', 'A'];
    const spec = [
      ...codes.flatMap((v, i) => [`${v} L ${3 + i}`, `${v} S ${2 + i / 2}`]),
      ...Array.from({ length: 20 }, (_, i) => {
        const side = Math.floor(i / 5) % 2 === 0 ? 'LONG' : 'SHORT';
        return `${codes[i % 5]} ${side} ${1 + i / 10} ${dates[i % 4]} s${i}`;
      }),
    ];
    const input = bookOf(spec);
    expect(input.boros).toHaveLength(20);
    const started = performance.now();
    const result = groupBook(input);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.solves).toBeGreaterThan(0);
    expect(result.solves).toBeLessThanOrEqual(9);
    expect(unshownLegs(input, result)).toEqual([]);
  });

  it('B35 pivot cap throws: every leg goes to Ungrouped and the error is logged', async () => {
    const actual = await vi.importActual<typeof import('./lp')>('./lp');
    vi.mocked(maximize).mockImplementationOnce(() => actual.maximize(Array.from({ length: 6_000 }, (_, j) => j + 1), [Array<number>(6_000).fill(1)], [1]));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const input = bookOf(['G L 1', 'H S 1', 'B L 1 USDC twin', 'G LONG 1 N g', 'H SHORT 1 N h', 'H LONG 1 O w']);
    const result = groupBook(input);
    expect(result.cards).toEqual([]);
    expect(ungroupedOf(result)).toEqual(['U B|L|twin 1', 'U G|L 1', 'U H|S 1', 'U g 1', 'U h 1', 'U(W) w']);
    expect(unshownLegs(input, result)).toEqual([]);
    expect(logged).toHaveBeenCalledWith('grouping: solve did not finish');
  });

  it('card sizes equal the leg sizes at every rung', () => {
    const bookAt = (size: number, price: number, restShare: number, split: boolean): GroupInput => {
      const parts = split ? [size * 0.6, size - size * 0.6] : [size];
      return {
        restShare,
        perps: [
          { venue: 'GATE', side: 'LONG', symbol: 'G', size, notionalUsd: size * price, quoteTwin: false },
          { venue: 'HYPERLIQUID', side: 'SHORT', symbol: 'H', size, notionalUsd: size * price, quoteTwin: false },
        ],
        boros: parts.flatMap((part, i) => [
          { marketId: 10 + 2 * i, legs: venueLegsOf({ venue: 'GATE', side: 'LONG', spreadVenues: null }, part), size: part, notionalUsd: part * price, maturity: DATES.N + i * 30 * 86_400 },
          { marketId: 11 + 2 * i, legs: venueLegsOf({ venue: 'HYPERLIQUID', side: 'SHORT', spreadVenues: null }, part), size: part, notionalUsd: part * price, maturity: DATES.N + i * 30 * 86_400 },
        ]),
      };
    };
    const rungs = [
      ...[0.01, 1, 100, 2_400].map((size) => ({ size, price: 2_500, restShare: 0.001 })),
      ...[50, 5_000, 100_000, 1_000_000, 6_000_000].map((size) => ({ size, price: 1, restShare: 0.005 })),
    ];
    for (const { size, price, restShare } of rungs) {
      for (const split of [false, true]) {
        const input = bookAt(size, price, restShare, split);
        const result = groupBook(input);
        const legSizes = input.boros.map((b) => b.size);
        const hedged = result.cards.filter((c) => c.kind === 'hedged');
        if (input.boros.every((b) => b.notionalUsd >= 50)) {
          expect(hedged.map((c) => c.size).sort((a, b) => b - a), `${size} ${split}`).toEqual([...new Set(legSizes)]);
        }
        for (const card of result.cards) {
          expect(legSizes.concat(size), `${size} ${split} card`).toContain(card.size);
          for (const row of [...card.perps, ...card.boros]) expect([card.size, ...legSizes, size], `${size} ${split} row`).toContain(row.size);
        }
        for (const row of [...result.ungrouped.perps, ...result.ungrouped.boros]) expect(legSizes.concat(size)).toContain(row.size);
        expect(unshownLegs(input, result)).toEqual([]);
      }
    }
  });

  it('F25 a lone $6M leg does not change the pairing of small units', () => {
    const units = ['G L 1000', 'H S 1000', 'O L 999', 'LI S 999'];
    expect(cardsOf(groupBook(bookOf(units, { price: 1 })))).toEqual(['BM G/H - 1000', 'BM O/LI - 999']);
    const withWhale = groupBook(bookOf([...units, 'B LONG 6000000 N b'], { price: 1 }));
    expect(cardsOf(withWhale)).toEqual(['BM G/H - 1000', 'BM O/LI - 999']);
    expect(ungroupedOf(withWhale)).toEqual(['U b 6000000']);
  });

  it('F1 a wrong-side spread names the venue whose perp it points against', () => {
    const result = groupBook(bookOf(['G L 1', 'LI S 1', 'H-G LONG 1 N sp']));
    expect(cardsOf(result)).toEqual(['BM G/LI - 1']);
    expect(result.cards[0].otherWay).toEqual([{ marketId: marketIdOf('sp'), blocks: true, againstVenue: 'GATE' }]);
  });

  it('F63 Boros rows list the long venue first, as the perp rows do', () => {
    const result = groupBook(bookOf(['G L 1', 'H S 1', 'G LONG 1 N zz', 'H SHORT 1 N a']));
    expect(result.cards.map(rowsOf)).toEqual([['G|L 1', 'H|S 1', 'zz 1', 'a 1']]);
  });

  it('empty book makes no card', () => {
    expect(groupBook({ perps: [], boros: [], restShare: 0.001 })).toEqual({ cards: [], ungrouped: { perps: [], boros: [] }, solves: 0 });
  });
});
