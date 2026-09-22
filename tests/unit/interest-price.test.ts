import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CrossexAccount, PositionsResponse } from '../../web/src/api/types';
import { HYPERLIQUID_FREE_BORROW_USDC, interestPrices } from '../../src/core/alerts/interestPrice';

const dir = new URL('../fixtures/owner-2026-09-18/', import.meta.url);
const account = JSON.parse(readFileSync(new URL('account.json', dir), 'utf8')) as CrossexAccount;
const positions = JSON.parse(readFileSync(new URL('positions.json', dir), 'utf8')) as PositionsResponse;

const ETH_HYPERLIQUID_MARK = 2473.41;

function withoutLighterEth(book: PositionsResponse): PositionsResponse {
  return {
    ...book,
    exposure: book.exposure.map((g) => ({ ...g, legs: g.legs.filter((l) => l.exchange !== 'LIGHTER') })),
  };
}

function withEquity(coin: string, exchangeType: string, equity: string | null): CrossexAccount {
  const others = account.assets.filter((a) => !(a.coin === coin && a.exchangeType === exchangeType));
  const mine = account.assets.find((a) => a.coin === coin && a.exchangeType === exchangeType);
  if (equity === null || !mine) return { ...account, assets: others };
  return { ...account, assets: [...others, { ...mine, equity }] };
}

function scaled(k: number): { acc: CrossexAccount; book: PositionsResponse } {
  const times = (v: string) => String(Number(v) * k);
  return {
    acc: {
      ...account,
      marginBalance: times(account.marginBalance),
      maintenanceMargin: times(account.maintenanceMargin),
      assets: account.assets.map((a) => ({ ...a, equity: times(a.equity) })),
    },
    book: {
      positions: positions.positions.map((p) => ({ ...p, maintenanceMargin: times(p.maintenanceMargin) })),
      exposure: positions.exposure.map((g) => ({ ...g, legs: g.legs.map((l) => ({ ...l, value: l.value * k })) })),
    },
  };
}

describe('interestPrices on the owner account of 2026-09-18', () => {
  it('USDT down side: the USDT CrossEx wallet goes below $0 at $1,612', () => {
    const { down } = interestPrices(account, positions, 'ETH');
    expect(down?.wallet).toBe('USDT');
    expect(Math.abs((down?.price ?? 0) - 1612)).toBeLessThanOrEqual(1);
  });

  it('Lighter up side: the USDC Lighter wallet goes below $0 at $3,242', () => {
    const { up } = interestPrices(account, positions, 'ETH');
    expect(up?.wallet).toBe('LIGHTER');
    expect(Math.abs((up?.price ?? 0) - 3242)).toBeLessThanOrEqual(1);
  });

  it('Hyperliquid starts at -10,000, the free allowance in Gate help 49324', () => {
    expect(HYPERLIQUID_FREE_BORROW_USDC).toBe(10_000);
    const { up } = interestPrices(account, withoutLighterEth(positions), 'ETH');
    expect(up?.wallet).toBe('HYPERLIQUID');
    expect(Math.abs((up?.price ?? 0) - 19472)).toBeLessThanOrEqual(1);
  });

  it('none within range: HYPE crosses no line from 0.02x to 10x', () => {
    expect(interestPrices(account, positions, 'HYPE')).toEqual({ down: null, up: null });
  });

  it('reads the coin in any case', () => {
    expect(interestPrices(account, positions, 'eth')).toEqual(interestPrices(account, positions, 'ETH'));
  });

  it('gives nothing for a coin the account does not hold', () => {
    expect(interestPrices(account, positions, 'BTC')).toEqual({ down: null, up: null });
  });

  it('a wallet already below $0 gives a down price above the price now', () => {
    const { down } = interestPrices(withEquity('USDT', 'CROSSEX', '-5'), positions, 'ETH');
    expect(down?.wallet).toBe('USDT');
    expect(down?.price ?? 0).toBeGreaterThan(ETH_HYPERLIQUID_MARK);
  });

  it('a wallet already past -10,000 gives an up price below the price now', () => {
    const { up } = interestPrices(withEquity('USDC', 'HYPERLIQUID', '-10500'), withoutLighterEth(positions), 'ETH');
    expect(up?.wallet).toBe('HYPERLIQUID');
    expect(up?.price ?? Infinity).toBeLessThan(ETH_HYPERLIQUID_MARK);
  });

  it('refuses a wallet equity that is not a number', () => {
    expect(() => interestPrices(withEquity('USDT', 'CROSSEX', 'n/a'), positions, 'ETH')).toThrow(/not a number/);
  });

  it('refuses a blank wallet equity instead of reading it as $0', () => {
    expect(() => interestPrices(withEquity('USDT', 'CROSSEX', ''), positions, 'ETH')).toThrow(/not a number/);
  });

  it('sends the Hyperliquid line once the nearer Lighter line is crossed', () => {
    const crossed = withEquity('USDC', 'LIGHTER', '-1');
    const { up } = interestPrices(crossed, positions, 'ETH');
    expect(up?.wallet).toBe('HYPERLIQUID');
    expect(Math.abs((up?.price ?? 0) - 19472)).toBeLessThanOrEqual(1);
  });

  it('counts a wallet with no asset row as $0, so interest starts at the price now', () => {
    const { up } = interestPrices(withEquity('USDC', 'LIGHTER', null), positions, 'ETH');
    expect(up).toEqual({ price: ETH_HYPERLIQUID_MARK, wallet: 'LIGHTER' });
  });

  it('scales with the book', () => {
    const base = interestPrices(account, positions, 'ETH');
    const hyperliquid: number[] = [];
    for (const k of [1, 100, 1_000, 3_500]) {
      const { acc, book } = scaled(k);
      const prices = interestPrices(acc, book, 'ETH');
      expect(prices.down?.wallet).toBe('USDT');
      expect(Math.abs((prices.down?.price ?? 0) - (base.down?.price ?? 0))).toBeLessThanOrEqual(1);
      expect(prices.up?.wallet).toBe('LIGHTER');
      expect(Math.abs((prices.up?.price ?? 0) - (base.up?.price ?? 0))).toBeLessThanOrEqual(1);
      const up = interestPrices(acc, withoutLighterEth(book), 'ETH').up;
      expect(up?.wallet).toBe('HYPERLIQUID');
      hyperliquid.push(up?.price ?? 0);
    }
    expect(Number(scaled(3_500).acc.marginBalance)).toBeGreaterThan(4_000_000);
    for (let i = 1; i < hyperliquid.length; i++) {
      expect(hyperliquid[i]).toBeLessThan(hyperliquid[i - 1]);
      expect(hyperliquid[i]).toBeGreaterThan(ETH_HYPERLIQUID_MARK);
    }
  });
});
