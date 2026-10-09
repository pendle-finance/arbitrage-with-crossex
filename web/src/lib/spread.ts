import { prettyVenue } from './fmt';

export type SpreadVenues = readonly [string, string];

export const spreadLabel = (venues: SpreadVenues): string =>
  venues.map((key) => (key === 'HYPERLIQUID' ? 'HL' : prettyVenue(key))).join('-');

export const spreadShareVenue = (venues: SpreadVenues): string => venues.join('_');

export const isSpreadLeg = (leg: { spreadVenues?: SpreadVenues | null }): boolean => Boolean(leg.spreadVenues);
