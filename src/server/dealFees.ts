import type { VenueFeeRow } from '../core/estimate/fees';
import type { AppDeps } from './app';
import { TTL } from './cache';
import type { TradePage } from './routes/rebalance';

export const accountFeeRowsOf = (deps: AppDeps): Promise<VenueFeeRow[]> =>
  deps.cache
    .get('fees', TTL.static, async () => (await deps.getClients().crossEx.getCrossexFee()).body)
    .then(
      ({ value }) => value,
      () => [],
    );

export const cachedTradesOf =
  (deps: AppDeps): TradePage =>
  async (query) =>
    (
      await deps.cache.get(`twap:trades:${query.from}:${query.page}:${query.limit}`, TTL.trades, async () =>
        (await deps.getClients().crossEx.listCrossexHistoryTrades(query)).body,
      )
    ).value;
