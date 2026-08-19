import { describe, expect, it } from 'vitest';
import { makeSharePayload } from '../test/fixtures';
import { applyExitMode, derivePositionView } from './derive';

const payload = makeSharePayload();

describe('derivePositionView', () => {
  it('recognizes the canonical 4-leg shape and pairs legs by venue, SHORT column first', () => {
    const v = derivePositionView(payload, payload.t);
    expect(v.isCanonicalFourLegs).toBe(true);
    expect(v.columns.map((c) => c.venue)).toEqual(['HYPERLIQUID', 'BYBIT']);
    expect(v.columns[0].boros?.s).toBe('S');
    expect(v.columns[0].perp?.s).toBe('S');
    expect(v.receiveApr).toBe(0.0936);
    expect(v.payApr).toBe(0.0229);
  });

  it('falls back for non-canonical books', () => {
    const v = derivePositionView(makeSharePayload({ l: payload.l.slice(0, 3) }), payload.t);
    expect(v.isCanonicalFourLegs).toBe(false);
    expect(v.columns).toHaveLength(2);
  });

  it('flips matured exactly when the viewer clock passes maturity', () => {
    expect(derivePositionView(payload, payload.m).matured).toBe(false);
    expect(derivePositionView(payload, payload.m + 1).matured).toBe(true);
  });

  it('reports the days left at share time', () => {
    expect(derivePositionView(payload, payload.t).daysLeftAtShare).toBe(12);
  });

  it('labels all four cost-assumption combinations exactly', () => {
    const label = (ce: 0 | 1, cx: 0 | 1) =>
      derivePositionView(makeSharePayload({ ce, cx }), payload.t).costAssumptionLabel;
    expect(label(1, 1)).toBe(
      'Numbers are net of the perp entry costs and the estimated exit costs.',
    );
    expect(label(1, 0)).toBe(
      'Numbers include the perp entry costs; exit costs are omitted (the perps roll over).',
    );
    expect(label(0, 1)).toBe(
      'Numbers include the estimated exit costs; entry costs are omitted (the perps were rolled in).',
    );
    expect(label(0, 0)).toBe(
      'Entry and exit perp costs are omitted (the perps roll through this maturity).',
    );
  });

  it('applies the viewer exit mode: rolls hand exit costs back, closes charge them', () => {
    // Sharer closed (cx=1): rolling hands 80 + 49.16 back, cx flips, APR
    // scales on the same capital/clock basis (a′ = a·p′/p).
    const rolled = applyExitMode(payload, 'roll');
    expect(rolled.cx).toBe(0);
    expect(rolled.p).toBeCloseTo(282 + 129.16, 5);
    expect(rolled.a).toBeCloseTo(0.1781 * ((282 + 129.16) / 282), 8);
    // Matching mode → identity (the exact same object).
    expect(applyExitMode(payload, 'close')).toBe(payload);
    // Round trip: closing a rolled payload lands back on the original target.
    expect(applyExitMode(rolled, 'close').p).toBeCloseTo(282, 5);
    // Unknown exit parts can't move the number.
    const unknown = applyExitMode(
      makeSharePayload({ f: { ...payload.f, fp: null, fs: null } }),
      'roll',
    );
    expect(unknown.p).toBe(282);
    expect(unknown.cx).toBe(0);
  });

  it('exposes every leg and the payload spread for the diagram', () => {
    const v = derivePositionView(
      makeSharePayload({ l: [...payload.l, { k: 'p', x: 'HYPERLIQUID', s: 'S', n: 1_000 }] }),
      payload.t,
    );
    expect(v.isCanonicalFourLegs).toBe(false);
    expect(v.legs).toHaveLength(5); // columns keep 1 per kind — legs keep all
    expect(v.lockedSpread).toBe(0.0707);
  });
});
