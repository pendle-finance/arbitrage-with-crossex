/**
 * The all-or-nothing roll (src/core/boros/rollover.ts): the checks that only
 * exist because two pairs go out as one batch, how the venue's preview
 * becomes the gate's verdict and margin figures, the legs handed to the
 * venue, and how its four fills become one outcome. Simulations and pair gates are produced by the real pair module —
 * they are inputs here, not the code under test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import type { BorosLegFill, BorosOrderClient, BorosRollLeg, BorosRollSimulation } from '../../src/core/boros/orders';
import {
  DEFAULT_SLIPPAGE_APR,
  evaluatePairGate,
  pairEligibility,
  simulateBorosPair,
  type BorosPairAccountState,
  type BorosPairLegInput,
} from '../../src/core/boros/pair';
import {
  evaluateRollGate,
  readRollFills,
  rollLegsFor,
  submitBorosRoll,
  type EvaluateRollInput,
  type RollStepInput,
} from '../../src/core/boros/rollover';
import { imInputs } from '../helpers/boros-fixtures';

const NOW = 1_752_000_000;
const DAY = 86_400;
const OLD = NOW + 30 * DAY;
const NEW = NOW + 60 * DAY;
const SIZE = 100_000;

const market = (over: Partial<BorosMarket>): BorosMarket => ({
  maxRateDeviationApr: 0.016,
  marketId: 155,
  tokenId: 3,
  name: 'Hyperliquid ETH old',
  venue: 'Hyperliquid',
  base: 'ETH',
  maturity: OLD,
  paymentPeriod: 3_600,
  settleFeeApr: 0.001,
  markApr: 0.09,
  floatingApr: 0.088,
  midApr: 0.09,
  notionalOi: 5_000_000,
  takerFeeRate: 0.0005,
  state: 'Normal',
  assetMarkPriceUsd: 1_880,
  ...imInputs,
  ...over,
});
const hlOld = market({});
const bnOld = market({ marketId: 101, name: 'Binance ETH old', venue: 'Binance', markApr: 0.045, midApr: 0.045 });
const hlNew = market({ marketId: 156, name: 'Hyperliquid ETH new', maturity: NEW, markApr: 0.1, midApr: 0.1 });
const bnNew = market({ marketId: 102, name: 'Binance ETH new', venue: 'Binance', maturity: NEW, markApr: 0.05, midApr: 0.05 });

/** One deep level each side, 0.1% off mid, so every fill is inside the default tolerance. */
const book = (m: BorosMarket, depth = 20_000_000): BorosOrderBook => ({
  marketId: m.marketId,
  bids: [[m.midApr - 0.001, depth]],
  asks: [[m.midApr + 0.001, depth]],
});

const leg = (m: BorosMarket, direction: 'long' | 'short', over: Partial<BorosPairLegInput> = {}): BorosPairLegInput => ({
  market: m,
  book: book(m),
  direction,
  slippageApr: DEFAULT_SLIPPAGE_APR,
  currentSize: 0,
  ...over,
});

const account: BorosPairAccountState = {
  cross: { available: 5_000, hasPositionOrOrders: true },
  isolatedByMarket: new Map(),
  gasBalanceUsd: 2,
};

/** Price one step the way the server does: simulate, then gate. */
function step(legA: BorosPairLegInput, legB: BorosPairLegInput, intent: 'close' | 'open', size = SIZE, acknowledged = true): RollStepInput {
  const simulation = simulateBorosPair({ legA, legB, size, intent, collateralPriceUsd: 1, nowSec: NOW });
  const gate = evaluatePairGate({
    simulation,
    legA,
    legB,
    account,
    eligibility: pairEligibility(legA.market, legB.market, NOW),
    opposingAcknowledged: acknowledged,
    simulatedAtMs: NOW * 1000,
    nowMs: NOW * 1000,
  });
  return { simulation, gate, legA, legB };
}

/** The account holds the old pair: SHORT Hyperliquid, LONG Binance. */
const exitLegs = () => ({
  legA: leg(hlOld, 'long', { currentSize: -SIZE, committedMargin: 1_000 }),
  legB: leg(bnOld, 'short', { currentSize: SIZE, committedMargin: 800 }),
});
const entryLegs = () => ({ legA: leg(hlNew, 'short'), legB: leg(bnNew, 'long') });

function rollInput(over: { exit?: RollStepInput; entry?: RollStepInput } = {}): Omit<EvaluateRollInput, 'venue'> {
  const x = exitLegs();
  const e = entryLegs();
  return {
    exit: over.exit ?? step(x.legA, x.legB, 'close'),
    entry: over.entry ?? step(e.legA, e.legB, 'open'),
  };
}

/** What the venue's preview says for a roll that goes through. */
const venueOk = (over: Partial<BorosRollSimulation> = {}): BorosRollSimulation => ({
  status: 'Succeed',
  reason: null,
  orders: [
    { action: 'close', marketId: 155, filled: true, matchedSize: SIZE, matchedApr: 0.091, fee: 4, error: null },
    { action: 'close', marketId: 101, filled: true, matchedSize: SIZE, matchedApr: 0.044, fee: 4, error: null },
    { action: 'open', marketId: 156, filled: true, matchedSize: SIZE, matchedApr: 0.099, fee: 4, error: null },
    { action: 'open', marketId: 102, filled: true, matchedSize: SIZE, matchedApr: 0.051, fee: 4, error: null },
  ],
  availableBefore: 5_000,
  availableAfter: 4_100,
  availableAfterExit: 5_300,
  marginRequired: 700,
  ...over,
});

describe('evaluateRollGate', () => {
  it('passes a clean roll and reports the margin the venue simulated', () => {
    const g = evaluateRollGate({ ...rollInput(), venue: venueOk() });
    expect(g.blockers).toEqual([]);
    expect(g.warnings).toEqual([]);
    expect(g.margin).toEqual({ need: 700, availableBefore: 5_000, availableAfter: 4_100, availableAfterExit: 5_300, shortfall: 0 });
  });

  it('keeps every exit blocker, drops the entry margin blockers, and prefixes both', () => {
    // A cross bucket with nothing spendable: the pair gate refuses the entry
    // for margin, but that verdict predates the exit freeing its margin — the
    // venue's preview, which runs the closes first, is the judge.
    const broke = { ...account, cross: { available: 0, hasPositionOrOrders: true } };
    const e = entryLegs();
    const entry = (() => {
      const simulation = simulateBorosPair({ ...e, size: SIZE, intent: 'open', collateralPriceUsd: 1, nowSec: NOW });
      const gate = evaluatePairGate({ simulation, ...e, account: broke, eligibility: pairEligibility(hlNew, bnNew, NOW), opposingAcknowledged: true, simulatedAtMs: NOW * 1000, nowMs: NOW * 1000 });
      return { simulation, gate, ...e };
    })();
    expect(entry.gate.blockers.map((b) => b.code)).toContain('cross-short-margin');
    const g = evaluateRollGate({ ...rollInput({ entry }), venue: venueOk() });
    expect(g.blockers).toEqual([]);

    // An exit blocker survives with its step named.
    const x = exitLegs();
    const stale = step(x.legA, x.legB, 'close');
    stale.gate = { ...stale.gate, blockers: [{ code: 'stale-simulation', message: 'old quote' }] };
    const g2 = evaluateRollGate({ ...rollInput({ exit: stale }), venue: venueOk() });
    expect(g2.blockers).toEqual([{ code: 'stale-simulation', message: 'Exit: old quote', step: 'exit', leg: undefined, marketId: undefined }]);
  });

  it('blocks when the venue could not preview the batch — nothing else can vouch for it', () => {
    const g = evaluateRollGate({ ...rollInput(), venue: null });
    expect(g.blockers.map((b) => b.code)).toEqual(['roll-unpriced']);
    expect(g.margin).toEqual({ need: null, availableBefore: null, availableAfter: null, availableAfterExit: null, shortfall: 0 });
  });

  it("blocks on the venue's refusal, naming the legs the book cannot fill", () => {
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const g = evaluateRollGate({ ...rollInput(), venue });
    expect(g.blockers).toHaveLength(1);
    expect(g.blockers[0].code).toBe('venue-refused');
    // The fixture book holds the size many times over, so the venue's
    // "Insufficient liquidity" (FOK not filled INSIDE THE BOUND) is slippage.
    const [head, line, ...rest] = g.blockers[0].message.split('\n');
    expect(head).toBe('The venue refuses this roll:');
    // …and this side's book does NOT agree it is short, so no depth is quoted:
    // a book that moved since it was read has nothing truthful to add.
    expect(line).toBe(
      'Re-entry · Hyperliquid ETH new — Slippage too high: the size does not fill inside the tolerance. Widen the tolerance or reduce the size.',
    );
    expect(rest).toEqual([]);
  });

  it('gives each refused leg its own line, cause and remedy', () => {
    const errors = [null, 'Insufficient liquidity', 'Large Rate Deviation', 'Not enough margin'];
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: errors[i] })),
      availableAfter: null,
    });
    const lines = evaluateRollGate({ ...rollInput(), venue }).blockers[0].message.split('\n');
    // The leg the venue did not name (it simply never ran) gets no line.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^Exit · .+ — Slippage too high: /);
    expect(lines[2]).toMatch(/^Re-entry · .+ — Rate limit exceeded \(Large Rate Deviation\): .+ Reduce the size\.$/);
    expect(lines[3]).toMatch(/^Re-entry · .+ — Not enough margin\. Add margin or roll a smaller size\.$/);
  });

  it("reports ONE error per leg: the venue's line replaces the pair gate's for a leg both flagged", () => {
    const e = entryLegs();
    const flagged = step(e.legA, e.legB, 'open');
    const [mA, mB] = [flagged.simulation.legA.marketId, flagged.simulation.legB.marketId];
    flagged.gate = {
      ...flagged.gate,
      blockers: [
        { code: 'rate-bound-out-of-range', leg: 'A', marketId: mA, message: 'A: bound outside the band' },
        { code: 'rate-bound-out-of-range', leg: 'B', marketId: mB, message: 'B: bound outside the band' },
      ],
    };
    // The venue names entry leg A only (orders: close A, close B, open A, open B).
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const g = evaluateRollGate({ ...rollInput({ entry: flagged }), venue });
    // One box, one line per leg: A in the venue's words, B in the gate's.
    expect(g.blockers.map((b) => b.code)).toEqual(['venue-refused']);
    const lines = g.blockers[0].message.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^Re-entry · .+ — Slippage too high: /);
    expect(lines[2]).toBe('Re-entry · B: bound outside the band');
  });

  it('keeps every distinct cause a leg the venue did not name carries', () => {
    const e = entryLegs();
    const flagged = step(e.legA, e.legB, 'open');
    const mB = flagged.simulation.legB.marketId;
    flagged.gate = {
      ...flagged.gate,
      blockers: [
        { code: 'rate-bound-out-of-range', leg: 'B', marketId: mB, message: 'B: bound outside the band' },
        { code: 'margin-unknown', leg: 'B', marketId: mB, message: 'B: margin unknown' },
      ],
    };
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const lines = evaluateRollGate({ ...rollInput({ entry: flagged }), venue }).blockers[0].message.split('\n');
    expect(lines.slice(2)).toEqual(['Re-entry · B: bound outside the band', 'Re-entry · B: margin unknown']);
  });

  it('calls it liquidity only when the whole book cannot supply the size', () => {
    // A thin exit book: the walk itself falls short, at any rate.
    const x = exitLegs();
    const thin = step({ ...x.legA, book: { ...x.legA.book!, bids: [[0.05, 1]], asks: [[0.051, 1]] } }, x.legB, 'close');
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 0 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const g = evaluateRollGate({ ...rollInput({ exit: thin }), venue });
    const refused = g.blockers.find((b) => b.code === 'venue-refused');
    expect(refused?.message.split('\n')[1]).toMatch(/^Exit · .+ — Insufficient liquidity: the whole book holds 1 \w+\. Reduce the size\.$/);
  });

  it('names how much the book DOES fill whole when the venue refuses a leg for liquidity', () => {
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const input = rollInput();
    input.entry.simulation.legA.sizeWithinTolerance = 562.6;
    const g = evaluateRollGate({ ...input, venue });
    // The venue's "Insufficient liquidity" is a FOK not filled INSIDE THE
    // BOUND; this side's book agrees it is short (562.6 < the size), so the
    // line names the cause as slippage and the depth that does fill.
    expect(g.blockers[0].message.split('\n')).toEqual([
      'The venue refuses this roll:',
      'Re-entry · Hyperliquid ETH new — Slippage too high: only 562.6 USDT fills inside the 0.25% tolerance. Widen the tolerance or reduce the size.',
    ]);
  });

  it("blocks on the venue's margin refusal and reports the shortfall it simulated", () => {
    const venue = venueOk({ status: 'Refused', reason: { code: 'INSUFFICIENT_MARGIN', message: 'InsufficientMargin' }, availableAfter: -250 });
    const g = evaluateRollGate({ ...rollInput(), venue });
    expect(g.blockers[0].message).toBe('The venue refuses this roll — InsufficientMargin. Add margin or roll a smaller size.');
    expect(g.margin.shortfall).toBe(250);
  });

  it("reads the contract's mid-batch margin revert as a margin refusal, sized off the account once the closes ran", () => {
    // Reverts before the venue's own post-batch check: no after-state. The
    // opens were judged on the margin left once the closes ran, which the
    // venue still reports — the shortfall is what they need beyond it.
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MM_INSUFFICIENT_IM', message: 'Not enough margin' },
      availableAfter: null,
      availableAfterExit: 700,
      marginRequired: 1_000,
    });
    const g = evaluateRollGate({ ...rollInput(), venue });
    expect(g.blockers[0].message).toBe('The venue refuses this roll — Not enough margin. Add margin or roll a smaller size.');
    expect(g.margin).toEqual({ need: 1_000, availableBefore: 5_000, availableAfter: null, availableAfterExit: 700, shortfall: 300 });
  });

  it('has no shortfall figure for a refusal that is not about margin, or from a venue that reports no exit state', () => {
    const liquidity = venueOk({ status: 'Refused', reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' }, availableAfter: null, availableAfterExit: 700, marginRequired: 1_000 });
    expect(evaluateRollGate({ ...rollInput(), venue: liquidity }).margin.shortfall).toBe(0);
    const older = venueOk({ status: 'Refused', reason: { code: 'MM_INSUFFICIENT_IM', message: 'Not enough margin' }, availableAfter: null, availableAfterExit: null });
    expect(evaluateRollGate({ ...rollInput(), venue: older }).margin.shortfall).toBe(0);
  });

  it('refuses a roll into the same or an earlier maturity', () => {
    const e = entryLegs();
    const sameMaturity = step({ ...e.legA, market: { ...hlNew, maturity: OLD } }, { ...e.legB, market: { ...bnNew, maturity: OLD } }, 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: sameMaturity }), venue: venueOk() });
    expect(g.blockers.map((b) => b.code)).toContain('maturity-not-later');
  });

  it('refuses legs that do not share one collateral token', () => {
    const e = entryLegs();
    const btcMargined = step({ ...e.legA, market: { ...hlNew, tokenId: 1 } }, { ...e.legB, market: { ...bnNew, tokenId: 1 } }, 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: btcMargined }), venue: venueOk() });
    expect(g.blockers.map((b) => b.code)).toContain('collateral-mismatch');
  });

  it('refuses a new leg that would not hold the side the old one holds', () => {
    // Re-entering LONG on Hyperliquid where the account is SHORT flips the hedge.
    const flipped = step(leg(hlNew, 'long'), leg(bnNew, 'short'), 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: flipped }), venue: venueOk() });
    expect(g.blockers.filter((b) => b.code === 'sides-mismatch')).toHaveLength(2);
  });

  it('refuses a new leg that is not the old leg one maturity later', () => {
    // Rolling the Hyperliquid leg into a Binance market keeps the sides and
    // the collateral but changes the hedge; a roll is the same shape later.
    const e = entryLegs();
    const swapped = step({ ...e.legA, market: { ...hlNew, venue: 'Binance' } }, e.legB, 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: swapped }), venue: venueOk() });
    expect(g.blockers.filter((b) => b.code === 'market-mismatch').map((b) => b.leg)).toEqual(['A']);
  });

  it('refuses when the exit was clamped to the position but the entry was not', () => {
    // Asked to roll 150k on a 100k position: the close clamps, the open would not.
    const x = exitLegs();
    const e = entryLegs();
    const g = evaluateRollGate({ ...rollInput({ exit: step(x.legA, x.legB, 'close', 150_000), entry: step(e.legA, e.legB, 'open', 150_000) }), venue: venueOk() });
    const mismatch = g.blockers.filter((b) => b.code === 'size-mismatch');
    expect(mismatch).toHaveLength(2);
    expect(mismatch[0].message).toMatch(/closes 100000 but .* would open 150000/);
  });

  it('says an account-level warning once, not once per step', () => {
    // Both steps' pair gates warn about the same low gas budget.
    const low = { ...account, gasBalanceUsd: 0.1 };
    const x = exitLegs();
    const e = entryLegs();
    const stepWith = (legA: BorosPairLegInput, legB: BorosPairLegInput, intent: 'close' | 'open') => {
      const simulation = simulateBorosPair({ legA, legB, size: SIZE, intent, collateralPriceUsd: 1, nowSec: NOW });
      const gate = evaluatePairGate({ simulation, legA, legB, account: low, eligibility: pairEligibility(legA.market, legB.market, NOW), opposingAcknowledged: true, simulatedAtMs: NOW * 1000, nowMs: NOW * 1000 });
      return { simulation, gate, legA, legB };
    };
    const g = evaluateRollGate({ exit: stepWith(x.legA, x.legB, 'close'), entry: stepWith(e.legA, e.legB, 'open'), venue: venueOk() });
    expect(g.warnings.filter((w) => /tops it up as it sends/.test(w))).toHaveLength(1);
  });
});

describe('rollLegsFor', () => {
  it('names each leg for the venue: the old market, the new one, the size closed and both rate bounds', () => {
    const input = rollInput();
    const legs = rollLegsFor(input.exit.simulation, input.entry.simulation)!;
    expect(legs).toEqual([
      // Closing the Hyperliquid short = buying at mid + tol; re-opening it = selling at mid − tol.
      { fromMarketId: 155, toMarketId: 156, size: SIZE, closeRate: 0.09 + DEFAULT_SLIPPAGE_APR, openRate: 0.1 - DEFAULT_SLIPPAGE_APR },
      { fromMarketId: 101, toMarketId: 102, size: SIZE, closeRate: 0.045 - DEFAULT_SLIPPAGE_APR, openRate: 0.05 + DEFAULT_SLIPPAGE_APR },
    ]);
  });

  it('carries the CLAMPED size when more than the position was asked', () => {
    const x = exitLegs();
    const e = entryLegs();
    const legs = rollLegsFor(step(x.legA, x.legB, 'close', 150_000).simulation, step(e.legA, e.legB, 'open', 150_000).simulation)!;
    expect(legs.map((l) => l.size)).toEqual([SIZE, SIZE]);
  });

  it('is null when a leg has nothing to trade', () => {
    const x = exitLegs();
    const e = entryLegs();
    // Flat on Binance: nothing to close there, so no batch.
    const exit = step(x.legA, { ...x.legB, currentSize: 0 }, 'close');
    expect(rollLegsFor(exit.simulation, step(e.legA, e.legB, 'open').simulation)).toBeNull();
  });
});

const fill = (marketId: number, over: Partial<BorosLegFill> = {}): BorosLegFill => ({
  marketId,
  direction: 'long',
  filledSize: SIZE,
  shortfallSize: 0,
  execApr: null,
  feeSize: null,
  failure: null,
  ...over,
});
const refused = (marketId: number, message: string, cause: 'this-leg' | 'batch'): BorosLegFill =>
  fill(marketId, { filledSize: 0, shortfallSize: SIZE, failure: { code: 'insufficient-margin', message, cause } });

describe('readRollFills', () => {
  it('is rolled only when all four legs filled whole', () => {
    const r = readRollFills([fill(155), fill(101), fill(156), fill(102)]);
    expect(r.status).toBe('rolled');
    expect(r.rolledSize).toBe(SIZE);
    expect(r.reason).toBeNull();
    // An 18-decimal size does not survive a float round-trip: 99999.99999999999 is whole.
    const dust = readRollFills([fill(155, { filledSize: SIZE - 1e-11, shortfallSize: 1e-11 }), fill(101), fill(156), fill(102)]);
    expect(dust.status).toBe('rolled');
  });

  it('is refused, naming the leg the venue named, when the batch was turned away', () => {
    const msg = '[SIMULATE] Not enough margin';
    const r = readRollFills([refused(155, msg, 'batch'), refused(101, msg, 'batch'), refused(156, msg, 'this-leg'), refused(102, msg, 'batch')]);
    expect(r.status).toBe('refused');
    expect(r.reason).toEqual({ code: 'insufficient-margin', message: msg, leg: 'entryA' });
    expect(r.rolledSize).toBe(0);
    // No leg named (the top-up was the failing call): the reason stands, unattributed.
    const r2 = readRollFills([refused(155, msg, 'batch'), refused(101, msg, 'batch'), refused(156, msg, 'batch'), refused(102, msg, 'batch')]);
    expect(r2.reason).toEqual({ code: 'insufficient-margin', message: msg, leg: null });
  });

  it('is unknown when any leg was never confirmed — even if the others read as filled', () => {
    const lost = fill(102, { filledSize: 0, shortfallSize: SIZE, failure: { code: 'unknown', message: 'no status came back' } });
    const r = readRollFills([fill(155), fill(101), fill(156), lost]);
    expect(r.status).toBe('unknown');
    expect(r.reason).toEqual({ code: 'unknown', message: 'no status came back', leg: null });
  });

  it('is unknown, not rolled or partial, when the venue reports a fill FOK cannot produce', () => {
    const r = readRollFills([fill(155), fill(101), fill(156, { filledSize: SIZE * 0.6, shortfallSize: SIZE * 0.4 }), fill(102)]);
    expect(r.status).toBe('unknown');
    expect(r.reason!.message).toMatch(/FOK legs cannot produce/);
    expect(readRollFills([fill(155), fill(101), fill(156)]).status).toBe('unknown');
  });
});

describe('submitBorosRoll', () => {
  const legs = (): BorosRollLeg[] => [
    { fromMarketId: 155, toMarketId: 156, size: SIZE },
    { fromMarketId: 101, toMarketId: 102, size: SIZE },
  ];

  it('hands the legs to the venue once and reads the verdict off its four answers', async () => {
    const rollOver = vi.fn(async () => [fill(155), fill(101), fill(156), fill(102)]);
    const client = { rollOver } as unknown as BorosOrderClient;
    const r = await submitBorosRoll(client, legs());
    expect(rollOver).toHaveBeenCalledTimes(1);
    expect(rollOver).toHaveBeenCalledWith(legs());
    expect(r.status).toBe('rolled');
  });

  it('folds a transport throw into unknown — the batch may have gone through', async () => {
    const client = { rollOver: vi.fn(async () => { throw new Error('Boros order submission timed out'); }) } as unknown as BorosOrderClient;
    const r = await submitBorosRoll(client, legs());
    expect(r.status).toBe('unknown');
    expect(r.reason!.message).toMatch(/timed out — the roll may or may not have gone through/);
    expect(Object.values(r.legs).every((l) => l.failure?.code === 'unknown')).toBe(true);
    expect(Object.values(r.legs).map((l) => l.marketId)).toEqual([155, 101, 156, 102]);
  });
});
