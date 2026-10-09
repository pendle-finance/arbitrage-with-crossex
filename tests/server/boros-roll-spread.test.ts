import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BorosLegFill,
  BorosMarketOrderRequest,
  BorosOrderClient,
  BorosRollLeg,
  BorosRollSimulation,
  PlaceOrdersOptions,
} from '../../src/core/boros/orders';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NOW_MS = Date.UTC(2026, 9, 8);
const ADDRESS = '0x1111111111111111111111111111111111111111';
const ETH_USD = 2571.7;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const SIZE_50 = round6(50 / ETH_USD);
const SIZE_6M = round6(6_000_000 / ETH_USD);

const SPREAD_NOV = 59;
const HL_OCT = 61;
const GATE_OCT = 62;
const SPREAD_OCT = 63;
const HL_DEC = 64;
const GATE_DEC = 65;

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
) as { results: Array<{ marketId: number; data: { midApr: number } }> };

const wei = (n: number): string => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

const wireBook = (midApr: number) => ({
  short: { ia: [Math.round((midApr + 0.001) * 10_000)], sz: [raw(1_000_000)] },
  long: { ia: [Math.round((midApr - 0.001) * 10_000)], sz: [raw(1_000_000)] },
});

type Held = { marketId: number; size: number };

function bodies(held: Held[]): Record<string, unknown> {
  const acc = marketAcc(ADDRESS, 2);
  const books = Object.fromEntries(
    fixture.results.map((m) => [`/apis/v1/markets/order-book?marketId=${m.marketId}`, wireBook(m.data.midApr)]),
  );
  return {
    '/apis/v1/markets': { results: fixture.results, total: fixture.results.length, skip: 0 },
    ...books,
    '/apis/v1/accounts/market-acc-infos-by-root': {
      results: [
        {
          marketAcc: acc,
          netBalance: raw(100_000),
          initialMargin: raw(0),
          positions: held.map((h) => ({ marketId: h.marketId, signedSize: wei(h.size), initialMargin: raw(0), orders: [] })),
        },
      ],
    },
    '/apis/v1/accounts/active-positions': {
      results: held.map((h) => ({
        marketAcc: acc,
        marketId: h.marketId,
        side: h.size >= 0 ? 0 : 1,
        fixedApr: 0.06,
        signedSize: wei(h.size),
        unrealisedPnl: '0',
        settlementPnl: '0',
      })),
    },
  };
}

const fill = (marketId: number, direction: 'long' | 'short', size: number): BorosLegFill => ({
  marketId,
  direction,
  filledSize: size,
  shortfallSize: 0,
  execApr: 0.06,
  feeSize: 0.001,
  failure: null,
});

const venueOk = (legs: BorosRollLeg[]): BorosRollSimulation => ({
  status: 'Succeed',
  reason: null,
  orders: [
    ...legs.map((l) => ({ action: 'close' as const, marketId: l.fromMarketId, filled: true, matchedSize: l.size, matchedApr: 0.06, fee: 0.001, error: null })),
    ...legs.map((l) => ({ action: 'open' as const, marketId: l.toMarketId, filled: true, matchedSize: l.size, matchedApr: 0.06, fee: 0.001, error: null })),
  ],
  availableBefore: 100_000,
  availableAfter: 99_000,
  availableAfterExit: 99_500,
  marginRequired: 1_000,
});

interface Calls {
  placed: Array<{ reqs: BorosMarketOrderRequest[]; opts: PlaceOrdersOptions | undefined }>;
  rolled: BorosRollLeg[][];
  previewed: BorosRollLeg[][];
}

function recordingClient(calls: Calls): BorosOrderClient {
  return {
    placeMarketOrders: async (reqs, opts) => {
      calls.placed.push({ reqs, opts });
      return reqs.map((r) => fill(r.marketId, r.direction, r.size));
    },
    rollOver: async (legs) => {
      calls.rolled.push(legs);
      return [
        ...legs.map((l) => fill(l.fromMarketId, 'long', l.size)),
        ...legs.map((l) => fill(l.toMarketId, 'short', l.size)),
      ];
    },
    simulateRollOver: async (legs) => {
      calls.previewed.push(legs);
      return venueOk(legs);
    },
    cancelOrders: async () => {},
    closePosition: async (r) => fill(r.marketId, r.direction, r.size),
  };
}

let app: FastifyInstance | null = null;
let calls: Calls;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
  calls = { placed: [], rolled: [], previewed: [] };
});
afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.BOROS_ROOT_ADDRESS;
  vi.useRealTimers();
});

function makeApp(held: Held[]) {
  const client = recordingClient(calls);
  app = makeTestApp({ borosFetch: borosStub(bodies(held)), getBorosOrders: () => client });
  return app;
}

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, headers: HOST, payload: payload as object });

const leg = (marketId: number, direction: 'long' | 'short', size: number) => ({ marketId, direction, slippageApr: 0.0025, size });

const rollBody = (
  exit: ReturnType<typeof leg>[],
  entry: ReturnType<typeof leg>[],
  tag: string,
) => ({
  address: ADDRESS,
  exit: { legs: exit },
  entry: { legs: entry },
  clientOrderIds: Object.fromEntries([
    ...exit.map((l) => [`exit:${l.marketId}`, `roll-${tag}-exit-${l.marketId}`]),
    ...entry.map((l) => [`entry:${l.marketId}`, `roll-${tag}-entry-${l.marketId}`]),
  ]),
});

describe('POST /api/boros/roll/execute with spread markets', () => {
  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('two singles roll into a spread (%s)', async (_label, size) => {
    makeApp([
      { marketId: HL_OCT, size: -size },
      { marketId: GATE_OCT, size },
    ]);
    const body = rollBody([leg(HL_OCT, 'long', size), leg(GATE_OCT, 'short', size)], [leg(SPREAD_NOV, 'short', size)], 'a16');

    const sim = await post('/api/boros/roll/simulate', body);
    expect(sim.statusCode, sim.body).toBe(200);
    expect(sim.json().data.venue).toBeNull();
    expect(sim.json().data.gate.blockers).toEqual([]);

    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.rolled).toHaveLength(0);
    expect(calls.previewed).toHaveLength(0);
    expect(calls.placed).toHaveLength(1);
    const { reqs, opts } = calls.placed[0];
    expect(reqs.map((r) => [r.marketId, r.direction])).toEqual([
      [HL_OCT, 'long'],
      [GATE_OCT, 'short'],
      [SPREAD_NOV, 'short'],
    ]);
    expect(opts?.topUpAfter).toBe(2);
    expect(reqs[0].size).toBeLessThanOrEqual(size);
    expect(reqs[0].size).toBeCloseTo(size, 6);
    expect(reqs[1].size).toBeCloseTo(size, 6);
    expect(reqs[2].size).toBeCloseTo(size, 6);
    expect(reqs.map((r) => r.clientOrderId)).toEqual([
      `roll-a16-exit-${HL_OCT}`,
      `roll-a16-exit-${GATE_OCT}`,
      `roll-a16-entry-${SPREAD_NOV}`,
    ]);
    const { result } = res.json().data;
    expect(result.status).toBe('rolled');
    expect(Object.keys(result.legs).sort()).toEqual([`entry:${SPREAD_NOV}`, `exit:${GATE_OCT}`, `exit:${HL_OCT}`].sort());
  });

  it('spread rolls into a spread', async () => {
    makeApp([{ marketId: SPREAD_OCT, size: -0.3 }]);
    const body = rollBody([leg(SPREAD_OCT, 'long', 0.3)], [leg(SPREAD_NOV, 'short', 0.3)], 'a17');
    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.placed).toHaveLength(0);
    expect(calls.rolled).toHaveLength(1);
    expect(calls.rolled[0]).toHaveLength(1);
    expect(calls.rolled[0][0]).toMatchObject({ fromMarketId: SPREAD_OCT, toMarketId: SPREAD_NOV });
    expect(calls.rolled[0][0].size).toBeCloseTo(0.3, 9);
    expect(res.json().data.result.status).toBe('rolled');
  });

  it('spread rolls into two singles', async () => {
    makeApp([{ marketId: SPREAD_NOV, size: -0.3 }]);
    const body = rollBody([leg(SPREAD_NOV, 'long', 0.3)], [leg(HL_DEC, 'short', 0.3), leg(GATE_DEC, 'long', 0.3)], 'a18');
    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.rolled).toHaveLength(0);
    expect(calls.previewed).toHaveLength(0);
    expect(calls.placed).toHaveLength(1);
    expect(calls.placed[0].reqs.map((r) => [r.marketId, r.direction])).toEqual([
      [SPREAD_NOV, 'long'],
      [HL_DEC, 'short'],
      [GATE_DEC, 'long'],
    ]);
    expect(calls.placed[0].opts?.topUpAfter).toBe(1);
    expect(res.json().data.result.status).toBe('rolled');
  });

  it('refuses replay keys that do not name the legs', async () => {
    makeApp([{ marketId: SPREAD_OCT, size: -0.3 }]);
    const body = {
      ...rollBody([leg(SPREAD_OCT, 'long', 0.3)], [leg(SPREAD_NOV, 'short', 0.3)], 'bad'),
      clientOrderIds: { exitA: 'roll-bad-exit-a', entryA: 'roll-bad-entry-a' },
    };
    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode).toBe(400);
    expect(calls.placed).toHaveLength(0);
    expect(calls.rolled).toHaveLength(0);
  });

  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('batch roll replays a resend (%s)', async (_label, size) => {
    makeApp([
      { marketId: HL_OCT, size: -size },
      { marketId: GATE_OCT, size },
    ]);
    const body = rollBody([leg(HL_OCT, 'long', size), leg(GATE_OCT, 'short', size)], [leg(SPREAD_NOV, 'short', size)], 'replay');

    const first = await post('/api/boros/roll/execute', body);
    const second = await post('/api/boros/roll/execute', body);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(calls.placed).toHaveLength(1);
    expect(first.json().data.replayed).toBe(false);
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.result).toEqual(first.json().data.result);
  });
});

describe('POST /api/boros/roll/execute on a mixed book', () => {
  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('two singles and a spread roll into one spread, each venue keeps its size (%s)', async (_label, perVenue) => {
    const single = round6((perVenue * 0.3) / 0.555);
    const spread = round6(perVenue - single);
    makeApp([
      { marketId: HL_OCT, size: -single },
      { marketId: GATE_OCT, size: single },
      { marketId: SPREAD_OCT, size: -spread },
    ]);
    const body = rollBody(
      [leg(HL_OCT, 'long', single), leg(GATE_OCT, 'short', single), leg(SPREAD_OCT, 'long', spread)],
      [leg(SPREAD_NOV, 'short', single + spread)],
      'mixed',
    );
    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.placed).toHaveLength(1);
    const { reqs, opts } = calls.placed[0];
    expect(reqs.map((r) => [r.marketId, r.direction])).toEqual([
      [HL_OCT, 'long'],
      [GATE_OCT, 'short'],
      [SPREAD_OCT, 'long'],
      [SPREAD_NOV, 'short'],
    ]);
    expect(opts).toMatchObject({ topUpAfter: 3, timeInForce: 'fill-or-kill' });
    const signed = (r: BorosMarketOrderRequest) => (r.direction === 'long' ? 1 : -1) * r.size;
    const hlMoved = signed(reqs[0]) + signed(reqs[2]) + signed(reqs[3]);
    const gateMoved = signed(reqs[1]) - signed(reqs[2]) - signed(reqs[3]);
    expect(Math.abs(hlMoved)).toBeLessThanOrEqual(1e-9 * perVenue);
    expect(Math.abs(gateMoved)).toBeLessThanOrEqual(1e-9 * perVenue);
  });
});

describe('POST /api/boros/roll/execute closes the exact open size', () => {
  const below = (x: number): number => x * (1 - 2 ** -52);

  it.each([
    ['$50', 0.3, 0.255],
    ['$6M', round6(SIZE_6M * (0.3 / 0.555)), round6(SIZE_6M * (0.255 / 0.555))],
  ])('a mixed-book exit with a float tail sends each open size in wei (%s)', async (_label, single, spread) => {
    expect(below(single)).toBeLessThan(single);
    if (single === 0.3) expect(below(single)).toBe(0.29999999999999993);
    makeApp([
      { marketId: HL_OCT, size: -single },
      { marketId: GATE_OCT, size: single },
      { marketId: SPREAD_OCT, size: -spread },
    ]);
    const body = rollBody(
      [leg(HL_OCT, 'long', below(single)), leg(GATE_OCT, 'short', below(single)), leg(SPREAD_OCT, 'long', spread)],
      [leg(SPREAD_NOV, 'short', below(single) + spread)],
      'dust',
    );
    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode, res.body).toBe(200);
    const { reqs } = calls.placed[0];
    expect(reqs.map((r) => [r.marketId, r.sizeWei])).toEqual([
      [HL_OCT, wei(single)],
      [GATE_OCT, wei(single)],
      [SPREAD_OCT, wei(spread)],
      [SPREAD_NOV, undefined],
    ]);
  });

  it.each([
    ['$50', 0.3],
    ['$6M', SIZE_6M],
  ])('a spread rolled into the next spread with a float tail sends the open size in wei (%s)', async (_label, size) => {
    makeApp([{ marketId: SPREAD_OCT, size: -size }]);
    const body = rollBody([leg(SPREAD_OCT, 'long', below(size))], [leg(SPREAD_NOV, 'short', below(size))], 'dust-rollover');
    const res = await post('/api/boros/roll/execute', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.rolled[0].map((l) => [l.fromMarketId, l.toMarketId, l.sizeWei])).toEqual([[SPREAD_OCT, SPREAD_NOV, wei(size)]]);
    expect(calls.previewed[0][0].sizeWei).toBe(wei(size));
  });
});

describe('POST /api/boros/roll/execute holds the market lock', () => {
  function gatedApp(held: Held[], outcome: 'fill' | 'throw' = 'fill') {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => {};
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client: BorosOrderClient = {
      ...recordingClient(calls),
      placeMarketOrders: async (reqs, opts) => {
        calls.placed.push({ reqs, opts });
        started();
        await gate;
        if (outcome === 'throw') throw new Error('ECONNRESET while waiting for the relayer');
        return reqs.map((r) => fill(r.marketId, r.direction, r.size));
      },
    };
    app = makeTestApp({ borosFetch: borosStub(bodies(held)), getBorosOrders: () => client });
    return { release, sent };
  }
  const held = (size: number): Held[] => [
    { marketId: HL_OCT, size: -size },
    { marketId: GATE_OCT, size },
  ];
  const twoIntoSpread = (size: number, tag: string) =>
    rollBody([leg(HL_OCT, 'long', size), leg(GATE_OCT, 'short', size)], [leg(SPREAD_NOV, 'short', size)], tag);

  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('refuses a second roll of the pair while the first is in flight, then frees the lock (%s)', async (_label, size) => {
    const { release, sent } = gatedApp(held(size));
    const first = post('/api/boros/roll/execute', twoIntoSpread(size, 'one'));
    await sent;
    const second = await post('/api/boros/roll/execute', twoIntoSpread(size, 'two'));
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.message).toBe('An order on this market is already running.');
    expect(calls.placed).toHaveLength(1);
    release();
    expect((await first).statusCode).toBe(200);
    const third = await post('/api/boros/roll/execute', twoIntoSpread(size, 'three'));
    expect(third.statusCode, third.body).toBe(200);
    expect(calls.placed).toHaveLength(2);
  });

  it('refuses a close on an exit market while a roll is in flight', async () => {
    const { release, sent } = gatedApp(held(SIZE_6M));
    const roll = post('/api/boros/roll/execute', twoIntoSpread(SIZE_6M, 'roll'));
    await sent;
    const close = await post('/api/boros/pair/execute', {
      address: ADDRESS,
      intent: 'close',
      opposingAcknowledged: true,
      legs: [{ ...leg(HL_OCT, 'long', SIZE_6M), clientOrderId: 'close-hl' }],
    });
    expect(close.statusCode, close.body).toBe(409);
    expect(close.json().error.message).toBe('A close on this market is already running.');
    expect(calls.placed).toHaveLength(1);
    release();
    expect((await roll).statusCode).toBe(200);
  });

  it('frees the lock after a roll the venue never answered, and after a refused one', async () => {
    const { release, sent } = gatedApp(held(SIZE_50), 'throw');
    const lost = post('/api/boros/roll/execute', twoIntoSpread(SIZE_50, 'lost'));
    await sent;
    release();
    expect((await lost).json().data.result.status).toBe('unknown');
    const refused = await post(
      '/api/boros/roll/execute',
      rollBody([leg(HL_OCT, 'long', SIZE_50), leg(GATE_OCT, 'short', SIZE_50)], [leg(SPREAD_NOV, 'short', SIZE_50 * 2)], 'bad'),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().data.blockers.length).toBeGreaterThan(0);
    const again = await post('/api/boros/roll/execute', twoIntoSpread(SIZE_50, 'again'));
    expect(again.statusCode, again.body).toBe(200);
    expect(calls.placed).toHaveLength(2);
  });
});
