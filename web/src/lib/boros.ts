/** Deep link into the Boros app: the market's trade page with the order form
 * prepopulated to the given direction, so "Short ETH funding @ Hyperliquid"
 * lands the visitor one confirm away from that exact leg. */
export const borosMarketUrl = (marketId: number, direction: 'long' | 'short'): string =>
  `https://boros.pendle.finance/markets/${marketId}?form=market&direction=${direction}`;

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
