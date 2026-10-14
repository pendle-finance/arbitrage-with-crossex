import type { BorosMarket } from './client';
import { knownRate, normalizeVenue } from './venue';

export type SpreadSide = 'SHORT' | 'LONG';

/** A spread's platformId joins its two legs' venue ids in leg order
 * ("hyperliquid-gate"), and its rate is leg 1 − leg 2 (pendle-backend-v3
 * 7de820d0c). Any two distinct venues read, in that order; anything else is
 * unreadable. A venue CrossEx does not trade is filtered where pairs are built. */
export function parseSpreadVenues(isSpread: boolean, platformId: string): [string, string] | null {
  if (!isSpread) return null;
  const legs = platformId.split('-').map(normalizeVenue);
  if (legs.length !== 2 || !legs.every((v) => /^[A-Z0-9]+$/.test(v)) || legs[0] === legs[1]) return null;
  return [legs[0], legs[1]];
}

export const isSpreadMarket = (m: Pick<BorosMarket, 'spreadVenues'>): boolean => Array.isArray(m.spreadVenues);

/** A rate the feed knows on this market. On a single the feed's 0 means none
 * (see knownRate); a spread trades around 0, so its 0 is a real level. */
export const knownRateOf = (m: Pick<BorosMarket, 'spreadVenues'>, n: number | null | undefined): n is number =>
  isSpreadMarket(m) ? typeof n === 'number' && Number.isFinite(n) : knownRate(n);

/** The funding gap below which leg 1 − leg 2 and leg 2 − leg 1 are too close to tell apart. */
const ORDER_CHECK_MIN_GAP = 0.005;

/**
 * True when a spread's live floating rate reads as leg 2 − leg 1. The backend
 * sets each leg's sign by hand, apart from the platformId order, so the order
 * is checked against the singles' live funding where Boros lists both venues
 * for the coin. False when it cannot tell: no single on a venue, or the two
 * venues fund within 0.5%.
 */
export function readsReversed(spread: BorosMarket, markets: ReadonlyArray<BorosMarket>): boolean {
  const venues = spread.spreadVenues;
  if (!venues || !knownRateOf(spread, spread.floatingApr)) return false;
  const funding = (venue: string): number | undefined =>
    markets.find(
      (m) =>
        !isSpreadMarket(m) &&
        m.base.toLowerCase() === spread.base.toLowerCase() &&
        normalizeVenue(m.venue) === venue &&
        knownRate(m.floatingApr),
    )?.floatingApr;
  const first = funding(venues[0]);
  const second = funding(venues[1]);
  if (first === undefined || second === undefined) return false;
  const gap = first - second;
  if (Math.abs(gap) < ORDER_CHECK_MIN_GAP) return false;
  return Math.abs(spread.floatingApr + gap) < Math.abs(spread.floatingApr - gap);
}

export function findSpread({
  markets,
  venues,
  maturity,
  tokenId,
  base,
}: {
  markets: ReadonlyArray<BorosMarket>;
  venues: readonly [string, string];
  maturity: number;
  tokenId: number;
  base: string;
}): BorosMarket | null {
  const wanted = new Set(venues);
  if (wanted.size !== 2) return null;
  return (
    markets.find(
      (m) =>
        m.state === 'Normal' &&
        m.maturity === maturity &&
        m.tokenId === tokenId &&
        m.base.toLowerCase() === base.toLowerCase() &&
        (m.spreadVenues?.every((v) => wanted.has(v)) ?? false),
    ) ?? null
  );
}

export function readSpreadSide(
  spreadVenues: readonly [string, string],
  perpSideByVenue: Readonly<Record<string, SpreadSide>>,
): SpreadSide | null {
  const first = perpSideByVenue[spreadVenues[0]];
  const second = perpSideByVenue[spreadVenues[1]];
  if (first === 'SHORT' && second === 'LONG') return 'SHORT';
  if (first === 'LONG' && second === 'SHORT') return 'LONG';
  return null;
}
