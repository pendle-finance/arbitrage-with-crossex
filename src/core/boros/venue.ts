/**
 * The three things the strategy solver (`returns.ts`, retired with the
 * strategy-box Positions tab) left behind that live code still needs: the
 * year constant every APR shares, the venue-key normaliser, and the shape of
 * a CrossEx position as the asset view reads it.
 */

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** A CrossEx position as returned by the venue, only the fields read here. */
export interface PerpPositionLike {
  symbol?: string;
  positionId?: string;
  positionSide?: string;
  positionQty?: string;
  positionValue?: string;
  entryPrice?: string;
  leverage?: string;
  upnl?: string;
  fundingFee?: string;
  fee?: string;
  initialMargin?: string;
  createTime?: string;
}

/**
 * A rate the feed actually knows. The Boros API leaves an absent mid or
 * floating rate as 0 (client.ts: `Number(data.midApr ?? 0)`), so 0 is "none";
 * a NEGATIVE rate is a real negative-funding market and must never be read
 * as missing.
 */
export const knownRate = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n !== 0;

/** Venue keys compare upper-case and trimmed, however the source spelled them. */
export function normalizeVenue(venue: string): string {
  return venue.trim().toUpperCase();
}
