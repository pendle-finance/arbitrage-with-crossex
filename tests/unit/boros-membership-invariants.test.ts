/**
 * Invariants the membership solve must hold for ANY set of assertions.
 *
 * The use-case suite checks the cases someone thought of. This one generates
 * them — thousands of random row sets over a fixed book — and asserts only the
 * things that must be true no matter what was asserted. Every bug in this
 * feature so far has been a case nobody enumerated: a leg claimed twice, size
 * that fell off the page, a card that stopped rendering. Those are all
 * invariant violations, so they are caught here without being predicted.
 *
 * Deterministic: a seeded PRNG, so a failure names a seed that reproduces it.
 */
import { describe, expect, it } from 'vitest';
import type { BorosCollateralZone, BorosMarket, BorosTxn } from '../../src/core/boros/client';
import { decodeMembership, encodeMembership } from '../../src/core/boros/partition';
import {
  buildStrategies,
  type MembershipRow,
  type PerpPositionLike,
  type StrategyReturns,
} from '../../src/core/boros/returns';
import { imInputs, raw } from '../helpers/boros-fixtures';

const NOW = 1_787_300_000;
const SEP = 1_790_294_400;
const DEC = 1_798_156_800;
const OPENED = NOW - 86_400;

const HL = 'HYPERLIQUID_FUTURE_ETH_USDC';
const BIN = 'BINANCE_FUTURE_ETH_USDT';
const GATE = 'GATE_FUTURE_ETH_USDT';
/** Two maturities, so cohort handling is exercised too. */
const MARKETS = [
  { id: 129, venue: 'Binance', maturity: DEC, side: 0 as const, size: 0.013 },
  { id: 128, venue: 'Hyperliquid', maturity: DEC, side: 1 as const, size: 0.013 },
  { id: 101, venue: 'Binance', maturity: SEP, side: 0 as const, size: 0.005 },
  { id: 102, venue: 'Hyperliquid', maturity: SEP, side: 1 as const, size: 0.005 },
];
const PERPS = [
  { symbol: HL, side: 'SHORT' as const, qty: 0.047 },
  { symbol: BIN, side: 'LONG' as const, qty: 0.024 },
  { symbol: GATE, side: 'LONG' as const, qty: 0.023 },
];

const market = (m: (typeof MARKETS)[number]): BorosMarket => ({
  maxRateDeviationApr: 0.016,
  marketId: m.id,
  tokenId: 2,
  name: `${m.venue} ETH ${m.maturity}`,
  venue: m.venue,
  base: 'ETH',
  maturity: m.maturity,
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

const perpPosition = (p: (typeof PERPS)[number]): PerpPositionLike => ({
  symbol: p.symbol,
  positionSide: p.side,
  positionQty: p.side === 'SHORT' ? String(-p.qty) : String(p.qty),
  positionValue: String(p.qty * 2_300),
  entryPrice: '2300',
  upnl: '0',
  fundingFee: '0',
  fee: '0',
  initialMargin: '10',
  createTime: String(OPENED * 1000),
});

const run = (rows: MembershipRow[]): StrategyReturns =>
  buildStrategies({
    address: '0x' + 'ab'.repeat(20),
    zones: [
      {
        tokenId: 2,
        cross: {
          isCross: true,
          netBalance: raw(1),
          marketPositions: MARKETS.map((m) => ({
            marketId: m.id,
            side: m.side,
            notionalSize: raw(m.side === 1 ? -m.size : m.size),
            fixedApr: 0.05,
            markApr: 0.05,
            pnl: { rateSettlementPnl: raw(0), unrealisedPnl: raw(0) },
            positionInitialMargin: raw(0.001),
          })),
        },
        isolated: [],
      } satisfies BorosCollateralZone,
    ],
    markets: MARKETS.map(market),
    txnsByToken: new Map<number, BorosTxn[]>([
      [
        2,
        MARKETS.map((m) => ({
          marketId: m.id,
          time: OPENED,
          fee: raw(0),
          pnl: raw(0),
          prevPositionS: '0',
          postPositionS: raw(m.side === 1 ? -m.size : m.size),
          fixedApr: 0.05,
        })),
      ],
    ]),
    pricesUsd: new Map([[2, 2_300]]),
    perpPositions: PERPS.map(perpPosition),
    nowSec: NOW,
    // Through the wire, exactly as the browser sends it.
    membership: decodeMembership(encodeMembership(rows)) ?? [],
  });

/** xorshift32 — a seed reproduces a failing case exactly. */
function prng(seed: number) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** A random, possibly nonsensical, set of assertions. */
function randomRows(rnd: () => number): MembershipRow[] {
  const ids = ['aaaa0001', 'bbbb0002', 'cccc0003'];
  const legs: MembershipRow['leg'][] = [
    ...PERPS.map((p) => ({ kind: 'perp' as const, symbol: p.symbol })),
    ...MARKETS.map((m) => ({ kind: 'boros' as const, marketId: m.id })),
  ];
  const rows: MembershipRow[] = [];
  for (const leg of legs) {
    // Each leg gets 0, 1 or 2 rows — two is the contradictory case worth
    // exploring, not an error to avoid.
    const n = Math.floor(rnd() * 3.4);
    for (let i = 0; i < n; i += 1) {
      const owner = rnd();
      const positionId = owner < 0.2 ? undefined : ids[Math.floor(rnd() * ids.length)];
      const whole =
        leg.kind === 'perp'
          ? (PERPS.find((p) => p.symbol === leg.symbol)?.qty ?? 0)
          : (MARKETS.find((m) => m.id === leg.marketId)?.size ?? 0);
      const q = rnd();
      const qty =
        q < 0.3
          ? undefined
          : q < 0.4
            ? 0 // "holds none of it"
            : q < 0.5
              ? whole * 1e-9 // a sliver, to probe the dust guards
              : q < 0.7
                ? whole * rnd()
                : q < 0.85
                  ? whole
                  : whole * (1 + rnd() * 10);
      rows.push({ positionId, leg, ...(qty === undefined ? {} : { qty }) });
    }
  }
  return rows;
}

const DUST = 1e-9;

function checkInvariants(out: StrategyReturns, label: string) {
  // 1 · Nothing is lost and nothing is invented, per venue perp position.
  //     ALL of it must be on cards: size nobody claimed is a one-leg unhedged
  //     position, which is a card like any other.
  for (const p of PERPS) {
    const onCards = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'perp' && l.symbol === p.symbol)
      .reduce((a, l) => a + (l.notionalToken ?? 0), 0);
    expect(onCards, `${label}: ${p.symbol} not conserved`).toBeCloseTo(p.qty, 6);
  }

  // 2 · Same for every Boros market — an unmatched card counts, that is what
  //     it is for.
  for (const m of MARKETS) {
    const onCards = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'boros' && l.marketId === m.id)
      .reduce((a, l) => a + (l.notionalToken ?? 0), 0);
    expect(onCards, `${label}: market ${m.id} not conserved`).toBeCloseTo(m.size, 6);
  }

  // 3 · Ids are unique — they key the client's pins, exclusions and React rows.
  const ids = out.strategies.map((s) => s.strategyId);
  expect(new Set(ids).size, `${label}: duplicate strategyId in ${ids}`).toBe(ids.length);

  // 4 · No leg is negative or non-finite, however contradictory the input.
  for (const l of out.strategies.flatMap((s) => s.legs)) {
    expect(Number.isFinite(l.notionalUsd), `${label}: non-finite notional`).toBe(true);
    expect(l.notionalToken ?? 0, `${label}: negative size on ${l.venue}`).toBeGreaterThanOrEqual(
      -DUST,
    );
  }
}

describe('membership invariants — random assertions over a two-maturity book', () => {
  it('holds for 3000 random row sets', () => {
    const rnd = prng(20260821);
    for (let i = 0; i < 3000; i += 1) {
      const rows = randomRows(rnd);
      let out: StrategyReturns;
      try {
        out = run(rows);
      } catch (err) {
        throw new Error(`case ${i} threw on ${JSON.stringify(rows)}: ${(err as Error).message}`);
      }
      checkInvariants(out, `case ${i} rows=${JSON.stringify(rows)}`);
    }
  });

  it('is deterministic — the same assertions always give the same book', () => {
    const rnd = prng(7);
    for (let i = 0; i < 40; i += 1) {
      const rows = randomRows(rnd);
      const a = run(rows);
      const b = run(rows);
      expect(a.strategies.map((s) => [s.strategyId, s.legs.map((l) => l.notionalToken)])).toEqual(
        b.strategies.map((s) => [s.strategyId, s.legs.map((l) => l.notionalToken)]),
      );
    }
  });

  it('holds with no assertions at all, and with assertions that name nothing real', () => {
    checkInvariants(run([]), 'empty');
    checkInvariants(
      run([
        { positionId: 'aaaa0001', leg: { kind: 'perp', symbol: 'NOPE_FUTURE_X_Y' } },
        { positionId: 'aaaa0001', leg: { kind: 'boros', marketId: 424_242 } },
        { leg: { kind: 'boros', marketId: 424_243 } },
      ]),
      'all-dangling',
    );
  });
});
