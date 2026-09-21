/**
 * The all-or-nothing roll (src/core/boros/rollover.ts): the checks that only
 * exist because two pairs go out as one batch, the post-exit margin figure,
 * the four FOK wire orders, and how the venue's four answers become one
 * verdict. Simulations and pair gates are produced by the real pair module —
 * they are inputs here, not the code under test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BorosMarket, BorosOrderBook } from '../../src/core/boros/client';
import type { BorosLegFill, BorosOrderClient, BorosRollLeg } from '../../src/core/boros/orders';
import {
  DEFAULT_SLIPPAGE_APR,
  evaluatePairGate,
  pairEligibility,
  simulateBorosPair,
  type BorosPairAccountState,
  type BorosPairLegInput,
} from '../../src/core/boros/pair';
import {
  ROLL_MARGIN_HAIRCUT,
  evaluateRollGate,
  readRollFills,
  rollLegsFor,
  submitBorosRoll,
  type EvaluateRollInput,
  type RollStepInput,
} from '../../src/core/boros/rollover';
import { SECONDS_IN_YEAR } from '../../src/core/boros/venue';
import { imInputs } from '../helpers/boros-fixtures';

const NOW = 1_752_000_000;
const DAY = 86_400;
const OLD = NOW + 30 * DAY;
const NEW = NOW + 60 * DAY;
/** Years left on the OLD legs. */
const T = (30 * DAY) / SECONDS_IN_YEAR;
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

/** The account holds the old pair: SHORT Hyperliquid (receives 10%), LONG Binance (pays 4%). */
const exitLegs = () => ({
  legA: leg(hlOld, 'long', { currentSize: -SIZE, committedMargin: 1_000, positionApr: 0.1 }),
  legB: leg(bnOld, 'short', { currentSize: SIZE, committedMargin: 800, positionApr: 0.04 }),
});
const entryLegs = () => ({ legA: leg(hlNew, 'short'), legB: leg(bnNew, 'long') });

function rollInput(over: { exit?: RollStepInput; entry?: RollStepInput; account?: BorosPairAccountState } = {}): EvaluateRollInput {
  const x = exitLegs();
  const e = entryLegs();
  return {
    exit: over.exit ?? step(x.legA, x.legB, 'close'),
    entry: over.entry ?? step(e.legA, e.legB, 'open'),
    account: over.account ?? account,
    nowSec: NOW,
  };
}

describe('evaluateRollGate', () => {
  it('passes a clean roll and prices the post-exit margin', () => {
    const input = rollInput();
    const g = evaluateRollGate(input);
    expect(g.blockers).toEqual([]);
    expect(g.warnings).toEqual([]);

    // The re-entry opens from flat, so it adds its whole margin.
    const { legA, legB } = input.entry.simulation;
    expect(g.margin.need).toBeCloseTo(legA.marginRequired! + legB.marginRequired!, 9);
    // A full close frees every unit the old legs committed.
    expect(g.margin.freed).toBeCloseTo(1_800, 9);
    // At the bound: the short closes by buying at mid + tol = 9.25% against
    // its locked 10%, the long by selling at 4.25% against its 4%.
    expect(g.margin.worstExitPnl).toBeCloseTo((0.1 - 0.0925) * SIZE * T + (0.0425 - 0.04) * SIZE * T, 9);
    expect(g.margin.exitFee).toBeCloseTo(2 * 0.0005 * SIZE * T, 9);
    expect(g.margin.availableAfter).toBeCloseTo((5_000 + 1_800 + 1_000 * T - 100 * T) * ROLL_MARGIN_HAIRCUT, 9);
    expect(g.margin.shortfall).toBe(0);
  });

  it('keeps every exit blocker, drops the entry margin blockers, and prefixes both', () => {
    // A cross bucket with nothing spendable: the pair gate refuses the entry
    // for margin, but that verdict predates the exit freeing its margin.
    const broke = { ...account, cross: { available: 0, hasPositionOrOrders: true } };
    // …and the old legs posted next to nothing, so the exit frees little.
    const x = exitLegs();
    const input = rollInput({
      account: broke,
      exit: step({ ...x.legA, committedMargin: 50 }, { ...x.legB, committedMargin: 50 }, 'close'),
    });
    const e = entryLegs();
    input.entry = (() => {
      const simulation = simulateBorosPair({ ...e, size: SIZE, intent: 'open', collateralPriceUsd: 1, nowSec: NOW });
      const gate = evaluatePairGate({ simulation, ...e, account: broke, eligibility: pairEligibility(hlNew, bnNew, NOW), opposingAcknowledged: true, simulatedAtMs: NOW * 1000, nowMs: NOW * 1000 });
      return { simulation, gate, ...e };
    })();
    expect(input.entry.gate.blockers.map((b) => b.code)).toContain('cross-short-margin');
    const g = evaluateRollGate(input);
    expect(g.blockers.find((b) => b.code === 'cross-short-margin')).toBeUndefined();
    // …and the roll's own margin figure says how short it really is.
    expect(g.margin.shortfall).toBeGreaterThan(0);
    expect(g.warnings.some((w) => /refuses the whole roll/.test(w))).toBe(true);

    // An exit blocker survives with its step named.
    const stale = step(x.legA, x.legB, 'close');
    stale.gate = { ...stale.gate, blockers: [{ code: 'stale-simulation', message: 'old quote' }] };
    const g2 = evaluateRollGate(rollInput({ exit: stale }));
    expect(g2.blockers).toEqual([{ code: 'stale-simulation', message: 'Exit: old quote', step: 'exit', leg: undefined, marketId: undefined }]);
  });

  it('refuses a roll into the same or an earlier maturity', () => {
    const e = entryLegs();
    const sameMaturity = step({ ...e.legA, market: { ...hlNew, maturity: OLD } }, { ...e.legB, market: { ...bnNew, maturity: OLD } }, 'open');
    const g = evaluateRollGate(rollInput({ entry: sameMaturity }));
    expect(g.blockers.map((b) => b.code)).toContain('maturity-not-later');
  });

  it('refuses legs that do not share one collateral token', () => {
    const e = entryLegs();
    const btcMargined = step({ ...e.legA, market: { ...hlNew, tokenId: 1 } }, { ...e.legB, market: { ...bnNew, tokenId: 1 } }, 'open');
    const g = evaluateRollGate(rollInput({ entry: btcMargined }));
    expect(g.blockers.map((b) => b.code)).toContain('collateral-mismatch');
  });

  it('refuses a new leg that would not hold the side the old one holds', () => {
    // Re-entering LONG on Hyperliquid where the account is SHORT flips the hedge.
    const e = entryLegs();
    const flipped = step(leg(hlNew, 'long'), leg(bnNew, 'short'), 'open');
    void e;
    const g = evaluateRollGate(rollInput({ entry: flipped }));
    const codes = g.blockers.map((b) => b.code);
    expect(codes.filter((c) => c === 'sides-mismatch')).toHaveLength(2);
  });

  it('refuses when the exit was clamped to the position but the entry was not', () => {
    // Asked to roll 150k on a 100k position: the close clamps, the open would not.
    const x = exitLegs();
    const e = entryLegs();
    const g = evaluateRollGate(rollInput({ exit: step(x.legA, x.legB, 'close', 150_000), entry: step(e.legA, e.legB, 'open', 150_000) }));
    const mismatch = g.blockers.filter((b) => b.code === 'size-mismatch');
    expect(mismatch).toHaveLength(2);
    expect(mismatch[0].message).toMatch(/closes 100000 but .* would open 150000/);
  });

  it('refuses a leg the book cannot fill whole — FOK would revert the batch', () => {
    const e = entryLegs();
    const thin = step({ ...e.legA, book: book(hlNew, 40_000) }, e.legB, 'open');
    const g = evaluateRollGate(rollInput({ entry: thin }));
    const b = g.blockers.find((x) => x.code === 'partial-depth');
    expect(b).toMatchObject({ step: 'entry', leg: 'A', marketId: 156 });
    expect(b!.message).toMatch(/has 40000 of 100000 inside the rate bound/);
  });

  it('judges FOK depth per level, not by the VWAP the slippage gate uses', () => {
    // The new Hyperliquid leg SELLS 100k into bids 9.98% × 60k then 9.60% ×
    // 60k against a 10% mid with a 0.25% tolerance (bound 9.75%): the VWAP
    // over 100k is 9.828% — inside the tolerance, so `slippage-exceeds-max`
    // is silent — but the venue matches level by level down to the bound and
    // never touches the 9.60% level, so a FOK for 100k reverts. Only 60k sits
    // inside the bound.
    const e = entryLegs();
    const ladder: BorosOrderBook = { marketId: 156, bids: [[0.0998, 60_000], [0.096, 60_000]], asks: [[0.101, 20_000_000]] };
    const marginal = step({ ...e.legA, book: ladder }, e.legB, 'open');
    expect(marginal.simulation.legA.slippageExceeded).toBe(false);
    expect(marginal.simulation.legA.shortfallSize).toBe(0);
    const g = evaluateRollGate(rollInput({ entry: marginal }));
    const b = g.blockers.find((x) => x.code === 'partial-depth');
    expect(b).toMatchObject({ step: 'entry', leg: 'A' });
    expect(b!.message).toMatch(/has 60000 of 100000 inside the rate bound/);
  });

  it('refuses a new leg that is not the old leg one maturity later', () => {
    // Rolling the Hyperliquid leg into a Binance market keeps the sides and
    // the collateral but changes the hedge; a roll is the same shape later.
    const e = entryLegs();
    const swapped = step({ ...e.legA, market: { ...hlNew, venue: 'Binance' } }, e.legB, 'open');
    const g = evaluateRollGate(rollInput({ entry: swapped }));
    expect(g.blockers.filter((b) => b.code === 'market-mismatch').map((b) => b.leg)).toEqual(['A']);
  });

  it('judges an isolated-only new leg against its own bucket — the exit cannot feed it', () => {
    const e = entryLegs();
    const isolated = step({ ...e.legA, market: { ...hlNew, isolatedOnly: true }, isolatedOnly: true }, e.legB, 'open');
    const g = evaluateRollGate(rollInput({ entry: isolated }));
    // The cross figure now carries only leg B…
    expect(g.margin.need).toBeCloseTo(isolated.simulation.legB.marginRequired!, 9);
    // …and leg A's whole margin is short, because its isolated bucket is empty.
    expect(g.margin.shortfall).toBeCloseTo(isolated.simulation.legA.marginRequired!, 9);
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
    const g = evaluateRollGate({ exit: stepWith(x.legA, x.legB, 'close'), entry: stepWith(e.legA, e.legB, 'open'), account: low, nowSec: NOW });
    expect(g.warnings.filter((w) => /tops it up as it sends/.test(w))).toHaveLength(1);
  });

  it('reports the margin as unknown, not short, when an input is missing', () => {
    // No locked rate on the old legs: the exit PnL cannot be priced.
    const x = exitLegs();
    const noRate = step({ ...x.legA, positionApr: undefined }, { ...x.legB, positionApr: undefined }, 'close');
    const g = evaluateRollGate(rollInput({ exit: noRate }));
    expect(g.margin.worstExitPnl).toBeNull();
    expect(g.margin.availableAfter).toBeNull();
    expect(g.margin.shortfall).toBe(0);
    expect(g.warnings).toEqual([]);
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
