/**
 * How a shared Boros leg is divided between strategies — by the fills that
 * built it, and by the user where they disagree.
 *
 * The book here is a real one: a Binance/HL pair opened first with BOTH its
 * Boros legs, then a Gate/HL perp pair opened 17 days later with no Boros of
 * its own. One Hyperliquid Boros short serves both. Sized pro-rata by perp,
 * 32% of it went to the strategy that never traded it and the fully-built one
 * reported "68% matched"; anchored on the Boros fills, it stays where it was
 * opened.
 */
import { describe, expect, it } from 'vitest';
import type { BorosCollateralZone, BorosMarket, BorosTxn } from '../../src/core/boros/client';
import {
  buildStrategies,
  type BuildStrategiesInput,
  type MembershipRow,
  type PerpPositionLike,
} from '../../src/core/boros/returns';
import { imInputs, raw } from '../helpers/boros-fixtures';

const NOW = 1_787_000_000;
const DAY = 86_400;
const OPENED_1 = NOW - 18 * DAY; // the Binance/HL strategy
const OPENED_2 = NOW - 1 * DAY; // the Gate/HL perp pair, later
const MATURITY = NOW + 127 * DAY;

const mk = (marketId: number, venue: string, name: string, markApr: number): BorosMarket => ({
  maxRateDeviationApr: 0.016,
  marketId,
  tokenId: 2,
  name,
  venue,
  base: 'ETH',
  maturity: MATURITY,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr,
  floatingApr: markApr - 0.001,
  midApr: markApr,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 1_920,
  ...imInputs,
});
const binMarket = mk(129, 'Binance', 'Binance ETHUSDT 25 Dec 2026', 0.0335);
const hlMarket = mk(128, 'Hyperliquid', 'Hyperliquid ETH 25 Dec 2026', 0.0625);

/** Boros: Binance long 0.053, Hyperliquid short 0.053 — one cohort. */
function zones(): BorosCollateralZone[] {
  const pos = (marketId: number, side: 0 | 1, notional: number, fixedApr: number) => ({
    marketId,
    side,
    notionalSize: raw(notional),
    fixedApr,
    markApr: fixedApr,
    pnl: { rateSettlementPnl: raw(0.1), unrealisedPnl: raw(-0.01) },
    positionInitialMargin: raw(0.002),
  });
  return [
    {
      tokenId: 2,
      cross: {
        isCross: true,
        netBalance: raw(0.03),
        marketPositions: [pos(129, 0, 0.053, 0.0338), pos(128, 1, -0.053, 0.0619)],
      },
      isolated: [],
    },
  ];
}

const txns = (): BorosTxn[] => [
  { marketId: 129, time: OPENED_1, fee: raw(0.00002), pnl: raw(-0.00002), prevPositionS: '0', postPositionS: raw(0.053), fixedApr: 0.0338 },
  { marketId: 128, time: OPENED_1, fee: raw(0.00002), pnl: raw(-0.00002), prevPositionS: '0', postPositionS: raw(-0.053), fixedApr: 0.0619 },
];

/** Perps: Binance long 0.053 and Gate long 0.025 against ONE HL short 0.078. */
const perps = (): PerpPositionLike[] => [
  {
    symbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    positionSide: 'SHORT',
    positionQty: '-0.078',
    positionValue: '150',
    entryPrice: '1923',
    upnl: '-1',
    fundingFee: '0.36',
    fee: '-0.07',
    initialMargin: '30',
    createTime: String(OPENED_1 * 1000),
    positionId: 'hl-1',
  },
  {
    symbol: 'BINANCE_FUTURE_ETH_USDT',
    positionSide: 'LONG',
    positionQty: '0.053',
    positionValue: '102',
    entryPrice: '1924',
    upnl: '2.88',
    fundingFee: '-0.2',
    fee: '-0.02',
    initialMargin: '20',
    createTime: String(OPENED_1 * 1000),
    positionId: 'bin-1',
  },
  {
    symbol: 'GATE_FUTURE_ETH_USDT',
    positionSide: 'LONG',
    positionQty: '0.025',
    positionValue: '48',
    entryPrice: '1921',
    upnl: '-0.15',
    fundingFee: '0',
    fee: '-0.01',
    initialMargin: '10',
    createTime: String(OPENED_2 * 1000),
    positionId: 'gate-1',
  },
];

const book = (over: Partial<BuildStrategiesInput> = {}): BuildStrategiesInput => ({
  address: '0x' + 'cd'.repeat(20),
  zones: zones(),
  markets: [binMarket, hlMarket],
  txnsByToken: new Map([[2, txns()]]),
  pricesUsd: new Map([[2, 1_920]]),
  perpPositions: perps(),
  nowSec: NOW,
  ...over,
});

const cardFor = (out: ReturnType<typeof buildStrategies>, perpVenue: string) =>
  out.strategies.find((s) => s.legs.some((l) => l.kind === 'perp' && l.venue === perpVenue));

const borosQty = (s: ReturnType<typeof buildStrategies>['strategies'][number], venue: string) =>
  s.legs.find((l) => l.kind === 'boros' && l.venue === venue)?.notionalToken ?? 0;

/**
 * ⚠ THE CARDS ARE NOT A CENSUS OF THE VENUE.
 *
 * The client prunes a membership row once the server stops reporting its leg,
 * so "which legs exist" must be answered by something no downstream filtering
 * can shorten. `buildBorosLegs` drops a whole collateral zone whose USD price
 * cannot be resolved — a warning, and a 200 — so a position can be open and on
 * no card. Read off the cards, that was indistinguishable from closed, and the
 * user's pins for those legs were deleted with no undo.
 */
describe('liveBorosMarketIds — counted from the zones, not the cards', () => {
  it('still lists a market whose collateral zone could not be priced', () => {
    const out = buildStrategies(book({ pricesUsd: new Map([[2, null]]) }));
    // Nothing could be built…
    expect(out.strategies.flatMap((s) => s.legs).filter((l) => l.kind === 'boros')).toEqual([]);
    expect(out.warnings.join(' ')).toMatch(/Can't price the .* collateral zone/);
    // …and the positions are open all the same.
    expect([...out.liveBorosMarketIds].sort((a, b) => a - b)).toEqual([128, 129]);
  });

  it('lists exactly the markets the account holds a position on', () => {
    const out = buildStrategies(book());
    expect([...out.liveBorosMarketIds].sort((a, b) => a - b)).toEqual([128, 129]);
  });

  it('leaves out a market whose position is flat', () => {
    // A closed leg must NOT be reported live, or the prune could never run.
    const flat = zones().map((z) => ({
      ...z,
      cross: z.cross
        ? {
            ...z.cross,
            marketPositions: z.cross.marketPositions.map((p) =>
              p.marketId === 128 ? { ...p, notionalSize: '0' } : p,
            ),
          }
        : z.cross,
    }));
    const out = buildStrategies(book({ zones: flat }));
    expect(out.liveBorosMarketIds).toEqual([129]);
  });
});

describe('shared Boros leg — anchored on the Boros fills', () => {
  it('gives the whole leg to the strategy whose fills opened it', () => {
    // Boros anchors: the fill that built this leg landed with the Binance
    // strategy, 17 days before the Gate perp pair existed. The later pair has
    // perp exposure at Hyperliquid but never traded that rate, so it gets none
    // of it — and the fully-built strategy reads as what it is.
    const out = buildStrategies(book());
    const bin = cardFor(out, 'BINANCE')!;
    const gate = cardFor(out, 'GATE')!;
    expect(borosQty(bin, 'HYPERLIQUID')).toBeCloseTo(0.053, 6);
    expect(borosQty(gate, 'HYPERLIQUID')).toBe(0);
    expect(bin.hedge).toBe('hedged');
    expect(bin.hedgeChecks.borosMatchRatio).toBeCloseTo(1, 6);
    // The sibling stays a strategy — it simply has no Boros yet.
    expect(gate.legs.filter((l) => l.kind === 'perp')).toHaveLength(2);
  });

  it('falls back to pro-rata by perp size when no fill record explains the leg', () => {
    // With no evidence, an equal hedge ratio is the least-assuming split —
    // 0.053/0.078 and 0.025/0.078 of the one 0.053 short.
    const out = buildStrategies(book({ txnsByToken: new Map() }));
    expect(borosQty(cardFor(out, 'BINANCE')!, 'HYPERLIQUID')).toBeCloseTo(0.036, 3);
    expect(borosQty(cardFor(out, 'GATE')!, 'HYPERLIQUID')).toBeCloseTo(0.017, 3);
    expect(cardFor(out, 'BINANCE')!.hedge).toBe('partial');
  });

  it('never orphans Boros nobody is competing for', () => {
    // A book deliberately holding MORE Boros than perp must keep reading as
    // over-covered, not have the excess quietly moved to another card — that
    // is the signal the hedge check exists to give.
    const out = buildStrategies(
      book({
        perpPositions: perps().map((p) =>
          (p.symbol ?? '').startsWith('BINANCE')
            ? { ...p, positionQty: '0.026', positionValue: '50' }
            : p,
        ),
      }),
    );
    const bin = cardFor(out, 'BINANCE')!;
    // Its Binance Boros long is 0.053 against only 0.026 of perp — all of it
    // still belongs to this strategy.
    expect(borosQty(bin, 'BINANCE')).toBeCloseTo(0.053, 6);
    expect(out.strategies.some((s) => s.attribution.source === 'boros-only')).toBe(false);
  });

  it('orphaning the other pair frees the whole leg', () => {
    // The blunt instrument: rows with no positionId say the Gate and
    // Hyperliquid perps belong to nothing, so they stop competing for the
    // Hyperliquid Boros.
    const out = buildStrategies(
      book({
        membership: [
          { leg: { kind: 'perp', symbol: 'GATE_FUTURE_ETH_USDT' } },
          { leg: { kind: 'perp', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' }, qty: 0.025 },
        ],
      }),
    );
    const bin = cardFor(out, 'BINANCE')!;
    expect(borosQty(bin, 'HYPERLIQUID')).toBeCloseTo(0.053, 6);
    expect(bin.hedge).toBe('hedged');
    // …but the Gate PAIR is gone: its legs land on one-leg unhedged positions
    // rather than staying together as a partly-built strategy.
    const gate = out.strategies.find(
      (s) => s.attribution.source === 'unhedged' && s.legs.some((l) => l.venue === 'GATE'),
    );
    expect(gate?.hedge).toBe('unhedged');
    expect(gate?.legs.map((l) => l.venue)).toEqual(['GATE']);
    expect(out.strategies.filter((s) => s.attribution.source !== 'unhedged').map((s) => s.strategyId))
      .toEqual([bin.strategyId]);
  });
});

/*
 * The "saying which position holds it" block that stood here is gone.
 *
 * Every case in it — claim the whole leg, "all of it" with no size, leave the
 * remainder, clamp an over-claim, report a stale leg, an unasserted book,
 * claim part of a shared perp — is covered by boros-membership-usecases.ts on
 * the SAME book, and covered better: those go through decodeMembership /
 * encodeMembership, so they also catch a payload the wire silently drops.
 * Two suites asserting one behaviour, one of them weaker, is not coverage.
 */

describe('one perp, two maturities', () => {
  /**
   * The stranding bug: a Gate/HL perp pair opened alongside a Sep Boros pair,
   * while an older, LARGER Dec cohort also wants Hyperliquid perp. Choosing a
   * single cohort per perp sent the pair to Dec (more Boros at its venues) and
   * left the Sep pair rendering with no hedge at all — "no perp legs yet".
   *
   * A perp has no maturity, so both cohorts draw on it instead.
   */
  const MAT_SEP = NOW + 36 * DAY;
  const gateSep = { ...mk(188, 'Gate', 'Gate ETHUSDT 25 Sep 2026', 0.0347), maturity: MAT_SEP };
  const hlSep = { ...mk(102, 'Hyperliquid', 'Hyperliquid ETH 25 Sep 2026', 0.0656), maturity: MAT_SEP };

  const twoMaturities = (): BuildStrategiesInput =>
    book({
      markets: [binMarket, hlMarket, gateSep, hlSep],
      zones: [
        {
          tokenId: 2,
          cross: {
            isCross: true,
            netBalance: raw(0.05),
            marketPositions: [
              // Dec — the bigger, older book.
              { marketId: 129, side: 0, notionalSize: raw(0.053), fixedApr: 0.0338, markApr: 0.0338, pnl: { rateSettlementPnl: raw(0.1), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.002) },
              { marketId: 128, side: 1, notionalSize: raw(-0.053), fixedApr: 0.0619, markApr: 0.0619, pnl: { rateSettlementPnl: raw(0.1), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.002) },
              // Sep — opened with the Gate perp pair, 17 days later.
              { marketId: 188, side: 0, notionalSize: raw(0.025), fixedApr: 0.0347, markApr: 0.0347, pnl: { rateSettlementPnl: raw(0.05), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
              { marketId: 102, side: 1, notionalSize: raw(-0.025), fixedApr: 0.0656, markApr: 0.0656, pnl: { rateSettlementPnl: raw(0.05), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
            ],
          },
          isolated: [],
        },
      ],
      txnsByToken: new Map([
        [
          2,
          [
            ...txns(),
            { marketId: 188, time: OPENED_2, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(0.025), fixedApr: 0.0347 },
            { marketId: 102, time: OPENED_2, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(-0.025), fixedApr: 0.0656 },
          ],
        ],
      ]),
    });

  it('hedges BOTH maturities instead of stranding one without perps', () => {
    const out = buildStrategies(twoMaturities());
    const bin = cardFor(out, 'BINANCE')!;
    const gate = cardFor(out, 'GATE')!;

    // The Sep pair keeps the perps it was opened with…
    expect(gate.legs.filter((l) => l.kind === 'perp')).toHaveLength(2);
    expect(borosQty(gate, 'GATE')).toBeCloseTo(0.025, 6);
    expect(borosQty(gate, 'HYPERLIQUID')).toBeCloseTo(0.025, 6);
    expect(gate.hedge).toBe('hedged');

    // …and the Dec book is untouched by it.
    expect(borosQty(bin, 'BINANCE')).toBeCloseTo(0.053, 6);
    expect(borosQty(bin, 'HYPERLIQUID')).toBeCloseTo(0.053, 6);
    expect(bin.hedge).toBe('hedged');

    // No phantom perp-less card, and no "attached to the largest cohort" note.
    expect(out.strategies.some((s) => s.attribution.source === 'boros-only')).toBe(false);
    expect(out.strategies.flatMap((s) => s.warnings).join(' ')).not.toMatch(/largest cohort/);
  });

  /**
   * ⚠ A POSITION RUNS TO ONE DATE, and only a PINNED card can break that.
   *
   * A solved card is single-maturity structurally (cohorts are keyed
   * `(base, maturity)`), so this is the one path that needs saying out loud.
   * The dialog refuses the assignment now, but a share link or a pin written
   * before it did can still carry the clash in — and it does not degrade the
   * card, it misprices it, silently, while every number keeps its confident
   * formatting.
   */
  it('warns when a pinned position holds Boros legs of two maturities', () => {
    const P = 'a1b2c3d4';
    const out = buildStrategies({
      ...twoMaturities(),
      membership: [
        { positionId: P, leg: { kind: 'boros', marketId: 129 } }, // Dec long
        { positionId: P, leg: { kind: 'boros', marketId: 128 } }, // Dec short
        { positionId: P, leg: { kind: 'boros', marketId: 102 } }, // SEP short — the intruder
      ],
    });
    const card = out.strategies.find((s) => s.strategyId === P)!;
    expect(card.legs.filter((l) => l.kind === 'boros')).toHaveLength(3);
    expect(card.warnings.join(' ')).toMatch(/mature on 2 different dates/);
    // …and the warning is worth having because THIS is what the card's own
    // countdown and every projection on it are computed against.
    expect(card.maturity).toBe(MAT_SEP);
  });

  it('says nothing when a pinned position keeps to one maturity', () => {
    const P = 'a1b2c3d4';
    const out = buildStrategies({
      ...twoMaturities(),
      membership: [
        { positionId: P, leg: { kind: 'boros', marketId: 129 } },
        { positionId: P, leg: { kind: 'boros', marketId: 128 } },
      ],
    });
    const card = out.strategies.find((s) => s.strategyId === P)!;
    expect(card.legs.filter((l) => l.kind === 'boros')).toHaveLength(2);
    expect(card.warnings.join(' ')).not.toMatch(/different dates/);
  });

  it('splits one Hyperliquid perp across the two maturities it hedges', () => {
    const out = buildStrategies(twoMaturities());
    const hlPerp = out.strategies
      .flatMap((s) => s.legs)
      .filter((l) => l.kind === 'perp' && l.venue === 'HYPERLIQUID');
    // 0.053 to Dec, 0.025 to Sep — the whole 0.078 position, counted once.
    expect(hlPerp.reduce((a, l) => a + (l.notionalToken ?? 0), 0)).toBeCloseTo(0.078, 6);
  });
});

describe('one perp spanning two maturities', () => {
  it('gives each maturity its own card id, so pins and keys cannot collide', () => {
    // A tranche that hedges two cohorts yields a card in each. Keyed on the
    // tranche alone they collide, and everything the client stores per
    // strategyId — pins, excluded entry parts, React keys, share links —
    // silently addresses the wrong one.
    const MAT_SEP = NOW + 36 * DAY;
    const gateSep = { ...mk(188, 'Gate', 'Gate ETHUSDT 25 Sep 2026', 0.0347), maturity: MAT_SEP };
    const hlSep = { ...mk(102, 'Hyperliquid', 'Hyperliquid ETH 25 Sep 2026', 0.0656), maturity: MAT_SEP };
    const out = buildStrategies(
      book({
        markets: [binMarket, hlMarket, gateSep, hlSep],
        zones: [
          {
            tokenId: 2,
            cross: {
              isCross: true,
              netBalance: raw(0.05),
              marketPositions: [
                { marketId: 129, side: 0, notionalSize: raw(0.053), fixedApr: 0.0338, markApr: 0.0338, pnl: { rateSettlementPnl: raw(0.1), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.002) },
                { marketId: 128, side: 1, notionalSize: raw(-0.053), fixedApr: 0.0619, markApr: 0.0619, pnl: { rateSettlementPnl: raw(0.1), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.002) },
                { marketId: 188, side: 0, notionalSize: raw(0.025), fixedApr: 0.0347, markApr: 0.0347, pnl: { rateSettlementPnl: raw(0.05), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
                { marketId: 102, side: 1, notionalSize: raw(-0.025), fixedApr: 0.0656, markApr: 0.0656, pnl: { rateSettlementPnl: raw(0.05), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001) },
              ],
            },
            isolated: [],
          },
        ],
        txnsByToken: new Map([
          [
            2,
            [
              ...txns(),
              { marketId: 188, time: OPENED_2, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(0.025), fixedApr: 0.0347 },
              { marketId: 102, time: OPENED_2, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(-0.025), fixedApr: 0.0656 },
            ],
          ],
        ]),
      }),
    );
    const ids = out.strategies.map((s) => s.strategyId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a perp serving two maturities', () => {
  /**
   * The spec's rule, taken literally: "A perp serving two maturities splits
   * across both." Pro-rata to the Boros it covers in each — no floor, no
   * suppression of a small side.
   */
  const MAT_SEP = NOW + 36 * DAY;
  const binSep = { ...mk(101, 'Binance', 'Binance ETHUSDT 25 Sep 2026', 0.05), maturity: MAT_SEP };
  const hlSep = { ...mk(102, 'Hyperliquid', 'Hyperliquid ETH 25 Sep 2026', 0.073), maturity: MAT_SEP };

  const pos = (marketId: number, side: 0 | 1, notional: number, fixedApr: number) => ({
    marketId, side, notionalSize: raw(notional), fixedApr, markApr: fixedApr,
    pnl: { rateSettlementPnl: raw(0.01), unrealisedPnl: raw(0) }, positionInitialMargin: raw(0.001),
  });
  const fill = (hash: string, t: number, symbol: string, side: 'BUY' | 'SELL', qty: number, ab: 'A' | 'B') =>
    ({ symbol, side, qty, price: 1920, feeUsd: 0.01, timeSec: t, text: `t${hash}${ab}1` });

  const twoEntries = () =>
    book({
      markets: [binMarket, hlMarket, binSep, hlSep],
      zones: [{
        tokenId: 2,
        cross: {
          isCross: true, netBalance: raw(0.05),
          marketPositions: [
            pos(129, 0, 0.013, 0.0338), pos(128, 1, -0.013, 0.0619),
            pos(101, 0, 0.013, 0.0499), pos(102, 1, -0.013, 0.073),
          ],
        },
        isolated: [],
      }],
      txnsByToken: new Map([[2, [
        { marketId: 129, time: OPENED_1, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(0.013), fixedApr: 0.0338 },
        { marketId: 128, time: OPENED_1, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(-0.013), fixedApr: 0.0619 },
        { marketId: 101, time: OPENED_2, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(0.013), fixedApr: 0.0499 },
        { marketId: 102, time: OPENED_2, fee: raw(0.00001), pnl: raw(-0.00001), prevPositionS: '0', postPositionS: raw(-0.013), fixedApr: 0.073 },
      ]]]),
      perpPositions: [
        { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionSide: 'SHORT', positionQty: '-0.024', positionValue: '46', entryPrice: '1920', upnl: '0', fundingFee: '0', fee: '-0.02', initialMargin: '20', createTime: String(OPENED_1 * 1000), positionId: 'hl-1' },
        { symbol: 'BINANCE_FUTURE_ETH_USDT', positionSide: 'LONG', positionQty: '0.024', positionValue: '46', entryPrice: '1920', upnl: '0', fundingFee: '0', fee: '-0.02', initialMargin: '20', createTime: String(OPENED_1 * 1000), positionId: 'bin-1' },
      ],
      perpFills: [
        fill('aaaaaaa', OPENED_1, 'BINANCE_FUTURE_ETH_USDT', 'BUY', 0.013, 'A'),
        fill('aaaaaaa', OPENED_1, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 0.013, 'B'),
        fill('bbbbbbb', OPENED_2, 'BINANCE_FUTURE_ETH_USDT', 'BUY', 0.011, 'A'),
        fill('bbbbbbb', OPENED_2, 'HYPERLIQUID_FUTURE_ETH_USDC', 'SELL', 0.011, 'B'),
      ],
    });

  it('counts each venue position exactly once across the maturities it hedges', () => {
    const out = buildStrategies(twoEntries());
    const perp = (v: string) =>
      out.strategies.flatMap((s) => s.legs).filter((l) => l.kind === 'perp' && l.venue === v)
        .reduce((a, l) => a + (l.notionalToken ?? 0), 0);
    // The invariant the spec states: per-strategy totals sum to the venue's.
    expect(perp('BINANCE')).toBeCloseTo(0.024, 6);
    expect(perp('HYPERLIQUID')).toBeCloseTo(0.024, 6);
  });

  it('never renders a card holding a fraction of a cent', () => {
    // Float dust from the perp pairing left a tranche with ~0 in it, and it
    // was being drawn as a position.
    const out = buildStrategies(twoEntries());
    for (const s of out.strategies) {
      expect(s.legs.reduce((a, l) => a + l.notionalUsd, 0)).toBeGreaterThan(0.005);
    }
  });
});
