/**
 * assetModel — the asset view's money math: hedge gaps (direction + unit
 * rule), exclusions, the totals composition (and its double-count guard),
 * and the approximate APR.
 */
import { describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { borosKey, deriveAsset, perpKey, SECONDS_IN_YEAR } from './assetModel';

const NOW = 1_760_000_000;
const DAY = 86_400;

const perp = (over: Partial<AssetPerpOpen>): AssetPerpOpen => ({
  symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
  venue: 'HYPERLIQUID',
  side: 'LONG',
  qty: 1000,
  notionalUsd: 1_900_000,
  entryPrice: 1900,
  markPrice: 1900,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: 0,
  openedAt: NOW - 30 * DAY,
  ...over,
});

const boros = (over: Partial<AssetBorosOpen>): AssetBorosOpen => ({
  marketId: 155,
  venue: 'HYPERLIQUID',
  maturity: NOW + 60 * DAY,
  collateral: 'ETH',
  side: 'LONG',
  sizeToken: 1000,
  notionalUsd: 1_900_000,
  entryApr: 0.08,
  markApr: 0.07,
  floatingApr: 0.06,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: 0,
  ...over,
});

const group = (over: Partial<AssetGroup>): AssetGroup => ({
  base: 'ETH',
  priceUsd: 1900,
  earliestSec: NOW - 30 * DAY,
  perpOpen: [],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
  ...over,
});

describe('hedge status', () => {
  it("Hubert's canonical book: 1000 HL long + 600 OKX + 400 Gate shorts, each venue Boros-covered → perfect", () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 }),
        perp({ symbol: 'OKX', venue: 'OKX', side: 'SHORT', qty: 600 }),
        perp({ symbol: 'GATE', venue: 'GATE', side: 'SHORT', qty: 400 }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000 }),
        boros({ marketId: 2, venue: 'OKX', side: 'SHORT', sizeToken: 600 }),
        boros({ marketId: 3, venue: 'GATE', side: 'SHORT', sizeToken: 400 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.deltaNeutral).toBe(true);
    expect(d.gaps).toHaveLength(0);
    expect(d.perfect).toBe(true);
  });

  it('a missing Boros leg reports the exact venue, direction and size', () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 }),
        perp({ symbol: 'OKX', venue: 'OKX', side: 'SHORT', qty: 1000 }),
      ],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.deltaNeutral).toBe(true);
    // A SHORT perp receives floating; a SHORT YU locks it — that's the miss.
    expect(d.gaps).toEqual([{ venue: 'OKX', action: 'short-boros', size: 1000, unit: 'base' }]);
    expect(d.perfect).toBe(false);
  });

  it('a partially-covered venue reports only the shortfall; within 2% counts as covered', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 900 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toEqual([
      { venue: 'HYPERLIQUID', action: 'long-boros', size: 100, unit: 'base' },
    ]);

    const near = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 995 })],
    });
    expect(deriveAsset(near, {}, 0, NOW).gaps).toHaveLength(0);
  });

  it('an unbalanced perp book is flagged even when every floating leg is covered', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toHaveLength(0);
    expect(d.deltaNeutral).toBe(false);
    expect(d.netPerp).toBe(1000);
    expect(d.perfect).toBe(false);
  });

  it('a Boros leg with no perp behind it is a SHORT-side gap (over-hedged venue)', () => {
    const g = group({
      borosOpen: [boros({ marketId: 1, venue: 'OKX', side: 'LONG', sizeToken: 500 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toEqual([{ venue: 'OKX', action: 'short-boros', size: 500, unit: 'base' }]);
  });

  it('USD-collateral assets (HYPE) compare USD notionals, not token quantities', () => {
    const g = group({
      base: 'HYPE',
      perpOpen: [
        perp({ symbol: 'HL_HYPE', venue: 'HYPERLIQUID', side: 'SHORT', qty: 10_000, notionalUsd: 400_000 }),
      ],
      borosOpen: [
        // sizeToken is USDT here — 400k USD covers the 400k USD perp exactly.
        boros({ marketId: 9, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 400_000, notionalUsd: 400_000, collateral: 'USDT' }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toHaveLength(0);
    expect(d.venues[0].unit).toBe('usd');
  });

  it('covered venues whose Boros legs mature inside 14d get an expiry warning', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000, maturity: NOW + 5 * DAY }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toHaveLength(0);
    expect(d.venues[0].expiresSoon).toBe(true);
  });
});

describe('exclusions', () => {
  const g = () =>
    group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, upnlUsd: 100, fundingUsd: 50, feesUsd: 10, imUsd: 2000 }),
        perp({ symbol: 'OKX', venue: 'OKX', side: 'SHORT', qty: 1000 }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000, imUsd: 500, mtmUsd: 40 }),
        boros({ marketId: 2, venue: 'OKX', side: 'SHORT', sizeToken: 1000 }),
      ],
    });

  it("'all' on a perp removes it from gap math, totals and capital", () => {
    const d = deriveAsset(g(), { [perpKey('HL')]: 'all' }, 0, NOW);
    // With the HL perp gone its Boros leg is over-coverage; OKX stays whole.
    expect(d.gaps).toEqual([{ venue: 'HYPERLIQUID', action: 'short-boros', size: 1000, unit: 'base' }]);
    expect(d.totals.breakdown.perpUpnlUsd).toBe(0);
    expect(d.totals.capitalUsd).toBe(500); // only the HL Boros leg's IM remains
  });

  it('a partial exclusion scales the leg pro-rata everywhere', () => {
    const d = deriveAsset(g(), { [perpKey('HL')]: 250 }, 0, NOW);
    // 750 kept vs 1000 boros → gap −250 → short 250 YU to rebalance.
    expect(d.gaps).toEqual([{ venue: 'HYPERLIQUID', action: 'short-boros', size: 250, unit: 'base' }]);
    expect(d.totals.breakdown.perpUpnlUsd).toBeCloseTo(75, 9);
    expect(d.totals.breakdown.perpFundingUsd).toBeCloseTo(37.5, 9);
    expect(d.totals.capitalUsd).toBeCloseTo(2000 * 0.75 + 500 + 0 + 0, 9);
  });

  it("'all' on a market also drops its history rows; partial does not", () => {
    const base = group({
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', maturity: NOW + DAY, settleUsd: 100, settleFeeUsd: 2, tradePnlUsd: -10, tradeFeeUsd: 10 },
        { marketId: 2, venue: 'OKX', maturity: NOW + DAY, settleUsd: 40, settleFeeUsd: 1, tradePnlUsd: 0, tradeFeeUsd: 0 },
      ],
      perpClosed: [
        { symbol: 'GATE_OLD', venue: 'GATE', closedPnlUsd: 20, fundingUsd: 5, feesUsd: 3, count: 1, lastClosedAt: NOW - DAY },
      ],
    });
    const all = deriveAsset(base, {}, 0, NOW);
    expect(all.totals.pnlUsd).toBeCloseTo(100 - 10 + 40 + (20 + 5 - 3), 9);

    const excluded = deriveAsset(
      base,
      { [borosKey(1)]: 'all', [perpKey('GATE_OLD')]: 'all' },
      0,
      NOW,
    );
    expect(excluded.totals.pnlUsd).toBeCloseTo(40, 9);

    const partial = deriveAsset(base, { [borosKey(1)]: 500 }, 0, NOW);
    expect(partial.totals.pnlUsd).toBeCloseTo(all.totals.pnlUsd, 9);
  });
});

describe('totals & APR', () => {
  it('headline PnL composes both sides and never double-counts open Boros settlement', () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', upnlUsd: 100, fundingUsd: 3120, feesUsd: 210 }),
      ],
      borosOpen: [
        // settleUsd/mtmUsd here are display-only; history carries the sums.
        boros({ marketId: 1, settleUsd: 3205, mtmUsd: 820, imUsd: 500 }),
      ],
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', maturity: NOW + DAY, settleUsd: 3205, settleFeeUsd: 30, tradePnlUsd: -390, tradeFeeUsd: 390 },
      ],
      perpClosed: [
        { symbol: 'OLD', venue: 'GATE', closedPnlUsd: 150, fundingUsd: 30, feesUsd: 12, count: 1, lastClosedAt: NOW - DAY },
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.totals.pnlUsd).toBeCloseTo(
      100 + 3120 - 210 + (150 + 30 - 12) + 3205 + -390,
      9,
    );
    expect(d.totals.mtmUsd).toBeCloseTo(820, 9); // shown, not added
  });

  it('APR ≈ pnl / capital annualized over the asset clock; null without capital or clock', () => {
    const g = group({
      earliestSec: NOW - 73 * DAY, // 0.2 years
      perpOpen: [perp({ symbol: 'HL', upnlUsd: 0, fundingUsd: 2000, imUsd: 10_000 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    const years = (73 * DAY) / SECONDS_IN_YEAR;
    expect(d.aprEst).toBeCloseTo(2000 / 10_000 / years, 9);

    const noCapital = deriveAsset(group({ earliestSec: NOW - DAY }), {}, 0, NOW);
    expect(noCapital.aprEst).toBeNull();

    // Dust capital: annualizing $4 of margin prints alarm-sized noise — no APR.
    const dust = deriveAsset(
      group({ earliestSec: NOW - DAY, perpOpen: [perp({ symbol: 'HL', fundingUsd: -5, imUsd: 4 })] }),
      {},
      0,
      NOW,
    );
    expect(dust.aprEst).toBeNull();

    const noClock = deriveAsset(group({ earliestSec: null }), {}, 0, NOW);
    expect(noClock.aprEst).toBeNull();
  });

  it('a user start date after the earliest activity floors the clock', () => {
    const since = NOW - 10 * DAY;
    const g = group({
      earliestSec: NOW - 100 * DAY,
      perpOpen: [perp({ symbol: 'HL', fundingUsd: 1000, imUsd: 10_000 })],
    });
    const d = deriveAsset(g, {}, since, NOW);
    expect(d.clockStartSec).toBe(since);
  });
});
