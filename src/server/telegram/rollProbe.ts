import type { AssetGroup } from '../../../web/src/api/types';
import { deriveAsset, pairRollDue, type PairEstimate } from '../../../web/src/panels/assets/assetModel';
import type { BorosMarket } from '../../core/boros/client';
import { readSpreadSide, type SpreadSide } from '../../core/boros/spread';
import { normalizeVenue } from '../../core/boros/venue';
import type { BorosPairSimulation } from '../../core/boros/pair';
import {
  MAX_ROLL_TARGETS,
  ROLL_OPPORTUNITY_SHARE,
  pairNetApr,
  pairRollGeometry,
  rollFigures,
  rollBatchTolerance,
  rollFitSize,
  rollOpportunities,
  rollQuoteIsFillable,
  rollTargetsFor,
  type RollTarget,
  seedSlippageApr,
  type RollProbeResult,
} from '../../core/boros/rollProbe';
import type { AssetViewOut, AssetViewParams } from '../routes/assetView';
import type { RollSignalInput } from './sync';

export interface PairSimulateBody {
  address: string;
  legs: { marketId: number; direction: 'long' | 'short'; slippageApr: number; size: number }[];
  intent: 'open' | 'close';
}

export type PairPricer = (
  body: PairSimulateBody,
  fresh: boolean,
) => Promise<{ simulation: BorosPairSimulation }>;

export interface RollProbeDeps {
  borosAddress: () => string | null;
  buildAssetView: (params: AssetViewParams) => Promise<AssetViewOut>;
  loadMarkets: (fresh: boolean) => Promise<BorosMarket[]>;
  price: PairPricer;
  now: () => number;
  log?: (message: string) => void;
}

function entryLegsOf(
  target: RollTarget,
  markets: ReadonlyArray<BorosMarket>,
  perpSides: Readonly<Record<string, SpreadSide>>,
): { marketId: number; direction: 'long' | 'short' }[] | null {
  if (!('spreadMarketId' in target)) {
    return [
      { marketId: target.longMarketId, direction: 'long' },
      { marketId: target.shortMarketId, direction: 'short' },
    ];
  }
  const venues = markets.find((m) => m.marketId === target.spreadMarketId)?.spreadVenues;
  const side = venues ? readSpreadSide(venues, perpSides) : null;
  return side === null ? null : [{ marketId: target.spreadMarketId, direction: side === 'LONG' ? 'long' : 'short' }];
}

export function createRollProbe(deps: RollProbeDeps): () => Promise<RollSignalInput[]> {
  const probePair = async (
    pair: PairEstimate,
    base: string,
    markets: BorosMarket[],
    nowSec: number,
  ): Promise<RollSignalInput['targets']> => {
    const { yuLegs, heldSize, pairPerpImUsd } = pairRollGeometry(pair);
    if (yuLegs.length === 0 || yuLegs.some((l) => l.marketId === undefined) || !(heldSize > 0)) return [];
    const heldIds = yuLegs.map((l) => l.marketId as number);
    const current = pairNetApr(pair, nowSec);
    if (current === null) return [];

    const targets = rollTargetsFor(markets, pair, base, pair.soonestMaturitySec).slice(0, MAX_ROLL_TARGETS);
    if (targets.length === 0) return [];
    const exitSlippageApr = seedSlippageApr(markets, heldIds);
    const address = deps.borosAddress();
    if (address === null) return [];
    const perpSides: Record<string, SpreadSide> = {
      [normalizeVenue(pair.longVenue)]: 'LONG',
      [normalizeVenue(pair.shortVenue)]: 'SHORT',
    };

    const probes: Record<number, RollProbeResult> = {};
    for (const target of targets) {
      const entryLegs = entryLegsOf(target, markets, perpSides);
      if (entryLegs === null) continue;
      const entrySlippageApr = seedSlippageApr(
        markets,
        entryLegs.map((l) => l.marketId),
      );
      const bodies = (
        size: number,
        exitSlip = exitSlippageApr,
        entrySlip = entrySlippageApr,
      ): { exit: PairSimulateBody; entry: PairSimulateBody } => ({
        exit: {
          address,
          legs: yuLegs.map((l) => ({
            marketId: l.marketId as number,
            direction: l.side === 'LONG' ? 'short' : 'long',
            slippageApr: exitSlip,
            size,
          })),
          intent: 'close',
        },
        entry: {
          address,
          legs: entryLegs.map((l) => ({ ...l, slippageApr: entrySlip, size })),
          intent: 'open',
        },
      });

      const fifth = bodies(heldSize * ROLL_OPPORTUNITY_SHARE);
      const [exitFifth, entryFifth] = await Promise.all([
        deps.price(fifth.exit, false),
        deps.price(fifth.entry, false),
      ]);
      const exitFifthLegs = exitFifth.simulation.legs;
      const entryFifthLegs = entryFifth.simulation.legs;
      assertBooksRead([...exitFifthLegs, ...entryFifthLegs]);
      const size = rollFitSize(exitFifthLegs, entryFifthLegs, heldSize);
      if (size === null) {
        probes[target.maturity] = { ok: false, rate: null, size: 0 };
        continue;
      }

      // At the tolerance the modal gives each batch for this size, so the
      // alert and the modal quote one request.
      const atSize = bodies(
        size,
        rollBatchTolerance(exitFifthLegs, size, exitSlippageApr),
        rollBatchTolerance(entryFifthLegs, size, entrySlippageApr),
      );
      const [exit, entry] = await Promise.all([deps.price(atSize.exit, false), deps.price(atSize.entry, false)]);
      const exitSim = exit.simulation;
      const entrySim = entry.simulation;
      assertBooksRead([...exitSim.legs, ...entrySim.legs]);
      const ok = rollQuoteIsFillable(exitSim, entrySim);
      const { netRate } = rollFigures({
        entrySim,
        exitSim,
        size,
        perpImUsd: pairPerpImUsd * (size / heldSize),
        maturity: target.maturity,
        heldLegs: yuLegs,
        nowSec,
      });
      probes[target.maturity] = { ok, rate: ok ? netRate : null, size };
    }

    return rollOpportunities(probes, targets, current, pair.soonestMaturitySec).map((o) => ({
      maturity: o.maturity,
      apr: o.rate,
      currentApr: o.current,
    }));
  };

  return async function probeRolls(): Promise<RollSignalInput[]> {
    const address = deps.borosAddress();
    if (address === null) return [];
    const nowMs = deps.now();
    const nowSec = Math.floor(nowMs / 1000);
    const [view, markets] = await Promise.all([
      deps.buildAssetView({ address, requestedSinceSec: null, legSince: new Map(), fresh: false }),
      deps.loadMarkets(false),
    ]);

    const signals: RollSignalInput[] = [];
    let logged = false;
    for (const group of view.assets) {
      const derived = deriveAsset(group as unknown as AssetGroup, {}, view.sinceSec, nowSec);
      for (const pair of derived.pairs) {
        if (!pairRollDue(pair, nowSec)) continue;
        const signal: RollSignalInput = {
          coin: group.base,
          longVenue: pair.longVenue,
          shortVenue: pair.shortVenue,
          maturity: pair.soonestMaturitySec,
          targets: [],
        };
        try {
          signal.targets = await probePair(pair, group.base, markets, nowSec);
        } catch (err) {
          // A pair that could not be priced (a Boros 429, a book that did
          // not load) is NOT a pair with nothing to roll into: it is marked
          // so the sync keeps the targets it last had for it, instead of
          // blanking a real opportunity for the next five minutes.
          signal.unpriced = true;
          if (!logged) {
            logged = true;
            const message = err instanceof Error ? err.message : String(err);
            (deps.log ?? console.warn)(`Roll probe skipped ${group.base}: ${message}`);
          }
        }
        signals.push(signal);
      }
    }
    return signals;
  };
}

/** A leg whose book did not load quotes as unfillable, which reads exactly
 * like "nothing to roll into". It is a failed read, so it is thrown. */
function assertBooksRead(legs: BorosPairSimulation['legs']): void {
  const dark = legs.find((l) => l.bookStatus === 'unavailable');
  if (dark) throw new Error(`${dark.marketName}: order book unavailable`);
}
