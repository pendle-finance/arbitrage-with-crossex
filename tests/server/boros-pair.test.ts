/**
 * /api/boros/pair/* — body validation, the context join, and the two things
 * that actually protect money: the gate is re-run SERVER-SIDE at execute (a
 * client that skips it gets a 409, not a fill), and the books that back an
 * order come from their own short-TTL key rather than the scan's 30s one.
 *
 * Boros is stubbed through the AppDeps.borosFetch seam; the write port through
 * AppDeps.borosOrders. Money pins live in tests/unit/boros-pair.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BorosLegFill,
  BorosMarketOrderRequest,
  BorosOrderClient,
} from '../../src/core/boros/orders';
import { borosExecutionsPending } from '../../src/server/routes/borosPair';
import { imInputs, raw } from '../helpers/boros-fixtures';
import { TtlCache } from '../../src/server/cache';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;
const ADDRESS = '0x1111111111111111111111111111111111111111';
/** The account the agent signs for. Write routes are bound to it. */
const OTHER = '0x2222222222222222222222222222222222222222';

const HL = 155;
const BN = 158;
/** A third market, for the cases that need an odd one out alongside a pair. */
const OK = 161;

const market = (marketId: number, platformName: string, midApr: number) => ({
  marketId,
  tokenId: 3,
  state: 'Normal',
  imData: {
    name: `${platformName} ETH 30d`,
    maturity: MATURITY,
    iTickThresh: imInputs.imTickThresh,
    tickStep: imInputs.imTickStep,
  },
  extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
  metadata: { platformName, assetSymbol: 'ETH' },
  config: { takerFee: '500000000000000', kIM: raw(imInputs.kIM), tThresh: imInputs.tThreshSec },
  data: { midApr, markApr: midApr, floatingApr: 0.05, notionalOI: 12_000_000, assetMarkPrice: 1900 },
});

/** Books in Boros wire shape: `short` is the ASK side, `long` the BID side. */
const wireBook = (bidTick: number, askTick: number, size = 20_000_000) => ({
  short: { ia: [askTick], sz: [raw(size)] },
  long: { ia: [bidTick], sz: [raw(size)] },
});

function bodies(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '/core/v1/markets': { results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.045)] },
    [`/core/v1/order-books/${HL}`]: wireBook(900, 920),
    [`/core/v1/order-books/${BN}`]: wireBook(400, 420),
    '/core/v1/collaterals/summary': {
      collaterals: [
        {
          tokenId: 3,
          crossPosition: { netBalance: raw(500_000), marketPositions: [] },
          isolatedPositions: [],
        },
      ],
    },
    ...over,
  };
}

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

function orderClient(place?: (req: BorosMarketOrderRequest) => Promise<BorosLegFill>): BorosOrderClient {
  const one = place ?? (async (r) => okFill({ marketId: r.marketId, direction: r.direction }));
  return {
    // The route submits both legs as ONE batch; the per-leg script is applied
    // to each entry so existing scenarios read unchanged.
    placeMarketOrders: async (reqs) => Promise.all(reqs.map((r) => one(r))),
    cancelOrders: async () => {},
    closePosition: async () => okFill(),
  };
}

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

function makeApp(over: Record<string, unknown> = {}, calls?: string[], client?: BorosOrderClient) {
  app = makeTestApp({ borosFetch: borosStub(bodies(over), calls), getBorosOrders: () => client });
  return app;
}

const pairBody = (over: Record<string, unknown> = {}) => ({
  address: ADDRESS,
  legA: { marketId: HL, direction: 'short', slippageApr: 0.0025 },
  legB: { marketId: BN, direction: 'long', slippageApr: 0.0025 },
  size: 100_000,
  intent: 'open',
  ...over,
});

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, headers: HOST, payload: payload as object });

describe('GET /api/boros/pair/context', () => {
  it('returns the tradable universe with this account\'s per-market state', async () => {
    const res = await makeApp().inject({
      method: 'GET',
      url: `/api/boros/pair/context?address=${ADDRESS}`,
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.markets.map((m: { marketId: number }) => m.marketId).sort()).toEqual([HL, BN].sort());
    expect(data.markets[0]).toMatchObject({ tokenId: 3, maturity: MATURITY, currentSize: 0 });
    expect(data.crossByToken).toEqual([{ tokenId: 3, available: 500_000 }]);
    expect(data.defaultSlippageApr).toBeGreaterThan(0);
  });

  it('rejects a malformed address', async () => {
    const res = await makeApp().inject({
      method: 'GET',
      url: '/api/boros/pair/context?address=nope',
      headers: HOST,
    });
    expect(res.statusCode).toBe(400);
  });

  it('omits Hyperliquid xyz: synthetics — nothing here can hedge or pair them', async () => {
    // BRENTOIL and friends are index markets with no CrossEx perp behind them,
    // and each is the only market at its base AND maturity, so a pair ticket
    // can never find one a partner. Listing them offered a market whose every
    // simulation was dead on arrival.
    //
    // The two ETH markets are the CONTROL: they pair with each other, so the
    // only thing this asserts is that the synthetic is gone. Without a viable
    // pair here the no-partner filter would empty the list and the test would
    // pass for the wrong reason.
    const synthetic = market(OK, 'Hyperliquid', 0.05);
    synthetic.metadata.assetSymbol = 'xyz:BRENTOIL';
    const res = await makeApp({
      '/core/v1/markets': {
        results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.07), synthetic],
      },
    }).inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
    expect(res.json().data.markets.map((m: { marketId: number }) => m.marketId)).toEqual([BN, HL]);
  });

  it('omits matured and halted markets', async () => {
    const dead = market(OK, 'OKX', 0.045);
    dead.imData.maturity = NOW - 1;
    const res = await makeApp({
      '/core/v1/markets': {
        results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.07), dead],
      },
    }).inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
    expect(res.json().data.markets.map((m: { marketId: number }) => m.marketId)).toEqual([BN, HL]);
  });

  it('omits a market nothing shares its maturity, collateral AND base with', async () => {
    // The general rule the `xyz:` prefix was only ever a proxy for. Here the
    // odd one out is a perfectly ordinary market: a lone BTC market sitting in
    // a cohort of ETH markets. It is ELIGIBLE by pairEligibility (same
    // collateral, same maturity) but its only partners would be a different
    // coin, which is not a spread — so the ticket must not offer it.
    const lone = market(OK, 'OKX', 0.06);
    lone.metadata.assetSymbol = 'BTC';
    const res = await makeApp({
      '/core/v1/markets': {
        results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.07), lone],
      },
    }).inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
    expect(res.json().data.markets.map((m: { marketId: number }) => m.marketId)).toEqual([BN, HL]);
  });

  it('keeps two markets that share maturity, collateral and base', async () => {
    // The guard against over-filtering: the ordinary two-venue pair this whole
    // terminal exists to trade must survive.
    const res = await makeApp({
      '/core/v1/markets': {
        results: [market(HL, 'Hyperliquid', 0.09), market(BN, 'Binance', 0.07)],
      },
    }).inject({ method: 'GET', url: `/api/boros/pair/context?address=${ADDRESS}`, headers: HOST });
    expect(res.json().data.markets.map((m: { marketId: number }) => m.marketId)).toEqual([BN, HL]);
  });
});

describe('boros writes bust the reads they invalidate', () => {
  /** An app whose cache records every bust, so the route's promise is testable. */
  function appWithBustSpy(client?: BorosOrderClient) {
    const busted: string[] = [];
    const cache = new TtlCache();
    const realBust = cache.bust.bind(cache);
    cache.bust = ((prefix: string) => {
      busted.push(prefix);
      return realBust(prefix);
    }) as typeof cache.bust;
    app = makeTestApp({
      borosFetch: borosStub(bodies()),
      getBorosOrders: () => client ?? orderClient(),
      cache,
    });
    return { busted };
  }

  it('an OPEN busts the cached Boros reads, like a close does', async () => {
    // `/strategy` serves boros:collaterals from a 30s TTL. Without this bust a
    // freshly opened leg could be invalidated client-side, refetched at once,
    // and STILL come back from the pre-trade snapshot — the position appeared
    // only when the TTL happened to lapse, which is what "it takes a while and
    // sometimes I have to refresh" actually was.
    const { busted } = appWithBustSpy();
    const res = await post('/api/boros/pair/execute', pairBody({ clientOrderIdA: 'coid-bust-a', clientOrderIdB: 'coid-bust-b' }));
    expect(res.statusCode).toBe(200);
    expect(busted).toContain('boros:collaterals');
    expect(busted).toContain('boros:txns');
  });
});

describe('POST /api/boros/pair/simulate', () => {
  it('prices the pair and reports a clean gate', async () => {
    makeApp();
    const res = await post('/api/boros/pair/simulate', pairBody());
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.simulation.legA.execApr).toBeCloseTo(0.09, 9);
    expect(data.simulation.legB.execApr).toBeCloseTo(0.042, 9);
    expect(data.simulation.estSpreadApr).toBeGreaterThan(data.simulation.worstSpreadApr);
    expect(data.gate.blockers).toEqual([]);
    expect(data.simulatedAtMs).toBeGreaterThan(0);
  });

  it('reads books from a key the 30s scan cache cannot serve', async () => {
    const calls: string[] = [];
    makeApp({}, calls);
    await post('/api/boros/pair/simulate', pairBody());
    const bookCalls = calls.filter((c) => c.startsWith('/core/v1/order-books/'));
    expect(bookCalls).toHaveLength(2);
    // A second simulate inside the short TTL is served from cache…
    await post('/api/boros/pair/simulate', pairBody());
    expect(calls.filter((c) => c.startsWith('/core/v1/order-books/'))).toHaveLength(2);
  });

  it('surfaces an ineligible pair as a reason instead of pricing it', async () => {
    const other = market(BN, 'Binance', 0.045);
    other.imData.maturity = MATURITY + DAY;
    makeApp({ '/core/v1/markets': { results: [market(HL, 'Hyperliquid', 0.09), other] } });
    const res = await post('/api/boros/pair/simulate', pairBody());
    const { data } = res.json();
    expect(data.eligibility).toMatchObject({ eligible: false, code: 'different-maturity' });
    expect(data.gate.blockers.map((b: { code: string }) => b.code)).toContain('ineligible-pair');
    expect(data.simulation.estSpreadApr).toBeNull();
  });

  it.each([
    ['a bad address', { address: 'nope' }],
    ['a missing market', { legA: { direction: 'short' } }],
    ['a bad direction', { legA: { marketId: HL, direction: 'sideways' } }],
    ['a non-positive size', { size: 0 }],
    ['an out-of-range tolerance', { legA: { marketId: HL, direction: 'short', slippageApr: 5 } }],
    ['a bad intent', { intent: 'hedge' }],
  ])('rejects %s with a 400', async (_label, over) => {
    makeApp();
    const res = await post('/api/boros/pair/simulate', pairBody(over));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a percent-shaped tolerance rather than silently coercing it', async () => {
    makeApp();
    // 0.25 meaning "0.25%" is 100x the intended 0.0025 — it must not become
    // the rate bound the order carries.
    const res = await post(
      '/api/boros/pair/simulate',
      pairBody({ legA: { marketId: HL, direction: 'short', slippageApr: 25 } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/APR fraction, not percent/);
  });

  it('names an unknown market rather than 500-ing', async () => {
    makeApp();
    const res = await post('/api/boros/pair/simulate', pairBody({ legB: { marketId: 999, direction: 'long' } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/unknown Boros market 999/);
  });

  // A gas read that fails must not look like a rich account. Both shapes of
  // failure — a throw and a null — have to land on the SAME unknown state, or
  // one of them waves the trade through to a venue rejection the panel cannot
  // explain.
  const failedReads: Array<[string, () => Promise<number | null>]> = [
    ['throws', async () => { throw new Error('boros rpc down'); }],
    ['returns null', async () => null],
  ];
  it.each(failedReads)('treats a gas read that %s as unknown, not as funded', async (_label, getGasBalance) => {
    makeApp({}, undefined, { ...orderClient(), getGasBalance });
    const res = await post('/api/boros/pair/simulate', pairBody());
    const { data } = res.json();
    expect(data.gasBalanceUsd).toBeNull();
    // It SAYS so, but it does not refuse the trade: this read is not on the
    // order's critical path, and the top-up control only shows on a number, so
    // a blocker here would strand the user with no way forward.
    expect(data.gate.blockers).toEqual([]);
    expect(data.gate.warnings.join(' ')).toMatch(/could not be read/i);
  });

  it('raises no gas blocker on a funded pot', async () => {
    makeApp({}, undefined, { ...orderClient(), getGasBalance: async () => 5 });
    const res = await post('/api/boros/pair/simulate', pairBody());
    const { data } = res.json();
    expect(data.gasBalanceUsd).toBe(5);
    expect(data.gate.blockers).toEqual([]);
  });
});

describe('POST /api/boros/pair/top-up-gas', () => {
  it('pays once and echoes the amount SENT, never a freshly read balance', async () => {
    // Boros credits the pot when its indexer processes the PayTreasury event,
    // so a balance read straight after the call still returns the OLD figure.
    // Reporting it would tell the user the top-up did nothing and invite a
    // second one, which cannot be undone.
    const paid: Array<[number, number]> = [];
    const getGasBalance = vi.fn(async () => 0.05);
    makeApp({}, undefined, {
      ...orderClient(),
      payTreasury: async (amountUsd, marketId) => {
        paid.push([amountUsd, marketId]);
      },
      getGasBalance,
    });
    const res = await post('/api/boros/pair/top-up-gas', { amountUsd: 5 });
    expect(res.statusCode).toBe(200);
    expect(paid).toHaveLength(1);
    expect(paid[0][0]).toBe(5);
    expect(res.json().data).toEqual({ sentUsd: 5 });
    expect(getGasBalance).not.toHaveBeenCalled();
  });

  it('tops up an account that has entered no market — the cold start', async () => {
    // The user this whole route exists for. Requiring an entered market would
    // refuse exactly them: entering is order registration, and they cannot
    // place an order until the gas lands.
    const paid: number[] = [];
    makeApp({}, undefined, {
      ...orderClient(),
      payTreasury: async (amountUsd) => {
        paid.push(amountUsd);
      },
    });
    const res = await post('/api/boros/pair/top-up-gas', { amountUsd: 5 });
    expect(res.statusCode).toBe(200);
    expect(paid).toEqual([5]);
  });

  it.each([
    ['under the floor, where the ops-fee sweep would eat it', 1],
    ['over the cap, which the user cannot get back', 500],
    ['not a number', 'five'],
    ['absent', undefined],
  ])('refuses an amount %s without spending anything', async (_label, amountUsd) => {
    const payTreasury = vi.fn();
    makeApp({}, undefined, { ...orderClient(), payTreasury });
    const res = await post('/api/boros/pair/top-up-gas', { amountUsd });
    expect(res.statusCode).toBe(400);
    expect(payTreasury).not.toHaveBeenCalled();
  });

  it('answers 503 when this install cannot place Boros orders at all', async () => {
    makeApp();
    const res = await post('/api/boros/pair/top-up-gas', { amountUsd: 5 });
    expect(res.statusCode).toBe(503);
  });

  it('answers 503 when the order client cannot top up', async () => {
    // `payTreasury` is optional on the port: an install that can trade may
    // still have no way to pay, and that is a 503, not a 500.
    makeApp({}, undefined, orderClient());
    const res = await post('/api/boros/pair/top-up-gas', { amountUsd: 5 });
    expect(res.statusCode).toBe(503);
  });

});

describe('borosExecutionsPending', () => {
  it('counts a memoized execution and starts each app at zero', async () => {
    // What the update route reads before restarting: a restart empties the
    // replay memo, so a panel retry after it would double-fill for real.
    makeApp({}, undefined, orderClient());
    expect(borosExecutionsPending()).toBe(0);
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(200);
    expect(borosExecutionsPending()).toBe(1);

    await app!.close();
    makeApp({}, undefined, orderClient());
    expect(borosExecutionsPending()).toBe(0);
  });
});

describe('POST /api/boros/pair/execute', () => {
  it('sends both legs and reports the fills', async () => {
    const seen: Array<{ marketId: number; limitApr: number }> = [];
    makeApp({}, undefined, orderClient(async (r) => {
      seen.push({ marketId: r.marketId, limitApr: r.limitApr });
      return okFill({ marketId: r.marketId, direction: r.direction, execApr: r.direction === 'short' ? 0.09 : 0.042 });
    }));
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.result.partial).toBe(false);
    expect(data.result.hedgedSize).toBe(100_000);
    // The receive-fixed leg's bound sits BELOW its estimate, the pay-fixed
    // leg's ABOVE — 0.09 − 0.0025 and 0.042 + 0.0025.
    expect(seen.find((s) => s.marketId === HL)!.limitApr).toBeCloseTo(0.0875, 9);
    expect(seen.find((s) => s.marketId === BN)!.limitApr).toBeCloseTo(0.0445, 9);
  });

  it('re-runs the gate server-side and refuses a blocked pair with a 409', async () => {
    const place = vi.fn(async (r: { marketId: number; direction: 'long' | 'short' }) =>
      okFill({ marketId: r.marketId, direction: r.direction }),
    );
    // Cross bucket far too small for either leg's margin.
    makeApp(
      {
        '/core/v1/collaterals/summary': {
          collaterals: [
            { tokenId: 3, crossPosition: { netBalance: raw(1), marketPositions: [] }, isolatedPositions: [] },
          ],
        },
      },
      undefined,
      orderClient(place),
    );
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().data.blockers.map((b: { code: string }) => b.code)).toContain(
      'cross-short-margin',
    );
    // Nothing was sent.
    expect(place).not.toHaveBeenCalled();
  });

  it('refuses when the §4 acknowledgement is missing, even if the client omitted it', async () => {
    const place = vi.fn(async (r: { marketId: number; direction: 'long' | 'short' }) =>
      okFill({ marketId: r.marketId, direction: r.direction }),
    );
    // An existing LONG on HL that leg A's short would oppose.
    makeApp(
      {
        '/core/v1/collaterals/summary': {
          collaterals: [
            {
              tokenId: 3,
              crossPosition: {
                netBalance: raw(500_000),
                marketPositions: [
                  { marketId: HL, side: 0, notionalSize: raw(150_000), pnl: {}, positionInitialMargin: raw(0) },
                ],
              },
              isolatedPositions: [],
            },
          ],
        },
      },
      undefined,
      orderClient(place),
    );
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().data.blockers.map((b: { code: string }) => b.code)).toContain(
      'flip-unacknowledged',
    );
    expect(place).not.toHaveBeenCalled();
  });

  it('reports a partial fill rather than a plain success', async () => {
    makeApp({}, undefined, orderClient(async (r) =>
      r.marketId === HL
        ? okFill({ marketId: HL, direction: 'short', filledSize: 60_000, shortfallSize: 40_000, failure: { code: 'insufficient-depth', message: 'thin' } })
        : okFill({ marketId: BN, direction: 'long', execApr: 0.042 }),
    ));
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    const { data } = res.json();
    expect(data.result.partial).toBe(true);
    expect(data.result.unhedgedSize).toBe(40_000);
    expect(data.result.unhedgedLeg).toBe('B');
    expect(data.result.legA.failure.code).toBe('insufficient-depth');
  });

  it('does not submit a leg with nothing to trade', async () => {
    // A zero-delta leg has no execution rate either, so building an order for
    // it produced a NEGATIVE rate bound on a zero-size order — and both legs
    // share one batch, so that entry could take the good leg down with it.
    const sent: Array<Array<{ marketId: number; size: number; limitApr: number }>> = [];
    // Leg B is flat, so a CLOSE gives it nothing to do.
    makeApp(
      {
        '/core/v1/collaterals/summary': {
          collaterals: [
            {
              tokenId: 3,
              crossPosition: {
                netBalance: raw(500_000),
                marketPositions: [
                  { marketId: HL, side: 0, notionalSize: raw(100_000), pnl: {}, positionInitialMargin: raw(0) },
                ],
              },
              isolatedPositions: [],
            },
          ],
        },
      },
      undefined,
      {
        placeMarketOrders: async (reqs) => {
          sent.push(reqs.map((r) => ({ marketId: r.marketId, size: r.size, limitApr: r.limitApr })));
          return reqs.map((r) => okFill({ marketId: r.marketId, direction: r.direction }));
        },
        cancelOrders: async () => {},
        closePosition: async () => okFill(),
      },
    );

    const res = await post(
      '/api/boros/pair/execute',
      pairBody({
        intent: 'close',
        // Closing opposes the held position, so §4's acknowledgement applies.
        opposingAcknowledged: true,
        clientOrderIdA: 'coid-aaaa',
        clientOrderIdB: 'coid-bbbb',
      }),
    );
    expect(res.statusCode).toBe(200);
    // Exactly one order, for the leg that actually has a position to close.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0][0].marketId).toBe(HL);
    expect(sent[0][0].size).toBeGreaterThan(0);
    expect(sent[0][0].limitApr).toBeGreaterThan(0);
  });

  it('trades ONE leg when onlyLeg is set, for a completion', async () => {
    const sent: number[][] = [];
    makeApp({}, undefined, {
      placeMarketOrders: async (reqs) => {
        sent.push(reqs.map((r) => r.marketId));
        return reqs.map((r) => okFill({ marketId: r.marketId, direction: r.direction }));
      },
      cancelOrders: async () => {},
      closePosition: async () => okFill(),
    });
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ onlyLeg: 'B', clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual([[BN]]);
    // Pair-level hedge framing is dropped — one fill closing a gap is not an
    // unhedged residual.
    expect(res.json().data.result.bothLegsSubmitted).toBe(false);
    expect(res.json().data.result.unhedgedSize).toBe(0);
  });

  it('replays a resend of the same order ids instead of trading twice', async () => {
    // Boros has no client-order-id, so nothing at the venue dedupes: without
    // this a lost response plus a Confirm press doubles the position.
    let calls = 0;
    makeApp({}, undefined, {
      placeMarketOrders: async (reqs) => {
        calls += 1;
        return reqs.map((r) => okFill({ marketId: r.marketId, direction: r.direction }));
      },
      cancelOrders: async () => {},
      closePosition: async () => okFill(),
    });
    const body = pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' });

    const first = await post('/api/boros/pair/execute', body);
    const second = await post('/api/boros/pair/execute', body);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(calls).toBe(1);
    expect(first.json().data.replayed).toBe(false);
    // Said plainly, so the panel does not imply a fresh trade.
    expect(second.json().data.replayed).toBe(true);
    expect(second.json().data.result).toEqual(first.json().data.result);
  });

  it('lets a genuinely new order through with fresh ids', async () => {
    let calls = 0;
    makeApp({}, undefined, {
      placeMarketOrders: async (reqs) => {
        calls += 1;
        return reqs.map((r) => okFill({ marketId: r.marketId, direction: r.direction }));
      },
      cancelOrders: async () => {},
      closePosition: async () => okFill(),
    });
    await post('/api/boros/pair/execute', pairBody({ clientOrderIdA: 'coid-aaa1', clientOrderIdB: 'coid-bbb1' }));
    await post('/api/boros/pair/execute', pairBody({ clientOrderIdA: 'coid-aaa2', clientOrderIdB: 'coid-bbb2' }));
    expect(calls).toBe(2);
  });

  it('refuses to trade an account other than the one it signs for', async () => {
    // The gate reasons over body.address while orders sign for the configured
    // root; unbound, a body field points every §6/§7 check at a stranger's
    // margin and positions while the trade lands on the user's own account.
    const place = vi.fn(async (reqs: unknown[]) => reqs.map(() => okFill()));
    makeApp({}, undefined, {
      placeMarketOrders: place as never,
      cancelOrders: async () => {},
      closePosition: async () => okFill(),
    });
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ address: OTHER, clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/does not match the account this install signs for/);
    expect(place).not.toHaveBeenCalled();
  });

  it('ignores a foreign address on cancel-and-close rather than sizing from it', async () => {
    // This route runs no gate and takes the close SIZE from the position it
    // reads, so a foreign address would let the caller choose the size of a
    // market order on the configured account.
    let sized: number | null = null;
    app = makeTestApp({
      borosFetch: borosStub(bodies()),
      getBorosOrders: () => ({
        placeMarketOrders: async (reqs) => reqs.map(() => okFill()),
        cancelOrders: async () => {},
        closePosition: async (r) => {
          sized = r.size;
          return okFill();
        },
      }),
    });
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      address: OTHER,
      clientOrderId: 'coid-foreign',
    });
    // Accepted, but the body's address had no effect: the configured account is
    // flat, so there is nothing to close.
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ cancelled: true, closed: false, fill: null });
    expect(sized).toBeNull();
  });

  it('answers 503 when the install cannot place Boros orders at all', async () => {
    makeApp(); // no borosOrders dep
    const res = await post(
      '/api/boros/pair/execute',
      pairBody({ clientOrderIdA: 'coid-aaaa', clientOrderIdB: 'coid-bbbb' }),
    );
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/not configured/i);
  });

  it.each([
    ['missing ids', {}],
    ['a too-short id', { clientOrderIdA: 'abc', clientOrderIdB: 'coid-bbbb' }],
    ['identical ids', { clientOrderIdA: 'coid-same', clientOrderIdB: 'coid-same' }],
  ])('rejects %s with a 400 before touching the venue', async (_label, over) => {
    const place = vi.fn();
    makeApp({}, undefined, orderClient(place as never));
    const res = await post('/api/boros/pair/execute', pairBody(over));
    expect(res.statusCode).toBe(400);
    expect(place).not.toHaveBeenCalled();
  });
});

describe('POST /api/boros/pair/market/:marketId/cancel-and-close', () => {
  it('cancels before closing, so a resting order cannot re-open the position', async () => {
    const order: string[] = [];
    let closeReq: { marketId: number; size: number; direction: string; limitApr: number } | null = null;
    // A position to close: without one the route cancels and stops.
    app = makeTestApp({
      borosFetch: borosStub(
        bodies({
          '/core/v1/collaterals/summary': {
            collaterals: [
              {
                tokenId: 3,
                crossPosition: {
                  netBalance: raw(500_000),
                  marketPositions: [
                    { marketId: HL, side: 0, notionalSize: raw(75_000), pnl: {}, positionInitialMargin: raw(0) },
                  ],
                },
                isolatedPositions: [],
              },
            ],
          },
        }),
      ),
      getBorosOrders: () => ({
        placeMarketOrders: async (reqs) => reqs.map(() => okFill()),
        cancelOrders: async () => {
          order.push('cancel');
        },
        closePosition: async (r) => {
          order.push('close');
          closeReq = r;
          return okFill({ filledSize: r.size, shortfallSize: 0 });
        },
      }),
    });
    // No address in the body — the server derives it from the agent it signs with.
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-close1',
    });
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(['cancel', 'close']);
    // A long 75k is reduced by a SHORT of exactly 75k, at a bounded rate.
    expect(closeReq).toMatchObject({ marketId: HL, size: 75_000, direction: 'short' });
    expect(closeReq!.limitApr).toBeLessThan(0.09);
    expect(res.json().data.closed).toBe(true);
  });

  /** The 75k-long fixture, reused by the size/slippage cases below. */
  const longPositionApp = (capture: { req: { marketId: number; size: number; direction: string; limitApr: number } | null }) =>
    makeTestApp({
      borosFetch: borosStub(
        bodies({
          '/core/v1/collaterals/summary': {
            collaterals: [
              {
                tokenId: 3,
                crossPosition: {
                  netBalance: raw(500_000),
                  marketPositions: [
                    { marketId: HL, side: 0, notionalSize: raw(75_000), pnl: {}, positionInitialMargin: raw(0) },
                  ],
                },
                isolatedPositions: [],
              },
            ],
          },
        }),
      ),
      getBorosOrders: () => ({
        placeMarketOrders: async (reqs) => reqs.map(() => okFill()),
        cancelOrders: async () => {},
        closePosition: async (r) => {
          capture.req = r;
          return okFill({ filledSize: r.size, shortfallSize: 0 });
        },
      }),
    });

  it('closes only the size asked for, and reports a partial as not-flat', async () => {
    const cap: { req: { marketId: number; size: number; direction: string; limitApr: number } | null } = { req: null };
    app = longPositionApp(cap);
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-part1',
      size: 25_000,
    });
    expect(res.statusCode).toBe(200);
    expect(cap.req).toMatchObject({ size: 25_000, direction: 'short' });
    // `closed` means FLAT. A deliberate partial is not a failed close, so it
    // says so plainly rather than claiming the position is gone.
    expect(res.json().data).toMatchObject({ closed: false, openSize: 75_000 });
  });

  it('CLAMPS an oversized close to the position — Boros has no reduce-only flag', async () => {
    // Without the clamp a size past the position does not stop at flat: it
    // crosses and opens a fresh one the other way. This is the guarantee that
    // makes accepting a caller-supplied size safe at all.
    const cap: { req: { marketId: number; size: number; direction: string; limitApr: number } | null } = { req: null };
    app = longPositionApp(cap);
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-over1',
      size: 10_000_000,
    });
    expect(res.statusCode).toBe(200);
    expect(cap.req!.size).toBe(75_000);
    expect(res.json().data.closed).toBe(true);
  });

  it('carries the caller\'s rate bound, and rejects an absurd one', async () => {
    const cap: { req: { marketId: number; size: number; direction: string; limitApr: number } | null } = { req: null };
    app = longPositionApp(cap);
    // A SHORT close accepts rates at or above mark − bound, so a wider bound
    // lands strictly lower than the 1% default.
    const wide = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-slip1',
      slippageApr: 0.05,
    });
    expect(wide.statusCode).toBe(200);
    const wideApr = cap.req!.limitApr;

    cap.req = null;
    app = longPositionApp(cap);
    const tight = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-slip2',
      slippageApr: 0.001,
    });
    expect(tight.statusCode).toBe(200);
    expect(wideApr).toBeLessThan(cap.req!.limitApr);

    app = longPositionApp({ req: null });
    const bad = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-slip3',
      slippageApr: 5,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/slippageApr/);
  });

  it('busts the cached Boros account read, so the next poll cannot serve a pre-close position', async () => {
    // /strategy serves `boros:collaterals:<addr>` from a 30s cache (TTL.boros).
    // Without a bust the client can invalidate, refetch at once, and STILL be
    // handed the position as it was before the close — the card then sat on a
    // stale size while claiming the close had landed.
    const calls: string[] = [];
    const cap: { req: { marketId: number; size: number; direction: string; limitApr: number } | null } = { req: null };
    app = makeTestApp({
      borosFetch: borosStub(
        bodies({
          '/core/v1/collaterals/summary': {
            collaterals: [
              {
                tokenId: 3,
                crossPosition: {
                  netBalance: raw(500_000),
                  marketPositions: [
                    { marketId: HL, side: 0, notionalSize: raw(75_000), pnl: {}, positionInitialMargin: raw(0) },
                  ],
                },
                isolatedPositions: [],
              },
            ],
          },
        }),
        calls,
      ),
      getBorosOrders: () => ({
        placeMarketOrders: async (reqs) => reqs.map(() => okFill()),
        cancelOrders: async () => {},
        closePosition: async (r) => {
          cap.req = r;
          return okFill({ filledSize: r.size, shortfallSize: 0 });
        },
      }),
    });

    const summaries = () => calls.filter((c) => c.includes('/collaterals/summary')).length;
    // Warm the cache, then confirm a second read inside the TTL is served from it.
    await post(`/api/boros/pair/market/${HL}/cancel-and-close`, { clientOrderId: 'coid-warm' });
    const afterFirst = summaries();

    await post(`/api/boros/pair/market/${HL}/cancel-and-close`, { clientOrderId: 'coid-second' });
    // The close busts the key, so the second call had to re-read rather than
    // sizing from a cached position that no longer exists.
    expect(summaries()).toBeGreaterThan(afterFirst);
  });

  it('cancels and stops when there is no position to close', async () => {
    const order: string[] = [];
    app = makeTestApp({
      borosFetch: borosStub(bodies()),
      getBorosOrders: () => ({
        placeMarketOrders: async (reqs) => reqs.map(() => okFill()),
        cancelOrders: async () => {
          order.push('cancel');
        },
        closePosition: async () => {
          order.push('close');
          return okFill();
        },
      }),
    });
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-close2',
    });
    expect(res.statusCode).toBe(200);
    // No phantom close order against a flat market.
    expect(order).toEqual(['cancel']);
    expect(res.json().data).toMatchObject({ closed: false, fill: null });
  });

  it('answers 503 when order placement is not configured', async () => {
    makeApp();
    const res = await post(`/api/boros/pair/market/${HL}/cancel-and-close`, {
      clientOrderId: 'coid-close3',
    });
    expect(res.statusCode).toBe(503);
  });
});
