import { describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../web/src/api/types';
import type { BorosMarket } from '../../src/core/boros/client';
import type { BorosPairSimulation, SimulatedLeg } from '../../src/core/boros/pair';
import type { AssetViewOut } from '../../src/server/routes/assetView';
import { createRollProbe, type PairSimulateBody } from '../../src/server/telegram/rollProbe';

const NOW = 1_760_000_000;
const DAY = 86_400;
const SOON = NOW + 8 * DAY;
const LATER = NOW + 60 * DAY;
const ADDRESS = '0x1111111111111111111111111111111111111111';

const perp = (o: Partial<AssetPerpOpen> & { venue: string; side: 'LONG' | 'SHORT'; qty: number }): AssetPerpOpen => ({
  symbol: `${o.venue}_FUTURE_ETH_USDT`,
  notionalUsd: o.qty * 2500,
  entryPrice: 2500,
  markPrice: 2500,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: o.qty * 250,
  openedAt: NOW - 10 * DAY,
  ...o,
});

const yu = (
  o: Partial<AssetBorosOpen> & { marketId: number; venue: string; side: 'LONG' | 'SHORT'; sizeToken: number; maturity: number },
): AssetBorosOpen => ({
  collateral: 'ETH',
  notionalUsd: o.sizeToken * 2500,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: o.sizeToken * 100,
  spreadVenues: null,
  ...o,
});

const withBoros = (base: string, borosOpen: AssetBorosOpen[]): AssetGroup => ({
  base,
  supported: true,
  priceUsd: 2500,
  earliestSec: NOW - 10 * DAY,
  perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
  perpClosed: [],
  borosOpen,
  borosHistory: [],
});

const group = (base: string, marketIds: [number, number]): AssetGroup =>
  withBoros(base, [
    yu({ marketId: marketIds[0], venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SOON, entryApr: 0.04 }),
    yu({ marketId: marketIds[1], venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SOON, entryApr: 0.08 }),
  ]);

const spreadGroup = (): AssetGroup =>
  withBoros('ETH', [
    yu({
      marketId: 59,
      venue: 'HYPERLIQUID',
      side: 'SHORT',
      sizeToken: 100,
      maturity: SOON,
      entryApr: 0.0348,
      spreadVenues: ['HYPERLIQUID', 'GATE'],
    }),
  ]);

const twinsBook = (): AssetGroup => ({
  ...withBoros('ETH', [
    yu({
      marketId: 59,
      venue: 'HYPERLIQUID',
      side: 'SHORT',
      sizeToken: 50,
      maturity: SOON,
      entryApr: 3,
      spreadVenues: ['HYPERLIQUID', 'GATE'],
    }),
    yu({ marketId: 1, venue: 'GATE', side: 'LONG', sizeToken: 10, maturity: SOON, entryApr: 0.5 }),
    yu({ marketId: 2, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 10, maturity: SOON, entryApr: 0 }),
  ]),
  perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 60 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 60 })],
});

const view = (assets: AssetGroup[]): AssetViewOut =>
  ({
    sinceSec: 0,
    nowSec: NOW,
    defaultSinceSec: null,
    assets,
    supportedCoins: ['ETH', 'BTC'],
    earliestSec: NOW - 10 * DAY,
    coverage: { settlementsFromSec: 0, perpClosedFromSec: 0, borosTxnsComplete: true, backfilling: false },
    interest: { paidUsd: 0, byCoin: {}, coversFromSec: 0, available: true },
    warnings: [],
  }) as unknown as AssetViewOut;

const market = (marketId: number, venue: string, base: string, maturity: number): BorosMarket =>
  ({ marketId, venue, base, maturity, state: 'Normal', maxRateDeviationApr: 0.04, tokenId: 2, spreadVenues: null }) as BorosMarket;

const spreadMarket = (marketId: number, maturity: number): BorosMarket => ({
  ...market(marketId, 'HL-GATE', 'ETH', maturity),
  spreadVenues: ['HYPERLIQUID', 'GATE'],
});

const leg = (over: Partial<SimulatedLeg> = {}): SimulatedLeg => ({
  marketId: 1,
  marketName: 'Gate ETH',
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
  marginReleased: 0,
  liquidationApr: null,
  slippageApr: 0.01,
  sizing: { currentSize: 0, deltaSize: 100, resultingSize: 100, opposing: false, flips: false, clampedToClose: false, orderSide: 'long' },
  takerFeeCost: 0,
  ...over,
});

const simulation = (over: Partial<BorosPairSimulation> = {}): BorosPairSimulation => ({
  legs: [leg(), leg({ marketId: 2, direction: 'short' })],
  receiveLeg: 1,
  estSpreadApr: 0.5,
  worstSpreadApr: 0.5,
  costToCrossSize: 0,
  feeDragApr: 0,
  takerDragApr: 0,
  intent: 'open',
  midSpreadApr: 0.5,
  slippageApr: 0,
  marginRequiredTotal: 50,
  marginReleasedTotal: 0,
  hedgedSize: 100,
  unhedgedSize: 0,
  collateral: 'ETH',
  collateralPriceUsd: 2500,
  secondsToMaturity: LATER - NOW,
  reasons: [],
  ...over,
});

const pricer =
  (priced: PairSimulateBody[] = []) =>
  async (body: PairSimulateBody): Promise<{ simulation: BorosPairSimulation }> => {
    priced.push(body);
    return {
      simulation: simulation({
        intent: body.intent,
        legs: body.legs.map((l) =>
          leg({ marketId: l.marketId, direction: l.direction, ...(body.intent === 'close' ? { execApr: null } : {}) }),
        ),
        receiveLeg: body.legs.length === 2 ? 1 : 0,
      }),
    };
  };

const markets: BorosMarket[] = [
  market(1, 'Gate', 'ETH', SOON),
  market(2, 'Hyperliquid', 'ETH', SOON),
  market(3, 'Gate', 'ETH', LATER),
  market(4, 'Hyperliquid', 'ETH', LATER),
  market(5, 'Gate', 'BTC', SOON),
  market(6, 'Hyperliquid', 'BTC', SOON),
  market(7, 'Gate', 'BTC', LATER),
  market(8, 'Hyperliquid', 'BTC', LATER),
];

const deps = (over: {
  assets?: AssetGroup[];
  price?: (body: PairSimulateBody) => Promise<{ simulation: BorosPairSimulation }>;
  address?: string | null;
  markets?: BorosMarket[];
}) => ({
  borosAddress: () => (over.address === undefined ? ADDRESS : over.address),
  buildAssetView: async () => view(over.assets ?? [group('ETH', [1, 2])]),
  loadMarkets: async () => over.markets ?? markets,
  price:
    over.price ??
    (async (body: PairSimulateBody) => ({ simulation: simulation({ intent: body.intent }) })),
  now: () => NOW * 1_000,
  log: () => undefined,
});

describe('the roll probe on the server', () => {
  it('reports one target when a later maturity beats the rate held', async () => {
    const signals = await createRollProbe(deps({}))();
    expect(signals).toHaveLength(1);
    expect(signals[0].coin).toBe('ETH');
    expect(signals[0].longVenue).toBe('GATE');
    expect(signals[0].shortVenue).toBe('HYPERLIQUID');
    expect(signals[0].maturity).toBe(SOON);
    expect(signals[0].targets).toHaveLength(1);
    expect(signals[0].targets[0].maturity).toBe(LATER);
    expect(signals[0].targets[0].apr).toBeGreaterThan(signals[0].targets[0].currentApr);
  });

  it('spread pair gets roll targets', async () => {
    const priced: PairSimulateBody[] = [];
    const probe = createRollProbe(
      deps({
        assets: [spreadGroup()],
        markets: [spreadMarket(59, SOON), spreadMarket(60, LATER), ...markets.slice(0, 4)],
        price: async (body) => {
          priced.push(body);
          return {
            simulation: simulation({
              intent: body.intent,
              legs: body.legs.map((l) => leg({ marketId: l.marketId, direction: l.direction })),
              receiveLeg: 0,
            }),
          };
        },
      }),
    );
    const signals = await probe();
    expect(signals).toHaveLength(1);
    expect(signals[0].targets.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].targets[0].maturity).toBe(LATER);
    const entry = priced.find((b) => b.intent === 'open');
    expect(entry?.legs.map((l) => [l.marketId, l.direction])).toEqual([[60, 'short']]);
    const exit = priced.find((b) => b.intent === 'close');
    expect(exit?.legs.map((l) => [l.marketId, l.direction])).toEqual([[59, 'long']]);
  });

  it('case 3: twin pairs at one date are priced apart, and only the singles twin rolls', async () => {
    const signals = await createRollProbe(
      deps({ assets: [twinsBook()], markets: [spreadMarket(59, SOON), spreadMarket(60, LATER), ...markets.slice(0, 4)], price: pricer() }),
    )();
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect([s.coin, s.longVenue, s.shortVenue, s.maturity]).toEqual(['ETH', 'GATE', 'HYPERLIQUID', SOON]);
    }
    const spread = signals.find((s) => s.marketIds?.join(',') === '59');
    const singles = signals.find((s) => s.marketIds?.join(',') === '1,2');
    expect([spread?.kind, singles?.kind]).toEqual(['spread', 'singles']);
    expect(spread?.targets).toEqual([]);
    expect(singles?.targets.map((t) => t.maturity)).toEqual([LATER]);
    expect(singles?.targets[0].apr).toBeGreaterThan(singles?.targets[0].currentApr ?? Infinity);
  });

  it('twin pairs with nothing later to roll into still report both, so the roll-due reminder fires', async () => {
    const signals = await createRollProbe(
      deps({ assets: [twinsBook()], markets: [spreadMarket(59, SOON), ...markets.slice(0, 2)], price: pricer() }),
    )();
    expect(signals.map((s) => [s.maturity, s.marketIds, s.targets])).toEqual(
      expect.arrayContaining([
        [SOON, [59], []],
        [SOON, [1, 2], []],
      ]),
    );
    expect(signals).toHaveLength(2);
  });

  it('a pair far from maturity sends no roll signal', async () => {
    const far = NOW + 200 * DAY;
    const book = withBoros('ETH', [
      yu({ marketId: 3, venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: far, entryApr: 0.04 }),
      yu({ marketId: 4, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: far, entryApr: 0.08 }),
    ]);
    const signals = await createRollProbe(
      deps({ assets: [book], markets: [market(3, 'Gate', 'ETH', far), market(4, 'Hyperliquid', 'ETH', far)] }),
    )();
    expect(signals).toEqual([]);
  });

  it.each([
    {
      kind: 'singles to singles',
      assets: () => [group('ETH', [1, 2])],
      listed: () => markets.slice(0, 4),
      held: [1, 2],
      exit: [[1, 'short'], [2, 'long']],
      entry: [[3, 'long'], [4, 'short']],
    },
    {
      kind: 'singles to spread',
      assets: () => [group('ETH', [1, 2])],
      listed: () => [...markets.slice(0, 4), spreadMarket(60, LATER)],
      held: [1, 2],
      exit: [[1, 'short'], [2, 'long']],
      entry: [[60, 'short']],
    },
    {
      kind: 'spread to spread',
      assets: () => [spreadGroup()],
      listed: () => [spreadMarket(59, SOON), spreadMarket(60, LATER), ...markets.slice(0, 4)],
      held: [59],
      exit: [[59, 'long']],
      entry: [[60, 'short']],
    },
    {
      kind: 'spread to singles',
      assets: () => [spreadGroup()],
      listed: () => [spreadMarket(59, SOON), ...markets.slice(0, 4)],
      held: [59],
      exit: [[59, 'long']],
      entry: [[3, 'long'], [4, 'short']],
    },
    {
      kind: 'singles past a close-only spread and another collateral',
      assets: () => [group('ETH', [1, 2])],
      listed: () => [
        ...markets.slice(0, 2),
        { ...market(9, 'Hyperliquid', 'ETH', LATER), tokenId: 3 },
        ...markets.slice(2, 4),
        { ...spreadMarket(60, LATER), state: 'CloseOnly' },
      ],
      held: [1, 2],
      exit: [[1, 'short'], [2, 'long']],
      entry: [[3, 'long'], [4, 'short']],
    },
  ])('$kind: one signal, priced on the right markets', async ({ assets, listed, held, exit, entry }) => {
    const priced: PairSimulateBody[] = [];
    const signals = await createRollProbe(deps({ assets: assets(), markets: listed(), price: pricer(priced) }))();
    expect(signals).toHaveLength(1);
    expect(signals[0].marketIds).toEqual(held);
    expect(signals[0].maturity).toBe(SOON);
    expect(signals[0].targets.map((t) => t.maturity)).toEqual([LATER]);
    const legsOf = (intent: 'open' | 'close') =>
      priced
        .find((b) => b.intent === intent)
        ?.legs.map((l) => [l.marketId, l.direction])
        .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(legsOf('close')).toEqual(exit);
    expect(legsOf('open')).toEqual(entry);
  });

  it('keeps the other pair when one pair cannot be priced', async () => {
    const probe = createRollProbe(
      deps({
        assets: [group('ETH', [1, 2]), group('BTC', [5, 6])],
        price: async (body) => {
          if (body.legs[0].marketId === 5 || body.legs[0].marketId === 7) throw new Error('book unavailable');
          return { simulation: simulation({ intent: body.intent }) };
        },
      }),
    );
    const signals = await probe();
    expect(signals.map((s) => s.coin)).toEqual(['ETH', 'BTC']);
    expect(signals[0].targets).toHaveLength(1);
    expect(signals[0].unpriced).toBeUndefined();
    expect(signals[1].maturity).toBe(SOON);
    expect(signals[1].targets).toEqual([]);
    // Unknown, not "nothing to roll into": the sync keeps its last targets.
    expect(signals[1].unpriced).toBe(true);
  });

  it('a leg whose book did not load marks the pair unpriced, not opportunity-free', async () => {
    const probe = createRollProbe(
      deps({
        price: async (body) => ({
          simulation: simulation({
            intent: body.intent,
            legs: [leg({ bookStatus: 'unavailable', execApr: null, estFillSize: 0 }), leg({ marketId: 2 })],
          }),
        }),
      }),
    );
    const signals = await probe();
    expect(signals).toHaveLength(1);
    expect(signals[0].targets).toEqual([]);
    expect(signals[0].unpriced).toBe(true);
  });

  it('reports a pair with no later maturity so the bot still learns when it matures', async () => {
    const probe = createRollProbe({ ...deps({}), loadMarkets: async () => markets.slice(0, 2) });
    const signals = await probe();
    expect(signals).toHaveLength(1);
    expect(signals[0].coin).toBe('ETH');
    expect(signals[0].maturity).toBe(SOON);
    expect(signals[0].targets).toEqual([]);
  });

  it('reports nothing when this install has no Boros account', async () => {
    expect(await createRollProbe(deps({ address: null }))()).toEqual([]);
  });
});
