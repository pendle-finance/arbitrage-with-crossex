import { describe, it, expect } from 'vitest';
import {
  nativeSymbol,
  parseBinanceBook,
  parseBybitBook,
  parseGateBook,
  parseHlBook,
  parseKrakenBook,
  parseOkxBook,
  refMidOf,
} from '../../src/core/estimate/books';

describe('nativeSymbol', () => {
  it('maps each venue to its own instrument id', () => {
    expect(nativeSymbol('BINANCE', 'BTC', 'USDT')).toBe('BTCUSDT');
    expect(nativeSymbol('BYBIT', 'BTC', 'USDT')).toBe('BTCUSDT');
    expect(nativeSymbol('OKX', 'BTC', 'USDT')).toBe('BTC-USDT-SWAP');
    expect(nativeSymbol('KRAKEN', 'BTC', 'USD')).toBe('PF_BTCUSD');
    expect(nativeSymbol('HYPERLIQUID', 'BTC', 'USDC')).toBe('BTC');
  });

  it('GATE always uses the USDT-settled contract regardless of the target quote', () => {
    expect(nativeSymbol('GATE', 'BTC', 'USDT')).toBe('BTC_USDT');
    expect(nativeSymbol('GATE', 'BTC', 'USDC')).toBe('BTC_USDT');
  });

  it('unknown venue (open-ended set) returns null', () => {
    expect(nativeSymbol('DERIBIT', 'BTC', 'USDC')).toBeNull();
  });
});

describe('parseGateBook', () => {
  // Gate futures order_book: s = contract COUNT, scaled by quanto_multiplier.
  const payload = {
    id: 123456,
    current: 1719900000.1,
    update: 1719900000.0,
    asks: [
      { p: '65000.1', s: 100 },
      { p: '65001.2', s: 250 },
    ],
    bids: [{ p: '64999.9', s: 50 }],
  };

  it('scales contract counts by the quanto multiplier', () => {
    const b = parseGateBook(payload, 0.0001)!;
    expect(b.asks).toEqual([
      [65000.1, 0.01],
      [65001.2, 0.025],
    ]);
    expect(b.bids).toEqual([[64999.9, 0.005]]);
  });

  it('returns null on garbage', () => {
    expect(parseGateBook({ nope: true }, 0.0001)).toBeNull();
    expect(parseGateBook(null, 0.0001)).toBeNull();
    expect(parseGateBook('<html>', 0.0001)).toBeNull();
  });
});

describe('parseBinanceBook', () => {
  const payload = {
    lastUpdateId: 1,
    bids: [
      ['64999.90', '1.500'],
      ['64999.80', '2.000'],
    ],
    asks: [['65000.10', '0.750']],
  };

  it('reads base-qty string tuples', () => {
    const b = parseBinanceBook(payload)!;
    expect(b.bids).toEqual([
      [64999.9, 1.5],
      [64999.8, 2],
    ]);
    expect(b.asks).toEqual([[65000.1, 0.75]]);
  });

  it('returns null on garbage', () => {
    expect(parseBinanceBook({})).toBeNull();
    expect(parseBinanceBook(undefined)).toBeNull();
  });
});

describe('parseBybitBook', () => {
  const payload = {
    retCode: 0,
    result: {
      s: 'BTCUSDT',
      a: [['65000.10', '0.75']],
      b: [['64999.90', '1.5']],
      ts: 1719900000000,
    },
  };

  it('reads result.a/result.b', () => {
    const b = parseBybitBook(payload)!;
    expect(b.asks).toEqual([[65000.1, 0.75]]);
    expect(b.bids).toEqual([[64999.9, 1.5]]);
  });

  it('returns null on garbage', () => {
    expect(parseBybitBook({ retCode: 0, result: {} })).toBeNull();
    expect(parseBybitBook({})).toBeNull();
  });
});

describe('parseOkxBook', () => {
  const payload = {
    code: '0',
    data: [
      {
        asks: [['65000.1', '2', '0', '4']],
        bids: [['64999.9', '15', '0', '8']],
        ts: '1719900000000',
      },
    ],
  };

  it('scales contract counts by ctVal', () => {
    const b = parseOkxBook(payload, 0.01)!;
    expect(b.asks).toEqual([[65000.1, 0.02]]);
    expect(b.bids).toEqual([[64999.9, 0.15]]);
  });

  it('returns null on garbage', () => {
    expect(parseOkxBook({ code: '0', data: [] }, 0.01)).toBeNull();
    expect(parseOkxBook({}, 0.01)).toBeNull();
  });
});

describe('parseHlBook', () => {
  const payload = {
    coin: 'BTC',
    time: 1719900000000,
    levels: [
      [
        { px: '64999.9', sz: '1.5', n: 3 },
        { px: '64999.8', sz: '2.0', n: 1 },
      ],
      [{ px: '65000.1', sz: '0.75', n: 5 }],
    ],
  };

  it('reads levels[0]=bids, levels[1]=asks', () => {
    const b = parseHlBook(payload)!;
    expect(b.bids).toEqual([
      [64999.9, 1.5],
      [64999.8, 2],
    ]);
    expect(b.asks).toEqual([[65000.1, 0.75]]);
  });

  it('returns null on garbage', () => {
    expect(parseHlBook({ levels: [[]] })).toBeNull();
    expect(parseHlBook({})).toBeNull();
  });
});

describe('parseKrakenBook', () => {
  const payload = {
    result: 'success',
    orderBook: {
      bids: [
        [64999.9, 1.5],
        [64999.8, 2],
      ],
      asks: [[65000.1, 0.75]],
    },
  };

  it('reads numeric tuples under orderBook', () => {
    const b = parseKrakenBook(payload)!;
    expect(b.bids).toEqual([
      [64999.9, 1.5],
      [64999.8, 2],
    ]);
    expect(b.asks).toEqual([[65000.1, 0.75]]);
  });

  it('returns null on garbage', () => {
    expect(parseKrakenBook({ result: 'error' })).toBeNull();
    expect(parseKrakenBook(null)).toBeNull();
  });
});

describe('normalization invariants', () => {
  it('sorts bids desc and asks asc even when the venue sends them unsorted', () => {
    const b = parseBinanceBook({
      bids: [
        ['100', '1'],
        ['102', '1'],
        ['101', '1'],
      ],
      asks: [
        ['105', '1'],
        ['103', '1'],
        ['104', '1'],
      ],
    })!;
    expect(b.bids.map((l) => l[0])).toEqual([102, 101, 100]);
    expect(b.asks.map((l) => l[0])).toEqual([103, 104, 105]);
  });

  it('drops zero/negative/non-numeric levels', () => {
    const b = parseBinanceBook({
      bids: [
        ['100', '0'],
        ['99', '-1'],
        ['abc', '1'],
        ['98', '1'],
      ],
      asks: [],
    })!;
    expect(b.bids).toEqual([[98, 1]]);
    expect(b.asks).toEqual([]);
  });
});

describe('refMidOf execution guard', () => {
  const book = (bid: number, ask: number) => ({
    bids: [[bid, 1] as [number, number]],
    asks: [[ask, 1] as [number, number]],
    ts: 0,
  });

  it('returns the midpoint of a normal two-sided book', () => {
    expect(refMidOf(book(99, 101), 0.05)).toBe(100);
  });

  it('rejects crossed/locked and absurdly wide books', () => {
    expect(refMidOf(book(101, 100), 0.05)).toBeNull();
    expect(refMidOf(book(100, 100), 0.05)).toBeNull();
    expect(refMidOf(book(90, 110), 0.05)).toBeNull();
  });

  it('rejects a one-sided or unavailable book', () => {
    expect(refMidOf({ bids: [[100, 1]], asks: [], ts: 0 }, 0.05)).toBeNull();
    expect(refMidOf(null, 0.05)).toBeNull();
  });
});
