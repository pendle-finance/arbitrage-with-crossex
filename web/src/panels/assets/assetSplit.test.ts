import { describe, expect, it } from 'vitest';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { borosOnlyPairs, deriveAsset, perpOnlyPairs, type PendingLeg, type PerpOnlyPair, type UnpairedPerp } from './assetModel';

const OCT30 = Date.UTC(2026, 9, 30, 8) / 1000;
const NOV27 = Date.UTC(2026, 10, 27, 8) / 1000;
const NOW = OCT30 - 14 * 86_400;
const SPREAD: [string, string] = ['HYPERLIQUID', 'GATE'];

type Unit = 'base' | 'usd';
/** BTC sizes in coins; SOL sizes in dollars (lib/boros.ts sizeUnitForBase). */
const COIN = { base: { base: 'BTC', price: 80_000 }, usd: { base: 'SOL', price: 150 } } as const;

interface Leg {
  venue: string;
  side: 'LONG' | 'SHORT';
  size: number;
}
interface Yu extends Leg {
  id: number;
  maturity: number;
  spread?: [string, string];
}

/** One book, every size scaled by `k` and read in the unit's own terms. */
function book(unit: Unit, k: number, perps: Leg[], yus: Yu[]): AssetGroup {
  const { base, price } = COIN[unit];
  const usdOf = (size: number) => (unit === 'base' ? size * k * price : size * k);
  const perpOpen: AssetPerpOpen[] = perps.map((p) => ({
    symbol: `${p.venue}_FUTURE_${base}_USDT`,
    venue: p.venue,
    side: p.side,
    qty: usdOf(p.size) / price,
    notionalUsd: usdOf(p.size),
    entryPrice: price,
    markPrice: price,
    leverage: 20,
    upnlUsd: 0,
    fundingUsd: 0,
    feesUsd: 0,
    imUsd: usdOf(p.size) / 20,
    openedAt: NOW - 86_400,
  }));
  const borosOpen: AssetBorosOpen[] = yus.map((y) => ({
    marketId: y.id,
    venue: y.spread ? y.spread[0] : y.venue,
    spreadVenues: y.spread ?? null,
    maturity: y.maturity,
    collateral: unit === 'base' ? base : 'USDT',
    side: y.side,
    sizeToken: unit === 'base' ? y.size * k : usdOf(y.size),
    notionalUsd: usdOf(y.size),
    entryApr: 0.05,
    markApr: 0.05,
    floatingApr: 0.04,
    settleUsd: 0,
    mtmUsd: 0,
    imUsd: usdOf(y.size) / 50,
    settleFeeApr: 0.001,
  }));
  return { base, supported: true, priceUsd: price, earliestSec: NOW - 86_400, perpOpen, perpClosed: [], borosOpen, borosHistory: [] };
}

function run(g: AssetGroup) {
  const d = deriveAsset(g, {}, 0, NOW);
  const po = perpOnlyPairs(d.unpairedPerps, d.pendingLegs);
  const bo = borosOnlyPairs(po.restPerps, po.restYus);
  return { d, po, bo };
}

const held = (y: PendingLeg | null) => (y ? `${y.venue}@${y.maturity === OCT30 ? 'OCT30' : 'NOV27'}` : null);
/** A part in the book's own numbers (sizes divided back by `k`). */
const read = (p: PerpOnlyPair, k: number) => ({
  size: p.size / k,
  longYu: held(p.longYu),
  shortYu: held(p.shortYu),
  missingLong: p.missingLong / k,
  missingShort: p.missingShort / k,
});
const part = (size: number, longYu: string | null, shortYu: string | null, missingLong: number, missingShort: number) => ({
  size: expect.closeTo(size, 9),
  longYu,
  shortYu,
  missingLong: expect.closeTo(missingLong, 9),
  missingShort: expect.closeTo(missingShort, 9),
});

const PERPS = (size: number): Leg[] => [
  { venue: 'GATE', side: 'LONG', size },
  { venue: 'HYPERLIQUID', side: 'SHORT', size },
];

/** k for each unit and size: the smallest part about $30 a side, and a book of about $6M. */
const scales = (smallest: number, total: number) => {
  const usdPerUnit = (unit: Unit) => (unit === 'base' ? COIN.base.price : 1);
  return (['base', 'usd'] as const).flatMap((unit) => [
    { unit, label: 'small', k: 30 / (smallest * usdPerUnit(unit)) },
    { unit, label: '$6M', k: 3_000_000 / (total * usdPerUnit(unit)) },
  ]);
};

function expectSound(po: ReturnType<typeof perpOnlyPairs>, perpSize: number) {
  const keys = po.pairs.map((p) => p.partKey);
  expect(new Set(keys).size).toBe(keys.length);
  const total = po.pairs.reduce((t, p) => t + p.size, 0);
  expect(total).toBeLessThanOrEqual(perpSize * (1 + 1e-12));
  for (const p of po.pairs) {
    expect(p.long.sizeBase).toBeCloseTo(p.short.sizeBase, 9);
    expect(p.long.notionalUsd + p.short.notionalUsd).toBeCloseTo(p.notionalUsd, 6);
  }
}

describe('a perp unit splits by the size each held single covers', () => {
  describe.each(scales(0.36, 4.03))('case 0, $unit unit, $label book', ({ unit, k }) => {
    it('0.36 with the Gate single held, HL missing at 30 Oct; 3.67 perps only', () => {
      const { d, po, bo } = run(book(unit, k, PERPS(4.03), [{ id: 1, venue: 'GATE', side: 'LONG', size: 0.36, maturity: OCT30 }]));
      expect(d.pairs).toEqual([]);
      expect(po.pairs.map((p) => read(p, k))).toEqual([part(0.36, 'GATE@OCT30', null, 0, 0.36), part(3.67, null, null, 3.67, 3.67)]);
      expect(po.restPerps).toEqual([]);
      expect(po.restYus).toEqual([]);
      expect(bo.pairs).toEqual([]);
      expectSound(po, 4.03 * k);
    });
  });

  describe.each(scales(0.05, 4))('case 2a, $unit unit, $label book', ({ unit, k }) => {
    it('each single is its own part at its own date; the rest is perps only', () => {
      const { d, po, bo } = run(
        book(unit, k, PERPS(4), [
          { id: 1, venue: 'GATE', side: 'LONG', size: 0.05, maturity: OCT30 },
          { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 3.9, maturity: NOV27 },
        ]),
      );
      expect(d.pairs).toEqual([]);
      expect(po.pairs.map((p) => read(p, k))).toEqual([
        part(3.9, null, 'HYPERLIQUID@NOV27', 3.9, 0),
        part(0.05, 'GATE@OCT30', null, 0, 0.05),
        part(0.05, null, null, 0.05, 0.05),
      ]);
      expect(po.restYus).toEqual([]);
      expect(bo.pairs).toEqual([]);
      expectSound(po, 4 * k);
    });
  });

  describe.each(scales(0.14, 4))('case 2b, $unit unit, $label book', ({ unit, k }) => {
    it('0.36 full singles pair, 0.14 with the HL single held, 3.50 perps only', () => {
      const { d, po, bo } = run(
        book(unit, k, PERPS(4), [
          { id: 1, venue: 'GATE', side: 'LONG', size: 0.36, maturity: OCT30 },
          { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 0.5, maturity: OCT30 },
        ]),
      );
      expect(d.pairs.map((p) => [p.kind, p.size / k, p.soonestMaturitySec])).toEqual([['singles', expect.closeTo(0.36, 9), OCT30]]);
      expect(po.pairs.map((p) => read(p, k))).toEqual([part(0.14, null, 'HYPERLIQUID@OCT30', 0.14, 0), part(3.5, null, null, 3.5, 3.5)]);
      expect(po.restYus).toEqual([]);
      expect(bo.pairs).toEqual([]);
      expectSound(po, 3.64 * k);
    });
  });

  describe.each(scales(0.6, 4))('$unit unit, $label book', ({ unit, k }) => {
    it('a part-filled single: its size takes the single, the rest is perps only', () => {
      const { po } = run(book(unit, k, PERPS(4), [{ id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 1.7, maturity: NOV27 }]));
      expect(po.pairs.map((p) => read(p, k))).toEqual([part(1.7, null, 'HYPERLIQUID@NOV27', 1.7, 0), part(2.3, null, null, 2.3, 2.3)]);
      expectSound(po, 4 * k);
    });

    it('a spread plus a part single: the spread takes perps first, the single splits the rest', () => {
      const { d, po } = run(
        book(unit, k, PERPS(4), [
          { id: 9, venue: 'HYPERLIQUID', side: 'SHORT', size: 1.7, maturity: NOV27, spread: SPREAD },
          { id: 1, venue: 'GATE', side: 'LONG', size: 1.7, maturity: OCT30 },
        ]),
      );
      expect(d.pairs.map((p) => [p.kind, p.size / k])).toEqual([['spread', expect.closeTo(1.7, 9)]]);
      expect(po.pairs.map((p) => read(p, k))).toEqual([part(1.7, 'GATE@OCT30', null, 0, 1.7), part(0.6, null, null, 0.6, 0.6)]);
      expectSound(po, 2.3 * k);
    });
  });

  it('a single smaller than the dust line stays ungrouped, and its perps join the rest', () => {
    // $50 a side of BTC perps: the 0.36/4.03 single is under $5, a rounding leg.
    const k = 50 / (4.03 * COIN.base.price);
    const { po, bo } = run(book('base', k, PERPS(4.03), [{ id: 1, venue: 'GATE', side: 'LONG', size: 0.36, maturity: OCT30 }]));
    // The sliver is rounding to the cap too, so both sides open 4.03 and the
    // gaps stay even (owner 2026-10-16, F-B).
    expect(po.pairs.map((p) => read(p, k))).toEqual([part(4.03, null, null, 4.03, 4.03)]);
    expect(bo.restYus.map((y) => [y.venue, y.sizeBase / k])).toEqual([['GATE', expect.closeTo(0.36, 9)]]);
  });

  // Live 16 Oct (F-B): a $10 Gate single behind 0.949 ETH of perps cut
  // Gate's gap to 0.945 against Hyperliquid's 0.949, and the uneven gaps lost
  // the spread offer.
  it('a $10 single leaves both gaps at the whole unit, so the spread is offered', () => {
    const k = 10 / (0.004 * COIN.base.price);
    const { po, bo } = run(book('base', k, PERPS(0.949), [{ id: 1, venue: 'GATE', side: 'LONG', size: 0.004, maturity: NOV27 }]));
    expect(po.pairs.map((p) => read(p, k))).toEqual([part(0.949, null, null, 0.949, 0.949)]);
    expect(po.pairs[0].heldElsewhereLong).toBeUndefined();
    expect(bo.restYus.map((y) => [y.venue, y.sizeBase / k])).toEqual([['GATE', expect.closeTo(0.004, 9)]]);
  });

  it('small singles count once together they pass the dust line', () => {
    // Three $10 Gate singles: the two smallest stay under it ($20), the third
    // does not ($30), so Gate lacks the unit less that one.
    const k = 10 / (0.004 * COIN.base.price);
    const { po } = run(
      book('base', k, PERPS(0.949), [
        { id: 1, venue: 'GATE', side: 'LONG', size: 0.004, maturity: NOV27 },
        { id: 2, venue: 'GATE', side: 'LONG', size: 0.004, maturity: OCT30 },
        { id: 3, venue: 'GATE', side: 'LONG', size: 0.004, maturity: NOV27 + 28 * 86_400 },
      ]),
    );
    expect(po.pairs.map((p) => read(p, k))).toEqual([part(0.949, null, null, 0.945, 0.949)]);
  });

  // Live 16 Oct: a 0.348 ETH Gate single on a 0.348125 unit showed no held
  // row, only "missing 0.000125 ETH, Open leg" — an order Boros refuses.
  for (const k of [1, 50]) {
    it(`a held side short by a rounding rest shows as held, not missing (x${k})`, () => {
      const { po } = run(book('base', k, PERPS(0.348125 / 30), [{ id: 1, venue: 'GATE', side: 'LONG', size: 0.348 / 30, maturity: OCT30 }]));
      const [p] = po.pairs;
      expect(po.pairs).toHaveLength(1);
      expect(held(p.longYu)).toBe('GATE@OCT30');
      expect(p.missingLong).toBe(0);
      expect(p.missingShort / k).toBeCloseTo(0.348125 / 30, 9);
    });
  }

  it('0.05 BTC is a part of its own, not dust', () => {
    const { po } = run(book('base', 1, PERPS(4), [{ id: 1, venue: 'GATE', side: 'LONG', size: 0.05, maturity: OCT30 }]));
    expect(po.pairs.map((p) => read(p, 1))).toEqual([part(0.05, 'GATE@OCT30', null, 0, 0.05), part(3.95, null, null, 3.95, 3.95)]);
  });

  it('two singles larger than the perps: the larger one takes them first', () => {
    const { po } = run(
      book('base', 1, PERPS(4), [
        { id: 1, venue: 'GATE', side: 'LONG', size: 0.36, maturity: OCT30 },
        { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 3.9, maturity: NOV27 },
      ]),
    );
    // Gate already holds 0.36 at 30 Oct, so its open stops at 4 − 0.36.
    expect(po.pairs.map((p) => read(p, 1))).toEqual([part(3.9, null, 'HYPERLIQUID@NOV27', 3.64, 0), part(0.1, 'GATE@OCT30', null, 0, 0.1)]);
    expect(po.restYus.map((y) => [y.venue, y.sizeBase])).toEqual([['GATE', expect.closeTo(0.26, 9)]]);
    expectSound(po, 4);
  });

  it('two singles at one date that reach the model unpaired make one part with both held', () => {
    const perp = (venue: string, side: 'LONG' | 'SHORT', sizeBase: number): UnpairedPerp => ({
      venue,
      side,
      symbol: `${venue}_FUTURE_BTC_USDT`,
      sizeBase,
      notionalUsd: sizeBase * 80_000,
      unit: 'base',
      imUsd: sizeBase * 4_000,
      share: 1,
    });
    const yu = (marketId: number, venue: string, side: 'LONG' | 'SHORT', sizeBase: number): PendingLeg => ({
      venue,
      side,
      marketId,
      maturity: OCT30,
      sizeBase,
      notionalUsd: sizeBase * 80_000,
      unit: 'base',
      lockedApr: 0.05,
      imUsd: sizeBase * 1_000,
      share: 1,
    });
    const po = perpOnlyPairs([perp('GATE', 'LONG', 4), perp('HYPERLIQUID', 'SHORT', 4)], [yu(1, 'GATE', 'LONG', 0.36), yu(2, 'HYPERLIQUID', 'SHORT', 0.5)]);
    expect(po.pairs.map((p) => read(p, 1))).toEqual([
      part(0.36, 'GATE@OCT30', 'HYPERLIQUID@OCT30', 0, 0),
      part(0.14, null, 'HYPERLIQUID@OCT30', 0.14, 0),
      part(3.5, null, null, 3.5, 3.5),
    ]);
    expect(po.pairs.map((p) => p.partKey)).toEqual([
      'GATE_FUTURE_BTC_USDT:HYPERLIQUID_FUTURE_BTC_USDT:1+2:0',
      'GATE_FUTURE_BTC_USDT:HYPERLIQUID_FUTURE_BTC_USDT:2:0',
      'GATE_FUTURE_BTC_USDT:HYPERLIQUID_FUTURE_BTC_USDT:none:0',
    ]);
    expectSound(po, 4);
  });

  it('two perp symbols on one venue give their parts different keys', () => {
    const g = book('base', 1, PERPS(4), []);
    g.perpOpen.push({ ...g.perpOpen[0], symbol: 'GATE_FUTURE_BTC_USDC', qty: 1, notionalUsd: 80_000, imUsd: 4_000 });
    g.perpOpen.push({ ...g.perpOpen[1], symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', qty: 1, notionalUsd: 80_000, imUsd: 4_000 });
    const { po } = run(g);
    expect(po.pairs.length).toBeGreaterThan(1);
    expectSound(po, 5);
  });
});

describe('checked and correct before the split, unchanged by it', () => {
  it('a part single on both sides, same size and date: the pair takes it, the rest is perps only', () => {
    const { d, po } = run(
      book('base', 1, PERPS(4), [
        { id: 1, venue: 'GATE', side: 'LONG', size: 1, maturity: OCT30 },
        { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 1, maturity: OCT30 },
      ]),
    );
    expect(d.pairs.map((p) => [p.kind, p.size])).toEqual([['singles', expect.closeTo(1, 9)]]);
    expect(po.pairs.map((p) => read(p, 1))).toEqual([part(3, null, null, 3, 3)]);
    expect(po.restYus).toEqual([]);
  });

  it('a part spread with no singles: the spread takes its size, the rest is perps only', () => {
    const { d, po } = run(book('usd', 1_000, PERPS(4), [{ id: 9, venue: 'HYPERLIQUID', side: 'SHORT', size: 1, maturity: NOV27, spread: SPREAD }]));
    expect(d.pairs.map((p) => [p.kind, p.size / 1_000])).toEqual([['spread', expect.closeTo(1, 9)]]);
    expect(po.pairs.map((p) => read(p, 1_000))).toEqual([part(3, null, null, 3, 3)]);
    expect(po.restYus).toEqual([]);
  });

  it('a single larger than its perps: the extra goes to Ungrouped', () => {
    const { po, bo } = run(book('base', 1, PERPS(4), [{ id: 1, venue: 'GATE', side: 'LONG', size: 5, maturity: OCT30 }]));
    expect(po.pairs.map((p) => read(p, 1))).toEqual([part(4, 'GATE@OCT30', null, 0, 4)]);
    expect(bo.pairs).toEqual([]);
    expect(bo.restYus.map((y) => [y.venue, y.sizeBase])).toEqual([['GATE', expect.closeTo(1, 9)]]);
  });
});

describe('an open stops at what the venue lacks, singles at every date counted (owner 2026-10-16)', () => {
  const sizeOf = (y: PendingLeg) => (y.unit === 'base' ? y.sizeBase : y.notionalUsd);
  const heldAt = (legs: PendingLeg[] | undefined, k: number) => legs?.map((y) => [held(y), sizeOf(y) / k]);

  describe.each(scales(3, 3))('perps 3, Gate 3 at 30 Oct, HL 3 at 27 Nov, $unit unit, $label book', ({ unit, k }) => {
    it('HL already holds 3: nothing left to open on HL', () => {
      const { po } = run(
        book(unit, k, PERPS(3), [
          { id: 1, venue: 'GATE', side: 'LONG', size: 3, maturity: OCT30 },
          { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 3, maturity: NOV27 },
        ]),
      );
      expect(po.pairs.map((p) => read(p, k))).toEqual([part(3, 'GATE@OCT30', null, 0, 0)]);
      expect(heldAt(po.pairs[0].heldElsewhereShort, k)).toEqual([['HYPERLIQUID@NOV27', expect.closeTo(3, 9)]]);
      expect(po.pairs[0].heldElsewhereLong).toBeUndefined();
      expect(po.restYus.map((y) => [held(y), sizeOf(y) / k])).toEqual([['HYPERLIQUID@NOV27', expect.closeTo(3, 9)]]);
      expectSound(po, 3 * k);
    });
  });

  describe.each(scales(1, 4))('perps 4, Gate 3 at 30 Oct, HL 3 at 27 Nov, $unit unit, $label book', ({ unit, k }) => {
    it('each side opens only the 1 it lacks', () => {
      const { po } = run(
        book(unit, k, PERPS(4), [
          { id: 1, venue: 'GATE', side: 'LONG', size: 3, maturity: OCT30 },
          { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 3, maturity: NOV27 },
        ]),
      );
      expect(po.pairs.map((p) => read(p, k))).toEqual([part(3, 'GATE@OCT30', null, 0, 1), part(1, null, 'HYPERLIQUID@NOV27', 1, 0)]);
      expect(heldAt(po.pairs[0].heldElsewhereShort, k)).toEqual([['HYPERLIQUID@NOV27', expect.closeTo(3, 9)]]);
      expect(po.pairs[1].heldElsewhereLong).toBeUndefined();
      expectSound(po, 4 * k);
    });
  });

  describe.each(scales(1, 4))('the cap does not bind, $unit unit, $label book', ({ unit, k }) => {
    it('perps 4, Gate 1 at 30 Oct, HL 1 at 27 Nov: every part as before', () => {
      const { po } = run(
        book(unit, k, PERPS(4), [
          { id: 1, venue: 'GATE', side: 'LONG', size: 1, maturity: OCT30 },
          { id: 2, venue: 'HYPERLIQUID', side: 'SHORT', size: 1, maturity: NOV27 },
        ]),
      );
      expect(po.pairs.map((p) => read(p, k))).toEqual([
        part(1, 'GATE@OCT30', null, 0, 1),
        part(1, null, 'HYPERLIQUID@NOV27', 1, 0),
        part(2, null, null, 2, 2),
      ]);
      expect(po.pairs.every((p) => !p.heldElsewhereLong && !p.heldElsewhereShort)).toBe(true);
    });
  });
});

describe('case 9: a venue with only a spread leg still has a funding rate', () => {
  const PX = 2500;
  const g = (spread: [string, string], side: 'LONG' | 'SHORT', floatingApr: number): AssetGroup => ({
    base: 'ETH',
    supported: true,
    priceUsd: PX,
    earliestSec: NOW - 86_400,
    perpOpen: [
      {
        symbol: 'GATE_FUTURE_ETH_USDT',
        venue: 'GATE',
        side: 'LONG',
        qty: 4,
        notionalUsd: 4 * PX,
        entryPrice: PX,
        markPrice: PX,
        leverage: 20,
        upnlUsd: 0,
        fundingUsd: 0,
        feesUsd: 0,
        imUsd: 500,
        openedAt: NOW - 86_400,
        // A LONG that received −5% paid 5%: Gate's rate is 5%, longs pay.
        fundingApr7d: -0.05,
      },
    ],
    perpClosed: [],
    borosOpen: [
      {
        marketId: 9,
        venue: spread[0],
        spreadVenues: spread,
        maturity: NOV27,
        collateral: 'ETH',
        side,
        sizeToken: 4,
        notionalUsd: 4 * PX,
        entryApr: 0.02,
        markApr: 0.02,
        floatingApr,
        settleUsd: 0,
        mtmUsd: 0,
        imUsd: 100,
        settleFeeApr: 0.002,
      },
    ],
    borosHistory: [],
  });

  it.each([
    ['HL-GATE, floating HL − Gate = 3%', ['HYPERLIQUID', 'GATE'] as [string, string], 'SHORT' as const, 0.03],
    ['GATE-HL, floating Gate − HL = −3%', ['GATE', 'HYPERLIQUID'] as [string, string], 'LONG' as const, -0.03],
  ])('%s: HL reads 8%%', (_name, spread, side, floatingApr) => {
    const d = deriveAsset(g(spread, side, floatingApr), {}, 0, NOW);
    expect(d.lockedAprFwd).toBeNull();
    const e = d.unlockedEstimate;
    expect(e).not.toBeNull();
    const hl = e!.venues.find((v) => v.venue === 'HYPERLIQUID')!;
    expect(hl.fundingApr).toBeCloseTo(0.08, 12);
    expect(hl.source).toBe('current');
    expect(hl.gapUsd).toBeCloseTo(4 * PX, 6);
    expect(e!.venues.find((v) => v.venue === 'GATE')).toBeUndefined();
  });

  it('no rate on the other venue either: still no estimate', () => {
    const book = g(['HYPERLIQUID', 'GATE'], 'SHORT', 0.03);
    book.perpOpen[0].fundingApr7d = null;
    expect(deriveAsset(book, {}, 0, NOW).unlockedEstimate).toBeNull();
  });
});
