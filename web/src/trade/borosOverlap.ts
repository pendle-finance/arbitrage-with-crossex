/**
 * Boros legs a venue already holds at another date, on the side a ticket is
 * about to open. They can cover the same perp the new leg hedges: past
 * `room`, the open covers that part of the perp twice until enough of the
 * held legs mature. Sizes travel like BorosOpenPrefill's: `size` in dollars,
 * `sizeBase` in the coin when the asset is counted in it.
 */
export interface BorosOverlap {
  venue: string;
  side: 'LONG' | 'SHORT';
  /** Names the held legs, e.g. "Hyperliquid SHORT holds 10 ETH at 30 Oct." */
  held: string;
  room: number;
  roomBase?: number;
  legs: Array<{ size: number; sizeBase?: number; maturity: number }>;
}

/**
 * How much of an `open` covers a perp twice, and when that ends: at the
 * first held maturity that leaves the perp covered once, or when the new leg
 * itself matures. `usd` picks the dollar figures over the coin ones, as the
 * market's collateral does for the size. Null when nothing is covered twice.
 */
export function doubledCover(
  o: BorosOverlap,
  open: number,
  usd: boolean,
  opensUntil: number,
): { size: number; until: number } | null {
  const room = usd ? o.room : o.roomBase;
  const legs = o.legs.map((l) => ({ size: usd ? l.size : l.sizeBase, maturity: l.maturity }));
  if (room === undefined || legs.some((l) => l.size === undefined) || !(open > 0)) return null;
  const held = legs.reduce((t, l) => t + (l.size as number), 0);
  const tiny = open * 1e-6;
  const size = Math.min(open - room, held);
  if (!(size > tiny)) return null;
  let matured = 0;
  let until = opensUntil;
  for (const l of [...legs].sort((a, b) => a.maturity - b.maturity)) {
    matured += l.size as number;
    if (open - room - matured <= tiny || matured >= held - tiny) {
      until = Math.min(l.maturity, opensUntil);
      break;
    }
  }
  return { size, until };
}
