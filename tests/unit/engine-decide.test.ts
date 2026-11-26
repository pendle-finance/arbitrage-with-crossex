/** Pure-function tests: fx arithmetic, projections, sizing, decide edges. */
import { describe, expect, it } from 'vitest';
import { fx, fxFloorToStep, fxStr } from '../../src/engine/fx';
import { clipBandPrice, decide, project, sizeFor } from '../../src/engine/decide';
import { TUNING, type OrderRow, type PairRow } from '../../src/engine/types';
import type { DecideCtx } from '../../src/engine/decide';
import { legSpec, A_CONTRACT, B_CONTRACT } from './engine-sim';

const ctx: DecideCtx = { touchA: '2500', bestA: '2500', refB: '2500', refA: '2500', maxClip: '1000000' };

function pairRow(over?: Partial<PairRow>): PairRow {
  return {
    id: 'p1',
    mode: 'OPENING',
    a: legSpec(A_CONTRACT, 'BUY'),
    b: legSpec(B_CONTRACT, 'SELL'),
    targetQty: '0.152',
    limitPrice: '2500',
    pricePolicy: 'fixed',
    deadlineAt: null,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip: null,
    clipBandBp: null,
    repegBehindBp: null,
    repegAutoBp: null,
    repegNotBefore: 0,
    haltKind: null,
    haltReason: null,
    reportJson: null,
    createdAt: 0,
    ...over,
  };
}

function order(over: Partial<OrderRow>): OrderRow {
  return {
    pairId: 'p1',
    leg: 'A',
    seq: 1,
    clientId: 't-p1.A1',
    kind: 'maker',
    side: 'BUY',
    qty: '0.152',
    price: '2500',
    tif: 'poc',
    state: 'OPEN',
    venueOrderId: 'V1',
    cumQty: '0',
    avgFillPrice: '0',
    closeReason: null,
    cancelRequested: 0,
    quarantinedStatus: null,
    venueReason: null,
    readFailStreak: 0,
    createdAt: 0,
    resolvedAt: null,
    ...over,
  };
}

/** A leg-B hedge row (taker IOC), so freeze cases can be exercised without a maker. */
function hedgeOrder(over?: Partial<OrderRow>): OrderRow {
  return order({
    leg: 'B',
    seq: 2,
    clientId: 't-p1.B2',
    kind: 'taker',
    side: 'SELL',
    price: null,
    tif: 'ioc',
    ...over,
  });
}

describe('fx', () => {
  it('parses, formats, floors exactly', () => {
    expect(fxStr(fx('0.152'))).toBe('0.152');
    expect(fxStr(fx('0'))).toBe('0');
    expect(fxStr(fxFloorToStep(fx('0.152'), fx('0.1')))).toBe('0.1');
    expect(fxStr(fxFloorToStep(fx('0.152'), fx('0.001')))).toBe('0.152');
    expect(fxStr(fx('0.05') + fx('0.102'))).toBe('0.152'); // no float drift, ever
    expect(() => fx('1e-3')).toThrow();
  });
});

describe('project (reservation accounting)', () => {
  it('reserves full qty for PENDING/OPEN, cum for CLOSED, zero for DEAD', () => {
    const pair = pairRow();
    const p = project(pair, [
      order({ seq: 1, state: 'CLOSED', cumQty: '0.05', qty: '0.152' }),
      order({ seq: 2, state: 'OPEN', qty: '0.102', cumQty: '0.01' }),
      order({ leg: 'B', kind: 'taker', seq: 1, clientId: 't-p1.B1', state: 'PENDING', qty: '0.05', cumQty: '0' }),
      order({ leg: 'B', kind: 'taker', seq: 2, clientId: 't-p1.B2', state: 'DEAD', qty: '0.01', cumQty: '0' }),
    ]);
    expect(p.aFilled).toBe('0.06'); // 0.05 + 0.01
    expect(p.aReserved).toBe('0.152'); // 0.05 (closed cum) + 0.102 (open qty)
    expect(p.bReserved).toBe('0.05'); // pending counts FULL; dead counts 0
    expect(p.unhedged).toBe('0.01'); // 0.06 − 0.05
    expect(p.residualA).toBe('0'); // target fully reserved
    expect(p.anyPending).toBe(true);
  });
});

describe('clipBandPrice (Hyperliquid 5-sig-fig cap)', () => {
  const hl = (side: 'BUY' | 'SELL'): Parameters<typeof clipBandPrice>[1] =>
    legSpec('HYPERLIQUID_FUTURE_BTC_USDC', side, { tick: '0.1' });
  const gate = (side: 'BUY' | 'SELL'): Parameters<typeof clipBandPrice>[1] =>
    legSpec('GATE_FUTURE_BTC_USDT', side, { tick: '0.1' });

  const sigFigs = (s: string): number => s.replace(/[.-]/g, '').replace(/^0+/, '').length;

  it('caps an HL banded price to ≤5 significant figures (the live 422 case)', () => {
    // ref 65964, BUY band 10bp → ~65970.7 → HL rejects 6 sig figs. Must cap.
    const px = clipBandPrice('65964', hl('BUY'), 10);
    expect(sigFigs(px)).toBeLessThanOrEqual(5);
    // Band-preserving direction kept: a BUY limit never exceeds ref·(1+band).
    expect(Number(px)).toBeLessThanOrEqual(65964 * 1.001 + 1e-6);
  });

  it('caps an HL SELL band without ever pricing below ref·(1−band)', () => {
    const px = clipBandPrice('65964', hl('SELL'), 10);
    expect(sigFigs(px)).toBeLessThanOrEqual(5);
    expect(Number(px)).toBeGreaterThanOrEqual(65964 * 0.999 - 1e-6);
  });

  it('leaves non-HL venues at full tick precision (no sig-fig cap)', () => {
    const px = clipBandPrice('65964', gate('BUY'), 10);
    expect(sigFigs(px)).toBeGreaterThan(5); // 66029.9 — Gate allows it
  });
});

describe('sizeFor', () => {
  it('floors to lot, zeroes below minSize/minNotional, never rounds up', () => {
    expect(fxStr(sizeFor(fx('0.152'), legSpec(B_CONTRACT, 'SELL', { lot: '0.1' }), null)!)).toBe('0.1');
    expect(fxStr(sizeFor(fx('0.05'), legSpec(B_CONTRACT, 'SELL', { minSize: '0.1' }), null)!)).toBe('0');
    // minNotional 200 at price 2500: 0.05*2500=125 < 200 → 0
    expect(
      fxStr(sizeFor(fx('0.05'), legSpec(B_CONTRACT, 'SELL', { minNotional: '200' }), '2500')!),
    ).toBe('0');
    // minNotional needs a price: null ref → null ("cannot size safely")
    expect(sizeFor(fx('0.05'), legSpec(B_CONTRACT, 'SELL', { minNotional: '200' }), null)).toBeNull();
  });
});

describe('decide edges', () => {
  it('freezes on any PENDING order', () => {
    const pair = pairRow();
    const p = project(pair, [order({ state: 'PENDING', venueOrderId: null })]);
    expect(decide(pair, p, 0, ctx)).toEqual({ type: 'idle', reason: 'frozen: order in doubt' });
  });

  it('freezes on any quarantined order', () => {
    const pair = pairRow();
    // A quarantined HEDGE with no maker resting: nothing is acquiring, so the
    // freeze is the whole answer. (A quarantined order alongside a RESTING maker
    // is a different case — see the cancel test below.)
    const p = project(pair, [hedgeOrder({ quarantinedStatus: 'WEIRD' })]);
    expect(decide(pair, p, 0, ctx).type).toBe('idle');
  });

  // The freeze blocks PLACEMENT, which stops the hedge — but a maker already
  // resting on the venue keeps filling, so exposure grows with nothing
  // neutralizing it. And because no hedge order is ever submitted,
  // bumpHedgeWall never fires, hedgeRejectStreak stays 0, and HALTED is
  // unreachable: the deal quietly goes fully directional at target size.
  it.each([
    ['in doubt', { state: 'PENDING' as const, venueOrderId: null }],
    ['quarantined', { quarantinedStatus: 'WEIRD' }],
  ])('cancels a resting maker while the hedge is %s', (_label, over) => {
    const pair = pairRow();
    const maker = order({ state: 'OPEN' });
    const p = project(pair, [maker, hedgeOrder(over)]);
    expect(decide(pair, p, 0, ctx)).toEqual({ type: 'cancel', order: maker });
  });

  it('does not cancel a maker that is merely still in doubt itself', () => {
    // A freshly-placed maker is PENDING for its own resolution window; cancelling
    // on that would kill every maker the instant it was submitted.
    const pair = pairRow();
    const p = project(pair, [order({ state: 'PENDING', venueOrderId: null })]);
    expect(decide(pair, p, 0, ctx)).toEqual({ type: 'idle', reason: 'frozen: order in doubt' });
  });

  it('hedge outranks everything, in every live mode', () => {
    for (const mode of ['OPENING', 'CONVERTING', 'STOPPING'] as const) {
      const pair = pairRow({ mode });
      const p = project(pair, [order({ state: 'CLOSED', cumQty: '0.05', closeReason: 'filled' })]);
      const a = decide(pair, p, 0, ctx);
      expect(a).toMatchObject({ type: 'place', leg: 'B', tif: 'ioc', qty: '0.05' });
    }
  });

  it('never places the maker blind (no price → idle)', () => {
    const pair = pairRow({ pricePolicy: 'touch', limitPrice: null });
    const p = project(pair, []);
    expect(decide(pair, p, 0, { ...ctx, touchA: null }).type).toBe('idle');
  });

  it('deadline is a level: fires even when it passed long ago (e.g. during downtime)', () => {
    const pair = pairRow({ deadlineAt: 1_000 });
    const p = project(pair, [order({ state: 'OPEN' })]);
    expect(decide(pair, p, 999_999_999, ctx)).toMatchObject({ type: 'setMode', mode: 'CONVERTING' });
  });

  it('exhausted POC budget: stops with the cause in haltReason, never a bare "stopped"', () => {
    const pair = pairRow({ pocRejects: TUNING.MAX_POC_REJECTS });
    const a = decide(pair, project(pair, []), 0, ctx);
    expect(a).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
    // haltReason is what STOPPING's finishIfSettled writes into the report.
    expect((a as { haltReason?: string }).haltReason).toMatch(/crossing the market/);
  });

  it('a venue cancel that is NOT ours is a STOP; our own cancel is not', () => {
    const pair = pairRow();
    const stop = decide(
      pair,
      project(pair, [order({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 0 })]),
      0,
      ctx,
    );
    expect(stop).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
    const ours = decide(
      pair,
      project(pair, [order({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 })]),
      0,
      ctx,
    );
    expect(ours.type).not.toBe('setMode'); // converges (re-places) instead
  });

  it('a stopped deal names its unfilled rest as stopped, a halted one as blocked', () => {
    const settled = [
      order({ state: 'CLOSED', cumQty: '0.05', closeReason: 'cancelled', cancelRequested: 1 }),
      hedgeOrder({ state: 'CLOSED', qty: '0.05', cumQty: '0.05', closeReason: 'filled' }),
    ];
    const stopped = pairRow({ mode: 'STOPPING' });
    expect(decide(stopped, project(stopped, settled), 0, ctx)).toMatchObject({
      type: 'finish',
      report: { reason: 'stopped (unacquired residual 0.102 — not filled before the stop)' },
    });
    const halted = pairRow({ mode: 'STOPPING', haltReason: 'hedge failed 3x' });
    expect(decide(halted, project(halted, settled), 0, ctx)).toMatchObject({
      type: 'finish',
      report: { reason: 'hedge failed 3x (unacquired residual 0.102 — below the venue minimum or blocked)' },
    });
  });

  it('a poc insta-cancel is NOT a STOP', () => {
    const pair = pairRow();
    const a = decide(
      pair,
      project(pair, [order({ state: 'CLOSED', closeReason: 'poc-reject', cancelRequested: 0 })]),
      0,
      ctx,
    );
    expect(a.type).toBe('place'); // requotes
  });

  it('re-peg: live maker at a stale price gets canceled', () => {
    const pair = pairRow({ limitPrice: '2499' });
    const p = project(pair, [order({ state: 'OPEN', price: '2500' })]);
    expect(decide(pair, p, 0, ctx)).toMatchObject({ type: 'cancel' });
  });

  it('convert waits for the hedge before clipping (hedge-first gating)', () => {
    const pair = pairRow({ mode: 'CONVERTING', hedgeNotBefore: 99_999 }); // hedge in backoff
    const p = project(pair, [order({ state: 'CLOSED', cumQty: '0.05', closeReason: 'filled' })]);
    const a = decide(pair, p, 0, ctx);
    expect(a.type).toBe('idle'); // owes a hedge; must not widen the gap with a clip
  });
});

describe('OPENING pauses acquisition while a failed hedge waits out its backoff', () => {
  const backoff = { hedgeNotBefore: 5_000, hedgeRejectStreak: 1 };
  const partlyFilled = (over?: Partial<OrderRow>): OrderRow => order({ state: 'OPEN', cumQty: '0.05', ...over });
  const cancelled = (): OrderRow => partlyFilled({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 });

  it('cancels the resting maker', () => {
    const pair = pairRow(backoff);
    const maker = partlyFilled();
    expect(decide(pair, project(pair, [maker]), 0, ctx)).toEqual({ type: 'cancel', order: maker });
  });

  it('re-sends the cancel while an unconfirmed one leaves the maker OPEN', () => {
    const pair = pairRow(backoff);
    const maker = partlyFilled({ cancelRequested: 1 });
    expect(decide(pair, project(pair, [maker]), 0, ctx)).toEqual({ type: 'cancel', order: maker });
  });

  it('places no new maker once the old one is closed', () => {
    const pair = pairRow(backoff);
    expect(decide(pair, project(pair, [cancelled()]), 0, ctx)).toEqual({
      type: 'idle',
      reason: 'acquisition paused: hedge failed, waiting out its backoff',
    });
  });

  it('sends the hedge first once the backoff is over', () => {
    const pair = pairRow(backoff);
    expect(decide(pair, project(pair, [cancelled()]), 5_000, ctx)).toEqual({
      type: 'place',
      leg: 'B',
      kind: 'taker',
      tif: 'ioc',
      qty: '0.05',
    });
  });
});

describe('maker + hedge close (both legs reduce-only)', () => {
  // Closing a long on A (SELL rests) and a short on B (BUY hedges).
  const closePair = (over?: Partial<PairRow>): PairRow =>
    pairRow({
      a: legSpec(A_CONTRACT, 'SELL', { reduceOnly: true }),
      b: legSpec(B_CONTRACT, 'BUY', { reduceOnly: true }),
      pricePolicy: 'touch',
      limitPrice: '2501',
      clipBandBp: 50,
      deadlineAt: 300_000,
      ...over,
    });
  const restingSell = (over?: Partial<OrderRow>): OrderRow =>
    order({ side: 'SELL', price: '2501', createdAt: 0, ...over });

  it('a venue cancel of the resting close converts the rest at market, with an alert', () => {
    const p = closePair();
    const proj = project(p, [restingSell({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 0 })]);
    const a = decide(p, proj, 1_000, ctx);
    expect(a).toMatchObject({ type: 'setMode', mode: 'CONVERTING', resetClipBudget: true });
    expect(a.type === 'setMode' && a.alert).toMatch(/cancelled on the venue/);
  });

  it('an exhausted POC budget converts a close instead of stopping it', () => {
    const p = closePair({ pocRejects: TUNING.MAX_POC_REJECTS });
    const a = decide(p, project(p, []), 1_000, ctx);
    expect(a).toMatchObject({ type: 'setMode', mode: 'CONVERTING', resetClipBudget: true });
  });

  it('opens keep the old rules: venue cancel stops, POC exhaustion stops', () => {
    const open = pairRow();
    const cancelled = project(open, [order({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 0 })]);
    expect(decide(open, cancelled, 1_000, ctx)).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
    const spent = pairRow({ pocRejects: TUNING.MAX_POC_REJECTS });
    expect(decide(spent, project(spent, []), 1_000, ctx)).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
  });

  it('closes use the distance rule', () => {
    const p = closePair({ repegBehindBp: 5, limitPrice: '2500.5' });
    const proj = project(p, [restingSell({ price: '2500.5' })]);
    expect(decide(p, proj, 6_000, { ...ctx, bestA: '2500' })).toEqual({ type: 'idle', reason: 'maker resting' });
    expect(decide(p, proj, 6_000, { ...ctx, bestA: '2499' })).toEqual({ type: 'cancel', order: proj.makerOrder });
    expect(decide(p, proj, 6_000, { ...ctx, bestA: '2502' })).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('never: a venue cancel of the resting close stops instead of going to market', () => {
    const p = closePair({ deadlineAt: null });
    const proj = project(p, [restingSell({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 0 })]);
    expect(decide(p, proj, 1_000, ctx)).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
  });

  it('never: an exhausted POC budget stops instead of going to market', () => {
    const p = closePair({ deadlineAt: null, pocRejects: TUNING.MAX_POC_REJECTS });
    expect(decide(p, project(p, []), 1_000, ctx)).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
  });

  it('caps each hedge order at maxClip', () => {
    const p = closePair({ targetQty: '10' });
    const proj = project(p, [restingSell({ qty: '10', cumQty: '4' })]);
    expect(decide(p, proj, 1_000, { ...ctx, maxClip: '1.5' })).toMatchObject({
      type: 'place',
      leg: 'B',
      qty: '1.5',
    });
  });

  it('a maxClip below the hedge minimum falls back to the full hedge', () => {
    const p = closePair({ targetQty: '10', b: legSpec(B_CONTRACT, 'BUY', { reduceOnly: true, minSize: '2' }) });
    const proj = project(p, [restingSell({ qty: '10', cumQty: '4' })]);
    expect(decide(p, proj, 1_000, { ...ctx, maxClip: '1.5' })).toMatchObject({ type: 'place', leg: 'B', qty: '4' });
  });

  const refusedHedges = (n: number, label: string): OrderRow[] =>
    Array.from({ length: n }, (_, i) =>
      hedgeOrder({ seq: i + 1, clientId: `t-p1.B${i + 1}`, side: 'BUY', state: 'DEAD', closeReason: `rejected:${label}` }),
    );

  it('a stopping close gives up on a hedge leg that keeps refusing, and says so', () => {
    const p = closePair({ mode: 'STOPPING', hedgeRejectStreak: TUNING.STOP_HEDGE_GIVE_UP });
    const proj = project(p, [
      restingSell({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1, cumQty: '0.152' }),
      ...refusedHedges(TUNING.STOP_HEDGE_GIVE_UP, 'REDUCE_ONLY_ORDER_REJECTED'),
    ]);
    const a = decide(p, proj, 1_000, ctx);
    expect(a.type).toBe('finish');
    if (a.type !== 'finish') return;
    expect(a.report.unhedged).toBe('0.152');
    expect(a.report.reason).toMatch(/hedge leg refused/);
    expect(a.alert).toMatch(/may already be closed/);
  });

  it('below the give-up limit a stopping close still retries the hedge', () => {
    const p = closePair({ mode: 'STOPPING', hedgeRejectStreak: TUNING.STOP_HEDGE_GIVE_UP - 1 });
    const proj = project(p, [restingSell({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1, cumQty: '0.152' })]);
    expect(decide(p, proj, 1_000, ctx)).toMatchObject({ type: 'place', leg: 'B', qty: '0.152' });
  });

  it('hedge failures that are not reduce-only refusals never make a stopping close give up', () => {
    const p = closePair({ mode: 'STOPPING', hedgeRejectStreak: 50 });
    const proj = project(p, [
      restingSell({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1, cumQty: '0.152' }),
      ...refusedHedges(TUNING.STOP_HEDGE_GIVE_UP - 1, 'REDUCE_ONLY_ORDER_REJECTED'),
      hedgeOrder({ seq: 20, clientId: 't-p1.B20', side: 'BUY', state: 'DEAD', closeReason: 'rejected:TRADE_HYPERLIQUID_ORDER_LIMIT_ERROR' }),
      hedgeOrder({ seq: 21, clientId: 't-p1.B21', side: 'BUY', state: 'CLOSED', closeReason: 'cancelled' }),
    ]);
    expect(decide(p, proj, 1_000, ctx)).toMatchObject({ type: 'place', leg: 'B', qty: '0.152' });
  });

  it('an open deal never gives up on its hedge while stopping', () => {
    const p = pairRow({ mode: 'STOPPING', hedgeRejectStreak: 50 });
    const proj = project(p, [order({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1, cumQty: '0.152' })]);
    expect(decide(p, proj, 1_000, ctx)).toMatchObject({ type: 'place', leg: 'B' });
  });
});

describe('TWAP engine rules', () => {
  const repegPair = (over?: Partial<PairRow>): PairRow =>
    pairRow({ pricePolicy: 'touch', limitPrice: '1729.2', repegBehindBp: 5, ...over });
  const resting = (over?: Partial<OrderRow>): OrderRow => order({ price: '1729.2', createdAt: 0, ...over });
  const cancelledMaker = (over?: Partial<OrderRow>): OrderRow =>
    resting({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1, ...over });

  it('child deadline sends rest at market', () => {
    const filled = '36.403';
    const hedge = hedgeOrder({ state: 'CLOSED', qty: filled, cumQty: filled, closeReason: 'filled' });
    const opening = pairRow({ targetQty: '57.803', limitPrice: '1729.2', deadlineAt: 240_000 });
    const live = resting({ qty: '57.803', cumQty: filled });
    expect(decide(opening, project(opening, [live, hedge]), 240_000, ctx)).toMatchObject({
      type: 'setMode',
      mode: 'CONVERTING',
    });
    const converting = { ...opening, mode: 'CONVERTING' as const };
    expect(decide(converting, project(converting, [live, hedge]), 240_000, ctx)).toEqual({
      type: 'cancel',
      order: live,
    });
    const rest = cancelledMaker({ qty: '57.803', cumQty: filled });
    expect(decide(converting, project(converting, [rest, hedge]), 240_500, ctx)).toEqual({
      type: 'place',
      leg: 'A',
      kind: 'taker',
      tif: 'ioc',
      qty: '21.4',
    });
  });

  it('never has no deadline', () => {
    const p = pairRow({ deadlineAt: null });
    expect(decide(p, project(p, [order({})]), 7_200_000, ctx)).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('re-peg by distance on opens', () => {
    const p = repegPair();
    const proj = project(p, [resting()]);
    const book = { ...ctx, bestA: '1730.15' };
    expect(decide(p, proj, 10_000, book)).toEqual({ type: 'cancel', order: proj.makerOrder });
    expect(decide(p, project(p, [cancelledMaker()]), 10_200, book)).toEqual({
      type: 'place',
      leg: 'A',
      kind: 'maker',
      tif: 'poc',
      qty: '0.152',
      price: '1730.15',
    });
  });

  it('re-peg by distance on a SELL maker', () => {
    const p = repegPair({ a: legSpec(A_CONTRACT, 'SELL'), b: legSpec(B_CONTRACT, 'BUY'), limitPrice: '1730.15' });
    const proj = project(p, [resting({ side: 'SELL', price: '1730.15' })]);
    expect(decide(p, proj, 10_000, { ...ctx, bestA: '1729.2' })).toEqual({ type: 'cancel', order: proj.makerOrder });
    expect(decide(p, proj, 10_000, { ...ctx, bestA: '1729.6' })).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('re-peg holds under the distance', () => {
    const p = repegPair({ limitPrice: '1729.4' });
    const proj = project(p, [resting({ price: '1729.4' })]);
    expect(decide(p, proj, 10_000, { ...ctx, bestA: '1730.15' })).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('re-peg waits 5 s between moves', () => {
    const p = repegPair();
    const proj = project(p, [resting({ createdAt: 10_000 })]);
    const book = { ...ctx, bestA: '1730.25' };
    expect(decide(p, proj, 13_000, book)).toEqual({ type: 'idle', reason: 'maker resting' });
    expect(decide(p, proj, 10_000 + TUNING.REPEG_MIN_GAP_MS - 1, book)).toEqual({ type: 'idle', reason: 'maker resting' });
    expect(decide(p, proj, 10_000 + TUNING.REPEG_MIN_GAP_MS, book)).toEqual({ type: 'cancel', order: proj.makerOrder });
  });

  it('re-peg off never moves', () => {
    const p = repegPair({ repegBehindBp: null });
    const proj = project(p, [resting()]);
    expect(decide(p, proj, 600_000, { ...ctx, bestA: '1737.85' })).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('re-peg off places at the peg one gap behind, as today', () => {
    const p = repegPair({ repegBehindBp: null });
    const book = { ...ctx, touchA: '1730.14', bestA: '1730.15' };
    expect(decide(p, project(p, []), 0, book)).toMatchObject({ type: 'place', kind: 'maker', price: '1730.14' });
    const on = repegPair();
    expect(decide(on, project(on, []), 0, book)).toMatchObject({ type: 'place', kind: 'maker', price: '1730.15' });
  });

  it('a typed price never re-pegs', () => {
    const p = repegPair({ pricePolicy: 'fixed' });
    const proj = project(p, [resting()]);
    expect(decide(p, proj, 600_000, { ...ctx, bestA: '1737.85' })).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('refused re-peg waits a minute', () => {
    const refusedAt = 20_000;
    const p = repegPair({ repegNotBefore: refusedAt + TUNING.REPEG_REFUSED_WAIT_MS });
    const refused = resting({
      seq: 2,
      clientId: 't-p1.A2',
      price: '1730.15',
      state: 'DEAD',
      venueOrderId: null,
      closeReason: 'rejected:TRADE_HYPERLIQUID_ORDER_LIMIT_ERROR',
      createdAt: refusedAt,
    });
    const book = { ...ctx, bestA: '1731' };
    const replace = decide(p, project(p, [cancelledMaker(), refused]), refusedAt + 2_000, book);
    expect(replace).toEqual({ type: 'place', leg: 'A', kind: 'maker', tif: 'poc', qty: '0.152', price: '1729.2' });
    const again = resting({ seq: 3, clientId: 't-p1.A3', createdAt: refusedAt + 2_000 });
    const proj = project(p, [cancelledMaker(), refused, again]);
    expect(decide(p, proj, refusedAt + TUNING.REPEG_REFUSED_WAIT_MS - 1, book)).toEqual({
      type: 'idle',
      reason: 'maker resting',
    });
    expect(decide(p, proj, refusedAt + TUNING.REPEG_REFUSED_WAIT_MS, book)).toEqual({ type: 'cancel', order: again });
  });

  describe('same-contract reopen cancels the rest first', () => {
    const gateEth = 'GATE_FUTURE_ETH_USDT';
    const realize = pairRow({
      a: legSpec(gateEth, 'SELL', { reduceOnly: true }),
      b: legSpec(gateEth, 'BUY'),
      targetQty: '4.2',
      pricePolicy: 'touch',
      limitPrice: '1730.15',
      repegBehindBp: 5,
    });
    const restingClose = (over?: Partial<OrderRow>): OrderRow =>
      order({ side: 'SELL', qty: '4.2', cumQty: '1', price: '1730.15', ...over });

    it('cancels the resting close before the reopen', () => {
      const close = restingClose();
      expect(decide(realize, project(realize, [close]), 1_000, ctx)).toEqual({ type: 'cancel', order: close });
    });

    it('re-sends the cancel while the close still reads open', () => {
      const close = restingClose({ cancelRequested: 1 });
      expect(decide(realize, project(realize, [close]), 1_000, ctx)).toEqual({ type: 'cancel', order: close });
    });

    it('sends the reopen once the close is cancelled', () => {
      const close = restingClose({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 });
      expect(decide(realize, project(realize, [close]), 1_000, ctx)).toEqual({
        type: 'place',
        leg: 'B',
        kind: 'taker',
        tif: 'ioc',
        qty: '1',
      });
    });
  });

  describe('hedge refused for margin has its own halt kind', () => {
    const filledMaker = (): OrderRow => order({ qty: '57.803', cumQty: '4.2' });
    const refusedHedge = (closeReason: string): OrderRow =>
      hedgeOrder({ state: 'DEAD', qty: '4.2', cumQty: '0', venueOrderId: null, closeReason });
    const afterRefusal = (over?: Partial<PairRow>): PairRow =>
      pairRow({ targetQty: '57.803', hedgeRejectStreak: TUNING.HEDGE_REJECT_HALT, hedgeNotBefore: 4_000, ...over });

    it('halts with haltKind hedge-margin', () => {
      const p = afterRefusal();
      const a = decide(p, project(p, [filledMaker(), refusedHedge('rejected:INSUFFICIENT_MARGIN')]), 1_000, ctx);
      expect(a).toMatchObject({ type: 'setMode', mode: 'HALTED', haltKind: 'hedge-margin' });
    });

    it('reads a refusal the venue gave after it took the order', () => {
      const p = afterRefusal();
      const late = hedgeOrder({ state: 'CLOSED', qty: '4.2', cumQty: '0', closeReason: 'FAIL', venueReason: 'INSUFFICIENT_MARGIN' });
      expect(decide(p, project(p, [filledMaker(), late]), 1_000, ctx)).toMatchObject({ haltKind: 'hedge-margin' });
    });

    it('a wall for another reason halts with no kind', () => {
      const p = afterRefusal();
      const a = decide(p, project(p, [filledMaker(), refusedHedge('rejected:TRADE_ORDER_QUANTITY_MIN_ERROR')]), 1_000, ctx);
      expect(a).toMatchObject({ type: 'setMode', mode: 'HALTED' });
      expect(a.type === 'setMode' && a.haltKind).toBeFalsy();
    });

    it('a margin refusal under the wall limit retries the hedge first', () => {
      const p = afterRefusal({ hedgeRejectStreak: 1 });
      const a = decide(p, project(p, [filledMaker(), refusedHedge('rejected:INSUFFICIENT_MARGIN')]), 4_000, ctx);
      expect(a).toEqual({ type: 'place', leg: 'B', kind: 'taker', tif: 'ioc', qty: '4.2' });
    });

    it('a stopping deal keeps stopping', () => {
      const p = afterRefusal({ mode: 'STOPPING' });
      const a = decide(p, project(p, [filledMaker(), refusedHedge('rejected:INSUFFICIENT_MARGIN')]), 1_000, ctx);
      expect(a).toEqual({ type: 'cancel', order: expect.objectContaining({ leg: 'A' }) });
    });
  });
});

describe('TWAP money sizes across the scale ladder', () => {
  const rungs = ['0.017', '1.667', '33.334', '333.334', '2000'];
  const lot = fx('0.001');
  const share = (qty: string, tenths: bigint): string => fxStr(fxFloorToStep((fx(qty) * tenths) / 10n, lot));
  const plain = /^\d+(\.\d+)?$/;
  const touchPair = (qty: string, over?: Partial<PairRow>): PairRow =>
    pairRow({ pricePolicy: 'touch', targetQty: qty, limitPrice: '2500', repegBehindBp: 5, ...over });
  const resting = (qty: string, cum: string, over?: Partial<OrderRow>): OrderRow =>
    order({ qty, cumQty: cum, price: '2500', createdAt: 0, ...over });
  const hedged = (filled: string): OrderRow =>
    hedgeOrder({ state: 'CLOSED', qty: filled, cumQty: filled, closeReason: 'filled' });

  it.each(rungs)('child deadline at %s sends the unfilled rest as a plain decimal string', (qty) => {
    const filled = share(qty, 4n);
    const rest = fxStr(fx(qty) - fx(filled));
    const opening = pairRow({ targetQty: qty, deadlineAt: 240_000 });
    const live = resting(qty, filled);
    expect(decide(opening, project(opening, [live, hedged(filled)]), 240_000, ctx)).toMatchObject({
      type: 'setMode',
      mode: 'CONVERTING',
    });
    const converting = { ...opening, mode: 'CONVERTING' as const };
    const cancelled = resting(qty, filled, { state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 });
    const action = decide(converting, project(converting, [cancelled, hedged(filled)]), 240_500, ctx);
    expect(action).toEqual({ type: 'place', leg: 'A', kind: 'taker', tif: 'ioc', qty: rest });
    if (action.type !== 'place') throw new Error('expected a place action');
    expect(action.qty).toMatch(plain);
    expect(action.qty).not.toMatch(/e/i);
  });

  it.each(rungs)('never at %s keeps resting and re-pegs for 24 h, with no market step', (qty) => {
    const p = touchPair(qty, { deadlineAt: null });
    const live = resting(qty, '0');
    const hour = 3_600_000;
    for (let h = 1; h <= 24; h++) {
      const action = decide(p, project(p, [live]), h * hour, ctx);
      expect(action).toEqual({ type: 'idle', reason: 'maker resting' });
    }
    const book = { ...ctx, bestA: '2501.5' };
    const moved = decide(p, project(p, [live]), 24 * hour, book);
    expect(moved).toEqual({ type: 'cancel', order: live });
    const cancelled = resting(qty, '0', { state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 });
    const again = decide(p, project(p, [cancelled]), 24 * hour + 200, book);
    expect(again).toEqual({ type: 'place', leg: 'A', kind: 'maker', tif: 'poc', qty, price: '2501.5' });
  });

  it.each(rungs)('never at %s with a part fill keeps hedging the filled part', (qty) => {
    const filled = share(qty, 3n);
    const p = touchPair(qty, { deadlineAt: null });
    const live = resting(qty, filled);
    const hedge = decide(p, project(p, [live]), 24 * 3_600_000, ctx);
    expect(hedge).toEqual({ type: 'place', leg: 'B', kind: 'taker', tif: 'ioc', qty: filled });
    expect(decide(p, project(p, [live, hedged(filled)]), 24 * 3_600_000 + 1_000, ctx)).toEqual({
      type: 'idle',
      reason: 'maker resting',
    });
  });

  describe.each([
    ['ETH', '3000.1', '3003.1'],
    ['BTC', '90000.5', '90090.5'],
  ])('re-peg of a %s maker', (_coin, startPrice, newPrice) => {
    it.each(rungs)('at %s builds the new price and qty as strings', (qty) => {
      const filled = share(qty, 4n);
      const rest = fxStr(fx(qty) - fx(filled));
      const a = legSpec(A_CONTRACT, 'BUY', { tick: '0.1' });
      const p = touchPair(qty, { a, limitPrice: startPrice, deadlineAt: null });
      const live = resting(qty, filled, { price: startPrice, createdAt: 10_000 });
      const proj = project(p, [live, hedged(filled)]);
      const book = { ...ctx, bestA: newPrice, refB: startPrice };
      const gap = TUNING.REPEG_MIN_GAP_MS;
      expect(decide(p, proj, 10_000 + gap - 1, book)).toEqual({ type: 'idle', reason: 'maker resting' });
      expect(decide(p, proj, 10_000 + gap, book)).toEqual({ type: 'cancel', order: live });
      const cancelled = resting(qty, filled, {
        price: startPrice,
        state: 'CLOSED',
        closeReason: 'cancelled',
        cancelRequested: 1,
      });
      const action = decide(p, project(p, [cancelled, hedged(filled)]), 10_000 + gap + 200, book);
      expect(action).toEqual({ type: 'place', leg: 'A', kind: 'maker', tif: 'poc', qty: rest, price: newPrice });
      if (action.type !== 'place' || action.price === undefined) throw new Error('expected a priced place action');
      expect(action.qty).toMatch(plain);
      expect(action.price).toMatch(plain);
      expect(fx(action.price) % fx('0.1')).toBe(0n);
      expect(action.qty).not.toMatch(/e/i);
    });
  });
});
