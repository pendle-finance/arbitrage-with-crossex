import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { halfCapSeedPct } from '../../src/core/boros/rollProbe';
import type { BorosLegFill, BorosMarketOrderRequest, BorosOrderClient } from '../../src/core/boros/orders';
import type { AppDeps } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import { closeBorosLegs, forgetBorosExecutions, MAY_HAVE_FILLED, type BorosCloseDeps } from '../../src/server/borosClose';
import { createPairPricer } from '../../src/server/routes/borosPair';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SPREAD = 59;
const ETH_USD = 2571.7;

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/boros/spread-2026-10-08.json', import.meta.url), 'utf8'),
) as { results: Array<{ marketId: number; data: { midApr: number }; config: { status: number } }> };

const wei = (n: number): string => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

const wireBook = (midApr: number) => ({
  short: { ia: [Math.round((midApr + 0.001) * 10_000)], sz: [raw(1_000_000)] },
  long: { ia: [Math.round((midApr - 0.001) * 10_000)], sz: [raw(1_000_000)] },
});

function bodies(held: number): Record<string, unknown> {
  const acc = marketAcc(ADDRESS, 2);
  return {
    '/apis/v1/markets': { results: fixture.results, total: fixture.results.length, skip: 0 },
    ...Object.fromEntries(
      fixture.results.map((m) => [`/apis/v1/markets/order-book?marketId=${m.marketId}`, wireBook(m.data.midApr)]),
    ),
    '/apis/v1/accounts/market-acc-infos-by-root': {
      results: [
        {
          marketAcc: acc,
          netBalance: raw(100_000_000),
          initialMargin: raw(0),
          positions: [{ marketId: SPREAD, signedSize: wei(-held), initialMargin: raw(0), orders: [] }],
        },
      ],
    },
    '/apis/v1/accounts/active-positions': {
      results: [
        {
          marketAcc: acc,
          marketId: SPREAD,
          side: 1,
          fixedApr: 0.06,
          signedSize: wei(-held),
          unrealisedPnl: '0',
          settlementPnl: '0',
        },
      ],
    },
  };
}

const fillOf = (r: BorosMarketOrderRequest, part: number): BorosLegFill => ({
  marketId: r.marketId,
  direction: r.direction,
  filledSize: r.size * part,
  shortfallSize: r.size * (1 - part),
  execApr: 0.06,
  feeSize: 0.001,
  failure: null,
});

function setup(held: number, part: number) {
  const placed: BorosMarketOrderRequest[][] = [];
  const client: BorosOrderClient = {
    placeMarketOrders: async (reqs) => {
      placed.push(reqs);
      return reqs.map((r) => fillOf(r, part));
    },
    cancelOrders: async () => {},
    closePosition: async (r) => fillOf({ ...r, limitApr: 0 }, part),
  };
  const appDeps = {
    cache: new TtlCache(),
    borosFetch: borosStub(bodies(held)),
    getBorosOrders: () => client,
    borosSettle: { maxMs: 0 },
  } as unknown as AppDeps;
  const pricer = createPairPricer(appDeps);
  const deps: BorosCloseDeps = {
    getBorosOrders: appDeps.getBorosOrders,
    checkCanTrade: async () => {},
    parseTradableAddress: (value) => String(value),
    pricer,
  };
  return { placed, deps, pricer };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 8));
  forgetBorosExecutions();
});
afterEach(() => vi.useRealTimers());

describe('closeBorosLegs on a spread market', () => {
  it.each([
    ['$50', 50 / ETH_USD],
    ['$6M', 6_000_000 / ETH_USD],
  ])('closes the share, capped at the live size minus keep, with the seed (%s)', async (_label, held) => {
    const { placed, deps, pricer } = setup(held, 1);
    const market = (await pricer.loadMarkets(false)).find((m) => m.marketId === SPREAD)!;
    expect(market.spreadVenues).not.toBeNull();
    const seed = halfCapSeedPct([market.maxRateDeviationApr ?? 0]);
    expect(seed).not.toBeNull();

    const share = held * 0.4;
    const keep = held * 0.5;
    const res = await closeBorosLegs(deps, {
      address: ADDRESS,
      legs: [{ marketId: SPREAD, size: share, keep }],
      slippagePct: seed as number,
      clientOrderId: 'dl-1',
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toHaveLength(1);
    expect(placed[0][0]).toMatchObject({ marketId: SPREAD, direction: 'long', clientOrderId: 'dl-1-59' });
    expect(placed[0][0].size).toBeCloseTo(share, 6);
    expect(placed[0][0].size).toBeLessThanOrEqual(held - keep);
    expect(res.held).toEqual([{ marketId: SPREAD, size: expect.closeTo(held, 6) }]);
    expect(res.filled[0].size).toBeCloseTo(share, 6);
    expect(res.rest[0].size).toBe(0);

    const narrow = setup(held, 1);
    await closeBorosLegs(narrow.deps, {
      address: ADDRESS,
      legs: [{ marketId: SPREAD, size: share, keep }],
      slippagePct: (seed as number) / 2,
      clientOrderId: 'dl-2',
    });
    expect(Math.abs(narrow.placed[0][0].limitApr - placed[0][0].limitApr)).toBeCloseTo((seed as number) / 200, 9);
  });

  it('caps the share at the live size minus keep', async () => {
    const held = 0.3;
    const { placed, deps } = setup(held, 1);
    const res = await closeBorosLegs(deps, {
      address: ADDRESS,
      legs: [{ marketId: SPREAD, size: 0.25, keep: 0.2 }],
      slippagePct: 1,
      clientOrderId: 'dl-cap',
    });
    expect(placed[0][0].size).toBeCloseTo(0.1, 6);
    expect(res.filled[0].size).toBeCloseTo(0.1, 6);
  });

  it('a part fill reports the filled and the rest, and held stays the size before the close', async () => {
    const held = 0.3;
    const { placed, deps } = setup(held, 0.5);
    const res = await closeBorosLegs(deps, {
      address: ADDRESS,
      legs: [{ marketId: SPREAD, size: 0.12, keep: 0.1 }],
      slippagePct: 1,
      clientOrderId: 'dl-part',
    });
    expect(placed[0][0].size).toBeCloseTo(0.12, 6);
    expect(res.filled[0].size).toBeCloseTo(0.06, 6);
    expect(res.rest[0].size).toBeCloseTo(0.06, 6);
    expect(res.held[0].size).toBeCloseTo(held, 6);
  });

  it.each([
    ['$50', 50 / ETH_USD],
    ['$6M', 6_000_000 / ETH_USD],
  ])('onSend runs once before the submit, so a submit that times out still leaves the send recorded (%s)', async (_label, held) => {
    const { deps } = setup(held, 1);
    const events: string[] = [];
    const client = deps.getBorosOrders!()!;
    deps.getBorosOrders = () => ({
      ...client,
      placeMarketOrders: async () => {
        events.push('submit');
        throw new Error('timeout of 30000ms exceeded');
      },
    });
    const row: { sent: { size: number } | null } = { sent: null };
    const share = held * 0.4;

    await expect(
      closeBorosLegs(deps, {
        address: ADDRESS,
        legs: [{ marketId: SPREAD, size: share, keep: held * 0.5 }],
        slippagePct: 1,
        clientOrderId: 'dl-timeout',
        onSend: () => {
          events.push('onSend');
          row.sent = { size: share };
        },
      }),
    ).rejects.toThrow(MAY_HAVE_FILLED);
    expect(events).toEqual(['onSend', 'submit']);
    expect(row.sent).toEqual({ size: share });
  });

  it('a leg that comes back unknown without an error rejects the close', async () => {
    const held = 0.3;
    const { deps } = setup(held, 1);
    const client = deps.getBorosOrders!()!;
    deps.getBorosOrders = () => ({
      ...client,
      placeMarketOrders: async (reqs) =>
        reqs.map((r) => ({ ...fillOf(r, 0), execApr: null, feeSize: null, failure: { code: 'unknown' as const, message: 'Boros did not confirm the order' } })),
    });
    let sent = false;

    await expect(
      closeBorosLegs(deps, {
        address: ADDRESS,
        legs: [{ marketId: SPREAD, size: 0.12, keep: 0.1 }],
        slippagePct: 1,
        clientOrderId: 'dl-unknown',
        onSend: () => {
          sent = true;
        },
      }),
    ).rejects.toThrow('Boros did not confirm the order');
    expect(sent).toBe(true);
  });
});
