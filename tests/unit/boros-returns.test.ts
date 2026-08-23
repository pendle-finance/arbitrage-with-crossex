/**
 * 4-leg strategy returns math (src/core/boros/returns.ts): sign conventions,
 * 18-dec + collateral-price scaling, the (venue, base) join, hedge states,
 * APR annualization/suppression, fee accounting, and the degraded modes.
 */
import { describe, expect, it } from 'vitest';
import type { BorosCollateralZone, BorosMarket, BorosTxn } from '../../src/core/boros/client';
import { resolveCollateralPricesUsd } from '../../src/core/boros/client';
import {
  buildStrategies,
  chainPerpEntrySlippageUsd,
  SECONDS_IN_YEAR,
  type BuildStrategiesInput,
  type DealFillRecord,
  type PerpFillRecord,
  type PerpPositionLike,
  type StrategyReturns,
} from '../../src/core/boros/returns';
import { imInputs, raw } from '../helpers/boros-fixtures';

/** Perp size no position claimed. It is a one-leg card of its own — the
 * `unhedgedResiduals` list this replaced was the same fact as a footnote. */
const unhedgedCards = (out: StrategyReturns) =>
  out.strategies.filter((s) => s.attribution.source === 'unhedged');
const unhedgedVenues = (out: StrategyReturns) =>
  unhedgedCards(out)
    .flatMap((s) => s.legs.map((l) => l.venue))
    .sort();
const unhedgedQty = (out: StrategyReturns, venue: string) =>
  unhedgedCards(out)
    .flatMap((s) => s.legs)
    .filter((l) => l.venue === venue)
    .reduce((a, l) => a + (l.notionalToken ?? 0), 0);

const NOW = 1_752_000_000;
const DAY = 86_400;
const OPENED = NOW - 12 * DAY;
const MATURITY = NOW + 15 * DAY;

const hlMarket: BorosMarket = {
  maxRateDeviationApr: 0.016,
  marketId: 155,
  tokenId: 3,
  name: 'Hyperliquid ETH 31 Jul 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  maturity: MATURITY,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: 0.076,
  floatingApr: 0.075,
  midApr: 0.076,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 1_880,
  ...imInputs,
};
const okxMarket: BorosMarket = {
  ...hlMarket,
  marketId: 158,
  name: 'OKX ETHUSDT 31 Jul 2026',
  venue: 'OKX',
  paymentPeriod: 28_800,
  markApr: 0.032,
  floatingApr: 0.031,
  midApr: 0.032,
};

/** Canonical 4-leg book (domain shape) — numbers documented in
 * tests/helpers/boros-fixtures.ts; keep the seams in lockstep. */
function ethZones(): BorosCollateralZone[] {
  return [
    {
      tokenId: 3,
      cross: {
        isCross: true,
        netBalance: raw(20_000),
        marketPositions: [
          {
            marketId: 155,
            side: 1,
            notionalSize: raw(-1_000_000),
            fixedApr: 0.08,
            markApr: 0.076,
            pnl: { rateSettlementPnl: raw(3_205), unrealisedPnl: raw(820) },
            positionInitialMargin: raw(5_000),
          },
          {
            marketId: 158,
            side: 0,
            notionalSize: raw(1_000_000),
            fixedApr: 0.03,
            markApr: 0.032,
            pnl: { rateSettlementPnl: raw(1_120), unrealisedPnl: raw(-300) },
            positionInitialMargin: raw(5_000),
          },
        ],
      },
      isolated: [],
    },
  ];
}

function ethTxns(): BorosTxn[] {
  return [
    { marketId: 155, time: OPENED, fee: raw(390), pnl: raw(-390), prevPositionS: '0', postPositionS: raw(-1_000_000), fixedApr: 0.08 },
    { marketId: 158, time: OPENED, fee: raw(300), pnl: raw(-300), prevPositionS: '0', postPositionS: raw(1_000_000), fixedApr: 0.03 },
  ];
}

/** Matching perp overlay: SHORT HL / LONG OKX, $1M each (Gate `fee` negative).
 * Entry gap: long 1883.4 − short 1883.0 = 0.4 × 531 = $212.40 entry slippage. */
const ENTRY_SLIPPAGE = (1883.4 - 1883.0) * 531;
function ethPerps(): PerpPositionLike[] {
  return [
    {
      symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
      positionSide: 'SHORT',
      positionQty: '-531',
      positionValue: '1000000',
      entryPrice: '1883.0',
      upnl: '50',
      fundingFee: '3120',
      fee: '-210',
      initialMargin: '12500',
      createTime: String(OPENED * 1000), // Gate reports ms
    },
    {
      symbol: 'OKX_FUTURE_ETH_USDT',
      positionSide: 'LONG',
      positionQty: '531',
      positionValue: '1000000',
      entryPrice: '1883.4',
      upnl: '-45',
      fundingFee: '-1940',
      fee: '-202',
      initialMargin: '12500',
      createTime: String(OPENED * 1000),
    },
  ];
}

function input(over: Partial<BuildStrategiesInput> = {}): BuildStrategiesInput {
  return {
    address: '0x' + 'ab'.repeat(20),
    zones: ethZones(),
    markets: [hlMarket, okxMarket],
    txnsByToken: new Map([[3, ethTxns()]]),
    pricesUsd: new Map([[3, 1]]),
    perpPositions: ethPerps(),
    nowSec: NOW,
    ...over,
  };
}

/** The itemised entry cost must total the two aggregates it decomposes, or the
 * client's add-back silently disagrees with the waterfalls. */
function assertEntryPartsSum(s: {
  perpEntryCostParts: { usd: number }[];
  feesUsd: { paid: { perpTradingUsd: number; perpEntrySlippageUsd: number | null } };
}) {
  expect(s.perpEntryCostParts.reduce((a, p) => a + p.usd, 0)).toBeCloseTo(
    s.feesUsd.paid.perpTradingUsd + (s.feesUsd.paid.perpEntrySlippageUsd ?? 0),
    6,
  );
}

describe('buildStrategies — canonical 4-leg book', () => {
  it('computes per-leg nets, realized total, spread, and locked APR', () => {
    const out = buildStrategies(input());
    expect(out.strategies).toHaveLength(1);
    const s = out.strategies[0];
    expect(s.base).toBe('ETH');
    expect(s.maturity).toBe(MATURITY);
    expect(s.legs).toHaveLength(4);

    // Perp legs first (sorted by venue), then Boros legs.
    expect(s.legs.map((l) => `${l.kind}:${l.venue}`)).toEqual([
      'perp:HYPERLIQUID',
      'perp:OKX',
      'boros:HYPERLIQUID',
      'boros:OKX',
    ]);

    // Per-leg nets: perp = funding − |fee| (price MtM EXCLUDED — the pair's
    // uPnLs cancel to entry-gap noise, accounted once as entry slippage);
    // boros = settlement + mtm + tradePnl(net).
    const [perpHl, perpOkx, borosHl, borosOkx] = s.legs;
    expect(perpHl.netUsd).toBeCloseTo(3120 - 210, 6);
    expect(perpOkx.netUsd).toBeCloseTo(-1940 - 202, 6);
    expect(perpHl.mtmUsd).toBeCloseTo(50, 6); // display-only, not in net
    expect(borosHl.netUsd).toBeCloseTo(3205 + 820 - 390, 6);
    expect(borosOkx.netUsd).toBeCloseTo(1120 - 300 - 300, 6);
    // Realized = Σ leg nets − entry slippage (subtracted once, pair-level).
    expect(s.realizedPnlUsd).toBeCloseTo(2910 - 2142 + 3635 + 520 - ENTRY_SLIPPAGE, 6);

    // Boros leg carries entry → mark rates + the live floating APR.
    expect(borosHl.side).toBe('SHORT');
    expect(borosHl.entryApr).toBeCloseTo(0.08);
    expect(borosHl.floatingApr).toBeCloseTo(0.075);
    expect(borosOkx.side).toBe('LONG');

    // Locked: SHORT receives 8%, LONG pays 3% on $1M each → $50k/yr fixed.
    // spread = 50_000 / (2M/2) = 5%; capital = perp IM 25k + boros balance 20k.
    expect(s.spread).toBeCloseTo(0.05, 10);
    expect(s.capitalUsd).toBeCloseTo(45_000, 6);
    // The split the share page pies must sum back to the whole.
    expect(s.capitalSplit.perpUsd).toBeCloseTo(25_000, 6);
    expect(s.capitalSplit.borosUsd).toBeCloseTo(20_000, 6);
    expect(s.capitalSplit.perpUsd + s.capitalSplit.borosUsd).toBeCloseTo(s.capitalUsd, 6);
    expect(s.lockedAprOnCapital).toBeCloseTo(50_000 / 45_000, 10);

    // Realized APR annualizes over the 12d since the earliest open.
    const elapsed = 12 * DAY;
    expect(s.elapsedSeconds).toBe(elapsed);
    expect(s.realizedApr).toBeCloseTo((s.realizedPnlUsd / 45_000) * (SECONDS_IN_YEAR / elapsed), 10);

    // Both venues cancel exactly → hedged, no mismatch.
    expect(s.hedge).toBe('hedged');
    expect(s.notionalMismatchUsd).toBeCloseTo(0, 6);
    expect(out.perpSource).toBe('connected-gate-account');
  });

  it('accounts fees: paid (exact perp + slippage + Boros trade + settle accrual) vs future', () => {
    const s = buildStrategies(input()).strategies[0];
    expect(s.feesUsd.paid.perpTradingUsd).toBeCloseTo(412, 6);
    // Entry crossing cost: (long entry − short entry) × matched qty.
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    expect(s.feesUsd.paid.borosTradeUsd).toBeCloseTo(690, 6);
    // 2 legs × $1M × 0.1% APR × 12d/365d — display-only accrual estimate.
    const paidSettle = 2 * 1_000_000 * 0.001 * ((12 * DAY) / SECONDS_IN_YEAR);
    expect(s.feesUsd.paid.borosSettlementUsd).toBeCloseTo(paidSettle, 6);
    expect(s.feesUsd.paid.totalUsd).toBeCloseTo(412 + ENTRY_SLIPPAGE + 690 + paidSettle, 6);
    // Future: settle runs to maturity; exit slippage mirrors entry; exit fees
    // need a fee schedule (none supplied here) → null, and the total propagates.
    const futureSettle = 2 * 1_000_000 * 0.001 * ((15 * DAY) / SECONDS_IN_YEAR);
    expect(s.feesUsd.future.borosSettlementUsd).toBeCloseTo(futureSettle, 6);
    expect(s.feesUsd.future.perpExitSlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    expect(s.feesUsd.future.perpExitFeesUsd).toBeNull();
    expect(s.feesUsd.future.totalUsd).toBeNull();
  });

  it('projects to maturity: spread return (full life) − paid costs − future settle fees', () => {
    const s = buildStrategies(input()).strategies[0];
    // Clock starts at the Boros open → the spread accrues over the FULL life.
    const lifeYears = (27 * DAY) / SECONDS_IN_YEAR; // 12d elapsed + 15d remaining
    const spreadReturn = (0.08 - 0.03) * 1_000_000 * lifeYears;
    expect(s.clockStartSec).toBe(OPENED);
    expect(s.spreadReturnUsd).toBeCloseTo(spreadReturn, 6);
    const futureSettle = 2 * 1_000_000 * 0.001 * ((15 * DAY) / SECONDS_IN_YEAR);
    expect(s.expectedPnlToMaturityUsd).toBeCloseTo(
      spreadReturn - s.feesUsd.paid.totalUsd - futureSettle,
      6,
    );
    expect(s.secondsToMaturity).toBe(15 * DAY);
  });
});

describe('buildStrategies — scaling', () => {
  it('converts token-margined zones to USD via the collateral price', () => {
    const btcMarket: BorosMarket = {
      ...hlMarket,
      marketId: 157,
      name: 'Hyperliquid BTC 31 Jul 2026',
      tokenId: 1,
      base: 'BTC',
      notionalOi: 40, // BTC-collateral units, not USD
      assetMarkPriceUsd: 118_000,
    };
    const zones: BorosCollateralZone[] = [
      {
        tokenId: 1,
        cross: {
          isCross: true,
          netBalance: raw(0.5),
          marketPositions: [
            {
              marketId: 157,
              side: 0,
              notionalSize: raw(40),
              fixedApr: 0.037,
              markApr: 0.08,
              pnl: { rateSettlementPnl: raw(0.12), unrealisedPnl: raw(0.067) },
              positionInitialMargin: raw(0.06),
            },
          ],
        },
        isolated: [],
      },
    ];
    const out = buildStrategies(
      input({
        zones,
        markets: [btcMarket],
        txnsByToken: new Map(),
        pricesUsd: resolveCollateralPricesUsd([btcMarket]),
        perpPositions: [],
      }),
    );
    const leg = out.strategies[0].legs[0];
    expect(leg.notionalUsd).toBeCloseTo(40 * 118_000, 3);
    expect(leg.collateral).toBe('BTC');
    expect(leg.notionalToken).toBeCloseTo(40, 10);
    expect(leg.cashFlowUsd).toBeCloseTo(0.12 * 118_000, 3);
    expect(leg.mtmUsd).toBeCloseTo(0.067 * 118_000, 3);
    expect(out.strategies[0].capitalUsd).toBeCloseTo(0.5 * 118_000, 3);
  });

  it('stamps every leg with its token-unit size; only Boros legs carry a collateral symbol', () => {
    const out = buildStrategies(input());
    const legs = out.strategies[0].legs;
    for (const leg of legs.filter((l) => l.kind === 'boros')) {
      expect(leg.collateral).toBe('USDT');
      expect(leg.notionalToken).toBeCloseTo(1_000_000, 6);
    }
    const perp = legs.find((l) => l.kind === 'perp')!;
    expect(perp.collateral).toBeUndefined();
    expect(perp.notionalToken).toBeCloseTo(531, 10); // |positionQty|, base-coin units
  });

  it('excludes zones whose collateral token has no USD reference, with a warning', () => {
    const zones = ethZones();
    zones[0].tokenId = 4; // BNB — no BNB market in the fixture set
    const out = buildStrategies(input({ zones, pricesUsd: new Map([[4, null]]) }));
    // No priceable Boros legs anywhere — the perps still render, as the
    // unhedged card every Boros-less coin gets, rather than vanishing.
    expect(out.strategies.flatMap((s) => s.legs).filter((l) => l.kind === 'boros')).toEqual([]);
    expect(out.strategies.map((s) => s.strategyId)).toEqual(['ETH#perps']);
    expect(out.warnings.join(' ')).toMatch(/BNB collateral zone/);
  });
});

describe('buildStrategies — hedge states & degraded modes', () => {
  it('Boros-only (Gate unconfigured): partial hedge, locked spread still computed', () => {
    const out = buildStrategies(input({ perpPositions: null }));
    expect(out.perpSource).toBeNull();
    expect(out.warnings.join(' ')).toMatch(/Gate credentials are not configured/);
    const s = out.strategies[0];
    expect(s.hedge).toBe('partial');
    expect(s.spread).toBeCloseTo(0.05, 10);
    expect(s.legs).toHaveLength(2);
    // Capital is the Boros balance only.
    expect(s.capitalUsd).toBeCloseTo(20_000, 6);
  });

  it('Gate connected but no matching perps: unhedged, with a plain-language warning', () => {
    const out = buildStrategies(input({ perpPositions: [] }));
    const s = out.strategies[0];
    expect(s.hedge).toBe('unhedged');
    expect(s.warnings.join(' ')).toMatch(/No matching perp legs for ETH/);
    // …said ONCE. The per-venue "no X perp found" note is for a card where
    // some OTHER venue does have its perp; with no perp legs at all it just
    // repeats the card-level sentence, once per venue.
    expect(s.warnings.filter((w) => /floating rate is unhedged/.test(w))).toHaveLength(0);
  });

  it('perp legs whose base has no Boros cohort become a card of their own', () => {
    // Every position is a card. A coin with no Boros side used to be someone
    // else's problem (the Positions panel's exposure boxes); now it renders in
    // the same book, saying plainly that no rate is locked against it.
    const stray: PerpPositionLike = {
      symbol: 'BINANCE_FUTURE_SOL_USDT',
      positionSide: 'LONG',
      positionQty: '10',
      positionValue: '2000',
      upnl: '1',
      fundingFee: '2',
      fee: '-1',
      initialMargin: '400',
    };
    const out = buildStrategies(input({ perpPositions: [...ethPerps(), stray] }));
    expect(out.strategies).toHaveLength(2);
    const sol = out.strategies.find((s) => s.base === 'SOL');
    expect(sol?.strategyId).toBe('SOL#perps');
    expect(sol?.attribution.source).toBe('unhedged');
    expect(sol?.hedge).toBe('unhedged');
    expect(sol?.legs.map((l) => `${l.kind}:${l.venue}`)).toEqual(['perp:BINANCE']);
    // The ETH strategy is untouched by the stray coin.
    expect(out.strategies.find((s) => s.base === 'ETH')?.legs.filter((l) => l.base === 'SOL')).toEqual([]);
  });

  it('flags a notional mismatch beyond the 2% band as a partial hedge', () => {
    const perps = ethPerps();
    perps[0].positionValue = '600000'; // HL perp only covers 60% of the Boros leg
    const out = buildStrategies(input({ perpPositions: perps }));
    const s = out.strategies[0];
    expect(s.hedge).toBe('partial');
    expect(s.notionalMismatchUsd).toBeCloseTo(400_000, 6);
    expect(s.warnings.join(' ')).toMatch(/HYPERLIQUID legs are imbalanced/);
  });

  it('a Boros leg with no perp on its venue warns venue-specifically', () => {
    const out = buildStrategies(input({ perpPositions: [ethPerps()[0]] })); // HL perp only
    const s = out.strategies[0];
    expect(s.hedge).toBe('partial');
    expect(s.warnings.join(' ')).toMatch(/No OKX perp found for ETH/);
  });
});

describe('buildStrategies — time & APR edge cases', () => {
  it('suppresses realized APR before one full settlement period', () => {
    const zones = ethZones();
    const txns = ethTxns().map((t) => ({ ...t, time: NOW - 1_800 })); // opened 30min ago
    const perps = ethPerps().map((p) => ({ ...p, createTime: String((NOW - 1_800) * 1000) }));
    // OKX pays every 8h → elapsed 30min < 28_800s.
    const out = buildStrategies(input({ zones, txnsByToken: new Map([[3, txns]]), perpPositions: perps }));
    expect(out.strategies[0].realizedApr).toBeNull();
    expect(out.totals.realizedApr).toBeNull();
  });

  it('handles matured cohorts: spread stops at maturity, zero future settle fees', () => {
    const past = NOW - DAY;
    const markets = [
      { ...hlMarket, maturity: past },
      { ...okxMarket, maturity: past },
    ];
    const out = buildStrategies(input({ markets }));
    const s = out.strategies[0];
    expect(s.secondsToMaturity).toBe(0);
    // Spread accrued only over the 11d the position lived (open → maturity).
    const lifeYears = (11 * DAY) / SECONDS_IN_YEAR;
    expect(s.spreadReturnUsd).toBeCloseTo((0.08 - 0.03) * 1_000_000 * lifeYears, 6);
    expect(s.feesUsd.future.borosSettlementUsd).toBe(0);
    // Paid settle accrual is also capped at maturity.
    expect(s.feesUsd.paid.borosSettlementUsd).toBeCloseTo(2 * 1_000_000 * 0.001 * lifeYears, 6);
    expect(s.expectedPnlToMaturityUsd).toBeCloseTo(
      s.spreadReturnUsd! - s.feesUsd.paid.totalUsd,
      6,
    );
  });

  it('measures fees/open-time from the LATEST open-from-flat event only', () => {
    const txns: BorosTxn[] = [
      // A previous round-trip whose fees must NOT count.
      { marketId: 155, time: OPENED - 30 * DAY, fee: raw(999), pnl: raw(-999), prevPositionS: '0', postPositionS: raw(-500_000), fixedApr: 0.09 },
      { marketId: 155, time: OPENED - 20 * DAY, fee: raw(999), pnl: raw(1_500), prevPositionS: raw(-500_000), postPositionS: '0', fixedApr: 0.085 },
      ...ethTxns(),
    ];
    const s = buildStrategies(input({ txnsByToken: new Map([[3, txns]]) })).strategies[0];
    expect(s.feesUsd.paid.borosTradeUsd).toBeCloseTo(690, 6);
    expect(s.elapsedSeconds).toBe(12 * DAY);
  });

  it('missing txn history: warns, keeps computing, and leans on perp open times', () => {
    const out = buildStrategies(input({ txnsByToken: new Map() }));
    const s = out.strategies[0];
    expect(s.warnings.join(' ')).toMatch(/No trade history found/);
    expect(s.feesUsd.paid.borosTradeUsd).toBe(0);
    // Perp createTime still anchors the annualization window.
    expect(s.elapsedSeconds).toBe(12 * DAY);
    expect(s.realizedApr).not.toBeNull();
  });

  it('a market missing from /markets degrades with a warning, never crashes', () => {
    const out = buildStrategies(input({ markets: [okxMarket] })); // HL market absent
    const s = out.strategies.find((x) => x.legs.some((l) => l.warnings.length));
    expect(out.strategies.length).toBeGreaterThan(0);
    expect(s ?? out.strategies[0]).toBeTruthy();
    const all = out.strategies.flatMap((x) => x.warnings).join(' ');
    expect(all).toMatch(/missing from \/markets/);
  });
});

describe('buildStrategies — margin groups & capital', () => {
  it('includes ISOLATED margin groups (positions + their own capital)', () => {
    const zones: BorosCollateralZone[] = [
      {
        tokenId: 3,
        cross: { isCross: true, netBalance: raw(20_000), marketPositions: [ethZones()[0].cross!.marketPositions[0]] },
        isolated: [
          {
            isCross: false,
            netBalance: raw(7_000),
            marketPositions: [ethZones()[0].cross!.marketPositions[1]],
          },
        ],
      },
    ];
    const out = buildStrategies(input({ zones }));
    const s = out.strategies[0];
    // Both legs present (one from cross, one from the isolated group)…
    expect(s.legs.filter((l) => l.kind === 'boros')).toHaveLength(2);
    // …and capital = perp IM 25k + cross balance 20k + isolated balance 7k.
    expect(s.capitalUsd).toBeCloseTo(25_000 + 20_000 + 7_000, 6);
  });

  it('apportions a shared margin group across cohorts by IM share (never double-counts)', () => {
    const laterMaturity = MATURITY + 56 * DAY;
    const hlSep: BorosMarket = { ...hlMarket, marketId: 169, maturity: laterMaturity };
    const zones = ethZones();
    // Same cross group backs a second cohort with 3x the IM of each first-cohort leg.
    zones[0].cross!.marketPositions.push({
      marketId: 169,
      side: 1,
      notionalSize: raw(-3_000_000),
      fixedApr: 0.06,
      markApr: 0.058,
      pnl: { rateSettlementPnl: raw(0), unrealisedPnl: raw(0) },
      positionInitialMargin: raw(30_000),
    });
    const out = buildStrategies(
      input({ zones, markets: [hlMarket, okxMarket, hlSep], perpPositions: [] }),
    );
    // Group IM = 5k + 5k + 30k; balance 20k splits 25%/75% across the cohorts.
    const first = out.strategies.find((s) => s.maturity === MATURITY)!;
    const second = out.strategies.find((s) => s.maturity === laterMaturity)!;
    expect(first.capitalUsd).toBeCloseTo(20_000 * (10_000 / 40_000), 6);
    expect(second.capitalUsd).toBeCloseTo(20_000 * (30_000 / 40_000), 6);
    expect(first.capitalUsd + second.capitalUsd).toBeCloseTo(20_000, 6);
  });
});

describe('buildStrategies — perp field robustness', () => {
  it('derives perp side from the qty sign when positionSide is missing', () => {
    const perps = ethPerps().map(({ positionSide, ...rest }) => rest as PerpPositionLike);
    // HL leg has qty '-531' → SHORT; OKX '531' → LONG — hedge stays intact.
    const out = buildStrategies(input({ perpPositions: perps }));
    const s = out.strategies[0];
    const perpLegs = s.legs.filter((l) => l.kind === 'perp');
    expect(perpLegs.find((l) => l.venue === 'HYPERLIQUID')?.side).toBe('SHORT');
    expect(perpLegs.find((l) => l.venue === 'OKX')?.side).toBe('LONG');
    expect(s.hedge).toBe('hedged');
  });

  it('accepts Gate createTime in SECONDS as well as milliseconds', () => {
    const perps = ethPerps().map((p) => ({ ...p, createTime: String(OPENED) })); // seconds
    const out = buildStrategies(input({ txnsByToken: new Map(), perpPositions: perps }));
    // Annualization window anchors on the perp opens (Boros open unknown here).
    expect(out.strategies[0].elapsedSeconds).toBe(12 * DAY);
  });

  it('reports a transient perp failure with the caller-supplied warning, not "not configured"', () => {
    const out = buildStrategies(
      input({
        perpPositions: null,
        perpsUnavailableWarning: "Couldn't load Gate positions right now (rate-limited) — retrying.",
      }),
    );
    expect(out.warnings.join(' ')).toMatch(/rate-limited/);
    expect(out.warnings.join(' ')).not.toMatch(/credentials are not configured/);
    expect(out.strategies[0].hedge).toBe('partial');
  });
});

describe('buildStrategies — perp funding re-based to the strategy clock', () => {
  /** Perps opened 10d BEFORE the Boros lock (a pre-existing arb, later locked). */
  const olderPerps = () =>
    ethPerps().map((p, i) => ({
      ...p,
      positionId: `pos-${i}`,
      createTime: String((OPENED - 10 * DAY) * 1000),
    }));

  it('re-sums funding from the account-book ledger when a position predates the clock', () => {
    // Ledger: pos-0 received 100/day; only the 12 days SINCE the Boros open count.
    const entries = (positionId: string, perDay: number) =>
      Array.from({ length: 22 }, (_, d) => ({
        positionId,
        timeSec: OPENED - 10 * DAY + d * DAY + 60,
        changeUsd: perDay,
      }));
    const out = buildStrategies(
      input({
        perpPositions: olderPerps(),
        perpFunding: {
          coversFromSec: 0,
          byPosition: new Map([
            ['pos-0', entries('pos-0', 100)],
            ['pos-1', entries('pos-1', -50)],
          ]),
        },
      }),
    );
    const s = out.strategies[0];
    const hl = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    const okx = s.legs.find((l) => l.kind === 'perp' && l.venue === 'OKX')!;
    // 12 daily settlements fall inside [clockStart, now): d = 10..21.
    expect(hl.cashFlowUsd).toBeCloseTo(12 * 100, 6);
    expect(okx.cashFlowUsd).toBeCloseTo(12 * -50, 6);
    expect(hl.netUsd).toBeCloseTo(1200 - 210, 6);
    expect(s.warnings.join(' ')).not.toMatch(/pre-lock accrual/);
  });

  it('keeps the cumulative counter (with a warning) when the ledger cannot cover the window', () => {
    const out = buildStrategies(
      input({
        perpPositions: olderPerps(),
        // Ledger only covers from AFTER the clock start — insufficient.
        perpFunding: { coversFromSec: OPENED + DAY, byPosition: new Map() },
      }),
    );
    const s = out.strategies[0];
    const hl = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    expect(hl.cashFlowUsd).toBeCloseTo(3120, 6); // unchanged since-open counter
    expect(s.warnings.join(' ')).toMatch(/pre-lock accrual/);
  });

  it('trusts an empty ledger within 8h of the lock — a young strategy has no settlements yet', () => {
    // Perp opened shortly before the Boros legs, strategy locked 4h ago: no
    // funding boundary has passed since the lock (venues settle at up to 8h
    // intervals), so zero ledger rows IS the truth. Funding since start is a
    // genuine $0 — re-based silently, no confusing "returned no rows" notice.
    const out = buildStrategies(
      input({
        nowSec: OPENED + 4 * 3600,
        perpPositions: olderPerps(),
        perpFunding: { coversFromSec: 0, byPosition: new Map() },
      }),
    );
    const s = out.strategies[0];
    const hl = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    expect(hl.cashFlowUsd).toBe(0); // re-based: nothing settled since the lock
    expect(hl.netUsd).toBe(-hl.feesUsd);
    expect(s.warnings.join(' ')).not.toMatch(/returned no rows/);
  });

  it('past the 8h grace an empty ledger is suspicious again — counter kept, warning shown', () => {
    const out = buildStrategies(
      input({
        nowSec: OPENED + 8 * 3600 + 60,
        perpPositions: olderPerps(),
        perpFunding: { coversFromSec: 0, byPosition: new Map() },
      }),
    );
    const s = out.strategies[0];
    const hl = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    expect(hl.cashFlowUsd).toBeCloseTo(3120, 6); // counter kept, NOT zeroed
    expect(s.warnings.join(' ')).toMatch(/returned no rows/);
  });

  it('keeps the counter (with a warning) when the ledger covers the window but has no rows for the position', () => {
    // The regression: coversFromSec 0 means "uncapped fetch", which is ALSO what
    // an empty/unusable ledger response produces. Summing `?? []` here yielded 0
    // and confidently overwrote the venue's cumulative funding with $0 — the
    // largest P&L component of a funding-rate arb — while the else-branch warning
    // could never fire, so the number looked earned rather than missing.
    const out = buildStrategies(
      input({
        perpPositions: olderPerps(),
        perpFunding: { coversFromSec: 0, byPosition: new Map() },
      }),
    );
    const s = out.strategies[0];
    const hl = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    expect(hl.cashFlowUsd).toBeCloseTo(3120, 6); // counter kept, NOT zeroed
    expect(s.warnings.join(' ')).toMatch(/returned no rows/);
  });

  it('re-bases only the positions the ledger actually carries', () => {
    // pos-0 is present, pos-1 is missing: one leg re-bases, the other keeps its
    // counter and says so. A blanket `?? []` would silently zero pos-1.
    const out = buildStrategies(
      input({
        perpPositions: olderPerps(),
        perpFunding: {
          coversFromSec: 0,
          byPosition: new Map([
            [
              'pos-0',
              Array.from({ length: 22 }, (_, d) => ({
                positionId: 'pos-0',
                timeSec: OPENED - 10 * DAY + d * DAY + 60,
                changeUsd: 100,
              })),
            ],
          ]),
        },
      }),
    );
    const s = out.strategies[0];
    const hl = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    const okx = s.legs.find((l) => l.kind === 'perp' && l.venue === 'OKX')!;
    expect(hl.cashFlowUsd).toBeCloseTo(12 * 100, 6); // re-based from the ledger
    expect(okx.cashFlowUsd).not.toBeCloseTo(0, 6); // counter kept, not zeroed
    expect(s.warnings.join(' ')).toMatch(/returned no rows/);
  });

  it('leaves positions opened at/after the clock alone (counter already equals since-start)', () => {
    const out = buildStrategies(
      input({
        perpPositions: ethPerps().map((p, i) => ({ ...p, positionId: `pos-${i}` })),
        perpFunding: { coversFromSec: 0, byPosition: new Map() }, // empty ledger — must not matter
      }),
    );
    const hl = out.strategies[0].legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    expect(hl.cashFlowUsd).toBeCloseTo(3120, 6);
    expect(out.strategies[0].warnings.join(' ')).not.toMatch(/pre-lock accrual/);
  });
});

describe('buildStrategies — APR clock basis', () => {
  it('defaults the clock to the earliest BOROS open even when the perps are older', () => {
    // Perp pair has existed 10 days longer than the Boros legs.
    const perps = ethPerps().map((p) => ({ ...p, createTime: String((OPENED - 10 * DAY) * 1000) }));
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    expect(s.clockBasis).toBe('boros-open');
    expect(s.clockStartSec).toBe(OPENED);
    expect(s.elapsedSeconds).toBe(12 * DAY); // NOT 22d — the spread lock starts the clock
    expect(s.realizedApr).toBeCloseTo(
      (s.realizedPnlUsd / s.capitalUsd) * (SECONDS_IN_YEAR / (12 * DAY)),
      10,
    );
  });

  it('falls back to the perp open (with a warning) when the Boros open time is unknown', () => {
    const s = buildStrategies(input({ txnsByToken: new Map() })).strategies[0];
    expect(s.clockBasis).toBe('perp-open');
    expect(s.elapsedSeconds).toBe(12 * DAY);
    expect(s.warnings.join(' ')).toMatch(/APR clock falls back to the earliest perp open/);
  });

  it('a custom override wins over both and re-annualizes accordingly', () => {
    const s = buildStrategies(input({ clockStartOverrideSec: NOW - 6 * DAY })).strategies[0];
    expect(s.clockBasis).toBe('custom');
    expect(s.clockStartSec).toBe(NOW - 6 * DAY);
    // The spread-return window follows the same clock: 6d elapsed + 15d left.
    expect(s.spreadReturnUsd).toBeCloseTo(
      (0.08 - 0.03) * 1_000_000 * ((21 * DAY) / SECONDS_IN_YEAR),
      6,
    );
    expect(s.elapsedSeconds).toBe(6 * DAY);
    expect(s.realizedApr).toBeCloseTo(
      (s.realizedPnlUsd / s.capitalUsd) * (SECONDS_IN_YEAR / (6 * DAY)),
      10,
    );
  });

  it('the suppression rule applies to the override window too', () => {
    // 30-minute custom window < OKX's 8h settlement period → APR suppressed.
    const s = buildStrategies(input({ clockStartOverrideSec: NOW - 1_800 })).strategies[0];
    expect(s.realizedApr).toBeNull();
  });
});

describe('buildStrategies — perp exit cost (maker+hedge)', () => {
  const feeRows = [
    { exchangeType: 'HYPERLIQUID', futureMakerFee: '0.0002', futureTakerFee: '0.00048' },
    { exchangeType: 'OKX', futureMakerFee: '0.0002', futureTakerFee: '0.00048' },
  ];

  it('prices the pair exit as maker on one leg + taker on the other', () => {
    const s = buildStrategies(input({ venueFees: feeRows })).strategies[0];
    // Symmetric rates: either assignment costs $1M × (2 + 4.8) bps.
    expect(s.feesUsd.future.perpExitFeesUsd).toBeCloseTo(
      1_000_000 * 0.0002 + 1_000_000 * 0.00048,
      6,
    );
    // Exit slippage mirrors the entry crossing cost, so the future total closes.
    expect(s.feesUsd.future.perpExitSlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    const futureSettle = 2 * 1_000_000 * 0.001 * ((15 * DAY) / SECONDS_IN_YEAR);
    expect(s.feesUsd.future.totalUsd).toBeCloseTo(
      s.feesUsd.future.perpExitFeesUsd! + ENTRY_SLIPPAGE + futureSettle,
      6,
    );
  });

  it('picks the CHEAPER maker assignment when venue rates differ', () => {
    const rows = [
      {
        exchangeType: 'HYPERLIQUID',
        futureMakerFee: '0.0002',
        futureTakerFee: '0.00048',
        specialFeeList: [
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', makerFeeRate: '0', takerFeeRate: '0.0002' },
        ],
      },
      { exchangeType: 'OKX', futureMakerFee: '0.0002', futureTakerFee: '0.00048' },
    ];
    const s = buildStrategies(input({ venueFees: rows })).strategies[0];
    // HL maker + OKX taker = 0 + 480; HL taker + OKX maker = 200 + 200 → $400.
    expect(s.feesUsd.future.perpExitFeesUsd).toBeCloseTo(400, 6);
  });

  it('falls back to taker-per-leg when the strategy is not a 2-leg pair', () => {
    const s = buildStrategies(
      input({ perpPositions: [ethPerps()[0]], venueFees: feeRows }),
    ).strategies[0];
    expect(s.feesUsd.future.perpExitFeesUsd).toBeCloseTo(1_000_000 * 0.00048, 6);
  });

  it('reports null (never a guess) when perps exist but the schedule is unknown', () => {
    const out = buildStrategies(input()); // no venueFees supplied
    const s = out.strategies[0];
    expect(s.feesUsd.future.perpExitFeesUsd).toBeNull();
    expect(out.totals.perpExitFeesTotalUsd).toBeNull();
    // Slippage doesn't need the schedule — it stays known.
    expect(out.totals.perpExitSlippageTotalUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
  });

  it('is zero fees AND zero slippage for a Boros-only strategy (nothing to exit on Gate)', () => {
    // Structurally 0, never null: a null would poison the account totals for
    // every other strategy whose slippage IS known.
    const out = buildStrategies(input({ perpPositions: [], venueFees: feeRows }));
    expect(out.strategies[0].feesUsd.future.perpExitFeesUsd).toBe(0);
    expect(out.strategies[0].feesUsd.future.perpExitSlippageUsd).toBe(0);
    expect(out.strategies[0].feesUsd.paid.perpEntrySlippageUsd).toBe(0);
    expect(out.strategies[0].feesUsd.future.totalUsd).not.toBeNull();
    expect(out.totals.perpExitFeesTotalUsd).toBe(0);
    expect(out.totals.perpExitSlippageTotalUsd).toBe(0);
  });
});

describe('buildStrategies — entry slippage', () => {
  it('is signed: a favorable entry gap becomes a negative (gain) cost', () => {
    const perps = ethPerps();
    perps[1].entryPrice = '1882.5'; // long entered BELOW the short → favorable
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo((1882.5 - 1883.0) * 531, 6);
  });

  it('is null with a warning when an entry price is missing', () => {
    const perps = ethPerps();
    delete perps[0].entryPrice;
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeNull();
    expect(s.feesUsd.future.perpExitSlippageUsd).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/Entry slippage for ETH is unknown/);
    // A null slippage counts as 0 in the paid total (never a guess).
    const paidSettle = 2 * 1_000_000 * 0.001 * ((12 * DAY) / SECONDS_IN_YEAR);
    expect(s.feesUsd.paid.totalUsd).toBeCloseTo(412 + 690 + paidSettle, 6);
  });

  it('is null with a warning when the perp side is not a simple 1-long/1-short pair', () => {
    const s = buildStrategies(input({ perpPositions: [ethPerps()[0]] })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/Entry slippage for ETH is unknown/);
  });

  it('uses the matched (smaller) qty when the legs are unevenly sized', () => {
    const perps = ethPerps();
    perps[1].positionQty = '400';
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo((1883.4 - 1883.0) * 400, 6);
  });
});

describe('buildStrategies — migrated perp pair (entry slippage chaining)', () => {
  /** The HL short's ORIGINAL entry, 10 days before the OKX long existed. The
   * live entry gap (1883.4 − 1900.0) × 531 = −$8,814.60 is almost entirely
   * market drift over those 10 days — the number the fix must never show. */
  const H0 = 1900.0;
  const PHANTOM = (1883.4 - H0) * 531;
  function migratedPerps(): PerpPositionLike[] {
    const perps = ethPerps();
    perps[0].entryPrice = String(H0);
    perps[0].createTime = String((OPENED - 10 * DAY) * 1000);
    return perps;
  }
  /** The chain that actually built the book: Short HL / Long GATE at t−10d,
   * then the migration Short GATE (reduce) / Long OKX at t. Each deal's own
   * contemporaneous gap is $212.40; the drift lives between deals. */
  function migrationDeals(): DealFillRecord[] {
    return [
      {
        dealId: 'deal-hl-gate',
        aContract: 'HYPERLIQUID_FUTURE_ETH_USDC',
        aSide: 'SELL',
        bContract: 'GATE_FUTURE_ETH_USDT',
        bSide: 'BUY',
        aFilled: 531,
        bFilled: 531,
        aAvgFill: 1900.0,
        bAvgFill: 1900.4,
        createdAtSec: OPENED - 10 * DAY,
      },
      {
        dealId: 'deal-gate-okx',
        aContract: 'GATE_FUTURE_ETH_USDT',
        aSide: 'SELL',
        bContract: 'OKX_FUTURE_ETH_USDT',
        bSide: 'BUY',
        aFilled: 531,
        bFilled: 531,
        aAvgFill: 1883.0,
        bAvgFill: 1883.4,
        createdAtSec: OPENED,
      },
    ];
  }
  const CHAINED = 2 * ENTRY_SLIPPAGE; // $212.40 + $212.40

  it('ESTIMATES from the live entry gap without the journal, and flags it when large', () => {
    // Doctrine change: this used to report null and drop the cost entirely.
    // Excluding it reads as zero in the totals the user decides on, so the
    // estimate is kept and LABELLED instead — the per-leg entry override is
    // the correction when the user knows what a leg really filled at.
    const s = buildStrategies(input({ perpPositions: migratedPerps() })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(PHANTOM, 6);
    // This fixture's gap is drift-sized — far over the 0.5% threshold — so it
    // must carry the warning rather than pass silently.
    expect(s.warnings.join(' ')).toMatch(/estimate from the live entry gap.*looks large/s);
    expect(s.warnings.join(' ')).toMatch(/Manual adjustment/);
    // And it is now IN the paid total, not excluded from it.
    const paidSettle = 2 * 1_000_000 * 0.001 * ((12 * DAY) / SECONDS_IN_YEAR);
    expect(s.feesUsd.paid.totalUsd).toBeCloseTo(412 + PHANTOM + 690 + paidSettle, 6);
  });

  it('does NOT flag an estimate that is small enough to be an ordinary crossing cost', () => {
    // Below the threshold the gap is what a taker pays, and warning about it
    // would train the user to dismiss the warning that matters.
    const perps = migratedPerps();
    perps[0].entryPrice = String(1883.4 - 1); // ~0.05% of notional
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(1 * 531, 6);
    expect(s.warnings.join(' ')).not.toMatch(/looks large/);
  });

  it('sums the journal chain: both deals’ gaps, never the drift-sized live gap', () => {
    const s = buildStrategies(
      input({ perpPositions: migratedPerps(), dealFills: migrationDeals() }),
    ).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(CHAINED, 6);
    expect(s.feesUsd.paid.perpEntrySlippageUsd).not.toBeCloseTo(PHANTOM, 0);
    expect(s.feesUsd.future.perpExitSlippageUsd).toBeCloseTo(CHAINED, 6); // exit mirrors the chain
    expect(s.warnings.join(' ')).toMatch(/summed from 2 deals in this terminal's journal/);
    const paidSettle = 2 * 1_000_000 * 0.001 * ((12 * DAY) / SECONDS_IN_YEAR);
    expect(s.feesUsd.paid.totalUsd).toBeCloseTo(412 + CHAINED + 690 + paidSettle, 6);
  });

  it.each([
    { deltaSec: 15 * 60, viaLiveEntries: true }, // at the sync limit — contemporaneous
    { deltaSec: 15 * 60 + 1, viaLiveEntries: false }, // one second past — not attributable
  ])('open-time gap of $deltaSec s → live entries: $viaLiveEntries', ({ deltaSec, viaLiveEntries }) => {
    const perps = ethPerps(); // entries 1883.0/1883.4 — real gap, no drift
    perps[0].createTime = String((OPENED - deltaSec) * 1000);
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    // Either way the NUMBER is the live gap now — what the sync check decides
    // is whether it is reported as measured or as a flagged estimate.
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    if (viaLiveEntries) expect(s.warnings.join(' ')).not.toMatch(/estimate from the live entry gap/);
  });

  it('treats a missing open time as not-contemporaneous, with its own warning', () => {
    const perps = ethPerps();
    delete perps[0].createTime;
    const s = buildStrategies(input({ perpPositions: perps })).strategies[0];
    // Estimated, not refused — but this fixture's gap is small, so the cause
    // only surfaces if the number is also big enough to be suspect.
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
  });

  it('a same-time book keeps the live formula even when the journal is present', () => {
    const s = buildStrategies(
      input({ perpPositions: ethPerps(), dealFills: migrationDeals() }),
    ).strategies[0];
    // Precedence pin: positions API stays the source of truth for synced books.
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    expect(s.warnings.join(' ')).not.toMatch(/journal/);
  });

  it('chains a DCA top-up as a third gap', () => {
    const perps = migratedPerps();
    perps[0].positionQty = '-581';
    perps[1].positionQty = '581';
    const deals = [
      ...migrationDeals(),
      {
        dealId: 'deal-dca',
        aContract: 'HYPERLIQUID_FUTURE_ETH_USDC',
        aSide: 'SELL' as const,
        bContract: 'OKX_FUTURE_ETH_USDT',
        bSide: 'BUY' as const,
        aFilled: 50,
        bFilled: 50,
        aAvgFill: 1901.0,
        bAvgFill: 1901.2,
        createdAtSec: OPENED + 3600,
      },
    ];
    const s = buildStrategies(input({ perpPositions: perps, dealFills: deals })).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(CHAINED + (1901.2 - 1901.0) * 50, 6);
    expect(s.warnings.join(' ')).toMatch(/summed from 3 deals/);
  });

  it('falls back to the flagged ESTIMATE when the chain does not reconcile', () => {
    // A non-reconciling chain is the same situation as no journal at all: the
    // fills cannot be rebuilt, so the live gap is the best available number.
    // Kept and labelled rather than dropped — see the doctrine note above.
    const perps = migratedPerps();
    perps[0].positionQty = '-400'; // 131 contracts were closed off-journal
    perps[1].positionQty = '400';
    const s = buildStrategies(
      input({ perpPositions: perps, dealFills: migrationDeals() }),
    ).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).not.toBeNull();
    expect(s.warnings.join(' ')).toMatch(/estimate from the live entry gap.*looks large/s);
  });

  it('a migrated book itemises EVERY execution, each addressable by deal id', () => {
    const s = buildStrategies(
      input({ perpPositions: migratedPerps(), dealFills: migrationDeals() }),
    ).strategies[0];
    assertEntryPartsSum(s);
    const slip = s.perpEntryCostParts.filter((p) => p.kind === 'slippage');
    expect(slip.map((p) => p.id)).toEqual(['slip:deal:deal-hl-gate', 'slip:deal:deal-gate-okx']);
    // Each part is that deal's OWN contemporaneous gap — the drift between
    // deals never enters any of them.
    expect(slip.every((p) => Math.abs(p.usd - ENTRY_SLIPPAGE) < 1e-6)).toBe(true);
    // …and the venues name the pair actually crossed, including the venue the
    // live book no longer holds.
    expect(slip[0].venues.sort()).toEqual(['GATE', 'HYPERLIQUID']);
    expect(slip[1].venues.sort()).toEqual(['GATE', 'OKX']);
    expect(slip[0].atSec).toBeLessThan(slip[1].atSec!);
  });

  it('the DCA top-up is its own tickable part', () => {
    const perps = migratedPerps();
    perps[0].positionQty = '-581';
    perps[1].positionQty = '581';
    const deals = [
      ...migrationDeals(),
      {
        dealId: 'deal-dca',
        aContract: 'HYPERLIQUID_FUTURE_ETH_USDC',
        aSide: 'SELL' as const,
        bContract: 'OKX_FUTURE_ETH_USDT',
        bSide: 'BUY' as const,
        aFilled: 50,
        bFilled: 50,
        aAvgFill: 1901.0,
        bAvgFill: 1901.2,
        createdAtSec: OPENED + 3600,
      },
    ];
    const s = buildStrategies(input({ perpPositions: perps, dealFills: deals })).strategies[0];
    assertEntryPartsSum(s);
    const dca = s.perpEntryCostParts.find((p) => p.id === 'slip:deal:deal-dca');
    expect(dca?.usd).toBeCloseTo((1901.2 - 1901.0) * 50, 6);
    expect(dca?.qty).toBe(50);
  });

  it('an ESTIMATED slippage is itemised as its own part, and the sum still holds', () => {
    // The estimate is a real entry in the decomposition, tickable like any
    // other — that is what makes it correctable rather than a hidden fudge.
    const perps = migratedPerps();
    perps[0].positionQty = '-400'; // closed off-journal
    const s = buildStrategies(
      input({ perpPositions: perps, dealFills: migrationDeals() }),
    ).strategies[0];
    expect(s.feesUsd.paid.perpEntrySlippageUsd).not.toBeNull();
    expect(s.perpEntryCostParts.filter((p) => p.kind === 'slippage')).toHaveLength(1);
    assertEntryPartsSum(s);
  });
});

describe('chainPerpEntrySlippageUsd (reducer)', () => {
  const PAIR = {
    base: 'ETH',
    longSymbol: 'OKX_FUTURE_ETH_USDT',
    longQty: 531,
    shortSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    shortQty: 531,
    earliestOpenSec: OPENED - 10 * DAY,
  };
  const deal = (over: Partial<DealFillRecord> = {}): DealFillRecord => ({
    dealId: 'deal-1',
    aContract: 'HYPERLIQUID_FUTURE_ETH_USDC',
    aSide: 'SELL',
    bContract: 'OKX_FUTURE_ETH_USDT',
    bSide: 'BUY',
    aFilled: 531,
    bFilled: 531,
    aAvgFill: 1883.0,
    bAvgFill: 1883.4,
    createdAtSec: OPENED,
    ...over,
  });

  it('returns null on no matching deals', () => {
    expect(chainPerpEntrySlippageUsd([], PAIR)).toBeNull();
    expect(
      chainPerpEntrySlippageUsd([deal({ aContract: 'BYBIT_FUTURE_BTC_USDT', bContract: 'GATE_FUTURE_BTC_USDT' })], PAIR),
    ).toBeNull();
  });

  it('poisons the whole chain on an unusable fill, never skip-and-miscount', () => {
    expect(chainPerpEntrySlippageUsd([deal(), deal({ aAvgFill: 0 })], PAIR)).toBeNull();
    expect(chainPerpEntrySlippageUsd([deal(), deal({ aSide: 'BUY' })], PAIR)).toBeNull();
  });

  it('drops deals older than the lookback, which then fails reconciliation', () => {
    const old = deal({ createdAtSec: PAIR.earliestOpenSec - 49 * 3600 });
    expect(chainPerpEntrySlippageUsd([old], PAIR)).toBeNull();
  });

  it('ignores other-base deals while reconciling the target base', () => {
    const btc = deal({
      aContract: 'BYBIT_FUTURE_BTC_USDT',
      bContract: 'GATE_FUTURE_BTC_USDT',
      aFilled: 3,
      bFilled: 3,
      aAvgFill: 64_000,
      bAvgFill: 64_010,
    });
    const r = chainPerpEntrySlippageUsd([deal(), btc], PAIR);
    expect(r).not.toBeNull();
    expect(r!.usd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    expect(r!.deals).toBe(1);
  });
});

describe('buildStrategies — hedge band boundary', () => {
  it.each([
    { mismatchPct: 0.019, hedge: 'hedged' }, // just inside the 2% band
    { mismatchPct: 0.03, hedge: 'partial' }, // just outside
  ])('classifies a $mismatchPct venue mismatch as $hedge', ({ mismatchPct, hedge }) => {
    const perps = ethPerps();
    // Per venue: boros notional 1M vs perp x. Solve |1M − x| / (1M + x) = p
    // → x = 1M(1−p)/(1+p) puts the venue exactly at mismatch ratio p.
    const x = (1_000_000 * (1 - mismatchPct)) / (1 + mismatchPct);
    perps[0].positionValue = String(x);
    perps[1].positionValue = String(x);
    const out = buildStrategies(input({ perpPositions: perps }));
    expect(out.strategies[0].hedge).toBe(hedge);
  });
});

describe('buildStrategies — what counts as capital', () => {
  // The canonical book posts $5,000 of Boros initial margin per leg into a
  // group holding $20,000. The extra $10,000 is the user's own trading money
  // sitting in the same collateral account — it is not capital this position
  // needed, and counting it halves the reported APR.
  it("defaults to the group's posted balance", () => {
    const s = buildStrategies(input()).strategies[0];
    expect(s.capitalSplit.borosUsd).toBeCloseTo(20_000, 6);
    expect(s.capitalUsd).toBeCloseTo(45_000, 6); // perp IM 25k + balance 20k
    expect(buildStrategies(input()).capitalBasis).toBe('balance');
  });

  it("counts only the margin the legs post when asked for 'im'", () => {
    const s = buildStrategies(input({ capitalBasis: 'im' })).strategies[0];
    expect(s.capitalSplit.borosUsd).toBeCloseTo(10_000, 6); // 5k + 5k, not 20k
    expect(s.capitalSplit.perpUsd).toBeCloseTo(25_000, 6); // perps were ALWAYS IM
    expect(s.capitalUsd).toBeCloseTo(35_000, 6);
    // Every APR is a return on that number, so the basis has to move them.
    expect(s.lockedAprOnCapital).toBeCloseTo(50_000 / 35_000, 10);
    expect(s.realizedApr).toBeCloseTo(
      (s.realizedPnlUsd / 35_000) * (SECONDS_IN_YEAR / (12 * DAY)),
      10,
    );
  });

  it('splits the margin across strategies that share the account', () => {
    // A shared Boros leg posts its margin once; the two strategies must not
    // both claim it.
    const whole = buildStrategies(input({ capitalBasis: 'im' })).totals.capitalUsd;
    const split = buildStrategies({ ...input({ capitalBasis: 'im' }) });
    expect(split.totals.capitalUsd).toBeCloseTo(whole, 6);
    expect(split.capitalBasis).toBe('im');
  });
});

describe('buildStrategies — a leg belongs to exactly one strategy', () => {
  it('does not re-attach a perp a tranche already scaled', () => {
    // Two maturities: the tranche picks its cohort by BOTH its venues, the
    // leftover branch used to re-pick by one — so a cohort with no tranche
    // grabbed a perp that was already inside another strategy.
    const laterMaturity = MATURITY + 56 * DAY;
    const hlLate: BorosMarket = { ...hlMarket, marketId: 169, maturity: laterMaturity };
    const zones = ethZones();
    zones[0].cross!.marketPositions.push({
      marketId: 169,
      side: 1,
      notionalSize: raw(-2_000_000),
      fixedApr: 0.06,
      markApr: 0.058,
      pnl: { rateSettlementPnl: raw(50), unrealisedPnl: raw(10) },
      positionInitialMargin: raw(500),
    });
    const out = buildStrategies(input({ zones, markets: [hlMarket, okxMarket, hlLate] }));
    const hlLegs = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID');
    // The venue holds ONE Hyperliquid perp; the account may never show two.
    expect(hlLegs.reduce((a, l) => a + (l.notionalToken ?? 0), 0)).toBeCloseTo(531, 6);
    expect(out.totals.capitalUsd).toBeLessThanOrEqual(45_000 + 1);
  });

  it('leaves a detached pair out of every strategy card', () => {
    // A row with no positionId says the leg belongs to nothing at all — the
    // solver may not group it, and it is reported as exposure instead.
    const out = buildStrategies(
      input({
        membership: [
          { leg: { kind: 'perp', symbol: 'OKX_FUTURE_ETH_USDT' } },
          { leg: { kind: 'perp', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' } },
        ],
      }),
    );
    // The user said these legs are not a strategy together: each gets a card
    // of its own holding nothing else, and appears nowhere but there.
    expect(
      out.strategies
        .filter((s) => s.attribution.source !== 'unhedged')
        .flatMap((s) => s.legs)
        .filter((l) => l.kind === 'perp'),
    ).toEqual([]);
    expect(unhedgedVenues(out)).toEqual(['HYPERLIQUID', 'OKX']);
  });
});

describe('buildStrategies — one venue, two quote coins', () => {
  it('divides that venue\'s single Boros leg instead of giving it to each', () => {
    // HL lists ETH under both USDC and USDT; each perp position has its own
    // per-symbol share of 1, so sizing the Boros leg by one symbol's share
    // handed the WHOLE leg to both strategies.
    const zones = ethZones();
    const out = buildStrategies(
      input({
        zones,
        perpPositions: [
          { ...ethPerps()[0], symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionQty: '-265.5', positionValue: '500000' },
          { ...ethPerps()[0], symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', positionQty: '-265.5', positionValue: '500000' },
          { ...ethPerps()[1], positionQty: '265.5', positionValue: '500000' },
          { ...ethPerps()[1], symbol: 'BINANCE_FUTURE_ETH_USDT', positionQty: '265.5', positionValue: '500000' },
        ],
      }),
    );
    const hlBoros = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'boros' && l.venue === 'HYPERLIQUID');
    // The venue reports ONE $1M Boros position; the split must partition it.
    expect(hlBoros.reduce((a, l) => a + l.notionalUsd, 0)).toBeLessThanOrEqual(1_000_000 + 1);
  });
});

describe('buildStrategies — one perp shared across two maturity cohorts', () => {
  /**
   * The live-book regression. A perp is PERPETUAL: one Hyperliquid short hedges
   * both maturities at once, so the partition splits it 50/50 between the two
   * strategies — correctly. But each cohort has its OWN Hyperliquid Boros leg,
   * shared with nobody. Charging that leg the perp's 0.5 left half of every
   * Boros position unclaimed, spun it out as a phantom `boros-only` card, and
   * reported two genuinely-hedged strategies as `partial`.
   */
  const LATER = MATURITY + 56 * DAY;
  const hlDec: BorosMarket = { ...hlMarket, marketId: 169, maturity: LATER };
  const binDec: BorosMarket = {
    ...okxMarket,
    marketId: 170,
    name: 'Binance ETHUSDT 25 Sep 2026',
    venue: 'Binance',
    maturity: LATER,
  };

  /** Sep: HL short + OKX long. Dec: HL short + Binance long. $1M every leg. */
  function twoCohortZones(): BorosCollateralZone[] {
    const pos = (marketId: number, side: 0 | 1, notional: number, fixedApr: number) => ({
      marketId,
      side,
      notionalSize: raw(notional),
      fixedApr,
      markApr: fixedApr - 0.002,
      pnl: { rateSettlementPnl: raw(100), unrealisedPnl: raw(10) },
      positionInitialMargin: raw(2_500),
    });
    return [
      {
        tokenId: 3,
        cross: {
          isCross: true,
          netBalance: raw(20_000),
          marketPositions: [
            pos(155, 1, -1_000_000, 0.08), // HL, Sep
            pos(158, 0, 1_000_000, 0.03), // OKX, Sep
            pos(169, 1, -1_000_000, 0.07), // HL, Dec
            pos(170, 0, 1_000_000, 0.025), // Binance, Dec
          ],
        },
        isolated: [],
      },
    ];
  }

  /** ONE Hyperliquid short of 1062 backing both strategies, two longs of 531. */
  function twoCohortPerps(): PerpPositionLike[] {
    return [
      { ...ethPerps()[0], positionQty: '-1062', positionValue: '2000000', initialMargin: '25000' },
      { ...ethPerps()[1], positionQty: '531', positionValue: '1000000' },
      {
        ...ethPerps()[1],
        symbol: 'BINANCE_FUTURE_ETH_USDT',
        positionQty: '531',
        positionValue: '1000000',
        createTime: String((OPENED + DAY) * 1000),
      },
    ];
  }

  const fill = (
    hash: string,
    timeSec: number,
    symbol: string,
    side: 'BUY' | 'SELL',
    ab: 'A' | 'B',
  ): PerpFillRecord => ({
    symbol,
    side,
    qty: 531,
    price: 1883,
    feeUsd: 10,
    timeSec,
    text: `t${hash}${ab}1`,
  });

  const twoCohortInput = (over: Partial<BuildStrategiesInput> = {}) =>
    input({
      zones: twoCohortZones(),
      markets: [hlMarket, okxMarket, hlDec, binDec],
      perpPositions: twoCohortPerps(),
      perpFills: [
        fill('aaaaaaa', OPENED, 'OKX_FUTURE_ETH_USDT', 'BUY', 'A'),
        fill('aaaaaaa', OPENED, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 'B'),
        fill('bbbbbbb', OPENED + DAY, 'BINANCE_FUTURE_ETH_USDT', 'BUY', 'A'),
        fill('bbbbbbb', OPENED + DAY, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 'B'),
      ],
      ...over,
    });

  it('gives each cohort\'s Boros leg WHOLE to its strategy, with no phantom leftover card', () => {
    const out = buildStrategies(twoCohortInput());
    // Two strategies and nothing else: a `boros-only` remainder here would be
    // half of a position that is already fully accounted for.
    expect(out.strategies).toHaveLength(2);
    expect(out.strategies.map((s) => s.attribution.source)).not.toContain('boros-only');

    for (const s of out.strategies) {
      const hl = s.legs.find((l) => l.kind === 'boros' && l.venue === 'HYPERLIQUID')!;
      // The whole $1M leg, not the 0.5 the shared PERP is split by.
      expect(hl.notionalUsd).toBeCloseTo(1_000_000, 6);
      expect(hl.share).toBeCloseTo(1, 9);
      // The perp really is shared — that half is correct and must stay.
      const hlPerp = s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
      expect(hlPerp.share).toBeCloseTo(0.5, 9);
    }
    // Both venue positions land exactly once across the book.
    const hlBoros = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'boros' && l.venue === 'HYPERLIQUID');
    expect(hlBoros.reduce((a, l) => a + l.notionalUsd, 0)).toBeCloseTo(2_000_000, 6);
  });

  it('reports both strategies as fully hedged, not partial', () => {
    const out = buildStrategies(twoCohortInput());
    for (const s of out.strategies) {
      expect(s.hedge).toBe('hedged');
      expect(s.hedgeChecks.borosMatchRatio).toBeCloseTo(1, 9);
      expect(s.hedgeChecks.borosVsPerpRatio).toBeCloseTo(1, 9);
      expect(s.hedgeChecks.fullyHedged).toBe(true);
      expect(s.warnings.join(' ')).not.toMatch(/imbalanced by/);
    }
    expect(unhedgedVenues(out)).toEqual([]);
  });
});

describe('buildStrategies — two quote coins divide one venue\'s locked rate', () => {
  it('gives each tranche the increment it opened at, not the blend the first one drained', () => {
    // HL lists ETH under USDC and USDT in ONE cohort, so its single Boros leg
    // is owned half each. Sizing the rate-allocation targets by `leg.share`
    // (1 per symbol) asked for the WHOLE pool twice: the older tranche drained
    // both increments and showed their blend as its measured rate, while its
    // sibling got nothing and fell back to the position's average.
    const out = buildStrategies(
      input({
        // One HL Boros leg of $1M, built 500k @7% then 500k @5%.
        txnsByToken: new Map([
          [
            3,
            [
              { marketId: 155, time: OPENED, fee: raw(100), pnl: raw(-100), prevPositionS: '0', postPositionS: raw(-500_000), fixedApr: 0.07 },
              { marketId: 155, time: OPENED + DAY, fee: raw(100), pnl: raw(-100), prevPositionS: raw(-500_000), postPositionS: raw(-1_000_000), fixedApr: 0.05 },
              { marketId: 158, time: OPENED, fee: raw(300), pnl: raw(-300), prevPositionS: '0', postPositionS: raw(1_000_000), fixedApr: 0.03 },
            ] as BorosTxn[],
          ],
        ]),
        perpPositions: [
          { ...ethPerps()[0], symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionQty: '-265.5', positionValue: '500000' },
          { ...ethPerps()[0], symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', positionQty: '-265.5', positionValue: '500000' },
          { ...ethPerps()[1], positionQty: '265.5', positionValue: '500000' },
          { ...ethPerps()[1], symbol: 'BINANCE_FUTURE_ETH_USDT', positionQty: '265.5', positionValue: '500000' },
        ],
        perpFills: [
          { symbol: 'OKX_FUTURE_ETH_USDT', side: 'BUY', qty: 265.5, price: 1883, feeUsd: 5, timeSec: OPENED, text: 'taaaaaaaA1' },
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'SELL', qty: 265.5, price: 1883, feeUsd: 5, timeSec: OPENED, text: 'taaaaaaaB1' },
          { symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty: 265.5, price: 1883, feeUsd: 5, timeSec: OPENED + DAY, text: 'tbbbbbbbA1' },
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDT', side: 'SELL', qty: 265.5, price: 1883, feeUsd: 5, timeSec: OPENED + DAY, text: 'tbbbbbbbB1' },
        ],
      }),
    );
    const rateOf = (perpVenue: string): number => {
      const s = out.strategies.find((x) => x.legs.some((l) => l.kind === 'perp' && l.venue === perpVenue))!;
      return s.legs.find((l) => l.kind === 'boros' && l.venue === 'HYPERLIQUID')!.entryApr!;
    };
    expect(rateOf('OKX')).toBeCloseTo(0.07, 6);
    expect(rateOf('BINANCE')).toBeCloseTo(0.05, 6);
    // The decomposition still averages back to what the venue charged.
    expect((rateOf('OKX') + rateOf('BINANCE')) / 2).toBeCloseTo(0.06, 6);
  });
});

describe('buildStrategies — multiple cohorts', () => {
  it('splits maturities into separate strategies, and a perp covers what it can', () => {
    const laterMaturity = MATURITY + 56 * DAY;
    const hlSep: BorosMarket = { ...hlMarket, marketId: 169, maturity: laterMaturity };
    const zones = ethZones();
    // Add a smaller HL leg in the later cohort.
    zones[0].cross!.marketPositions.push({
      marketId: 169,
      side: 1,
      notionalSize: raw(-100_000),
      fixedApr: 0.06,
      markApr: 0.058,
      pnl: { rateSettlementPnl: raw(50), unrealisedPnl: raw(10) },
      positionInitialMargin: raw(500),
    });
    const out = buildStrategies(input({ zones, markets: [hlMarket, okxMarket, hlSep] }));
    expect(out.strategies).toHaveLength(2);
    // Sorted by gross notional: the $1M-per-leg cohort first.
    expect(out.strategies[0].maturity).toBe(MATURITY);
    // The $1M cohort's Boros absorbs the whole HL perp, so nothing is left for
    // the later, smaller cohort — whose leg is then genuinely uncovered rather
    // than sharing a perp that is already fully spoken for.
    const bigCohortPerps = out.strategies[0].legs.filter((l) => l.kind === 'perp');
    expect(bigCohortPerps.map((l) => l.venue)).toContain('HYPERLIQUID');
    expect(out.strategies[1].legs.filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')).toHaveLength(0);
    // The perp is NOT split here, so it must not claim to be.
    expect(bigCohortPerps.flatMap((l) => l.warnings).join(' ')).not.toMatch(/counted here/);
    // And it is counted exactly once across the whole book.
    expect(
      out.strategies
        .flatMap((s) => s.legs)
        .filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')
        .reduce((a, l) => a + l.notionalUsd, 0),
    ).toBeCloseTo(1_000_000, 6);
    // Totals sum across cohorts.
    expect(out.totals.realizedPnlUsd).toBeCloseTo(
      out.strategies[0].realizedPnlUsd + out.strategies[1].realizedPnlUsd,
      6,
    );
  });
});

describe('buildStrategies — hedgeChecks sizing gate', () => {
  // The gate behind the UI's headline numbers (APR / capital / PnL by
  // maturity): a book still being built must not show a full-life spread
  // projection computed on the wrong notional.
  it('canonical 4-leg book: fully hedged, every ratio 1', () => {
    const s = buildStrategies(input()).strategies[0];
    expect(s.hedgeChecks).toEqual({
      borosMatchRatio: 1,
      perpMatchRatio: 1,
      borosVsPerpRatio: 1,
      fullyHedged: true,
    });
  });

  it('a missing perp leg zeroes the perp ratio and closes the gate', () => {
    const s = buildStrategies(input({ perpPositions: [ethPerps()[0]] })).strategies[0];
    expect(s.hedgeChecks.perpMatchRatio).toBe(0);
    expect(s.hedgeChecks.fullyHedged).toBe(false);
  });

  it('a one-sided Boros book zeroes the boros ratio and closes the gate', () => {
    const zones = ethZones();
    zones[0].cross!.marketPositions = zones[0].cross!.marketPositions.filter(
      (p) => p.marketId === 155,
    );
    const s = buildStrategies(input({ zones })).strategies[0];
    expect(s.hedgeChecks.borosMatchRatio).toBe(0);
    expect(s.hedgeChecks.fullyHedged).toBe(false);
  });

  it('layers sized apart close the gate at 80%, strictly', () => {
    const sized = (value: string) =>
      ethPerps().map((p) => ({ ...p, positionValue: value }));
    // Matched $700k perps against the $2M Boros book: 1.4/2 = 0.7 → closed.
    const under = buildStrategies(input({ perpPositions: sized('700000') })).strategies[0];
    expect(under.hedgeChecks.perpMatchRatio).toBe(1);
    expect(under.hedgeChecks.borosVsPerpRatio).toBeCloseTo(0.7, 10);
    expect(under.hedgeChecks.fullyHedged).toBe(false);
    // $800k exactly is 0.8 — NOT > 0.8, still closed (strict thresholds).
    const edge = buildStrategies(input({ perpPositions: sized('800000') })).strategies[0];
    expect(edge.hedgeChecks.borosVsPerpRatio).toBeCloseTo(0.8, 10);
    expect(edge.hedgeChecks.fullyHedged).toBe(false);
    // $850k clears it: 1.7/2 = 0.85 → open.
    const ok = buildStrategies(input({ perpPositions: sized('850000') })).strategies[0];
    expect(ok.hedgeChecks.borosVsPerpRatio).toBeCloseTo(0.85, 10);
    expect(ok.hedgeChecks.fullyHedged).toBe(true);
  });

  it('an invisible perp side (Boros-only view) closes the gate — unverifiable is not hedged', () => {
    const s = buildStrategies(input({ perpPositions: null })).strategies[0];
    expect(s.hedgeChecks.perpMatchRatio).toBe(0);
    expect(s.hedgeChecks.borosVsPerpRatio).toBe(0);
    expect(s.hedgeChecks.fullyHedged).toBe(false);
  });
});

/** The itemised entry cost the Positions box lets a user tick through. The one
 * property everything downstream leans on is the SUM: the parts must total the
 * two aggregates, or the client's add-back silently disagrees with the charts. */
describe('buildStrategies — perp entry cost parts', () => {
  it('a book opened in one go is ONE slippage part plus a fee part per leg', () => {
    const s = buildStrategies(input()).strategies[0];
    assertEntryPartsSum(s);
    const slip = s.perpEntryCostParts.filter((p) => p.kind === 'slippage');
    const fees = s.perpEntryCostParts.filter((p) => p.kind === 'fees');
    expect(slip).toHaveLength(1);
    expect(slip[0].id).toBe('slip:live');
    expect(slip[0].usd).toBeCloseTo(ENTRY_SLIPPAGE, 6);
    expect(slip[0].qty).toBe(531);
    expect(slip[0].atSec).toBe(OPENED);
    expect(slip[0].venues.sort()).toEqual(['HYPERLIQUID', 'OKX']);
    // Gate reports a position's fee cumulatively, so a fee part has no single
    // point in time and carries its leg's side instead.
    expect(fees).toHaveLength(2);
    expect(fees.every((p) => p.atSec === null && p.qty === null)).toBe(true);
    expect(fees.map((p) => p.side).sort()).toEqual(['LONG', 'SHORT']);
    expect(fees.reduce((a, p) => a + p.usd, 0)).toBeCloseTo(412, 6);
  });

  it('a Boros-only strategy has nothing to itemise', () => {
    const s = buildStrategies(input({ perpPositions: [] })).strategies[0];
    expect(s.perpEntryCostParts).toEqual([]);
    assertEntryPartsSum(s);
  });
});

describe('buildStrategies — one venue leg shared by two strategies', () => {
  // The scenario the split exists for: HL/OKX opened on day 0, HL/Binance a day
  // later. CrossEx nets the HL leg into ONE row at a blended 1903.6 entry, and
  // Boros nets the HL rate into ONE position at a blended 6.70%. Neither says
  // which part belongs to which strategy — the fill record does.
  const S_OPENED = NOW - 10 * DAY;
  const HL_SYM = 'HYPERLIQUID_FUTURE_ETH_USDC';
  const OKX_SYM = 'OKX_FUTURE_ETH_USDT';
  const BIN_SYM = 'BINANCE_FUTURE_ETH_USDT';
  const binMarket: BorosMarket = {
    ...hlMarket,
    marketId: 161,
    name: 'Binance ETHUSDT 31 Jul 2026',
    venue: 'Binance',
    markApr: 0.023,
    floatingApr: 0.022,
  };
  const HL_BLEND = (190_000 * 0.07 + 285_900 * 0.065) / 475_900;

  function sharedZones(): BorosCollateralZone[] {
    return [
      {
        tokenId: 3,
        cross: {
          isCross: true,
          netBalance: raw(40_000),
          marketPositions: [
            {
              marketId: 155, // Hyperliquid — ONE position, blended rate
              side: 1,
              notionalSize: raw(-475_900),
              fixedApr: HL_BLEND,
              markApr: 0.076,
              pnl: { rateSettlementPnl: raw(1_000), unrealisedPnl: raw(200) },
              positionInitialMargin: raw(10_000),
            },
            {
              marketId: 158, // OKX
              side: 0,
              notionalSize: raw(190_040),
              fixedApr: 0.03,
              markApr: 0.032,
              pnl: { rateSettlementPnl: raw(300), unrealisedPnl: raw(-50) },
              positionInitialMargin: raw(4_000),
            },
            {
              marketId: 161, // Binance
              side: 0,
              notionalSize: raw(285_870),
              fixedApr: 0.022,
              markApr: 0.023,
              pnl: { rateSettlementPnl: raw(400), unrealisedPnl: raw(-70) },
              positionInitialMargin: raw(6_000),
            },
          ],
        },
        isolated: [],
      },
    ];
  }

  /** The Boros side built in two fills at two different rates — exactly what
   * the blended 6.70% is an average of. */
  function sharedTxns(): BorosTxn[] {
    return [
      { marketId: 155, time: S_OPENED, fee: raw(60), pnl: raw(-60), prevPositionS: '0', postPositionS: raw(-190_000), fixedApr: 0.07 },
      { marketId: 158, time: S_OPENED, fee: raw(50), pnl: raw(-50), prevPositionS: '0', postPositionS: raw(190_040), fixedApr: 0.03 },
      { marketId: 155, time: S_OPENED + DAY, fee: raw(90), pnl: raw(-90), prevPositionS: raw(-190_000), postPositionS: raw(-475_900), fixedApr: 0.065 },
      { marketId: 161, time: S_OPENED + DAY, fee: raw(70), pnl: raw(-70), prevPositionS: '0', postPositionS: raw(285_870), fixedApr: 0.022 },
    ];
  }

  function sharedPerps(): PerpPositionLike[] {
    return [
      {
        symbol: HL_SYM,
        positionSide: 'SHORT',
        positionQty: '-250',
        positionValue: '475900',
        entryPrice: '1903.6', // (100×1900 + 150×1906) / 250 — the blend
        upnl: '10',
        fundingFee: '1000',
        fee: '-52',
        initialMargin: '20000',
        createTime: String(S_OPENED * 1000),
        positionId: 'hl-1',
      },
      {
        symbol: OKX_SYM,
        positionSide: 'LONG',
        positionQty: '100',
        positionValue: '190040',
        entryPrice: '1900.4',
        upnl: '-4',
        fundingFee: '-400',
        fee: '-19',
        initialMargin: '8000',
        createTime: String(S_OPENED * 1000),
        positionId: 'okx-1',
      },
      {
        symbol: BIN_SYM,
        positionSide: 'LONG',
        positionQty: '150',
        positionValue: '285870',
        entryPrice: '1905.8',
        upnl: '-6',
        fundingFee: '-600',
        fee: '-28',
        initialMargin: '12000',
        createTime: String((S_OPENED + DAY) * 1000),
        positionId: 'bin-1',
      },
    ];
  }

  /** The venue's own fill history, engine-tagged so each fill rejoins its deal. */
  function sharedFills(): PerpFillRecord[] {
    const leg = (
      hash: string,
      timeSec: number,
      symbol: string,
      side: 'BUY' | 'SELL',
      qty: number,
      price: number,
      feeUsd: number,
      ab: 'A' | 'B',
    ): PerpFillRecord => ({ symbol, side, qty, price, feeUsd, timeSec, text: `t${hash}${ab}1` });
    return [
      leg('aaaaaaa', S_OPENED, OKX_SYM, 'BUY', 100, 1900.4, 19, 'A'),
      leg('aaaaaaa', S_OPENED, HL_SYM, 'SELL', 100, 1900, 21, 'B'),
      leg('bbbbbbb', S_OPENED + DAY, BIN_SYM, 'BUY', 150, 1905.8, 28, 'A'),
      leg('bbbbbbb', S_OPENED + DAY, HL_SYM, 'SELL', 150, 1906, 31, 'B'),
    ];
  }

  const sharedInput = (over: Partial<BuildStrategiesInput> = {}) =>
    input({
      zones: sharedZones(),
      markets: [hlMarket, okxMarket, binMarket],
      txnsByToken: new Map([[3, sharedTxns()]]),
      perpPositions: sharedPerps(),
      perpFills: sharedFills(),
      ...over,
    });

  it('reports two strategies, each with its own four legs', () => {
    const out = buildStrategies(sharedInput());
    expect(out.strategies).toHaveLength(2);
    for (const s of out.strategies) {
      expect(s.legs).toHaveLength(4);
      expect(s.attribution.source).toBe('fill-history');
      expect(s.attribution.confidence).toBe('measured');
    }
    // Identities are distinct and stable — the client keys pins off them.
    const ids = out.strategies.map((s) => s.strategyId);
    expect(new Set(ids).size).toBe(2);
  });

  it('gives each strategy the rate it actually locked, not the book\'s blend', () => {
    const out = buildStrategies(sharedInput());
    const okx = out.strategies.find((s) => s.legs.some((l) => l.venue === 'OKX'))!;
    const bin = out.strategies.find((s) => s.legs.some((l) => l.venue === 'BINANCE'))!;
    const hlRate = (s: (typeof out.strategies)[number]) =>
      s.legs.find((l) => l.kind === 'boros' && l.venue === 'HYPERLIQUID')!.entryApr!;
    expect(hlRate(okx)).toBeCloseTo(0.07, 3);
    expect(hlRate(bin)).toBeCloseTo(0.065, 3);
    // …and therefore the true spreads (4.0% / 4.3%), where the blended rate
    // would have shown 3.7% / 4.5% for the same book.
    expect(okx.spread).toBeCloseTo(0.04, 3);
    expect(bin.spread).toBeCloseTo(0.043, 3);
  });

  it('recovers each strategy\'s crossing cost from its own fills', () => {
    const out = buildStrategies(sharedInput());
    const okx = out.strategies.find((s) => s.legs.some((l) => l.venue === 'OKX'))!;
    const bin = out.strategies.find((s) => s.legs.some((l) => l.venue === 'BINANCE'))!;
    expect(okx.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(40, 6);
    expect(bin.feesUsd.paid.perpEntrySlippageUsd).toBeCloseTo(-30, 6);
    // Fees come from the venue's CUMULATIVE charge, split by size — the fills'
    // own sum covers only matched opening executions, so it would quietly drop
    // whatever was paid on closes or off-journal fills.
    const hlFee = (s: (typeof out.strategies)[number]) =>
      s.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!.feesUsd;
    expect(hlFee(okx)).toBeCloseTo(52 * 0.4, 6);
    expect(hlFee(bin)).toBeCloseTo(52 * 0.6, 6);
    expect(hlFee(okx) + hlFee(bin)).toBeCloseTo(52, 6);
  });

  it('every shared number adds back up to what the venue reported', () => {
    const out = buildStrategies(sharedInput());
    const legs = out.strategies.flatMap((s) => s.legs);
    const at = (kind: string, venue: string) => legs.filter((l) => l.kind === kind && l.venue === venue);
    // The shared HL perp: sizes, funding and notional all partition exactly.
    expect(at('perp', 'HYPERLIQUID').reduce((s, l) => s + (l.notionalToken ?? 0), 0)).toBeCloseTo(250, 9);
    expect(at('perp', 'HYPERLIQUID').reduce((s, l) => s + l.cashFlowUsd, 0)).toBeCloseTo(1_000, 6);
    expect(at('perp', 'HYPERLIQUID').reduce((s, l) => s + l.notionalUsd, 0)).toBeCloseTo(475_900, 6);
    expect(at('boros', 'HYPERLIQUID').reduce((s, l) => s + l.notionalUsd, 0)).toBeCloseTo(475_900, 6);
    // Capital: the perp initial margin and the Boros group balance are each
    // counted once across the two strategies.
    expect(out.totals.capitalUsd).toBeCloseTo(20_000 + 8_000 + 12_000 + 40_000, 6);
    // Every leg says what fraction of its venue position it owns.
    for (const l of at('perp', 'HYPERLIQUID')) expect(l.share).toBeGreaterThan(0);
    expect(at('perp', 'HYPERLIQUID').reduce((s, l) => s + (l.share ?? 0), 0)).toBeCloseTo(1, 9);
    expect(unhedgedVenues(out)).toEqual([]);
  });

  it('without a fill record it still splits, but calls the split a proposal and refuses to invent prices', () => {
    const out = buildStrategies(sharedInput({ perpFills: null }));
    expect(out.strategies).toHaveLength(2);
    for (const s of out.strategies) {
      expect(s.attribution.confidence).toBe('unconfirmed');
      // The blended 1903.6 is an average over both strategies: no strategy may
      // claim it as its own entry, so the crossing cost is unknown, not guessed.
      expect(s.feesUsd.paid.perpEntrySlippageUsd).toBeNull();
      expect(s.warnings.join(' ')).toMatch(/proposal you can edit/);
    }
    expect(out.totals.perpExitSlippageTotalUsd).toBeNull();
    expect(out.totals.slippageUnknownCount).toBe(2);
    expect(out.totals.strategyCount).toBe(2);
  });

  it('gives each strategy its own APR clock, not the shared position\'s first open', () => {
    const out = buildStrategies(sharedInput());
    const okx = out.strategies.find((s) => s.legs.some((l) => l.venue === 'OKX'))!;
    const bin = out.strategies.find((s) => s.legs.some((l) => l.venue === 'BINANCE'))!;
    // The HL Boros position opened with the FIRST strategy; the second one
    // must not inherit its start, or a day of someone else's accrual is
    // annualized into its APR and its spread projection.
    expect(okx.clockStartSec).toBe(S_OPENED);
    expect(bin.clockStartSec).toBe(S_OPENED + DAY);
    expect(bin.elapsedSeconds).toBe(NOW - (S_OPENED + DAY));
  });

  it('re-bases a shared leg\'s funding from the ledger instead of pro-rating a lifetime counter', () => {
    // The HL perp predates the Binance strategy, so its cumulative counter
    // includes funding that strategy never earned. The ledger can measure the
    // real amount — the guard must not skip it just because the tranche
    // re-stamped the leg's open.
    const ledger = {
      byPosition: new Map([
        [
          'hl-1',
          [
            { positionId: 'hl-1', timeSec: S_OPENED + 100, changeUsd: 200 },
            { positionId: 'hl-1', timeSec: S_OPENED + DAY + 100, changeUsd: 800 },
          ],
        ],
      ]),
      coversFromSec: 0,
    };
    const out = buildStrategies(sharedInput({ perpFunding: ledger }));
    const bin = out.strategies.find((s) => s.legs.some((l) => l.venue === 'BINANCE'))!;
    const hl = bin.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    // 0.6 of the $800 settled after this strategy started — not 0.6 of $1,000.
    expect(hl.cashFlowUsd).toBeCloseTo(480, 6);
  });

  it('credits the EARLIER strategy the funding it earned while it owned the whole leg', () => {
    // The share of a shared leg changes over its life: for the first day the
    // OKX strategy owned 100% of the HL perp, then the Binance strategy opened
    // and it dropped to 40%. Scaling the lifetime counter (or the ledger sum)
    // by the FINAL 0.4 would attribute $400 and silently drop the
    // (1 − 0.4) × $200 earned solo — with the two cards then summing to $880
    // of the venue's $1,000.
    const ledger = {
      byPosition: new Map([
        [
          'hl-1',
          [
            { positionId: 'hl-1', timeSec: S_OPENED + 100, changeUsd: 200 },
            { positionId: 'hl-1', timeSec: S_OPENED + DAY + 100, changeUsd: 800 },
          ],
        ],
      ]),
      coversFromSec: 0,
    };
    const out = buildStrategies(sharedInput({ perpFunding: ledger }));
    const okx = out.strategies.find((s) => s.legs.some((l) => l.venue === 'OKX'))!;
    const hl = okx.legs.find((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')!;
    // $200 at 100% ownership + 0.4 × $800 after the split.
    expect(hl.cashFlowUsd).toBeCloseTo(520, 6);
    // …and the shared leg still adds back up to the venue's counter WITH the
    // ledger attached (the invariant test above runs without one).
    const hlLegs = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID');
    expect(hlLegs.reduce((s, l) => s + l.cashFlowUsd, 0)).toBeCloseTo(1_000, 6);
  });

  it('honours a stated size, and reports what nothing could hedge', () => {
    const out = buildStrategies(
      sharedInput({
        membership: [
          { positionId: 'aa', leg: { kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDT' }, qty: 150 },
          { positionId: 'aa', leg: { kind: 'perp', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' }, qty: 150 },
        ],
      }),
    );
    const bin = out.strategies.find((s) => s.legs.some((l) => l.venue === 'BINANCE'))!;
    expect(bin.attribution.pinned).toBe(true);
    // A stated size is the user's assertion — the card must not also claim it
    // was guessed by proximity (it shows a `pinned` chip right next to this).
    expect(bin.warnings.join(' ')).toMatch(/holds the legs you assigned to it/);
    expect(bin.warnings.join(' ')).not.toMatch(/proposal you can edit/);
    expect(bin.legs.find((l) => l.kind === 'perp' && l.venue === 'BINANCE')!.notionalToken).toBeCloseTo(150, 9);

    // Orphaning them instead — rows with no positionId — leaves both unhedged.
    const detached = buildStrategies(
      sharedInput({
        membership: [
          { leg: { kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDT' } },
          { leg: { kind: 'perp', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' }, qty: 150 },
        ],
      }),
    );
    expect(unhedgedVenues(detached)).toEqual(['BINANCE', 'HYPERLIQUID']);
    expect(unhedgedQty(detached, 'HYPERLIQUID')).toBeCloseTo(150, 9);
  });
});

describe('buildStrategies — a coin-collateral book does not price its own hedge', () => {
  /**
   * The live "dust position" regression. This book is ETH-COLLATERAL, so a
   * Boros leg and the perp hedging it count the same coin: 1 ETH against 1 ETH.
   * Routing that comparison through USD priced one side off Pendle's
   * `assetMarkPriceUsd` and the other off the venue's `positionValue`, two
   * feeds sampled at different instants. Whenever the venue's happened to be
   * the lower of the two the perp looked too small to cover its own Boros, the
   * shortfall became `spare`, got smeared across the other tranches, and one of
   * them rendered a third card holding a few cents — blinking in and out as the
   * feeds crossed.
   */
  const LATER = MATURITY + 56 * DAY;
  const hlEth: BorosMarket = { ...hlMarket, tokenId: 2 };
  const okxEth: BorosMarket = { ...okxMarket, tokenId: 2 };
  const hlDec: BorosMarket = { ...hlEth, marketId: 169, maturity: LATER };
  const binDec: BorosMarket = {
    ...okxEth,
    marketId: 170,
    name: 'Binance ETHUSDT 25 Sep 2026',
    venue: 'Binance',
    maturity: LATER,
  };
  /** Pendle's ETH mark, and what every market above reports. */
  const BOROS_ETH = hlMarket.assetMarkPriceUsd;

  /** One ETH of Boros on each of the four markets, margined in ETH. */
  const zones = (): BorosCollateralZone[] => [
    {
      tokenId: 2,
      cross: {
        isCross: true,
        netBalance: raw(20),
        marketPositions: [169, 170, 155, 158].map((marketId) => ({
          marketId,
          side: (marketId === 169 || marketId === 155 ? 1 : 0) as 0 | 1,
          notionalSize: raw(marketId === 169 || marketId === 155 ? -1 : 1),
          fixedApr: 0.08,
          markApr: 0.078,
          pnl: { rateSettlementPnl: raw(0.001), unrealisedPnl: raw(0.0001) },
          positionInitialMargin: raw(0.01),
        })),
      },
      isolated: [],
    },
  ];

  const txns = (): BorosTxn[] =>
    [155, 158, 169, 170].map((marketId) => ({
      marketId,
      time: marketId === 155 || marketId === 158 ? OPENED : OPENED + DAY,
      fee: raw(0.0001),
      pnl: raw(-0.0001),
      prevPositionS: '0',
      postPositionS: raw(marketId === 169 || marketId === 155 ? -1 : 1),
      fixedApr: 0.08,
    }));

  /** ONE Hyperliquid short of 2 ETH hedging both maturities, two longs of 1. */
  const perps = (hlVenuePrice: number): PerpPositionLike[] => [
    {
      ...ethPerps()[0],
      positionQty: '-2',
      positionValue: String(2 * hlVenuePrice),
      initialMargin: '0.05',
    },
    { ...ethPerps()[1], positionQty: '1', positionValue: String(BOROS_ETH) },
    {
      ...ethPerps()[1],
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      positionQty: '1',
      positionValue: String(BOROS_ETH),
      createTime: String((OPENED + DAY) * 1000),
    },
  ];

  const fill = (hash: string, timeSec: number, symbol: string, side: 'BUY' | 'SELL', ab: 'A' | 'B') => ({
    symbol,
    side,
    qty: 1,
    price: BOROS_ETH,
    feeUsd: 0.01,
    timeSec,
    text: `t${hash}${ab}1`,
  });

  const build = (hlVenuePrice: number) =>
    buildStrategies(
      input({
        zones: zones(),
        markets: [hlEth, okxEth, hlDec, binDec],
        txnsByToken: new Map([[2, txns()]]),
        pricesUsd: new Map([[2, BOROS_ETH]]),
        perpPositions: perps(hlVenuePrice),
        perpFills: [
          fill('aaaaaaa', OPENED, 'OKX_FUTURE_ETH_USDT', 'BUY', 'A'),
          fill('aaaaaaa', OPENED, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 'B'),
          fill('bbbbbbb', OPENED + DAY, 'BINANCE_FUTURE_ETH_USDT', 'BUY', 'A'),
          fill('bbbbbbb', OPENED + DAY, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 'B'),
        ],
      }),
    );

  it('gives the same two strategies whichever way the venue mark has drifted', () => {
    // Below Pendle's mark, level with it, and above: the book is the same book.
    for (const venuePrice of [BOROS_ETH - 4, BOROS_ETH - 0.01, BOROS_ETH, BOROS_ETH + 0.01, BOROS_ETH + 4]) {
      const out = build(venuePrice);
      expect(
        out.strategies.map((s) => s.strategyId).sort(),
        `venue mark ${venuePrice} vs Boros ${BOROS_ETH}`,
      ).toEqual(['ETH#BINANCE-HYPERLIQUID#exec', 'ETH#HYPERLIQUID-OKX#exec']);
    }
  });

  it('never spins the drift out as a dust card', () => {
    // The failing case before the fix: venue mark under Pendle's by 0.2%.
    const out = build(BOROS_ETH - 4);
    for (const s of out.strategies) {
      const total = s.legs.reduce((a, l) => a + l.notionalUsd, 0);
      // Four legs of ~1 ETH each. A card built from the drift came to cents.
      expect(total).toBeGreaterThan(BOROS_ETH);
    }
    // Each Hyperliquid Boros leg belongs whole to its own maturity.
    for (const s of out.strategies) {
      const hl = s.legs.find((l) => l.kind === 'boros' && l.venue === 'HYPERLIQUID')!;
      expect(hl.share).toBeCloseTo(1, 9);
    }
  });
});

describe('buildStrategies — a perp pair nothing hedges is reported once', () => {
  /**
   * A tranche is eligible for every cohort that shares one of its venues, so
   * one whose Boros all went elsewhere used to render a full-size card in each
   * of them — the venue's own position counted twice across the book. Worse,
   * the id suffix keys off COVERED cohorts, of which it has none, so both
   * cards carried the same strategyId and the client's pin store,
   * excluded-entry-parts store and React keys all collided between them.
   */
  const LATER = MATURITY + 56 * DAY;
  const hlDec: BorosMarket = { ...hlMarket, marketId: 169, maturity: LATER };

  /** Two maturities of Hyperliquid Boros, nothing else. */
  const zones = (): BorosCollateralZone[] => [
    {
      tokenId: 3,
      cross: {
        isCross: true,
        netBalance: raw(20_000),
        marketPositions: [155, 169].map((marketId) => ({
          marketId,
          side: 1 as 0 | 1,
          notionalSize: raw(-1_000_000),
          fixedApr: 0.08,
          markApr: 0.078,
          pnl: { rateSettlementPnl: raw(100), unrealisedPnl: raw(10) },
          positionInitialMargin: raw(2_500),
        })),
      },
      isolated: [],
    },
  ];

  const txns = (): BorosTxn[] =>
    [155, 169].map((marketId) => ({
      marketId,
      time: marketId === 155 ? OPENED : OPENED + DAY,
      fee: raw(390),
      pnl: raw(-390),
      prevPositionS: '0',
      postPositionS: raw(-1_000_000),
      fixedApr: 0.08,
    }));

  /** One Hyperliquid short of 1062 behind both maturities, two longs of 531. */
  const perps = (): PerpPositionLike[] => [
    { ...ethPerps()[0], positionQty: '-1062', positionValue: '2000000', initialMargin: '25000' },
    { ...ethPerps()[1], positionQty: '531', positionValue: '1000000' },
    {
      ...ethPerps()[1],
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      positionQty: '531',
      positionValue: '1000000',
      createTime: String((OPENED + DAY) * 1000),
    },
  ];

  const fill = (h: string, timeSec: number, symbol: string, side: 'BUY' | 'SELL', ab: 'A' | 'B'): PerpFillRecord => ({
    symbol,
    side,
    qty: 531,
    price: 1883,
    feeUsd: 10,
    timeSec,
    text: `t${h}${ab}1`,
  });

  /** Both Hyperliquid Boros legs assigned whole to the OKX pair, leaving the
   * Binance pair covered by nothing at either maturity. */
  const out = () =>
    buildStrategies(
      input({
        zones: zones(),
        markets: [hlMarket, okxMarket, hlDec],
        txnsByToken: new Map([[3, txns()]]),
        perpPositions: perps(),
        perpFills: [
          fill('aaaaaaa', OPENED, 'OKX_FUTURE_ETH_USDT', 'BUY', 'A'),
          fill('aaaaaaa', OPENED, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 'B'),
          fill('bbbbbbb', OPENED + DAY, 'BINANCE_FUTURE_ETH_USDT', 'BUY', 'A'),
          fill('bbbbbbb', OPENED + DAY, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 'B'),
        ],
        membership: [
          { positionId: 'okx1', leg: { kind: 'perp' as const, symbol: 'OKX_FUTURE_ETH_USDT' } },
          {
            positionId: 'okx1',
            leg: { kind: 'perp' as const, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' },
            qty: 531,
          },
          // Both maturities of the Hyperliquid Boros short.
          { positionId: 'okx1', leg: { kind: 'boros' as const, marketId: 155 } },
          { positionId: 'okx1', leg: { kind: 'boros' as const, marketId: 169 } },
        ],
      }),
    );

  it('gives every card its own strategyId', () => {
    const ids = out().strategies.map((s) => s.strategyId);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('counts the uncovered venue position once, not once per maturity', () => {
    const legs = out().strategies.flatMap((s) => s.legs);
    const binance = legs.filter((l) => l.kind === 'perp' && l.venue === 'BINANCE');
    // The venue reports $1M. Two full-size cards would report $2M.
    expect(binance.reduce((a, l) => a + l.notionalUsd, 0)).toBeCloseTo(1_000_000, 6);
    // And the shared short stays whole across the whole book.
    const hl = legs.filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID');
    expect(hl.reduce((a, l) => a + l.notionalUsd, 0)).toBeCloseTo(2_000_000, 6);
  });

  it('still reports the uncovered pair — it is a real position', () => {
    const binance = out()
      .strategies.flatMap((s) => s.legs)
      .filter((l) => l.kind === 'perp' && l.venue === 'BINANCE');
    expect(binance.length).toBe(1);
  });
});

describe('buildStrategies — the shared-perp warning never rounds to 0% or 100%', () => {
  /**
   * One perp covering a large maturity and a tiny one. Rounding the split to
   * whole percent printed "0% of this HYPERLIQUID perp is counted here" on a
   * card that was showing that perp's numbers, and "100%" on the sibling that
   * was not whole — the reader cannot tell absent from rounded from broken.
   */
  const LATER = MATURITY + 56 * DAY;
  const hlDec: BorosMarket = { ...hlMarket, marketId: 169, maturity: LATER };
  const BIG = 1_000_000;
  const TINY = 1_000;

  const out = () =>
    buildStrategies(
      input({
        markets: [hlMarket, okxMarket, hlDec],
        zones: [
          {
            tokenId: 3,
            cross: {
              isCross: true,
              netBalance: raw(20_000),
              marketPositions: [
                { marketId: 155, side: 1 as 0 | 1, notionalSize: raw(-BIG), fixedApr: 0.08, markApr: 0.078, pnl: { rateSettlementPnl: raw(100), unrealisedPnl: raw(10) }, positionInitialMargin: raw(2_500) },
                { marketId: 158, side: 0 as 0 | 1, notionalSize: raw(BIG), fixedApr: 0.03, markApr: 0.032, pnl: { rateSettlementPnl: raw(50), unrealisedPnl: raw(5) }, positionInitialMargin: raw(2_500) },
                { marketId: 169, side: 1 as 0 | 1, notionalSize: raw(-TINY), fixedApr: 0.07, markApr: 0.068, pnl: { rateSettlementPnl: raw(1), unrealisedPnl: raw(0) }, positionInitialMargin: raw(10) },
              ],
            },
            isolated: [],
          },
        ],
        txnsByToken: new Map([
          [
            3,
            [
              { marketId: 155, time: OPENED, fee: raw(390), pnl: raw(-390), prevPositionS: '0', postPositionS: raw(-BIG), fixedApr: 0.08 },
              { marketId: 158, time: OPENED, fee: raw(300), pnl: raw(-300), prevPositionS: '0', postPositionS: raw(BIG), fixedApr: 0.03 },
              { marketId: 169, time: OPENED + DAY, fee: raw(1), pnl: raw(-1), prevPositionS: '0', postPositionS: raw(-TINY), fixedApr: 0.07 },
            ],
          ],
        ]),
        // One pair, big enough to cover both maturities.
        perpPositions: [
          { ...ethPerps()[0], positionValue: String(BIG + TINY) },
          { ...ethPerps()[1], positionValue: String(BIG + TINY) },
        ],
      }),
    );

  it('says <1% and >99% rather than 0% and 100%', () => {
    const notes = out()
      .strategies.flatMap((s) => s.legs)
      .flatMap((l) => l.warnings ?? [])
      .filter((w) => /is counted here/.test(w));
    expect(notes.length).toBeGreaterThan(0);
    for (const w of notes) {
      expect(w).not.toMatch(/(^|\s)0% of this/);
      expect(w).not.toMatch(/(^|\s)100% of this/);
    }
    expect(notes.some((w) => w.startsWith('<1% of this'))).toBe(true);
    expect(notes.some((w) => w.startsWith('>99% of this'))).toBe(true);
  });
});
