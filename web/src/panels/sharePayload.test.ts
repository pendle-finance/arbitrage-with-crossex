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
    // carry/yr = lockedAprFwd × capital; per-leg notional = half the pair's.
    const p = pairSharePayload(pair(), 'ETH', opts);
    expect(p.sp).toBeCloseTo((0.0292 * 200) / (98 / 2), 12);
  });

  it('omits a YU leg rate rather than publishing it as 0%', () => {
    const withUnknownRate = pair({ legs: [yuLeg({ lockedApr: null }), ...pair().legs.slice(1)] });
    const p = pairSharePayload(withUnknownRate, 'ETH', opts);
    // Legs are re-sorted for display, so find the one by identity, not index.
    const gateYu = p.l.find((l) => l.k === 'b' && l.x === 'gate' && l.s === 'L');
    expect(gateYu?.r).toBeUndefined();
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
