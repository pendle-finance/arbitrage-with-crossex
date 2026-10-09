import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BorosPairSimulation, SimulatedLeg } from '../../src/core/boros/pair';
import {
  ROLL_OPPORTUNITY_SHARE,
  exitPnlOf,
  rollFigures,
  rollFitSize,
  rollOpportunities,
  rollTargetsFor,
  type RollProbeResult,
  type RollTarget,
} from '../../src/core/boros/rollProbe';
import { fetchBorosMarkets, type BorosMarket, type FetchLike } from '../../src/core/boros/client';

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
  legs: [leg(), leg({ marketId: 2, direction: 'short' })],
  receiveLeg: 1,
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
    const targets = rollTargetsFor(markets, { longVenue: 'GATE', shortVenue: 'HYPERLIQUID', legs: [] }, 'eth', NOW);
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
    expect(rollTargetsFor(markets, { longVenue: 'Gate', shortVenue: 'Hyperliquid', legs: [] }, 'ETH', NOW)).toEqual([]);
  });
});

describe('roll candidates on the staging spread markets', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
  ) as { results: unknown[] };
  const OCT_30 = 1793318400;
  const NOV_27 = 1795737600;
  const DEC_25 = 1798156800;
  const held = (marketId: number) => ({
    kind: 'yu' as const,
    venue: 'Hyperliquid',
    side: 'SHORT' as const,
    sizeToken: 1,
    lockedApr: 0.05,
    maturity: OCT_30,
    marketId,
    imUsd: 0,
  });
  const ownerPair = { longVenue: 'Gate', shortVenue: 'Hyperliquid', legs: [held(61), held(62)] };
  const load = (): Promise<BorosMarket[]> =>
    fetchBorosMarkets((async () => ({ ok: true, status: 200, json: async () => fixture })) as unknown as FetchLike);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 8));
  });
  afterEach(() => vi.useRealTimers());

  it('target prefers the spread', async () => {
    const markets = await load();
    expect(markets.filter((m) => m.maturity === NOV_27 && m.base === 'ETH').map((m) => m.marketId).sort()).toEqual([51, 59, 60]);
    expect(rollTargetsFor(markets, ownerPair, 'ETH', OCT_30)).toEqual([
      { maturity: NOV_27, spreadMarketId: 59 },
      { maturity: DEC_25, longMarketId: 65, shortMarketId: 64 },
    ]);
  });

  it('offers a spread held at 30 Oct the next spread', async () => {
    const markets = await load();
    const spreadPair = { ...ownerPair, legs: [held(63)] };
    expect(rollTargetsFor(markets, spreadPair, 'ETH', OCT_30)[0]).toEqual({ maturity: NOV_27, spreadMarketId: 59 });
  });

  it('skips a maturity whose spread is not trading, with no fall back to the singles', async () => {
    const markets = (await load()).map((m) => (m.marketId === 59 ? { ...m, state: 'Paused' as BorosMarket['state'] } : m));
    expect(rollTargetsFor(markets, ownerPair, 'ETH', OCT_30)).toEqual([{ maturity: DEC_25, longMarketId: 65, shortMarketId: 64 }]);
  });
});

describe('the two-stage sizing', () => {
  const held = 100;
  const fifth = held * ROLL_OPPORTUNITY_SHARE;
  const ladder = (cum: number): SimulatedLeg => leg({ depth: [[0.001, cum]], maxToleranceApr: 0.05 });

  it('is no opportunity when the books take less than a fifth', () => {
    const exit = [ladder(fifth), ladder(1_000)];
    const entry = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(exit, entry, held)).toBeNull();
  });

  it('suggests the capacity less the buffer once a fifth fits', () => {
    const exit = [ladder(25), ladder(1_000)];
    const entry = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(exit, entry, held)).toBeCloseTo(23.75, 9);
  });

  it('sizes at the band, so a stray level inside the seed does not zero the opportunity', () => {
    // 0.01 at 0.4%, then 1,000 at 1.1%: past a 1% seed, inside the 5% band.
    const stray = leg({ depth: [[0.004, 0.01], [0.011, 1_000]], maxToleranceApr: 0.05 });
    const exit = [stray, ladder(1_000)];
    const entry = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(exit, entry, held)).toBe(held);
  });

  it('never suggests more than the position', () => {
    const legs = [ladder(1_000), ladder(1_000)];
    expect(rollFitSize(legs, legs, held)).toBe(held);
  });
});

describe('the roll rate', () => {
  it('is carry on capital, less the round trip, plus what the exit realises', () => {
    const entrySim = sim({
      estSpreadApr: 0.09,
      costToCrossSize: 4,
      legs: [leg({ marginRequired: 20 }), leg({ marginRequired: 30 })],
    });
    const exitSim = sim({
      intent: 'close',
      costToCrossSize: 2,
      legs: [leg({ execApr: 0.14, estFillSize: 100 }), leg({ execApr: 0.12, estFillSize: 100 })],
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
      heldLegs: [
        { ...held, venue: 'Gate', side: 'LONG', lockedApr: -0.1 },
        { ...held, venue: 'Hyperliquid', side: 'SHORT', lockedApr: 0.2 },
      ],
      nowSec: NOW,
    });
    expect(figures.newBorosImUsd).toBeCloseTo(50, 9);
    expect(figures.capitalUsd).toBeCloseTo(60, 9);
    expect(figures.totalCostUsd).toBeCloseTo(6, 9);
    expect(figures.exitPnlUsd).toBeCloseTo(3, 9);
    expect(figures.netRate).toBeCloseTo(0.05, 9);
  });

  it('prices the exit of a leg entered at a NEGATIVE rate against that rate, not its magnitude', () => {
    // lockedApr is signed by side: a LONG entered at −5% stores +0.05. The
    // old `Math.abs` read that as an entry at +5%, so closing at −3% showed
    // a loss of 8% × size × years where the truth is a gain of 2%.
    const held = { kind: 'yu' as const, sizeToken: 1_000, imUsd: 0, maturity: NOW + YEAR };
    const exitSim = sim({ intent: 'close', legs: [leg({ execApr: -0.03, estFillSize: 1_000 }), leg({ execApr: -0.03, estFillSize: 1_000 })] });
    const long = exitPnlOf(exitSim, [{ ...held, venue: 'Gate', side: 'LONG', lockedApr: 0.05 }], NOW);
    expect(long).toBeCloseTo((-0.03 - -0.05) * 1_000, 9);
    // A SHORT entered at −5% stores −0.05; closing at −3% loses 2%.
    const short = exitPnlOf(exitSim, [{ ...held, venue: 'Gate', side: 'SHORT', lockedApr: -0.05 }], NOW);
    expect(short).toBeCloseTo((-0.05 - -0.03) * 1_000, 9);
  });

  it('is quoted per $6,000,000 exactly as per $50', () => {
    const at = (scale: number): number | null =>
      rollFigures({
        entrySim: sim({
          estSpreadApr: 0.09,
          costToCrossSize: 4 * scale,
          legs: [
            leg({ marginRequired: 20 * scale, sizing: { ...leg().sizing, deltaSize: 100 * scale, resultingSize: 100 * scale } }),
            leg({ marginRequired: 30 * scale, sizing: { ...leg().sizing, deltaSize: 100 * scale, resultingSize: 100 * scale } }),
          ],
        }),
        exitSim: sim({ intent: 'close', costToCrossSize: 2 * scale, legs: [leg({ execApr: 0.14, estFillSize: 100 * scale }), leg({ execApr: 0.12, estFillSize: 100 * scale })] }),
        size: 100 * scale,
        perpImUsd: 10 * scale,
        maturity: NOW + YEAR / 2,
        heldLegs: [
          { kind: 'yu', venue: 'Gate', side: 'LONG', sizeToken: 100 * scale, imUsd: 0, lockedApr: -0.1, maturity: NOW + YEAR / 4 },
          { kind: 'yu', venue: 'Hyperliquid', side: 'SHORT', sizeToken: 100 * scale, imUsd: 0, lockedApr: 0.2, maturity: NOW + YEAR / 4 },
        ],
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
