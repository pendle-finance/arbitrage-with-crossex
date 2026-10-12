import { prettyVenue } from './fmt';

export type SpreadVenues = readonly [string, string];

/** The platform half of the name, as the Boros app prints it: "HL-GATE". */
export const spreadPlatform = (venues: SpreadVenues): string =>
  venues.map((key) => (key.toUpperCase() === 'HYPERLIQUID' ? 'HL' : prettyVenue(key).toUpperCase())).join('-');

/** The Boros app's name for a spread market, "ETH Spread HL-GATE", used on every screen. */
export const spreadName = (base: string, venues: SpreadVenues): string => `${base} Spread ${spreadPlatform(venues)}`;

export const spreadShareVenue = (venues: SpreadVenues): string => venues.join('_');

export const isSpreadLeg = (leg: { spreadVenues?: SpreadVenues | null }): boolean => Boolean(leg.spreadVenues);
