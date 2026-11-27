import { ROLL_OPPORTUNITY_SHARE, fitAtBand, planBatch, suggestedRollSize } from '../../../web/src/panels/assets/rollSizing';
import { sigFigsDirectional } from '../numbers';
import type { BorosMarket } from './client';
import type { BorosPairSimulation, SimulatedLeg } from './pair';
import { findSpread, isSpreadMarket } from './spread';
import { normalizeVenue } from './venue';

const EPS = 1e-9;

export const ROLL_MAX_SLIP_APR = 0.1;
export const ROLL_FALLBACK_SLIP_APR = 0.01;
export const MAX_ROLL_TARGETS = 8;

export type RollTarget =
  | { maturity: number; spreadMarketId: number }
  | { maturity: number; longMarketId: number; shortMarketId: number };

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

export function halfCapSeedPct(caps: ReadonlyArray<number>): number | null {
  const valid = caps.filter((c) => Number.isFinite(c) && c > 0);
  if (valid.length === 0) return null;
  const meanHalf = valid.reduce((sum, c) => sum + c / 2, 0) / valid.length;
  const pct = sigFigsDirectional(meanHalf * 100, 1, 'down');
  return pct > 0 ? pct : null;
}

export function seedSlippageApr(markets: ReadonlyArray<BorosMarket>, ids: ReadonlyArray<number>): number {
  const pct = halfCapSeedPct(ids.map((id) => markets.find((m) => m.marketId === id)?.maxRateDeviationApr ?? 0));
  return pct === null ? ROLL_FALLBACK_SLIP_APR : pct / 100;
}

export function rollTargetsFor(
  markets: ReadonlyArray<BorosMarket>,
  pair: Pick<RollPairFacts, 'longVenue' | 'shortVenue' | 'legs'>,
  base: string,
  after: number,
): RollTarget[] {
  const sameVenue = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const venues = [normalizeVenue(pair.longVenue), normalizeVenue(pair.shortVenue)] as const;
  const later = markets.filter((m) => m.maturity > after && m.base.toLowerCase() === base.toLowerCase());
  const heldIds = new Set(pair.legs.filter((l) => l.kind === 'yu').map((l) => l.marketId));
  const tokenId = markets.find((m) => heldIds.has(m.marketId))?.tokenId;
  const targets: RollTarget[] = [];
  for (const maturity of [...new Set(later.map((m) => m.maturity))].sort((a, b) => a - b)) {
    // Only a trading spread takes the roll (findSpread wants Normal). A
    // close-only or paused one counts as no spread: the singles stand.
    const spread = tokenId !== undefined ? findSpread({ markets: later, venues, maturity, tokenId, base }) : null;
    if (spread) {
      targets.push({ maturity, spreadMarketId: spread.marketId });
      continue;
    }
    // The held coin's markets only: Hyperliquid BTC lists a BTC and a USDT
    // market at one maturity, and a roll cannot change collateral.
    const singles = later.filter(
      (m) =>
        m.maturity === maturity &&
        m.state === 'Normal' &&
        !isSpreadMarket(m) &&
        (tokenId === undefined || m.tokenId === tokenId),
    );
    const long = singles.find((m) => sameVenue(m.venue, pair.longVenue));
    const short = singles.find((m) => sameVenue(m.venue, pair.shortVenue));
    if (long && short) targets.push({ maturity, longMarketId: long.marketId, shortMarketId: short.marketId });
  }
  return targets;
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
  if (exitLegs.length === 0 || entryLegs.length === 0) return null;
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
  if (!exitSim || !entrySim || exitSim.legs.length === 0 || entrySim.legs.length === 0) return false;
  if (entrySim.legs.length === 2 && entrySim.receiveLeg === null) return false;
  return [...exitSim.legs, ...entrySim.legs].every(
    (l) => l.bookStatus === 'ok' && !l.slippageExceeded && !l.bandExceeded && !(l.shortfallSize > 0),
  );
}
