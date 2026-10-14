/**
 * The share card is public and written in the present tense, so a number on it
 * is a claim. These tests pin the one rule that failed in 1.6.0: the payload
 * reports what it was given and never substitutes a zero.
 *
 * The matching half — hiding the button when a number is unknown — lives in
 * AssetCard's `canSharePair` and is enforced at compile time by this module's
 * non-nullable parameters.
 */
import { describe, expect, it } from 'vitest';
import { decodeSharePayload, encodeSharePayload, roundTo } from '../lib/shareCodec';
import { pairSharePayload } from './sharePayload';
import type { PairEstimate, PairLegDetail } from './assets/assetModel';

const NOW = 1_760_000_000;
const MATURITY = NOW + 49 * 86_400;

const yuLeg = (over: Partial<PairLegDetail> = {}): PairLegDetail => ({
  venue: 'gate',
  kind: 'yu',
  side: 'LONG',
  share: 1,
  sizeToken: 0.01,
  sizeBase: 0.01,
  notionalUsd: 24.5,
  lockedApr: -0.0504,
  feesUsd: 0,
  maturity: MATURITY,
  marketId: 200,
  imUsd: 0.13,
  imAtOpenUsd: 0.13,
  ...over,
});

const pair = (over: Partial<PairEstimate> = {}): PairEstimate => ({
  longVenue: 'gate',
  shortVenue: 'hyperliquid',
  kind: 'singles',
  size: 0.01,
  unit: 'base',
  notionalUsd: 98,
  capitalUsd: 200,
  lockedAprFwd: 0.0292,
  exitFeeUsd: 0.02,
  hedgedSinceSec: NOW - 15 * 86_400,
  perpOpenedSec: NOW - 15 * 86_400,
  borosOpenedSec: NOW - 15 * 86_400,
  soonestMaturitySec: MATURITY,
  legs: [
    yuLeg(),
    yuLeg({ venue: 'hyperliquid', side: 'SHORT', lockedApr: 0.0796, marketId: 196 }),
    { ...yuLeg(), kind: 'perp', lockedApr: null, symbol: 'GATE_FUTURE_ETH_USDT', marketId: undefined },
    {
      ...yuLeg(),
      kind: 'perp',
      side: 'SHORT',
      lockedApr: null,
      symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
      marketId: undefined,
    },
  ],
  perpFeesPaidUsd: 0.03,
  borosFeesPaidUsd: 0.01,
  ...over,
});

const opts = {
  nowSec: NOW,
  inclPerpFees: true,
  inclExitFee: false,
  netApr: 0.0241,
  netUsd: 0.64,
  lockedAprFwd: 0.0292,
};

describe('pairSharePayload', () => {
  it('carries the displayed APR and PnL through untouched', () => {
    const p = pairSharePayload(pair(), 'ETH', opts);
    expect(p.a).toBe(0.0241);
    expect(p.p).toBe(0.64);
  });

  /** The regression: a pair under MIN_APR_CAPITAL_USD has no APR, the old
   * builder took `?? 0`, and the card headlined "I'm getting 0.00% fixed APR"
   * over legs reading +7.96% and −5.04%. Zero is now only ever a real zero. */
  it('never emits a zero the caller did not supply', () => {
    const p = pairSharePayload(pair(), 'ETH', opts);
    expect(p.a).not.toBe(0);
    expect(p.sp).not.toBe(0);
  });

  it('keeps a NEGATIVE net APR negative — a loss is not an unknown', () => {
    const p = pairSharePayload(pair(), 'ETH', { ...opts, netApr: -0.031, netUsd: -0.82 });
    expect(p.a).toBe(-0.031);
    expect(p.p).toBe(-0.82);
  });

  it('derives the locked spread on NOTIONAL from the capital-based rate', () => {
    // carry/yr = lockedAprFwd × capital; per-leg notional = half the two RATE
    // legs' (24.5 each) — the notional the carry is earned on, not the perps'.
    const p = pairSharePayload(pair(), 'ETH', opts);
    expect(p.sp).toBeCloseTo((0.0292 * 200) / 24.5, 12);
  });

  it('omits a YU leg rate rather than publishing it as 0%', () => {
    const withUnknownRate = pair({ legs: [yuLeg({ lockedApr: null }), ...pair().legs.slice(1)] });
    const p = pairSharePayload(withUnknownRate, 'ETH', opts);
    // The two Boros legs share one row, so one unknown rate leaves it blank.
    const boros = p.l.filter((l) => l.k === 'b');
    expect(boros).toHaveLength(1);
    expect(boros[0].r).toBeUndefined();
    expect(p.l.every((l) => l.r !== 0)).toBe(true);
  });

  it('always marks the pair as an estimate — the split is proposed, not measured', () => {
    expect(pairSharePayload(pair(), 'ETH', opts).uc).toBe(1);
  });

  it('leaks no wallet address or symbol-shaped junk into the payload', () => {
    const p = pairSharePayload(pair(), 'ETH', opts);
    expect(JSON.stringify(p)).not.toMatch(/0x[0-9a-fA-F]{8}/);
    expect(p.b).toBe('ETH');
  });
});

describe('pairSharePayload on a spread pair', () => {
  const OPENED = Date.UTC(2026, 9, 8) / 1000;
  const NOV_27 = Date.UTC(2026, 10, 27) / 1000;
  const perp = (venue: string, side: 'LONG' | 'SHORT', symbol: string): PairLegDetail => ({
    ...yuLeg({ venue, side, sizeToken: 0.555, sizeBase: 0.555, notionalUsd: 1_700, lockedApr: null }),
    kind: 'perp',
    symbol,
    marketId: undefined,
  });
  const ownerPair = (): PairEstimate => ({
    ...pair({ longVenue: 'GATE', shortVenue: 'HYPERLIQUID', soonestMaturitySec: NOV_27, hedgedSinceSec: OPENED }),
    legs: [
      perp('GATE', 'LONG', 'GATE_FUTURE_ETH_USDT'),
      perp('HYPERLIQUID', 'SHORT', 'HYPERLIQUID_FUTURE_ETH_USDC'),
      {
        ...yuLeg({
          venue: 'HYPERLIQUID',
          side: 'SHORT',
          sizeToken: 0.555,
          sizeBase: 0.555,
          notionalUsd: 1_700,
          lockedApr: 0.0348,
          marketId: 59,
          maturity: NOV_27,
        }),
        spreadVenues: ['HYPERLIQUID', 'GATE'],
      },
    ],
  });

  it('spread leg', () => {
    const payload = pairSharePayload(ownerPair(), 'ETH', { ...opts, nowSec: OPENED });
    const boros = payload.l.filter((l) => l.k === 'b');
    expect(boros).toHaveLength(1);
    expect(boros[0]).toMatchObject({ k: 'b', x: 'HYPERLIQUID_GATE', s: 'S', n: 1_700 });
    // The row carries the pair's net locked spread, the figure the card prints beside it.
    expect(boros[0].r).toBeCloseTo(payload.sp, 12);
    expect(payload.v).toBe(1);
    const decoded = decodeSharePayload(encodeSharePayload(payload));
    expect(decoded).toEqual({
      ok: true,
      payload: {
        ...payload,
        sp: roundTo(payload.sp, 4),
        p: Math.round(payload.p),
        l: payload.l.map((l) => (l.r === undefined ? l : { ...l, r: roundTo(l.r, 4) })),
      },
    });
  });

  it('shows two single Boros legs as one HL-GATE spread leg', () => {
    const payload = pairSharePayload(pair(), 'ETH', opts);
    const boros = payload.l.filter((l) => l.k === 'b');
    expect(boros).toHaveLength(1);
    // Hyperliquid's single is SHORT, so the HL−Gate spread is short.
    expect(boros[0]).toMatchObject({ x: 'HYPERLIQUID_GATE', s: 'S', n: 0 });
    expect(boros[0].r).toBeCloseTo(payload.sp, 12);
    expect(payload.l.filter((l) => l.k === 'p')).toHaveLength(2);
  });

  it('sizes a mixed book per perp side: a spread counts whole, a single half', () => {
    const singles = (n: number) => [
      yuLeg({ venue: 'GATE', side: 'LONG', notionalUsd: n, sizeBase: n / 3000 }),
      yuLeg({ venue: 'HYPERLIQUID', side: 'SHORT', notionalUsd: n, sizeBase: n / 3000, lockedApr: 0.08 }),
    ];
    const mixed = ownerPair();
    mixed.legs = [...mixed.legs, ...singles(1_000)];
    const payload = pairSharePayload(mixed, 'ETH', { ...opts, nowSec: OPENED });
    const boros = payload.l.filter((l) => l.k === 'b');
    expect(boros).toHaveLength(1);
    expect(boros[0]).toMatchObject({ x: 'HYPERLIQUID_GATE', s: 'S', n: 2_700 });
    expect(boros[0].tn).toBeCloseTo(0.555 + 1_000 / 3000, 3);
    expect(boros[0].r).toBeCloseTo(payload.sp, 12);
  });

  it('names a spread for any venue pair, Hyperliquid first, else A to Z', () => {
    const okxLighter = pair({
      legs: [
        yuLeg({ venue: 'OKX', side: 'SHORT', notionalUsd: 1_000, lockedApr: 0.06 }),
        yuLeg({ venue: 'LIGHTER', side: 'LONG', notionalUsd: 1_000, lockedApr: -0.04 }),
      ],
    });
    const payload = pairSharePayload(okxLighter, 'ETH', opts);
    const boros = payload.l.filter((l) => l.k === 'b');
    // LIGHTER first; its single is LONG, so the LIGHTER−OKX spread is long.
    expect(boros).toEqual([expect.objectContaining({ x: 'LIGHTER_OKX', s: 'L', n: 1_000 })]);
    // `r` is the entry rate a LONG pays: −spread, so the page reads "receive".
    expect(payload.sp).toBeGreaterThan(0);
    expect(boros[0].r).toBeCloseTo(-payload.sp, 12);
  });

  it('keeps the legs apart when they do not form one spread', () => {
    const threeVenues = pair({
      legs: [yuLeg({ venue: 'GATE' }), yuLeg({ venue: 'OKX', side: 'SHORT' }), yuLeg({ venue: 'LIGHTER', side: 'SHORT' })],
    });
    const boros = pairSharePayload(threeVenues, 'ETH', opts).l.filter((l) => l.k === 'b');
    expect(boros).toHaveLength(3);
    // A LONG single held at 5.04% sends its entry rate, +5.04%: the page reads "pay".
    expect(boros.find((l) => l.s === 'L')?.r).toBe(0.0504);
  });
});
