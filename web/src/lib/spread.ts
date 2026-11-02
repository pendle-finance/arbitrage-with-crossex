import { prettyVenue } from './fmt';

export type SpreadVenues = readonly [string, string];

/** The platform half of the name, as the Boros app prints it: "HL-GATE". */
export const spreadPlatform = (venues: SpreadVenues): string =>
  venues.map((key) => (key.toUpperCase() === 'HYPERLIQUID' ? 'HL' : prettyVenue(key).toUpperCase())).join('-');

/** The Boros app's name for a spread market, "ETH Spread HL-GATE", used on every screen. */
export const spreadName = (base: string, venues: SpreadVenues): string => `${base} Spread ${spreadPlatform(venues)}`;

export const spreadShareVenue = (venues: SpreadVenues): string => venues.join('_');

export const isSpreadLeg = (leg: { spreadVenues?: SpreadVenues | null }): boolean => Boolean(leg.spreadVenues);

export type VenueLeg = { venue: string; side: 'LONG' | 'SHORT'; size: number };

const otherSide = (side: 'LONG' | 'SHORT'): 'LONG' | 'SHORT' => (side === 'LONG' ? 'SHORT' : 'LONG');

export function venueLegsOf(
  leg: { venue: string; side: 'LONG' | 'SHORT'; spreadVenues?: SpreadVenues | readonly string[] | null },
  size: number,
): VenueLeg[] {
  const venues = leg.spreadVenues;
  if (!venues) return [{ venue: leg.venue, side: leg.side, size }];
  if (venues.length !== 2) return venues.map((venue) => ({ venue, side: leg.side, size }));
  return [
    { venue: venues[0], side: leg.side, size },
    { venue: venues[1], side: otherSide(leg.side), size },
  ];
}
