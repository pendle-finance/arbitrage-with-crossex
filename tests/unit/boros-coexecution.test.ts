/**
 * The co-execution grouping, end to end through `buildStrategies`.
 *
 * The unit tests in boros-grouping.test.ts prove the binder. This proves the
 * thing that actually went wrong on a live book: two Boros legs bought in ONE
 * transaction were being torn onto two different cards, because the solver
 * divides a Boros leg market by market and nothing in it could say "these two
 * are one trade".
 */
import { describe, expect, it } from 'vitest';
import type { BorosCollateralZone, BorosMarket, BorosTxn } from '../../src/core/boros/client';
import { buildStrategies, type PerpPositionLike } from '../../src/core/boros/returns';
import { imInputs, raw } from '../helpers/boros-fixtures';

const NOW = 1_787_300_000;
const MAT = 1_798_156_800;
const OPENED = NOW - 86_400;

const HL = 'HYPERLIQUID_FUTURE_ETH_USDC';
const BIN = 'BINANCE_FUTURE_ETH_USDT';
const GATE = 'GATE_FUTURE_ETH_USDT';
const BIN_BOROS = 129;
const HL_BOROS = 128;

const market = (marketId: number, venue: string): BorosMarket => ({
  maxRateDeviationApr: 0.016,
  marketId,
  tokenId: 2,
  name: `${venue} ETH`,
  venue,
  base: 'ETH',
  maturity: MAT,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: 0.05,
  floatingApr: 0.05,
  midApr: 0.05,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 2_300,
  ...imInputs,
});

const perp = (
  symbol: string,
  side: 'LONG' | 'SHORT',
  qty: number,
  openedSec: number,
): PerpPositionLike => ({
  symbol,
  positionSide: side,
  positionQty: side === 'SHORT' ? String(-qty) : String(qty),
  positionValue: String(qty * 2_300),
  entryPrice: '2300',
  upnl: '0',
  fundingFee: '0',
  fee: '0',
  initialMargin: '10',
  createTime: String(openedSec * 1000),
});

/**
 * The Boros spread is placed at OPENED. The GATE pair is opened at the same
 * moment and the BINANCE pair two hours earlier — which is what makes legacy
 * tear the spread: the Hyperliquid Boros leg is eligible for both tranches and
 * picks the nearer one (Gate), while the Binance Boros leg is only eligible
 * for the Binance tranche. One trade, two cards.
 */
const BIN_OPENED = OPENED - 7_200;

/**
 * Tagged fills, so the two tranches are `#exec` with their OWN open times —
 * as on a real book. Without them the shared Hyperliquid leg's `createTime`
 * dates both tranches identically and the tear does not arise.
 * `t{7-char pair hash}{A|B}{seq}` is this engine's client order id.
 */
const fills = [
  { symbol: BIN, side: 'BUY' as const, qty: 0.024, price: 2_300, feeUsd: 0, timeSec: BIN_OPENED, text: 't1111111A0' },
  { symbol: HL, side: 'SELL' as const, qty: 0.024, price: 2_300, feeUsd: 0, timeSec: BIN_OPENED, text: 't1111111B0' },
  { symbol: GATE, side: 'BUY' as const, qty: 0.023, price: 2_300, feeUsd: 0, timeSec: OPENED, text: 't2222222A0' },
  { symbol: HL, side: 'SELL' as const, qty: 0.023, price: 2_300, feeUsd: 0, timeSec: OPENED, text: 't2222222B0' },
];

/**
 * The live shape: one Hyperliquid short of 0.047 shared by a Binance pair
 * (0.024) and a Gate pair (0.023), plus a Boros spread whose two legs were
 * placed `gapSec` apart at equal size on opposite sides.
 */
const book = (
  opts: { gapSec?: number; historyComplete?: boolean; growBinance?: boolean } = {},
) =>
  buildStrategies({
    address: '0x' + 'ab'.repeat(20),
    zones: [
      {
        tokenId: 2,
        cross: {
          isCross: true,
          netBalance: raw(1),
          marketPositions: [
            { marketId: BIN_BOROS, side: 0, notionalSize: raw(opts.growBinance ? 0.02 : 0.013), fixedApr: 0.045, markApr: 0.045, pnl: { rateSettlementPnl: raw(0), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
            { marketId: HL_BOROS, side: 1, notionalSize: raw(-0.013), fixedApr: 0.065, markApr: 0.065, pnl: { rateSettlementPnl: raw(0), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
          ],
        },
        isolated: [],
      } satisfies BorosCollateralZone,
    ],
    markets: [market(BIN_BOROS, 'Binance'), market(HL_BOROS, 'Hyperliquid')],
    txnsByToken: new Map<number, BorosTxn[]>([
      [
        2,
        [
          { marketId: BIN_BOROS, time: OPENED, fee: raw(0), pnl: raw(0), prevPositionS: '0', postPositionS: raw(0.013), fixedApr: 0.045 },
          { marketId: HL_BOROS, time: OPENED + (opts.gapSec ?? 0), fee: raw(0), pnl: raw(0), prevPositionS: '0', postPositionS: raw(-0.013), fixedApr: 0.065 },
          // A second add on the Binance leg, a day later: now that leg is two
          // increments and belongs to two executions, not one.
          ...(opts.growBinance
            ? [{ marketId: BIN_BOROS, time: OPENED + 86_400, fee: raw(0), pnl: raw(0), prevPositionS: raw(0.013), postPositionS: raw(0.02), fixedApr: 0.05 }]
            : []),
        ],
      ],
    ]),
    pricesUsd: new Map([[2, 2_300]]),
    perpPositions: [
      perp(HL, 'SHORT', 0.047, BIN_OPENED),
      perp(BIN, 'LONG', 0.024, BIN_OPENED),
      perp(GATE, 'LONG', 0.023, OPENED),
    ],
    perpFills: fills,
    nowSec: NOW,
    borosHistoryComplete: opts.historyComplete,
  });

/** Which card each Boros market landed on. */
const borosHomes = (out: ReturnType<typeof book>) => {
  const at = new Map<number, string>();
  for (const s of out.strategies) {
    for (const l of s.legs) {
      if (l.kind === 'boros' && l.marketId !== undefined) at.set(l.marketId, s.strategyId);
    }
  }
  return at;
};

/** Every venue leg accounted for exactly once, across every card. */
const expectConserved = (out: ReturnType<typeof book>, over: { binBoros?: number } = {}) => {
  const legs = out.strategies.flatMap((s) => s.legs);
  const sum = (pred: (l: (typeof legs)[number]) => boolean) =>
    legs.filter(pred).reduce((a, l) => a + (l.notionalToken ?? 0), 0);
  expect(sum((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID')).toBeCloseTo(0.047, 9);
  expect(sum((l) => l.kind === 'perp' && l.venue === 'BINANCE')).toBeCloseTo(0.024, 9);
  expect(sum((l) => l.kind === 'perp' && l.venue === 'GATE')).toBeCloseTo(0.023, 9);
  expect(sum((l) => l.kind === 'boros' && l.marketId === BIN_BOROS)).toBeCloseTo(over.binBoros ?? 0.013, 9);
  expect(sum((l) => l.kind === 'boros' && l.marketId === HL_BOROS)).toBeCloseTo(0.013, 9);
};

describe('co-execution grouping', () => {
  it('keeps a same-transaction Boros pair on one card', () => {
    // Before this, the two halves were scored separately against different
    // eligible tranches and landed on two cards. This fixture reproduces that
    // exactly: the Hyperliquid Boros leg is eligible for both tranches and the
    // Gate one is nearer in time, while the Binance leg has only one home.
    const at = borosHomes(book());
    expect(at.get(BIN_BOROS)).toBe(at.get(HL_BOROS));
  });

  it('conserves every venue leg — grouping moves size, never invents it', () => {
    expectConserved(book());
  });

  it('leaves a pair placed far apart alone — that is not one trade', () => {
    // Ten minutes apart is the weak band, which does not bind.
    const at = borosHomes(book({ gapSec: 600 }));
    expect(at.get(BIN_BOROS)).not.toBe(at.get(HL_BOROS));
    expectConserved(book({ gapSec: 600 }));
  });

  it('will not bind on a truncated history — the band argues from absence', () => {
    const at = borosHomes(book({ historyComplete: false }));
    expect(at.get(BIN_BOROS)).not.toBe(at.get(HL_BOROS));
    expectConserved(book({ historyComplete: false }));
  });

  it('leaves a leg grown over several days alone — that is several executions', () => {
    /**
     * The constraint is applied per LEG, but an execution binds INCREMENTS,
     * and the two coincide only when the leg has exactly one. Grow the Binance
     * Boros leg a day later and it takes part in two executions with two
     * different counterparties; collapsing those to one leg-level set would
     * force two strategies onto one card — the netting mistake this module
     * exists to undo. Where that could happen it must do nothing at all.
     */
    const at = borosHomes(book({ growBinance: true }));
    expect(at.get(BIN_BOROS)).not.toBe(at.get(HL_BOROS));
    expectConserved(book({ growBinance: true }), { binBoros: 0.02 });
  });
});
