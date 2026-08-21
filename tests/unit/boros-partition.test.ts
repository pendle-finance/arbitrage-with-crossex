/**
 * The partition solver (src/core/boros/partition.ts): rebuilding the tranches
 * that compose a netted venue position, the FIFO-close doctrine, pins, the
 * proximity fallback and its confidence labelling, and the Boros fill replay
 * that recovers a per-strategy fixed rate from a blended one.
 */
import { describe, expect, it } from 'vitest';
import type { BorosTxn } from '../../src/core/boros/client';
import {
  borosIncrements,
  decodeMembership,
  encodeMembership,
  solvePerpPartition,
  type MembershipRow,
  type PerpFillRecord,
  type PerpLegSnapshot,
} from '../../src/core/boros/partition';
import { raw } from '../helpers/boros-fixtures';

const T0 = 1_752_000_000;
const DAY = 86_400;

const pos = (over: Partial<PerpLegSnapshot> & Pick<PerpLegSnapshot, 'symbol' | 'venue' | 'side' | 'qty'>): PerpLegSnapshot => ({
  base: 'ETH',
  entryPrice: 1_900,
  openedAtSec: T0,
  ...over,
});

const HL = 'HYPERLIQUID_FUTURE_ETH_USDC';
const OKX = 'OKX_FUTURE_ETH_USDT';
const BIN = 'BINANCE_FUTURE_ETH_USDT';

/** One engine-tagged execution: both legs share the pair hash. */
function exec(hash: string, timeSec: number, legs: Array<[string, 'BUY' | 'SELL', number, number, number]>): PerpFillRecord[] {
  return legs.map(([symbol, side, qty, price, feeUsd], i) => ({
    symbol,
    side,
    qty,
    price,
    feeUsd,
    timeSec,
    text: `t${hash}${i === 0 ? 'A' : 'B'}1`,
  }));
}

describe('solvePerpPartition — the shared-leg scenario', () => {
  // One HL short of 250 ETH is really two strategies: 100 against OKX opened
  // on day 0, 150 against Binance opened on day 1. The venue reports one HL
  // row at the blended entry of 1903.6, and only the fill record can say which
  // part belongs where.
  const positions = [
    pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 250, entryPrice: 1903.6 }),
    pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 100, entryPrice: 1900.4 }),
    pos({ symbol: BIN, venue: 'BINANCE', side: 'LONG', qty: 150, entryPrice: 1905.8, openedAtSec: T0 + DAY }),
  ];
  const fills = [
    ...exec('aaaaaaa', T0, [
      [OKX, 'BUY', 100, 1900.4, 19],
      [HL, 'SELL', 100, 1900, 21],
    ]),
    ...exec('bbbbbbb', T0 + DAY, [
      [BIN, 'BUY', 150, 1905.8, 28],
      [HL, 'SELL', 150, 1906, 31],
    ]),
  ];

  it('splits the shared leg by the execution record, with each tranche keeping its own prices and fees', () => {
    const out = solvePerpPartition({ positions, fills });
    expect(out.reconciled).toBe(true);
    expect(out.residuals).toEqual([]);
    expect(out.tranches).toHaveLength(2);

    const binance = out.tranches.find((t) => t.long.venue === 'BINANCE')!;
    const okx = out.tranches.find((t) => t.long.venue === 'OKX')!;

    // The sizes are what the pairing itself yields — no price scoring needed.
    expect(okx.qty).toBe(100);
    expect(binance.qty).toBe(150);
    // Each tranche keeps its OWN entry prices, not the venue's 1903.6 blend.
    expect(okx.short.entryPrice).toBe(1900);
    expect(binance.short.entryPrice).toBe(1906);
    // Shares of the shared HL leg add back to the whole position.
    expect(okx.short.share + binance.short.share).toBeCloseTo(1, 12);
    expect(okx.short.share).toBeCloseTo(100 / 250, 12);
    // Per-fill fees are exact, so no pro-rata split of a cumulative scalar.
    expect(okx.short.feesUsd).toBeCloseTo(21, 12);
    expect(binance.long.feesUsd).toBeCloseTo(28, 12);
    // Measured from the record — not a proposal.
    expect(okx.source).toBe('fill-history');
    expect(okx.confidence).toBe('measured');
  });

  it('recovers each strategy\'s own crossing cost, which the blended entries cannot', () => {
    const out = solvePerpPartition({ positions, fills });
    const slip = (t: (typeof out.tranches)[number]) =>
      (t.long.entryPrice! - t.short.entryPrice!) * t.qty;
    const okx = out.tranches.find((t) => t.long.venue === 'OKX')!;
    const binance = out.tranches.find((t) => t.long.venue === 'BINANCE')!;
    expect(slip(okx)).toBeCloseTo(40, 9);
    expect(slip(binance)).toBeCloseTo(-30, 9);
    // The venue's blended gap only ever knew the SUM of those two.
    expect(slip(okx) + slip(binance)).toBeCloseTo(10, 9);
  });

  it('falls back to proximity when no record explains the book, and says it is unconfirmed', () => {
    const out = solvePerpPartition({ positions });
    expect(out.reconciled).toBe(true);
    expect(out.tranches).toHaveLength(2);
    expect(out.tranches.every((t) => t.source === 'proximity')).toBe(true);
    expect(out.tranches.every((t) => t.confidence === 'unconfirmed')).toBe(true);
    // Sizes still come out right — they never depended on the prices.
    expect(out.tranches.map((t) => t.qty).sort((a, b) => a - b)).toEqual([100, 150]);
    // But the SHARED leg may not claim a price: 1903.6 is an average over both
    // strategies, so splitting it would invent a crossing cost. The unshared
    // counterparts keep their own entries.
    for (const t of out.tranches) {
      expect(t.short.entryPrice).toBeNull();
      expect(t.long.entryPrice).toBeGreaterThan(0);
    }
  });
});

describe('solvePerpPartition — pairing rules', () => {
  it('keeps a 3-venue ring alive instead of netting every venue to zero', () => {
    // HL short 100 / Binance long 100 · Binance short 60 / OKX long 60 …
    // netting per venue would cancel Binance entirely and lose two strategies.
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 100, entryPrice: 1900 }),
      pos({ symbol: BIN, venue: 'BINANCE', side: 'LONG', qty: 100, entryPrice: 1900.2 }),
      pos({ symbol: 'BINANCE_FUTURE_ETH_USDC', venue: 'BINANCE', side: 'SHORT', qty: 60, entryPrice: 1950, openedAtSec: T0 + 10 * DAY }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 60, entryPrice: 1950.1, openedAtSec: T0 + 10 * DAY }),
    ];
    const out = solvePerpPartition({ positions });
    expect(out.tranches).toHaveLength(2);
    expect(out.tranches.map((t) => t.qty).sort((a, b) => a - b)).toEqual([60, 100]);
    expect(out.residuals).toEqual([]);
  });

  it('makes ONE tranche per venue pair, however far apart the fills', () => {
    // The spec pairs POSITIONS, not fills: "take the best pair, size it
    // min(qtyLong, qtyShort), decrement both, repeat". A venue pair is paired
    // once, so a position's size splits across the several PAIRS it hedges —
    // never across time on one pair. Two HL/OKX entries a week apart are one
    // strategy at the weighted-average entry.
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 300 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 300 }),
    ];
    const fills = [
      ...exec('ddddddd', T0, [[OKX, 'BUY', 100, 1800, 1], [HL, 'SELL', 100, 1801, 1]]),
      ...exec('eeeeeee', T0 + 7 * DAY, [[OKX, 'BUY', 200, 2000, 2], [HL, 'SELL', 200, 2002, 2]]),
    ];
    const out = solvePerpPartition({ positions, fills });
    expect(out.tranches).toHaveLength(1);
    expect(out.tranches[0].qty).toBe(300);
    // Entries are the fills' weighted average, which is still the tranche's
    // OWN price — the fill record is what makes it knowable at all.
    expect(out.tranches[0].long.entryPrice).toBeCloseTo((100 * 1800 + 200 * 2000) / 300, 9);
    expect(out.tranches[0].short.entryPrice).toBeCloseTo((100 * 1801 + 200 * 2002) / 300, 9);
    // Per-fill fees still sum exactly rather than being pro-rated.
    expect(out.tranches[0].long.feesUsd).toBeCloseTo(3, 9);
  });

  it('still treats clips of one book as one tranche', () => {
    // Three executions within the same day are one strategy being filled, not
    // three strategies — splitting those would be noise.
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 300 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 300 }),
    ];
    const fills = [
      ...exec('fffffff', T0, [[OKX, 'BUY', 100, 1900, 1], [HL, 'SELL', 100, 1901, 1]]),
      ...exec('ggggggg', T0 + 1200, [[OKX, 'BUY', 100, 1902, 1], [HL, 'SELL', 100, 1903, 1]]),
      ...exec('hhhhhhh', T0 + 3600, [[OKX, 'BUY', 100, 1904, 1], [HL, 'SELL', 100, 1905, 1]]),
    ];
    const out = solvePerpPartition({ positions, fills });
    expect(out.tranches).toHaveLength(1);
    expect(out.tranches[0].qty).toBe(300);
  });

  it('a single long against a single short is forced, not guessed', () => {
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 531 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 531 }),
    ];
    const out = solvePerpPartition({ positions });
    expect(out.tranches).toHaveLength(1);
    expect(out.tranches[0].source).toBe('forced');
    expect(out.tranches[0].confidence).toBe('measured');
  });

  it('never pairs legs of different coins', () => {
    // A BTC long and an ETH short are both residuals and both alone on their
    // side of the book — judged across the whole account that reads as a
    // forced pairing, and 2 BTC would be taken out of a 50 ETH short.
    const out = solvePerpPartition({
      positions: [
        pos({ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', side: 'LONG', qty: 2, base: 'BTC', entryPrice: 60_000 }),
        pos({ symbol: OKX, venue: 'OKX', side: 'SHORT', qty: 50, entryPrice: 3_000 }),
      ],
    });
    expect(out.tranches).toEqual([]);
    expect(out.residuals.map((r) => r.base).sort()).toEqual(['BTC', 'ETH']);
    expect(out.reconciled).toBe(true);
  });

  it('prices the unexplained remainder, not the whole-leg blend again', () => {
    // Fills explain half the book at 2000; the venue's blend of 2100 over 100
    // therefore implies the other half was entered at 2200. Re-using 2100 for
    // the remainder would count the explained fills twice.
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'LONG', qty: 100, entryPrice: 2100 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'SHORT', qty: 100, entryPrice: 2000 }),
    ];
    const fills = exec('iiiiiii', T0, [
      [HL, 'BUY', 50, 2000, 1],
      [OKX, 'SELL', 50, 2000, 1],
    ]);
    const out = solvePerpPartition({ positions, fills });
    const whole = out.tranches.find((t) => t.long.symbol === HL)!;
    expect(whole.qty).toBe(100);
    // (50 × 2000 + 50 × 2200) / 100 = 2100 — the venue's own average, restored.
    expect(whole.long.entryPrice).toBeCloseTo(2100, 9);
  });

  it('merges clips of one book across UTC midnight', () => {
    // 23:58 and 00:03 are five minutes apart; a calendar-day bucket would file
    // them as two strategies.
    const beforeMidnight = 1_767_225_480; // 2026-01-01 23:58:00 UTC
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 200 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 200 }),
    ];
    const fills = [
      ...exec('jjjjjjj', beforeMidnight, [[OKX, 'BUY', 100, 1900, 1], [HL, 'SELL', 100, 1901, 1]]),
      ...exec('kkkkkkk', beforeMidnight + 300, [[OKX, 'BUY', 100, 1902, 1], [HL, 'SELL', 100, 1903, 1]]),
    ];
    const out = solvePerpPartition({ positions, fills });
    expect(out.tranches).toHaveLength(1);
    expect(out.tranches[0].qty).toBe(200);
  });

  it('reports what nothing could hedge as an unhedged residual', () => {
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 250 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 100 }),
    ];
    const out = solvePerpPartition({ positions });
    expect(out.tranches[0].qty).toBe(100);
    expect(out.residuals).toEqual([
      { symbol: HL, venue: 'HYPERLIQUID', base: 'ETH', side: 'SHORT', qty: 150, share: 0.6 },
    ]);
    expect(out.reconciled).toBe(true);
  });

  it('composes the live book from the NEWEST opens — closes are FIFO', () => {
    // Three opens of 100 each, but only 150 is still open: the two most recent
    // opens compose it (50 of the middle one), never the oldest.
    const positions = [
      pos({ symbol: HL, venue: 'HYPERLIQUID', side: 'SHORT', qty: 150, entryPrice: 1900 }),
      pos({ symbol: OKX, venue: 'OKX', side: 'LONG', qty: 150, entryPrice: 1900 }),
    ];
    const fills = [
      ...exec('ccccccc', T0, [[OKX, 'BUY', 100, 1800, 1], [HL, 'SELL', 100, 1800, 1]]),
      ...exec('ddddddd', T0 + DAY, [[OKX, 'BUY', 100, 1900, 1], [HL, 'SELL', 100, 1900, 1]]),
      ...exec('eeeeeee', T0 + 2 * DAY, [[OKX, 'BUY', 100, 2000, 1], [HL, 'SELL', 100, 2000, 1]]),
    ];
    const out = solvePerpPartition({ positions, fills });
    const qty = out.tranches.reduce((s, t) => s + t.qty, 0);
    expect(qty).toBe(150);
    const prices = out.tranches.flatMap((t) => [t.long.entryPrice]).filter(Boolean);
    // The 1800 open was closed away; only 1900 and 2000 survive.
    expect(prices.some((p) => Math.abs((p ?? 0) - 1800) < 1)).toBe(false);
  });
});

describe('borosIncrements — un-blending a netted fixed rate', () => {
  const txn = (over: Partial<BorosTxn>): BorosTxn => ({
    marketId: 155,
    time: T0,
    fee: raw(0),
    pnl: raw(0),
    prevPositionS: '0',
    postPositionS: raw(-100),
    fixedApr: 0.07,
    ...over,
  });

  it('recovers each fill\'s own rate from a position that reports only the blend', () => {
    const txns = [
      txn({ time: T0, prevPositionS: '0', postPositionS: raw(-190_000), fixedApr: 0.07 }),
      txn({ time: T0 + DAY, prevPositionS: raw(-190_000), postPositionS: raw(-475_900), fixedApr: 0.065 }),
    ];
    const inc = borosIncrements(txns, 155, 475_900)!;
    expect(inc.map((i) => i.fixedApr)).toEqual([0.07, 0.065]);
    expect(inc.reduce((s, i) => s + i.qty, 0)).toBeCloseTo(475_900, 6);
    // The blend the venue reports is exactly the notional-weighted average —
    // which is why it can be taken apart again.
    const blended = inc.reduce((s, i) => s + i.qty * i.fixedApr, 0) / 475_900;
    expect(blended).toBeCloseTo((190_000 * 0.07 + 285_900 * 0.065) / 475_900, 12);
  });

  it('scales what is still open so it still averages to the venue\'s rate', () => {
    // A reduce does not re-average the venue's rate, so the surviving 200 is
    // still the blend of both opens (100 @9% + 200 @5% = 6.33%). Keeping only
    // the newest would hand the strategy 5% — a rate the venue never charged.
    const txns = [
      txn({ time: T0, prevPositionS: '0', postPositionS: raw(-100), fixedApr: 0.09 }),
      txn({ time: T0 + DAY, prevPositionS: raw(-100), postPositionS: raw(-300), fixedApr: 0.05 }),
    ];
    const inc = borosIncrements(txns, 155, 200)!;
    expect(inc.reduce((s, i) => s + i.qty, 0)).toBeCloseTo(200, 9);
    const blended = inc.reduce((s, i) => s + i.qty * i.fixedApr, 0) / 200;
    expect(blended).toBeCloseTo((100 * 0.09 + 200 * 0.05) / 300, 12);
  });

  it('orders same-second fills by the position chain, not by time alone', () => {
    // One order filling across three book levels stamps one second.
    const txns = [
      txn({ time: T0, prevPositionS: raw(-70), postPositionS: raw(-100), fixedApr: 0.03 }),
      txn({ time: T0, prevPositionS: '0', postPositionS: raw(-40), fixedApr: 0.01 }),
      txn({ time: T0, prevPositionS: raw(-40), postPositionS: raw(-70), fixedApr: 0.02 }),
    ];
    const inc = borosIncrements(txns, 155, 100)!;
    expect(inc.map((i) => i.fixedApr)).toEqual([0.01, 0.02, 0.03]);
    expect(inc.map((i) => i.qty)).toEqual([40, 30, 30]);
  });

  it('a position that FLIPPED through zero keeps only the new side', () => {
    // One fill closes the long and opens a short (the venue's tradeDirection 2).
    // The opening size is the WHOLE new side, and the closed side's rate is
    // gone — not blended into the survivor.
    const txns = [
      txn({ time: T0, prevPositionS: '0', postPositionS: raw(10), fixedApr: 0.05 }),
      txn({ time: T0 + DAY, prevPositionS: raw(10), postPositionS: raw(-40), fixedApr: 0.09 }),
    ];
    expect(borosIncrements(txns, 155, 40)).toEqual([{ timeSec: T0 + DAY, qty: 40, fixedApr: 0.09 }]);
  });

  it('bails when the replay disagrees with the rate the venue reports', () => {
    // entryApr on a reducing fill is the venue's own average of everything
    // before it. If our replay cannot reproduce it, this history did not build
    // this position — the caller must fall back to the blended rate, not show
    // a confident per-strategy one.
    const txns = [
      txn({ time: T0, prevPositionS: '0', postPositionS: raw(100), fixedApr: 0.05 }),
      txn({ time: T0 + DAY, prevPositionS: raw(100), postPositionS: raw(60), fixedApr: 0.06, entryApr: 0.09 }),
    ];
    expect(borosIncrements(txns, 155, 60)).toBeNull();
  });

  it('chains a close and its re-open when they share a second', () => {
    // Sorting a same-second group by size (either way) would replay these out
    // of order and mis-weight every rate after them.
    const txns = [
      txn({ time: T0, prevPositionS: '0', postPositionS: raw(100), fixedApr: 0.04 }),
      txn({ time: T0 + DAY, prevPositionS: '0', postPositionS: raw(-80), fixedApr: 0.07 }),
      txn({ time: T0 + DAY, prevPositionS: raw(100), postPositionS: '0', fixedApr: 0.041, entryApr: 0.04 }),
    ];
    expect(borosIncrements(txns, 155, 80)).toEqual([{ timeSec: T0 + DAY, qty: 80, fixedApr: 0.07 }]);
  });

  it('refuses when the history cannot explain the live size', () => {
    const txns = [txn({ prevPositionS: '0', postPositionS: raw(-10), fixedApr: 0.07 })];
    expect(borosIncrements(txns, 155, 1_000)).toBeNull();
    // …and when a row carries no rate at all.
    const noRate = [txn({ prevPositionS: '0', postPositionS: raw(-10), fixedApr: undefined })];
    expect(borosIncrements(noRate, 155, 10)).toBeNull();
  });
});


describe('membership codec', () => {
  const rows: MembershipRow[] = [
    { positionId: 'a3f1c8d2', leg: { kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDT' } },
    { positionId: 'a3f1c8d2', leg: { kind: 'boros', marketId: 129 }, qty: 0.013 },
    // No positionId: the leg belongs to nothing — the old qty-0 detach.
    { leg: { kind: 'perp', symbol: 'GATE_FUTURE_ETH_USDT' } },
  ];

  /** The exact bytes the rows above must encode to. The browser keeps its own
   * copy of this codec (web/src/panels/partitionStore.ts, btoa-based where
   * this one uses Buffer), and web/src/panels/partitionStore.test.ts pins the
   * SAME vector — so a field added to one copy and not the other fails a test
   * instead of silently dropping every user's assertions. */
  const GOLDEN =
    'eyJ2IjozLCJyIjpbeyJwIjoiYTNmMWM4ZDIiLCJrIjoicCIsInIiOiJCSU5BTkNFX0ZVVFVSRV9FVEhfVVNEVCJ9LHsicCI6ImEzZjFjOGQyIiwiayI6ImIiLCJyIjoxMjksInEiOjAuMDEzfSx7ImsiOiJwIiwiciI6IkdBVEVfRlVUVVJFX0VUSF9VU0RUIn1dfQ';

  it('encodes to the golden vector the browser copy must also produce', () => {
    expect(encodeMembership(rows)).toBe(GOLDEN);
    expect(decodeMembership(GOLDEN)).toEqual(rows);
  });

  it('round-trips through the query-string encoding', () => {
    const encoded = encodeMembership(rows);
    expect(encoded).not.toMatch(/[+/=]/); // base64url — safe in a URL as-is
    expect(decodeMembership(encoded)).toEqual(rows);
  });

  it('keeps "all of it" distinct from a size of zero', () => {
    // An absent qty means "everything unclaimed"; 0 means "none". Collapsing
    // them would turn a claim into a detach.
    const wire = (r: MembershipRow) => JSON.parse(atob(encodeMembership([r]))) as { r: [{ q?: number }] };
    expect(wire({ positionId: 'aa', leg: { kind: 'boros', marketId: 1 } }).r[0].q).toBeUndefined();
    expect(wire({ positionId: 'aa', leg: { kind: 'boros', marketId: 1 }, qty: 0 }).r[0].q).toBe(0);
  });

  it('reads an empty payload as "no assertions", not as a broken link', () => {
    // Null is reserved for input that could not be READ — the route turns it
    // into a warning, and a payload asking for nothing has nothing to warn
    // about.
    expect(decodeMembership(Buffer.from('{"v":3,"r":[]}').toString('base64url'))).toEqual([]);
    const allInvalid = Buffer.from(
      JSON.stringify({ v: 3, r: [{ k: 'p', r: 'not a symbol' }] }),
    ).toString('base64url');
    expect(decodeMembership(allInvalid)).toEqual([]);
  });

  it('applies one row per (position, leg) even when the payload repeats it', () => {
    const repeated = Buffer.from(
      JSON.stringify({
        v: 3,
        r: [
          { p: 'aa', k: 'b', r: 129, q: 1 },
          { p: 'aa', k: 'b', r: 129, q: 2 },
        ],
      }),
    ).toString('base64url');
    // Last wins — applying both would claim the size twice.
    expect(decodeMembership(repeated)).toEqual([
      { positionId: 'aa', leg: { kind: 'boros', marketId: 129 }, qty: 2 },
    ]);
  });

  it('keeps the same leg in two DIFFERENT positions — that is a shared leg', () => {
    const shared = Buffer.from(
      JSON.stringify({
        v: 3,
        r: [
          { p: 'aa', k: 'b', r: 129, q: 1 },
          { p: 'bb', k: 'b', r: 129, q: 2 },
        ],
      }),
    ).toString('base64url');
    expect(decodeMembership(shared)).toHaveLength(2);
  });

  it('rejects anything malformed rather than half-applying it', () => {
    expect(decodeMembership('not-base64-json')).toBeNull();
    expect(decodeMembership(Buffer.from('{"v":4,"r":[]}').toString('base64url'))).toBeNull();
    expect(decodeMembership(Buffer.from('{"v":3}').toString('base64url'))).toBeNull();
  });

  it('drops individual rows that fail validation, keeping the good ones', () => {
    const payload = Buffer.from(
      JSON.stringify({
        v: 3,
        r: [
          { p: 'aa', k: 'p', r: 'BINANCE_FUTURE_ETH_USDT' },
          { p: 'aa<script>', k: 'p', r: 'BINANCE_FUTURE_ETH_USDT' }, // bad id
          { p: 'aa', k: 'b', r: 1.5 }, // marketId is an integer
          { p: 'aa', k: 'b', r: 129, q: -5 }, // negative size
          { p: 'aa', k: 'b', r: 129, q: null }, // a missing qty must not become 0
          { p: 'aa', k: 'x', r: 1 }, // unknown kind
        ],
      }),
    ).toString('base64url');
    expect(decodeMembership(payload)).toEqual([
      { positionId: 'aa', leg: { kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDT' }, qty: undefined },
    ]);
  });

  it('encodes nothing for an empty book, so the URL stays clean', () => {
    expect(encodeMembership([])).toBe('');
  });
});
