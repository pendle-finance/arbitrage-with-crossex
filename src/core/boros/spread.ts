import type { BorosMarket } from './client';

export type SpreadSide = 'SHORT' | 'LONG';

export function parseSpreadVenues(isSpread: boolean, platformId: string): [string, string] | null {
  return isSpread && platformId === 'hyperliquid-gate' ? ['HYPERLIQUID', 'GATE'] : null;
}

export const isSpreadMarket = (m: Pick<BorosMarket, 'spreadVenues'>): boolean => Array.isArray(m.spreadVenues);

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
