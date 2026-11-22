import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deepenBook, fetchDeepBook, type NormalizedBook, sigFigsWidth } from '../../src/core/estimate/books';
import { planRealize, type RealizeInput } from '../../src/core/rebalance/realize';
import { FEE_ROWS } from './fixtures/realize-books';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const MID = 2800;
const LADDER = [50, 5_000, 100_000, 1_000_000, 6_000_000];

const range = <T,>(count: number, at: (i: number) => T): T[] => Array.from({ length: count }, (_, i) => at(i));

const hlBody = (sigFigs: number | undefined) => {
  if (sigFigs === undefined) {
    return {
      levels: [
        range(20, (i) => ({ px: (MID - 0.05 - i * 0.1).toFixed(2), sz: '15' })),
        range(20, (i) => ({ px: (MID + 0.05 + i * 0.1).toFixed(2), sz: '15' })),
      ],
    };
  }
  const step = sigFigsWidth(sigFigs)(MID);
  const bucket = String(15 * step * 10);
  return {
    levels: [
      range(20, (i) => ({ px: String(MID - (i + 1) * step), sz: bucket })),
      range(20, (i) => ({ px: String(MID + (i + 1) * step), sz: bucket })),
    ],
  };
};

const shortInput = (need: number, book: NormalizedBook | null): RealizeInput => {
  const positionQty = Math.max(1, (need / 200) * 1.5);
  return {
    pool: 'HYPERLIQUID',
    moveUsd: need + 100,
    cashUsd: 100,
    borrowUsd: need * 2,
    convertCounts: true,
    availableMargin: 1e9,
    perps: [
      {
        symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
        positionQty: String(-positionQty),
        entryPrice: '3000',
        markPrice: '2800',
        initialMargin: String((positionQty * 2800) / 25),
      },
    ],
    books: { HYPERLIQUID_FUTURE_ETH_USDC: book },
    feeRows: FEE_ROWS,
    rules: { HYPERLIQUID_FUTURE_ETH_USDC: { lotSize: '0.0001', minSize: '0.0001' } },
  };
};

describe('deep book reads', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.get).mockReset();
  });

  it('coarse buckets round against the trader and skip the boundary bucket', () => {
    const fine: NormalizedBook = { bids: [[2799.95, 1], [2799.05, 1]], asks: [[2800.05, 1], [2800.95, 1]], ts: 0 };
    const coarse: NormalizedBook = {
      bids: [[2799, 9], [2797.6, 4], [2797, 3]],
      asks: [[2801, 9], [2802.4, 4], [2803, 3]],
      ts: 0,
    };
    const deep = deepenBook(fine, coarse, () => 1);
    expect(deep.asks).toEqual([[2800.05, 1], [2800.95, 1], [2803, 4], [2803, 3]]);
    expect(deep.bids).toEqual([[2799.95, 1], [2799.05, 1], [2797, 4], [2797, 3]]);
  });

  it('a $100K Hyperliquid order at about 10 bp is priced from the deep read, not refused past-book', async () => {
    vi.mocked(axios.post).mockImplementation(async (_url, body) => ({
      data: hlBody((body as { nSigFigs?: number }).nSigFigs),
    }));
    const deep = await fetchDeepBook('HYPERLIQUID', 'ETH', 'USDC');
    expect(vi.mocked(axios.post).mock.calls.map(([, body]) => (body as { nSigFigs?: number }).nSigFigs)).toEqual([
      undefined,
      4,
      3,
    ]);
    const fine = hlBody(undefined);
    const top: NormalizedBook = {
      bids: fine.levels[0].map((l) => [Number(l.px), Number(l.sz)]),
      asks: fine.levels[1].map((l) => [Number(l.px), Number(l.sz)]),
      ts: 0,
    };
    expect(planRealize(shortInput(100_000, top))?.refused?.reason).toBe('past-book');
    const plan = planRealize(shortInput(100_000, deep));
    expect(plan?.refused).toBeNull();
    expect(plan?.legs[0].impactBp).toBeGreaterThan(5);
    expect(plan?.legs[0].impactBp).toBeLessThan(25);
    const held = Math.min(...[deep?.asks ?? [], deep?.bids ?? []].map((side) => side.reduce((t, [, q]) => t + q, 0)));
    let priced = 0;
    for (const need of LADDER) {
      const rung = planRealize(shortInput(need, deep));
      if ((rung?.legs[0].qty ?? 0) > held) expect(rung?.refused?.reason).toBe('past-book');
      else {
        priced += 1;
        expect(rung?.refused?.reason).not.toBe('past-book');
      }
    }
    expect(priced).toBe(4);
  });

  it('a Gate read takes 300 levels and one coarse read at ten ticks', async () => {
    const urls: string[] = [];
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.includes('/contracts/')) return { data: { quanto_multiplier: '0.01', order_price_round: '0.01' } };
      const coarse = url.includes('interval=');
      const step = coarse ? 0.1 : 0.01;
      const size = coarse ? '50000' : '5000';
      return {
        data: {
          bids: range(300, (i) => ({ p: (MID - (coarse ? 4 : 0) - i * step).toFixed(2), s: size })),
          asks: range(300, (i) => ({ p: (MID + (coarse ? 4 : 0.01) + i * step).toFixed(2), s: size })),
        },
      };
    });
    const deep = await fetchDeepBook('GATE', 'ETH', 'USDT');
    expect(urls.filter((url) => url.includes('order_book')).sort()).toEqual([
      'https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=ETH_USDT&limit=300',
      'https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=ETH_USDT&limit=300&interval=0.1',
    ]);
    expect(deep?.asks.length).toBeGreaterThan(300);
    expect(deep?.asks.every(([price], i, all) => i === 0 || price > all[i - 1][0])).toBe(true);
    expect(deep?.bids.every(([price], i, all) => i === 0 || price < all[i - 1][0])).toBe(true);
  });

  it('a failed coarse read keeps the fine book', async () => {
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      if ((body as { nSigFigs?: number }).nSigFigs) throw new Error('rate limited');
      return { data: hlBody(undefined) };
    });
    const deep = await fetchDeepBook('HYPERLIQUID', 'ETH', 'USDC');
    expect(deep?.asks).toHaveLength(20);
  });
});
