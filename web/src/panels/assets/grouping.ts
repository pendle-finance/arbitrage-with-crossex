import type { VenueLeg } from '../../lib/spread';
import { maximize } from './lp';

export const DUST_USD = 50;

const EPS = 1e-9;
const HEDGED_WEIGHT = 10;
const DATE_WEIGHT = 0.001;
const PERP_DATE_WEIGHT = 0.00000001;
const SPREAD_FIRST_WEIGHT = 0.00002;
const SIZE_MATCH_WEIGHT = 0.000001;
const MAX_SOLVES = 9;

export const sameSize = (a: number, b: number): boolean => Math.abs(a - b) <= EPS * b;

type Side = 'LONG' | 'SHORT';
type Holds = 'LONG' | 'SHORT' | 'both' | 'none';

export type GroupPerp = { venue: string; side: Side; symbol: string; size: number; notionalUsd: number; quoteTwin: boolean };

export type GroupBoros = { marketId: number; legs: VenueLeg[]; size: number; notionalUsd: number; maturity: number };

export type GroupInput = { perps: GroupPerp[]; boros: GroupBoros[]; restShare: number };

export type GroupCard = {
  kind: 'hedged' | 'borosMissing' | 'perpMissing';
  longVenue: string;
  shortVenue: string;
  maturity: number | null;
  size: number;
  perps: Array<{ venue: string; side: Side; symbol: string; size: number }>;
  boros: Array<{ marketId: number; size: number }>;
  holds: Holds;
  spread: boolean;
  offer: { long: number; short: number };
  /** The part of each offer that covers no perp twice. Boros the venue holds
   * at another date can already cover this perp; past `room` an open covers
   * it twice until that leg matures. */
  room: { long: number; short: number };
  blocked: { long: boolean; short: boolean };
  otherWay: Array<{ marketId: number; blocks: boolean; againstVenue: string }>;
};

export type UngroupedPerp = { venue: string; side: Side; symbol: string; size: number; quoteTwin: boolean };

export type WrongSide = { blocks: boolean; againstVenue: string };

export type UngroupedBoros = { marketId: number; size: number; wrongSide: WrongSide | null };

export type GroupResult = { cards: GroupCard[]; ungrouped: { perps: UngroupedPerp[]; boros: UngroupedBoros[] }; solves: number };

type PerpLeg = { kind: 'perp'; venue: string; side: Side; symbol: string; size: number; notionalUsd: number };
type BorosLeg = { kind: 'boros'; position: GroupBoros; size: number; notionalUsd: number };
type Leg = PerpLeg | BorosLeg;

type BorosHalf = { maturity: number | null; rows: number[]; holds: Holds; spread: boolean };

type Candidate = {
  longVenue: string;
  shortVenue: string;
  perpRows: number[];
  boros: BorosHalf;
  rows: number[];
  weight: number;
  hedged: boolean;
};

type Chosen = Candidate & { size: number; rides: Map<number, number> };

type WrongWay = { position: GroupBoros; blocks: boolean; against: string[] };

const unitPrice = (leg: { size: number; notionalUsd: number }): number => (leg.size > 0 ? leg.notionalUsd / leg.size : 0);

const holdsLeg = (position: GroupBoros, venue: string, side: Side): boolean =>
  position.legs.some((l) => l.venue === venue && l.side === side);

function perpLegsOf(perps: GroupPerp[]): PerpLeg[] {
  const byKey = new Map<string, PerpLeg>();
  for (const p of perps) {
    const key = `${p.venue}|${p.side}`;
    const leg = byKey.get(key);
    if (leg) {
      leg.size += p.size;
      leg.notionalUsd += p.notionalUsd;
      continue;
    }
    byKey.set(key, { kind: 'perp', venue: p.venue, side: p.side, symbol: p.symbol, size: p.size, notionalUsd: p.notionalUsd });
  }
  return [...byKey.values()].sort((a, b) => (a.venue === b.venue ? a.side.localeCompare(b.side) : a.venue < b.venue ? -1 : 1));
}

function netSideOf(perpLegs: PerpLeg[], venue: string): Side | null {
  const long = perpLegs.find((l) => l.venue === venue && l.side === 'LONG');
  const short = perpLegs.find((l) => l.venue === venue && l.side === 'SHORT');
  const size = (long?.size ?? 0) + (short?.size ?? 0);
  const net = (long?.size ?? 0) - (short?.size ?? 0);
  const price = size > 0 ? ((long?.notionalUsd ?? 0) + (short?.notionalUsd ?? 0)) / size : 0;
  if (Math.abs(net) * price < DUST_USD) return null;
  return net > 0 ? 'LONG' : 'SHORT';
}

function candidatesOf(legs: Leg[]): Candidate[] {
  const borosRows = legs.flatMap((l, r) => (l.kind === 'boros' ? [r] : []));
  const positionAt = (r: number): GroupBoros => (legs[r] as BorosLeg).position;
  const perpRow = (venue: string, side: Side) => legs.findIndex((l) => l.kind === 'perp' && l.venue === venue && l.side === side);
  const venues = [
    ...new Set(legs.flatMap((l) => (l.kind === 'perp' ? [l.venue] : l.position.legs.map((v) => v.venue)))),
  ].sort();
  const dates = [...new Set(borosRows.map((r) => positionAt(r).maturity))].sort((a, b) => a - b);
  const rankOf = (maturity: number) => (dates.indexOf(maturity) + 1) / dates.length;
  const candidates: Candidate[] = [];
  for (const longVenue of venues) {
    for (const shortVenue of venues) {
      if (longVenue === shortVenue) continue;
      const pL = perpRow(longVenue, 'LONG');
      const pS = perpRow(shortVenue, 'SHORT');
      const perpHalves: number[][] = [[]];
      if (pL >= 0) perpHalves.push([pL]);
      if (pS >= 0) perpHalves.push([pS]);
      if (pL >= 0 && pS >= 0) perpHalves.push([pL, pS]);
      const borosHalves: BorosHalf[] = [{ maturity: null, rows: [], holds: 'none', spread: false }];
      for (const maturity of dates) {
        const at = borosRows.filter((r) => positionAt(r).maturity === maturity);
        const singles = (venue: string, side: Side) =>
          at.filter((r) => positionAt(r).legs.length === 1 && holdsLeg(positionAt(r), venue, side));
        for (const r of at) {
          const p = positionAt(r);
          if (p.legs.length === 2 && holdsLeg(p, longVenue, 'LONG') && holdsLeg(p, shortVenue, 'SHORT')) {
            borosHalves.push({ maturity, rows: [r], holds: 'both', spread: true });
          }
        }
        const longs = singles(longVenue, 'LONG');
        const shorts = singles(shortVenue, 'SHORT');
        for (const a of longs) borosHalves.push({ maturity, rows: [a], holds: 'LONG', spread: false });
        for (const b of shorts) borosHalves.push({ maturity, rows: [b], holds: 'SHORT', spread: false });
        for (const a of longs) for (const b of shorts) borosHalves.push({ maturity, rows: [a, b], holds: 'both', spread: false });
      }
      for (const perpRows of perpHalves) {
        for (const boros of borosHalves) {
          if (perpRows.length < 2 && boros.holds !== 'both') continue;
          if (perpRows.length === 0 && boros.rows.some((r) => legs[r].notionalUsd < DUST_USD)) continue;
          const hedged = perpRows.length === 2 && boros.holds === 'both';
          let weight = (hedged ? HEDGED_WEIGHT : 0) + perpRows.length + (boros.spread ? 2 : boros.rows.length);
          if (perpRows.length > 0 && boros.maturity !== null) {
            weight += DATE_WEIGHT * rankOf(boros.maturity);
            weight += PERP_DATE_WEIGHT * rankOf(boros.maturity) * perpRows.length;
            if (boros.spread) weight += SPREAD_FIRST_WEIGHT;
          }
          const rows = [...perpRows, ...boros.rows];
          const sizes = rows.map((r) => legs[r].size);
          const smallest = Math.min(...sizes);
          weight -= (SIZE_MATCH_WEIGHT * sizes.reduce((t, z) => t + (z - smallest), 0)) / Math.max(...sizes);
          candidates.push({ longVenue, shortVenue, perpRows, boros, rows, weight, hedged });
        }
      }
    }
  }
  return candidates;
}

function solveCards(legs: Leg[], candidates: Candidate[], restShare: number): { chosen: Chosen[]; solves: number } {
  if (candidates.length === 0) return { chosen: [], solves: 0 };
  let live = candidates.map((_, i) => i);
  let sizes = new Map<number, number>();
  let solves = 0;
  const isTiny = (c: Candidate, s: number) => {
    const price = Math.max(...c.rows.map((r) => unitPrice(legs[r])));
    const perpTiny = c.perpRows.length > 0 && 2 * s * price < DUST_USD;
    return perpTiny || c.rows.every((r) => s < restShare * legs[r].size);
  };
  for (;;) {
    const A = legs.map((_, r) => live.map((ci) => (candidates[ci].rows.includes(r) ? 1 : 0)));
    const x = maximize(
      live.map((ci) => candidates[ci].weight),
      A,
      legs.map((l) => l.size),
    );
    solves++;
    sizes = new Map(live.map((ci, j) => [ci, x[j]]));
    const tiny = live.filter((ci) => (sizes.get(ci) ?? 0) > EPS && isTiny(candidates[ci], sizes.get(ci) ?? 0));
    if (tiny.length === 0) break;
    if (solves === MAX_SOLVES) {
      for (const ci of tiny) sizes.set(ci, 0);
      break;
    }
    live = live.filter((ci) => !tiny.includes(ci));
  }
  const chosen = [...sizes]
    .filter(([, s]) => s > EPS)
    .map(([ci, size]) => {
      const c = candidates[ci];
      const whole = c.rows.map((r) => legs[r].size).find((z) => sameSize(size, z));
      return { ...c, size: whole ?? size, rides: new Map<number, number>() };
    });
  return { chosen, solves };
}

const kindOf = (c: Candidate): GroupCard['kind'] => (c.hedged ? 'hedged' : c.perpRows.length === 2 ? 'borosMissing' : 'perpMissing');

function cardsOf(legs: Leg[], chosen: Chosen[]): GroupCard[] {
  const byKey = new Map<string, GroupCard>();
  for (const c of chosen) {
    const kind = kindOf(c);
    const key = [kind, c.longVenue, c.shortVenue, c.boros.maturity, c.boros.spread, c.boros.holds].join('|');
    const card = byKey.get(key) ?? {
      kind,
      longVenue: c.longVenue,
      shortVenue: c.shortVenue,
      maturity: c.boros.maturity,
      size: 0,
      perps: [],
      boros: [],
      holds: c.boros.holds,
      spread: c.boros.spread,
      offer: { long: 0, short: 0 },
      room: { long: 0, short: 0 },
      blocked: { long: false, short: false },
      otherWay: [],
    };
    card.size += c.size;
    for (const r of c.rows) {
      const leg = legs[r];
      const size = c.size + (c.rides.get(r) ?? 0);
      if (leg.kind === 'perp') {
        const row = card.perps.find((p) => p.venue === leg.venue && p.side === leg.side);
        if (row) row.size += size;
        else card.perps.push({ venue: leg.venue, side: leg.side, symbol: leg.symbol, size });
        continue;
      }
      const row = card.boros.find((b) => b.marketId === leg.position.marketId);
      if (row) row.size += size;
      else card.boros.push({ marketId: leg.position.marketId, size });
    }
    byKey.set(key, card);
  }
  const cards = [...byKey.values()];
  const onLongVenue = (card: GroupCard, marketId: number) =>
    legs.some((l) => l.kind === 'boros' && l.position.marketId === marketId && holdsLeg(l.position, card.longVenue, 'LONG')) ? 0 : 1;
  for (const card of cards) {
    card.boros.sort((a, b) => onLongVenue(card, a.marketId) - onLongVenue(card, b.marketId) || a.marketId - b.marketId);
  }
  return cards;
}

function setOffers(cards: GroupCard[], ctx: { input: GroupInput; perpLegs: PerpLeg[]; legs: Leg[]; chosen: Chosen[]; wrongWay: WrongWay[] }) {
  const { input, perpLegs, legs, chosen, wrongWay } = ctx;
  const flipped = new Set(wrongWay.map((w) => w.position.marketId));
  const perpSize = (venue: string, side: Side) => perpLegs.find((l) => l.venue === venue && l.side === side)?.size ?? 0;
  const heldOn = (venue: string, side: Side) => {
    const all = input.boros.reduce((t, p) => t + (!flipped.has(p.marketId) && holdsLeg(p, venue, side) ? p.size : 0), 0);
    const elsewhere = chosen.reduce((t, c) => {
      const holdsHere = c.boros.rows.some((r) => holdsLeg((legs[r] as BorosLeg).position, venue, side));
      const holdsPerp = c.perpRows.some((r) => {
        const leg = legs[r];
        return leg.kind === 'perp' && leg.venue === venue && leg.side === side;
      });
      return t + (holdsHere && !holdsPerp ? c.size : 0);
    }, 0);
    return all - elsewhere;
  };
  const nets = (venue: string, side: Side) => wrongWay.some((w) => w.blocks && holdsLeg(w.position, venue, side));
  const roomOf = (card: GroupCard, venue: string, side: Side) => {
    const value = Math.max(0, Math.min(card.size, perpSize(venue, side) - heldOn(venue, side)));
    return value <= EPS * Math.max(1, card.size) ? 0 : value;
  };
  for (const card of cards) {
    if (card.kind !== 'borosMissing') continue;
    card.blocked = { long: nets(card.longVenue, 'SHORT'), short: nets(card.shortVenue, 'LONG') };
    card.offer = {
      long: card.holds === 'LONG' || card.blocked.long ? 0 : card.size,
      short: card.holds === 'SHORT' || card.blocked.short ? 0 : card.size,
    };
    card.room = {
      long: card.offer.long > 0 ? roomOf(card, card.longVenue, 'LONG') : 0,
      short: card.offer.short > 0 ? roomOf(card, card.shortVenue, 'SHORT') : 0,
    };
  }
}

const perpOut = (p: { venue: string; side: Side; symbol: string; size: number }, quoteTwin: boolean): UngroupedPerp => ({
  venue: p.venue,
  side: p.side,
  symbol: p.symbol,
  size: p.size,
  quoteTwin,
});

export function groupBook(input: GroupInput): GroupResult {
  const twins = input.perps.filter((p) => p.quoteTwin && p.size > 0).map((p) => perpOut(p, true));
  const perpLegs = perpLegsOf(input.perps.filter((p) => !p.quoteTwin && p.size > 0));
  const positions = input.boros.filter((p) => p.size > 0).sort((a, b) => a.marketId - b.marketId);
  const ungroupedBoros: UngroupedBoros[] = [];
  const wrongWay: WrongWay[] = [];
  const placeable: GroupBoros[] = [];
  for (const p of positions) {
    if (p.legs.length > 2) {
      ungroupedBoros.push({ marketId: p.marketId, size: p.size, wrongSide: null });
      continue;
    }
    const against = p.legs.flatMap((l) => {
      const net = netSideOf(perpLegs, l.venue);
      return net !== null && net !== l.side ? [l.venue] : [];
    });
    if (against.length > 0) wrongWay.push({ position: p, blocks: p.notionalUsd * p.legs.length >= DUST_USD, against });
    else placeable.push(p);
  }
  const legs: Leg[] = [
    ...perpLegs,
    ...placeable.map((position): BorosLeg => ({ kind: 'boros', position, size: position.size, notionalUsd: position.notionalUsd })),
  ];

  let solved: { chosen: Chosen[]; solves: number };
  try {
    solved = solveCards(legs, candidatesOf(legs), input.restShare);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    const flipped = new Map(wrongWay.map((w) => [w.position.marketId, w.against[0]]));
    return {
      cards: [],
      ungrouped: {
        perps: [...twins, ...perpLegs.map((l) => perpOut(l, false))],
        boros: positions.map((p) => {
          const againstVenue = flipped.get(p.marketId);
          return { marketId: p.marketId, size: p.size, wrongSide: againstVenue === undefined ? null : { blocks: false, againstVenue } };
        }),
      },
      solves: 0,
    };
  }
  const { chosen, solves } = solved;

  const rests: UngroupedPerp[] = [];
  legs.forEach((leg, r) => {
    const rest = leg.size - chosen.reduce((t, c) => t + (c.rows.includes(r) ? c.size : 0), 0);
    if (rest <= EPS * leg.size) return;
    const holder = chosen.filter((c) => c.rows.includes(r)).sort((a, b) => b.size - a.size)[0];
    if (holder && (rest * unitPrice(leg) < DUST_USD || rest < input.restShare * leg.size)) {
      holder.rides.set(r, rest);
      return;
    }
    if (leg.kind === 'perp') rests.push(perpOut({ ...leg, size: rest }, false));
    else ungroupedBoros.push({ marketId: leg.position.marketId, size: rest, wrongSide: null });
  });

  const cards = cardsOf(legs, chosen);
  for (const w of wrongWay) {
    const host = cards.find(
      (c) => c.kind === 'borosMissing' && w.position.legs.some((l) => l.venue === c.longVenue || l.venue === c.shortVenue),
    );
    if (host) {
      const againstVenue = w.against.find((v) => v === host.longVenue || v === host.shortVenue) ?? w.against[0];
      host.otherWay.push({ marketId: w.position.marketId, blocks: w.blocks, againstVenue });
    } else {
      ungroupedBoros.push({ marketId: w.position.marketId, size: w.position.size, wrongSide: { blocks: false, againstVenue: w.against[0] } });
    }
  }
  setOffers(cards, { input, perpLegs, legs, chosen, wrongWay });

  return {
    cards,
    ungrouped: { perps: [...twins, ...rests], boros: ungroupedBoros.sort((a, b) => a.marketId - b.marketId) },
    solves,
  };
}
