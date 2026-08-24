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

/**
 * Which unit a coin's size box should default to, for BOTH the perp legs and
 * the Boros legs of the same strategy.
 *
 * The rule follows the Boros collateral, because that is the leg with no say
 * in the matter: an ETH-collateral market denominates size in ETH, a
 * USDT-collateral market in USDT. Sizing the perp in the same unit is what
 * makes a hedge exact — matching an ETH Boros leg from a USD box means
 * eyeballing an FX conversion, and the error surfaces later as a position the
 * card flags as imbalanced.
 *
 * ETH and BTC are the coin-margined markets on Boros today; every other coin
 * (HYPE and the rest) is quoted against USDT/USDC, so a token unit there is a
 * conversion imposed for no reason — the user is handed a quantity when the
 * number that matters, on both legs, is dollars.
 *
 * ⚠ Keep this the single source for that choice. When the ticket knows the
 * market's actual collateral it should prefer THAT (see BorosPairTicket's
 * prefill); this answers the same question for callers that only have a coin.
 */
const COIN_MARGINED = new Set(['ETH', 'BTC']);

export function sizeUnitForBase(base: string | null | undefined): 'base' | 'usd' {
  return base && COIN_MARGINED.has(base.toUpperCase()) ? 'base' : 'usd';
}

/** The same rule expressed as a collateral symbol, for labelling a size box. */
export function isUsdCollateral(collateral: string | null | undefined): boolean {
  const c = (collateral ?? '').toUpperCase();
  return c === 'USDT' || c === 'USDC';
}
