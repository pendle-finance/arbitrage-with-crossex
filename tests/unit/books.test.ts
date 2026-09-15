import { describe, it, expect } from 'vitest';
import {
  nativeSymbol,
  parseBinanceBook,
  parseBybitBook,
  parseGateBook,
  parseHlBook,
  parseKrakenBook,
  parseLighterBook,
  parseOkxBook,
  lighterMarketId,
} from '../../src/core/estimate/books';

describe('nativeSymbol', () => {
  it('maps each venue to its own instrument id', () => {
    expect(nativeSymbol('BINANCE', 'BTC', 'USDT')).toBe('BTCUSDT');
    expect(nativeSymbol('BYBIT', 'BTC', 'USDT')).toBe('BTCUSDT');
    expect(nativeSymbol('OKX', 'BTC', 'USDT')).toBe('BTC-USDT-SWAP');
    expect(nativeSymbol('KRAKEN', 'BTC', 'USD')).toBe('PF_BTCUSD');
    expect(nativeSymbol('HYPERLIQUID', 'BTC', 'USDC')).toBe('BTC');
    expect(nativeSymbol('LIGHTER', 'ETH', 'USDC')).toBe('ETH');
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

describe('parseLighterBook', () => {
  const order = (price: string, qty: string) => ({
    order_index: 1,
    order_id: '1',
    owner_account_index: 7,
    initial_base_amount: qty,
    remaining_base_amount: qty,
    price,
    order_expiry: 1789532407887,
    transaction_time: 0,
  });
  const payload = {
    code: 200,
    total_asks: 3,
    asks: [order('2499.07', '0.0443'), order('2499.07', '0.5'), order('2499.10', '1.2')],
    total_bids: 2,
    bids: [order('2498.98', '1.3865'), order('2498.90', '0.25')],
  };

  it('merges single orders at one price into one level', () => {
    const b = parseLighterBook(payload)!;
    expect(b.asks).toEqual([
      [2499.07, 0.5443],
      [2499.1, 1.2],
    ]);
    expect(b.bids).toEqual([
      [2498.98, 1.3865],
      [2498.9, 0.25],
    ]);
  });

  it('returns null on garbage', () => {
    expect(parseLighterBook({ asks: [], bids: [] })).toBeNull();
    expect(parseLighterBook({})).toBeNull();
  });
});

describe('lighterMarketId', () => {
  const list = {
    code: 200,
    order_books: [
      { symbol: 'ETH/USDC', market_id: 2048, market_type: 'spot', status: 'active' },
      { symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active' },
      { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active' },
      { symbol: 'OLD', market_id: 90, market_type: 'perp', status: 'inactive' },
    ],
  };

  it('finds the active perp market for a base coin, id 0 included', () => {
    expect(lighterMarketId(list, 'ETH')).toBe('0');
    expect(lighterMarketId(list, 'BTC')).toBe('1');
  });

  it('returns null for a spot-only, inactive or unknown coin', () => {
    expect(lighterMarketId(list, 'OLD')).toBeNull();
    expect(lighterMarketId(list, 'DOGE')).toBeNull();
    expect(lighterMarketId({}, 'ETH')).toBeNull();
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
