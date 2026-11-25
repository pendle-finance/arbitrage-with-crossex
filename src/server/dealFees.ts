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

const FEE_READ_DEADLINE_MS = 1_500;
const FEE_READ_RETRY_MS = 10_000;
const readFailedAt = new WeakMap<AppDeps, Map<string, number>>();

export async function feeReadWithin<T>(deps: AppDeps, read: { kind: string; work: () => Promise<T>; fallback: T }): Promise<T> {
  const failures = readFailedAt.get(deps) ?? new Map<string, number>();
  readFailedAt.set(deps, failures);
  const failedAt = failures.get(read.kind);
  if (failedAt !== undefined && Date.now() - failedAt < FEE_READ_RETRY_MS) return read.fallback;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('fee read timed out')), FEE_READ_DEADLINE_MS);
  });
  try {
    const work = read.work();
    work.catch(() => undefined);
    return await Promise.race([work, deadline]);
  } catch {
    failures.set(read.kind, Date.now());
    return read.fallback;
  } finally {
    clearTimeout(timer);
  }
}

export const feeRowsWithin = (deps: AppDeps): Promise<VenueFeeRow[]> =>
  feeReadWithin(deps, { kind: 'rows', work: () => accountFeeRowsOf(deps), fallback: [] as VenueFeeRow[] });
