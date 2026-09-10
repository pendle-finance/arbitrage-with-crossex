import { getLeverageMax } from '../../core/orders';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

/** Max settable leverage for one symbol, from the cached risk-limit tiers. */
export async function leverageMaxFor(deps: AppDeps, symbol: string, fresh: boolean): Promise<number> {
  const { value } = await deps.cache.get(
    `risk:${symbol}`,
    TTL.static,
    async () => (await getLeverageMax(deps.getClients().crossEx, [symbol])).get(symbol) ?? 0,
    { fresh },
  );
  return value;
}
