import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CrossexAccount, CrossexPosition, ExposureGroup, PositionsResponse } from '../../web/src/api/types';
import { buildTriggerCoins, type TriggerCoin } from '../../src/core/alerts/triggers';
import { isSupportedCoin, SUPPORTED_COINS } from '../../src/core/coins';
import { MARK_MEMORY_MS, rememberMarks, resetMarkMemory } from '../../src/core/marks';

const dir = new URL('../fixtures/owner-2026-09-18/', import.meta.url);
const account = JSON.parse(readFileSync(new URL('account.json', dir), 'utf8')) as CrossexAccount;
const positions = JSON.parse(readFileSync(new URL('positions.json', dir), 'utf8')) as PositionsResponse;

beforeEach(resetMarkMemory);

function ethOf(coins: TriggerCoin[]): TriggerCoin {
  const eth = coins.find((c) => c.coin === 'ETH');
  if (!eth) throw new Error('no ETH entry');
  return eth;
}

function withLeg(base: string, exchange: string, mark: string): PositionsResponse {
  const symbol = `${exchange}_FUTURE_${base}_USDT`;
  const position: CrossexPosition = { ...positions.positions[0], symbol, markPrice: mark, maintenanceMargin: '5' };
  const leg = { symbol, exchange, quote: 'USDT', side: 'LONG' as const, qty: 1, value: 5_000 };
  const held = positions.exposure.some((g) => g.base === base);
  const exposure: ExposureGroup[] = held
    ? positions.exposure.map((g) => (g.base === base ? { ...g, legs: [...g.legs, leg] } : g))
    : [...positions.exposure, { ...positions.exposure[0], base, legs: [leg] }];
  return { positions: [...positions.positions, position], exposure };
}

describe('supported coins', () => {
  it('lists ETH, HYPE and BTC only', () => {
    expect(SUPPORTED_COINS).toEqual(['ETH', 'HYPE', 'BTC']);
  });

  it('matches a coin in any case and refuses the rest', () => {
    expect(isSupportedCoin('eth')).toBe(true);
    expect(isSupportedCoin('Hype')).toBe(true);
    expect(isSupportedCoin('BTC')).toBe(true);
    expect(isSupportedCoin('SOL')).toBe(false);
    expect(isSupportedCoin('')).toBe(false);
  });
});

describe('buildTriggerCoins on the owner account of 2026-09-18', () => {
  it('owner ETH liquidation: up at $13,663 on HYPERLIQUID, no down line', () => {
    const { liquidation } = ethOf(buildTriggerCoins(account, positions));
    expect(liquidation.up?.venue).toBe('HYPERLIQUID');
    expect(Math.abs((liquidation.up?.price ?? 0) - 13663)).toBeLessThanOrEqual(1);
    expect(liquidation.down).toBeNull();
  });

  it('owner ETH interest: down $1,612 on USDT, up $3,242 on LIGHTER', () => {
    const { interest } = ethOf(buildTriggerCoins(account, positions));
    expect(interest.down?.wallet).toBe('USDT');
    expect(Math.abs((interest.down?.price ?? 0) - 1612)).toBeLessThanOrEqual(1);
    expect(interest.up?.wallet).toBe('LIGHTER');
    expect(Math.abs((interest.up?.price ?? 0) - 3242)).toBeLessThanOrEqual(1);
  });

  it('owner ETH legs: every CrossEx leg with its venue and side', () => {
    expect(ethOf(buildTriggerCoins(account, positions)).legs).toEqual([
      { venue: 'OKX', side: 'long' },
      { venue: 'LIGHTER', side: 'short' },
      { venue: 'BINANCE', side: 'long' },
      { venue: 'GATE', side: 'long' },
      { venue: 'HYPERLIQUID', side: 'short' },
    ]);
  });

  it('owner HYPE: never on a fall, and the true price on the far pump', () => {
    const hype = buildTriggerCoins(account, positions).find((c) => c.coin === 'HYPE');
    expect(hype?.liquidation.down).toBeNull();
    expect(hype?.liquidation.up?.venue).toBe('HYPERLIQUID');
    expect(hype?.liquidation.up?.price ?? 0).toBeGreaterThan(86.597 * 10);
    expect(hype?.interest.down).toBeNull();
    expect(hype?.interest.up?.wallet).toBe('HYPERLIQUID');
    expect(hype?.interest.up?.price ?? 0).toBeCloseTo(86.597 * (1 + (10_000 + 539.16436148) / 199.1455), 2);
  });

  it('minimal fields: coin, legs, liquidation and interest, nothing else', () => {
    const coins = buildTriggerCoins(account, positions);
    expect(coins.length).toBeGreaterThan(0);
    for (const coin of coins) {
      expect(Object.keys(coin).sort()).toEqual(['coin', 'interest', 'legs', 'liquidation', 'rolls']);
      for (const leg of coin.legs) expect(Object.keys(leg).sort()).toEqual(['side', 'venue']);
      expect(Object.keys(coin.liquidation).sort()).toEqual(['down', 'up']);
      expect(Object.keys(coin.interest).sort()).toEqual(['down', 'up']);
      for (const side of [coin.liquidation.down, coin.liquidation.up]) {
        if (side) expect(Object.keys(side).sort()).toEqual(['price', 'venue']);
      }
      for (const side of [coin.interest.down, coin.interest.up]) {
        if (side) expect(Object.keys(side).sort()).toEqual(['price', 'wallet']);
      }
    }
    const eth = ethOf(coins);
    expect(eth.rolls).toEqual([]);
    expect(eth.liquidation.up).not.toBeNull();
    expect(eth.interest.down).not.toBeNull();
    expect(eth.interest.up).not.toBeNull();
  });

  it('skips coins outside the set', () => {
    const coins = buildTriggerCoins(account, withLeg('SOL', 'GATE', '150'));
    expect(coins.map((c) => c.coin)).toEqual(['ETH', 'HYPE']);
  });

  it('ignores Boros legs', () => {
    const owner = ethOf(buildTriggerCoins(account, positions));
    const eth = ethOf(buildTriggerCoins(account, withLeg('ETH', 'BOROS', '2473')));
    expect(eth.legs.some((l) => l.venue === 'BOROS')).toBe(false);
    expect(eth.liquidation).toEqual(owner.liquidation);
    expect(eth.interest).toEqual(owner.interest);
  });

  it('refuses to build when Gate margin figures are not numbers', () => {
    expect(() => buildTriggerCoins({ ...account, marginBalance: 'n/a' }, positions)).toThrow(/not a number/);
    expect(() => buildTriggerCoins({ ...account, maintenanceMargin: 'x' }, positions)).toThrow(/not a number/);
  });
});

describe('buildTriggerCoins on a book that liquidates either way', () => {
  const template = positions.positions[0];
  const asset = account.assets[0];
  const acc: CrossexAccount = {
    ...account,
    marginBalance: '1000',
    maintenanceMargin: '200',
    assets: [
      { ...asset, coin: 'USDT', exchangeType: 'CROSSEX', equity: '500' },
      { ...asset, coin: 'USDC', exchangeType: 'HYPERLIQUID', equity: '500' },
    ],
  };
  const book: PositionsResponse = {
    positions: [
      { ...template, symbol: 'GATE_FUTURE_ETH_USDT', markPrice: '100', maintenanceMargin: '100' },
      { ...template, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', markPrice: '100', maintenanceMargin: '100' },
    ],
    exposure: [
      {
        ...positions.exposure[0],
        base: 'ETH',
        legs: [
          { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'SHORT', qty: 200, value: 20_000 },
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'LONG', qty: 200, value: 20_000 },
        ],
      },
    ],
  };

  it('liquidates on both sides: up on the Gate short, down on the Hyperliquid long', () => {
    const { liquidation } = ethOf(buildTriggerCoins(acc, book));
    expect(liquidation.up?.venue).toBe('GATE');
    expect(liquidation.up?.price).toBeCloseTo(100 * (1 + 850 / 2200), 2);
    expect(liquidation.down?.venue).toBe('HYPERLIQUID');
    expect(liquidation.down?.price).toBeCloseTo(100 * (1 - 850 / 1800), 2);
  });

  it('sends no liquidation trigger for a coin whose leg has never had a mark, and still lists its legs', () => {
    for (const symbol of ['GATE_FUTURE_ETH_USDT', 'HYPERLIQUID_FUTURE_ETH_USDC']) {
      resetMarkMemory();
      const blanked: PositionsResponse = {
        ...book,
        positions: book.positions.map((p) => (p.symbol === symbol ? { ...p, markPrice: '' } : p)),
      };
      const eth = ethOf(buildTriggerCoins(acc, blanked));
      expect(eth.liquidation).toEqual({ down: null, up: null });
      expect(eth.liquidationUnknown).toBe(true);
      expect(eth.legs).toEqual([
        { venue: 'GATE', side: 'short' },
        { venue: 'HYPERLIQUID', side: 'long' },
      ]);
    }
  });

  it('keeps the line on the last price Gate sent when a mark goes blank inside 60 s', () => {
    const blanked: PositionsResponse = {
      ...book,
      positions: book.positions.map((p) =>
        p.symbol === 'GATE_FUTURE_ETH_USDT' ? { ...p, markPrice: '' } : p,
      ),
    };
    rememberMarks(book.positions, Date.now() - (MARK_MEMORY_MS - 5_000));
    const eth = ethOf(buildTriggerCoins(acc, blanked));
    expect(eth.liquidationUnknown).toBeUndefined();
    expect(eth.liquidation.up?.price).toBeCloseTo(100 * (1 + 850 / 2200), 2);
  });

  it('says the liquidation is unknown once the last price is over 60 s old', () => {
    const blanked: PositionsResponse = {
      ...book,
      positions: book.positions.map((p) =>
        p.symbol === 'GATE_FUTURE_ETH_USDT' ? { ...p, markPrice: '' } : p,
      ),
    };
    rememberMarks(book.positions, Date.now() - (MARK_MEMORY_MS + 5_000));
    const eth = ethOf(buildTriggerCoins(acc, blanked));
    expect(eth.liquidationUnknown).toBe(true);
    expect(eth.liquidation).toEqual({ down: null, up: null });
    expect(eth.legs.length).toBe(2);
  });

  it('prices interest on both sides of the same book', () => {
    const { interest } = ethOf(buildTriggerCoins(acc, book));
    expect(interest.up?.wallet).toBe('USDT');
    expect(interest.up?.price).toBeCloseTo(102.5, 6);
    expect(interest.down?.wallet).toBe('HYPERLIQUID');
    expect(interest.down?.price).toBeCloseTo(47.5, 6);
  });
});

describe('buildTriggerCoins with Gate risk limit tiers', () => {
  const template = positions.positions[0];
  const asset = account.assets[0];
  const acc: CrossexAccount = {
    ...account,
    marginBalance: '400000',
    maintenanceMargin: '52550',
    assets: [
      { ...asset, coin: 'USDT', exchangeType: 'CROSSEX', equity: '400000' },
      { ...asset, coin: 'USDC', exchangeType: 'HYPERLIQUID', equity: '0' },
    ],
  };
  const book: PositionsResponse = {
    positions: [
      { ...template, symbol: 'GATE_FUTURE_HYPE_USDT', markPrice: '40', maintenanceMargin: '15050' },
      { ...template, symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', markPrice: '40', maintenanceMargin: '37500' },
    ],
    exposure: [
      {
        ...positions.exposure[0],
        base: 'HYPE',
        legs: [
          { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 18_750, value: 750_000 },
          { symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 18_750, value: 750_000 },
        ],
      },
    ],
  };
  const tiers = {
    GATE_FUTURE_HYPE_USDT: [
      { from: 0, rate: 0.015, deduction: 0 },
      { from: 200_000, rate: 0.018, deduction: 600 },
      { from: 300_000, rate: 0.02, deduction: 1_200 },
      { from: 500_000, rate: 0.025, deduction: 3_700 },
      { from: 1_000_000, rate: 0.08, deduction: 58_700 },
      { from: 6_000_000, rate: 0.1, deduction: 178_700 },
    ],
    HYPERLIQUID_FUTURE_HYPE_USDC: [{ from: 0, rate: 0.05, deduction: 0 }],
  };

  const hypeOf = (coins: TriggerCoin[]): TriggerCoin => {
    const hype = coins.find((c) => c.coin === 'HYPE');
    if (!hype) throw new Error('no HYPE entry');
    return hype;
  };

  it('sends the tiered line, nearer than the flat one, on a $400,000 account', () => {
    expect(hypeOf(buildTriggerCoins(acc, book)).liquidation.up?.price).toBeCloseTo(148.96, 1);
    expect(hypeOf(buildTriggerCoins(acc, book, tiers)).liquidation.up?.price).toBeCloseTo(123.76, 1);
  });
});
