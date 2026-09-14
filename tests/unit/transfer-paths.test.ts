import { describe, it, expect } from 'vitest';
import {
  pathRule,
  transferPaths,
  type AccountLike,
  type AssetLike,
  type CoinRuleLike,
  type SpotBalance,
  type TransferPath,
} from '../../src/core/rebalance/plan';

function cashRow(coin: string, exchangeType: string, balance: string): AssetLike {
  return { coin, exchangeType, balance, borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0' };
}

const ACCOUNT: AccountLike = {
  availableMargin: '831.95',
  marginBalance: '988.23',
  initialMargin: '156.28',
  assets: [
    cashRow('USDT', 'CROSSEX', '986.60'),
    cashRow('USDC', 'GATE', '0.29'),
    cashRow('USDC', 'HYPERLIQUID', '11.92'),
  ],
};

const COINS: CoinRuleLike[] = [
  { coin: 'USDT', minTransAmount: 0.00000001, estFee: 0, isDisabled: 0 },
  { coin: 'USDC', minTransAmount: 11, estFee: 1, isDisabled: 0 },
];

const SPOT: SpotBalance[] = [
  { coin: 'USDT', available: 318.429, locked: 0 },
  { coin: 'USDC', available: 0, locked: 0 },
];

const pathOf = (paths: TransferPath[], coin: string, from: string, to: string): TransferPath => {
  const found = paths.find((p) => p.coin === coin && p.from === from && p.to === to);
  if (!found) throw new Error(`no path ${coin} ${from} to ${to}`);
  return found;
};

describe('transferPaths', () => {
  const paths = transferPaths({ account: ACCOUNT, spot: SPOT, coins: COINS });

  it('USDT out max at 112 percent', () => {
    expect(pathOf(paths, 'USDT', 'CROSSEX', 'SPOT').max).toBe(813.19);
  });

  it('Hyperliquid out max is cash', () => {
    expect(pathOf(paths, 'USDC', 'CROSSEX_HYPERLIQUID', 'SPOT').max).toBe(11.92);
  });

  it('six paths', () => {
    expect(paths.map((p) => [p.coin, p.from, p.to])).toEqual([
      ['USDT', 'SPOT', 'CROSSEX'],
      ['USDT', 'CROSSEX', 'SPOT'],
      ['USDC', 'SPOT', 'CROSSEX_GATE'],
      ['USDC', 'CROSSEX_GATE', 'SPOT'],
      ['USDC', 'SPOT', 'CROSSEX_HYPERLIQUID'],
      ['USDC', 'CROSSEX_HYPERLIQUID', 'SPOT'],
    ]);
  });

  it('minimum 11 on Hyperliquid paths', () => {
    expect(pathOf(paths, 'USDC', 'SPOT', 'CROSSEX_HYPERLIQUID').min).toBe(11);
    expect(pathOf(paths, 'USDC', 'CROSSEX_HYPERLIQUID', 'SPOT').min).toBe(11);
    expect(pathOf(paths, 'USDC', 'SPOT', 'CROSSEX_GATE').min).toBe(0);
    expect(pathOf(paths, 'USDC', 'CROSSEX_GATE', 'SPOT').min).toBe(0);
    expect(pathOf(paths, 'USDT', 'SPOT', 'CROSSEX').min).toBe(0.00000001);
    expect(pathOf(paths, 'USDT', 'CROSSEX', 'SPOT').min).toBe(0.00000001);
  });

  it('fees per path', () => {
    expect(paths.map((p) => p.feeUsd)).toEqual([0, 0, 0, 0, 0.05, 1]);
  });

  it('no spot read no max', () => {
    const unread = transferPaths({ account: ACCOUNT, spot: null, coins: COINS });
    expect(unread.filter((p) => p.from === 'SPOT').map((p) => p.max)).toEqual([null, null, null]);
  });

  it('string coin rules', () => {
    const wire = [{ coin: 'USDC', minTransAmount: '11', estFee: '1', isDisabled: '0' }];
    const parsed = transferPaths({ account: ACCOUNT, spot: SPOT, coins: wire });
    for (const path of parsed.filter((p) => p.from === 'CROSSEX_HYPERLIQUID' || p.to === 'CROSSEX_HYPERLIQUID')) {
      expect(path.min).toBe(11);
      expect(typeof path.min).toBe('number');
    }
    expect(typeof pathOf(parsed, 'USDC', 'CROSSEX_HYPERLIQUID', 'SPOT').feeUsd).toBe('number');
  });

  it('spot max is the spot available floored to cents', () => {
    expect(pathOf(paths, 'USDT', 'SPOT', 'CROSSEX').max).toBe(318.42);
    expect(pathOf(paths, 'USDC', 'SPOT', 'CROSSEX_HYPERLIQUID').max).toBe(0);
  });

  it('spot max is 0 for a coin spot does not list', () => {
    const usdtOnly = transferPaths({ account: ACCOUNT, spot: [SPOT[0]], coins: COINS });
    expect(pathOf(usdtOnly, 'USDC', 'SPOT', 'CROSSEX_GATE').max).toBe(0);
  });

  it('Gate bucket out max is its cash', () => {
    expect(pathOf(paths, 'USDC', 'CROSSEX_GATE', 'SPOT').max).toBe(0.29);
  });

  it('missing coin rules fall back to the static table', () => {
    const fallback = transferPaths({ account: ACCOUNT, spot: SPOT, coins: [] });
    expect(fallback.map((p) => p.min)).toEqual([0.00000001, 0.00000001, 0, 0, 11, 11]);
    expect(fallback.map((p) => p.feeUsd)).toEqual([0, 0, 0, 0, 0.05, 1]);
  });

  it('seconds per path', () => {
    expect(paths.map((p) => p.seconds)).toEqual([3, 3, 5, 5, 120, 400]);
  });
});

describe('pathRule', () => {
  it('reads a path in the table', () => {
    expect(pathRule('USDC', 'CROSSEX_HYPERLIQUID', 'SPOT')).toEqual({
      coin: 'USDC',
      from: 'CROSSEX_HYPERLIQUID',
      to: 'SPOT',
      min: 11,
      feeUsd: 1,
      seconds: 400,
    });
  });

  it('is null for a path not in the table', () => {
    expect(pathRule('USDC', 'CROSSEX_HYPERLIQUID', 'CROSSEX_GATE')).toBeNull();
    expect(pathRule('USDT', 'SPOT', 'CROSSEX_GATE')).toBeNull();
  });
});
