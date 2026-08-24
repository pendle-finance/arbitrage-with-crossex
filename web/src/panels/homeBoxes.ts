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
  StrategyLeg,
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

/**
 * An ExposureGroup rendered as a StrategyRollup, so the degraded path can use
 * the SAME card as everything else.
 *
 * A position should not change visual language because of what the Boros feed
 * could tell us about it. Everything here comes from the positions feed — the
 * perp legs, their sides, their notionals — and every field the strategy
 * solver would have computed is left at the value that means "not known":
 * no Boros legs, no maturity, no capital, no projection.
 *
 * ⚠ The card must NOT then claim the Boros legs are MISSING. With no address
 * tracked we have not looked, and "no Boros legs yet" is a statement about the
 * user's book that we are in no position to make — see `borosUnknown` on
 * StrategyCard, which is what this pairs with.
 *
 * Perp-only numbers stay honest: uPnL and funding are per-leg facts the perp
 * feed knows, so they show. The rate/capital/ROI block does not, because
 * `fullyHedged: false` gates it — the same gate a half-built tracked position
 * passes through.
 */
export function rollupFromExposure(group: ExposureGroup): StrategyRollup {
  const legs: StrategyLeg[] = group.legs.map((l) => ({
    kind: 'perp' as const,
    venue: l.exchange,
    base: group.base,
    side: l.side,
    notionalUsd: l.value,
    notionalToken: l.qty,
    symbol: l.symbol,
    cashFlowUsd: 0,
    mtmUsd: 0,
    tradePnlUsd: 0,
    feesUsd: 0,
    netUsd: 0,
    openedAt: null,
    warnings: [],
  }));
  return {
    // Distinct from every server id (`BASE#perps`, `BASE@maturity`) so a
    // membership pin can never be filed against a card that only exists
    // because the feed is down.
    strategyId: `${group.base}#untracked`,
    attribution: { source: 'unhedged', confidence: 'measured', pinned: false },
    base: group.base,
    // 0 is the "no Boros legs, so no maturity" sentinel the cards already read.
    maturity: 0,
    legs,
    hedge: 'unhedged',
    hedgeChecks: {
      borosMatchRatio: 0,
      perpMatchRatio: 1,
      borosVsPerpRatio: 0,
      fullyHedged: false,
    },
    capitalUsd: 0,
    capitalSplit: { perpUsd: 0, borosUsd: 0 },
    realizedPnlUsd: 0,
    realizedApr: null,
    spread: 0,
    lockedAprOnCapital: 0,
    spreadReturnUsd: null,
    expectedPnlToMaturityUsd: null,
    elapsedSeconds: null,
    clockBasis: null,
    clockStartSec: null,
    secondsToMaturity: 0,
    notionalMismatchUsd: Math.abs(group.netValue),
    perpEntryCostParts: [],
    feesUsd: {
      paid: {
        perpTradingUsd: 0,
        perpEntrySlippageUsd: null,
        borosTradeUsd: 0,
        borosSettlementUsd: 0,
        totalUsd: 0,
      },
      future: {
        perpExitFeesUsd: 0,
        perpExitSlippageUsd: null,
        borosSettlementUsd: 0,
        totalUsd: 0,
      },
    },
    warnings: [],
  };
}
