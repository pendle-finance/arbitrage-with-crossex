/**
 * /api/boros/roll/{simulate,execute} — the all-or-nothing roll (close a pair
 * at one maturity, re-open it at a later one as ONE batch). What matters here
 * is the same as /pair/execute: the roll gate is re-run SERVER-SIDE, the four
 * legs go out in the documented order as ONE FOK batch, and a lost-response
 * retry replays the original outcome instead of trading twice.
 *
 * The core roll arithmetic (gate, margin, four wire orders, verdict) is pinned
 * in tests/unit/boros-rollover.test.ts; this file is the route seam only.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BorosLegFill, BorosOrderClient, BorosRollLeg } from '../../src/core/boros/orders';
import { imInputs, raw } from '../helpers/boros-fixtures';
import { TtlCache } from '../../src/server/cache';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
/** The pair being LEFT (30d) and the pair being ROLLED INTO (60d). */
const MATURITY = NOW + 30 * DAY;
const MATURITY2 = NOW + 60 * DAY;
const ADDRESS = '0x1111111111111111111111111111111111111111';
/** The account the agent signs for; write routes are bound to it. */
const OTHER = '0x2222222222222222222222222222222222222222';

const HL = 155;
const BN = 158;
/** The later-maturity twins: same tokenId, same base, same venues. */
const HL2 = 156;
const BN2 = 159;

const market = (marketId: number, platformName: string, midApr: number, maturity = MATURITY) => ({
  marketId,
  tokenId: 3,
  state: 'Normal',
  imData: {
    name: `${platformName} ETH ${maturity === MATURITY ? '30d' : '60d'}`,
    maturity,
    iTickThresh: imInputs.imTickThresh,
    tickStep: imInputs.imTickStep,
  },
  extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
  metadata: { platformName, assetSymbol: 'ETH' },
  config: { takerFee: '500000000000000', kIM: raw(imInputs.kIM), tThresh: imInputs.tThreshSec },
  data: { midApr, markApr: midApr, floatingApr: 0.05, notionalOI: 12_000_000, assetMarkPrice: 1900 },
});

/**
 * A book 0.1% off `midApr` each side (ticks are APR × 10⁴). Both sides sit
 * inside the default 0.25% tolerance, so every order direction — the exit's
 * buy/sell and the entry's — fills clean.
 */
const wireBook = (midApr: number, size = 20_000_000) => ({
  short: { ia: [Math.round((midApr + 0.001) * 10_000)], sz: [raw(size)] },
  long: { ia: [Math.round((midApr - 0.001) * 10_000)], sz: [raw(size)] },
});

/** Default account: FLAT everywhere. Seed positions via the `over` on rollBodies. */
function rollBodies(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '/core/v1/markets': {
      results: [
        market(HL, 'Hyperliquid', 0.09),
        market(BN, 'Binance', 0.045),
        market(HL2, 'Hyperliquid', 0.1, MATURITY2),
        market(BN2, 'Binance', 0.05, MATURITY2),
      ],
    },
    [`/core/v1/order-books/${HL}`]: wireBook(0.09),
    [`/core/v1/order-books/${BN}`]: wireBook(0.045),
    [`/core/v1/order-books/${HL2}`]: wireBook(0.1),
    [`/core/v1/order-books/${BN2}`]: wireBook(0.05),
    '/core/v1/collaterals/summary': {
      collaterals: [{ tokenId: 3, crossPosition: { netBalance: raw(500_000), marketPositions: [] }, isolatedPositions: [] }],
    },
    ...over,
  };
}

/** The account holds the OLD pair: SHORT Hyperliquid @9%, LONG Binance @4.5%. */
const heldPair = {
  '/core/v1/collaterals/summary': {
    collaterals: [
      {
        tokenId: 3,
        crossPosition: {
          netBalance: raw(500_000),
          marketPositions: [
            { marketId: HL, side: 1, notionalSize: raw(-100_000), fixedApr: 0.09, pnl: {}, positionInitialMargin: raw(1_000) },
            { marketId: BN, side: 0, notionalSize: raw(100_000), fixedApr: 0.045, pnl: {}, positionInitialMargin: raw(800) },
          ],
        },
        isolatedPositions: [],
      },
    ],
  },
};

const okFill = (over: Partial<BorosLegFill> = {}): BorosLegFill => ({
  marketId: HL,
  direction: 'short',
  filledSize: 100_000,
  shortfallSize: 0,
  execApr: 0.09,
  feeSize: 4,
  failure: null,
  ...over,
});
/** The venue's four answers to a roll — closes then opens — every one whole. */
const rolledFills = (legs: BorosRollLeg[]): BorosLegFill[] => [
  ...legs.map((l) => okFill({ marketId: l.fromMarketId, direction: 'long', filledSize: l.size, shortfallSize: 0 })),
  ...legs.map((l) => okFill({ marketId: l.toMarketId, direction: 'short', filledSize: l.size, shortfallSize: 0 })),
];

/** A client that records its ONE rollOver call and scripts the fills. */
function capturingClient(calls: BorosRollLeg[][], roll?: (legs: BorosRollLeg[]) => BorosLegFill[]): BorosOrderClient {
  return {
    placeMarketOrders: async () => {
      throw new Error('a roll must not go through placeMarketOrders');
    },
    rollOver: async (legs) => {
      calls.push(legs);
      return roll ? roll(legs) : rolledFills(legs);
    },
    cancelOrders: async () => {},
    closePosition: async () => okFill(),
  };
}
const spyClient = (roll: NonNullable<BorosOrderClient['rollOver']>): BorosOrderClient => ({
  placeMarketOrders: async () => {
    throw new Error('a roll must not go through placeMarketOrders');
  },
  rollOver: roll,
  cancelOrders: async () => {},
  closePosition: async () => okFill(),
});

const rollBody = (over: Record<string, unknown> = {}) => ({
  address: ADDRESS,
  exit: {
    legA: { marketId: HL, direction: 'long', slippageApr: 0.0025 },
    legB: { marketId: BN, direction: 'short', slippageApr: 0.0025 },
    size: 100_000,
  },
  entry: {
    legA: { marketId: HL2, direction: 'short', slippageApr: 0.0025 },
    legB: { marketId: BN2, direction: 'long', slippageApr: 0.0025 },
    size: 100_000,
  },
  clientOrderIds: { exitA: 'roll-exit-a1', exitB: 'roll-exit-b1', entryA: 'roll-entry-a1', entryB: 'roll-entry-b1' },
  ...over,
});

let app: FastifyInstance | null = null;
beforeEach(() => {
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
});
afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.BOROS_ROOT_ADDRESS;
  vi.useRealTimers();
});

function makeRollApp(over: Record<string, unknown> = {}, client?: BorosOrderClient, cache?: TtlCache) {
  app = makeTestApp({
    borosFetch: borosStub(rollBodies(over)),
    getBorosOrders: () => client,
    ...(cache ? { cache } : {}),
  });
  return app;
}

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, headers: HOST, payload: payload as object });

describe('POST /api/boros/roll/simulate', () => {
  it('prices both steps and returns a post-exit margin with positionApr reaching the exit legs', async () => {
    const calls: BorosRollLeg[][] = [];
    makeRollApp(heldPair, capturingClient(calls));
    const res = await post('/api/boros/roll/simulate', rollBody());
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    // Both steps priced against ONE account read.
    expect(data.exit.simulation.legA.execApr).toBeGreaterThan(0);
    expect(data.entry.simulation.legA.execApr).toBeGreaterThan(0);
    // A clean roll — no blockers, and the margin object is populated.
    expect(data.gate.blockers).toEqual([]);
    // A full close frees every unit the old legs committed (1000 + 800).
    expect(data.gate.margin.freed).toBeCloseTo(1_800, 6);
    expect(data.gate.margin.need).toBeGreaterThan(0);
    // positionApr reached the exit legs, so the exit PnL could be priced —
    // it is null the moment the locked rate does not flow through.
    expect(data.gate.margin.worstExitPnl).not.toBeNull();
    // Simulating never touches the venue.
    expect(calls).toHaveLength(0);
  });

  it('prefixes a step blocker with the step it belongs to', async () => {
    // A thin re-entry book: the leg cannot fill whole, and FOK would revert the
    // batch — a roll-only blocker, named "Re-entry:" so the panel says which step.
    const calls: BorosRollLeg[][] = [];
    makeRollApp({ ...heldPair, [`/core/v1/order-books/${HL2}`]: wireBook(0.1, 40_000) }, capturingClient(calls));
    const res = await post('/api/boros/roll/simulate', rollBody());
    expect(res.statusCode).toBe(200);
    const blocker = res.json().data.gate.blockers.find((b: { code: string }) => b.code === 'partial-depth');
    expect(blocker).toMatchObject({ step: 'entry', leg: 'A', marketId: HL2 });
    expect(blocker.message).toMatch(/^Re-entry: .* has 40000 of 100000 inside the rate bound/);
  });
});

describe('POST /api/boros/roll/execute', () => {
  it('hands the venue the two legs once — old market, new market, size, both bounds — and busts the reads', async () => {
    const calls: BorosRollLeg[][] = [];
    const busted: string[] = [];
    const cache = new TtlCache();
    const realBust = cache.bust.bind(cache);
    cache.bust = ((prefix: string) => {
      busted.push(prefix);
      return realBust(prefix);
    }) as typeof cache.bust;
    makeRollApp(heldPair, capturingClient(calls), cache);

    const res = await post('/api/boros/roll/execute', rollBody());
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.result.status).toBe('rolled');
    expect(data.replayed).toBe(false);

    // Exactly one roll, two legs: the venue builds the four FOK orders itself.
    expect(calls).toHaveLength(1);
    // Closing the HL short buys at mid + tol; re-opening it sells at the new mid − tol.
    expect(calls[0].map((l) => [l.fromMarketId, l.toMarketId, l.closeRate, l.openRate])).toEqual([
      [HL, HL2, 0.09 + 0.0025, 0.1 - 0.0025],
      [BN, BN2, 0.045 - 0.0025, 0.05 + 0.0025],
    ]);
    // The size is the position as a float (an 18-decimal integer does not
    // round-trip exactly); the venue caps the close at the position in wei.
    calls[0].forEach((l) => expect(l.size).toBeCloseTo(100_000, 6));

    expect(busted).toContain('boros:collaterals');
    expect(busted).toContain('boros:txns');
  });

  it('re-runs the roll gate server-side and refuses a blocked roll with a 409', async () => {
    // The default account is FLAT, so the exit has nothing to close — the pair
    // gate's own blocker, surfaced through the roll gate with an "Exit:" prefix.
    const place = vi.fn(async (legs: BorosRollLeg[]) => rolledFills(legs));
    makeRollApp({}, spyClient(place));
    const res = await post('/api/boros/roll/execute', rollBody());
    expect(res.statusCode).toBe(409);
    const blockers = res.json().data.blockers as Array<{ code: string; message: string }>;
    const noSize = blockers.find((b) => b.code === 'no-size');
    expect(noSize).toBeDefined();
    expect(noSize!.message).toMatch(/^Exit: You hold nothing on/);
    expect(place).not.toHaveBeenCalled();
  });

  it.each([
    ['missing ids', { clientOrderIds: {} }],
    ['a too-short id', { clientOrderIds: { exitA: 'abc', exitB: 'roll-exit-b1', entryA: 'roll-entry-a1', entryB: 'roll-entry-b1' } }],
    ['duplicate ids', { clientOrderIds: { exitA: 'dup-000001', exitB: 'dup-000001', entryA: 'roll-entry-a1', entryB: 'roll-entry-b1' } }],
  ])('rejects %s with a 400 before touching the venue', async (_label, over) => {
    const place = vi.fn(async (legs: BorosRollLeg[]) => rolledFills(legs));
    makeRollApp(heldPair, spyClient(place));
    const res = await post('/api/boros/roll/execute', rollBody(over));
    expect(res.statusCode).toBe(400);
    expect(place).not.toHaveBeenCalled();
  });

  it('replays a resend of the same four ids after a rolled result, without a second submission', async () => {
    // Boros has no client-order-id, so nothing at the venue dedupes: without the
    // memo a lost response plus a Confirm press rolls the position twice.
    const calls: BorosRollLeg[][] = [];
    makeRollApp(heldPair, capturingClient(calls));
    const body = rollBody();

    const first = await post('/api/boros/roll/execute', body);
    const second = await post('/api/boros/roll/execute', body);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(calls).toHaveLength(1); // one submission, not two
    expect(first.json().data.replayed).toBe(false);
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.result).toEqual(first.json().data.result);
  });

  it('does not memoize a REFUSED roll — the same ids get an honest second attempt', async () => {
    // A roll the venue turned away provably traded nothing, so its ids may be
    // reused; only a rolled/unknown outcome is remembered.
    let n = 0;
    const refuse = spyClient(async (legs) => {
      n += 1;
      return rolledFills(legs).map((f) =>
        okFill({ ...f, filledSize: 0, shortfallSize: 100_000, failure: { code: 'insufficient-margin', message: '[SIMULATE] Not enough margin', cause: 'batch' } }),
      );
    });
    makeRollApp(heldPair, refuse);
    const body = rollBody();

    const first = await post('/api/boros/roll/execute', body);
    const second = await post('/api/boros/roll/execute', body);

    expect(first.json().data.result.status).toBe('refused');
    expect(second.json().data.result.status).toBe('refused');
    expect(second.json().data.replayed).toBe(false);
    expect(n).toBe(2); // executed again, not replayed
  });

  it('answers 503 when the install cannot roll', async () => {
    makeRollApp(heldPair, undefined); // no order client
    const res = await post('/api/boros/roll/execute', rollBody());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/not configured/i);
    // …or one that predates the venue's roll-over builder.
    makeRollApp(heldPair, { placeMarketOrders: async () => [], cancelOrders: async () => {}, closePosition: async () => okFill() });
    expect((await post('/api/boros/roll/execute', rollBody())).statusCode).toBe(503);
  });

  it('refuses to roll an account other than the one it signs for', async () => {
    const place = vi.fn(async (legs: BorosRollLeg[]) => rolledFills(legs));
    makeRollApp(heldPair, spyClient(place));
    const res = await post('/api/boros/roll/execute', rollBody({ address: OTHER }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/does not match the account this install signs for/);
    expect(place).not.toHaveBeenCalled();
  });
});
