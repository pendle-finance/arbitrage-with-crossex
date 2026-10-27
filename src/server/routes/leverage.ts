import { CoreError } from '../../core/errors';
import { getPositionLimits } from '../../core/orders';
import type { PositionLimit } from '../../core/positionLimit';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

export function requirePositionLimit(map: Map<string, PositionLimit | null>, symbol: string): PositionLimit {
  const limit = map.get(symbol);
  if (!limit) {
    throw new CoreError(`CrossEx returned no leverage limit for ${symbol} — nothing was sent; try again`, 'leverage');
  }
  return limit;
}

/** One symbol's max leverage and largest position, from the cached risk-limit tiers. */
export async function positionLimitFor(deps: AppDeps, symbol: string, fresh: boolean): Promise<PositionLimit> {
  const { value } = await deps.cache.get(
    `risk:${symbol}`,
    TTL.static,
    async () => requirePositionLimit(await getPositionLimits(deps.getClients().crossEx, [symbol]), symbol),
    { fresh },
  );
  return value;
}
