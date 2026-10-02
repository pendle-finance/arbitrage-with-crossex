/** Pure-function tests: fx arithmetic, projections, sizing, decide edges. */
import { describe, expect, it } from 'vitest';
import { fx, fxFloorToStep, fxStr } from '../../src/engine/fx';
import { clipBandPrice, decide, project, sizeFor } from '../../src/engine/decide';
import { TUNING, type OrderRow, type PairRow } from '../../src/engine/types';
import type { DecideCtx } from '../../src/engine/decide';
import { legSpec, A_CONTRACT, B_CONTRACT } from './engine-sim';

const ctx: DecideCtx = { touchA: '2500', refB: '2500', refA: '2500', maxClip: '1000000' };

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
