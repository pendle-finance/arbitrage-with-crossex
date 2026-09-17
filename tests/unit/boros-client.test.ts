/**
 * Boros API client (src/core/boros/client.ts): wire-shape normalization
 * (18-dec settleFeeRate), the transactions pagination loop, response-shape
 * guards, and error categorization (429 → rate-limited so TtlCache cools down).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchBorosCollaterals,
  fetchBorosMarkets,
  fetchBorosOrderBook,
  fetchBorosTransactions,
  resolveCollateralPricesUsd,
  setClientTagContext,
  type FetchLike,
} from '../../src/core/boros/client';

// The client tag lives in module state; reset it around every test so a case
// that sets a version/active flag can never leak into the plain-tag assertions.
beforeEach(() => setClientTagContext({ version: null, active: false }));
afterEach(() => setClientTagContext({ version: null, active: false }));

const ADDR = '0x' + 'ab'.repeat(20);
/** This account's cross USDT (tokenId 3) handle — the fill feed's key. */
const MARKET_ACC = ADDR + '000003ffffff';

function stub(handler: (url: URL) => { status?: number; body?: unknown }): FetchLike {
  return async (url: string) => {
    const { status = 200, body = {} } = handler(new URL(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

describe('fetchBorosMarkets', () => {
  it('normalizes 18-dec settleFeeRate and unwraps results[]', async () => {
    const markets = await fetchBorosMarkets(
      stub(() => ({
        body: {
          results: [
            {
              marketId: 155,
              tokenId: 3,
              imData: { name: 'Hyperliquid ETH 31 Jul 2026', maturity: 1785456000 },
              extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
              platform: { platformId: 'Hyperliquid' },
              metadata: { underlyingSymbol: 'ETH' },
              data: { markApr: 0.076, floatingApr: 0.075, assetMarkPrice: 1880 },
            },
          ],
        },
      })),
    );
    expect(markets).toHaveLength(1);
    expect(markets[0].settleFeeApr).toBeCloseTo(0.001, 12); // '1000000000000000'/1e18
    expect(markets[0].venue).toBe('Hyperliquid');
    expect(markets[0].base).toBe('ETH');
    expect(markets[0].paymentPeriod).toBe(3600);
  });

  it('maps config.status (on-chain MarketStatus) to the lifecycle state', async () => {
    const mk = (status: unknown) => ({ marketId: 155, tokenId: 3, config: { status } });
    const states = async (status: unknown) =>
      (await fetchBorosMarkets(stub(() => ({ body: { results: [mk(status)] } }))))[0].state;
    expect(await states(2)).toBe('Normal');
    expect(await states(1)).toBe('CloseOnly');
    expect(await states(0)).toBe('Paused');
    // An unknown or absent status must not read as tradable.
    expect(await states(undefined)).toBe('Unknown');
  });

  it('surfaces midApr, notionalOI, the 18-dec takerFee and the lifecycle state', async () => {
    const markets = await fetchBorosMarkets(
      stub(() => ({
        body: {
          results: [
            {
              marketId: 155,
              tokenId: 3,
              imData: { name: 'Hyperliquid ETH 31 Jul 2026', maturity: 1785456000 },
              config: { status: 2, takerFee: '500000000000000', maxRateDeviationFactorBase1e4: 2500 },
              extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
              platform: { platformId: 'Hyperliquid' },
              metadata: { underlyingSymbol: 'ETH' },
              data: {
                markApr: 0.076,
                floatingApr: 0.075,
                midApr: 0.0921,
                notionalOI: 801.005045896532,
                assetMarkPrice: 1880,
              },
            },
          ],
        },
      })),
    );
    expect(markets[0].midApr).toBe(0.0921);
    expect(markets[0].notionalOi).toBe(801.005045896532); // collateral units, NOT USD
    expect(markets[0].takerFeeRate).toBeCloseTo(0.0005, 12);
    expect(markets[0].state).toBe('Normal');
    // maxRateDeviation is a FRACTION OF THE MARK, not the deviation itself:
    // 2500/1e4 = 0.25, and 0.25 x 7.6% = 1.9% APR. Reading the factor as the
    // cap directly would have quoted 25%.
    expect(markets[0].maxRateDeviationApr).toBeCloseTo(0.019, 12);
  });

  it('normalizes the initial-margin inputs (kIM is 18-dec, tThresh comes off config)', async () => {
    const markets = await fetchBorosMarkets(
      stub(() => ({
        body: {
          results: [
            {
              marketId: 155,
              tokenId: 3,
              // Live HYPERLIQUID-ETH-31JUL2026 values (2026-07).
              imData: {
                name: 'Hyperliquid ETH 31 Jul 2026',
                maturity: 1785456000,
                iTickThresh: 770,
                tickStep: 2,
              },
              config: { kIM: '476190476190476190', tThresh: 432000 },
              // extConfig.tickStep is a decoy: the margin step must come from imData.
              extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600, tickStep: 7 },
              platform: { platformId: 'Hyperliquid' },
              metadata: { underlyingSymbol: 'ETH' },
              data: { markApr: 0.076, assetMarkPrice: 1880 },
            },
          ],
        },
      })),
    );
    expect(markets[0].kIM).toBeCloseTo(0.476190476190476, 12); // 1/kIM = the 2.1x preset
    expect(markets[0].imTickThresh).toBe(770);
    expect(markets[0].imTickStep).toBe(2);
    expect(markets[0].tThreshSec).toBe(432_000);
    // Pins the wire floor: imData.marginFloor was 0.08003999738290433 on this market.
    expect(1.00005 ** (markets[0].imTickThresh * markets[0].imTickStep) - 1).toBeCloseTo(
      0.08003999738290433,
      9,
    );
  });

  it('defaults absent margin inputs to 0 so the capital model can detect them', async () => {
    const markets = await fetchBorosMarkets(
      stub(() => ({ body: { results: [{ marketId: 155, tokenId: 3 }] } })),
    );
    expect(markets[0].kIM).toBe(0);
    expect(markets[0].imTickThresh).toBe(0);
    expect(markets[0].imTickStep).toBe(0);
    expect(markets[0].tThreshSec).toBe(0);
  });

  it('throws a network CoreError on a bare-array body (no results[])', async () => {
    await expect(fetchBorosMarkets(stub(() => ({ body: [] })))).rejects.toMatchObject({
      name: 'CoreError',
      category: 'network',
    });
  });

  it('maps HTTP 429 to the rate-limited category (TtlCache cooldown), 5xx to network', async () => {
    await expect(fetchBorosMarkets(stub(() => ({ status: 429 })))).rejects.toMatchObject({
      name: 'CoreError',
      category: 'rate-limited',
    });
    await expect(fetchBorosMarkets(stub(() => ({ status: 500 })))).rejects.toMatchObject({
      name: 'CoreError',
      category: 'network',
    });
  });
});

describe('fetchBorosOrderBook', () => {
  /** 18-dec size string. */
  const sz = (n: number) => String(n * 1e18);
  /** Round away float noise from tick × 0.0001 so levels compare exactly. */
  const round = (levels: Array<[number, number]>) =>
    levels.map(([apr, size]) => [Number(apr.toFixed(6)), size] as [number, number]);

  // Ticks are DELIBERATELY SHUFFLED on both sides — the wire order is not sorted.
  const wireBook = {
    short: { ia: [940, 923, 1000], sz: [sz(4), sz(1.5), sz(9)] },
    long: { ia: [900, 922, 850], sz: [sz(3), sz(2.5), sz(7)] },
  };

  it('maps wire short → asks and wire long → bids, scaling ticks and 18-dec sizes', async () => {
    const urls: string[] = [];
    const book = await fetchBorosOrderBook(
      stub((url) => {
        urls.push(url.pathname + url.search);
        return { body: wireBook };
      }),
      155,
    );

    expect(urls).toEqual([
      '/apis/v1/markets/order-book?marketId=155&tickSize=0.0001&pendle_client=boroscrossex',
    ]);
    expect(book.marketId).toBe(155);
    // asks (wire "short") sorted apr-ascending, bids (wire "long") apr-descending.
    expect(round(book.asks)).toEqual([
      [0.0923, 1.5],
      [0.094, 4],
      [0.1, 9],
    ]);
    expect(round(book.bids)).toEqual([
      [0.0922, 2.5],
      [0.09, 3],
      [0.085, 7],
    ]);
    // The whole point of the mapping: asks price ABOVE bids.
    expect(book.asks[0][0]).toBeGreaterThan(book.bids[0][0]);
  });

  it('drops levels with non-positive or unparseable sizes', async () => {
    const book = await fetchBorosOrderBook(
      stub(() => ({
        body: {
          short: { ia: [923, 930, 940], sz: [sz(1.5), '0', 'not-a-number'] },
          long: { ia: [922, 910], sz: [sz(2.5), sz(-4)] },
        },
      })),
      155,
    );
    expect(round(book.asks)).toEqual([[0.0923, 1.5]]);
    expect(round(book.bids)).toEqual([[0.0922, 2.5]]);
  });

  it('throws a network CoreError when a side is missing or ia/sz lengths disagree', async () => {
    await expect(
      fetchBorosOrderBook(stub(() => ({ body: { long: wireBook.long } })), 155),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'network' });

    await expect(
      fetchBorosOrderBook(
        stub(() => ({ body: { short: { ia: [923, 940], sz: [sz(1.5)] }, long: wireBook.long } })),
        155,
      ),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'network' });
  });

  it('maps HTTP 429 to the rate-limited category', async () => {
    await expect(
      fetchBorosOrderBook(stub(() => ({ status: 429 })), 155),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'rate-limited' });
  });
});

describe('fetchBorosTransactions pagination', () => {
  const txn = (marketId: number, timestamp: number) => ({
    marketId,
    timestamp,
    fee: '1',
    pnl: '-1',
    prevPositionS: '0',
    postPositionS: '1',
  });

  it('walks resumeToken pages until the feed is exhausted and concatenates in order', async () => {
    const pages = [
      { results: [txn(100, 1), txn(101, 2)], resumeToken: 'p2' },
      { results: [txn(102, 3)], resumeToken: null },
    ];
    const tokens: Array<string | null> = [];
    const { txns, complete } = await fetchBorosTransactions(
      stub((url) => {
        tokens.push(url.searchParams.get('resumeToken'));
        return { body: pages[tokens.length - 1] };
      }),
      MARKET_ACC,
      155,
    );
    expect(tokens).toEqual([null, 'p2']);
    expect(txns.map((t) => t.marketId)).toEqual([100, 101, 102]);
    expect(complete).toBe(true);
  });

  it('stops after one page when the feed returns no resumeToken', async () => {
    let calls = 0;
    const { txns } = await fetchBorosTransactions(
      stub(() => {
        calls += 1;
        return { body: { results: [txn(1, 1)], resumeToken: null } };
      }),
      MARKET_ACC,
      155,
    );
    expect(calls).toBe(1);
    expect(txns).toHaveLength(1);
  });

  it('stops on an empty page even if the feed still offers a resumeToken', async () => {
    let calls = 0;
    const { txns } = await fetchBorosTransactions(
      stub(() => {
        calls += 1;
        return { body: { results: [], resumeToken: 'never-ending' } };
      }),
      MARKET_ACC,
      155,
    );
    expect(calls).toBe(1); // empty page short-circuits
    expect(txns).toHaveLength(0);
  });

  it('throws (never caches "no history") when results[] is missing', async () => {
    await expect(
      fetchBorosTransactions(stub(() => ({ body: { resumeToken: null } })), MARKET_ACC, 155),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'network' });
  });

  it('reports coverage: complete when the feed is exhausted', async () => {
    const { complete } = await fetchBorosTransactions(
      stub(() => ({ body: { results: [txn(1, 1)], resumeToken: null } })),
      MARKET_ACC,
      155,
    );
    expect(complete).toBe(true);
  });

  it('reports coverage: INCOMPLETE when the page cap cuts it short', async () => {
    // An account past the guard used to get a silently truncated history —
    // and truncation fakes absence, which is what any "no counterpart nearby,
    // so it was placed alone" reasoning rests on.
    let calls = 0;
    const { complete } = await fetchBorosTransactions(
      stub(() => {
        calls += 1;
        return { body: { results: [txn(calls, calls)], resumeToken: `page-${calls}` } };
      }),
      MARKET_ACC,
      155,
    );
    expect(calls).toBe(30);
    expect(complete).toBe(false);
  });

  it("maps the feed's own field names, and entryApr only on a reducing fill", async () => {
    const { txns } = await fetchBorosTransactions(
      stub(() => ({
        body: {
          results: [
            // Open from flat: prevPositionF rides along but means nothing yet.
            { marketId: 7, timestamp: 100, fee: '1', pnl: '-1', tradeRate: 0.09,
              prevPositionS: '0', postPositionS: '5', prevPositionF: '0' },
            // Reduces without flipping — the venue's own entry rate applies.
            { marketId: 7, timestamp: 200, fee: '1', pnl: '3', tradeRate: 0.04,
              prevPositionS: '5', postPositionS: '2', prevPositionF: '90000000000000000' },
            // Closes THROUGH flat into a short: not a reduction, no entry rate.
            { marketId: 7, timestamp: 300, fee: '1', pnl: '2', tradeRate: 0.05,
              prevPositionS: '2', postPositionS: '-1', prevPositionF: '40000000000000000' },
          ],
          resumeToken: null,
        },
      })),
      MARKET_ACC,
      7,
    );
    expect(txns.map((t) => t.time)).toEqual([100, 200, 300]);
    expect(txns.map((t) => t.fixedApr)).toEqual([0.09, 0.04, 0.05]);
    expect(txns.map((t) => t.entryApr)).toEqual([undefined, 0.09, undefined]);
  });
});

describe('fetchBorosCollaterals', () => {
  const ROOT = '0x' + 'ab'.repeat(20);
  /** root · accountId(1B) · tokenId(2B) · marketId(3B); FFFFFF ⇒ cross. */
  const CROSS = ROOT + '00' + '0003' + 'ffffff';
  const ISO = ROOT + '00' + '0003' + '00009b'; // isolated on market 155
  const OTHER_ACCOUNT = ROOT + '01' + '0003' + 'ffffff';

  /** The surface is two reads; route each by pathname. */
  const accountStub = (infos: unknown, actives: unknown): FetchLike =>
    stub((url) => ({ body: url.pathname.endsWith('/active-positions') ? actives : infos }));

  const infos = {
    results: [
      {
        marketAcc: CROSS,
        netBalance: '20',
        initialMargin: '5',
        positions: [{ marketId: 155, signedSize: '-7', initialMargin: '5', orders: [] }],
      },
      {
        marketAcc: ISO,
        netBalance: '9',
        initialMargin: '1',
        positions: [{ marketId: 155, signedSize: '3', initialMargin: '1', orders: [{ id: '1' }] }],
      },
    ],
  };
  const actives = {
    results: [
      { marketAcc: CROSS, marketId: 155, side: 1, fixedApr: 0.08, unrealisedPnl: '11', settlementPnl: '13' },
    ],
  };

  it('rebuilds zones from the marketAcc layout and joins the live rates onto them', async () => {
    const zones = await fetchBorosCollaterals(accountStub(infos, actives), ROOT, []);
    expect(zones).toHaveLength(1);
    expect(zones[0].tokenId).toBe(3); // decoded from the marketAcc, not a body field
    expect(zones[0].cross?.netBalance).toBe('20');
    expect(zones[0].isolated).toHaveLength(1);

    const p = zones[0].cross!.marketPositions[0];
    expect(p.notionalSize).toBe('-7'); // signedSize carries the sign
    expect(p.side).toBe(1);
    expect(p.fixedApr).toBe(0.08);
    // settlementPnl/unrealisedPnl are the old rateSettlementPnl/unrealisedPnl.
    expect(p.pnl.rateSettlementPnl).toBe('13');
    expect(p.pnl.unrealisedPnl).toBe('11');
    expect(p.positionInitialMargin).toBe('5');
  });

  it('reads resting orders from the order list instead of the initial-margin gap', async () => {
    const zones = await fetchBorosCollaterals(accountStub(infos, actives), ROOT, []);
    expect(zones[0].cross!.marketPositions[0].hasRestingOrders).toBe(false);
    expect(zones[0].isolated[0].marketPositions[0].hasRestingOrders).toBe(true);
  });

  it('keeps only the requested accountId', async () => {
    const zones = await fetchBorosCollaterals(
      accountStub({ results: [{ marketAcc: OTHER_ACCOUNT, netBalance: '1', positions: [] }] }, { results: [] }),
      ROOT,
      [],
    );
    expect(zones).toHaveLength(0);
  });

  it('splits the position IM out of the combined per-market margin and takes markApr from the market', async () => {
    // IM at mark = |size| × 10% × 1y × kIM 1 = 10 for a size of 100.
    const market = {
      marketId: 155, tokenId: 3, name: '', venue: '', base: '', maturity: Date.now() / 1000 + 365 * 86_400,
      paymentPeriod: 0, settleFeeApr: 0, markApr: 0.1, floatingApr: 0, midApr: 0, notionalOi: 0, takerFeeRate: 0,
      state: 'Normal', assetMarkPriceUsd: 1, kIM: 1, imTickThresh: 0, imTickStep: 0, tThreshSec: 0, maxRateDeviationApr: 0,
    };
    const e18 = (n: number) => `${n}000000000000000000`;
    const book = (orders: Array<{ side: number; im: number }>, combined: number) => ({
      results: [
        {
          marketAcc: CROSS,
          netBalance: e18(100),
          positions: [
            {
              marketId: 155,
              signedSize: e18(100),
              initialMargin: e18(combined),
              orders: orders.map((o) => ({ side: o.side, initialMargin: e18(o.im) })),
            },
          ],
        },
      ],
    });
    const posIm = async (orders: Array<{ side: number; im: number }>, combined: number) =>
      (await fetchBorosCollaterals(accountStub(book(orders, combined), { results: [] }), ROOT, [market]))[0].cross!
        .marketPositions[0];
    // Same-side orders stack on top of the position.
    expect((await posIm([{ side: 0, im: 5 }], 15)).positionInitialMargin).toBe(e18(10));
    // Opposite-side orders net against it: 40 − 10 = 30 also fits "30 − 0 same-side",
    // and the IM at mark is what picks 10 over 30.
    expect((await posIm([{ side: 1, im: 40 }], 30)).positionInitialMargin).toBe(e18(10));
    expect((await posIm([], 10)).markApr).toBe(0.1);
  });

  it('throws a network CoreError when either read is not the documented shape', async () => {
    await expect(
      fetchBorosCollaterals(accountStub({ collaterals: [] }, { results: [] }), ROOT, []),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'network' });
    await expect(
      fetchBorosCollaterals(accountStub({ results: [] }, {}), ROOT, []),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'network' });
  });
});

describe('resolveCollateralPricesUsd', () => {
  it('prices stables at 1, token collateral via a same-asset market, unknown as null', () => {
    const mk = (tokenId: number, base: string, px: number) =>
      ({ marketId: tokenId * 100, tokenId, name: '', venue: '', base, maturity: 0, paymentPeriod: 0, settleFeeApr: 0, markApr: 0, floatingApr: 0, midApr: 0, notionalOi: 0, takerFeeRate: 0, state: 'Normal', assetMarkPriceUsd: px, kIM: 0, imTickThresh: 0, imTickStep: 0, tThreshSec: 0, maxRateDeviationApr: 0 }) as const;
    const prices = resolveCollateralPricesUsd([
      { ...mk(3, 'HYPE', 40) }, // USDT-margined HYPE book
      { ...mk(1, 'BTC', 118_000) }, // BTC-margined BTC book
      { ...mk(4, 'SOL', 150) }, // BNB-margined book with no BNB market anywhere
    ]);
    expect(prices.get(3)).toBe(1);
    expect(prices.get(1)).toBe(118_000);
    expect(prices.get(4)).toBeNull();
  });
});

describe('client identification tag', () => {
  // The Boros backend attributes traffic by this tag; it is appended centrally
  // in getJson so no fetcher can forget it — with '&' when the path already
  // carries a query string, '?' when it does not.
  it('every fetcher sends pendle_client=boroscrossex', async () => {
    const urls: URL[] = [];
    const record = stub((url) => {
      urls.push(url);
      return { body: { results: [], total: 0, skip: 0, collaterals: [], short: { ia: [], sz: [] }, long: { ia: [], sz: [] } } };
    });

    await fetchBorosMarkets(record);
    await fetchBorosOrderBook(record, 155);
    await fetchBorosCollaterals(record, ADDR, []);
    await fetchBorosTransactions(record, MARKET_ACC, 155);

    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) {
      expect(url.searchParams.get('pendle_client'), url.pathname).toBe('boroscrossex');
    }
  });

  const tagOf = async (): Promise<string | null> => {
    let seen: URL | undefined;
    await fetchBorosMarkets(
      stub((url) => {
        seen = url;
        return { body: { results: [] } };
      }),
    );
    return seen!.searchParams.get('pendle_client');
  };

  it('appends the configured version', async () => {
    setClientTagContext({ version: '1.3.0' });
    expect(await tagOf()).toBe('boroscrossex1.3.0');
  });

  it('appends _active for a credentialed user, after the version', async () => {
    setClientTagContext({ version: '1.3.0', active: true });
    expect(await tagOf()).toBe('boroscrossex1.3.0_active');
  });

  it('appends _active with no version when the version is unknown', async () => {
    setClientTagContext({ active: true });
    expect(await tagOf()).toBe('boroscrossex_active');
  });

  it('drops a version that fails the safe-charset check', async () => {
    setClientTagContext({ version: 'a b?' });
    expect(await tagOf()).toBe('boroscrossex');
  });
});
