/**
 * Two-leg Boros market entry (src/core/boros/pair.ts): pair eligibility, the
 * per-leg book walk and its sign conventions, the two NET spread numbers, the
 * §4 sizing arithmetic and the confirm gate.
 *
 * Every expectation is hand-derived below — never by calling the code under
 * test. Book APRs carry float noise, so rates are compared with toBeCloseTo.
 */
import { describe, expect, it } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import {
  acknowledgementCopy,
  evaluatePairGate,
  pairEligibility,
  resolveLegSizing,
  simulateBorosPair,
  DEFAULT_SLIPPAGE_APR,
  MIN_GAS_BALANCE_USD,
  MAX_SLIPPAGE_APR,
  SIMULATION_MAX_AGE_MS,
  type BorosPairAccountState,
  type BorosPairLegInput,
  type EvaluatePairInput,
  type SimulateBorosPairInput,
} from '../../src/core/boros/pair';
import { SECONDS_IN_YEAR } from '../../src/core/boros/returns';
import { imInputs } from '../helpers/boros-fixtures';

const NOW = 1_752_000_000;
const NOW_MS = NOW * 1000;
const DAY = 86_400;
const MATURITY = NOW + 30 * DAY;
/** Shared duration of the fixture, in years. */
const T = (30 * DAY) / SECONDS_IN_YEAR;
const SIZE = 100_000;

const hlMarket: BorosMarket = {
  maxRateDeviationApr: 0.016,
  marketId: 155,
  tokenId: 3,
  name: 'Hyperliquid ETH 31 Aug 2026',
  venue: 'Hyperliquid',
  base: 'ETH',
  maturity: MATURITY,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: 0.089,
  floatingApr: 0.088,
  midApr: 0.09,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 1_880,
  ...imInputs,
};
const bnMarket: BorosMarket = {
  ...hlMarket,
  marketId: 101,
  name: 'Binance ETHUSDT 31 Aug 2026',
  venue: 'Binance',
  markApr: 0.046,
  midApr: 0.045,
};

/** Both fixture markets charge 5bp taker + 10bp settle, so the pair's fee drag
 * on the spread is (0.0005 × 2) + (0.001 × 2) = 0.003. */
const FEE_DRAG = 0.003;

/** Single deep level per side, so the VWAP is exactly the quoted rate. */
const book = (marketId: number, bidApr: number, askApr: number, size = 20_000_000): BorosOrderBook => ({
  marketId,
  bids: [[bidApr, size]],
  asks: [[askApr, size]],
});

const leg = (over: Partial<BorosPairLegInput> = {}): BorosPairLegInput => ({
  market: hlMarket,
  book: book(155, 0.09, 0.092),
  direction: 'short',
  slippageApr: DEFAULT_SLIPPAGE_APR,
  currentSize: 0,
  ...over,
});

function simInput(over: Partial<SimulateBorosPairInput> = {}): SimulateBorosPairInput {
  return {
    legA: leg(),
    legB: leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'long' }),
    size: SIZE,
    intent: 'open',
    collateralPriceUsd: 1,
    nowSec: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §2 eligibility
// ---------------------------------------------------------------------------

describe('pairEligibility', () => {
  it('accepts two live markets sharing collateral and maturity', () => {
    expect(pairEligibility(hlMarket, bnMarket, NOW)).toEqual({
      eligible: true,
      code: null,
      reason: null,
    });
  });

  it('names the collateral mismatch rather than hiding the pair', () => {
    const btcCollateral = { ...bnMarket, tokenId: 1 };
    const res = pairEligibility(hlMarket, btcCollateral, NOW);
    expect(res.eligible).toBe(false);
    expect(res.code).toBe('different-collateral');
    expect(res.reason).toBe('different collateral — USDT vs BTC');
  });

  it('names the maturity mismatch', () => {
    const later = { ...bnMarket, maturity: MATURITY + DAY };
    expect(pairEligibility(hlMarket, later, NOW).code).toBe('different-maturity');
  });

  it('rejects a leg against itself', () => {
    expect(pairEligibility(hlMarket, hlMarket, NOW).code).toBe('same-market');
  });

  it('rejects a matured or halted market', () => {
    expect(pairEligibility(hlMarket, { ...bnMarket, maturity: NOW - 1 }, NOW).code).toBe(
      'not-tradable',
    );
    expect(pairEligibility(hlMarket, { ...bnMarket, state: 'Halted' }, NOW).code).toBe(
      'not-tradable',
    );
  });

  it('does NOT consult margin mode — that decides where margin sits, not validity', () => {
    // Same inputs, and the caller's isolated-only flags live elsewhere entirely.
    expect(pairEligibility(hlMarket, bnMarket, NOW).eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 sizing arithmetic
// ---------------------------------------------------------------------------

describe('resolveLegSizing', () => {
  it('opens from flat', () => {
    const s = resolveLegSizing(0, 100, 'long', 'open');
    expect(s).toMatchObject({ currentSize: 0, deltaSize: 100, resultingSize: 100, opposing: false, flips: false });
  });

  it('adds to a same-direction position', () => {
    const s = resolveLegSizing(60, 100, 'long', 'open');
    expect(s.resultingSize).toBe(160);
    expect(s.opposing).toBe(false);
  });

  it('reduces an opposing position without crossing zero', () => {
    const s = resolveLegSizing(150, 100, 'short', 'open');
    expect(s.deltaSize).toBe(-100);
    expect(s.resultingSize).toBe(50);
    expect(s.opposing).toBe(true);
    expect(s.flips).toBe(false);
  });

  it('crosses through zero when the size exceeds the position', () => {
    const s = resolveLegSizing(40, 100, 'short', 'open');
    expect(s.resultingSize).toBe(-60);
    expect(s.opposing).toBe(true);
    expect(s.flips).toBe(true);
  });

  it('landing exactly flat closes but does not re-open', () => {
    const s = resolveLegSizing(100, 100, 'short', 'open');
    expect(s.resultingSize).toBe(0);
    expect(s.opposing).toBe(true);
    expect(s.flips).toBe(false);
  });

  it('close intent clamps to the position and can never flip it', () => {
    const s = resolveLegSizing(40, 100, 'short', 'close');
    expect(s.deltaSize).toBe(-40);
    expect(s.resultingSize).toBe(0);
    expect(s.flips).toBe(false);
    expect(s.clampedToClose).toBe(true);
  });

  it('close intent on a flat or same-direction market does nothing', () => {
    expect(resolveLegSizing(0, 100, 'short', 'close').deltaSize).toBe(0);
    expect(resolveLegSizing(40, 100, 'long', 'close').deltaSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §3 simulation
// ---------------------------------------------------------------------------

describe('simulateBorosPair', () => {
  it('walks each leg on the side it actually crosses', () => {
    const sim = simulateBorosPair(simInput());
    // Leg A is receive-fixed → hits HL's BIDS at 0.09.
    expect(sim.legA.execApr).toBeCloseTo(0.09, 12);
    // Leg B is pay-fixed → lifts BN's ASKS at 0.042.
    expect(sim.legB.execApr).toBeCloseTo(0.042, 12);
    expect(sim.receiveLeg).toBe('A');
  });

  it('quotes the estimated spread NET of taker and settlement fees', () => {
    const sim = simulateBorosPair(simInput());
    // 0.09 − 0.042 − 0.003 = 0.045
    expect(sim.estSpreadApr).toBeCloseTo(0.09 - 0.042 - FEE_DRAG, 12);
    expect(sim.feeDragApr).toBeCloseTo(FEE_DRAG, 12);
  });

  it('charges ONE leg\'s fees on a single-leg ticket, not the pair\'s', () => {
    // A single-leg ticket carries a borrowed partner sized to zero so the pair
    // shape stays valid. That phantom leg must not be billed: quoting the full
    // pair drag on a one-leg trade overstates the cost by exactly one leg, and
    // the error propagates into estSpreadApr and the net APR built on it.
    const sim = simulateBorosPair(simInput({ onlyLeg: 'A' }));
    // Each fixture market charges 5bp taker + 10bp settle = 0.0015 per leg.
    expect(sim.feeDragApr).toBeCloseTo(FEE_DRAG / 2, 12);
    expect(sim.feeDragApr).toBeLessThan(FEE_DRAG);
  });

  it('still quotes the pair\'s fees before a size is entered', () => {
    // With size 0 NEITHER leg trades, but the ticket is still a pair ticket —
    // reporting zero drag would read as "this trade is free".
    const sim = simulateBorosPair(simInput({ size: 0 }));
    expect(sim.feeDragApr).toBeCloseTo(FEE_DRAG, 12);
  });

  it('compounds BOTH tolerances into the worst case — never just one leg', () => {
    const sim = simulateBorosPair(simInput());
    const est = 0.09 - 0.042 - FEE_DRAG;
    // Receive leg slips DOWN, pay leg slips UP: the two give-ups add.
    expect(sim.worstSpreadApr).toBeCloseTo(est - 2 * DEFAULT_SLIPPAGE_APR, 12);
    // Explicitly: it is worse than moving one leg alone would suggest.
    expect(sim.worstSpreadApr!).toBeLessThan(est - DEFAULT_SLIPPAGE_APR);
  });

  it('moves the worst case live with the slippage setting, leaving the estimate alone', () => {
    const tight = simulateBorosPair(
      simInput({
        legA: leg({ slippageApr: 0.0001 }),
        legB: leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'long', slippageApr: 0.0001 }),
      }),
    );
    const est = 0.09 - 0.042 - FEE_DRAG;
    expect(tight.estSpreadApr).toBeCloseTo(est, 12);
    expect(tight.worstSpreadApr).toBeCloseTo(est - 0.0002, 12);
  });

  it('honours a per-leg slippage override', () => {
    const sim = simulateBorosPair(
      simInput({
        legA: leg({ slippageApr: 0.001 }),
        legB: leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'long', slippageApr: 0.004 }),
      }),
    );
    expect(sim.worstSpreadApr).toBeCloseTo(0.09 - 0.042 - FEE_DRAG - 0.005, 12);
  });

  it('clamps a runaway tolerance', () => {
    const sim = simulateBorosPair({ ...simInput(), legA: leg({ slippageApr: 99 }) });
    expect(sim.legA.slippageApr).toBe(MAX_SLIPPAGE_APR);
  });

  it('charges margin per leg off the RESULTING netted position', () => {
    const sim = simulateBorosPair(simInput());
    // IM = N × max(|apr|, floor) × max(DTM, tThresh) / 365 × kIM, with the
    // fixture's floor ≈ 0.08004 dominating leg B's 4.2% rate.
    const floor = 1.00005 ** (770 * 2) - 1;
    const dtmDays = 30;
    const imA = (SIZE * 0.09 * dtmDays * imInputs.kIM) / 365;
    const imB = (SIZE * floor * dtmDays * imInputs.kIM) / 365;
    expect(sim.legA.marginRequired).toBeCloseTo(imA, 6);
    expect(sim.legB.marginRequired).toBeCloseTo(imB, 6);
    expect(sim.marginRequiredTotal).toBeCloseTo(imA + imB, 6);
    // Not symmetric — the point of showing it per leg.
    expect(sim.legA.marginRequired).not.toBeCloseTo(sim.legB.marginRequired!, 6);
  });

  it('prices cost-to-cross off taker fees × size × years', () => {
    const sim = simulateBorosPair(simInput());
    expect(sim.costToCrossSize).toBeCloseTo(0.001 * SIZE * T, 8);
  });

  it('reports a thin book as a real fill plus a shortfall, never an invented rate', () => {
    const thin = book(155, 0.09, 0.092, 40_000);
    const sim = simulateBorosPair(simInput({ legA: leg({ book: thin }) }));
    expect(sim.legA.estFillSize).toBe(40_000);
    expect(sim.legA.shortfallSize).toBe(60_000);
    expect(sim.legA.bookStatus).toBe('insufficient-depth');
    // The rate it CAN get is still quoted — only the size falls short.
    expect(sim.legA.execApr).toBeCloseTo(0.09, 12);
    expect(sim.hedgedSize).toBe(40_000);
    expect(sim.unhedgedSize).toBe(60_000);
  });

  it('refuses to quote a spread when the legs do not offset', () => {
    const sim = simulateBorosPair(
      simInput({ legB: leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'short' }) }),
    );
    expect(sim.receiveLeg).toBeNull();
    expect(sim.estSpreadApr).toBeNull();
    expect(sim.worstSpreadApr).toBeNull();
    expect(sim.reasons.join(' ')).toContain('do not offset');
  });

  it('degrades to null with a reason when a book is unavailable', () => {
    const sim = simulateBorosPair(simInput({ legA: leg({ book: null }) }));
    expect(sim.legA.execApr).toBeNull();
    expect(sim.legA.bookStatus).toBe('unavailable');
    expect(sim.estSpreadApr).toBeNull();
    expect(sim.reasons.join(' ')).toContain('order book unavailable');
  });

  it('surfaces no gross spread anywhere on the result', () => {
    const sim = simulateBorosPair(simInput());
    const gross = 0.09 - 0.042;
    // The pre-cost 0.048 must not appear as any quoted spread field, and no
    // field may carry it under another name.
    expect(sim.estSpreadApr).not.toBeCloseTo(gross, 9);
    expect(sim.worstSpreadApr).not.toBeCloseTo(gross, 9);
    const aprFields = Object.entries(sim).filter(([k]) => k.endsWith('Apr'));
    expect(aprFields.length).toBeGreaterThan(0);
    for (const [, v] of aprFields) {
      if (typeof v === 'number') expect(v).not.toBeCloseTo(gross, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 / §7 confirm gate
// ---------------------------------------------------------------------------

const account = (over: Partial<BorosPairAccountState> = {}): BorosPairAccountState => ({
  cross: { available: 1_000_000, hasPositionOrOrders: false },
  isolatedByMarket: new Map(),
  ...over,
});

function gateInput(over: Partial<EvaluatePairInput> = {}): EvaluatePairInput {
  const legA = leg();
  const legB = leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'long' });
  return {
    simulation: simulateBorosPair(simInput({ legA, legB })),
    legA,
    legB,
    account: account(),
    eligibility: pairEligibility(hlMarket, bnMarket, NOW),
    opposingAcknowledged: false,
    simulatedAtMs: NOW_MS,
    nowMs: NOW_MS,
    ...over,
  };
}

const codes = (g: { blockers: Array<{ code: string }> }) => g.blockers.map((b) => b.code);

describe('evaluatePairGate', () => {
  it('unlocks a clean pair', () => {
    expect(evaluatePairGate(gateInput()).blockers).toEqual([]);
  });

  it('blocks an ineligible pair', () => {
    const g = evaluatePairGate(
      gateInput({ eligibility: pairEligibility(hlMarket, { ...bnMarket, tokenId: 1 }, NOW) }),
    );
    expect(codes(g)).toContain('ineligible-pair');
  });

  it('checks cross margin against the COMBINED requirement of both legs', () => {
    const sim = gateInput().simulation;
    const imA = sim.legA.marginRequired!;
    const imB = sim.legB.marginRequired!;
    const total = imA + imB;
    // A balance that clears EITHER leg on its own but not the two together —
    // checking each leg independently would wrongly let this through.
    const available = Math.max(imA, imB) + 1;
    expect(available).toBeLessThan(total);

    const g = evaluatePairGate(
      gateInput({ account: account({ cross: { available, hasPositionOrOrders: false } }) }),
    );
    const blocker = g.blockers.find((b) => b.code === 'cross-short-margin');
    expect(blocker).toBeDefined();
    expect(blocker!.shortfall).toBeCloseTo(total - available, 6);
  });

  it('charges only the INCREMENTAL margin when a leg already posts some', () => {
    // Adding to an existing position: `available` is already net of the margin
    // that position posts, so charging the full resulting margin again would
    // block a trade the account can plainly fund.
    const sim = gateInput().simulation;
    const imA = sim.legA.marginRequired!;
    const imB = sim.legB.marginRequired!;
    const committed = imA * 0.8;
    const legA = leg({ committedMargin: committed });

    const clean = evaluatePairGate(
      gateInput({
        legA,
        account: account({
          cross: { available: imA - committed + imB, hasPositionOrOrders: true },
        }),
      }),
    );
    expect(codes(clean)).not.toContain('cross-short-margin');

    // One unit short of the incremental requirement still blocks.
    const short = evaluatePairGate(
      gateInput({
        legA,
        account: account({
          cross: { available: imA - committed + imB - 1, hasPositionOrOrders: true },
        }),
      }),
    );
    expect(short.blockers.find((b) => b.code === 'cross-short-margin')!.shortfall).toBeCloseTo(1, 6);
  });

  it('never lets a leg that frees margin lend it to the other leg', () => {
    const sim = gateInput().simulation;
    const imB = sim.legB.marginRequired!;
    // Leg A already posts far more than its resulting position needs.
    const legA = leg({ committedMargin: sim.legA.marginRequired! * 5 });
    const g = evaluatePairGate(
      gateInput({ legA, account: account({ cross: { available: imB - 1, hasPositionOrOrders: true } }) }),
    );
    // Leg A contributes 0, not a negative — leg B's own shortfall still stands.
    expect(g.blockers.find((b) => b.code === 'cross-short-margin')!.shortfall).toBeCloseTo(1, 6);
  });

  it('reports an isolated-only leg as its own shortfall, never summed', () => {
    const legA = leg({ isolatedOnly: true });
    const legB = leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'long', isolatedOnly: true });
    const sim = simulateBorosPair(simInput({ legA, legB }));
    const g = evaluatePairGate(
      gateInput({
        legA,
        legB,
        simulation: sim,
        account: account({
          cross: null,
          isolatedByMarket: new Map([
            [155, { available: 0, hasPositionOrOrders: false }],
            [101, { available: 0, hasPositionOrOrders: false }],
          ]),
        }),
      }),
    );
    const shorts = g.blockers.filter((b) => b.code === 'isolated-short-margin');
    expect(shorts).toHaveLength(2);
    expect(shorts[0].shortfall).toBeCloseTo(sim.legA.marginRequired!, 6);
    expect(shorts[1].shortfall).toBeCloseTo(sim.legB.marginRequired!, 6);
    // Two separate numbers — the balances are not fungible.
    expect(shorts[0].shortfall).not.toBeCloseTo(shorts[1].shortfall!, 6);
    expect(codes(g)).not.toContain('cross-short-margin');
  });

  it('quotes the SHORTFALL, not the total required', () => {
    const legA = leg({ isolatedOnly: true });
    const sim = simulateBorosPair(simInput({ legA }));
    const required = sim.legA.marginRequired!;
    const g = evaluatePairGate(
      gateInput({
        legA,
        simulation: sim,
        account: account({
          isolatedByMarket: new Map([[155, { available: required - 250, hasPositionOrOrders: false }]]),
        }),
      }),
    );
    const b = g.blockers.find((x) => x.code === 'isolated-short-margin')!;
    expect(b.shortfall).toBeCloseTo(250, 6);
    // Magnitude-scaled: no trailing zeros at USDT scale, real precision at ETH scale.
    expect(b.message).toContain('250 USDT');
  });

  it('blocks a leg sitting in an isolated bucket with something in it (§6A)', () => {
    const legA = leg({ onIsolatedMargin: true, isolatedHasPositionOrOrders: true });
    const g = evaluatePairGate(gateInput({ legA, simulation: simulateBorosPair(simInput({ legA })) }));
    const b = g.blockers.find((x) => x.code === 'isolated-must-switch')!;
    expect(b.message).toContain('Switch it to cross margin');
  });

  it('does NOT raise §6A for an isolated-ONLY market — that pairing is valid', () => {
    const legA = leg({ isolatedOnly: true, onIsolatedMargin: true, isolatedHasPositionOrOrders: true });
    const g = evaluatePairGate(
      gateInput({
        legA,
        simulation: simulateBorosPair(simInput({ legA })),
        account: account({
          isolatedByMarket: new Map([[155, { available: 1e9, hasPositionOrOrders: true }]]),
        }),
      }),
    );
    expect(codes(g)).not.toContain('isolated-must-switch');
  });

  it('requires the acknowledgement whenever a leg opposes an existing position', () => {
    const legA = leg({ currentSize: 150 }); // short 100 against a long 150 → reduces
    const sim = simulateBorosPair(simInput({ legA }));
    const g = evaluatePairGate(gateInput({ legA, simulation: sim }));
    expect(g.requiresAcknowledgement).toBe(true);
    expect(g.opposingLegs).toEqual(['A']);
    expect(codes(g)).toContain('flip-unacknowledged');

    const ticked = evaluatePairGate(gateInput({ legA, simulation: sim, opposingAcknowledged: true }));
    expect(codes(ticked)).not.toContain('flip-unacknowledged');
  });

  it('quotes a token-collateral shortfall at a readable precision, never "0.00"', () => {
    // An ETH-collateralised market: margins land in hundredths. A fixed-2dp
    // format renders the whole blocker as "0.00 ETH" — "you need nothing" on
    // the screen that is refusing the trade.
    const ethMarket = { ...hlMarket, tokenId: 2, kIM: 0.001 };
    const legA = leg({ market: ethMarket, isolatedOnly: true });
    const legB = leg({
      market: { ...bnMarket, tokenId: 2 },
      book: book(101, 0.04, 0.042),
      direction: 'long',
    });
    const sim = simulateBorosPair(simInput({ legA, legB, size: 0.01 }));
    const g = evaluatePairGate(
      gateInput({
        legA,
        legB,
        simulation: sim,
        eligibility: pairEligibility(ethMarket, { ...bnMarket, tokenId: 2 }, NOW),
        account: account({
          isolatedByMarket: new Map([[155, { available: 0, hasPositionOrOrders: false }]]),
        }),
      }),
    );
    const b = g.blockers.find((x) => x.code === 'isolated-short-margin')!;
    expect(b.shortfall).toBeGreaterThan(0);
    // The number the user reads must not round away to zero.
    expect(b.message).not.toMatch(/\b0\.00 ETH\b/);
    expect(b.message).toMatch(/ETH/);
  });

  it('blocks on an empty prepaid gas balance, distinctly from margin', () => {
    const g = evaluatePairGate(gateInput({ account: account({ gasBalanceUsd: 0 }) }));
    const codesOut = codes(g);
    expect(codesOut).toContain('no-gas');
    // Gas is topped up with payTreasury, margin with collateral — different fix.
    expect(codesOut).not.toContain('cross-short-margin');
    expect(g.blockers.find((b) => b.code === 'no-gas')!.message).toMatch(
      /gas, not trading collateral/i,
    );
  });

  it('blocks a LOW balance too, not just an empty one', () => {
    // $0.05 is under the ops-fee sweep threshold. A `<= 0` check let it through
    // to fail at submit — the exact failure this blocker exists to pre-empt.
    const g = evaluatePairGate(gateInput({ account: account({ gasBalanceUsd: 0.05 }) }));
    expect(codes(g)).toContain('no-gas');
    const msg = g.blockers.find((b) => b.code === 'no-gas')!.message;
    // Names what is actually there, so the shortfall is obvious.
    expect(msg).toContain('$0.05');
    // The amount to send is the button's job, not this message's.
    expect(msg).not.toContain('$10');
  });

  it('blocks an UNKNOWN balance and says the read failed', () => {
    // null = the read failed. Waving it through renders an account we know
    // nothing about as a funded one.
    const g = evaluatePairGate(gateInput({ account: account({ gasBalanceUsd: null }) }));
    expect(codes(g)).toContain('no-gas');
    expect(g.blockers.find((b) => b.code === 'no-gas')!.message).toMatch(/could not be read/i);
  });

  it('raises no gas blocker at or above the minimum, or when never read', () => {
    // undefined = no read was attempted, on an install that cannot place orders
    // anyway. That is not the same as a read that failed.
    expect(
      codes(evaluatePairGate(gateInput({ account: account({ gasBalanceUsd: undefined }) }))),
    ).not.toContain('no-gas');
    expect(
      codes(evaluatePairGate(gateInput({ account: account({ gasBalanceUsd: 5 }) }))),
    ).not.toContain('no-gas');
    expect(
      codes(
        evaluatePairGate(gateInput({ account: account({ gasBalanceUsd: MIN_GAS_BALANCE_USD }) })),
      ),
    ).not.toContain('no-gas');
  });

  it('refuses a simulation older than the refresh interval', () => {
    const g = evaluatePairGate(gateInput({ nowMs: NOW_MS + SIMULATION_MAX_AGE_MS + 1 }));
    expect(codes(g)).toContain('stale-simulation');
  });

  it('flags a resting TP/SL as a warning, not a blocker', () => {
    const legA = leg({ hasTpSl: true });
    const g = evaluatePairGate(gateInput({ legA, simulation: simulateBorosPair(simInput({ legA })) }));
    expect(g.blockers).toEqual([]);
    expect(g.warnings.join(' ')).toContain('TP/SL');
  });

  it('separates a depth failure from a book that is simply unavailable', () => {
    const empty = { marketId: 155, bids: [], asks: [] as Array<[number, number]> };
    const noDepth = leg({ book: empty });
    const gDepth = evaluatePairGate(
      gateInput({ legA: noDepth, simulation: simulateBorosPair(simInput({ legA: noDepth })) }),
    );
    expect(codes(gDepth)).toContain('no-depth');

    const gone = leg({ book: null });
    const gGone = evaluatePairGate(
      gateInput({ legA: gone, simulation: simulateBorosPair(simInput({ legA: gone })) }),
    );
    expect(codes(gGone)).toContain('book-unavailable');
  });
});

describe('acknowledgementCopy', () => {
  const copyFor = (currentSize: number, size: number) => {
    const legA = leg({ currentSize });
    const sim = simulateBorosPair(simInput({ legA, size }));
    return acknowledgementCopy(sim.legA, 'USDT');
  };

  it('says "closes … and opens … in the opposite direction" for a true flip', () => {
    const c = copyFor(40_000, 100_000);
    expect(c).toContain('closes my existing');
    expect(c).toContain('long position of 40,000 USDT');
    expect(c).toContain('opens 60,000 USDT in the opposite direction');
  });

  it('says "closes … in full" when the delta lands exactly flat', () => {
    expect(copyFor(100_000, 100_000)).toContain('in full');
  });

  it('does not overstate a pure reduction as a flip', () => {
    const c = copyFor(150_000, 100_000);
    expect(c).toContain('reduces my existing');
    expect(c).toContain('to 50,000 USDT');
    expect(c).not.toContain('opposite direction');
  });
});

describe('the no-size blocker on a reduce-only ticket', () => {
  /**
   * The live confusion: a size IS entered, but Close is reduce-only and both
   * legs point the same way as the positions held, so both deltas clamp to
   * zero. "Enter a size to trade" then sends the user to fix the one thing
   * that was already right.
   */
  const closeGate = (dirA: 'long' | 'short', dirB: 'long' | 'short', curA: number, curB: number) => {
    const legA = leg({ direction: dirA, currentSize: curA });
    const legB = leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: dirB, currentSize: curB });
    return evaluatePairGate(
      gateInput({
        legA,
        legB,
        simulation: simulateBorosPair(simInput({ legA, legB, size: SIZE, intent: 'close' })),
        opposingAcknowledged: true,
      }),
    );
  };

  const noSize = (g: { blockers: Array<{ code: string; message: string }> }) =>
    g.blockers.find((b) => b.code === 'no-size')!.message;

  it('names the markets that would ADD rather than asking for a size', () => {
    // Short against a short, long against a long: reduce-only zeroes both.
    const msg = noSize(closeGate('short', 'long', -50_000, 50_000));
    expect(msg).toMatch(/reduce-only/i);
    expect(msg).toContain(hlMarket.name);
    expect(msg).toContain(bnMarket.name);
    expect(msg).toMatch(/add to it, not reduce it/i);
    expect(msg).toMatch(/Flip the direction, or switch to Open/i);
    expect(msg).not.toMatch(/Enter a size/i);
  });

  it('says there is nothing to close when the account is flat', () => {
    const msg = noSize(closeGate('short', 'long', 0, 0));
    expect(msg).toMatch(/nothing to close/i);
    expect(msg).toContain(hlMarket.name);
  });

  it('still asks for a size when none was entered', () => {
    const legA = leg();
    const legB = leg({ market: bnMarket, book: book(101, 0.04, 0.042), direction: 'long' });
    const g = evaluatePairGate(
      gateInput({ legA, legB, simulation: simulateBorosPair(simInput({ legA, legB, size: 0 })) }),
    );
    expect(noSize(g)).toBe('Enter a size to trade.');
  });
});
