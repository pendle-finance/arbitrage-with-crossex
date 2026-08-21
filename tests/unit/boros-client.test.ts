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
              metadata: { platformName: 'Hyperliquid', assetSymbol: 'ETH' },
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

  it('surfaces midApr, notionalOI, the 18-dec takerFee and the lifecycle state', async () => {
    const markets = await fetchBorosMarkets(
      stub(() => ({
        body: {
          results: [
            {
              marketId: 155,
              tokenId: 3,
              imData: { name: 'Hyperliquid ETH 31 Jul 2026', maturity: 1785456000 },
              config: { takerFee: '500000000000000' },
              extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
              metadata: { platformName: 'Hyperliquid', assetSymbol: 'ETH' },
              data: {
                markApr: 0.076,
                floatingApr: 0.075,
                midApr: 0.0921,
                notionalOI: 801.005045896532,
                assetMarkPrice: 1880,
              },
              state: 'Normal',
            },
          ],
        },
      })),
    );
    expect(markets[0].midApr).toBe(0.0921);
    expect(markets[0].notionalOi).toBe(801.005045896532); // collateral units, NOT USD
    expect(markets[0].takerFeeRate).toBeCloseTo(0.0005, 12);
    expect(markets[0].state).toBe('Normal');
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
              metadata: { platformName: 'Hyperliquid', assetSymbol: 'ETH' },
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

    expect(urls).toEqual(['/core/v1/order-books/155?tickSize=0.0001&pendle_client=boroscrossex']);
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
  const txn = (marketId: number, time: number) => ({
    marketId,
    time,
    fee: '1',
    pnl: '-1',
    prevPositionS: '0',
    postPositionS: '1',
  });

  it('walks skip/limit pages until total is exhausted and concatenates in order', async () => {
    // 3 pages: 200 + 200 + 50 = 450 txns.
    const TOTAL = 450;
    const all = Array.from({ length: TOTAL }, (_, i) => txn(100 + i, 1_700_000_000 + i));
    const requestedSkips: number[] = [];
    const txns = await fetchBorosTransactions(
      stub((url) => {
        const skip = Number(url.searchParams.get('skip'));
        const limit = Number(url.searchParams.get('limit'));
        requestedSkips.push(skip);
        return { body: { results: all.slice(skip, skip + limit), total: TOTAL } };
      }),
      ADDR,
      3,
    );
    expect(requestedSkips).toEqual([0, 200, 400]);
    expect(txns).toHaveLength(TOTAL);
    expect(txns[0].marketId).toBe(100);
    expect(txns[TOTAL - 1].marketId).toBe(100 + TOTAL - 1);
  });

  it('stops after one page when total fits in the first fetch', async () => {
    let calls = 0;
    const txns = await fetchBorosTransactions(
      stub(() => {
        calls += 1;
        return { body: { results: [txn(1, 1)], total: 1 } };
      }),
      ADDR,
      3,
    );
    expect(calls).toBe(1);
    expect(txns).toHaveLength(1);
  });

  it('stops on an empty page even if total lies, and caps runaway pagination', async () => {
    let calls = 0;
    const txns = await fetchBorosTransactions(
      stub(() => {
        calls += 1;
        return { body: { results: [], total: 999_999 } }; // server bug: total never reachable
      }),
      ADDR,
      3,
    );
    expect(calls).toBe(1); // empty page short-circuits
    expect(txns).toHaveLength(0);
  });

  it('throws (never caches "no history") when results[] is missing', async () => {
    await expect(
      fetchBorosTransactions(stub(() => ({ body: { total: 10 } })), ADDR, 3),
    ).rejects.toMatchObject({ name: 'CoreError', category: 'network' });
  });
});

describe('resolveCollateralPricesUsd', () => {
  it('prices stables at 1, token collateral via a same-asset market, unknown as null', () => {
    const mk = (tokenId: number, base: string, px: number) =>
      ({ marketId: tokenId * 100, tokenId, name: '', venue: '', base, maturity: 0, paymentPeriod: 0, settleFeeApr: 0, markApr: 0, floatingApr: 0, midApr: 0, notionalOi: 0, takerFeeRate: 0, state: 'Normal', assetMarkPriceUsd: px, kIM: 0, imTickThresh: 0, imTickStep: 0, tThreshSec: 0 }) as const;
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
    await fetchBorosCollaterals(record, ADDR);
    await fetchBorosTransactions(record, ADDR, 3);

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
