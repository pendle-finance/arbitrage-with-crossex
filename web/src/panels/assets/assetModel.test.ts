/**
 * assetModel — the asset view's money math: hedge gaps (direction + unit
 * rule), exclusions, the totals composition (and its double-count guard),
 * and the approximate APR.
 */
import { describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import {
  borosKey,
  defaultChargePerpFees,
  assetIsActive,
  perpOnlyCloseLegs,
  pairTimelineAxis,
  timelineBar,
  deriveAsset,
  keptSlice,
  pairBorosCloseLegs,
  pairLockedSpread,
  pairPerpCloseLegs,
  pairRollDue,
  perpKey,
  SECONDS_IN_YEAR,
} from './assetModel';

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
  spreadVenues: null,
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
  supported: true,
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
    expect(d.gaps).toMatchObject([{ venue: 'OKX', action: 'short-boros', size: 1000, unit: 'base', kind: 'missing', leg: 'boros' }]);
    expect(d.perfect).toBe(false);
  });

  it('a partially-covered venue reports only the shortfall; within 0.1% counts as covered on ETH', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 900 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toMatchObject([
      { venue: 'HYPERLIQUID', action: 'long-boros', size: 100, unit: 'base' },
    ]);

    const near = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 999.5 })],
    });
    expect(deriveAsset(near, {}, 0, NOW).gaps).toHaveLength(0);
  });

  it('ETH on a coin market flags a 0.5% gap but keeps its locked APR, which holds to 2%', () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 }),
        perp({ symbol: 'OKX', venue: 'OKX', side: 'SHORT', qty: 1000 }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 995 }),
        boros({ marketId: 2, venue: 'OKX', side: 'SHORT', sizeToken: 1000 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toMatchObject([{ venue: 'HYPERLIQUID', action: 'long-boros', size: 5, unit: 'base' }]);
    expect(d.perfect).toBe(false);
    expect(d.lockedCarryPerYearUsd).not.toBeNull();
  });

  it('a 3% ETH gap loses the locked APR as before', () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 }),
        perp({ symbol: 'OKX', venue: 'OKX', side: 'SHORT', qty: 1000 }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 970 }),
        boros({ marketId: 2, venue: 'OKX', side: 'SHORT', sizeToken: 1000 }),
      ],
    });
    expect(deriveAsset(g, {}, 0, NOW).lockedCarryPerYearUsd).toBeNull();
  });

  it('ETH hedged on a USDT market keeps the 2% band, since its dollar size moves with price', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 })],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', collateral: 'USDT', sizeToken: 1_890_500, notionalUsd: 1_890_500 }),
      ],
    });
    expect(deriveAsset(g, {}, 0, NOW).gaps).toHaveLength(0);
  });

  it('HYPE keeps the 2% band on both checks', () => {
    const g = group({
      base: 'HYPE',
      priceUsd: 85.75,
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'SHORT', qty: 2.3, notionalUsd: 197.23 }),
        perp({ symbol: 'GATE', venue: 'GATE', side: 'LONG', qty: 2.3, notionalUsd: 199.0 }),
      ],
      borosOpen: [
        boros({ marketId: 216, venue: 'HYPERLIQUID', side: 'SHORT', collateral: 'USDT', sizeToken: 200, notionalUsd: 200 }),
        boros({ marketId: 217, venue: 'GATE', side: 'LONG', collateral: 'USDT', sizeToken: 200, notionalUsd: 200 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toHaveLength(0);
    expect(d.deltaNeutral).toBe(true);
    expect(d.perfect).toBe(true);
  });

  it('ETH perps 0.5% apart are not delta-neutral', () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000 }),
        perp({ symbol: 'OKX', venue: 'OKX', side: 'SHORT', qty: 990 }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000 }),
        boros({ marketId: 2, venue: 'OKX', side: 'SHORT', sizeToken: 990 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.deltaNeutral).toBe(false);
    expect(d.perfect).toBe(false);
    expect(d.lockedCarryPerYearUsd).not.toBeNull();
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

  it('a Boros leg with no perp behind it flags the MISSING perp, never the Boros surplus', () => {
    const g = group({
      borosOpen: [boros({ marketId: 1, venue: 'OKX', side: 'LONG', sizeToken: 500 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toMatchObject([{ venue: 'OKX', action: 'long-perp', size: 500, unit: 'base', kind: 'missing', leg: 'perp', want: 500 }]);
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

  it('a USDT-margined BTC market hedges a BTC perp by its dollar notional, not its token count', () => {
    // Hyperliquid BTC trades as a USDT-margined market (194) and a
    // BTC-margined one (137). 100,000 USDT of YU at a $100k mark covers a
    // 1 BTC perp exactly; read as 100,000 "BTC" it was a 99,999 BTC deficit.
    const g = group({
      base: 'BTC',
      priceUsd: 100_000,
      perpOpen: [
        perp({ symbol: 'HL_BTC', venue: 'HYPERLIQUID', side: 'LONG', qty: 1, notionalUsd: 100_000, entryPrice: 100_000, markPrice: 100_000, imUsd: 20_000 }),
        perp({ symbol: 'BN_BTC', venue: 'BINANCE', side: 'SHORT', qty: 1, notionalUsd: 100_000, entryPrice: 100_000, markPrice: 100_000, imUsd: 20_000 }),
      ],
      borosOpen: [
        boros({ marketId: 194, venue: 'HYPERLIQUID', side: 'LONG', collateral: 'USDT', sizeToken: 100_000, notionalUsd: 100_000, entryApr: 0.07, imUsd: 2_000 }),
        boros({ marketId: 137, venue: 'BINANCE', side: 'SHORT', collateral: 'BTC', sizeToken: 1, notionalUsd: 100_000, entryApr: 0.055, imUsd: 2_000 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.gaps).toHaveLength(0);
    expect(d.venues.map((v) => v.unit)).toEqual(['base', 'base']);
    expect(d.venues.find((v) => v.venue === 'HYPERLIQUID')!.borosSigned).toBeCloseTo(1, 9);
    expect(d.lockedAprFwd).not.toBeNull();
    // One 4-leg pair of 1 BTC, nothing pending, and the locked rate is what
    // the legs say: receive 5.5% on Binance, pay 7% on Hyperliquid.
    expect(d.pairs).toHaveLength(1);
    expect(d.pairs[0].size).toBeCloseTo(1, 9);
    expect(d.pendingLegs).toHaveLength(0);
    expect(d.pairs[0].lockedAprFwd).toBeLessThan(0);
    expect(d.lockedAprFwd).toBeLessThan(0);
  });

  it('a coin-margined leg on the same coin is still read as coins', () => {
    const d = deriveAsset(
      group({
        perpOpen: [perp({ side: 'LONG', qty: 1000 })],
        borosOpen: [boros({ side: 'LONG', collateral: 'ETH', sizeToken: 1000 })],
      }),
      {},
      0,
      NOW,
    );
    expect(d.gaps).toHaveLength(0);
    expect(d.venues[0].borosSigned).toBeCloseTo(1000, 9);
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
    // With the HL perp gone its Boros leg has no floating side: the PERP is
    // what's missing (the flag never sits on the surplus); OKX stays whole.
    expect(d.gaps).toMatchObject([{ venue: 'HYPERLIQUID', action: 'long-perp', size: 1000, unit: 'base', kind: 'missing', leg: 'perp' }]);
    expect(d.totals.breakdown.perpUpnlUsd).toBe(0);
    expect(d.totals.capitalUsd).toBe(500); // only the HL Boros leg's IM remains
  });

  it('a partial exclusion scales the leg pro-rata everywhere', () => {
    const d = deriveAsset(g(), { [perpKey('HL')]: 250 }, 0, NOW);
    // 750 kept vs 1000 boros → the perp is 250 short of its YU.
    expect(d.gaps).toMatchObject([{ venue: 'HYPERLIQUID', action: 'long-perp', size: 250, unit: 'base', kind: 'deficit', leg: 'perp', want: 1000 }]);
    expect(d.totals.breakdown.perpUpnlUsd).toBeCloseTo(75, 9);
    expect(d.totals.breakdown.perpFundingUsd).toBeCloseTo(37.5, 9);
    expect(d.totals.capitalUsd).toBeCloseTo(2000 * 0.75 + 500 + 0 + 0, 9);
  });

  it('a slice carved out AT A PRICE hands back exactly its own mark-to-market', () => {
    // 1000 ETH long, venue average $1,900, mark $1,900, venue uPnL +100.
    // Exclude 250 ETH that were bought at $1,800: that slice alone is
    // +250 × (1,900 − 1,800) = +25,000 of the venue's figure, and it leaves.
    const d = deriveAsset(g(), { [perpKey('HL')]: { qty: 250, at: 1800 } }, 0, NOW);
    expect(d.totals.breakdown.perpUpnlUsd).toBeCloseTo(100 - 250 * (1900 - 1800), 9);
    // Everything that cannot be attributed to a price stays pro-rata.
    expect(d.totals.breakdown.perpFundingUsd).toBeCloseTo(37.5, 9);
    expect(d.gaps).toMatchObject([{ venue: 'HYPERLIQUID', action: 'long-perp', size: 250, unit: 'base', kind: 'deficit', leg: 'perp' }]);
  });

  it('keptSlice re-derives the remainder as the weighted residual; a bare qty leaves it alone', () => {
    const priced = keptSlice({ k: { qty: 250, at: 1800 } }, 'k', 1000, 1900);
    expect(priced.keep).toBeCloseTo(0.75, 12);
    // (1000×1900 − 250×1800) / 750
    expect(priced.entry).toBeCloseTo((1_900_000 - 450_000) / 750, 9);
    const plain = keptSlice({ k: 250 }, 'k', 1000, 1900);
    expect(plain).toEqual({ keep: 0.75, entry: 1900, at: null });
    expect(keptSlice({ k: 'all' }, 'k', 1000, 1900).keep).toBe(0);
    // A rate works the same way: 25% of the leg locked at 12% out of an 8% blend.
    expect(keptSlice({ k: { qty: 250, at: 0.12 } }, 'k', 1000, 0.08).entry).toBeCloseTo(0.05 / 0.75, 12);
  });

  it("'all' on a market also drops its history rows; partial does not", () => {
    const base = group({
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', spreadVenues: null, maturity: NOW + DAY, settleUsd: 100, settleFeeUsd: 2, tradePnlUsd: -10, tradeFeeUsd: 10 },
        { marketId: 2, venue: 'OKX', spreadVenues: null, maturity: NOW + DAY, settleUsd: 40, settleFeeUsd: 1, tradePnlUsd: 0, tradeFeeUsd: 0 },
      ],
      perpClosed: [
        { symbol: 'GATE_OLD', venue: 'GATE', closedPnlUsd: 20, fundingUsd: 5, feesUsd: 3, count: 1, lastClosedAt: NOW - DAY, rows: [] },
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

describe('carry − cost', () => {
  it('the headline PnL is exactly gross carry minus cost, with fees and price basis in cost', () => {
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, upnlUsd: 120, fundingUsd: 300, feesUsd: 40 }),
      ],
      perpClosed: [
        { symbol: 'GATE_OLD', venue: 'GATE', closedPnlUsd: -25, fundingUsd: 80, feesUsd: 15, count: 1, lastClosedAt: NOW - DAY, rows: [] },
      ],
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', spreadVenues: null, maturity: NOW + DAY, settleUsd: 500, settleFeeUsd: 12, tradePnlUsd: -30, tradeFeeUsd: 8 },
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    // Carry: 300 + 80 funding, 500 settlement (ALREADY net of its 12 fee —
    // unavoidable, so it never enters carry or cost), −30 + 8 trade gross.
    expect(d.totals.carryGrossUsd).toBeCloseTo(300 + 80 + 500 - 22, 9);
    // Cost: perp fees 40 + 15, Boros TRADE fee 8, less the price basis (120 − 25).
    expect(d.totals.costUsd).toBeCloseTo(55 + 8 - 95, 9);
    // The identity is what actually matters, and it is unchanged: the
    // settlement fee cancelled on both sides, so PnL is the same as before.
    expect(d.totals.pnlUsd).toBeCloseTo(d.totals.carryGrossUsd - d.totals.costUsd, 9);
    expect(d.totals.borosFeesAllUsd).toBeCloseTo(8, 9); // trade fees only
  });

  it('adds the backend rebate into PnL and carry, keeps the identity, and honours exclusions', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, upnlUsd: 0, fundingUsd: 0, feesUsd: 0 })],
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', spreadVenues: null, maturity: NOW + DAY, settleUsd: 500, settleFeeUsd: 12, rebateUsd: 6, tradePnlUsd: 0, tradeFeeUsd: 0 },
        { marketId: 2, venue: 'OKX', spreadVenues: null, maturity: NOW + DAY, settleUsd: 40, settleFeeUsd: 4, rebateUsd: 2, tradePnlUsd: 0, tradeFeeUsd: 0 },
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    // Rebate is a credit ADDED to PnL and carry (never a re-netting of settle).
    expect(d.totals.breakdown.borosRebateUsd).toBeCloseTo(8, 9);
    expect(d.totals.pnlUsd).toBeCloseTo(500 + 40 + 8, 9);
    expect(d.totals.carryGrossUsd).toBeCloseTo(500 + 40 + 8, 9);
    // The identity still closes with the rebate inside carryGross.
    expect(d.totals.pnlUsd).toBeCloseTo(d.totals.carryGrossUsd - d.totals.costUsd, 9);

    // Excluding a market drops its rebate too.
    const excluded = deriveAsset(g, { [borosKey(2)]: 'all' }, 0, NOW);
    expect(excluded.totals.breakdown.borosRebateUsd).toBeCloseTo(6, 9);

    // A non-rebated feed (no rebateUsd) shows zero and no PnL change.
    const plain = deriveAsset(
      group({
        perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, upnlUsd: 0, fundingUsd: 0, feesUsd: 0 })],
        borosHistory: [{ marketId: 1, venue: 'HYPERLIQUID', spreadVenues: null, maturity: NOW + DAY, settleUsd: 500, settleFeeUsd: 12, tradePnlUsd: 0, tradeFeeUsd: 0 }],
      }),
      {},
      0,
      NOW,
    );
    expect(plain.totals.breakdown.borosRebateUsd).toBe(0);
    expect(plain.totals.pnlUsd).toBeCloseTo(500, 9);
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
        { marketId: 1, venue: 'HYPERLIQUID', spreadVenues: null, maturity: NOW + DAY, settleUsd: 3205, settleFeeUsd: 30, tradePnlUsd: -390, tradeFeeUsd: 390 },
      ],
      perpClosed: [
        { symbol: 'OLD', venue: 'GATE', closedPnlUsd: 150, fundingUsd: 30, feesUsd: 12, count: 1, lastClosedAt: NOW - DAY, rows: [] },
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

/**
 * A part-hedged book used to show "—" for its APR. It now gets an estimate —
 * fixed rate legs plus the funding its unlocked part earns — and ONLY where
 * the fixed rate would have been a dash (his call 2026-10-01).
 */
describe('the estimated APR of a book that is not fully locked', () => {
  const PX = 1900;
  // His example: 10 ETH long HL and short Gate, 6 ETH locked on each venue.
  const book = (yuSize: number, over: { hl7d?: number | null; gate7d?: number | null } = {}) =>
    group({
      priceUsd: PX,
      perpOpen: [
        // A LONG that PAID 10% a year received −10%.
        perp({ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', venue: 'HYPERLIQUID', side: 'LONG', qty: 10, notionalUsd: 10 * PX, imUsd: 1_000, fundingApr7d: over.hl7d === undefined ? -0.1 : over.hl7d }),
        perp({ symbol: 'GATE_FUTURE_ETH_USDT', venue: 'GATE', side: 'SHORT', qty: 10, notionalUsd: 10 * PX, imUsd: 1_000, fundingApr7d: over.gate7d === undefined ? 0.04 : over.gate7d }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: yuSize, notionalUsd: yuSize * PX, entryApr: 0.08, floatingApr: 0.11, imUsd: 300 }),
        boros({ marketId: 2, venue: 'GATE', side: 'SHORT', sizeToken: yuSize, notionalUsd: yuSize * PX, entryApr: 0.05, floatingApr: -0.01, imUsd: 300 }),
      ],
    });

  it('the unlocked 4 ETH earns (Gate − HL funding) on top of the locked legs', () => {
    const d = deriveAsset(book(6), {}, 0, NOW);
    expect(d.lockedAprFwd).toBeNull();
    const e = d.unlockedEstimate!;
    const capital = 1_000 + 1_000 + 300 + 300;
    // Fixed: SHORT Gate receives 5%, LONG HL pays 8%, on 6 ETH each.
    const fixed = (0.05 - 0.08) * 6 * PX;
    // Floating: HL funding 10% (longs pay), Gate 4%: 4 ETH × (4% − 10%).
    const floating = 4 * PX * (0.04 - 0.1);
    expect(e.fixedCarryPerYearUsd).toBeCloseTo(fixed, 6);
    expect(e.floatingCarryPerYearUsd).toBeCloseTo(floating, 6);
    expect(e.apr).toBeCloseTo((fixed + floating) / capital, 9);
    expect(e.fixedApr + e.floatingApr).toBeCloseTo(e.apr, 12);
    expect(e.venues.map((v) => [v.venue, v.source, Math.round(v.gapUsd)])).toEqual([
      ['HYPERLIQUID', '7d', 4 * PX],
      ['GATE', '7d', -4 * PX],
    ]);
  });

  it('a fully locked book keeps its fixed rate and gets no estimate', () => {
    const d = deriveAsset(book(10), {}, 0, NOW);
    expect(d.lockedAprFwd).not.toBeNull();
    expect(d.unlockedEstimate).toBeNull();
  });

  it("a venue with no perp history falls back to Boros's current floating rate", () => {
    const d = deriveAsset(book(6, { gate7d: null }), {}, 0, NOW);
    const gate = d.unlockedEstimate!.venues.find((v) => v.venue === 'GATE')!;
    expect(gate.source).toBe('current');
    expect(gate.fundingApr).toBeCloseTo(-0.01, 12);
  });

  it('no estimate when a gap has no rate at all, or a rate leg has no entry', () => {
    const noRate = book(6, { gate7d: null });
    noRate.borosOpen = noRate.borosOpen.filter((b) => b.venue !== 'GATE');
    expect(deriveAsset(noRate, {}, 0, NOW).unlockedEstimate).toBeNull();

    const noEntry = book(6);
    noEntry.borosOpen = [{ ...noEntry.borosOpen[0], entryApr: null }, noEntry.borosOpen[1]];
    expect(deriveAsset(noEntry, {}, 0, NOW).unlockedEstimate).toBeNull();
  });
});

describe('defaultChargePerpFees', () => {
  const boros = NOW - 10 * DAY;
  it('on when the perp went on with (or after) its Boros leg', () => {
    expect(defaultChargePerpFees({ perpOpenedSec: boros, borosOpenedSec: boros })).toBe(true);
    expect(defaultChargePerpFees({ perpOpenedSec: boros + DAY, borosOpenedSec: boros })).toBe(true);
    // Up to three days earlier still counts as opened for this hedge.
    expect(defaultChargePerpFees({ perpOpenedSec: boros - 3 * DAY, borosOpenedSec: boros })).toBe(true);
  });
  it('off when the perp predates the Boros leg by more than three days', () => {
    expect(defaultChargePerpFees({ perpOpenedSec: boros - 3 * DAY - 1, borosOpenedSec: boros })).toBe(false);
    expect(defaultChargePerpFees({ perpOpenedSec: boros - 30 * DAY, borosOpenedSec: boros })).toBe(false);
  });
  it('stays on when either open is unknown', () => {
    expect(defaultChargePerpFees({ perpOpenedSec: null, borosOpenedSec: boros })).toBe(true);
    expect(defaultChargePerpFees({ perpOpenedSec: boros, borosOpenedSec: null })).toBe(true);
  });
});


describe('pairs — merging sub-pairs of one venue pairing', () => {
  it('ONE Boros market hedging two perp books at a venue comes back as ONE leg, not two', () => {
    // HL holds ETH_USDC 600 + ETH_USDT 400 (two books), hedged by one HL YU of
    // 1000; Gate is short 1000 with its own YU. Each HL book forms its own
    // (HL, GATE, maturity) sub-pair, and the merge used to concatenate the
    // legs — the same marketId twice, which the close form cannot quote
    // (a pair against itself) and would submit as two closes.
    const g = group({
      perpOpen: [
        perp({ symbol: 'HL_USDC', venue: 'HYPERLIQUID', side: 'LONG', qty: 600, notionalUsd: 1_140_000, imUsd: 6_000 }),
        perp({ symbol: 'HL_USDT', venue: 'HYPERLIQUID', side: 'LONG', qty: 400, notionalUsd: 760_000, imUsd: 4_000 }),
        perp({ symbol: 'GATE', venue: 'GATE', side: 'SHORT', qty: 1000, imUsd: 10_000 }),
      ],
      borosOpen: [
        boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000, imUsd: 10_000 }),
        boros({ marketId: 2, venue: 'GATE', side: 'SHORT', sizeToken: 1000, imUsd: 10_000 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(1);
    const yu = d.pairs[0].legs.filter((l) => l.kind === 'yu');
    expect(yu.map((l) => l.marketId).sort()).toEqual([1, 2]);
    const hl = yu.find((l) => l.marketId === 1)!;
    // The merged leg carries the WHOLE attributed size, share and margin.
    expect(hl.sizeToken).toBeCloseTo(1000, 6);
    expect(hl.notionalUsd).toBeCloseTo(1_900_000, 6);
    expect(hl.share).toBeCloseTo(1, 6);
    expect(hl.imUsd).toBeCloseTo(10_000, 6);
    // The Gate short was shared between the two sub-pairs: one row, whole.
    const perps = d.pairs[0].legs.filter((l) => l.kind === 'perp');
    expect(perps.map((l) => l.symbol).sort()).toEqual(['GATE', 'HL_USDC', 'HL_USDT']);
    expect(perps.find((l) => l.symbol === 'GATE')!.sizeToken).toBeCloseTo(1000, 6);
  });
});

describe('closing from a pair row', () => {
  // HYPE sizes in DOLLARS on the card and its YU legs are USDT-margined. The
  // close orders must still go out in each leg's own token: 100 HYPE on the
  // perps, 8,000 USDT on the YU legs — never $8,000 "HYPE".
  const hype = group({
    base: 'HYPE',
    priceUsd: 80,
    perpOpen: [
      perp({ symbol: 'GATE_HYPE', venue: 'GATE', side: 'LONG', qty: 100, notionalUsd: 8_000, imUsd: 800 }),
      perp({ symbol: 'HL_HYPE', venue: 'HYPERLIQUID', side: 'SHORT', qty: 100, notionalUsd: 8_000, imUsd: 800 }),
    ],
    borosOpen: [
      boros({ marketId: 7, venue: 'GATE', side: 'LONG', collateral: 'USDT', sizeToken: 8_000, notionalUsd: 8_000, imUsd: 800 }),
      boros({ marketId: 8, venue: 'HYPERLIQUID', side: 'SHORT', collateral: 'USDT', sizeToken: 8_000, notionalUsd: 8_000, imUsd: 800 }),
    ],
  });

  it('perp close legs are coin quantities even when the asset displays in USD', () => {
    const d = deriveAsset(hype, {}, 0, NOW);
    expect(d.pairs).toHaveLength(1);
    expect(d.pairs[0].unit).toBe('usd');
    expect(pairPerpCloseLegs(d.pairs[0])).toEqual([
      { symbol: 'GATE_HYPE', qty: 100, venue: 'GATE', partial: false },
      { symbol: 'HL_HYPE', qty: 100, venue: 'HYPERLIQUID', partial: false },
    ]);
  });

  it('Boros close legs carry the collateral-token size and the same slice in dollars', () => {
    const d = deriveAsset(hype, {}, 0, NOW);
    const legs = pairBorosCloseLegs(d.pairs[0], hype);
    expect(legs.map((l) => l.marketId).sort()).toEqual([7, 8]);
    for (const l of legs) {
      expect(l.notionalToken).toBeCloseTo(8_000, 6);
      expect(l.notionalUsd).toBeCloseTo(8_000, 6);
      expect(l.collateral).toBe('USDT');
    }
    // And the coin reading of the same slice is 100 HYPE, for display.
    const yu = d.pairs[0].legs.filter((l) => l.kind === 'yu');
    for (const l of yu) expect(l.sizeBase).toBeCloseTo(100, 6);
  });

  it('a half-excluded Boros leg closes only the kept half', () => {
    const d = deriveAsset(hype, { 'boros:7': 4_000 }, 0, NOW);
    const gate = pairBorosCloseLegs(d.pairs[0], hype).find((l) => l.marketId === 7)!;
    expect(gate.notionalToken).toBeCloseTo(4_000, 6);
    // The excluded half is not this farm's, so the pair holds ALL of what is
    // left: `share` is against the kept leg, not the venue position.
    expect(gate.share).toBeCloseTo(1, 6);
  });
});

describe('exclusions and maturity — his 2026-09-09 rules', () => {
  it('a partial Boros exclusion scales the settled PnL by the kept fraction, not just capital', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, imUsd: 10_000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000, imUsd: 10_000, mtmUsd: 900 })],
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', spreadVenues: null, maturity: NOW + 60 * DAY, settleUsd: 3000, settleFeeUsd: 30, tradePnlUsd: -10, tradeFeeUsd: 10 },
      ],
    });
    const whole = deriveAsset(g, {}, 0, NOW);
    const half = deriveAsset(g, { 'boros:1': 500 }, 0, NOW);
    expect(half.totals.breakdown.borosSettleUsd).toBeCloseTo(whole.totals.breakdown.borosSettleUsd / 2, 6);
    expect(half.totals.breakdown.borosSettleFeeUsd).toBeCloseTo(15, 6);
    // Capital and settlements move together, so ROI does not double.
    expect(half.totals.capitalUsd).toBeCloseTo(15_000, 6);
  });

  it('a matured YU leg is finished: it covers nothing and ties up no capital', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, imUsd: 10_000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000, maturity: NOW - DAY, imUsd: 5_000 })],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.perfect).toBe(false);
    expect(d.gaps).toHaveLength(1);
    expect(d.gaps[0]).toMatchObject({ venue: 'HYPERLIQUID', leg: 'boros', kind: 'missing' });
    expect(d.totals.capitalUsd).toBe(10_000);
    expect(d.pairs).toHaveLength(0);
  });
});

describe('assetIsActive', () => {
  const NOW = 1_000_000;
  // A leg is open only while it is UNMATURED, so the fixture dates ahead of NOW.
  const yuLeg = (marketId: number, sizeToken: number, maturity = NOW + 86_400) =>
    ({ marketId, sizeToken, maturity }) as never;
  it('an open perp makes the asset active, hedged or not', () => {
    expect(assetIsActive({ perpOpen: [{} as never], borosOpen: [] }, {}, NOW)).toBe(true);
  });
  it('history alone does not: nothing open is inactive', () => {
    expect(assetIsActive({ perpOpen: [], borosOpen: [] }, {}, NOW)).toBe(false);
  });
  it('an open Boros leg counts unless it is WHOLLY excluded', () => {
    const group = { perpOpen: [], borosOpen: [yuLeg(7, 100)] };
    expect(assetIsActive(group, {}, NOW)).toBe(true);
    // Half set aside: the other half is still the farm's.
    expect(assetIsActive(group, { 'boros:7': 50 }, NOW)).toBe(true);
    expect(assetIsActive(group, { 'boros:7': 'all' }, NOW)).toBe(false);
    expect(assetIsActive(group, { 'boros:7': 100 }, NOW)).toBe(false);
    // Another market's exclusion says nothing about this leg.
    expect(assetIsActive(group, { 'boros:8': 'all' }, NOW)).toBe(true);
  });
  /**
   * The chain keeps listing a matured leg in `borosOpen` forever. It hedges
   * nothing and earns nothing, `deriveAsset` already drops it from the card,
   * and an asset whose every leg has matured must be able to hide.
   */
  it('a MATURED Boros leg does not keep an asset active', () => {
    expect(assetIsActive({ perpOpen: [], borosOpen: [yuLeg(7, 100, NOW - 1)] }, {}, NOW)).toBe(false);
    // Its own maturity instant is the edge: settled, so no longer open.
    expect(assetIsActive({ perpOpen: [], borosOpen: [yuLeg(7, 100, NOW)] }, {}, NOW)).toBe(false);
    // One live leg beside a matured one still counts.
    expect(
      assetIsActive({ perpOpen: [], borosOpen: [yuLeg(7, 100, NOW - 1), yuLeg(8, 100)] }, {}, NOW),
    ).toBe(true);
  });
});


describe('pairLockedSpread — on the RATE legs’ notional', () => {
  const leg = (kind: 'perp' | 'yu', notionalUsd: number) => ({ kind, notionalUsd });
  // $100k a side locked at a 5% spread: $5k a year, on $20k of capital.
  const pair = (perpNotional: number) =>
    ({
      lockedAprFwd: 0.25,
      capitalUsd: 20_000,
      legs: [leg('perp', perpNotional), leg('perp', perpNotional), leg('yu', 100_000), leg('yu', 100_000)],
    }) as unknown as Parameters<typeof pairLockedSpread>[0];

  it('reads the same 5% whatever the perps are marked at', () => {
    expect(pairLockedSpread(pair(100_000))).toBeCloseTo(0.05, 9);
    // The perps rallied 25%; the rate legs — and what they earn — did not move.
    expect(pairLockedSpread(pair(125_000))).toBeCloseTo(0.05, 9);
    expect(pairLockedSpread(pair(80_000))).toBeCloseTo(0.05, 9);
  });

  it('is null with no rate or no rate legs', () => {
    expect(pairLockedSpread({ ...pair(100_000), lockedAprFwd: null })).toBeNull();
    expect(pairLockedSpread({ ...pair(100_000), legs: [] })).toBeNull();
  });
});

describe('a roll that keeps the old legs: the further maturity takes the perps', () => {
  const OLD = NOW + 20 * DAY;
  const NEW = NOW + 57 * DAY;
  const perps = (qty = 10) => [
    perp({ symbol: 'GATE_L', venue: 'GATE', side: 'LONG', qty, notionalUsd: qty * 1900 }),
    perp({ symbol: 'HL_S', venue: 'HYPERLIQUID', side: 'SHORT', qty, notionalUsd: qty * 1900 }),
  ];
  const singles = (maturity: number, size: number, id: number) => [
    boros({ marketId: id, venue: 'GATE', side: 'LONG', maturity, sizeToken: size, notionalUsd: size * 1900 }),
    boros({ marketId: id + 1, venue: 'HYPERLIQUID', side: 'SHORT', maturity, sizeToken: size, notionalUsd: size * 1900 }),
  ];
  const pendingAt = (d: ReturnType<typeof deriveAsset>, maturity: number) =>
    [
      ...d.pendingLegs,
      ...d.borosOnly.flatMap((p) => p.borosLegs),
      ...d.perpOnly.flatMap((p) => [p.longYu, p.shortYu, ...p.otherWay].flatMap((l) => (l ? [l] : []))),
    ]
      .filter((l) => l.maturity === maturity)
      .map((l) => l.marketId)
      .sort();

  it('equal sizes: the new date is the hedged pair, the old legs wait for perps (mozzarella 2026-10-17)', () => {
    const d = deriveAsset(group({ perpOpen: perps(), borosOpen: [...singles(OLD, 10, 1), ...singles(NEW, 10, 11)] }), {}, 0, NOW);
    expect(d.pairs.map((p) => p.soonestMaturitySec)).toEqual([NEW]);
    expect(pendingAt(d, OLD)).toEqual([1, 2]);
  });

  it('a smaller roll takes its size of the perps; the old pair keeps the rest', () => {
    const d = deriveAsset(group({ perpOpen: perps(), borosOpen: [...singles(OLD, 10, 1), ...singles(NEW, 4, 11)] }), {}, 0, NOW);
    const at = (m: number) => d.pairs.find((p) => p.soonestMaturitySec === m);
    expect(at(NEW)?.size).toBeCloseTo(4, 9);
    expect(at(OLD)?.size).toBeCloseTo(6, 9);
  });

  it('singles to a later spread: the spread takes the perps', () => {
    const spread = boros({ marketId: 21, venue: 'HL-GATE', spreadVenues: ['HYPERLIQUID', 'GATE'], side: 'SHORT', maturity: NEW, sizeToken: 10, notionalUsd: 19_000 });
    const d = deriveAsset(group({ perpOpen: perps(), borosOpen: [...singles(OLD, 10, 1), spread] }), {}, 0, NOW);
    expect(d.pairs.map((p) => p.soonestMaturitySec)).toEqual([NEW]);
    expect(pendingAt(d, OLD)).toEqual([1, 2]);
  });

  it('a later unit under the $50 dust line does not take the main pair\'s perps', () => {
    // 0.001 ETH a side is $1.90.
    const d = deriveAsset(group({ perpOpen: perps(), borosOpen: [...singles(OLD, 10, 1), ...singles(NEW, 0.001, 11)] }), {}, 0, NOW);
    const old = d.pairs.find((p) => p.soonestMaturitySec === OLD);
    expect(old?.size).toBeCloseTo(10, 9);
  });

  it('a roll that filled a hair short takes the perps\' dust rest: no sliver hedged card on the old date (report 2026-10-18)', () => {
    // 0.001 ETH a side is $1.90; 100 of 99.9999 is $0.19.
    for (const [whole, rolled] of [[0.949, 0.948], [100, 99.9999]]) {
      const d = deriveAsset(group({ perpOpen: perps(whole), borosOpen: [...singles(OLD, whole, 1), ...singles(NEW, rolled, 11)] }), {}, 0, NOW);
      expect(d.pairs.map((p) => p.soonestMaturitySec)).toEqual([NEW]);
      for (const l of d.pairs[0].legs.filter((x) => x.kind === 'perp')) expect(l.sizeBase).toBeCloseTo(whole, 9);
      expect(pendingAt(d, OLD)).toEqual([1, 2]);
      expect(d.unpairedPerps).toEqual([]);
    }
  });

  // Gate L 2 / HL S 1 / Lighter S 1 perps; Gate/HL at 27 Nov, Gate/Lighter at 25 Dec, a stray HL 25 Dec leg.
  const sharedGate = (gateNew: number) =>
    group({
      perpOpen: [...perps(1).slice(1), perp({ symbol: 'GATE_L', venue: 'GATE', side: 'LONG', qty: 2, notionalUsd: 3800 }), perp({ symbol: 'LIGHTER_S', venue: 'LIGHTER', side: 'SHORT', qty: 1, notionalUsd: 1900 })],
      borosOpen: [
        ...singles(OLD, 1, 1),
        ...singles(NEW, 1, 11).map((b) => (b.venue === 'GATE' ? { ...b, sizeToken: gateNew, notionalUsd: gateNew * 1900 } : b)),
        boros({ marketId: 31, venue: 'LIGHTER', side: 'SHORT', maturity: NEW, sizeToken: 1, notionalUsd: 1900 }),
      ],
    });
  const units = (d: ReturnType<typeof deriveAsset>) =>
    d.pairs.map((p) => `${p.longVenue}/${p.shortVenue} ${p.soonestMaturitySec === OLD ? 'old' : 'new'} ${p.size.toFixed(6)}`).sort();

  it('further first does not take a leg another venue pairing needs at that date (report 2026-10-18)', () => {
    expect(units(deriveAsset(sharedGate(1), {}, 0, NOW))).toEqual(['GATE/HYPERLIQUID old 1.000000', 'GATE/LIGHTER new 1.000000']);
  });

  it('the fallback is per venue pairing: an unrelated open-only roll in the same coin keeps further first', () => {
    const g = sharedGate(1);
    const mixed = group({
      perpOpen: [
        ...g.perpOpen,
        perp({ symbol: 'BINANCE_L', venue: 'BINANCE', side: 'LONG', qty: 3, notionalUsd: 5700 }),
        perp({ symbol: 'OKX_S', venue: 'OKX', side: 'SHORT', qty: 3, notionalUsd: 5700 }),
      ],
      borosOpen: [
        ...g.borosOpen,
        ...[OLD, NEW].flatMap((maturity, i) => [
          boros({ marketId: 41 + 2 * i, venue: 'BINANCE', side: 'LONG', maturity, sizeToken: 3, notionalUsd: 5700 }),
          boros({ marketId: 42 + 2 * i, venue: 'OKX', side: 'SHORT', maturity, sizeToken: 3, notionalUsd: 5700 }),
        ]),
      ],
    });
    expect(units(deriveAsset(mixed, {}, 0, NOW))).toEqual(['BINANCE/OKX new 3.000000', 'GATE/HYPERLIQUID old 1.000000', 'GATE/LIGHTER new 1.000000']);
  });

  it('with room for both at the later date, further first still holds', () => {
    expect(units(deriveAsset(sharedGate(2), {}, 0, NOW))).toEqual(['GATE/HYPERLIQUID new 1.000000', 'GATE/LIGHTER new 1.000000']);
  });

  it('a single held against its perp is no hedge: HL short perps and an HL LONG single (report 2026-10-18)', () => {
    const wrong = singles(OLD, 10, 1).map((b) => ({ ...b, side: 'LONG' as const }));
    const d = deriveAsset(group({ perpOpen: perps(), borosOpen: wrong }), {}, 0, NOW);
    expect(d.pairs).toEqual([]);
    expect(pendingAt(d, OLD)).toEqual([1, 2]);
  });

  it('other venue pairings keep largest first', () => {
    // Gate long perp 10 against HL short 10 (old date) or Lighter short 1 (new date).
    const g = group({
      perpOpen: [...perps(), perp({ symbol: 'LIGHTER_S', venue: 'LIGHTER', side: 'SHORT', qty: 1, notionalUsd: 1900 })],
      borosOpen: [
        ...singles(OLD, 10, 1),
        boros({ marketId: 31, venue: 'GATE', side: 'LONG', maturity: NEW, sizeToken: 1, notionalUsd: 1900 }),
        boros({ marketId: 32, venue: 'LIGHTER', side: 'SHORT', maturity: NEW, sizeToken: 1, notionalUsd: 1900 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs.find((p) => p.soonestMaturitySec === OLD)?.size).toBeCloseTo(10, 9);
  });
});

describe('pair timeline on a shared axis', () => {
  const T = 1_800_000_000;
  const D = 86_400;
  const pair = (openedDaysAgo: number | null, maturesInDays: number) => ({
    hedgedSinceSec: openedDaysAgo === null ? null : T - openedDaysAgo * D,
    soonestMaturitySec: T + maturesInDays * D,
  });

  it("tells a late-opened near pair from a fresh far one (the ticket's case)", () => {
    // Opened 2 days ago, matures in 3: most of its short term is gone.
    const sep = pair(2, 3);
    // Opened today, matures in 27: nothing has passed yet.
    const oct = pair(0, 27);
    const axis = pairTimelineAxis([sep, oct], T);
    const a = timelineBar(sep, T, axis);
    const b = timelineBar(oct, T, axis);
    // The near pair ends far left of the far one's maturity, and the far one
    // starts at today.
    expect(a.leftPct + a.widthPct).toBeLessThan(b.leftPct + b.widthPct);
    expect(b.leftPct).toBeCloseTo(b.todayPct, 9);
    expect(b.elapsedPct).toBe(0);
    // Each fill is the true share of its own term that has passed.
    expect(a.elapsedPct / a.widthPct).toBeCloseTo(2 / 5, 9);
  });

  it('keeps true time proportions between bars', () => {
    const short = pair(5, 5); // 10-day term
    const long = pair(10, 30); // 40-day term
    const axis = pairTimelineAxis([short, long], T);
    expect(timelineBar(long, T, axis).widthPct / timelineBar(short, T, axis).widthPct).toBeCloseTo(4, 9);
  });

  it('puts today at the same point on every bar', () => {
    const pairs = [pair(1, 3), pair(20, 60), pair(null, 15)];
    const axis = pairTimelineAxis(pairs, T);
    const today = pairs.map((p) => timelineBar(p, T, axis).todayPct);
    expect(new Set(today).size).toBe(1);
  });

  it("reads a lone pair as its own plain progress bar", () => {
    const only = pair(6, 24);
    const bar = timelineBar(only, T, pairTimelineAxis([only], T));
    expect(bar.leftPct).toBe(0);
    expect(bar.widthPct).toBe(100);
    expect(bar.elapsedPct).toBeCloseTo((6 / 30) * 100, 9);
  });

  it('starts an unknown-open pair a month before maturity, and fills a matured one whole', () => {
    const unknown = pair(null, 10);
    const axis = pairTimelineAxis([unknown], T);
    expect(axis.startSec).toBe(unknown.soonestMaturitySec - SECONDS_IN_YEAR / 12);
    const matured = pair(30, -2);
    const bar = timelineBar(matured, T, pairTimelineAxis([matured], T));
    expect(bar.elapsedPct).toBe(bar.widthPct);
  });
});

describe('market-blind grouping in the model', () => {
  const P = 2500;
  const OCT = NOW + 20 * DAY;
  const NOV = NOW + 48 * DAY;
  const gp = (venue: string, side: 'LONG' | 'SHORT', qty: number, over: Partial<AssetPerpOpen> = {}) =>
    perp({ symbol: `${venue}_FUTURE_ETH_USDT`, venue, side, qty, notionalUsd: qty * P, entryPrice: P, markPrice: P, imUsd: qty * 10, ...over });
  const yu = (marketId: number, venue: string, side: 'LONG' | 'SHORT', size: number, maturity: number, over: Partial<AssetBorosOpen> = {}) =>
    boros({ marketId, venue, side, sizeToken: size, notionalUsd: size * P, maturity, imUsd: size, ...over });
  const book = (perpOpen: AssetPerpOpen[], borosOpen: AssetBorosOpen[], over: Partial<AssetGroup> = {}) =>
    group({ priceUsd: P, perpOpen, borosOpen, ...over });
  const b15 = (extra = 0) =>
    book(
      [gp('GATE', 'LONG', 10 + extra), gp('HYPERLIQUID', 'SHORT', 10 + extra)],
      [yu(1, 'GATE', 'LONG', 6, OCT), yu(2, 'GATE', 'LONG', 4, NOV), yu(3, 'HYPERLIQUID', 'SHORT', 10, OCT)],
    );
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const cardsOf = (d: ReturnType<typeof deriveAsset>) =>
    [
      ...d.pairs.map((p) => `H ${p.longVenue}/${p.shortVenue} ${p.soonestMaturitySec} ${r6(p.size)}`),
      ...d.perpOnly.map((p) => `BM ${p.longVenue}/${p.shortVenue} ${(p.longYu ?? p.shortYu)?.marketId ?? '-'} ${r6(p.size)}`),
      ...d.borosOnly.map((p) => `PM ${p.longVenue}/${p.shortVenue} ${p.maturity} ${r6(p.size)}`),
    ].sort();
  const ungroupedOf = (d: ReturnType<typeof deriveAsset>) => [
    ...d.pendingLegs.map((l) => `${l.marketId} ${r6(l.sizeBase)}`),
    ...d.unpairedPerps.map((l) => `${l.symbol} ${r6(l.sizeBase)}`),
  ];

  it('half roll in the model', () => {
    const d = deriveAsset(b15(), {}, 0, NOW);
    expect(cardsOf(d)).toEqual([`BM GATE/HYPERLIQUID 2 4`, `H GATE/HYPERLIQUID ${OCT} 6`]);
    const card = d.perpOnly[0];
    expect(card.longYu).toMatchObject({ marketId: 2, venue: 'GATE', side: 'LONG', maturity: NOV });
    expect(card.longYu?.sizeBase).toBeCloseTo(4, 9);
    expect(ungroupedOf(d)).toEqual(['3 4']);
    expect(d.pendingLegs[0]).toMatchObject({ venue: 'HYPERLIQUID', side: 'SHORT', maturity: OCT });
    expect(card.missingLong).toBe(0);
    expect(card.missingShort).toBe(0);
    expect(card.heldElsewhereShort?.map((l) => `${l.marketId} ${r6(l.sizeBase)}`)).toEqual(['3 10']);
    expect(card.offerMaturity).toBe(NOV);
    expect(perpOnlyCloseLegs(card).map((l) => `${l.venue} ${r6(l.qty)} ${l.partial}`)).toEqual(['GATE 4 true', 'HYPERLIQUID 4 true']);
  });

  it('half roll: the old leg rest takes the extra perps', () => {
    const d = deriveAsset(b15(2), {}, 0, NOW);
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID 2 4', 'BM GATE/HYPERLIQUID 3 2', `H GATE/HYPERLIQUID ${OCT} 6`]);
    expect(d.perpOnly.find((p) => p.shortYu?.marketId === 3)?.offerMaturity).toBe(OCT);
    expect(ungroupedOf(d)).toEqual(['3 2']);
  });

  it('half roll at a $6M book keeps the same cards and offer cut', () => {
    const g = b15();
    const k = 240;
    const big = {
      ...g,
      perpOpen: g.perpOpen.map((l) => ({ ...l, qty: l.qty * k, notionalUsd: l.notionalUsd * k, imUsd: l.imUsd * k })),
      borosOpen: g.borosOpen.map((b) => ({ ...b, sizeToken: b.sizeToken * k, notionalUsd: b.notionalUsd * k, imUsd: b.imUsd * k })),
    };
    const d = deriveAsset(big, {}, 0, NOW);
    expect(cardsOf(d)).toEqual([`BM GATE/HYPERLIQUID 2 ${4 * k}`, `H GATE/HYPERLIQUID ${OCT} ${6 * k}`]);
    expect(ungroupedOf(d)).toEqual([`3 ${4 * k}`]);
    expect(d.perpOnly[0].missingShort).toBe(0);
    expect(d.perpOnly[0].heldElsewhereShort?.map((l) => r6(l.sizeBase))).toEqual([10 * k]);
  });

  it('half roll after the old date', () => {
    const d = deriveAsset(b15(), {}, 0, OCT + 1);
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID - 6', 'BM GATE/HYPERLIQUID 2 4']);
    expect(d.pairs).toEqual([]);
    expect(ungroupedOf(d)).toEqual([]);
    const open = d.perpOnly.find((p) => !p.longYu && !p.shortYu);
    expect(open?.missingLong).toBeCloseTo(6, 9);
    expect(open?.missingShort).toBeCloseTo(6, 9);
  });

  it('offer date after a half roll', () => {
    const g = b15(2);
    const d = deriveAsset({ ...g, borosOpen: g.borosOpen.map((b) => (b.marketId === 3 ? { ...b, sizeToken: 6, notionalUsd: 6 * P } : b)) }, {}, 0, NOW);
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID - 2', 'BM GATE/HYPERLIQUID 2 4', `H GATE/HYPERLIQUID ${OCT} 6`]);
    const open = d.perpOnly.find((p) => Math.abs(p.size - 2) < 1e-9);
    expect(open?.longYu).toBeNull();
    expect(open?.shortYu).toBeNull();
    expect(open?.offerMaturity).toBe(NOV);
    expect(open?.missingLong).toBeCloseTo(2, 9);
    expect(open?.missingShort).toBeCloseTo(2, 9);
  });

  it('unknown price keeps the cards in the model', () => {
    const d = deriveAsset({ ...b15(), priceUsd: 0 }, {}, 0, NOW);
    expect(cardsOf(d)).toEqual([`BM GATE/HYPERLIQUID 2 4`, `H GATE/HYPERLIQUID ${OCT} 6`]);
    expect(ungroupedOf(d)).toEqual(['3 4']);
  });

  it('hedge check leaves twins out', () => {
    const d = deriveAsset(
      book(
        [
          gp('BINANCE', 'LONG', 4),
          gp('BINANCE', 'LONG', 1, { symbol: 'BINANCE_FUTURE_ETH_USDC', quoteTwin: true }),
          gp('HYPERLIQUID', 'SHORT', 4),
        ],
        [yu(1, 'BINANCE', 'LONG', 4, NOV), yu(2, 'HYPERLIQUID', 'SHORT', 4, NOV)],
      ),
      {},
      0,
      NOW,
    );
    const binance = d.venues.find((v) => v.venue === 'BINANCE');
    expect(binance?.perpSigned).toBeCloseTo(4, 9);
    expect(binance?.borosSigned).toBeCloseTo(4, 9);
    expect(binance?.covered).toBe(true);
    expect(d.gaps).toEqual([]);
    expect(cardsOf(d)).toEqual([`H BINANCE/HYPERLIQUID ${NOV} 4`]);
    expect(d.unpairedPerps.map((p) => `${p.symbol} ${r6(p.sizeBase)} ${p.quoteTwin}`)).toEqual(['BINANCE_FUTURE_ETH_USDC 1 true']);
  });

  it('F51 a USDC twin counts in the net perps at every rung', () => {
    for (const usd of [50, 5_000, 100_000, 1_000_000, 6_000_000]) {
      const q = usd / P;
      const d = deriveAsset(
        book(
          [
            gp('BINANCE', 'LONG', 4 * q),
            gp('BINANCE', 'LONG', q, { symbol: 'BINANCE_FUTURE_ETH_USDC', quoteTwin: true }),
            gp('HYPERLIQUID', 'SHORT', 4 * q),
          ],
          [yu(1, 'BINANCE', 'LONG', 4 * q, NOV), yu(2, 'HYPERLIQUID', 'SHORT', 4 * q, NOV)],
        ),
        {},
        0,
        NOW,
      );
      expect(r6(d.netPerp), `${usd}`).toBe(r6(q));
      expect(r6(d.grossPerp), `${usd}`).toBe(r6(9 * q));
      expect(d.deltaNeutral, `${usd}`).toBe(false);
      expect(d.perfect, `${usd}`).toBe(false);
      expect(d.gaps, `${usd}`).toEqual([]);
    }
  });

  it('S-CLOSE-02 a row is a part close unless it is the whole venue position, at every rung', () => {
    for (const usd of [50, 5_000, 100_000, 1_000_000, 6_000_000]) {
      const k = usd / 6_000_000;
      const g = book(
        [gp('HYPERLIQUID', 'LONG', 2400 * k), gp('GATE', 'SHORT', 2399.04 * k), gp('LIGHTER', 'SHORT', 0.96 * k)],
        [
          yu(1, 'HYPERLIQUID', 'LONG', 2399.04 * k, NOV),
          yu(2, 'GATE', 'SHORT', 2399.04 * k, NOV),
          yu(3, 'HYPERLIQUID', 'LONG', 0.96 * k, NOV),
          yu(4, 'LIGHTER', 'SHORT', 0.96 * k, NOV),
        ],
      );
      const held = new Map(g.perpOpen.map((l) => [l.symbol, l.qty]));
      const d = deriveAsset(g, {}, 0, NOW);
      const legs = [...d.pairs.flatMap((pair) => pairPerpCloseLegs(pair)), ...d.perpOnly.flatMap((pair) => perpOnlyCloseLegs(pair))];
      expect(legs.length, `${usd}`).toBeGreaterThan(0);
      for (const leg of legs) {
        const whole = held.get(leg.symbol) ?? 0;
        expect(leg.partial, `${usd} ${leg.venue} ${leg.qty} of ${whole}`).toBe(Math.abs(leg.qty - whole) > 1e-9 * whole);
      }
      if (usd >= 1_000_000) {
        expect(cardsOf(d), `${usd}`).toEqual([`H HYPERLIQUID/GATE ${NOV} ${r6(2399.04 * k)}`, `H HYPERLIQUID/LIGHTER ${NOV} ${r6(0.96 * k)}`]);
        const main = d.pairs.find((pair) => pair.shortVenue === 'GATE');
        const hl = main ? pairPerpCloseLegs(main).find((l) => l.venue === 'HYPERLIQUID') : undefined;
        expect(hl, `${usd}`).toEqual({ symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', qty: 2399.04 * k, venue: 'HYPERLIQUID', partial: true });
      }
    }
  });

  it('S-CLOSE-02 a part-excluded perp closes only the kept part', () => {
    const d = deriveAsset(
      book([gp('GATE', 'LONG', 10), gp('HYPERLIQUID', 'SHORT', 6)], [yu(1, 'GATE', 'LONG', 6, NOV), yu(2, 'HYPERLIQUID', 'SHORT', 6, NOV)]),
      { [perpKey('GATE_FUTURE_ETH_USDT')]: 4 },
      0,
      NOW,
    );
    expect(cardsOf(d)).toEqual([`H GATE/HYPERLIQUID ${NOV} 6`]);
    expect(pairPerpCloseLegs(d.pairs[0]).map((l) => `${l.venue} ${r6(l.qty)} ${l.partial}`)).toEqual(['GATE 6 true', 'HYPERLIQUID 6 false']);
  });

  it('B24 the open beside a tiny Boros leg offers the rest', () => {
    const d = deriveAsset(book([gp('GATE', 'LONG', 1), gp('HYPERLIQUID', 'SHORT', 1)], [yu(1, 'GATE', 'LONG', 0.008, NOV)]), {}, 0, NOW);
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID - 1']);
    expect(ungroupedOf(d)).toEqual(['1 0.008']);
    expect(r6(d.perpOnly[0].missingLong)).toBe(0.992);
    expect(d.perpOnly[0].missingShort).toBe(1);
  });

  it('#75 an excluded leg blocks the open that nets against it', () => {
    const d = deriveAsset(
      book([gp('GATE', 'LONG', 1), gp('HYPERLIQUID', 'SHORT', 1)], [yu(5, 'HYPERLIQUID', 'LONG', 1, OCT), yu(6, 'GATE', 'LONG', 1, NOV)]),
      { [borosKey(5)]: 'all', [borosKey(6)]: 1 },
      0,
      NOW,
    );
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID - 1']);
    const card = d.perpOnly[0];
    expect(card.otherWay).toEqual([]);
    expect(card.missingShort).toBe(1);
    expect(card.excludedNetsShort).toEqual([{ marketId: 5, venue: 'HYPERLIQUID', side: 'LONG', maturity: OCT }]);
    expect(card.missingLong).toBe(1);
    expect(card.excludedNetsLong).toEqual([]);
  });

  it('a held-other-way leg is listed on its card and blocks that side', () => {
    const d = deriveAsset(book([gp('GATE', 'LONG', 1), gp('HYPERLIQUID', 'SHORT', 1)], [yu(5, 'HYPERLIQUID', 'LONG', 1, OCT)]), {}, 0, NOW);
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID - 1']);
    const card = d.perpOnly[0];
    expect(card.otherWay.map((l) => `${l.marketId} ${r6(l.sizeBase)}`)).toEqual(['5 1']);
    expect(card.otherWay[0].wrongSide).toEqual({ blocks: true, againstVenue: 'HYPERLIQUID' });
    expect(card.blockedShort).toBe(true);
    expect(card.missingShort).toBe(0);
    expect(card.missingLong).toBeCloseTo(1, 9);
    expect(d.pendingLegs).toEqual([]);
  });

  it('a leg on another card does not cut the offer in the model', () => {
    const d = deriveAsset(
      book([gp('GATE', 'LONG', 10), gp('HYPERLIQUID', 'SHORT', 10)], [yu(1, 'GATE', 'LONG', 10, NOV), yu(2, 'LIGHTER', 'SHORT', 10, NOV)]),
      {},
      0,
      NOW,
    );
    expect(cardsOf(d)).toEqual(['BM GATE/HYPERLIQUID - 10', `PM GATE/LIGHTER ${NOV} 10`]);
    const card = d.perpOnly[0];
    expect(card.missingLong).toBeCloseTo(10, 9);
    expect(card.missingShort).toBeCloseTo(10, 9);
    expect(card.heldElsewhereLong).toBeUndefined();
    expect(card.offerMaturity).toBe(NOV);
  });

  it('a part exclude row carries its size in the market unit', () => {
    const d = deriveAsset(
      book([], [yu(4, 'GATE', 'LONG', 25_000, NOV, { collateral: 'USDT', notionalUsd: 25_000 })], { priceUsd: 2500 }),
      {},
      0,
      NOW,
    );
    expect(d.pendingLegs[0].sizeBase).toBeCloseTo(10, 9);
    expect(d.pendingLegs[0].rowSizeToken).toBeCloseTo(25_000, 6);
  });

  it('exclusion of a closed leg changes nothing', () => {
    expect(deriveAsset(b15(), { 'boros:999': 'all', 'boros:998': { qty: 2 } }, 0, NOW)).toEqual(deriveAsset(b15(), {}, 0, NOW));
  });

  it('ED-6648 only matured legs', () => {
    const d = deriveAsset(book([], [yu(1, 'GATE', 'LONG', 1, OCT), yu(2, 'HYPERLIQUID', 'SHORT', 1, OCT)]), {}, 0, OCT + DAY);
    expect(cardsOf(d)).toEqual([]);
    expect(ungroupedOf(d)).toEqual([]);
  });

  it('ED-6648 everything closed', () => {
    const d = deriveAsset(book([], []), {}, 0, NOW);
    expect([d.pairs, d.perpOnly, d.borosOnly, d.pendingLegs, d.unpairedPerps]).toEqual([[], [], [], [], []]);
  });

  it('ED-6648 another coin never mixes', () => {
    const btc = group({
      base: 'BTC',
      priceUsd: 60_000,
      perpOpen: [
        perp({ symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', side: 'LONG', qty: 10, notionalUsd: 600_000 }),
        perp({ symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', venue: 'HYPERLIQUID', side: 'SHORT', qty: 10, notionalUsd: 600_000 }),
      ],
      borosOpen: [
        boros({ marketId: 11, venue: 'GATE', side: 'LONG', collateral: 'BTC', sizeToken: 6, notionalUsd: 360_000, maturity: NOV }),
        boros({ marketId: 12, venue: 'HYPERLIQUID', side: 'SHORT', collateral: 'BTC', sizeToken: 6, notionalUsd: 360_000, maturity: NOV }),
      ],
    });
    const eth = deriveAsset(b15(), {}, 0, NOW);
    const other = deriveAsset(btc, {}, 0, NOW);
    expect(cardsOf(eth)).toEqual([`BM GATE/HYPERLIQUID 2 4`, `H GATE/HYPERLIQUID ${OCT} 6`]);
    expect(cardsOf(other)).toEqual(['BM GATE/HYPERLIQUID - 4', `H GATE/HYPERLIQUID ${NOV} 6`]);
    expect(other.pairs[0].legs.map((l) => l.marketId ?? l.symbol).sort()).toEqual([11, 12, 'GATE_FUTURE_BTC_USDT', 'HYPERLIQUID_FUTURE_BTC_USDC'].sort());
  });

  const g17 = () => book([gp('GATE', 'LONG', 1), gp('HYPERLIQUID', 'SHORT', 1)], [yu(1, 'GATE', 'LONG', 1, OCT), yu(2, 'HYPERLIQUID', 'SHORT', 1, OCT)]);

  it('ED-6648 maturing today', () => {
    expect(cardsOf(deriveAsset(g17(), {}, 0, OCT - 1))).toEqual([`H GATE/HYPERLIQUID ${OCT} 1`]);
  });

  it('ED-6648 at the maturity second', () => {
    expect(cardsOf(deriveAsset(g17(), {}, 0, OCT))).toEqual(['BM GATE/HYPERLIQUID - 1']);
  });

  it('ED-6648 maturing today: roll due', () => {
    const d = deriveAsset(g17(), {}, 0, OCT - 1);
    expect(pairRollDue(d.pairs[0], OCT - 1)).toBe(true);
  });
});

describe('sizes at scale', () => {
  it('card sizes equal the leg sizes at every rung', () => {
    const bookAt = (base: string, price: number, qty: number, borosSize: number, collateral: string) =>
      group({
        base,
        priceUsd: price,
        perpOpen: [
          perp({ symbol: 'GATE', venue: 'GATE', side: 'LONG', qty, notionalUsd: qty * price, imUsd: (qty * price) / 10 }),
          perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'SHORT', qty, notionalUsd: qty * price, imUsd: (qty * price) / 10 }),
        ],
        borosOpen: [
          boros({ marketId: 1, venue: 'GATE', side: 'LONG', collateral, sizeToken: borosSize, notionalUsd: qty * price, imUsd: (qty * price) / 25 }),
          boros({ marketId: 2, venue: 'HYPERLIQUID', side: 'SHORT', collateral, sizeToken: borosSize, notionalUsd: qty * price, imUsd: (qty * price) / 25 }),
        ],
      });
    const rungs = [
      ...[0.01, 1, 100, 2_400].map((qty) => ({ g: bookAt('ETH', 2_500, qty, qty, 'ETH'), qty, usd: qty * 2_500 })),
      ...[50, 5_000, 100_000, 1_000_000, 6_000_000].map((usd) => ({ g: bookAt('HYPE', 40, usd / 40, usd, 'USDT'), qty: usd / 40, usd })),
    ];
    for (const { g, qty, usd } of rungs) {
      const d = deriveAsset(g, {}, 0, NOW);
      if (usd < 50) {
        expect(d.pairs, `${usd}`).toEqual([]);
        const [card] = d.perpOnly;
        for (const leg of [card.long, card.short, ...d.pendingLegs]) {
          expect(leg.sizeBase, `${usd}`).toBe(qty);
          expect(leg.share, `${usd}`).toBe(1);
        }
        continue;
      }
      expect(d.pairs, `${usd}`).toHaveLength(1);
      const [pair] = d.pairs;
      expect(pair.legs).toHaveLength(4);
      for (const leg of pair.legs) {
        expect(leg.sizeBase, `${usd} ${leg.venue} ${leg.kind}`).toBe(qty);
        expect(leg.notionalUsd, `${usd} ${leg.venue} ${leg.kind}`).toBe(usd);
        expect(leg.share, `${usd} ${leg.venue} ${leg.kind}`).toBe(1);
      }
      expect(pairPerpCloseLegs(pair).map((l) => l.qty)).toEqual([qty, qty]);
      expect(pairPerpCloseLegs(pair).every((l) => !l.partial)).toBe(true);
    }
  });
});
