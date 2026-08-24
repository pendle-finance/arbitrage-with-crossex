/** Pure taxonomy for the home view: every position lands in exactly one box.
 *
 * - 'strategy'  — a server StrategyRollup. With the strategy feed live this is
 *                 EVERY position: the solver emits a card per PAIR, including
 *                 Boros-less pairs and every leg no pair claimed
 *                 (`BASE#unhedged:SYMBOL`), so the leftover set is empty.
 *                 (Cards stay merged, and may hold more than one pair, when
 *                 the server could not reconcile the split — it says so in
 *                 the card's own warnings rather than guessing a grouping.)
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
  /**
   * Finished positions first, then the biggest.
   *
   * A complete book is the thing the user came to read: it has a locked rate,
   * a capital base and a projection, and it is what the strategy is FOR. Legs
   * still being assembled are work in progress, so they sort below however
   * large they are — server order was by notional alone, which floated a
   * half-built card above a finished one purely for being bigger.
   */
  const byCompleteness = (a: StrategyRollup, b: StrategyRollup) => {
    const done = (r: StrategyRollup) => (r.hedgeChecks.fullyHedged ? 0 : 1);
    return done(a) - done(b) || b.capitalUsd - a.capitalUsd;
  };
  return [
    ...[...rollups].sort(byCompleteness).map((rollup) => ({ kind: 'strategy' as const, rollup })),
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
