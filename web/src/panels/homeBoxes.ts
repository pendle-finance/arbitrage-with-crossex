/** Pure taxonomy for the home view: every position lands in exactly one box.
 *
 * - 'strategy'  — a server StrategyRollup. With the strategy feed live this is
 *                 EVERY position: the solver emits a card per coin, including
 *                 Boros-less pairs (`BASE#perps`) and unclaimed size
 *                 (`BASE#unhedged:SYMBOL`), so the leftover set is empty.
 * - 'perp-only' / 'stray' — the DEGRADED path only: exposure groups whose base
 *                 has no rollup. That happens when no address is tracked (the
 *                 strategy feed never runs) or the feed failed — the positions
 *                 feed still knows the perps exist, and a trading terminal must
 *                 not hide live positions behind a dead Boros backend.
 */
import type {
  ExposureGroup,
  PositionsResponse,
  StrategyReturns,
  StrategyRollup,
} from '../api/types';

export type HomeBox =
  | { kind: 'strategy'; rollup: StrategyRollup }
  | { kind: 'perp-only'; group: ExposureGroup }
  | { kind: 'stray'; group: ExposureGroup };

export function buildBoxes(
  strategy: StrategyReturns | undefined,
  positions: PositionsResponse | undefined,
): HomeBox[] {
  const rollups = strategy?.strategies ?? [];
  const rollupBases = new Set(rollups.map((r) => r.base.toUpperCase()));
  const leftovers = (positions?.exposure ?? []).filter(
    (g) => !rollupBases.has(g.base.toUpperCase()),
  );
  const byGross = (a: ExposureGroup, b: ExposureGroup) => b.grossValue - a.grossValue;
  return [
    // Server order (by notional) is kept for strategy boxes.
    ...rollups.map((rollup) => ({ kind: 'strategy' as const, rollup })),
    ...leftovers.filter((g) => !g.singleLeg).sort(byGross).map((group) => ({
      kind: 'perp-only' as const,
      group,
    })),
    ...leftovers.filter((g) => g.singleLeg).sort(byGross).map((group) => ({
      kind: 'stray' as const,
      group,
    })),
  ];
}
