import { venueLegsOf } from '../lib/spread';
import type { GroupBoros, GroupInput, GroupPerp } from '../panels/assets/grouping';
import { DATES, VENUES } from '../panels/assets/grouping.cases';

const PRICE = 2_500;
const RANDOM_MODULUS = 2_147_483_648;
const BOOK_VENUES = ['G', 'H', 'O', 'LI'].map((code) => VENUES[code]);
const DATE_CODES = ['O', 'N', 'D', 'M'];
const SIZES = [0.001, 0.015, 0.36, 1, 4.03, 6, 10, 10, 1000, 2400];
const ROLL_DATES: Array<[string, string]> = [
  ['O', 'N'],
  ['O', 'D'],
  ['N', 'D'],
];

type Side = 'LONG' | 'SHORT';

function randomOf(seed: number) {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % RANDOM_MODULUS;
    return state / RANDOM_MODULUS;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const size = (): number => (next() < 0.7 ? pick(SIZES) : Math.max(0.0001, Math.round(next() * 20 * 1e4) / 1e4));
  return { next, pick, shuffle, size };
}

type Random = ReturnType<typeof randomOf>;

class BookBuilder {
  perps: GroupPerp[] = [];
  boros: GroupBoros[] = [];
  private nextId = 1;

  addPerp(venue: string, side: Side, size: number) {
    this.perps.push({ venue, side, symbol: `${venue}_FUTURE_ETH_USDT`, size, notionalUsd: size * PRICE, quoteTwin: false });
  }

  addBoros(venue: string, side: Side, spreadVenues: [string, string] | null, size: number, dateCode: string) {
    if (dateCode === 'M') return;
    this.boros.push({
      marketId: this.nextId++,
      legs: venueLegsOf({ venue, side, spreadVenues }, size),
      size,
      notionalUsd: size * PRICE,
      maturity: DATES[dateCode],
    });
  }

  addStrays(random: Random) {
    for (let k = Math.floor(random.next() * 4); k > 0; k--) {
      if (random.next() < 0.5) {
        this.addPerp(random.pick(BOOK_VENUES), random.pick<Side>(['LONG', 'SHORT']), random.size());
        continue;
      }
      this.addBoros(random.pick(BOOK_VENUES), random.pick<Side>(['LONG', 'SHORT']), null, random.size(), random.pick(DATE_CODES));
    }
  }

  build(): GroupInput {
    return { perps: this.perps, boros: this.boros, restShare: 0.001 };
  }
}

function addUnit(book: BookBuilder, random: Random) {
  const [longVenue, shortVenue] = random.shuffle(BOOK_VENUES);
  const size = random.size();
  const dateCode = random.pick(DATE_CODES.slice(0, 3));
  book.addPerp(longVenue, 'LONG', size);
  book.addPerp(shortVenue, 'SHORT', size * (random.next() < 0.8 ? 1 : 1 + (random.next() - 0.5) * 0.2));
  if (random.next() < 0.4) {
    book.addBoros(shortVenue, 'SHORT', [shortVenue, longVenue], size, dateCode);
    return;
  }
  book.addBoros(longVenue, 'LONG', null, size, dateCode);
  if (random.next() < 0.85) {
    const shortSize = size * (random.next() < 0.8 ? 1 : random.next());
    book.addBoros(shortVenue, 'SHORT', null, shortSize, random.next() < 0.85 ? dateCode : random.pick(DATE_CODES));
  }
}

function addHalfRollUnit(book: BookBuilder, random: Random) {
  const [longVenue, shortVenue] = random.shuffle(BOOK_VENUES);
  const size = random.size();
  const [oldDate, newDate] = random.pick(ROLL_DATES);
  const newSize = size * (0.05 + random.next() * 0.45);
  const oldSize = size - newSize;
  book.addPerp(longVenue, 'LONG', size);
  book.addPerp(shortVenue, 'SHORT', size);
  if (random.next() < 0.4) {
    book.addBoros(shortVenue, 'SHORT', [shortVenue, longVenue], oldSize, oldDate);
    book.addBoros(shortVenue, 'SHORT', [shortVenue, longVenue], newSize, newDate);
    return;
  }
  book.addBoros(longVenue, 'LONG', null, oldSize, oldDate);
  book.addBoros(longVenue, 'LONG', null, newSize, newDate);
  if (random.next() < 0.85) {
    book.addBoros(shortVenue, 'SHORT', null, oldSize, oldDate);
    book.addBoros(shortVenue, 'SHORT', null, newSize, newDate);
  }
}

function booksOf(seed: number, count: number, addUnits: (book: BookBuilder, random: Random) => void): GroupInput[] {
  const random = randomOf(seed);
  return Array.from({ length: count }, () => {
    const book = new BookBuilder();
    addUnits(book, random);
    book.addStrays(random);
    return book.build();
  });
}

export const generatedBooks = (seed: number, count: number): GroupInput[] =>
  booksOf(seed, count, (book, random) => {
    for (let units = Math.floor(random.next() * 3); units > 0; units--) addUnit(book, random);
  });

export const halfRollBooks = (seed: number, count: number): GroupInput[] =>
  booksOf(seed, count, (book, random) => {
    for (let units = 1 + Math.floor(random.next() * 2); units > 0; units--) addHalfRollUnit(book, random);
  });
