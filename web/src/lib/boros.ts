/** Deep link into the Boros app: the market's trade page with the order form
 * prepopulated to the given direction, so "Short ETH funding @ Hyperliquid"
 * lands the visitor one confirm away from that exact leg. */
export const borosMarketUrl = (marketId: number, direction: 'long' | 'short'): string =>
  `https://boros.pendle.finance/markets/${marketId}?form=market&direction=${direction}`;

/**
 * Boros venue key → the CrossEx venue that lists its perps.
 *
 * ⚠ Mirrors `BOROS_VENUE_TO_CROSSEX` in `src/core/boros/opportunities.ts`. The
 * web bundle does not import from `src/core` (there is a deliberate boundary,
 * and the other shared helpers in this directory are duplicated the same way),
 * so the two copies must be edited together — a venue added there and not here
 * silently loses its perp CTAs.
 *
 * Identity for every venue currently mapped, which is exactly why forgetting
 * the translation LOOKS correct: the bug only appears on a Boros venue with no
 * CrossEx listing (Lighter is live in the market list today), where passing the
 * raw key arms a ticket for a venue that cannot fill it.
 */
const BOROS_VENUE_TO_CROSSEX: Record<string, string> = {
  BINANCE: 'BINANCE',
  BYBIT: 'BYBIT',
  GATE: 'GATE',
  OKX: 'OKX',
  HYPERLIQUID: 'HYPERLIQUID',
  KRAKEN: 'KRAKEN',
};

/**
 * The CrossEx venue for a Boros leg's venue, or null when none lists it.
 *
 * Null is the meaningful answer, not a failure: a Boros market whose venue has
 * no CrossEx perp cannot be hedged from this terminal at all, and a caller that
 * treats null as "just use the Boros key" produces a ticket that silently
 * refuses to resolve a symbol.
 */
export function crossexVenueFor(borosVenue: string | null | undefined): string | null {
  if (!borosVenue) return null;
  return BOROS_VENUE_TO_CROSSEX[borosVenue.trim().toUpperCase()] ?? null;
}
