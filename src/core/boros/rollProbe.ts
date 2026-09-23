import { defaultChargePerpFees, entryAprOf } from '../../../web/src/panels/assets/assetModel';
import { fitAtBand, planBatch, suggestedRollSize } from '../../../web/src/panels/assets/rollSizing';
import type { BorosMarket } from './client';
import type { BorosPairSimulation, SimulatedLeg } from './pair';

const SECONDS_IN_YEAR = 365 * 24 * 3600;
const EPS = 1e-9;

export const ROLL_OPPORTUNITY_SHARE = 0.2;
export const ROLL_MAX_SLIP_APR = 0.1;
export const ROLL_FALLBACK_SLIP_APR = 0.01;
export const MAX_ROLL_TARGETS = 8;

export interface RollTarget {
  maturity: number;
  longMarketId: number;
  shortMarketId: number;
}

export interface RollLegDetail {
  venue: string;
  kind: 'perp' | 'yu';
  side: 'LONG' | 'SHORT';
  sizeToken: number;
  lockedApr: number | null;
  maturity: number;
  marketId?: number;
  imUsd: number;
}

export interface RollPairFacts {
  longVenue: string;
  shortVenue: string;
  capitalUsd: number;
  lockedAprFwd: number | null;
  exitFeeUsd: number;
  hedgedSinceSec: number | null;
  perpOpenedSec: number | null;
  borosOpenedSec: number | null;
  soonestMaturitySec: number;
  legs: RollLegDetail[];
  perpFeesPaidUsd: number;
  borosFeesPaidUsd: number;
}

export interface RollProbeResult {
  ok: boolean;
  rate: number | null;
  size: number;
}

export interface RollOpportunity {
  maturity: number;
  rate: number;
  current: number;
  currentMaturity: number;
  size: number;
}

function floorTo1Sf(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(x));
  return Number((Math.floor(x / step) * step).toPrecision(12));
}

export function seedSlippageApr(markets: ReadonlyArray<BorosMarket>, ids: ReadonlyArray<number>): number {
  const caps = ids
    .map((id) => markets.find((m) => m.marketId === id)?.maxRateDeviationApr)
    .filter((c): c is number => typeof c === 'number' && c > 0);
  if (caps.length === 0) return ROLL_FALLBACK_SLIP_APR;
  const meanHalf = caps.reduce((sum, c) => sum + c / 2, 0) / caps.length;
  const pctVal = floorTo1Sf(meanHalf * 100);
  return pctVal > 0 ? pctVal / 100 : ROLL_FALLBACK_SLIP_APR;
}

export function rollTargetsFor(
  markets: ReadonlyArray<BorosMarket>,
  pair: Pick<RollPairFacts, 'longVenue' | 'shortVenue'>,
  base: string,
  after: number,
): RollTarget[] {
  const sameVenue = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const byMaturity = new Map<number, { long?: number; short?: number }>();
  for (const m of markets) {
    if (m.maturity <= after) continue;
    if (m.state !== 'Normal') continue;
    if (m.base.toLowerCase() !== base.toLowerCase()) continue;
    const slot = byMaturity.get(m.maturity) ?? {};
    if (sameVenue(m.venue, pair.longVenue)) slot.long = m.marketId;
    if (sameVenue(m.venue, pair.shortVenue)) slot.short = m.marketId;
    byMaturity.set(m.maturity, slot);
  }
  return [...byMaturity.entries()]
    .filter(([, v]) => v.long !== undefined && v.short !== undefined)
    .map(([maturity, v]) => ({ maturity, longMarketId: v.long as number, shortMarketId: v.short as number }))
    .sort((a, b) => a.maturity - b.maturity);
}

export function pairRollGeometry(pair: Pick<RollPairFacts, 'legs'>): {
  yuLegs: RollLegDetail[];
  heldSize: number;
  pairPerpImUsd: number;
} {
  const yuLegs = pair.legs.filter((l) => l.kind === 'yu');
  const perpLegs = pair.legs.filter((l) => l.kind === 'perp');
  return {
    yuLegs,
    heldSize: yuLegs.length > 0 ? Math.min(...yuLegs.map((l) => l.sizeToken)) : 0,
    pairPerpImUsd: perpLegs.reduce((total, l) => total + l.imUsd, 0),
  };
}

export function pairNetApr(pair: RollPairFacts, nowSec: number): number | null {
  const soonest = pair.soonestMaturitySec;
  const termYears = soonest > 0 ? (soonest - (pair.hedgedSinceSec ?? nowSec)) / SECONDS_IN_YEAR : 0;
  const perYearUsd = pair.lockedAprFwd !== null ? pair.lockedAprFwd * pair.capitalUsd : null;
  const carryUsd = perYearUsd !== null && termYears > 0 ? perYearUsd * termYears : null;
  const chargedUsd = pair.borosFeesPaidUsd + (defaultChargePerpFees(pair) ? pair.perpFeesPaidUsd : 0);
  const netUsd = carryUsd === null ? null : carryUsd - chargedUsd;
  return netUsd !== null && termYears > 0 && pair.capitalUsd > 0
    ? netUsd / pair.capitalUsd / termYears
    : null;
}

export function addedMarginOf(sim: BorosPairSimulation | null | undefined): number | null {
  if (!sim) return null;
  let total = 0;
  for (const leg of [sim.legA, sim.legB]) {
    if (leg.marginRequired === null) return null;
    const result = Math.abs(leg.sizing.resultingSize);
    const delta = Math.abs(leg.sizing.deltaSize);
    if (!(delta > 0)) continue;
    total += result > 0 ? leg.marginRequired * Math.min(1, delta / result) : leg.marginRequired;
  }
  return total;
}

export function exitPnlOf(
  sim: BorosPairSimulation | null | undefined,
  legA: RollLegDetail | undefined,
  legB: RollLegDetail | undefined,
  nowSec: number,
): number | null {
  const one = (s: SimulatedLeg | undefined, l: RollLegDetail | undefined): number | null | undefined => {
    if (!s || !l || l.lockedApr === null) return undefined;
    const locked = entryAprOf(l.side, l.lockedApr);
    const years = Math.max(0, l.maturity - nowSec) / SECONDS_IN_YEAR;
    const rate = s.execApr;
    return rate !== null ? (l.side === 'LONG' ? rate - locked : locked - rate) * s.estFillSize * years : null;
  };
  const legs = [one(sim?.legA, legA), one(sim?.legB, legB)].filter(
    (x): x is number | null => x !== undefined,
  );
  if (legs.length === 0 || legs.some((x) => x === null)) return null;
  return legs.reduce((a: number, x) => a + (x ?? 0), 0);
}

export interface RollFigures {
  netRate: number | null;
  spreadApr: number | null;
  totalCostUsd: number | null;
  exitPnlUsd: number | null;
  capitalUsd: number | null;
  newBorosImUsd: number | null;
}

export function rollFigures({
  entrySim,
  exitSim,
  size,
  perpImUsd,
  maturity,
  longLeg,
  shortLeg,
  nowSec,
}: {
  entrySim: BorosPairSimulation | undefined;
  exitSim: BorosPairSimulation | undefined;
  size: number;
  perpImUsd: number;
  maturity: number;
  longLeg: RollLegDetail | undefined;
  shortLeg: RollLegDetail | undefined;
  nowSec: number;
}): RollFigures {
  const termYears = Math.max(0, maturity - nowSec) / SECONDS_IN_YEAR;
  const px = entrySim?.collateralPriceUsd ?? exitSim?.collateralPriceUsd ?? null;
  const usdOf = (tokens: number | null | undefined): number | null =>
    tokens === null || tokens === undefined || px === null || !(px > 0) ? null : tokens * px;

  const newBorosImUsd = usdOf(addedMarginOf(entrySim));
  const capitalUsd = newBorosImUsd !== null ? perpImUsd + newBorosImUsd : null;
  const exitCostUsd = usdOf(exitSim?.costToCrossSize);
  const entryCostUsd = usdOf(entrySim?.costToCrossSize);
  const exitPnlUsd = usdOf(exitPnlOf(exitSim, longLeg, shortLeg, nowSec));
  const totalCostUsd = exitCostUsd !== null && entryCostUsd !== null ? exitCostUsd + entryCostUsd : null;
  const dragApr =
    totalCostUsd !== null && capitalUsd !== null && capitalUsd > 0 && termYears > 0
      ? totalCostUsd / capitalUsd / termYears
      : null;
  const rolledNotionalUsd = usdOf(size) ?? 0;
  const spreadApr = entrySim?.estSpreadApr ?? null;
  const carryPerYearUsd = spreadApr !== null && rolledNotionalUsd > 0 ? spreadApr * rolledNotionalUsd : null;
  const rateOnCapital =
    carryPerYearUsd !== null && capitalUsd !== null && capitalUsd > 0 ? carryPerYearUsd / capitalUsd : null;
  const exitPnlApr =
    exitPnlUsd !== null && capitalUsd !== null && capitalUsd > 0 && termYears > 0
      ? exitPnlUsd / capitalUsd / termYears
      : null;
  const netRate =
    rateOnCapital !== null && dragApr !== null && exitPnlApr !== null
      ? rateOnCapital - dragApr + exitPnlApr
      : rateOnCapital;
  return { netRate, spreadApr, totalCostUsd, exitPnlUsd, capitalUsd, newBorosImUsd };
}

/**
 * The size the roll modal DEFAULTS to — what the books take at the widest
 * tolerance each batch may carry (`fitAtBand`), less the buffer, capped at the
 * position — or null when that is under a fifth of the position: no
 * meaningful slice rolls, so no opportunity. One function with the modal's,
 * so the alert quotes the size the modal opens on.
 */
export function rollFitSize(
  exitLegs: ReadonlyArray<SimulatedLeg>,
  entryLegs: ReadonlyArray<SimulatedLeg>,
  heldSize: number,
): number | null {
  if (exitLegs.length + entryLegs.length !== 4) return null;
  const fit = fitAtBand(exitLegs, entryLegs, ROLL_MAX_SLIP_APR) ?? Infinity;
  const size = suggestedRollSize(fit, heldSize);
  return size >= heldSize * ROLL_OPPORTUNITY_SHARE - EPS ? size : null;
}

/** The tolerance the modal gives one batch for `size` (`planBatch`), the seed
 * when the ladders are missing — so the alert's quote is the modal's. */
export function rollBatchTolerance(legs: ReadonlyArray<SimulatedLeg>, size: number, seedApr: number): number {
  return planBatch(legs, size, seedApr, ROLL_MAX_SLIP_APR)?.toleranceApr ?? seedApr;
}

export function rollQuoteIsFillable(
  exitSim: BorosPairSimulation | undefined,
  entrySim: BorosPairSimulation | undefined,
): boolean {
  const legs = [exitSim, entrySim].flatMap((x) => (x ? [x.legA, x.legB] : []));
  return (
    legs.length === 4 &&
    entrySim?.receiveLeg !== null &&
    legs.every((l) => l.bookStatus === 'ok' && !l.slippageExceeded && !(l.shortfallSize > 0))
  );
}

export function rollOpportunities(
  probes: Record<number, RollProbeResult>,
  targets: ReadonlyArray<RollTarget>,
  current: number | null,
  currentMaturity: number,
): RollOpportunity[] {
  if (current === null) return [];
  const found: RollOpportunity[] = [];
  for (const t of targets) {
    const r = probes[t.maturity];
    if (!r || !r.ok || r.rate === null || !(r.rate > current)) continue;
    found.push({ maturity: t.maturity, rate: r.rate, current, currentMaturity, size: r.size });
  }
  return found.sort((a, b) => b.rate - a.rate);
}
