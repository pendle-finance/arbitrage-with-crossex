/**
 * The all-or-nothing roll (src/core/boros/rollover.ts): the checks that only
 * exist because two pairs go out as one batch, how the venue's preview
 * becomes the gate's verdict and margin figures, the legs handed to the
 * venue, and how its four fills become one outcome. Simulations and pair gates are produced by the real pair module —
 * they are inputs here, not the code under test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import type { BorosLegFill, BorosOrderClient, BorosRollSimulation } from '../../src/core/boros/orders';
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
  rollPlanFor,
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
  spreadVenues: null,
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
function step(legs: BorosPairLegInput[], intent: 'close' | 'open', size = SIZE, on: BorosPairAccountState = account): RollStepInput {
  const simulation = simulateBorosPair({ legs: legs.map((l) => ({ ...l, size })), intent, collateralPriceUsd: 1, nowSec: NOW });
  const gate = evaluatePairGate({
    simulation,
    legs,
    account: on,
    eligibility: pairEligibility(legs.map((l) => l.market), NOW, intent),
    opposingAcknowledged: true,
    simulatedAtMs: NOW * 1000,
    nowMs: NOW * 1000,
  });
  return { simulation, gate, legs };
}

/** The account holds the old pair: SHORT Hyperliquid, LONG Binance. */
const exitLegs = (size = SIZE) => [
  leg(hlOld, 'long', { currentSize: -size, committedMargin: 1_000 }),
  leg(bnOld, 'short', { currentSize: size, committedMargin: 800 }),
];
const entryLegs = () => [leg(hlNew, 'short'), leg(bnNew, 'long')];

function rollInput(over: { exit?: RollStepInput; entry?: RollStepInput } = {}): Omit<EvaluateRollInput, 'venue'> {
  return {
    exit: over.exit ?? step(exitLegs(), 'close'),
    entry: over.entry ?? step(entryLegs(), 'open'),
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
    const entry = step(entryLegs(), 'open', SIZE, broke);
    expect(entry.gate.blockers.map((b) => b.code)).toContain('cross-short-margin');
    const g = evaluateRollGate({ ...rollInput({ entry }), venue: venueOk() });
    expect(g.blockers).toEqual([]);

    // An exit blocker survives with its step named.
    const stale = step(exitLegs(), 'close');
    stale.gate = { ...stale.gate, blockers: [{ code: 'stale-simulation', message: 'old quote' }] };
    const g2 = evaluateRollGate({ ...rollInput({ exit: stale }), venue: venueOk() });
    expect(g2.blockers).toEqual([{ code: 'stale-simulation', message: 'Exit: old quote', step: 'exit', leg: undefined, marketId: undefined }]);
  });

  it('blocks when the venue could not preview the batch — nothing else can vouch for it', () => {
    const g = evaluateRollGate({ ...rollInput(), venue: null });
    expect(g.blockers.map((b) => b.code)).toEqual(['roll-unpriced']);
    expect(g.margin).toEqual({ need: null, availableBefore: null, availableAfter: null, availableAfterExit: null, shortfall: 0 });
  });

  it('a new market whose book has no price on the open side: its own blocker says why, not "waiting for a quote"', () => {
    // A fresh listing: bids only, and the re-entry opens long on it.
    const fresh = { ...book(bnNew), asks: [] };
    const entry = step([leg(hlNew, 'short'), leg(bnNew, 'long', { book: fresh })], 'open');
    // No rate to send at, so the batch is never previewed.
    expect(rollPlanFor(rollInput().exit.simulation, entry.simulation)).toBeNull();
    const g = evaluateRollGate({ ...rollInput({ entry }), venue: null });
    // Still blocked, by the step that cannot price, and only by it.
    expect(g.blockers.map((b) => b.code)).toEqual(['no-depth']);
    expect(g.blockers[0].message).toBe('Re-entry: Binance ETH new: nothing resting on the side this leg would cross.');
    // A book that could not be fetched at all is the same: its step says so.
    const unread = step([leg(hlNew, 'short'), leg(bnNew, 'long', { book: null })], 'open');
    expect(evaluateRollGate({ ...rollInput({ entry: unread }), venue: null }).blockers.map((b) => b.code)).toEqual(['book-unavailable']);
    // A priced batch whose preview went unanswered (429, timeout) keeps waiting.
    expect(evaluateRollGate({ ...rollInput(), venue: null }).blockers.map((b) => b.message)).toEqual([
      'The venue could not preview this roll — waiting for a quote.',
    ]);
  });

  it('a self-swap names the trader\'s own resting order and how to clear it', () => {
    for (const error of ['Self swapping error', 'MarketSelfSwap()']) {
      const venue = venueOk({
        status: 'Refused',
        reason: { code: 'MarketSelfSwap', message: error },
        orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? error : null })),
        availableAfter: null,
      });
      const [, line, ...rest] = evaluateRollGate({ ...rollInput(), venue }).blockers[0].message.split('\n');
      expect(line).toBe('• Re-entry · Hyperliquid ETH new: Your own order on this market blocks the fill.');
      expect(rest).toEqual(['Fix: Cancel it on Boros, then roll.']);
    }
  });

  it('a full market cap says which slot to free, not the raw contract error', () => {
    const error = 'MMMarketLimitExceeded()';
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MM_MARKET_LIMIT_EXCEEDED', message: error },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? error : null })),
      availableAfter: null,
    });
    const [, line, fix] = evaluateRollGate({ ...rollInput(), venue }).blockers[0].message.split('\n');
    expect(line).toBe('• Re-entry · Hyperliquid ETH new: Market limit reached: every Boros market slot holds a position or an order.');
    expect(fix).toBe('Fix: Close a position you no longer need, then roll.');
  });

  // A whole roll exits the old markets once flat, so on a part roll "roll the
  // whole position" is the fix that keeps every other position open.
  it('a market-limit refusal on a part roll offers the whole roll first', () => {
    const error = 'MMMarketLimitExceeded()';
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MM_MARKET_LIMIT_EXCEEDED', message: error },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? error : null })),
      availableAfter: null,
    });
    const exit = step(exitLegs(SIZE * 2), 'close', SIZE);
    const fix = evaluateRollGate({ ...rollInput({ exit }), venue }).blockers[0].message.split('\n').at(-1);
    expect(fix).toBe('Fix: Roll the whole position (it frees the old markets), or close a position you no longer need.');
  });

  // Live 16 Oct: both opens refused for the market cap read as one sentence
  // twice. Legs sharing a cause share one bullet, and the fix is said once.
  it('groups the legs that share a cause into one bullet and says each fix once', () => {
    const error = 'MMMarketLimitExceeded()';
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MM_MARKET_LIMIT_EXCEEDED', message: error },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i >= 2 ? error : null })),
      availableAfter: null,
    });
    expect(evaluateRollGate({ ...rollInput(), venue }).blockers[0].message.split('\n')).toEqual([
      'The venue refuses this roll:',
      '• Re-entry · Hyperliquid ETH new, Binance ETH new: Market limit reached: every Boros market slot holds a position or an order.',
      'Fix: Close a position you no longer need, then roll.',
    ]);
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
    expect(line).toBe('• Re-entry · Hyperliquid ETH new: Slippage too high: the size does not fill inside the tolerance.');
    expect(rest).toEqual(['Fix: Widen the tolerance or reduce the size.']);
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
    expect(lines).toHaveLength(7);
    expect(lines[1]).toMatch(/^• Exit · .+: Slippage too high: /);
    expect(lines[2]).toMatch(/^• Re-entry · .+: Rate limit exceeded \(Large Rate Deviation\): the rate sits too far from the venue's mark\.$/);
    expect(lines[3]).toMatch(/^• Re-entry · .+: Not enough margin\.$/);
    // Each cause's own remedy, once.
    expect(lines.slice(4)).toEqual([
      'Fix: Widen the tolerance or reduce the size.',
      'Fix: Reduce the size.',
      'Fix: Add margin or roll a smaller size.',
    ]);
  });

  it("reports ONE error per leg: the venue's line replaces the pair gate's for a leg both flagged", () => {
    const flagged = step(entryLegs(), 'open');
    const [mA, mB] = flagged.simulation.legs.map((l) => l.marketId);
    flagged.gate = {
      ...flagged.gate,
      blockers: [
        { code: 'rate-bound-out-of-range', leg: 0, marketId: mA, message: 'A: bound outside the band' },
        { code: 'rate-bound-out-of-range', leg: 1, marketId: mB, message: 'B: bound outside the band' },
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
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^• Re-entry · .+: Slippage too high: /);
    expect(lines[2]).toBe('• Re-entry · B: bound outside the band');
    expect(lines[3]).toBe('Fix: Widen the tolerance or reduce the size.');
  });

  it('keeps every distinct cause a leg the venue did not name carries', () => {
    const flagged = step(entryLegs(), 'open');
    const mB = flagged.simulation.legs[1].marketId;
    flagged.gate = {
      ...flagged.gate,
      blockers: [
        { code: 'rate-bound-out-of-range', leg: 1, marketId: mB, message: 'B: bound outside the band' },
        { code: 'margin-unknown', leg: 1, marketId: mB, message: 'B: margin unknown' },
      ],
    };
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const lines = evaluateRollGate({ ...rollInput({ entry: flagged }), venue }).blockers[0].message.split('\n');
    expect(lines.slice(2)).toEqual([
      '• Re-entry · B: bound outside the band',
      '• Re-entry · B: margin unknown',
      'Fix: Widen the tolerance or reduce the size.',
    ]);
  });

  it('calls it liquidity only when the whole book cannot supply the size', () => {
    // A thin exit book: the walk itself falls short, at any rate.
    const [a, b] = exitLegs();
    const thin = step([{ ...a, book: { ...a.book!, bids: [[0.05, 1]], asks: [[0.051, 1]] } }, b], 'close');
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 0 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const g = evaluateRollGate({ ...rollInput({ exit: thin }), venue });
    const refused = g.blockers.find((b) => b.code === 'venue-refused');
    expect(refused?.message.split('\n').slice(1)).toEqual([
      expect.stringMatching(/^• Exit · .+: Insufficient liquidity: the whole book holds 1 \w+\.$/),
      'Fix: Reduce the size.',
    ]);
  });

  it('names how much the book DOES fill whole when the venue refuses a leg for liquidity', () => {
    const venue = venueOk({
      status: 'Refused',
      reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
      orders: venueOk().orders.map((o, i) => ({ ...o, filled: false, matchedSize: null, error: i === 2 ? 'Insufficient liquidity' : null })),
      availableAfter: null,
    });
    const input = rollInput();
    input.entry.simulation.legs[0].sizeWithinTolerance = 562.6;
    const g = evaluateRollGate({ ...input, venue });
    // The venue's "Insufficient liquidity" is a FOK not filled INSIDE THE
    // BOUND; this side's book agrees it is short (562.6 < the size), so the
    // line names the cause as slippage and the depth that does fill.
    expect(g.blockers[0].message.split('\n')).toEqual([
      'The venue refuses this roll:',
      '• Re-entry · Hyperliquid ETH new: Slippage too high: only 562.6 USDT fills inside the 0.25% tolerance.',
      'Fix: Widen the tolerance or reduce the size.',
    ]);
  });

  it("blocks on the venue's margin refusal and reports the shortfall it simulated", () => {
    const venue = venueOk({ status: 'Refused', reason: { code: 'INSUFFICIENT_MARGIN', message: 'InsufficientMargin' }, availableAfter: -250 });
    const g = evaluateRollGate({ ...rollInput(), venue });
    expect(g.blockers[0].message).toBe('The venue refuses this roll:\n• InsufficientMargin.\nFix: Add margin or roll a smaller size.');
    expect(g.margin.shortfall).toBe(250);
  });

  // Live 16 Oct: two opens that each pass alone, but need one more market
  // slot than the closes free. No order is to blame; "widen" was wrong advice.
  it('a market-limit refusal with no one order to blame gets the market-limit advice', () => {
    const venue = venueOk({ status: 'Refused', reason: { code: 'MM_MARKET_LIMIT_EXCEEDED', message: 'MMMarketLimitExceeded()' }, availableAfter: null });
    const g = evaluateRollGate({ ...rollInput(), venue });
    expect(g.blockers[0].message).toBe(
      'The venue refuses this roll:\n• Market limit reached: every Boros market slot holds a position or an order.\nFix: Close a position you no longer need, then roll.',
    );
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
    expect(g.blockers[0].message).toBe('The venue refuses this roll:\n• Not enough margin.\nFix: Add margin or roll a smaller size.');
    expect(g.margin).toEqual({ need: 1_000, availableBefore: 5_000, availableAfter: null, availableAfterExit: 700, shortfall: 300 });
  });

  it('has no shortfall figure for a refusal that is not about margin, or from a venue that reports no exit state', () => {
    const liquidity = venueOk({ status: 'Refused', reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' }, availableAfter: null, availableAfterExit: 700, marginRequired: 1_000 });
    expect(evaluateRollGate({ ...rollInput(), venue: liquidity }).margin.shortfall).toBe(0);
    const older = venueOk({ status: 'Refused', reason: { code: 'MM_INSUFFICIENT_IM', message: 'Not enough margin' }, availableAfter: null, availableAfterExit: null });
    expect(evaluateRollGate({ ...rollInput(), venue: older }).margin.shortfall).toBe(0);
  });

  it('refuses a roll into the same or an earlier maturity', () => {
    const [a, b] = entryLegs();
    const sameMaturity = step([{ ...a, market: { ...hlNew, maturity: OLD } }, { ...b, market: { ...bnNew, maturity: OLD } }], 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: sameMaturity }), venue: venueOk() });
    expect(g.blockers.map((b) => b.code)).toContain('maturity-not-later');
  });

  it('refuses legs that do not share one collateral token', () => {
    const [a, b] = entryLegs();
    const btcMargined = step([{ ...a, market: { ...hlNew, tokenId: 1 } }, { ...b, market: { ...bnNew, tokenId: 1 } }], 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: btcMargined }), venue: venueOk() });
    expect(g.blockers.map((b) => b.code)).toContain('collateral-mismatch');
  });

  it('refuses a new leg that would not hold the side the old one holds', () => {
    // Re-entering LONG on Hyperliquid where the account is SHORT flips the hedge.
    const flipped = step([leg(hlNew, 'long'), leg(bnNew, 'short')], 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: flipped }), venue: venueOk() });
    expect(g.blockers.filter((b) => b.code === 'sides-mismatch')).toHaveLength(2);
  });

  it('refuses a new leg that is not the old leg one maturity later', () => {
    // Rolling the Hyperliquid leg into a Binance market keeps the sides and
    // the collateral but changes the hedge; a roll is the same shape later.
    const [a, b] = entryLegs();
    const swapped = step([{ ...a, market: { ...hlNew, venue: 'Binance' } }, b], 'open');
    const g = evaluateRollGate({ ...rollInput({ entry: swapped }), venue: venueOk() });
    expect(g.blockers.filter((x) => x.code === 'market-mismatch').map((x) => x.leg)).toEqual([0]);
  });

  it('refuses when the exit was clamped to the position but the entry was not', () => {
    // Asked to roll 150k on a 100k position: the close clamps, the open would not.
    const g = evaluateRollGate({ ...rollInput({ exit: step(exitLegs(), 'close', 150_000), entry: step(entryLegs(), 'open', 150_000) }), venue: venueOk() });
    const mismatch = g.blockers.filter((b) => b.code === 'size-mismatch');
    expect(mismatch).toHaveLength(2);
    expect(mismatch[0].message).toMatch(/closes 100000 but .* would open 150000/);
  });

  it('says an account-level warning once, not once per step', () => {
    // Both steps' pair gates warn about the same low gas budget.
    const low = { ...account, gasBalanceUsd: 0.1 };
    const g = evaluateRollGate({ exit: step(exitLegs(), 'close', SIZE, low), entry: step(entryLegs(), 'open', SIZE, low), venue: venueOk() });
    expect(g.warnings.filter((w) => /tops it up as it sends/.test(w))).toHaveLength(1);
  });

  it('says one gas line at gas debt on a short zone, the one the roll batch sends', () => {
    const debt = { ...account, gasBalanceUsd: -0.5, cross: { available: 0, hasPositionOrOrders: true } };
    const g = evaluateRollGate({ exit: step(exitLegs(), 'close', SIZE, debt), entry: step(entryLegs(), 'open', SIZE, debt), venue: venueOk() });
    const gas = g.warnings.filter((w) => w.startsWith('Prepaid gas'));
    expect(gas).toHaveLength(1);
    expect(gas[0]).toMatch(/from this market's cross margin/);
  });
});

describe('rollPlanFor', () => {
  it("closes every old leg, then re-opens each on its own venue and side, with each order's rate bound", () => {
    const input = rollInput();
    const plan = rollPlanFor(input.exit.simulation, input.entry.simulation)!;
    const row = (o: (typeof plan.closes)[number]) => [o.marketId, o.direction, o.size, o.clientOrderId];
    expect(plan.closes.map(row)).toEqual([
      [155, 'long', SIZE, 'exit:155'],
      [101, 'short', SIZE, 'exit:101'],
    ]);
    expect(plan.opens.map(row)).toEqual([
      [156, 'short', SIZE, 'entry:156'],
      [102, 'long', SIZE, 'entry:102'],
    ]);
    // Closing the Hyperliquid short = buying at mid + tol; re-opening it = selling at mid − tol.
    expect(plan.closes.map((o) => o.limitApr)).toEqual([0.09 + DEFAULT_SLIPPAGE_APR, 0.045 - DEFAULT_SLIPPAGE_APR]);
    expect(plan.opens.map((o) => o.limitApr)).toEqual([0.1 - DEFAULT_SLIPPAGE_APR, 0.05 + DEFAULT_SLIPPAGE_APR]);
  });

  it('carries the CLAMPED size when more than the position was asked', () => {
    const plan = rollPlanFor(step(exitLegs(), 'close', 150_000).simulation, step(entryLegs(), 'open', 150_000).simulation)!;
    expect([...plan.closes, ...plan.opens].map((o) => o.size)).toEqual([SIZE, SIZE, SIZE, SIZE]);
  });

  it.each([
    ['$50', 50, '49999999999999999999'],
    ['$6M', 6_000_000, '5999999999999999999999999'],
  ])("%s: re-opens each leg at its close's exact wei, so the new maturity holds what the old one did", (_label, size, wei) => {
    const plan = rollPlanFor(step(exitLegs(size), 'close', size).simulation, step(entryLegs(), 'open', size).simulation, {
      openSizeWei: { 155: wei },
    })!;
    expect(plan.closes.map((o) => o.sizeWei)).toEqual([wei, undefined]);
    expect(plan.opens.map((o) => [o.marketId, o.sizeWei])).toEqual([
      [156, wei],
      [102, undefined],
    ]);
    expect(plan.opens[0].size).toBe(plan.closes[0].size);
  });

  it('is null when a leg has nothing to trade', () => {
    const [a, b] = exitLegs();
    // Flat on Binance: nothing to close there, so no batch.
    const exit = step([a, { ...b, currentSize: 0 }], 'close');
    expect(rollPlanFor(exit.simulation, step(entryLegs(), 'open').simulation)).toBeNull();
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

const KEYS = ['exit:155', 'exit:101', 'entry:156', 'entry:102'];

describe('readRollFills', () => {
  it('is rolled only when all four legs filled whole', () => {
    const r = readRollFills([fill(155), fill(101), fill(156), fill(102)], KEYS);
    expect(r.status).toBe('rolled');
    expect(r.rolledSize).toBe(SIZE);
    expect(r.reason).toBeNull();
    // An 18-decimal size does not survive a float round-trip: 99999.99999999999 is whole.
    const dust = readRollFills([fill(155, { filledSize: SIZE - 1e-11, shortfallSize: 1e-11 }), fill(101), fill(156), fill(102)], KEYS);
    expect(dust.status).toBe('rolled');
  });

  it('is refused, naming the leg the venue named, when the batch was turned away', () => {
    const msg = '[SIMULATE] Not enough margin';
    const r = readRollFills([refused(155, msg, 'batch'), refused(101, msg, 'batch'), refused(156, msg, 'this-leg'), refused(102, msg, 'batch')], KEYS);
    expect(r.status).toBe('refused');
    expect(r.reason).toEqual({ code: 'insufficient-margin', message: msg, leg: 'entry:156' });
    expect(r.rolledSize).toBe(0);
    // No leg named (the top-up was the failing call): the reason stands, unattributed.
    const r2 = readRollFills([refused(155, msg, 'batch'), refused(101, msg, 'batch'), refused(156, msg, 'batch'), refused(102, msg, 'batch')], KEYS);
    expect(r2.reason).toEqual({ code: 'insufficient-margin', message: msg, leg: null });
  });

  it('is unknown when any leg was never confirmed — even if the others read as filled', () => {
    const lost = fill(102, { filledSize: 0, shortfallSize: SIZE, failure: { code: 'unknown', message: 'no status came back' } });
    const r = readRollFills([fill(155), fill(101), fill(156), lost], KEYS);
    expect(r.status).toBe('unknown');
    expect(r.reason).toEqual({ code: 'unknown', message: 'no status came back', leg: null });
  });

  it('is unknown, not rolled or partial, when the venue reports a fill FOK cannot produce', () => {
    const r = readRollFills([fill(155), fill(101), fill(156, { filledSize: SIZE * 0.6, shortfallSize: SIZE * 0.4 }), fill(102)], KEYS);
    expect(r.status).toBe('unknown');
    expect(r.reason!.message).toMatch(/FOK legs cannot produce/);
    expect(readRollFills([fill(155), fill(101), fill(156)], KEYS).status).toBe('unknown');
  });
});

describe('submitBorosRoll', () => {
  const plan = () => {
    const input = rollInput();
    return rollPlanFor(input.exit.simulation, input.entry.simulation)!;
  };

  it('sends the closes then the opens as one FOK batch, the top-up after the closes, and reads the four answers', async () => {
    const placeMarketOrders = vi.fn(async () => [fill(155), fill(101), fill(156), fill(102)]);
    const client = { placeMarketOrders } as unknown as BorosOrderClient;
    const r = await submitBorosRoll(client, plan());
    expect(placeMarketOrders).toHaveBeenCalledTimes(1);
    expect(placeMarketOrders).toHaveBeenCalledWith([...plan().closes, ...plan().opens], { topUpAfter: 2, timeInForce: 'fill-or-kill' });
    expect(r.status).toBe('rolled');
    expect(Object.keys(r.legs)).toEqual(KEYS);
    // The old markets' resting-order cancels ride along to the venue client.
    await submitBorosRoll(client, plan(), { cancelOrdersOn: [101] });
    expect(placeMarketOrders).toHaveBeenLastCalledWith(expect.any(Array), { cancelOrdersOn: [101], topUpAfter: 2, timeInForce: 'fill-or-kill' });
  });

  it('folds a transport throw into unknown — the batch may have gone through', async () => {
    const client = { placeMarketOrders: vi.fn(async () => { throw new Error('Boros order submission timed out'); }) } as unknown as BorosOrderClient;
    const r = await submitBorosRoll(client, plan());
    expect(r.status).toBe('unknown');
    expect(r.reason!.message).toMatch(/timed out — the roll may or may not have gone through/);
    expect(Object.values(r.legs).every((l) => l.failure?.code === 'unknown')).toBe(true);
    expect(Object.values(r.legs).map((l) => l.marketId)).toEqual([155, 101, 156, 102]);
  });
});

describe('spread rolls', () => {
  const spread = (over: Partial<BorosMarket>): BorosMarket =>
    market({ spreadVenues: ['HYPERLIQUID', 'BINANCE'], venue: 'HL-Binance', markApr: 0.045, midApr: 0.045, ...over });
  const spreadOld = spread({ marketId: 157, name: 'ETH HL-Binance spread 7 Aug 2025' });
  const spreadNew = spread({ marketId: 158, name: 'ETH HL-Binance spread 6 Sep 2025', maturity: NEW, markApr: 0.05, midApr: 0.05 });
  const spreadExit = (size = SIZE) => [leg(spreadOld, 'long', { currentSize: -size, committedMargin: 1_000 })];

  it.each([50, 6_000_000])('rolls two singles into the spread as one batch, closes first (%d)', (size) => {
    const exit = step(exitLegs(size), 'close', size);
    const entry = step([leg(spreadNew, 'short')], 'open', size);
    expect(evaluateRollGate({ exit, entry, venue: venueOk() }).blockers).toEqual([]);
    const plan = rollPlanFor(exit.simulation, entry.simulation, { ids: { 'exit:155': 'id-1' } })!;
    expect(plan.closes.map((o) => [o.marketId, o.direction, o.size, o.clientOrderId])).toEqual([
      [155, 'long', size, 'id-1'],
      [101, 'short', size, 'exit:101'],
    ]);
    expect(plan.opens.map((o) => [o.marketId, o.direction, o.size])).toEqual([[158, 'short', size]]);
    expect(plan.opens[0].limitApr).toBeCloseTo(0.05 - DEFAULT_SLIPPAGE_APR, 12);
  });

  it.each([50, 6_000_000])('rolls the spread into two singles as one batch (%d)', (size) => {
    const exit = step(spreadExit(size), 'close', size);
    const entry = step(entryLegs(), 'open', size);
    expect(evaluateRollGate({ exit, entry, venue: venueOk() }).blockers).toEqual([]);
    const plan = rollPlanFor(exit.simulation, entry.simulation)!;
    expect([...plan.closes, ...plan.opens].map((o) => [o.marketId, o.direction, o.size])).toEqual([
      [157, 'long', size],
      [156, 'short', size],
      [102, 'long', size],
    ]);
  });

  it('a batch roll with no venue preview is blocked like any roll, and the re-entry margin is the venue\'s', () => {
    const exit = step(exitLegs(), 'close');
    const open = step([leg(spreadNew, 'short')], 'open');
    const short = { code: 'cross-short-margin' as const, message: 'Not enough ETH cross margin' };
    const entry = { ...open, gate: { ...open.gate, blockers: [...open.gate.blockers, short] } };
    expect(evaluateRollGate({ exit, entry, venue: null }).blockers.map((b) => b.code)).toEqual(['roll-unpriced']);
    // Judged before the closes free their margin, the stale shortfall gives way to the venue's figures.
    const g = evaluateRollGate({ exit, entry, venue: venueOk({ marginRequired: 40, availableAfterExit: 560, availableAfter: 520 }) });
    expect(g.blockers).toEqual([]);
    expect(g.margin).toMatchObject({ need: 40, availableAfterExit: 560, availableAfter: 520, shortfall: 0 });
  });

  // A whole spread roll frees one slot; two new singles need two (report 2026-10-18).
  it('a market-limit refusal on a part spread-to-singles roll does not offer the whole roll', () => {
    const error = 'MMMarketLimitExceeded()';
    const venue = venueOk({ status: 'Refused', reason: { code: 'MM_MARKET_LIMIT_EXCEEDED', message: error }, orders: [], availableAfter: null });
    const exit = step(spreadExit(SIZE * 2), 'close', SIZE);
    const fix = evaluateRollGate({ exit, entry: step(entryLegs(), 'open'), venue }).blockers[0].message.split('\n').at(-1);
    expect(fix).toBe('Fix: Close a position you no longer need, then roll.');
    // One of the two singles already held: the whole roll frees the one slot the other needs.
    const entry = step([leg(hlNew, 'short', { currentSize: -SIZE }), leg(bnNew, 'long')], 'open');
    expect(evaluateRollGate({ exit, entry, venue }).blockers[0].message.split('\n').at(-1)).toBe(
      'Fix: Roll the whole position (it frees the old markets), or close a position you no longer need.',
    );
  });

  it('rolls a spread into the next spread with one close and one open, which still needs the venue preview', () => {
    const exit = step(spreadExit(), 'close');
    const entry = step([leg(spreadNew, 'short')], 'open');
    const plan = rollPlanFor(exit.simulation, entry.simulation)!;
    expect([...plan.closes, ...plan.opens].map((o) => [o.marketId, o.direction, o.size])).toEqual([
      [157, 'long', SIZE],
      [158, 'short', SIZE],
    ]);
    expect(evaluateRollGate({ exit, entry, venue: null }).blockers.map((b) => b.code)).toEqual(['roll-unpriced']);
  });

  it('refuses a spread on the other side of the singles it replaces', () => {
    const g = evaluateRollGate({ exit: step(exitLegs(), 'close'), entry: step([leg(spreadNew, 'long')], 'open'), venue: venueOk() });
    expect(g.blockers.filter((b) => b.code === 'sides-mismatch').map((b) => b.leg)).toEqual([0, 1]);
  });

  it('refuses a spread over other venues than the singles', () => {
    const other = { ...spreadNew, spreadVenues: ['HYPERLIQUID', 'GATE'] as [string, string] };
    const g = evaluateRollGate({ exit: step(exitLegs(), 'close'), entry: step([leg(other, 'short')], 'open'), venue: venueOk() });
    const mismatch = g.blockers.filter((b) => b.code === 'market-mismatch');
    expect(mismatch.map((b) => [b.step, b.leg])).toEqual([
      ['exit', 1],
      ['entry', 0],
    ]);
    expect(mismatch[1].message).toBe('ETH HL-Binance spread 6 Sep 2025 does not match the pair being rolled.');
  });

  it("caps a batch close at the venue's own size when the float would overshoot it", () => {
    const exit = step(exitLegs(50), 'close', 50);
    const entry = step([leg(spreadNew, 'short')], 'open', 50);
    const plan = rollPlanFor(exit.simulation, entry.simulation, { openSizeWei: { 155: '49999999999999999999' } })!;
    expect(plan.closes.map((o) => o.sizeWei)).toEqual(['49999999999999999999', undefined]);
  });

  it('sends a batch through the bulk call, with the top-up after the closes, and keys the fills by step and market', async () => {
    const exit = step(exitLegs(), 'close');
    const entry = step([leg(spreadNew, 'short')], 'open');
    const plan = rollPlanFor(exit.simulation, entry.simulation)!;
    const placeMarketOrders = vi.fn(async () => [fill(155), fill(101), fill(158)]);
    const r = await submitBorosRoll({ placeMarketOrders } as unknown as BorosOrderClient, plan, { cancelOrdersOn: [101] });
    expect(placeMarketOrders).toHaveBeenCalledWith([...plan.closes, ...plan.opens], { cancelOrdersOn: [101], topUpAfter: 2, timeInForce: 'fill-or-kill' });
    expect(r.status).toBe('rolled');
    expect(Object.keys(r.legs)).toEqual(['exit:155', 'exit:101', 'entry:158']);
  });

  it('reads a batch that came back part filled as unknown', async () => {
    const plan = rollPlanFor(step(exitLegs(), 'close').simulation, step([leg(spreadNew, 'short')], 'open').simulation)!;
    const placeMarketOrders = vi.fn(async () => [fill(155), fill(101), fill(158, { filledSize: SIZE * 0.6, shortfallSize: SIZE * 0.4 })]);
    const r = await submitBorosRoll({ placeMarketOrders } as unknown as BorosOrderClient, plan);
    expect(r.status).toBe('unknown');
    expect(r.rolledSize).toBe(0);
  });

  const batchOf = (direction: 'singles-to-spread' | 'spread-to-singles', size: number) =>
    direction === 'singles-to-spread'
      ? rollPlanFor(step(exitLegs(size), 'close', size).simulation, step([leg(spreadNew, 'short')], 'open', size).simulation)!
      : rollPlanFor(step(spreadExit(size), 'close', size).simulation, step(entryLegs(), 'open', size).simulation)!;

  it.each<['singles-to-spread' | 'spread-to-singles', number]>([
    ['singles-to-spread', 50],
    ['singles-to-spread', 6_000_000],
    ['spread-to-singles', 50],
    ['spread-to-singles', 6_000_000],
  ])('sends every order of a %s batch fill-or-kill, and reads a batch the book could not fill whole as refused (%d)', async (direction, size) => {
    const plan = batchOf(direction, size);
    const orders = [...plan.closes, ...plan.opens];
    const msg = '[SIMULATE] Insufficient liquidity';
    const placeMarketOrders = vi.fn(async () =>
      orders.map((o, i) =>
        fill(o.marketId, {
          filledSize: 0,
          shortfallSize: o.size,
          failure: { code: 'insufficient-depth', message: msg, cause: i === orders.length - 1 ? 'this-leg' : 'batch' },
        }),
      ),
    );
    const r = await submitBorosRoll({ placeMarketOrders } as unknown as BorosOrderClient, plan);
    expect(placeMarketOrders).toHaveBeenCalledWith(orders, { topUpAfter: plan.closes.length, timeInForce: 'fill-or-kill' });
    expect(r.status).toBe('refused');
    expect(r.reason).toMatchObject({ code: 'insufficient-depth', message: msg });
    expect(r.rolledSize).toBe(0);
  });

  it.each([50, 6_000_000])('reads a failed batch where any order traded as unknown, never refused (%d)', async (size) => {
    const plan = batchOf('singles-to-spread', size);
    const placeMarketOrders = vi.fn(async () => [
      fill(155, { filledSize: size }),
      fill(101, { filledSize: size }),
      fill(158, { filledSize: size * 0.6, shortfallSize: size * 0.4, failure: { code: 'insufficient-depth', message: 'Only part matched inside the rate bound.' } }),
    ]);
    const r = await submitBorosRoll({ placeMarketOrders } as unknown as BorosOrderClient, plan);
    expect(r.status).toBe('unknown');
    expect(r.rolledSize).toBe(0);
  });

  describe('a mixed book: two singles and a spread', () => {
    const ETH_USD = 2_571.7;
    const rich: BorosPairAccountState = { ...account, cross: { available: 10_000_000, hasPositionOrOrders: true } };
    const stepEach = (legs: Array<[BorosPairLegInput, number]>, intent: 'close' | 'open'): RollStepInput => {
      const simulation = simulateBorosPair({
        legs: legs.map(([l, size]) => ({ ...l, size })),
        intent,
        collateralPriceUsd: ETH_USD,
        nowSec: NOW,
      });
      const bare = legs.map(([l]) => l);
      const gate = evaluatePairGate({
        simulation,
        legs: bare,
        account: rich,
        eligibility: pairEligibility(bare.map((l) => l.market), NOW, intent),
        opposingAcknowledged: true,
        simulatedAtMs: NOW * 1000,
        nowMs: NOW * 1000,
      });
      return { simulation, gate, legs: bare };
    };
    const venuesById = new Map<number, string[]>([
      [hlOld.marketId, ['HYPERLIQUID']],
      [bnOld.marketId, ['BINANCE']],
      [spreadOld.marketId, ['HYPERLIQUID', 'BINANCE']],
      [hlNew.marketId, ['HYPERLIQUID']],
      [bnNew.marketId, ['BINANCE']],
      [spreadNew.marketId, ['HYPERLIQUID', 'BINANCE']],
    ]);
    const addTo = (book: Map<string, number>, marketId: number, signed: number): void =>
      venuesById.get(marketId)!.forEach((v, i) => book.set(v, (book.get(v) ?? 0) + (i === 0 ? signed : -signed)));
    const book = (perVenue: number, hl = 0.3, bn = 0.3, sp = 0.255) => {
      const unit = perVenue / (hl + sp);
      return { hl: hl * unit, bn: bn * unit, sp: sp * unit };
    };
    const exitOf = (b: ReturnType<typeof book>, f: number) =>
      stepEach(
        [
          [leg(hlOld, 'long', { currentSize: -b.hl }), f * b.hl],
          [leg(bnOld, 'short', { currentSize: b.bn }), f * b.bn],
          [leg(spreadOld, 'long', { currentSize: -b.sp }), f * b.sp],
        ],
        'close',
      );

    it.each<[string, number, 'spread' | 'singles', number]>([
      ['$50', 50 / ETH_USD, 'spread', 1],
      ['$50', 50 / ETH_USD, 'singles', 1],
      ['$6M', 2_333, 'spread', 1],
      ['$6M', 2_333, 'singles', 1],
      ['$6M', 2_333, 'spread', 0.4],
      ['$6M', 2_333, 'singles', 0.4],
    ])('%s: rolls 0.300/0.300/0.255 into %s at share %d and keeps each venue exposure', (_label, perVenue, target, f) => {
      const b = book(perVenue);
      const exit = exitOf(b, f);
      const open = f * (b.hl + b.sp);
      const entry =
        target === 'spread'
          ? stepEach([[leg(spreadNew, 'short'), open]], 'open')
          : stepEach([[leg(hlNew, 'short'), open], [leg(bnNew, 'long'), f * (b.bn + b.sp)]], 'open');
      expect(evaluateRollGate({ exit, entry, venue: venueOk() }).blockers).toEqual([]);
      const plan = rollPlanFor(exit.simulation, entry.simulation)!;
      expect(plan.closes.map((o) => [o.marketId, o.direction])).toEqual([
        [hlOld.marketId, 'long'],
        [bnOld.marketId, 'short'],
        [spreadOld.marketId, 'long'],
      ]);

      const before = new Map<string, number>();
      addTo(before, hlOld.marketId, -b.hl);
      addTo(before, bnOld.marketId, b.bn);
      addTo(before, spreadOld.marketId, -b.sp);
      const after = new Map(before);
      for (const o of [...plan.closes, ...plan.opens]) addTo(after, o.marketId, (o.direction === 'long' ? 1 : -1) * o.size);
      expect(before.get('HYPERLIQUID')).toBeCloseTo(-perVenue, 9);
      expect(before.get('BINANCE')).toBeCloseTo(perVenue, 9);
      for (const venue of ['HYPERLIQUID', 'BINANCE']) {
        expect(Math.abs(after.get(venue)! - before.get(venue)!)).toBeLessThanOrEqual(1e-9 * perVenue);
      }
    });

    it.each([
      ['$50', 50 / ETH_USD],
      ['$6M', 2_333],
    ])('%s: refuses a spread target when the two venues hold different sizes, and rolls the same book into singles', (_label, perVenue) => {
      const b = book(perVenue, 0.3, 0.25);
      const exit = exitOf(b, 1);
      const intoSpread = evaluateRollGate({ exit, entry: stepEach([[leg(spreadNew, 'short'), b.hl + b.sp]], 'open'), venue: venueOk() });
      expect(intoSpread.blockers.map((x) => [x.code, x.step, x.message])).toEqual([
        ['size-mismatch', 'entry', 'This pair holds different sizes on its two venues. One spread cannot hold both.'],
      ]);
      const intoSingles = stepEach([[leg(hlNew, 'short'), b.hl + b.sp], [leg(bnNew, 'long'), b.bn + b.sp]], 'open');
      expect(evaluateRollGate({ exit, entry: intoSingles, venue: venueOk() }).blockers).toEqual([]);
    });

    it.each([
      ['$50', 50 / ETH_USD],
      ['$6M', 2_333],
    ])('%s: rolls exit legs that close different shares of their own size when each venue keeps its size', (_label, perVenue) => {
      const b = book(perVenue);
      const exit = stepEach(
        [
          [leg(hlOld, 'long', { currentSize: -b.hl }), b.sp],
          [leg(bnOld, 'short', { currentSize: b.bn }), b.sp],
          [leg(spreadOld, 'long', { currentSize: -b.sp }), b.sp],
        ],
        'close',
      );
      const g = evaluateRollGate({ exit, entry: stepEach([[leg(spreadNew, 'short'), 2 * b.sp]], 'open'), venue: venueOk() });
      expect(g.blockers).toEqual([]);
    });

    it.each([
      ['$50', 50 / ETH_USD],
      ['$6M', 2_333],
    ])('%s: rolls an even pair into a spread when the account holds more than the pair on one venue', (_label, pair) => {
      const exit = stepEach(
        [
          [leg(hlOld, 'long', { currentSize: -pair * 1.25 }), pair],
          [leg(bnOld, 'short', { currentSize: pair }), pair],
        ],
        'close',
      );
      const intoSpread = stepEach([[leg(spreadNew, 'short'), pair]], 'open');
      const intoSingles = stepEach([[leg(hlNew, 'short'), pair], [leg(bnNew, 'long'), pair]], 'open');
      expect(evaluateRollGate({ exit, entry: intoSpread, venue: venueOk() }).blockers).toEqual([]);
      expect(evaluateRollGate({ exit, entry: intoSingles, venue: null }).blockers.map((x) => x.code)).toEqual(['roll-unpriced']);
      const plan = rollPlanFor(exit.simulation, intoSpread.simulation)!;
      expect(plan.closes.map((o) => o.size)).toEqual([pair, pair]);
    });

    it.each([
      ['$50', 50 / ETH_USD],
      ['$6M', 2_333],
    ])('%s: refuses a spread when the roll closes different sizes on its two venues', (_label, pair) => {
      const exit = stepEach(
        [
          [leg(hlOld, 'long', { currentSize: -pair }), pair],
          [leg(bnOld, 'short', { currentSize: pair }), pair * 0.8],
        ],
        'close',
      );
      const g = evaluateRollGate({ exit, entry: stepEach([[leg(spreadNew, 'short'), pair]], 'open'), venue: venueOk() });
      expect(g.blockers.map((x) => [x.code, x.step])).toEqual([['size-mismatch', 'entry']]);
    });

    const below = (x: number): number => x * (1 - 2 ** -52);
    it.each([
      ['$50', 0.3, '300000000000000000', 0.255, '255000000000000000'],
      ['$6M', 7_000 / 3, '2333333333333333333333', 5_950 / 3, '1983333333333333333333'],
    ])('%s: a full roll whose exit carries a float tail closes the exact open size', (_label, single, singleWei, sp, spWei) => {
      expect(below(single)).toBeLessThan(single);
      if (single === 0.3) expect(below(single)).toBe(0.29999999999999993);
      const exit = stepEach(
        [
          [leg(hlOld, 'long', { currentSize: -single }), below(single)],
          [leg(bnOld, 'short', { currentSize: single }), below(single)],
          [leg(spreadOld, 'long', { currentSize: -sp }), sp],
        ],
        'close',
      );
      const entry = stepEach([[leg(spreadNew, 'short'), below(single) + sp]], 'open');
      expect(evaluateRollGate({ exit, entry, venue: venueOk() }).blockers).toEqual([]);
      const openSizeWei = { [hlOld.marketId]: singleWei, [bnOld.marketId]: singleWei, [spreadOld.marketId]: spWei };
      const plan = rollPlanFor(exit.simulation, entry.simulation, { openSizeWei })!;
      expect(plan.closes.map((o) => o.sizeWei)).toEqual([singleWei, singleWei, spWei]);
      expect(plan.opens.map((o) => o.sizeWei)).toEqual([undefined]);

      const rolled = rollPlanFor(
        stepEach([[leg(spreadOld, 'long', { currentSize: -single }), below(single)]], 'close').simulation,
        stepEach([[leg(spreadNew, 'short'), below(single)]], 'open').simulation,
        { openSizeWei: { [spreadOld.marketId]: singleWei } },
      )!;
      expect([...rolled.closes, ...rolled.opens].map((o) => [o.marketId, o.sizeWei])).toEqual([
        [spreadOld.marketId, singleWei],
        [spreadNew.marketId, singleWei],
      ]);
    });

    it('refuses an entry that opens less than the venue exposure it closes', () => {
      const b = book(2_333);
      const g = evaluateRollGate({ exit: exitOf(b, 1), entry: stepEach([[leg(spreadNew, 'short'), b.sp]], 'open'), venue: venueOk() });
      expect(g.blockers.map((x) => [x.code, x.step, x.leg])).toEqual([
        ['size-mismatch', 'exit', 0],
        ['size-mismatch', 'exit', 1],
      ]);
      expect(g.blockers[0].message).toMatch(/^Hyperliquid ETH old: the roll closes .* on this venue but opens .*\. A roll moves one size\.$/);
    });
  });
});
