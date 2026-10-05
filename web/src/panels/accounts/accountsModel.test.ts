/**
 * Every account — Gate CrossEx and each Boros account — in one format, on one
 * scale: an account liquidates when maintenance margin used reaches 100%.
 */
import { describe, expect, it } from 'vitest';
import type { AssetBorosMargin, CrossexAccount } from '../../api/types';
import { buildAccountsView, verdictText } from './accountsModel';

const gate: CrossexAccount = {
  marginBalance: '20000',
  availableMargin: '15000',
  initialMargin: '5000',
  maintenanceMargin: '2500',
  initialMarginRate: '4',
  maintenanceMarginRate: '8',
  accountMode: 'CROSS_EXCHANGE',
  positionMode: 'ONE_WAY',
  assets: [],
};

const bucket = (over: Partial<AssetBorosMargin> = {}): AssetBorosMargin => ({
  tokenId: 2,
  collateral: 'ETH',
  isCross: true,
  healthFactor: 2,
  availableToken: 4,
  equityToken: 10,
  availableUsd: 10_000,
  equityUsd: 25_000,
  maintMarginUsd: 10_000,
  ...over,
});

describe('buildAccountsView', () => {
  it('puts Gate and each Boros account in the same format', () => {
    const v = buildAccountsView({ acc: gate, borosMargin: [bucket()] });
    expect(v.rows.map((r) => [r.name, r.availableUsd, r.balanceUsd, r.imUsed, r.mmUsed])).toEqual([
      ['Gate CrossEx', 15_000, 20_000, 0.25, 0.125],
      // Boros IM is the balance less what is free: (25,000 − 10,000) / 25,000.
      ['ETH cross', 10_000, 25_000, 0.6, 0.4],
    ]);
    // In the account's own coin too, from the server's token figures.
    expect(v.rows[1].token).toEqual({ symbol: 'ETH', available: 4, balance: 10 });
    expect(v.rows[0].token).toBeNull();
  });

  it('keeps a dollar account in dollars and skips an empty one', () => {
    const v = buildAccountsView({
      acc: null,
      borosMargin: [
        bucket({ tokenId: 3, collateral: 'USDT', equityUsd: 2_500, availableUsd: 2_500, maintMarginUsd: 0 }),
        bucket({ tokenId: 1, collateral: 'BTC', equityUsd: 0, availableUsd: 0, maintMarginUsd: 0 }),
      ],
    });
    expect(v.rows.map((r) => r.name)).toEqual(['USDT cross']);
    expect(v.rows[0].token).toBeNull();
  });

  it('names an isolated account by its market', () => {
    const v = buildAccountsView({
      acc: null,
      borosMargin: [bucket({ isCross: false, marketId: 7, marketVenue: 'HYPERLIQUID', marketBase: 'ETH' })],
    });
    expect(v.rows[0].name).toBe('Hyperliquid ETH isolated');
  });

  it('turns amber from 67% maintenance used and red from 91%, and names the worst account', () => {
    const ok = buildAccountsView({ acc: gate, borosMargin: [bucket()] });
    expect([ok.level, verdictText(ok), ok.worst]).toEqual(['ok', 'All accounts healthy', null]);

    const watch = buildAccountsView({ acc: gate, borosMargin: [bucket({ maintMarginUsd: 17_500 })] });
    expect(watch.level).toBe('watch');
    expect(verdictText(watch)).toBe('1 account needs attention');

    const risk = buildAccountsView({
      acc: gate,
      borosMargin: [bucket({ maintMarginUsd: 17_500 }), bucket({ tokenId: 1, collateral: 'BTC', maintMarginUsd: 23_750 })],
    });
    expect(risk.level).toBe('risk');
    expect(verdictText(risk)).toBe('1 account near liquidation');
    expect(risk.worst?.name).toBe('BTC cross');
  });

  it('sums every Boros account for the header, and keeps Gate on its own', () => {
    const v = buildAccountsView({
      acc: gate,
      borosMargin: [bucket(), bucket({ tokenId: 3, collateral: 'USDT', equityUsd: 2_500, availableUsd: 2_500, maintMarginUsd: 0 })],
    });
    expect(v.totals).toEqual({
      CrossEx: { availableUsd: 15_000, balanceUsd: 20_000 },
      Boros: { availableUsd: 12_500, balanceUsd: 27_500 },
    });
  });
});
