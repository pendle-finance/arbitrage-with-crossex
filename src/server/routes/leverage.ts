import { CoreError } from '../../core/errors';
import { getLeverageMax } from '../../core/orders';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

export function requireLeverageMax(map: Map<string, number>, symbol: string): number {
  const max = map.get(symbol) ?? 0;
  if (!(max > 0)) {
    throw new CoreError(`CrossEx returned no leverage limit for ${symbol} — nothing was sent; try again`, 'leverage');
  }
  return max;
}

/** Max settable leverage for one symbol, from the cached risk-limit tiers. */
export async function leverageMaxFor(deps: AppDeps, symbol: string, fresh: boolean): Promise<number> {
  const { value } = await deps.cache.get(
    `risk:${symbol}`,
    TTL.static,
    async () => requireLeverageMax(await getLeverageMax(deps.getClients().crossEx, [symbol]), symbol),
    { fresh },
  );
  return value;
}
