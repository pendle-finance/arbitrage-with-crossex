import { describe, expect, it } from 'vitest';
import { decodeSharePayload, encodeSharePayload } from '../lib/shareCodec';
import { makeStrategyLeg, makeStrategyRollup, STRATEGY_NOW } from '../test/fixtures';
import type { CostFlags } from './strategyMath';
import { buildSharePayload } from './sharePayload';

const flags: CostFlags = {
  inclExitFees: true,
  inclExitSlippage: true,
  inclEntryCost: true,
  excludedEntryPartIds: new Set<string>(),
};

/** The displayed locals StrategyCard would pass (the 17.81% / +$282 book with
 * the exit costs rolled over — the exact numbers its own tests pin). */
const displayed = { fixedAprOnCapital: 0.1781, expectedUsd: 282.21 };

const build = (over: Parameters<typeof makeStrategyRollup>[0] = {}) =>
  buildSharePayload({ s: makeStrategyRollup(over), ...displayed, flags, nowSec: STRATEGY_NOW });

describe('buildSharePayload', () => {
  it('snapshots the displayed values and the rollup whitelist', () => {
    const p = build();
    const opened = makeStrategyRollup().clockStartSec!;
    expect(p.v).toBe(1);
    expect(p.b).toBe('HYPE');
    expect(p.t).toBe(STRATEGY_NOW);
    expect(p.m).toBe(makeStrategyRollup().maturity);
    // UTC-day bucketed — the exact open second is an on-chain join key.
    expect(p.cs).toBe(opened - (opened % 86_400));
    expect(p.cs! % 86_400).toBe(0);
    expect(p.a).toBe(0.1781);
    expect(p.c).toBe(41_320);
    expect(p.cp).toBe(33_056);
    expect(p.cb).toBe(8_264);
    expect(p.p).toBe(282.21);
    expect(p.sp).toBe(0.0707);
    expect(p.h).toBe('h');
    expect(p.f).toEqual({
      pp: 65.01,
      ps: 49.16,
      pb: 3.77,
      pl: 1.6,
      fp: 80,
      fs: 49.16,
      fb: 10.06,
    });
  });

  it('orders legs deterministically and rounds notionals to display precision ($100)', () => {
    const p = build();
    // The perps carry their coin size (tn/ts); the USDT Boros legs do not —
    // asserted on its own above, so the shape here stays about ORDER.
    expect(p.l.map(({ tn: _tn, ts: _ts, ...rest }) => rest)).toEqual([
      { k: 'b', x: 'HYPERLIQUID', s: 'S', n: 158_800, r: 0.0936 },
      { k: 'b', x: 'BYBIT', s: 'L', n: 158_800, r: 0.0229 },
      { k: 'p', x: 'HYPERLIQUID', s: 'S', n: 160_300 }, // 160,316 → nearest $100
      { k: 'p', x: 'BYBIT', s: 'L', n: 160_300 },
    ]);
  });

  it('drops excluded entry parts from the shared fee lines (chargedEntryUsd doctrine)', () => {
    const withExcluded = (ids: string[]) =>
      buildSharePayload({
        s: makeStrategyRollup(),
        ...displayed,
        flags: { ...flags, excludedEntryPartIds: new Set(ids) },
        nowSec: STRATEGY_NOW,
      });
    // Slippage part slip:deal:deal-a ($30.00) excluded → ps hands it back.
    expect(withExcluded(['slip:deal:deal-a']).f.ps).toBeCloseTo(49.16 - 30, 5);
    // A fee part excluded → pp hands it back; ps untouched.
    const fees = withExcluded(['fees:BYBIT_FUTURE_HYPE_USDT']);
    expect(fees.f.pp).toBeCloseTo(65.01 - 20.55, 5);
    expect(fees.f.ps).toBeCloseTo(49.16, 5);
    // Master switch off: raw paid figures stay (label says unattributed).
    const rolled = buildSharePayload({
      s: makeStrategyRollup(),
      ...displayed,
      flags: { ...flags, inclEntryCost: false, excludedEntryPartIds: new Set(['slip:deal:deal-a']) },
      nowSec: STRATEGY_NOW,
    });
    expect(rolled.f.pp).toBeCloseTo(65.01, 5);
    expect(rolled.f.ps).toBeCloseTo(49.16, 5);
  });

  it('mirrors the cost toggles into ce/cx', () => {
    const rolled = buildSharePayload({
      s: makeStrategyRollup(),
      ...displayed,
      flags: { inclExitFees: false, inclExitSlippage: false, inclEntryCost: false },
      nowSec: STRATEGY_NOW,
    });
    expect(rolled.ce).toBe(0);
    expect(rolled.cx).toBe(0);
    expect(build().ce).toBe(1);
    expect(build().cx).toBe(1);
  });

  it('sizes token-margined legs in tokens (tn/ts) at display precision', () => {
    const p = build({
      legs: makeStrategyRollup().legs.map((l) =>
        l.kind === 'boros'
          ? makeStrategyLeg({ ...l, collateral: 'HYPE', notionalToken: 158_801.7 })
          : l,
      ),
    });
    // Boros: sized in the collateral token, at n's own $100-bucket precision.
    for (const l of p.l.filter((x) => x.k === 'b')) expect([l.tn, l.ts]).toEqual([158_800, 'HYPE']);
    // Perp: the base-coin size rides along on a token-margined strategy —
    // 900 tokens on a $160,316 leg re-expressed at n = $160,300 is 899.9: tn
    // is the ROUNDED n in token terms, never the book quantity.
    for (const l of p.l.filter((x) => x.k === 'p')) expect([l.tn, l.ts]).toEqual([899.9, 'HYPE']);
  });

  it('quantizes tn to the $100 USD bucket — tn carries nothing n does not', () => {
    // A $1,950 leg rounds to n = $2,000; its 43.18 tokens ride along scaled
    // the same way (44.29), so tn's granularity IS n's, whatever the price.
    const p = build({
      legs: [makeStrategyLeg({ collateral: 'HYPE', notionalUsd: 1_950, notionalToken: 43.18 })],
    });
    expect(p.l[0].n).toBe(2_000);
    expect(p.l[0].tn).toBe(44.29);
  });

  it('drops the bracket, without throwing, when the symbol fails the wire charset', () => {
    const p = build({
      legs: [makeStrategyLeg({ collateral: 'USDe', notionalUsd: 1_950, notionalToken: 1_949 })],
    });
    expect([p.l[0].tn, p.l[0].ts]).toEqual([undefined, undefined]);
    expect(() => encodeSharePayload(p)).not.toThrow();
  });

  it('carries a perp coin size even on a USDT-margined book, and no USDT one', () => {
    // Same rule as the card's notional column, from the same function: a
    // perp's coin size is never recoverable from its dollars, so it travels;
    // a USDT Boros leg's "size" IS its dollars, so it does not. Sharing must
    // not bracket a leg differently than the card it was taken from.
    const legs = build().l;
    for (const l of legs.filter((x) => x.k === 'p')) {
      expect([typeof l.tn, l.ts]).toEqual(['number', 'HYPE']);
    }
    for (const l of legs.filter((x) => x.k === 'b')) {
      expect([l.tn, l.ts]).toEqual([undefined, undefined]);
    }
  });

  it('encodes cleanly and round-trips through the codec', () => {
    const enc = encodeSharePayload(build());
    const dec = decodeSharePayload(enc);
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(dec.payload.a).toBe(0.1781);
      expect(dec.payload.p).toBe(282); // whole-dollar canonicalization
      expect(dec.payload.l).toHaveLength(4);
    }
  });

  it('leaks no address, symbol, or warning text — even when the rollup carries them', () => {
    const addressy = build({
      warnings: [`tracked address ${'0x' + 'ab'.repeat(20)} has a leg mismatch`],
      legs: makeStrategyRollup().legs.map((l) =>
        makeStrategyLeg({ ...l, warnings: [`entry price unknown for ${'0x' + 'cd'.repeat(20)}`] }),
      ),
    });
    const wire = encodeSharePayload(addressy);
    const json = JSON.stringify(addressy);
    for (const s of [json, wire]) {
      expect(s).not.toMatch(/0x[a-fA-F0-9]{40}/);
      expect(s).not.toContain('warnings');
      expect(s).not.toContain('symbol');
      expect(s).not.toContain('FUTURE_HYPE'); // no perp symbols
    }
  });
});
