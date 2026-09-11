/**
 * A pair is a 4-leg unit at ONE maturity. These pin that shape end-to-end
 * through deriveAsset: a laddered venue pairing becomes several rows, and
 * any YU leg with no counterpart at its maturity falls out as a pending leg
 * rather than being blended into a unit that settles earlier.
 */
import { describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { deriveAsset } from './assetModel';

const NOW = 1_760_000_000;
const DAY = 86_400;
const SEP = NOW + 16 * DAY;
const OCT = NOW + 51 * DAY;

const perp = (o: Partial<AssetPerpOpen> & { venue: string; side: 'LONG' | 'SHORT'; qty: number }): AssetPerpOpen => ({
  symbol: `${o.venue}_FUTURE_ETH_USDT`,
  notionalUsd: o.qty * 2500,
  entryPrice: 2500,
  markPrice: 2500,
  leverage: 10,
  upnlUsd: 0,
  fundingUsd: 0,
  feesUsd: 0,
  imUsd: o.qty * 250,
  openedAt: NOW - 10 * DAY,
  ...o,
});

let mid = 1;
const yu = (o: Partial<AssetBorosOpen> & { venue: string; side: 'LONG' | 'SHORT'; sizeToken: number; maturity: number }): AssetBorosOpen => ({
  marketId: mid++,
  collateral: 'ETH',
  notionalUsd: o.sizeToken * 2500,
  entryApr: 0.08,
  markApr: 0.08,
  floatingApr: 0.09,
  settleUsd: 0,
  mtmUsd: 0,
  imUsd: o.sizeToken * 100,
  ...o,
});

const group = (o: Partial<AssetGroup>): AssetGroup => ({
  base: 'ETH',
  priceUsd: 2500,
  earliestSec: NOW - 10 * DAY,
  perpOpen: [],
  perpClosed: [],
  borosOpen: [],
  borosHistory: [],
  ...o,
});

describe('settlement fees are netted out of the locked rate', () => {
  it('subtracts settleFeeApr from BOTH legs, whichever way they point', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        // LONG pays 4% fixed, SHORT receives 8%: gross spread +4%.
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP, entryApr: 0.04, settleFeeApr: 0.001 }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP, entryApr: 0.08, settleFeeApr: 0.001 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    const notional = 100 * 2500;
    const cap = d.pairs[0].capitalUsd;
    // (+0.08 − 0.04) × notional, minus 0.001 × notional on EACH leg — the
    // fee is a cost to the holder regardless of side.
    const expected = ((0.08 - 0.04) * notional - 2 * 0.001 * notional) / cap;
    expect(d.pairs[0].lockedAprFwd).toBeCloseTo(expected, 9);
  });

  it('a missing settleFeeApr (older server) leaves the rate unchanged', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP, entryApr: 0.04 }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP, entryApr: 0.08 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    const notional = 100 * 2500;
    expect(d.pairs[0].lockedAprFwd).toBeCloseTo(((0.08 - 0.04) * notional) / d.pairs[0].capitalUsd, 9);
  });

  it("the pair's Boros fee bucket holds TRADE fees only (settle is in the rate)", () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP }),
      ],
      borosHistory: [
        { marketId: 1, venue: 'GATE', maturity: SEP, settleUsd: 0, settleFeeUsd: 90, tradePnlUsd: 0, tradeFeeUsd: 10 },
        { marketId: 2, venue: 'HYPERLIQUID', maturity: SEP, settleUsd: 0, settleFeeUsd: 70, tradePnlUsd: 0, tradeFeeUsd: 30 },
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    // 10 + 30 of trade fees; the 160 of settle fees are NOT charged again.
    expect(d.pairs[0].borosFeesPaidUsd).toBeCloseTo(40, 6);
  });
});

describe('pairs are 4-leg units at one maturity', () => {
  it('his ladder: HL Sept+Oct vs Gate Sept only → one Sept pair, HL Oct pending', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 40, maturity: OCT }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(1);
    expect(d.pairs[0].soonestMaturitySec).toBe(SEP);
    // Every YU leg in the unit shares that maturity — nothing blended.
    const yuLegs = d.pairs[0].legs.filter((l) => l.kind === 'yu');
    expect(yuLegs).toHaveLength(2);
    expect(yuLegs.every((l) => l.maturity === SEP)).toBe(true);
    // The orphan Oct leg is listed apart, at its full size.
    expect(d.pendingLegs).toHaveLength(1);
    expect(d.pendingLegs[0]).toMatchObject({ venue: 'HYPERLIQUID', maturity: OCT, sizeBase: 40 });
  });

  it('both sides laddered → TWO pairs, one per maturity, no pending legs', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 140 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 140 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 40, maturity: OCT, entryApr: 0.05 }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 40, maturity: OCT, entryApr: 0.05 }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(2);
    expect(d.pairs.map((p) => p.soonestMaturitySec).sort()).toEqual([SEP, OCT].sort());
    for (const p of d.pairs) {
      const ms = new Set(p.legs.filter((l) => l.kind === 'yu').map((l) => l.maturity));
      expect(ms.size).toBe(1); // the whole point: one maturity per unit
    }
    expect(d.pendingLegs).toHaveLength(0);
    // Perps split pro-rata, so the two rows sum to the perp position.
    expect(d.pairs.reduce((t, p) => t + p.size, 0)).toBeCloseTo(140, 6);
  });

  it('perps and capital split pro-rata across the two maturity rows', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 75, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 75, maturity: SEP }),
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 25, maturity: OCT }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 25, maturity: OCT }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    const sep = d.pairs.find((p) => p.soonestMaturitySec === SEP)!;
    const oct = d.pairs.find((p) => p.soonestMaturitySec === OCT)!;
    expect(sep.size).toBeCloseTo(75, 6);
    expect(oct.size).toBeCloseTo(25, 6);
    // Each perp leg is carried at its share, never in full on both rows.
    expect(sep.legs.find((l) => l.kind === 'perp' && l.side === 'LONG')!.sizeToken).toBeCloseTo(75, 6);
    expect(oct.legs.find((l) => l.kind === 'perp' && l.side === 'LONG')!.sizeToken).toBeCloseTo(25, 6);
    expect(sep.capitalUsd + oct.capitalUsd).toBeCloseTo(
      // both perps' IM + both YU legs' IM, whole
      100 * 250 * 2 + 100 * 100 * 2,
      4,
    );
  });

  it('two perp books at ONE venue merge into a single unit, not two rows', () => {
    // A venue can hold several perp positions (an ETH_USDT and an ETH_USDC
    // book). Each generates its own (long, short, maturity) triple, and
    // listing them apart reads as two hedges with near-identical APRs —
    // which is exactly what a duplicate looks like.
    mid = 1;
    const g = group({
      perpOpen: [
        perp({ venue: 'GATE', side: 'LONG', qty: 60, symbol: 'GATE_FUTURE_ETH_USDT' }),
        perp({ venue: 'GATE', side: 'LONG', qty: 40, symbol: 'GATE_FUTURE_ETH_USDC' }),
        perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 }),
      ],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(1);
    // The merged unit carries the whole hedge, not one book's slice.
    expect(d.pairs[0].size).toBeCloseTo(100, 6);
    expect(d.pairs[0].capitalUsd).toBeCloseTo(100 * 250 + 100 * 250 + 100 * 100 * 2, 4);
    expect(d.pendingLegs).toHaveLength(0);
  });

  it('a maturity present on only ONE side forms no unit; both legs go pending', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: OCT }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(0); // no shared maturity ⇒ no 4-leg unit
    expect(d.pendingLegs.map((l) => l.maturity).sort()).toEqual([SEP, OCT].sort());
  });

  it('an incomplete side pairs what it can and leaves the rest pending', () => {
    mid = 1;
    const g = group({
      perpOpen: [perp({ venue: 'GATE', side: 'LONG', qty: 100 }), perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 100 })],
      borosOpen: [
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 60, maturity: SEP }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(1);
    expect(d.pairs[0].size).toBeCloseTo(60, 6); // capped by the thinner side
    // Gate's unpaired 40 is pending, HL has nothing left over.
    expect(d.pendingLegs).toHaveLength(1);
    expect(d.pendingLegs[0]).toMatchObject({ venue: 'GATE', sizeBase: 40 });
  });

  it('one laddered venue vs two single-maturity venues: each unit keeps its term', () => {
    mid = 1;
    const g = group({
      perpOpen: [
        perp({ venue: 'GATE', side: 'LONG', qty: 100 }),
        perp({ venue: 'OKX', side: 'LONG', qty: 40 }),
        perp({ venue: 'HYPERLIQUID', side: 'SHORT', qty: 140 }),
      ],
      borosOpen: [
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 40, maturity: OCT }),
        yu({ venue: 'GATE', side: 'LONG', sizeToken: 100, maturity: SEP }),
        yu({ venue: 'OKX', side: 'LONG', sizeToken: 40, maturity: OCT }),
      ],
    });
    const d = deriveAsset(g, {}, 0, NOW);
    expect(d.pairs).toHaveLength(2);
    const gate = d.pairs.find((p) => p.longVenue === 'GATE')!;
    const okx = d.pairs.find((p) => p.longVenue === 'OKX')!;
    expect(gate.soonestMaturitySec).toBe(SEP);
    expect(okx.soonestMaturitySec).toBe(OCT);
    // OKX pairs against HL's OCT leg only — the bug that started this.
    expect(okx.legs.filter((l) => l.kind === 'yu').every((l) => l.maturity === OCT)).toBe(true);
    expect(d.pendingLegs).toHaveLength(0);
  });
});
