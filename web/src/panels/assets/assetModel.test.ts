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
  deriveAsset,
  keptSlice,
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
    expect(d.gaps).toMatchObject([{ venue: 'OKX', action: 'short-boros', size: 1000, unit: 'base', kind: 'missing', leg: 'boros' }]);
    expect(d.perfect).toBe(false);
  });

  it('a partially-covered venue reports only the shortfall; within 2% counts as covered', () => {
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
        { marketId: 1, venue: 'HYPERLIQUID', maturity: NOW + DAY, settleUsd: 100, settleFeeUsd: 2, tradePnlUsd: -10, tradeFeeUsd: 10 },
        { marketId: 2, venue: 'OKX', maturity: NOW + DAY, settleUsd: 40, settleFeeUsd: 1, tradePnlUsd: 0, tradeFeeUsd: 0 },
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
        { marketId: 1, venue: 'HYPERLIQUID', maturity: NOW + DAY, settleUsd: 500, settleFeeUsd: 12, tradePnlUsd: -30, tradeFeeUsd: 8 },
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


describe('exclusions and maturity — his 2026-09-09 rules', () => {
  it('a partial Boros exclusion scales the settled PnL by the kept fraction, not just capital', () => {
    const g = group({
      perpOpen: [perp({ symbol: 'HL', venue: 'HYPERLIQUID', side: 'LONG', qty: 1000, imUsd: 10_000 })],
      borosOpen: [boros({ marketId: 1, venue: 'HYPERLIQUID', side: 'LONG', sizeToken: 1000, imUsd: 10_000, mtmUsd: 900 })],
      borosHistory: [
        { marketId: 1, venue: 'HYPERLIQUID', maturity: NOW + 60 * DAY, settleUsd: 3000, settleFeeUsd: 30, tradePnlUsd: -10, tradeFeeUsd: 10 },
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
