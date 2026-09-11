/** The asset view's 4-leg pair → the v1 share payload.
 *
 * WHITELIST-COPY ONLY — every field is named here explicitly, and the pair
 * is never spread. That is the privacy contract: nothing identifying has a
 * path into the wire format. The APR/PnL inputs are the numbers the pair
 * popup DISPLAYS — this module never re-derives them, so what the viewer of
 * the link sees is exactly what the sharer saw. */
import type { ShareLegV1, SharePayloadV1 } from '../lib/shareCodec';
import type { PairEstimate } from './assets/assetModel';

/** PairEstimate → the same v1 payload, for the asset view's pair popup.
 *
 * Same WHITELIST-COPY contract as `buildSharePayload`: every field is named
 * explicitly, the pair is never spread, and the displayed numbers are passed
 * in rather than re-derived so the link shows exactly what the sharer saw.
 *
 * A pair is an ESTIMATE (the short side is sliced proportionally), so it always
 * mints `uc: 1` — the shared page must not present a proposed split as fact. */
export function pairSharePayload(
  pair: PairEstimate,
  base: string,
  opts: {
    nowSec: number;
    inclPerpFees: boolean;
    inclExitFee: boolean;
    /** The popup's displayed net APR / net dollars. */
    netApr: number | null;
    netUsd: number | null;
  },
): SharePayloadV1 {
  const sig4 = (v: number) => Number(v.toPrecision(4));
  const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
  // Same $100 bucket as the strategy card: an exact notional would join a
  // public Boros fill uniquely.
  const round100 = (v: number) => Math.round(v / 100) * 100;
  const legs: ShareLegV1[] = pair.legs.map((l) => {
    const leg: ShareLegV1 = {
      k: l.kind === 'yu' ? 'b' : 'p',
      x: l.venue,
      s: l.side === 'SHORT' ? 'S' : 'L',
      n: round100(l.notionalUsd),
    };
    if (l.kind === 'yu' && l.lockedApr !== null) leg.r = l.lockedApr;
    // `tn`/`ts` is a COIN quantity — every leg carries one.
    if (SYMBOL_RE.test(base) && l.sizeBase > 0 && leg.n > 0) {
      const tn = sig4(l.sizeBase);
      if (tn > 0 && tn < 1e12) {
        leg.tn = tn;
        leg.ts = base;
      }
    }
    return leg;
  });
  const rank = (l: ShareLegV1) => `${l.k === 'b' ? 0 : 1}:${l.s === 'S' ? 0 : 1}:${l.x}`;
  legs.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  return {
    v: 1,
    b: base,
    t: opts.nowSec,
    m: pair.soonestMaturitySec,
    // UTC-day bucket, as above: the exact open second is the strongest join
    // key against public Boros fills, and the timeline only renders dates.
    cs:
      pair.hedgedSinceSec === null
        ? null
        : pair.hedgedSinceSec - (pair.hedgedSinceSec % 86_400),
    a: opts.netApr ?? 0,
    c: pair.capitalUsd,
    // The pair model carries one capital figure, not a perp/Boros split.
    cp: null,
    cb: null,
    p: opts.netUsd ?? 0,
    // The card prints this as "N% locked spread", and a spread is a rate on
    // NOTIONAL: what the receive leg locks minus what the pay leg locks, net
    // of settlement fees. `lockedAprFwd` is that same carry over CAPITAL —
    // the leveraged figure the headline APR already shows — and it read as
    // a 32% "spread" beside a 26% APR. Recover the notional basis from it:
    // carry per year = lockedAprFwd × capital; per-leg notional = half the
    // pair's two perp notionals.
    sp: (() => {
      const perLegNotional = pair.notionalUsd / 2;
      return pair.lockedAprFwd !== null && perLegNotional > 0 ? (pair.lockedAprFwd * pair.capitalUsd) / perLegNotional : 0;
    })(),
    // A pair only exists once both sides are on, and assetModel builds it from
    // legs that are open on both venues.
    h: 'h',
    // The perp-side cost switches the popup exposes.
    ce: opts.inclPerpFees ? 1 : 0,
    cx: opts.inclExitFee ? 1 : 0,
    // Always: the short side is sliced by today's sizes, never measured.
    uc: 1,
    l: legs,
    f: {
      pp: opts.inclPerpFees ? pair.perpFeesPaidUsd : 0,
      ps: null,
      // The pair model does not separate Boros trade from settlement fees.
      pb: pair.borosFeesPaidUsd,
      pl: 0,
      fp: opts.inclExitFee ? pair.exitFeeUsd : null,
      fs: null,
      fb: 0,
    },
  };
}
