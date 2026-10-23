import { venueLegsOf } from '../../lib/spread';
import type { GroupBoros, GroupCard, GroupInput, GroupPerp, GroupResult } from './grouping';

export const VENUES: Readonly<Record<string, string>> = { B: 'BINANCE', G: 'GATE', H: 'HYPERLIQUID', LI: 'LIGHTER', O: 'OKX' };

export const DATES: Readonly<Record<string, number>> = {
  O: Date.UTC(2026, 9, 30, 8) / 1000,
  N: Date.UTC(2026, 10, 27, 8) / 1000,
  D: Date.UTC(2026, 11, 11, 8) / 1000,
  A: Date.UTC(2027, 3, 30, 8) / 1000,
};

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_WIDTH = 6;

export function marketIdOf(name: string): number {
  if (name.length > ID_WIDTH) throw new Error(`book: id "${name}" is longer than ${ID_WIDTH}`);
  let id = 0;
  for (let i = 0; i < ID_WIDTH; i++) {
    const digit = i < name.length ? ID_CHARS.indexOf(name[i]) + 1 : 0;
    if (digit < 0 || (i < name.length && digit === 0)) throw new Error(`book: id "${name}" has a character outside ${ID_CHARS}`);
    id = id * (ID_CHARS.length + 1) + digit;
  }
  return id;
}

export function nameOf(marketId: number): string {
  let name = '';
  let rest = marketId;
  for (let i = 0; i < ID_WIDTH; i++) {
    const digit = rest % (ID_CHARS.length + 1);
    rest = Math.floor(rest / (ID_CHARS.length + 1));
    if (digit > 0) name = ID_CHARS[digit - 1] + name;
  }
  return name;
}

const codeOf = (venue: string): string => Object.keys(VENUES).find((k) => VENUES[k] === venue) ?? venue;
const dateCodeOf = (maturity: number | null): string =>
  maturity === null ? '-' : (Object.keys(DATES).find((k) => DATES[k] === maturity) ?? String(maturity));
const round6 = (n: number): number => +n.toFixed(6);

export type BookOptions = { price?: number; restShare?: number; excluded?: Record<string, number | 'all'> };

export function bookOf(spec: string[], opts: BookOptions = {}): GroupInput {
  const price = opts.price ?? 2_500;
  const perps: GroupPerp[] = [];
  const boros: GroupBoros[] = [];
  for (const token of spec) {
    const [venueCode, side, sizeText, fourth, fifth] = token.split(' ');
    const size = Number(sizeText);
    if (side === 'L' || side === 'S') {
      const venue = VENUES[venueCode];
      const quote = fourth ?? 'USDT';
      perps.push({
        venue,
        side: side === 'L' ? 'LONG' : 'SHORT',
        symbol: `${venue}_FUTURE_ETH_${quote}`,
        size,
        notionalUsd: size * price,
        quoteTwin: fifth === 'twin',
      });
      continue;
    }
    if (side !== 'LONG' && side !== 'SHORT') throw new Error(`book: no side in "${token}"`);
    if (!fifth) throw new Error(`book: no id in "${token}"`);
    if (fourth === 'M') continue;
    const excluded = opts.excluded?.[fifth];
    const kept = excluded === 'all' ? 0 : size - (excluded ?? 0);
    if (kept <= 0) continue;
    const venues = venueCode.split('-').map((c) => VENUES[c]);
    boros.push({
      marketId: marketIdOf(fifth),
      legs: venueLegsOf({ venue: venues[0], side, spreadVenues: venues.length > 1 ? venues : null }, kept),
      size: kept,
      notionalUsd: kept * price,
      maturity: DATES[fourth],
    });
  }
  return { perps, boros, restShare: opts.restShare ?? 0.001 };
}

export function cardKeyOf(card: GroupCard): string {
  const kind = card.kind === 'hedged' ? 'H' : card.kind === 'borosMissing' ? 'BM' : 'PM';
  const holds = card.kind === 'borosMissing' && (card.holds === 'LONG' || card.holds === 'SHORT') ? ` holds${card.holds[0]}` : '';
  return `${kind} ${codeOf(card.longVenue)}/${codeOf(card.shortVenue)} ${dateCodeOf(card.maturity)}${card.spread ? ' spread' : ''}${holds}`;
}

export const cardsOf = (result: GroupResult): string[] => result.cards.map((c) => `${cardKeyOf(c)} ${round6(c.size)}`).sort();

export function ungroupedOf(result: GroupResult): string[] {
  const perps = result.ungrouped.perps.map(
    (p) => `U ${codeOf(p.venue)}|${p.side[0]}${p.quoteTwin ? '|twin' : ''} ${round6(p.size)}`,
  );
  const boros = result.ungrouped.boros.map((b) => (b.wrongSide ? `U(W) ${nameOf(b.marketId)}` : `U ${nameOf(b.marketId)} ${round6(b.size)}`));
  return [...perps, ...boros].sort();
}

export function otherWayOf(result: GroupResult): string[] {
  const hosted = result.cards.flatMap((c) =>
    c.otherWay.map((o) => `${nameOf(o.marketId)} ${o.blocks ? 'blocks' : 'free'} against ${codeOf(o.againstVenue)} on ${cardKeyOf(c)}`),
  );
  const loose = result.ungrouped.boros.flatMap((b) =>
    b.wrongSide ? [`${nameOf(b.marketId)} ${b.wrongSide.blocks ? 'blocks' : 'free'} against ${codeOf(b.wrongSide.againstVenue)} in Ungrouped`] : [],
  );
  return [...hosted, ...loose].sort();
}

export function offersOf(card: GroupCard): string[] {
  const long = card.blocked.long ? 'blocked' : card.offer.long > 0 ? String(round6(card.offer.long)) : null;
  const short = card.blocked.short ? 'blocked' : card.offer.short > 0 ? String(round6(card.offer.short)) : null;
  return [
    ...(long ? [`${codeOf(card.longVenue)} LONG ${long}`] : []),
    ...(short ? [`${codeOf(card.shortVenue)} SHORT ${short}`] : []),
  ];
}

export const rowsOf = (card: GroupCard): string[] => [
  ...card.perps.map((p) => `${codeOf(p.venue)}|${p.side[0]} ${round6(p.size)}`),
  ...card.boros.map((b) => `${nameOf(b.marketId)} ${round6(b.size)}`),
];

export type GroupCase = {
  title: string;
  spec: string[];
  cards: string[] | null;
  ug?: string[];
  ow?: string[];
  offers?: Record<string, string[]>;
  rows?: Record<string, string[]>;
  opts?: BookOptions;
};

const BTC = { price: 80_000 };
const SOL = { price: 1, restShare: 0.005 };

export const CASES: GroupCase[] = [
  { title: 'ED-6648 normal: one full unit', spec: ['G L 10', 'H S 10', 'G LONG 10 N g', 'H SHORT 10 N h'], cards: ['H G/H N 10'] },
  { title: 'ED-6648 normal with a spread', spec: ['G L 10', 'H S 10', 'H-G SHORT 10 N sp'], cards: ['H G/H N spread 10'] },
  { title: 'ED-6648 only matured legs left, with perps', spec: ['G L 1', 'H S 1', 'G LONG 1 M g', 'H SHORT 1 M h'], cards: ['BM G/H - 1'] },
  { title: 'ED-6648 only matured legs left, no perps', spec: ['G LONG 1 M g', 'H SHORT 1 M h'], cards: [] },
  { title: 'ED-6648 everything closed', spec: [], cards: [] },
  { title: 'B14 perps only make one card', spec: ['G L 1', 'H S 1'], cards: ['BM G/H - 1'] },
  {
    title: 'ED-6648 two perps, a single on one side',
    spec: ['G L 1', 'H S 1', 'G LONG 1 N g'],
    cards: ['BM G/H N holdsL 1'],
    offers: { 'BM G/H N holdsL': ['H SHORT 1'] },
  },
  { title: 'G3 ED-6648 YUs only', spec: ['G LONG 1 N g', 'H SHORT 1 N h'], cards: ['PM G/H N 1'] },
  { title: 'G4 ED-6648 YUs and one perp', spec: ['G L 1', 'G LONG 1 N g', 'H SHORT 1 N h'], cards: ['PM G/H N 1'], rows: { 'PM G/H N': ['G|L 1', 'g 1', 'h 1'] } },
  { title: 'G5 ED-6648 one perp only', spec: ['G L 1'], cards: [], ug: ['U G|L 1'] },
  { title: 'G6 ED-6648 one single only', spec: ['G LONG 1 N g'], cards: [], ug: ['U g 1'] },
  { title: 'G7 ED-6648 one spread only', spec: ['H-G SHORT 1 N sp'], cards: ['PM G/H N spread 1'] },
  { title: 'ED-6648 perps open after the single matured', spec: ['G L 1', 'H S 1', 'G LONG 1 M g', 'H SHORT 1 M h'], cards: ['BM G/H - 1'] },
  { title: 'G8 ED-6648 YU smaller on both sides', spec: ['G L 10', 'H S 10', 'G LONG 6 N g', 'H SHORT 6 N h'], cards: ['BM G/H - 4', 'H G/H N 6'] },
  { title: 'ED-6648 YU smaller on one side only', spec: ['G L 10', 'H S 10', 'G LONG 10 N g', 'H SHORT 6 N h'], cards: ['BM G/H N holdsL 4', 'H G/H N 6'] },
  { title: 'ED-6648 YU bigger than perps', spec: ['G L 6', 'H S 6', 'G LONG 10 N g', 'H SHORT 10 N h'], cards: ['H G/H N 6', 'PM G/H N 4'] },
  {
    title: 'G9 ED-6648 long perp bigger than short perp',
    spec: ['G L 12', 'H S 10', 'G LONG 10 N g', 'H SHORT 10 N h'],
    cards: ['H G/H N 10'],
    ug: ['U G|L 2'],
  },
  {
    title: 'B13 lone single splits off its part (1.7.5 0.36 BTC single behind 4.03 BTC)',
    spec: ['G L 4.03', 'H S 4.03', 'G LONG 0.36 O g'],
    cards: ['BM G/H - 3.67', 'BM G/H O holdsL 0.36'],
    offers: { 'BM G/H O holdsL': ['H SHORT 0.36'] },
  },
  {
    title: 'ED-6648 tiny leftovers: roll filled slightly short',
    spec: ['G L 1', 'H S 1', 'G LONG 0.999 N g2', 'H SHORT 0.999 N h2', 'G LONG 0.001 O g1', 'H SHORT 0.001 O h1'],
    cards: ['H G/H N 0.999'],
    ug: ['U g1 0.001', 'U h1 0.001'],
  },
  {
    title: 'B25 dust perp rides',
    spec: ['G L 0.949', 'H S 0.95', 'G LONG 0.949 N g', 'H SHORT 0.949 N h'],
    cards: ['H G/H N 0.949'],
    rows: { 'H G/H N': ['G|L 0.949', 'H|S 0.95', 'g 0.949', 'h 0.949'] },
  },
  {
    title: 'B26 perp rest under 0.1% rides',
    spec: ['G L 100.03', 'H S 100.03', 'G LONG 100 N g', 'H SHORT 100 N h'],
    cards: ['H G/H N 100'],
    rows: { 'H G/H N': ['G|L 100.03', 'H|S 100.03', 'g 100', 'h 100'] },
  },
  {
    title: 'ED-6648 user excluded a whole leg',
    spec: ['G L 4.03', 'H S 4.03', 'G LONG 0.36 O g'],
    cards: ['BM G/H - 4.03'],
    opts: { excluded: { g: 'all' } },
  },
  {
    title: 'ED-6648 user excluded part of a leg',
    spec: ['G L 10', 'H S 10', 'G LONG 10 N g', 'H SHORT 6 N h'],
    cards: ['BM G/H - 4', 'H G/H N 6'],
    opts: { excluded: { g: 4 } },
  },
  {
    title: 'G11 ED-6648 lone perp on a third venue',
    spec: ['G L 10', 'H S 10', 'G LONG 10 N g', 'H SHORT 10 N h', 'O L 1'],
    cards: ['H G/H N 10'],
    ug: ['U O|L 1'],
  },
  {
    title: 'ED-6648 hedged unit + big extra on its own leg',
    spec: ['G L 12', 'H S 10', 'G LONG 10 N g', 'H SHORT 10 N h'],
    cards: ['H G/H N 10'],
    ug: ['U G|L 2'],
  },
  {
    title: 'ED-6648 hedged unit + small extra on its own leg ($12.50)',
    spec: ['G L 10.005', 'H S 10', 'G LONG 10 N g', 'H SHORT 10 N h'],
    cards: ['H G/H N 10'],
  },
  {
    title: 'B8 two pairings at one date',
    spec: ['G L 0.2', 'H S 0.2', 'O L 0.17', 'LI S 0.17', 'G LONG 0.2 N g', 'H SHORT 0.2 N h', 'O LONG 0.17 N o', 'LI SHORT 0.17 N l'],
    cards: ['H G/H N 0.2', 'H O/LI N 0.17'],
  },
  {
    title: 'ED-6648 one long shared by two shorts',
    spec: ['G L 2', 'H S 1', 'LI S 1', 'G LONG 2 N g', 'H SHORT 1 N h', 'LI SHORT 1 N l'],
    cards: ['H G/H N 1', 'H G/LI N 1'],
  },
  {
    title: 'G13 ED-6648 one row for two collaterals',
    spec: ['G L 2', 'H S 2', 'G LONG 1 N g137', 'G LONG 1 N g194', 'H SHORT 2 N h'],
    cards: ['H G/H N 2'],
    rows: { 'H G/H N': ['G|L 2', 'H|S 2', 'g137 1', 'g194 1', 'h 2'] },
  },
  {
    title: 'G14 ED-6648 full flip',
    spec: ['G L 1', 'H S 1', 'G SHORT 1 N g', 'H LONG 1 N h'],
    cards: ['BM G/H - 1'],
    ow: ['g blocks against G on BM G/H -', 'h blocks against H on BM G/H -'],
  },
  {
    title: 'B21 held other way at any date',
    spec: ['G L 1', 'H S 1', 'H LONG 1 O h'],
    cards: ['BM G/H - 1'],
    ow: ['h blocks against H on BM G/H -'],
    offers: { 'BM G/H -': ['G LONG 1', 'H SHORT blocked'] },
  },
  {
    title: 'G15 ED-6648 flip next to an arb',
    spec: ['G L 1', 'H S 1', 'G LONG 1 N g', 'H SHORT 1 N h', 'G SHORT 1 O gf', 'H LONG 1 O hf'],
    cards: ['H G/H N 1'],
    ug: ['U(W) gf', 'U(W) hf'],
    ow: ['gf free against G in Ungrouped', 'hf free against H in Ungrouped'],
  },
  { title: 'ED-6648 single only, rate trading', spec: ['H SHORT 1 N h'], cards: [], ug: ['U h 1'] },
  {
    title: 'A7 a USDC twin perp goes to Ungrouped',
    spec: ['B L 4 USDT', 'B L 1 USDC twin', 'H S 4', 'B LONG 4 N b', 'H SHORT 4 N h'],
    cards: ['H B/H N 4'],
    ug: ['U B|L|twin 1'],
  },
  {
    title: 'B37 strike then re-solve moves the small unit',
    spec: [
      'O L 0.015',
      'G S 0.013847265958786012',
      'H L 2400',
      'O S 2399.036178588867',
      'O LONG 0.015 N l942',
      'G SHORT 0.015 N s942',
      'H LONG 2400 D l941',
      'O SHORT 2400 D s941',
      'LI SHORT 0.001 M x942',
      'G SHORT 1000 O x941',
    ],
    cards: ['BM H/G D holdsL 0.013847', 'H H/O D 2399.036179'],
    ug: ['U O|L 0.015', 'U s942 0.015', 'U x941 1000', 'U(W) l942'],
  },
  { title: 'A8 a twin makes no card', spec: ['B L 1 USDC twin', 'H S 1'], cards: [], ug: ['U B|L|twin 1', 'U H|S 1'] },
  {
    title: 'G16 ED-6648 two full units at two dates',
    spec: ['G L 20', 'H S 20', 'G LONG 10 O g1', 'H SHORT 10 O h1', 'G LONG 10 N g2', 'H SHORT 10 N h2'],
    cards: ['H G/H N 10', 'H G/H O 10'],
  },
  {
    title: 'B7 roll keeps old legs',
    spec: ['G L 10', 'H S 10', 'G LONG 10 O g1', 'H SHORT 10 O h1', 'G LONG 4 N g2', 'H SHORT 4 N h2'],
    cards: ['H G/H N 4', 'H G/H O 6', 'PM G/H O 4'],
  },
  {
    title: 'B10 shared perps go to the bigger pairing',
    spec: ['G L 10', 'H S 10', 'LI S 1', 'G LONG 10 O g1', 'H SHORT 10 O h1', 'G LONG 1 N g2', 'LI SHORT 1 N l2'],
    cards: ['H G/H O 10', 'PM G/LI N 1'],
    rows: { 'PM G/LI N': ['LI|S 1', 'g2 1', 'l2 1'] },
  },
  {
    title: 'B9 stray leg at the new date',
    spec: ['G L 2', 'H S 1', 'LI S 1', 'G LONG 1 O g1', 'H SHORT 1 O h1', 'G LONG 1 N g2', 'H SHORT 1 N h2', 'LI SHORT 1 N l2'],
    cards: ['H G/H O 1', 'H G/LI N 1'],
    ug: ['U h2 1'],
  },
  {
    title: 'B16 singles at two dates never pair',
    spec: ['G L 3', 'H S 3', 'G LONG 3 O g', 'H SHORT 3 N h'],
    cards: ['BM G/H N holdsS 3'],
    ug: ['U g 3'],
  },
  {
    title: 'B15 half roll: new date takes the perps',
    spec: ['G L 10', 'H S 10', 'G LONG 6 O g1', 'G LONG 4 N g2', 'H SHORT 10 O h'],
    cards: ['BM G/H N holdsL 4', 'H G/H O 6'],
    ug: ['U h 4'],
    offers: { 'BM G/H N holdsL': [] },
  },
  { title: 'ED-6648 one second before maturity', spec: ['G L 1', 'H S 1', 'G LONG 1 O g', 'H SHORT 1 O h'], cards: ['H G/H O 1'] },
  { title: 'ED-6648 legs matured at the second', spec: ['G L 1', 'H S 1', 'G LONG 1 M g', 'H SHORT 1 M h'], cards: ['BM G/H - 1'] },
  {
    title: 'B11 spread and singles make two cards',
    spec: ['G L 3', 'H S 3', 'H-G SHORT 2 N sp', 'G LONG 1 N g', 'H SHORT 1 N h'],
    cards: ['H G/H N 1', 'H G/H N spread 2'],
  },
  {
    title: 'B12 spread takes the perps first',
    spec: ['G L 2', 'H S 2', 'H-G SHORT 2 N sp', 'G LONG 2 N g', 'H SHORT 2 N h'],
    cards: ['H G/H N spread 2', 'PM G/H N 2'],
  },
  {
    title: 'ED-6648 spread at one date, singles at another, perps for both',
    spec: ['G L 3', 'H S 3', 'H-G SHORT 2 N sp', 'G LONG 1 O g', 'H SHORT 1 O h'],
    cards: ['H G/H N spread 2', 'H G/H O 1'],
  },
  {
    title: 'G19 ED-6648 spread and singles at two dates',
    spec: ['G L 2', 'H S 2', 'H-G SHORT 2 N sp', 'G LONG 1 O g', 'H SHORT 1 O h'],
    cards: ['H G/H N spread 2', 'PM G/H O 1'],
  },
  {
    title: 'G20 ED-6648 two spreads at two dates',
    spec: ['G L 2', 'H S 2', 'H-G SHORT 2 N sp2', 'H-G SHORT 2 O sp1'],
    cards: ['H G/H N spread 2', 'PM G/H O spread 2'],
  },
  {
    title: 'G28 ED-6648 spread and singles at two other dates',
    spec: ['G L 3', 'H S 3', 'H-G SHORT 2 N sp', 'G LONG 1 O g', 'H SHORT 1 D h'],
    cards: ['BM G/H D holdsS 1', 'H G/H N spread 2'],
    ug: ['U g 1'],
  },
  {
    title: 'G21 ED-6648 spread and one lone single',
    spec: ['G L 3', 'H S 3', 'H-G SHORT 2 N sp', 'G LONG 1 N g'],
    cards: ['BM G/H N holdsL 1', 'H G/H N spread 2'],
    offers: { 'BM G/H N holdsL': ['H SHORT 1'] },
  },
  { title: 'G22 ED-6648 spread venue order flipped', spec: ['G L 1', 'H S 1', 'G-H LONG 1 N sp'], cards: ['H G/H N spread 1'] },
  {
    title: 'B23 wrong-way spread blocks both opens',
    spec: ['G L 1', 'H S 1', 'H-G LONG 1 N sp'],
    cards: ['BM G/H - 1'],
    ow: ['sp blocks against H on BM G/H -'],
    offers: { 'BM G/H -': ['G LONG blocked', 'H SHORT blocked'] },
  },
  { title: 'G23 ED-6648 spread smaller than the perps', spec: ['G L 3', 'H S 3', 'H-G SHORT 2 N sp'], cards: ['BM G/H - 1', 'H G/H N spread 2'] },
  { title: 'G24 ED-6648 spread bigger than the perps', spec: ['G L 1', 'H S 1', 'H-G SHORT 3 N sp'], cards: ['H G/H N spread 1', 'PM G/H N spread 2'] },
  {
    title: 'ED-6648 spread on other venues',
    spec: ['G L 1', 'H S 1', 'LI-G SHORT 1 N sp'],
    cards: ['BM G/H - 1', 'PM G/LI N spread 1'],
    offers: { 'BM G/H -': ['G LONG 1', 'H SHORT 1'] },
  },
  {
    title: 'C10 singles on other venues: the offer is not cut',
    spec: ['G L 10', 'H S 10', 'G LONG 10 N g', 'LI SHORT 10 N l'],
    cards: ['BM G/H - 10', 'PM G/LI N 10'],
    offers: { 'BM G/H -': ['G LONG 10', 'H SHORT 10'] },
  },
  {
    title: 'ED-6648 coin-margined and USDT-margined markets',
    spec: ['G L 2', 'H S 2', 'G LONG 1 N m137', 'G LONG 1 N m194', 'H SHORT 2 N h'],
    cards: ['H G/H N 2'],
  },
  {
    title: 'G26 ED-6648 two longs, two shorts, a tie',
    spec: ['G L 1', 'O L 1', 'H S 1', 'LI S 1', 'G LONG 1 N g', 'O LONG 1 N o', 'H SHORT 1 N h', 'LI SHORT 1 N l'],
    cards: null,
  },
  {
    title: 'ED-6648 very large sizes ($15B)',
    spec: ['G L 6000000', 'H S 6000000', 'G LONG 3600000 N g', 'H SHORT 3600000 N h'],
    cards: ['BM G/H - 2400000', 'H G/H N 3600000'],
  },
  {
    title: 'G29 ED-6648 roll opened, old legs held',
    spec: ['G L 10', 'H S 10', 'G LONG 10 O g1', 'H SHORT 10 O h1', 'G LONG 10 N g2', 'H SHORT 10 N h2'],
    cards: ['H G/H N 10', 'PM G/H O 10'],
  },
  {
    title: 'G31 ED-6648 spread added on top of singles at two dates',
    spec: ['G L 1.6066', 'H S 1.6066', 'H-G SHORT 1.39 N sp', 'G LONG 0.6747 O go', 'H SHORT 0.6747 O ho', 'G LONG 0.7485 N gn', 'H SHORT 0.7485 N hn'],
    cards: ['H G/H N 0.2166', 'H G/H N spread 1.39', 'PM G/H N 0.5319', 'PM G/H O 0.6747'],
  },
  {
    title: 'G30 ED-6648 exact tie keeps the single whole',
    spec: ['LI L 11.0049', 'H S 10.2623', 'G S 1', 'H-LI SHORT 10.0049 O sp', 'LI LONG 1 O l', 'G SHORT 0.7064 O s'],
    cards: ['BM LI/G O holdsL 0.2936', 'H LI/G O 0.7064', 'H LI/H O spread 10.0049'],
    ug: ['U H|S 0.2574'],
    offers: { 'BM LI/G O holdsL': ['G SHORT 0.2936'] },
  },
  { title: 'G32 ED-6648 a perp and a single on one venue make no card', spec: ['G L 1', 'G LONG 1 N g'], cards: [], ug: ['U G|L 1', 'U g 1'] },
  { title: 'G36 ED-6648 a perp and a single on two venues make no card', spec: ['G L 1', 'H SHORT 1 N h'], cards: [], ug: ['U G|L 1', 'U h 1'] },
  {
    title: 'B31 wrong-way leg blocks every card on its venue',
    spec: ['G L 1', 'O L 1', 'H S 2', 'H LONG 1 O w'],
    cards: ['BM G/H - 1', 'BM O/H - 1'],
    ow: ['w blocks against H on BM G/H -'],
    offers: { 'BM G/H -': ['G LONG 1', 'H SHORT blocked'], 'BM O/H -': ['O LONG 1', 'H SHORT blocked'] },
  },
  { title: 'B32 card of $37.50 a side stays', spec: ['G L 0.015', 'H S 0.015'], cards: ['BM G/H - 0.015'] },
  { title: 'B33 card of $20 a side is dust', spec: ['G L 0.008', 'H S 0.008'], cards: [], ug: ['U G|L 0.008', 'U H|S 0.008'] },
  {
    title: 'G37 ED-6648 two perps and a single make a card',
    spec: ['G L 1', 'H S 1', 'G LONG 1 N g'],
    cards: ['BM G/H N holdsL 1'],
    offers: { 'BM G/H N holdsL': ['H SHORT 1'] },
  },
  { title: 'B19 Boros-only legs at two dates stay apart', spec: ['G LONG 10 O g', 'LI SHORT 10 N l'], cards: [], ug: ['U g 10', 'U l 10'] },
  {
    title: 'B20 a dust perp sets no direction',
    spec: ['G LONG 10 O g', 'LI SHORT 10 N l', 'G S 0.01'],
    cards: [],
    ug: ['U G|S 0.01', 'U g 10', 'U l 10'],
    ow: [],
  },
  {
    title: 'B22 small wrong-way leg does not block',
    spec: ['G L 1', 'H S 1', 'H LONG 0.008 O h'],
    cards: ['BM G/H - 1'],
    ow: ['h free against H on BM G/H -'],
    offers: { 'BM G/H -': ['G LONG 1', 'H SHORT 1'] },
  },
  {
    title: 'B24 tiny Boros leg goes to Ungrouped',
    spec: ['G L 1', 'H S 1', 'G LONG 0.008 N g'],
    cards: ['BM G/H - 1'],
    ug: ['U g 0.008'],
    offers: { 'BM G/H -': ['G LONG 0.992', 'H SHORT 1'] },
  },
  {
    title: 'F39 a $25-a-leg hedged pair keeps its card (#50)',
    spec: ['G L 0.012', 'H S 0.012', 'G LONG 0.012 O g', 'H SHORT 0.012 O h'],
    cards: ['H G/H O 0.012'],
    ug: [],
  },
  {
    title: 'B27 big-book rests ride',
    spec: ['G L 1539.103', 'O L 324.866', 'H S 1863.969', 'H SHORT 1665 O h1', 'H SHORT 199.18 N h2', 'G LONG 1340 O g1', 'G LONG 199.18 N g2', 'O LONG 325 O o1'],
    cards: ['H G/H N 199.18', 'H G/H O 1339.923', 'H O/H O 324.866'],
    rows: { 'H G/H O': ['G|L 1339.923', 'H|S 1339.923', 'g1 1340', 'h1 1340.134'] },
  },
  {
    title: 'B36 dollar-unit rest share is 0.5%: (a) the HL perp carries $450',
    spec: ['G L 150000', 'H S 150450', 'G LONG 150000 N g', 'H SHORT 150000 N h'],
    cards: ['H G/H N 150000'],
    rows: { 'H G/H N': ['G|L 150000', 'H|S 150450', 'g 150000', 'h 150000'] },
    opts: SOL,
  },
  {
    title: 'B36 dollar-unit rest share is 0.5%: (b) both perps carry $450',
    spec: ['G L 150450', 'H S 150450', 'G LONG 150000 N g', 'H SHORT 150000 N h'],
    cards: ['H G/H N 150000'],
    opts: SOL,
  },
  {
    title: 'B36 dollar-unit rest share is 0.5%: (c) the Boros rests ride',
    spec: ['G L 149550', 'H S 149550', 'G LONG 150000 N g', 'H SHORT 150000 N h'],
    cards: ['H G/H N 149550'],
    opts: SOL,
  },
  {
    title: 'B36 dollar-unit rest share is 0.5%: (d) a 0.6% rest is its own card',
    spec: ['G L 150900', 'H S 150900', 'G LONG 150000 N g', 'H SHORT 150000 N h'],
    cards: ['BM G/H - 900', 'H G/H N 150000'],
    opts: SOL,
  },
  { title: 'U3 two perp sides on one venue', spec: ['G L 2', 'G S 1', 'H S 2'], cards: ['BM G/H - 2'], ug: ['U G|S 1'] },
  {
    title: 'G40 ED-6648 two collaterals make one missing card',
    spec: ['G LONG 1 N g137', 'G LONG 1 N g194', 'H SHORT 2 N h'],
    cards: ['PM G/H N 2'],
    rows: { 'PM G/H N': ['g137 1', 'g194 1', 'h 2'] },
  },
  {
    title: '1.7.5 each single is its own part at its own date',
    spec: ['G L 4', 'H S 4', 'G LONG 0.05 O a', 'H SHORT 3.9 N b'],
    cards: ['BM G/H - 0.05', 'BM G/H N holdsS 3.9', 'BM G/H O holdsL 0.05'],
    opts: BTC,
  },
  {
    title: '1.7.5 full singles pair 0.36, the HL single holds 0.14, the rest is perps only',
    spec: ['G L 4', 'H S 4', 'G LONG 0.36 O a', 'H SHORT 0.5 O b'],
    cards: ['BM G/H - 3.5', 'BM G/H O holdsS 0.14', 'H G/H O 0.36'],
    opts: BTC,
  },
  {
    title: '1.7.5 a part-filled single takes its size, the rest is perps only',
    spec: ['G L 4', 'H S 4', 'H SHORT 1.7 N b'],
    cards: ['BM G/H - 2.3', 'BM G/H N holdsS 1.7'],
    opts: BTC,
  },
  {
    title: '1.7.5 a spread plus a part single: the spread takes the perps first',
    spec: ['G L 4', 'H S 4', 'H-G SHORT 1.7 N sp', 'G LONG 1.7 O a'],
    cards: ['BM G/H - 0.6', 'BM G/H O holdsL 1.7', 'H G/H N spread 1.7'],
    opts: BTC,
  },
  {
    title: '1.7.5 0.05 BTC is a part of its own, not dust',
    spec: ['G L 4', 'H S 4', 'G LONG 0.05 O a'],
    cards: ['BM G/H - 3.95', 'BM G/H O holdsL 0.05'],
    opts: BTC,
  },
  {
    title: '1.7.5 two singles larger than the perps: the larger one takes them first',
    spec: ['G L 4', 'H S 4', 'G LONG 0.36 O a', 'H SHORT 3.9 N b'],
    cards: ['BM G/H N holdsS 3.9', 'BM G/H O holdsL 0.1'],
    ug: ['U a 0.26'],
    offers: { 'BM G/H N holdsS': ['G LONG 3.64'] },
    opts: BTC,
  },
  {
    title: '1.7.5 a part single on both sides: the pair takes it, the rest is perps only',
    spec: ['G L 4', 'H S 4', 'G LONG 1 O a', 'H SHORT 1 O b'],
    cards: ['BM G/H - 3', 'H G/H O 1'],
    opts: BTC,
  },
  {
    title: '1.7.5 a part spread with no singles: the rest is perps only',
    spec: ['G L 4', 'H S 4', 'H-G SHORT 1 N sp'],
    cards: ['BM G/H - 3', 'H G/H N spread 1'],
    opts: BTC,
  },
  {
    title: '1.7.5 a single larger than its perps: the extra goes to Ungrouped',
    spec: ['G L 4', 'H S 4', 'G LONG 5 O a'],
    cards: ['BM G/H O holdsL 4'],
    ug: ['U a 1'],
    opts: BTC,
  },
  {
    title: '1.7.5 mixed book with full perps is two cards: the spread and the singles',
    spec: ['G L 0.555', 'H S 0.555', 'H SHORT 0.3 N m51', 'G LONG 0.3 N m60', 'H-G SHORT 0.255 N m59'],
    cards: ['H G/H N 0.3', 'H G/H N spread 0.255'],
    opts: { price: 2_568 },
  },
  {
    title: '1.7.5 mixed book with part perps: the spread is hedged first',
    spec: ['G L 0.4', 'H S 0.4', 'H SHORT 0.3 N m51', 'G LONG 0.3 N m60', 'H-G SHORT 0.255 N m59'],
    cards: ['H G/H N 0.145', 'H G/H N spread 0.255', 'PM G/H N 0.155'],
    opts: { price: 2_568 },
  },
  {
    title: '1.7.5 mixed book with perps smaller than the spread: both groups miss perps',
    spec: ['G L 0.2', 'H S 0.2', 'H SHORT 0.3 N m51', 'G LONG 0.3 N m60', 'H-G SHORT 0.255 N m59'],
    cards: ['H G/H N spread 0.2', 'PM G/H N 0.3', 'PM G/H N spread 0.055'],
    opts: { price: 2_568 },
  },
  {
    title: '1.7.5 mixed book with no perps: two missing-perp cards',
    spec: ['H SHORT 0.3 N m51', 'G LONG 0.3 N m60', 'H-G SHORT 0.255 N m59'],
    cards: ['PM G/H N 0.3', 'PM G/H N spread 0.255'],
    opts: { price: 2_568 },
  },
  {
    title: '1.7.5 wrong-side spread stands alone',
    spec: ['G L 0.555', 'H S 0.555', 'H-G LONG 0.555 N m59'],
    cards: ['BM G/H - 0.555'],
    ow: ['m59 blocks against H on BM G/H -'],
    opts: { price: 2_568 },
  },
  {
    title: '1.7.6 a roll into a bigger size: the new date takes the perps',
    spec: ['G L 100', 'H S 100', 'G LONG 100 O a1', 'H SHORT 100 O b2', 'G LONG 500 N a11', 'H SHORT 500 N b12'],
    cards: ['H G/H N 100', 'PM G/H N 400', 'PM G/H O 100'],
  },
  {
    title: '1.7.6 a part perp left on the old card',
    spec: ['G L 100', 'H S 110', 'G LONG 100 O a1', 'H SHORT 100 O b2', 'G LONG 100 N a11', 'H SHORT 100 N b12'],
    cards: ['H G/H N 100', 'PM G/H O 100'],
    rows: { 'PM G/H O': ['H|S 10', 'a1 100', 'b2 100'] },
  },
  {
    title: '1.7.5 small singles still cut the offer',
    spec: ['G L 0.949', 'H S 0.949', 'G LONG 0.004 N a', 'G LONG 0.004 O b', 'G LONG 0.004 A c'],
    cards: ['BM G/H - 0.949'],
    ug: ['U a 0.004', 'U b 0.004', 'U c 0.004'],
    offers: { 'BM G/H -': ['G LONG 0.937', 'H SHORT 0.949'] },
  },
  {
    title: '1.7.6 a Boros leg shared with another card leaves its rest in Ungrouped',
    spec: ['G LONG 150 N a1', 'H SHORT 100 N b2'],
    cards: ['PM G/H N 100'],
    ug: ['U a1 50'],
  },
];

export const shuffle = <T,>(items: T[], seed: number): T[] => {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export function renameInput(input: GroupInput, to: Record<string, string>): GroupInput {
  return {
    ...input,
    perps: input.perps.map((p) => ({ ...p, venue: to[p.venue] })),
    boros: input.boros.map((p) => ({ ...p, legs: p.legs.map((l) => ({ ...l, venue: to[l.venue] })) })),
  };
}

export function renameResult(r: GroupResult, to: Record<string, string>): GroupResult {
  return {
    ...r,
    cards: r.cards.map((c) => ({
      ...c,
      longVenue: to[c.longVenue],
      shortVenue: to[c.shortVenue],
      perps: c.perps.map((p) => ({ ...p, venue: to[p.venue] })),
      otherWay: c.otherWay.map((w) => ({ ...w, againstVenue: to[w.againstVenue] })),
    })),
    ungrouped: {
      perps: r.ungrouped.perps.map((p) => ({ ...p, venue: to[p.venue] })),
      boros: r.ungrouped.boros.map((b) => ({ ...b, wrongSide: b.wrongSide && { ...b.wrongSide, againstVenue: to[b.wrongSide.againstVenue] } })),
    },
  };
}
