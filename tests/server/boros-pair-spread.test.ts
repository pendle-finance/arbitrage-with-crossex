import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BorosLegFill,
  BorosMarketOrderRequest,
  BorosOrderClient,
  PlaceOrdersOptions,
} from '../../src/core/boros/orders';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NOW_MS = Date.UTC(2026, 9, 8);
const ADDRESS = '0x1111111111111111111111111111111111111111';
const ETH_USD = 2571.7;
const SIZE_50 = 50 / ETH_USD;
const SIZE_6M = 6_000_000 / ETH_USD;

const HL_SINGLE = 51;
const SPREAD = 59;
const GATE_SINGLE = 60;
const SPREAD_IDS = [58, 59, 63];

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
) as { results: Array<{ marketId: number; data: { midApr: number }; config: { status: number } }> };

const wei = (n: number): string => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

const wireBook = (midApr: number) => ({
  short: { ia: [Math.round((midApr + 0.001) * 10_000)], sz: [raw(1_000_000)] },
  long: { ia: [Math.round((midApr - 0.001) * 10_000)], sz: [raw(1_000_000)] },
});

type Held = { marketId: number; size: number };

function bodies(held: Held[] = [], status: Record<number, number> = {}): Record<string, unknown> {
  const acc = marketAcc(ADDRESS, 2);
  const results = fixture.results.map((m) =>
    status[m.marketId] === undefined ? m : { ...m, config: { ...m.config, status: status[m.marketId] } },
  );
  const books = Object.fromEntries(
    fixture.results.map((m) => [`/apis/v1/markets/order-book?marketId=${m.marketId}`, wireBook(m.data.midApr)]),
  );
  return {
    '/apis/v1/markets': { results, total: results.length, skip: 0 },
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

const fill = (r: BorosMarketOrderRequest): BorosLegFill => ({
  marketId: r.marketId,
  direction: r.direction,
  filledSize: r.size,
  shortfallSize: 0,
  execApr: 0.06,
  feeSize: 0.001,
  failure: null,
});

type Placed = { reqs: BorosMarketOrderRequest[]; opts: PlaceOrdersOptions | undefined };

function recordingClient(placed: Placed[], failFirst = 0): BorosOrderClient {
  let failures = failFirst;
  return {
    placeMarketOrders: async (reqs, opts) => {
      placed.push({ reqs, opts });
      if (failures-- > 0) throw new Error('ECONNRESET while waiting for the relayer');
      return reqs.map(fill);
    },
    cancelOrders: async () => {},
    closePosition: async (r) => fill({ ...r, limitApr: 0 }),
  };
}

let app: FastifyInstance | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
});
afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.BOROS_ROOT_ADDRESS;
  vi.useRealTimers();
});

function makeApp(held: Held[] = [], client?: BorosOrderClient, status: Record<number, number> = {}) {
  app = makeTestApp({ borosFetch: borosStub(bodies(held, status)), getBorosOrders: () => client });
  return app;
}

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, headers: HOST, payload: payload as object });

const leg = (marketId: number, direction: 'long' | 'short', size: number, clientOrderId?: string) => ({
  marketId,
  direction,
  slippageApr: 0.0025,
  size,
  ...(clientOrderId ? { clientOrderId } : {}),
});

describe('GET /api/boros/pair/context with spread markets', () => {
  it('picker hides spread markets', async () => {
    makeApp();
    const res = await app!.inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
    expect(res.statusCode, res.body).toBe(200);
    const { data } = res.json();
    const ids = data.markets.map((m: { marketId: number }) => m.marketId);
    expect(ids).toEqual(expect.arrayContaining([HL_SINGLE, GATE_SINGLE]));
    expect(ids.some((id: number) => SPREAD_IDS.includes(id))).toBe(false);
    expect(data.markets.every((m: { spreadVenues: unknown }) => m.spreadVenues === null)).toBe(true);
    const spreads = data.spreadMarkets as Array<{ marketId: number; spreadVenues: unknown }>;
    expect(spreads.map((m) => m.marketId)).toEqual(expect.arrayContaining([SPREAD, 63]));
    expect(spreads.every((m) => Array.isArray(m.spreadVenues))).toBe(true);
    expect(spreads.find((m) => m.marketId === SPREAD)?.spreadVenues).toEqual(['HYPERLIQUID', 'GATE']);
  });

  it('lists a paused or close-only spread the trader does not hold as close-only, and refuses to open it', async () => {
    const placed: Placed[] = [];
    makeApp([], recordingClient(placed), { [SPREAD]: 0, 63: 1 });
    const res = await app!.inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
    expect(res.statusCode, res.body).toBe(200);
    const spreads = res.json().data.spreadMarkets as Array<{ marketId: number; closeOnly: boolean; paused: boolean }>;
    expect(Object.fromEntries(spreads.map((m) => [m.marketId, m.closeOnly]))).toEqual({ 58: false, [SPREAD]: true, 63: true });
    const paused = Object.fromEntries(spreads.map((m) => [m.marketId, m.paused]));
    expect(paused).toEqual({ 58: false, [SPREAD]: true, 63: false });

    for (const marketId of [SPREAD, 63]) {
      const sim = await post('/api/boros/pair/simulate', { address: ADDRESS, legs: [leg(marketId, 'short', SIZE_6M)], intent: 'open' });
      expect(sim.statusCode, sim.body).toBe(200);
      expect(sim.json().data.gate.blockers.length).toBeGreaterThan(0);
      const exec = await post('/api/boros/pair/execute', {
        address: ADDRESS,
        legs: [leg(marketId, 'short', SIZE_6M, `open-paused-${marketId}`)],
        intent: 'open',
      });
      expect(exec.statusCode, exec.body).toBe(409);
    }
    expect(placed).toHaveLength(0);
  });
});

describe('POST /api/boros/pair/simulate and /execute on one spread leg', () => {
  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('one-leg open quotes the spread (%s)', async (_label, size) => {
    makeApp([], recordingClient([]));
    const res = await post('/api/boros/pair/simulate', {
      address: ADDRESS,
      legs: [leg(SPREAD, 'short', size)],
      intent: 'open',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { simulation, gate } = res.json().data;
    expect(simulation.legs).toHaveLength(1);
    expect(simulation.receiveLeg).toBe(0);
    expect(simulation.feeDragApr).toBeCloseTo(0.002, 12);
    expect(simulation.estSpreadApr).toBeCloseTo(simulation.legs[0].execApr - simulation.feeDragApr, 12);
    expect(Math.abs(simulation.legs[0].sizing.deltaSize)).toBe(size);
    expect(gate.blockers).toEqual([]);
  });

  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('one-leg open sends one order (%s)', async (_label, size) => {
    const placed: Placed[] = [];
    makeApp([], recordingClient(placed));
    const res = await post('/api/boros/pair/execute', {
      address: ADDRESS,
      legs: [leg(SPREAD, 'short', size, 'coid-spread-open')],
      intent: 'open',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(placed).toHaveLength(1);
    expect(placed[0].reqs).toHaveLength(1);
    expect(placed[0].reqs[0]).toMatchObject({ marketId: SPREAD, direction: 'short', size, clientOrderId: 'coid-spread-open' });
    expect(placed[0].reqs[0].limitApr).toBeLessThan(fixture.results.find((m) => m.marketId === SPREAD)!.data.midApr);
    const { result } = res.json().data;
    expect(result.legs).toHaveLength(1);
    expect(result.allLegsSubmitted).toBe(true);
    expect(result.legs[0].filledSize).toBe(size);
  });

  it.each([
    ['$50', SIZE_50],
    ['$6M', SIZE_6M],
  ])('spread open replays a resend (%s)', async (_label, size) => {
    const placed: Placed[] = [];
    makeApp([], recordingClient(placed));
    const body = {
      address: ADDRESS,
      legs: [leg(SPREAD, 'short', size, 'coid-spread-replay')],
      intent: 'open',
    };

    const first = await post('/api/boros/pair/execute', body);
    const second = await post('/api/boros/pair/execute', body);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(placed).toHaveLength(1);
    expect(first.json().data.replayed).toBe(false);
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.result).toEqual(first.json().data.result);
  });

  it('an open never mixes', async () => {
    const placed: Placed[] = [];
    makeApp([], recordingClient(placed));
    const res = await post('/api/boros/pair/execute', {
      address: ADDRESS,
      legs: [leg(HL_SINGLE, 'short', 0.3, 'coid-mix-hl'), leg(SPREAD, 'long', 0.3, 'coid-mix-spread')],
      intent: 'open',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('spread or single markets, not both');
    expect(placed).toHaveLength(0);
  });

  it('refuses an empty legs list before pricing', async () => {
    makeApp([], recordingClient([]));
    const res = await post('/api/boros/pair/simulate', { address: ADDRESS, legs: [], intent: 'open' });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/boros/pair/execute, a mixed close', () => {
  const books: Array<[string, number, number, number]> = [
    ['A14 sizes', 0.3, 0.3, 0.255],
    ['$6M', SIZE_6M, SIZE_6M, SIZE_6M * 0.85],
  ];
  const heldFor = (hl: number, gate: number, spread: number): Held[] => [
    { marketId: HL_SINGLE, size: -hl },
    { marketId: GATE_SINGLE, size: gate },
    { marketId: SPREAD, size: -spread },
  ];
  const closeBody = (hl: number, gate: number, spread: number, tag: string) => ({
    address: ADDRESS,
    legs: [
      leg(HL_SINGLE, 'long', hl, `coid-${tag}-51`),
      leg(GATE_SINGLE, 'short', gate, `coid-${tag}-60`),
      leg(SPREAD, 'long', spread, `coid-${tag}-59`),
    ],
    intent: 'close',
    opposingAcknowledged: true,
  });

  it.each(books)('mixed close is one batch (%s)', async (_label, hl, gate, spread) => {
    const placed: Placed[] = [];
    makeApp(heldFor(hl, gate, spread), recordingClient(placed));
    const res = await post('/api/boros/pair/execute', closeBody(hl, gate, spread, 'close1'));
    expect(res.statusCode, res.body).toBe(200);
    expect(placed).toHaveLength(1);
    expect(placed[0].opts?.reducing).toBe(true);
    expect(placed[0].reqs.map((r) => [r.marketId, r.direction])).toEqual([
      [HL_SINGLE, 'long'],
      [GATE_SINGLE, 'short'],
      [SPREAD, 'long'],
    ]);
    const sent = placed[0].reqs.map((r) => r.size);
    expect(sent[0]).toBeLessThanOrEqual(hl);
    expect(sent[1]).toBeLessThanOrEqual(gate);
    expect(sent[2]).toBeLessThanOrEqual(spread);
    expect(sent[0]).toBeCloseTo(hl, 6);
    expect(sent[2]).toBeCloseTo(spread, 6);
    for (const r of placed[0].reqs) {
      if (r.sizeWei !== undefined) expect(BigInt(r.sizeWei)).toBeLessThanOrEqual(BigInt(wei(r.marketId === SPREAD ? spread : r.marketId === HL_SINGLE ? hl : gate)));
    }
  });

  it.each(books)('mixed close is all or none (%s)', async (_label, hl, gate, spread) => {
    const placed: Placed[] = [];
    makeApp(heldFor(hl, gate, spread), recordingClient(placed, 1));
    const res = await post('/api/boros/pair/execute', closeBody(hl, gate, spread, 'close2'));
    expect(res.statusCode, res.body).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/may have filled/);
    const legs = body.data.result.legs as BorosLegFill[];
    expect(legs).toHaveLength(3);
    expect(legs.every((l) => l.filledSize === 0)).toBe(true);
    expect(placed).toHaveLength(1);

    const retry = await post('/api/boros/pair/execute', closeBody(hl, gate, spread, 'close3'));
    expect(retry.statusCode).toBe(200);
    expect(placed).toHaveLength(2);
    expect(placed[1].reqs.map((r) => r.marketId)).toEqual([HL_SINGLE, GATE_SINGLE, SPREAD]);
  });

  it.each(books)('three-leg close replays a resend (%s)', async (_label, hl, gate, spread) => {
    const placed: Placed[] = [];
    makeApp(heldFor(hl, gate, spread), recordingClient(placed));
    const body = closeBody(hl, gate, spread, 'replay3');

    const first = await post('/api/boros/pair/execute', body);
    const second = await post('/api/boros/pair/execute', { ...body, legs: [...body.legs].reverse() });

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(placed).toHaveLength(1);
    expect(first.json().data.replayed).toBe(false);
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.result).toEqual(first.json().data.result);
  });

  it.each(books)('three-leg close holds the lock on every market (%s)', async (_label, hl, gate, spread) => {
    const placed: Placed[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const placing = new Promise<void>((resolve) => (entered = resolve));
    const inner = recordingClient(placed);
    makeApp(heldFor(hl, gate, spread), {
      ...inner,
      placeMarketOrders: async (reqs, opts) => {
        entered();
        await hold;
        return inner.placeMarketOrders(reqs, opts);
      },
    });
    const single = (marketId: number, id: string) =>
      post(`/api/boros/pair/market/${marketId}/cancel-and-close`, { clientOrderId: id });

    const running = post('/api/boros/pair/execute', closeBody(hl, gate, spread, 'lock3'));
    await Promise.race([placing, running]);

    for (const marketId of [SPREAD, HL_SINGLE, GATE_SINGLE]) {
      const refused = await single(marketId, `coid-lock-refused-${marketId}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toBe('A close on this market is already running.');
    }

    release();
    expect((await running).statusCode).toBe(200);
    const after = await single(SPREAD, 'coid-lock-after');
    expect(after.statusCode, after.body).toBe(200);
  });
});
