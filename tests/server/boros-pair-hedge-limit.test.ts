/**
 * /api/boros/pair/* with a `hedge`: the open is refused before any Boros send
 * when the perps that hedge it would break their CrossEx position limit.
 * CrossEx refuses those perps only after the Boros legs have filled.
 */
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BorosLegFill, BorosMarketOrderRequest, BorosOrderClient } from '../../src/core/boros/orders';
import { Store } from '../../src/engine/db';
import { account, ADDRESS, BN, HL, market, wireBook } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const HEDGE = { base: 'ETH', longVenue: 'HYPERLIQUID', shortVenue: 'OKX' };

const rule = (symbol: string) => ({
  symbol,
  state: 'live',
  business_type: 'FUTURE',
  lot_size: '0.001',
  min_size: '0',
  min_notional: '0',
  tick_size: '0.01',
  max_market_size: '10000',
  max_limit_size: '10000',
});

/** Gate reads the check makes. `capUsd` is the top tier's cap; the terminal
 * keeps 98% of it, and a plan 99% of that. */
function gateReads(capUsd: number, positions: unknown[] = []): void {
  const tiers = (symbol: string) => ({ symbol, tiers: [{ max_risk_limit_value: String(capUsd), leverage_max: '50' }] });
  mockGateGet('/rule/symbols', { body: [rule(A_CONTRACT), rule(B_CONTRACT)], times: 5 });
  mockGateGet('/rule/risk_limits', { body: [tiers(A_CONTRACT), tiers(B_CONTRACT)], times: 5 });
  mockGateGet('/positions', { body: positions, times: 5 });
  mockGateGet('/open_orders', { body: [], times: 10 });
}

const fill = (r: BorosMarketOrderRequest): BorosLegFill => ({
  marketId: r.marketId,
  direction: r.direction,
  filledSize: r.size,
  shortfallSize: 0,
  execApr: 0.09,
  feeSize: 4,
  failure: null,
});

let app: FastifyInstance | null = null;
let place: ReturnType<typeof vi.fn<(r: BorosMarketOrderRequest) => Promise<BorosLegFill>>>;
beforeEach(() => {
  process.env.BOROS_ROOT_ADDRESS = ADDRESS;
  place = vi.fn(async (r: BorosMarketOrderRequest) => fill(r));
  const client: BorosOrderClient = {
    placeMarketOrders: async (reqs) => Promise.all(reqs.map((r) => place(r))),
    cancelOrders: async () => {},
    closePosition: async () => fill({ marketId: HL, direction: 'short', size: 0 } as BorosMarketOrderRequest),
  };
  app = makeTestApp({
    borosFetch: borosStub({
      '/apis/v1/markets': { results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.045)] },
      [`/apis/v1/markets/order-book?marketId=${HL}`]: wireBook(900, 920),
      [`/apis/v1/markets/order-book?marketId=${BN}`]: wireBook(400, 420),
      ...account(500_000),
    }),
    getBorosOrders: () => client,
    engine: { store: new Store(':memory:'), venue: new FakeVenue(), clock: new VirtualClock() },
  });
});
afterEach(async () => {
  await app?.close();
  app = null;
  nock.cleanAll();
  delete process.env.BOROS_ROOT_ADDRESS;
});

// USDT collateral: a 100,000 open needs $100,000 of each perp.
const body = (over: Record<string, unknown> = {}) => ({
  address: ADDRESS,
  legs: [
    { marketId: HL, direction: 'short', slippageApr: 0.0025, size: 100_000, clientOrderId: 'coid-hedge-1' },
    { marketId: BN, direction: 'long', slippageApr: 0.0025, size: 100_000, clientOrderId: 'coid-hedge-2' },
  ],
  intent: 'open',
  hedge: HEDGE,
  ...over,
});

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, headers: HOST, payload: payload as object });

const codes = (blockers: Array<{ code: string }>) => blockers.map((b) => b.code);

describe('the hedge position limit on a Boros open', () => {
  it('blocks an open whose perps would pass 99% of the limit, and names the room left', async () => {
    gateReads(100_000);
    const res = await post('/api/boros/pair/simulate', body());
    expect(res.statusCode, res.body).toBe(200);
    const blocker = res.json().data.gate.blockers.find((b: { code: string }) => b.code === 'perp-limit');
    expect(blocker.message).toBe(
      `The hedge takes ${A_CONTRACT} to $100,000, above $97,020 (3% under the CrossEx risk-limit cap). The perps can add at most $97,020.`,
    );
  });

  it('passes an open under 99% of the limit', async () => {
    gateReads(1_000_000);
    const res = await post('/api/boros/pair/simulate', body());
    expect(codes(res.json().data.gate.blockers)).not.toContain('perp-limit');
  });

  it('counts the perps already held on that side', async () => {
    // Holding 380 ETH short at $2,500 on OKX ($950,000): adding $100,000 passes $970,200.
    gateReads(1_000_000, [{ symbol: B_CONTRACT, position_qty: '-380' }]);
    const res = await post('/api/boros/pair/simulate', body());
    const blocker = res.json().data.gate.blockers.find((b: { code: string }) => b.code === 'perp-limit');
    expect(blocker.message).toMatch(new RegExp(`^The hedge takes ${B_CONTRACT} to \\$1,050,000, above \\$970,200 .*at most \\$20,200\\.$`));
  });

  it('a perp held the other way makes room', async () => {
    gateReads(100_000, [{ symbol: A_CONTRACT, position_qty: '-40' }]);
    const res = await post('/api/boros/pair/simulate', body({ hedge: { ...HEDGE, shortVenue: null } }));
    expect(codes(res.json().data.gate.blockers)).not.toContain('perp-limit');
  });

  it('execute refuses with a 409 and sends nothing to Boros', async () => {
    gateReads(100_000);
    const res = await post('/api/boros/pair/execute', body());
    expect(res.statusCode, res.body).toBe(409);
    expect(codes(res.json().data.blockers)).toContain('perp-limit');
    expect(place).not.toHaveBeenCalled();
  });

  it('blocks when the limit cannot be read', async () => {
    mockGateGet('/rule/symbols', { body: [rule(A_CONTRACT), rule(B_CONTRACT)], times: 5 });
    mockGateGet('/rule/risk_limits', { body: [{ symbol: A_CONTRACT, tiers: [] }], times: 5 });
    mockGateGet('/positions', { body: [], times: 5 });
    mockGateGet('/open_orders', { body: [], times: 10 });
    const res = await post('/api/boros/pair/simulate', body());
    const blocker = res.json().data.gate.blockers.find((b: { code: string }) => b.code === 'perp-limit');
    expect(blocker.message).toBe('Could not check the hedge against the perp position limit. Try again.');
  });

  it('reads no perp limit for an open with no hedge', async () => {
    const res = await post('/api/boros/pair/simulate', body({ hedge: undefined }));
    expect(codes(res.json().data.gate.blockers)).toEqual([]);
  });
});
