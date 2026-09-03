/**
 * Ledger replay — the preview's EXACT numbers.
 *
 * Sends the book's enrollment events to the local server, which reconstructs
 * each window from the venues' own per-settlement records (Boros
 * settlement-events; the CrossEx funding ledger) and returns exact sums.
 * Recomputed per session from venue history — never persisted — so the same
 * setup yields the same numbers on any device: determinism by derivation.
 *
 * Windows are keyed by (leg, qty, t); the result for a window is immutable
 * except for its live end, so a long staleTime + the strategy feed's cadence
 * is plenty.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { postJson } from '../../api/client';
import { legRefKey } from '../partitionStore';
import type { LedgerBook } from './ledgerStore';
import type { PoolLeg, ReplayResult } from './model';

export function useReplay(
  address: string | null,
  book: LedgerBook,
  pool: Map<string, PoolLeg>,
): Map<string, ReplayResult> {
  // Only events whose leg the venues still report can be replayed to "now".
  const events = book.events
    .filter((e) => e.kind === 'enroll')
    .flatMap((e) => {
      if (e.kind !== 'enroll') return [];
      const p = pool.get(legRefKey(e.leg));
      if (!p) return [];
      return [
        e.leg.kind === 'perp'
          ? { id: e.id, kind: 'perp' as const, symbol: e.leg.symbol, qty: e.qty, venueQty: p.qty, t: e.t }
          : { id: e.id, kind: 'boros' as const, marketId: e.leg.marketId, qty: e.qty, venueQty: p.qty, t: e.t },
      ];
    });

  // Stable identity for the query key: what we ask determines what we get.
  const sig = events
    .map((e) => `${e.id}:${e.qty.toFixed(6)}:${e.t}`)
    .sort()
    .join('|');

  const q = useQuery({
    queryKey: ['boros-replay', address, sig],
    enabled: Boolean(address) && events.length > 0,
    // The windows' pasts are immutable; only the live end moves. Refresh on
    // the strategy feed's cadence.
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const body = await postJson<{ results: ReplayResult[] }>('/boros/replay', {
        address,
        accountId: 0,
        events,
      });
      return body.results;
    },
  });

  // Stable identity per response, or every deriveView memo downstream busts.
  const data = q.data;
  return useMemo(() => {
    const map = new Map<string, ReplayResult>();
    for (const r of data ?? []) map.set(r.id, r);
    return map;
  }, [data]);
}
