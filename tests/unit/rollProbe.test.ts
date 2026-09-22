import { describe, expect, it } from 'vitest';
import type { BorosPairSimulation, SimulatedLeg } from '../../src/core/boros/pair';
import {
  ROLL_OPPORTUNITY_SHARE,
  rollFigures,
  rollFitSize,
  rollOpportunities,
  rollTargetsFor,
  type RollProbeResult,
  type RollTarget,
} from '../../src/core/boros/rollProbe';
import type { BorosMarket } from '../../src/core/boros/client';

const NOW = 1_760_000_000;
const YEAR = 365 * 24 * 3600;

const leg = (over: Partial<SimulatedLeg> = {}): SimulatedLeg => ({
  marketId: 1,
  marketName: 'Gate ETH 30 Oct 2026',
  venue: 'Gate',
  base: 'ETH',
  direction: 'long',
  execApr: 0.1,
  midApr: 0.1,
  estSlippageApr: 0,
  worstApr: 0.1,
  slippageExceeded: false,
  sizeWithinTolerance: 1_000,
  depth: [[0.001, 1_000]],
  maxToleranceApr: 0.05,
  estFillSize: 100,
  shortfallSize: 0,
  bookStatus: 'ok',
  marginRequired: 25,
  liquidationApr: null,
  slippageApr: 0.01,
  sizing: {
    currentSize: 0,
    deltaSize: 100,
    resultingSize: 100,
    opposing: false,
    flips: false,
    clampedToClose: false,
    orderSide: 'long',
  },
  takerFeeCost: 0,
  ...over,
});

const sim = (over: Partial<BorosPairSimulation> = {}): BorosPairSimulation => ({
  legA: leg(),
  legB: leg({ marketId: 2, direction: 'short' }),
  receiveLeg: 'B',
  estSpreadApr: 0.09,
  worstSpreadApr: 0.08,
  costToCrossSize: 0,
  feeDragApr: 0,
  takerDragApr: 0,
  intent: 'open',
  midSpreadApr: 0.09,
  slippageApr: 0,
  marginRequiredTotal: 50,
  hedgedSize: 100,
  unhedgedSize: 0,
  collateral: 'USDT',
  collateralPriceUsd: 1,
  secondsToMaturity: YEAR / 2,
  reasons: [],
  ...over,
});

const market = (over: Partial<BorosMarket> & Pick<BorosMarket, 'marketId' | 'venue' | 'maturity'>): BorosMarket =>
  ({
    base: 'ETH',
    state: 'Normal',
    maxRateDeviationApr: 0.04,
    ...over,
  }) as BorosMarket;

describe('roll candidates', () => {
  it('lists only later maturities both venues list, soonest first', () => {
    const markets = [
      market({ marketId: 1, venue: 'Gate', maturity: NOW + 30 * 86_400 }),
      market({ marketId: 2, venue: 'Hyperliquid', maturity: NOW + 30 * 86_400 }),
      market({ marketId: 3, venue: 'Gate', maturity: NOW + 60 * 86_400 }),
      market({ marketId: 4, venue: 'Hyperliquid', maturity: NOW + 60 * 86_400 }),
      market({ marketId: 5, venue: 'Gate', maturity: NOW + 90 * 86_400 }),
      market({ marketId: 6, venue: 'Gate', maturity: NOW - 86_400 }),
      market({ marketId: 7, venue: 'Hyperliquid', maturity: NOW - 86_400 }),
    ];
    const targets = rollTargetsFor(markets, { longVenue: 'GATE', shortVenue: 'HYPERLIQUID' }, 'eth', NOW);
    expect(targets).toEqual([
      { maturity: NOW + 30 * 86_400, longMarketId: 1, shortMarketId: 2 },
      { maturity: NOW + 60 * 86_400, longMarketId: 3, shortMarketId: 4 },
    ]);
  });

  it('drops a market that is not tradable', () => {
    const markets = [
      market({ marketId: 1, venue: 'Gate', maturity: NOW + 30 * 86_400, state: 'CloseOnly' }),
      market({ marketId: 2, venue: 'Hyperliquid', maturity: NOW + 30 * 86_400 }),
    ];
    expect(rollTargetsFor(markets, { longVenue: 'Gate', shortVenue: 'Hyperliquid' }, 'ETH', NOW)).toEqual([]);
  });
});

describe('the two-stage sizing', () => {
  const held = 100;
  const fifth = held * ROLL_OPPORTUNITY_SHARE;
  const ladder = (cum: number): SimulatedLeg => leg({ depth: [[0.001, cum]], maxToleranceApr: 0.05 });

  it('is no opportunity when the books take less than a fifth', () => {
    const exit = [ladder(fifth), ladder(1_000)];
    const entry = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(exit, entry, 0.01, 0.01, held)).toBeNull();
  });

  it('suggests the capacity less the buffer once a fifth fits', () => {
    const exit = [ladder(25), ladder(1_000)];
    const entry = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(exit, entry, 0.01, 0.01, held)).toBeCloseTo(23.75, 9);
  });

  it('never suggests more than the position', () => {
    const legs = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(legs, legs, 0.01, 0.01, held)).toBe(held);
  });
});

describe('the roll rate', () => {
  it('is carry on capital, less the round trip, plus what the exit realises', () => {
    const entrySim = sim({
      estSpreadApr: 0.09,
      costToCrossSize: 4,
      legA: leg({ marginRequired: 20 }),
      legB: leg({ marginRequired: 30 }),
    });
    const exitSim = sim({
      intent: 'close',
      costToCrossSize: 2,
      legA: leg({ execApr: 0.14, estFillSize: 100 }),
      legB: leg({ execApr: 0.12, estFillSize: 100 }),
    });
    const held = {
      kind: 'yu' as const,
      sizeToken: 100,
      imUsd: 0,
      maturity: NOW + YEAR / 4,
    };
    const figures = rollFigures({
      entrySim,
      exitSim,
      size: 100,
      perpImUsd: 10,
      maturity: NOW + YEAR / 2,
      longLeg: { ...held, venue: 'Gate', side: 'LONG', lockedApr: -0.1 },
      shortLeg: { ...held, venue: 'Hyperliquid', side: 'SHORT', lockedApr: 0.2 },
      nowSec: NOW,
    });
    expect(figures.newBorosImUsd).toBeCloseTo(50, 9);
    expect(figures.capitalUsd).toBeCloseTo(60, 9);
    expect(figures.totalCostUsd).toBeCloseTo(6, 9);
    expect(figures.exitPnlUsd).toBeCloseTo(3, 9);
    expect(figures.netRate).toBeCloseTo(0.05, 9);
  });

  it('is quoted per $6,000,000 exactly as per $50', () => {
    const at = (scale: number): number | null =>
      rollFigures({
        entrySim: sim({
          estSpreadApr: 0.09,
          costToCrossSize: 4 * scale,
          legA: leg({ marginRequired: 20 * scale, sizing: { ...leg().sizing, deltaSize: 100 * scale, resultingSize: 100 * scale } }),
          legB: leg({ marginRequired: 30 * scale, sizing: { ...leg().sizing, deltaSize: 100 * scale, resultingSize: 100 * scale } }),
        }),
        exitSim: sim({ intent: 'close', costToCrossSize: 2 * scale, legA: leg({ execApr: 0.14, estFillSize: 100 * scale }), legB: leg({ execApr: 0.12, estFillSize: 100 * scale }) }),
        size: 100 * scale,
        perpImUsd: 10 * scale,
        maturity: NOW + YEAR / 2,
        longLeg: { kind: 'yu', venue: 'Gate', side: 'LONG', sizeToken: 100 * scale, imUsd: 0, lockedApr: -0.1, maturity: NOW + YEAR / 4 },
        shortLeg: { kind: 'yu', venue: 'Hyperliquid', side: 'SHORT', sizeToken: 100 * scale, imUsd: 0, lockedApr: 0.2, maturity: NOW + YEAR / 4 },
        nowSec: NOW,
      }).netRate;
    expect(at(0.5)).toBeCloseTo(0.05, 9);
    expect(at(60_000)).toBeCloseTo(0.05, 9);
  });
});

describe('which maturities are offered', () => {
  const targets: RollTarget[] = [
    { maturity: NOW + 30 * 86_400, longMarketId: 1, shortMarketId: 2 },
    { maturity: NOW + 60 * 86_400, longMarketId: 3, shortMarketId: 4 },
    { maturity: NOW + 90 * 86_400, longMarketId: 5, shortMarketId: 6 },
  ];
  const probe = (rate: number | null, ok = true): RollProbeResult => ({ ok, rate, size: 20 });

  it('keeps the ones that beat today, best first', () => {
    const probes: Record<number, RollProbeResult> = {
      [targets[0].maturity]: probe(0.12),
      [targets[1].maturity]: probe(0.2),
      [targets[2].maturity]: probe(0.15),
    };
    expect(rollOpportunities(probes, targets, 0.1, NOW + 5 * 86_400).map((o) => o.rate)).toEqual([0.2, 0.15, 0.12]);
  });

  it('drops a maturity that does not beat today, and one that cannot fill', () => {
    const probes: Record<number, RollProbeResult> = {
      [targets[0].maturity]: probe(0.09),
      [targets[1].maturity]: probe(0.3, false),
      [targets[2].maturity]: probe(0.11),
    };
    const kept = rollOpportunities(probes, targets, 0.1, NOW + 5 * 86_400);
    expect(kept.map((o) => o.maturity)).toEqual([targets[2].maturity]);
    expect(kept[0].current).toBe(0.1);
  });

  it('offers nothing when the rate the pair earns now is unknown', () => {
    expect(rollOpportunities({ [targets[0].maturity]: probe(0.5) }, targets, null, NOW)).toEqual([]);
  });
});
