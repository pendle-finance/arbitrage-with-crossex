/**
 * Every membership use case, end to end: the rows the UI writes, through the
 * real decoder, into the real solve.
 *
 * ⚠ These go through `decodeMembership` on purpose. The per-component tests
 * assert that a control emits the right event and that the solver honours a
 * row — neither noticed that a position id which is not lowercase hex is
 * silently dropped by the decoder, so a whole class of assertion did nothing.
 * A test that starts at the wire is the only one that can catch that.
 *
 * Conservation is asserted on EVERY case: each venue position must be fully
 * accounted for across the cards plus the unhedged residuals. Losing size is
 * the one failure a delta-neutral terminal must never ship.
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
const MAT = 1_798_156_800;
const OPENED = NOW - 86_400;

const HL = 'HYPERLIQUID_FUTURE_ETH_USDC';
const BIN = 'BINANCE_FUTURE_ETH_USDT';
const GATE = 'GATE_FUTURE_ETH_USDT';
/** Boros ETH Dec: Binance long 0.013, Hyperliquid short 0.013. */
const BIN_BOROS = 129;
const HL_BOROS = 128;

/** Ids as the UI mints them: 8 lowercase hex. */
const BIN_POS = 'b1c00001';
const GATE_POS = 'a2c00002';

const market = (marketId: number, venue: string): BorosMarket => ({
  maxRateDeviationApr: 0.016,
  marketId,
  tokenId: 2,
  name: `${venue} ETH 25 Dec 2026`,
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

const perp = (symbol: string, side: 'LONG' | 'SHORT', qty: number): PerpPositionLike => ({
  symbol,
  positionSide: side,
  positionQty: side === 'SHORT' ? String(-qty) : String(qty),
  positionValue: String(qty * 2_300),
  entryPrice: '2300',
  upnl: '0',
  fundingFee: '0',
  fee: '0',
  initialMargin: '10',
  createTime: String(OPENED * 1000),
});

/** The live book this was verified against: one Hyperliquid short of 0.047
 * shared by a Binance pair (0.024) and a Gate pair (0.023), and one Boros
 * spread whose two legs the solver hands to different pairs. */
const book = (rows: MembershipRow[]): StrategyReturns =>
  buildStrategies({
    address: '0x' + 'ab'.repeat(20),
    zones: [
      {
        tokenId: 2,
        cross: {
          isCross: true,
          netBalance: raw(1),
          marketPositions: [
            { marketId: BIN_BOROS, side: 0, notionalSize: raw(0.013), fixedApr: 0.045, markApr: 0.045, pnl: { rateSettlementPnl: raw(0), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
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
          { marketId: HL_BOROS, time: OPENED, fee: raw(0), pnl: raw(0), prevPositionS: '0', postPositionS: raw(-0.013), fixedApr: 0.065 },
        ],
      ],
    ]),
    pricesUsd: new Map([[2, 2_300]]),
    perpPositions: [perp(HL, 'SHORT', 0.047), perp(BIN, 'LONG', 0.024), perp(GATE, 'LONG', 0.023)],
    nowSec: NOW,
    // THE POINT: the rows make the round trip the browser makes.
    membership: decodeMembership(encodeMembership(rows)) ?? [],
  });

const legsOf = (out: StrategyReturns, id: string) =>
  (out.strategies.find((s) => s.strategyId === id)?.legs ?? [])
    .map((l) => `${l.kind[0]}:${l.venue}:${(l.notionalToken ?? 0).toFixed(4)}`)
    .sort();
const ids = (out: StrategyReturns) => out.strategies.map((s) => s.strategyId);

/** A card the SOLVER named, found by what it holds. Its id encodes which
 * evidence tier produced it (#exec off fills, #auto off proximity), which is
 * not what any of these cases is about. */
const solverCard = (out: StrategyReturns, venue: string): string => {
  const s = out.strategies.find(
    (x) =>
      !/^[0-9a-f]{8}$/.test(x.strategyId) &&
      x.legs.some((l) => l.kind === 'perp' && l.venue === venue),
  );
  expect(s, `no solver card holding a ${venue} perp`).toBeDefined();
  return (s as { strategyId: string }).strategyId;
};

/** Every unit of every venue position is on a card — size nobody claimed gets
 * a one-leg unhedged position of its own. A leak is the failure that matters
 * most, so this runs on every case. */
function expectNothingLost(out: StrategyReturns) {
  for (const [venue, whole] of [
    ['HYPERLIQUID', 0.047],
    ['BINANCE', 0.024],
    ['GATE', 0.023],
  ] as const) {
    const onCards = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'perp' && l.venue === venue)
      .reduce((a, l) => a + (l.notionalToken ?? 0), 0);
    expect(onCards, `${venue} is not fully accounted for`).toBeCloseTo(whole, 9);
  }
}

/** The one-leg card that unclaimed size on `venue` turned into, if any. */
const unhedgedCard = (out: StrategyReturns, venue: string) =>
  out.strategies.find(
    (s) =>
      s.attribution.source === 'unhedged' && s.legs.some((l) => l.venue === venue),
  );

/**
 * The rows PositionsHome writes when it freezes a solver-proposed card: one
 * per leg, with a size only where the leg is shared. Derived from the card
 * rather than hardcoded, because freezing must preserve whatever the solver
 * decided — including decisions this fixture makes differently from the live
 * book it was modelled on.
 */
const freezeOf = (out: StrategyReturns, cardId: string, positionId: string): MembershipRow[] => {
  const card = out.strategies.find((x) => x.strategyId === cardId);
  expect(card, `no card ${cardId}`).toBeDefined();
  return (card as { legs: StrategyReturns['strategies'][number]['legs'] }).legs.flatMap((l) => {
    const leg =
      l.kind === 'perp'
        ? l.symbol
          ? ({ kind: 'perp', symbol: l.symbol } as const)
          : null
        : l.marketId === undefined
          ? null
          : ({ kind: 'boros', marketId: l.marketId } as const);
    if (!leg) return [];
    return [{ positionId, leg, ...((l.share ?? 1) < 0.999 ? { qty: l.notionalToken } : {}) }];
  });
};

/** Explicit cards for the cases that need a KNOWN starting split. */
const BIN_CARD: MembershipRow[] = [
  { positionId: BIN_POS, leg: { kind: 'perp', symbol: BIN } },
  { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.024 },
  { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS } },
];
const GATE_CARD: MembershipRow[] = [
  { positionId: GATE_POS, leg: { kind: 'perp', symbol: GATE } },
  { positionId: GATE_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.023 },
  { positionId: GATE_POS, leg: { kind: 'boros', marketId: HL_BOROS } },
];
const withoutBoros = (rows: MembershipRow[]) => rows.filter((r) => r.leg.kind !== 'boros');
const withoutHlPerp = (rows: MembershipRow[]) =>
  rows.filter((r) => !(r.leg.kind === 'perp' && r.leg.symbol === HL));

describe('membership use cases — the rows the UI writes, through the wire', () => {
  it('0 · leaves an unasserted book to the solver', () => {
    const out = book([]);
    expect(ids(out).filter((i) => i.startsWith('ETH'))).toHaveLength(2);
    expectNothingLost(out);
  });

  it('1 · freezing a card keeps exactly what the solver proposed', () => {
    // The first assertion on any card writes a row per leg. That must be a
    // no-op on the numbers, or every correction would also move something else.
    const before = book([]);
    const binId = solverCard(before, 'BINANCE');
    const gateId = solverCard(before, 'GATE');
    const after = book([
      ...freezeOf(before, binId, BIN_POS),
      ...freezeOf(before, gateId, GATE_POS),
    ]);
    expect(legsOf(after, BIN_POS)).toEqual(legsOf(before, binId));
    expect(legsOf(after, GATE_POS)).toEqual(legsOf(before, gateId));
    expectNothingLost(after);
  });

  it('2 · MOVES a Boros leg from one card to the other', () => {
    const out = book([
      ...withoutBoros(GATE_CARD),
      ...BIN_CARD,
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: HL_BOROS } },
    ]);
    // The Binance card ends up with the complete spread…
    expect(legsOf(out, BIN_POS)).toContain('b:HYPERLIQUID:0.0130');
    expect(legsOf(out, BIN_POS)).toContain('b:BINANCE:0.0130');
    // …and the Gate card keeps its perps and nothing else.
    expect(legsOf(out, GATE_POS).filter((l) => l.startsWith('b:'))).toEqual([]);
    expectNothingLost(out);
  });

  it('3 · DETACHES a Boros leg to nothing, surfacing it rather than deleting it', () => {
    const out = book([
      ...withoutBoros(GATE_CARD),
      ...BIN_CARD,
      { leg: { kind: 'boros', marketId: HL_BOROS } },
    ]);
    expect(legsOf(out, BIN_POS)).not.toContain('b:HYPERLIQUID:0.0130');
    expect(legsOf(out, GATE_POS)).not.toContain('b:HYPERLIQUID:0.0130');
    // It becomes unmatched Boros — visible, and undoable. Scaling it out of
    // its cohort instead would take it off the page entirely.
    const unmatched = ids(out).find((i) => i.endsWith('#unmatched'));
    expect(unmatched, 'the orphaned leg vanished').toBeDefined();
    expect(legsOf(out, unmatched as string)).toContain('b:HYPERLIQUID:0.0130');
    expectNothingLost(out);
  });

  it('4 · DETACHES a perp leg onto a one-leg unhedged position', () => {
    const out = book([...BIN_CARD, { leg: { kind: 'perp', symbol: GATE } }]);
    const card = unhedgedCard(out, 'GATE');
    expect(card, 'the detached leg vanished').toBeDefined();
    // A position holding exactly the leg, not a footnote listing it.
    expect(card?.legs.map((l) => `${l.kind}:${l.venue}`)).toEqual(['perp:GATE']);
    expect(card?.hedge).toBe('unhedged');
    expectNothingLost(out);
  });

  it('5 · ATTACHES unclaimed size — a card can take the WHOLE shared leg', () => {
    const out = book([
      ...withoutHlPerp(BIN_CARD),
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.047 },
    ]);
    expect(legsOf(out, BIN_POS)).toContain('p:HYPERLIQUID:0.0470');
    expectNothingLost(out);
  });

  it('6 · takes PART of a shared leg, leaving the rest to the solver', () => {
    const out = book([
      ...withoutHlPerp(BIN_CARD),
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.01 },
    ]);
    expect(legsOf(out, BIN_POS)).toContain('p:HYPERLIQUID:0.0100');
    // The Gate pair is still solved out of what was left.
    expect(solverCard(out, 'GATE')).toBeTruthy();
    expectNothingLost(out);
  });

  it('7 · CLAMPS an over-claim instead of inventing size', () => {
    const out = book([
      ...withoutHlPerp(BIN_CARD),
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 99 },
    ]);
    expect(legsOf(out, BIN_POS)).toContain('p:HYPERLIQUID:0.0470');
    expect(out.warnings.join(' ')).toMatch(/clamped, not rescaled/);
    expectNothingLost(out);
  });

  it('8 · DROPS an assertion whose leg the venue no longer has, silently', () => {
    // The overwhelmingly common reason a leg stops existing is that the user
    // CLOSED it. Warning about that greeted anyone who flattened their book
    // with amber naming every leg they had just deliberately closed — so a
    // dangling row is dropped without comment, and the rest still applies.
    const out = book([...BIN_CARD, { positionId: BIN_POS, leg: { kind: 'boros', marketId: 999_999 } }]);
    expect(out.warnings.join(' ')).not.toMatch(/no longer match/);
    expect(ids(out)).toContain(BIN_POS);
    expectNothingLost(out);
  });

  it('names legs in warnings the way the cards name them, never a raw symbol', () => {
    // These sentences are read by a person. A dangling leg has no build to
    // read a venue off, so the symbol has to be parsed rather than printed.
    const out = book([
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: 'OKX_FUTURE_ETH_USDT' } },
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: 999_999 } },
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 99 },
    ]);
    const said = out.warnings.join(' ');
    // Dangling legs no longer produce a warning at all (see 8), so the naming
    // guarantee is checked on the warnings that DO survive — the clamp note,
    // which names a live leg the same way the cards do.
    expect(said).toMatch(/HYPERLIQUID ETH perp/);
    expect(said, 'a raw venue symbol leaked into a warning').not.toMatch(/_FUTURE_/);
  });

  it('9 · UNDOES back to exactly the solver\'s own answer', () => {
    expect(ids(book([]))).toEqual(ids(book([])));
    const before = book([]);
    const after = book([]);
    for (const id of ids(before)) expect(legsOf(after, id)).toEqual(legsOf(before, id));
  });

  it('rejects a position id the UI could never mint, rather than half-applying it', () => {
    // The bug this file exists for: `bin00001` is not hex, so every row naming
    // it is dropped at the wire and the whole assertion silently does nothing.
    // Caught only by going through the decoder.
    const bad = BIN_CARD.map((r) => ({ ...r, positionId: 'bin00001' }));
    expect(decodeMembership(encodeMembership(bad))).toEqual([]);
    // …so the book comes back exactly as the solver left it.
    expect(ids(book(bad))).toEqual(ids(book([])));
  });
});

describe('membership use cases — a Boros-only card', () => {
  /**
   * The shape on screen: a Boros leg split between a real position and a card
   * with NO perp legs at all ("No matching perp legs for ETH…"). Moving the
   * sliver onto the real position is the obvious thing to want, and the only
   * card it can come FROM is one that has no perp pair — a case every other
   * test here misses, because they all move legs between hedged positions.
   */
  const halfClaimed: MembershipRow[] = [
    ...withoutBoros(BIN_CARD),
    // The Binance position takes only half its Boros long; the rest has no
    // perp pair to belong to and surfaces on its own card.
    { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065 },
  ];

  it('splits a Boros leg onto an unmatched card when nothing else can hold it', () => {
    const out = book(halfClaimed);
    expect(legsOf(out, BIN_POS)).toContain('b:BINANCE:0.0065');
    const unmatched = ids(out).find((i) => i.endsWith('#unmatched'));
    expect(unmatched, 'the unclaimed half vanished').toBeDefined();
    expect(legsOf(out, unmatched as string)).toContain('b:BINANCE:0.0065');
    expectNothingLost(out);
  });

  it('MOVES the sliver off that card onto the real position', () => {
    // What the picker writes: the source holds no perp, so freezing it writes
    // nothing that survives the release, and the destination claims the leg
    // whole (no qty = all of it).
    const out = book([...withoutBoros(BIN_CARD), { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS } }]);
    expect(legsOf(out, BIN_POS)).toContain('b:BINANCE:0.0130');
    // …and nothing is left over for an unmatched card.
    expect(ids(out).some((i) => i.endsWith('#unmatched'))).toBe(false);
    expectNothingLost(out);
  });

  it('a position with NO perps yet is an ordinary position, not a dropped assertion', () => {
    // A Boros spread whose hedge has not been opened is a normal state in this
    // book — the perps follow the spread. It used to be dropped, because a
    // user position could only exist as a long/short tranche.
    const out = book([{ positionId: 'cccc0003', leg: { kind: 'boros', marketId: HL_BOROS } }]);
    expect(ids(out)).toContain('cccc0003');
    expect(legsOf(out, 'cccc0003')).toEqual(['b:HYPERLIQUID:0.0130']);
    expectNothingLost(out);
  });

  it('claims BOTH Boros legs into one un-hedged position — the spread before the perps', () => {
    const out = book([
      { positionId: 'cccc0003', leg: { kind: 'boros', marketId: HL_BOROS } },
      { positionId: 'cccc0003', leg: { kind: 'boros', marketId: BIN_BOROS } },
    ]);
    expect(legsOf(out, 'cccc0003')).toEqual(['b:BINANCE:0.0130', 'b:HYPERLIQUID:0.0130']);
    // And nobody else got a share of them.
    const elsewhere = out.strategies
      .filter((s) => s.strategyId !== 'cccc0003')
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'boros');
    expect(elsewhere).toEqual([]);
    expectNothingLost(out);
  });

  it('adding the perps later grows the SAME position, keeping its id', () => {
    // The point of a minted id: the position survives its own legs changing.
    const spreadOnly = book([
      { positionId: 'cccc0003', leg: { kind: 'boros', marketId: HL_BOROS } },
      { positionId: 'cccc0003', leg: { kind: 'boros', marketId: BIN_BOROS } },
    ]);
    const hedged = book([
      { positionId: 'cccc0003', leg: { kind: 'boros', marketId: HL_BOROS } },
      { positionId: 'cccc0003', leg: { kind: 'boros', marketId: BIN_BOROS } },
      { positionId: 'cccc0003', leg: { kind: 'perp', symbol: BIN } },
      { positionId: 'cccc0003', leg: { kind: 'perp', symbol: HL }, qty: 0.024 },
    ]);
    expect(ids(spreadOnly)).toContain('cccc0003');
    expect(ids(hedged)).toContain('cccc0003');
    expect(legsOf(hedged, 'cccc0003')).toEqual([
      'b:BINANCE:0.0130',
      'b:HYPERLIQUID:0.0130',
      'p:BINANCE:0.0240',
      'p:HYPERLIQUID:0.0240',
    ]);
    expectNothingLost(hedged);
  });
});

/**
 * The mirror of the Boros-only card: move a card's only Boros leg away and it
 * keeps its perps. Everything below was found by driving the real UI — the card
 * rendered, but it described itself as a matured Boros position.
 */
describe('membership use cases — a card left holding only perps', () => {
  const perpsOnly = () =>
    book([
      ...withoutBoros(GATE_CARD),
      ...BIN_CARD,
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: HL_BOROS } },
    ]);

  it('has no maturity to have passed', () => {
    const card = perpsOnly().strategies.find((s) => s.strategyId === GATE_POS);
    expect(legsOf(perpsOnly(), GATE_POS)).toEqual(['p:GATE:0.0230', 'p:HYPERLIQUID:0.0230']);
    // 0 is the "no Boros legs" sentinel, NOT a date in 1970. The card reads it
    // back through `isMatured`, which is why that guard exists.
    expect(card?.maturity).toBe(0);
  });

  it('does not claim a Boros open time is missing when there is no Boros leg', () => {
    const card = perpsOnly().strategies.find((s) => s.strategyId === GATE_POS);
    expect(card?.warnings.filter((w) => /Boros open time is unknown/.test(w))).toEqual([]);
    // The clock still starts somewhere — the perps' own open.
    expect(card?.clockBasis).toBe('perp-open');
  });

  it('keeps the venue entry prices on legs it holds WHOLE, so slippage stays knowable', () => {
    // A stated size only forfeits the entry price when the leg is SHARED —
    // that is when the venue's blended average stops describing this position.
    // A whole claim IS the venue position, so nulling its entry threw away a
    // price the card needs and left it reporting unknown slippage.
    const out = book([
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: BIN } },
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL } },
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS } },
    ]);
    const card = out.strategies.find((s) => s.strategyId === BIN_POS);
    expect(card?.feesUsd.paid.perpEntrySlippageUsd).not.toBeNull();
    expect(card?.warnings.filter((w) => /Entry slippage/.test(w))).toEqual([]);
  });

  it('still withholds the entry price from a leg it only SHARES', () => {
    const card = perpsOnly().strategies.find((s) => s.strategyId === GATE_POS);
    // Gate is whole here, but Hyperliquid is 0.023 of a 0.047 venue position —
    // one blended average across two positions is not this one's entry.
    expect(card?.feesUsd.paid.perpEntrySlippageUsd).toBeNull();
    expect(card?.warnings.some((w) => /Entry slippage/.test(w))).toBe(true);
  });

  it('still accounts for every unit of the book', () => {
    expectNothingLost(perpsOnly());
  });
});

/**
 * Correcting a shared leg's ENTRY, through the wire.
 *
 * The venue reports one blended entry across every position sharing a leg. A
 * user who opened those halves at different prices can say what THEIR half
 * paid — and the other half must move to compensate, because the venue's
 * average is ground truth over the whole position. Asserting is dividing a
 * known total, never restating it.
 *
 * The bug this pins: the assertion used to be a label on the asserting card
 * only. The sibling kept showing the venue blend, so the two cards disagreed
 * about what one venue position cost.
 */
describe('entry assertions — the venue average is conserved across claims', () => {
  /** HL is shared 0.024 (Binance card) / 0.023 (Gate card) at a venue blend of
   * 2300 — so 0.047 × 2300 = 108.10 total, whatever the split claims. */
  const HL_QTY = 0.047;
  const VENUE_ENTRY = 2_300;

  /**
   * The observable: entry SLIPPAGE.
   *
   * `StrategyLeg` carries no entry price — the entry lives on the internal
   * build and reaches the user as the signed gap between the pair's two legs.
   * That is also the number the "entry slippage is unknown" banner is about,
   * so asserting on it tests the thing the user actually sees.
   */
  const slipOf = (out: StrategyReturns, positionId: string): number | null =>
    out.strategies.find((s) => s.strategyId === positionId)?.feesUsd.paid
      .perpEntrySlippageUsd ?? null;

  const assertHl = (rows: MembershipRow[], positionId: string, entry: number) =>
    rows.map((r) =>
      r.positionId === positionId && r.leg.kind === 'perp' && r.leg.symbol === HL
        ? { ...r, entry }
        : r,
    );

  it('gives BOTH cards a known entry slippage once one half is asserted', () => {
    // Hubert's case. Unasserted, a partial claim on the shared HL leg has no
    // price of its own, so neither card can compute entry slippage and both
    // show "unknown". Asserting one half fixes BOTH: the assertion pins this
    // card, and conservation implies the sibling's.
    const before = book([...BIN_CARD, ...GATE_CARD]);
    expect(slipOf(before, BIN_POS)).toBeNull();
    expect(slipOf(before, GATE_POS)).toBeNull();

    const out = book(assertHl([...BIN_CARD, ...GATE_CARD], BIN_POS, 2_280));
    const mine = slipOf(out, BIN_POS);
    const sibling = slipOf(out, GATE_POS);
    expect(mine).not.toBeNull();
    expect(sibling).not.toBeNull();

    // The invariant, read back out of the two cards. BIN is long at the venue
    // blend (2300) against its asserted 2280 short; GATE is long 2300 against
    // the implied sibling short. Recovering the two shorts from the slippage
    // must return the venue's own average over the whole 0.047.
    const binShort = 2_300 - (mine as number) / 0.024;
    const gateShort = 2_300 - (sibling as number) / 0.023;
    expect(binShort).toBeCloseTo(2_280, 6);
    expect(0.024 * binShort + 0.023 * gateShort).toBeCloseTo(VENUE_ENTRY * HL_QTY, 6);
    expectNothingLost(out);
  });

  it('puts the reconciled entry ON BOTH LEGS, so each card can show its own', () => {
    // The bug behind the screenshot: the fix reached entry SLIPPAGE but never
    // the per-leg Entry label, which fell back to the venue's blended figure.
    // The sibling therefore still read 2440 next to an asserted 2418, and the
    // two did not add back up to the venue average.
    const legEntry = (out: StrategyReturns, positionId: string): number | undefined => {
      const card = out.strategies.find((s) => s.strategyId === positionId);
      const leg = card?.legs.find((l) => l.kind === 'perp' && l.symbol === HL);
      return leg?.entryPrice;
    };
    const out = book(assertHl([...BIN_CARD, ...GATE_CARD], BIN_POS, 2_280));
    const mine = legEntry(out, BIN_POS);
    const sibling = legEntry(out, GATE_POS);
    expect(mine).toBeCloseTo(2_280, 9);
    expect(sibling).toBeDefined();
    // THE THING HUBERT CHECKED: the two, weighted by size, are the venue's own.
    expect(0.024 * (mine as number) + 0.023 * (sibling as number)).toBeCloseTo(
      VENUE_ENTRY * HL_QTY,
      6,
    );
    // And with nothing asserted the field stays absent, so the UI keeps
    // falling back to the venue figure exactly as it always did.
    const plain = book([...BIN_CARD, ...GATE_CARD]);
    expect(legEntry(plain, BIN_POS)).toBeUndefined();
    expect(legEntry(plain, GATE_POS)).toBeUndefined();
  });

  it('leaves an unasserted book exactly as it was', () => {
    // No assertion ⇒ no invented price anywhere, and the banner still applies.
    const out = book([...BIN_CARD, ...GATE_CARD]);
    expect(slipOf(out, BIN_POS)).toBeNull();
    expect(slipOf(out, GATE_POS)).toBeNull();
    expectNothingLost(out);
  });

  it('honours BOTH claims when both assert', () => {
    const rows = assertHl(assertHl([...BIN_CARD, ...GATE_CARD], BIN_POS, 2_280), GATE_POS, 2_320);
    const out = book(rows);
    expect(2_300 - (slipOf(out, BIN_POS) as number) / 0.024).toBeCloseTo(2_280, 6);
    expect(2_300 - (slipOf(out, GATE_POS) as number) / 0.023).toBeCloseTo(2_320, 6);
    expectNothingLost(out);
  });

  it('refuses to invent a price when the assertion overruns the venue', () => {
    // 100000 on 0.024 of a 0.047 leg blended at 2300 implies a NEGATIVE price
    // for the remaining 0.023. The client blocks this; a payload that reaches
    // the server anyway must not fabricate one, so the sibling stays unknown.
    const out = book(assertHl([...BIN_CARD, ...GATE_CARD], BIN_POS, 100_000));
    expect(slipOf(out, GATE_POS)).toBeNull();
    expectNothingLost(out);
  });

  it('conserves the venue RATE across claims on a shared BOROS leg', () => {
    // The perp path shipped first and resolved perps only, so a Boros rate the
    // user asserted was silently dropped while the dialog reported success.
    // Same conservation, different unit: the venue's blended entryApr covers
    // every claim, and asserting one moves the others to balance it.
    const rate = (out: StrategyReturns, positionId: string): number | undefined =>
      out.strategies
        .find((x) => x.strategyId === positionId)
        ?.legs.find((l) => l.kind === 'boros' && l.marketId === BIN_BOROS)?.entryApr;

    // Split the Binance Boros leg (0.013 @ 4.5%) across both cards, then say
    // this half locked 5%. The other half must absorb the difference.
    const rows: MembershipRow[] = [
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: BIN } },
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065, entry: 0.05 },
      { positionId: GATE_POS, leg: { kind: 'perp', symbol: GATE } },
      { positionId: GATE_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065 },
    ];
    const out = book(rows);
    const mine = rate(out, BIN_POS);
    const sibling = rate(out, GATE_POS);
    expect(mine).toBeCloseTo(0.05, 12);
    expect(sibling).toBeDefined();
    // Equal halves, so the sibling takes 2*0.045 − 0.05 = 0.04.
    expect(sibling as number).toBeCloseTo(0.04, 12);
    // The invariant, in rate space.
    expect(0.0065 * (mine as number) + 0.0065 * (sibling as number)).toBeCloseTo(
      0.045 * 0.013,
      12,
    );
    expectNothingLost(out);
  });

  it('keeps the VENUE blend alongside the per-claim rate, so the UI can name both', () => {
    // Once anyone asserts, `entryApr` is that CLAIM's rate — so a UI comparing
    // against it printed the user's own number back at them as "the venue
    // reports". `venueEntry` preserves the blend for that comparison.
    const rows: MembershipRow[] = [
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065, entry: 0.05 },
      { positionId: GATE_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065 },
    ];
    const out = book(rows);
    for (const id of [BIN_POS, GATE_POS]) {
      const leg = out.strategies
        .find((x) => x.strategyId === id)
        ?.legs.find((l) => l.kind === 'boros' && l.marketId === BIN_BOROS);
      // Both cards carry the venue's own 4.5%, including the one that asserted
      // nothing and merely holds the balancing figure.
      expect(leg?.venueEntry).toBeCloseTo(0.045, 12);
      expect(leg?.entryApr).not.toBeCloseTo(0.045, 6);
    }
  });

  it('leaves an unasserted BOROS split on the venue rate', () => {
    const rows: MembershipRow[] = [
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065 },
      { positionId: GATE_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065 },
    ];
    const out = book(rows);
    for (const id of [BIN_POS, GATE_POS]) {
      const apr = out.strategies
        .find((x) => x.strategyId === id)
        ?.legs.find((l) => l.kind === 'boros' && l.marketId === BIN_BOROS)?.entryApr;
      expect(apr).toBeCloseTo(0.045, 12);
    }
    expectNothingLost(out);
  });

  it('RE-BALANCES a three-way split off whichever claim was asserted last', () => {
    // "Adjusting 1 = adjusting all", including at 3+ portions. Two claims that
    // said nothing must BOTH move, and must move to the same figure.
    const THIRD = 'c3c00003';
    const rows: MembershipRow[] = [
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.02, entry: 2280 },
      { positionId: GATE_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.015 },
      { positionId: THIRD, leg: { kind: 'perp', symbol: HL }, qty: 0.012 },
    ];
    const out = book(rows);
    const entry = (id: string): number | undefined =>
      out.strategies
        .find((x) => x.strategyId === id)
        ?.legs.find((l) => l.kind === 'perp' && l.symbol === HL)?.entryPrice;
    // The two silent claims are DERIVED — both moved off the venue's own 2300,
    // and both to the same figure, since the remainder splits by size.
    const g = entry(GATE_POS);
    const t = entry(THIRD);
    expect(entry(BIN_POS)).toBeCloseTo(2280, 9);
    expect(g).toBeDefined();
    expect(t).toBeDefined();
    expect(g as number).toBeCloseTo(t as number, 9);
    expect(g as number).not.toBeCloseTo(2300, 6);
    // Conservation over the WHOLE venue leg (0.047 at 2300).
    expect(0.02 * 2280 + (0.047 - 0.02) * (g as number)).toBeCloseTo(2300 * 0.047, 6);
    expectNothingLost(out);
  });

  it('re-balances an ORPHANED Boros portion too', () => {
    // Hubert's screenshot: the grouped card showed the asserted 9.02% while the
    // "Orphan leg" card beside it still showed the venue's 9.08% — two rates for
    // one venue position. An orphan is un-asserted size on the same leg, so it
    // takes the same implied rate.
    const rows: MembershipRow[] = [
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065, entry: 0.05 },
      // Detached: no positionId ⇒ its own orphan card.
      { leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065 },
    ];
    const out = book(rows);
    const legs = out.strategies.flatMap((x) =>
      x.legs.filter((l) => l.kind === 'boros' && l.marketId === BIN_BOROS),
    );
    // Every rendering of this market agrees: the asserted 5% and the balancing
    // 4%, and nothing is left sitting on the venue's own 4.5%.
    const aprs = legs.map((l) => l.entryApr as number).sort((a, b) => a - b);
    expect(aprs.length).toBeGreaterThanOrEqual(2);
    expect(aprs.some((a) => Math.abs(a - 0.05) < 1e-9)).toBe(true);
    expect(aprs.every((a) => Math.abs(a - 0.045) > 1e-9)).toBe(true);
    expectNothingLost(out);
  });

  it('lets a card claim the WHOLE of a leg a sibling already holds part of', () => {
    // Pressing "All" on a shared leg used to emit a BLANKET claim (`qty`
    // absent), which the solver reads as "all that no other position claims" —
    // and the sibling's stated 0.023 was drawn first, so the assignment took
    // the leftover and silently did nothing. A stated size wins instead.
    // The client RELEASES the sibling's claim first (see applyAssertion's
    // takesWholeLeg branch) — two stated claims on one leg cannot both be
    // honoured, they are drawn in order and clamped. These are the rows that
    // reach the solver after that release.
    const rows: MembershipRow[] = [
      ...withoutHlPerp(GATE_CARD),
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: BIN } },
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: HL }, qty: 0.047 },
    ];
    const out = book(rows);
    const hlQty = (id: string) =>
      out.strategies
        .find((x) => x.strategyId === id)
        ?.legs.find((l) => l.kind === 'perp' && l.symbol === HL)?.notionalToken ?? 0;
    // The whole venue leg lands on the card that asked for all of it.
    expect(hlQty(BIN_POS)).toBeCloseTo(0.047, 9);
    expect(hlQty(GATE_POS)).toBeCloseTo(0, 9);
    expectNothingLost(out);
  });

  it('re-balances LEFTOVER Boros size that no row mentions at all', () => {
    // Hubert's screenshot: one claim asserted, and the card holding the size
    // nobody spoke for still showed the venue's blend — two entries for one
    // venue position. This size never passes through the per-claim
    // reconciliation, but the venue average counted it, so it re-balances too.
    // NOTE: no orphan row here — the remainder is simply unclaimed.
    const rows: MembershipRow[] = [
      { positionId: BIN_POS, leg: { kind: 'perp', symbol: BIN } },
      { positionId: BIN_POS, leg: { kind: 'boros', marketId: BIN_BOROS }, qty: 0.0065, entry: 0.05 },
    ];
    const out = book(rows);
    const aprs = out.strategies
      .flatMap((x) => x.legs)
      .filter((l) => l.kind === 'boros' && l.marketId === BIN_BOROS)
      .map((l) => l.entryApr as number);
    expect(aprs.length).toBeGreaterThanOrEqual(2);
    // The asserted 5% is there…
    expect(aprs.some((a) => Math.abs(a - 0.05) < 1e-9)).toBe(true);
    // …and NOTHING is still sitting on the venue's own 4.5%.
    expect(aprs.every((a) => Math.abs(a - 0.045) > 1e-9)).toBe(true);
    expectNothingLost(out);
  });

  it('survives the wire — `e` is not dropped by encode/decode', () => {
    const rows = assertHl([...BIN_CARD, ...GATE_CARD], BIN_POS, 2_280);
    const through = decodeMembership(encodeMembership(rows)) ?? [];
    const hl = through.find(
      (r) => r.positionId === BIN_POS && r.leg.kind === 'perp' && r.leg.symbol === HL,
    );
    expect(hl?.entry).toBe(2_280);
  });

  it('drops a non-positive asserted entry at the decoder', () => {
    // Same discipline as `q`: not a fill, and it would poison the average.
    for (const bad of [0, -1]) {
      const rows = assertHl([...BIN_CARD], BIN_POS, bad);
      const through = decodeMembership(encodeMembership(rows)) ?? [];
      const hl = through.find(
        (r) => r.positionId === BIN_POS && r.leg.kind === 'perp' && r.leg.symbol === HL,
      );
      expect(hl?.entry).toBeUndefined();
    }
  });
});
