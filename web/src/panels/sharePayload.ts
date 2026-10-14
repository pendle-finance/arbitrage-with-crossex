/** The asset view's pair → the v1 share payload.
 *
 * WHITELIST-COPY ONLY — every field is named here explicitly, and the pair
 * is never spread. That is the privacy contract: nothing identifying has a
 * path into the wire format. The APR/PnL inputs are the numbers the pair
 * popup DISPLAYS — this module never re-derives them, so what the viewer of
 * the link sees is exactly what the sharer saw. */
import type { ShareLegV1, SharePayloadV1 } from '../lib/shareCodec';
import { spreadShareVenue } from '../lib/spread';
import { entryAprOf, pairLockedSpread, type PairEstimate, type PairLegDetail } from './assets/assetModel';

type ShareSourceLeg = Pick<PairLegDetail, 'kind' | 'venue' | 'side' | 'notionalUsd' | 'sizeBase' | 'lockedApr' | 'spreadVenues'>;

/**
 * Every Boros leg of the pair as ONE spread leg, however Boros holds it: a
 * spread market, two single legs, or both (mozzarella, 2026-10-12). Two single
 * legs on venues A and B lock the same thing a spread on A−B does, so the card
 * reads the same in every case. The leg is sized per perp side (a spread counts
 * whole, a single half, as `pairLockedSpread` counts it) and carries the pair's
 * net locked spread. Left as they are when the Boros legs do not span exactly
 * two venues, or the singles on one venue disagree on side.
 */
export function borosLegsAsSpread(legs: readonly ShareSourceLeg[], lockedSpread: number): ShareSourceLeg[] {
  const yu = legs.filter((l) => l.kind === 'yu');
  if (yu.length === 0) return [...legs];
  const real = yu.find((l) => l.spreadVenues);
  const venueSet = new Set(yu.flatMap((l) => (l.spreadVenues ? [...l.spreadVenues] : [l.venue]).map((v) => v.toUpperCase())));
  if (venueSet.size !== 2) return [...legs];
  // The order Boros names its one spread by (HL first), else A to Z.
  const venues = (real?.spreadVenues?.map((v) => v.toUpperCase()) ??
    [...venueSet].sort((a, b) => (a === 'HYPERLIQUID' ? -1 : b === 'HYPERLIQUID' ? 1 : a < b ? -1 : 1))) as [string, string];
  const firstSides = new Set(yu.filter((l) => !l.spreadVenues && l.venue.toUpperCase() === venues[0]).map((l) => l.side));
  if (firstSides.size > 1) return [...legs];
  const side = real?.side ?? [...firstSides][0];
  if (!side) return [...legs];
  const half = (l: ShareSourceLeg) => (l.spreadVenues ? 1 : 0.5);
  const merged: ShareSourceLeg = {
    kind: 'yu',
    venue: venues[0],
    side,
    notionalUsd: yu.reduce((t, l) => t + l.notionalUsd * half(l), 0),
    sizeBase: yu.reduce((t, l) => t + l.sizeBase * half(l), 0),
    // Unknown when any leg's rate is: a guess here would be a public claim.
    lockedApr: yu.every((l) => l.lockedApr !== null) ? lockedSpread : null,
    spreadVenues: venues,
  };
  return [...legs.filter((l) => l.kind !== 'yu'), merged];
}

/** PairEstimate → the same v1 payload, for the asset view's pair popup.
 *
 * Same WHITELIST-COPY contract as `buildSharePayload`: every field is named
 * explicitly, the pair is never spread, and the displayed numbers are passed
 * in rather than re-derived so the link shows exactly what the sharer saw.
 *
 * A pair is an ESTIMATE (the short side is sliced proportionally), so it always
 * mints `uc: 1` — the shared page must not present a proposed split as fact.
 *
 * ⚠ The displayed numbers are REQUIRED. `SharePayloadV1` types `a`, `p` and
 * `sp` as plain numbers, so a null reaching here can only become zero — and
 * zero is a public claim, not a blank. Non-nullable params push that decision
 * back to `canSharePair`, which hides the button instead. */
export function pairSharePayload(
  pair: PairEstimate,
  base: string,
  opts: {
    nowSec: number;
    inclPerpFees: boolean;
    inclExitFee: boolean;
    /** The popup's displayed net APR / net dollars — non-null by `canSharePair`. */
    netApr: number;
    netUsd: number;
    /** `pair.lockedAprFwd`, also non-null by `canSharePair`. Passed rather than
     * re-read off `pair` so the guarantee is the type system's, not a comment. */
    lockedAprFwd: number;
  },
): SharePayloadV1 {
  const sig4 = (v: number) => Number(v.toPrecision(4));
  const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
  // Same $100 bucket as the strategy card: an exact notional would join a
  // public Boros fill uniquely.
  const round100 = (v: number) => Math.round(v / 100) * 100;
  const sp = pairLockedSpread({ ...pair, lockedAprFwd: opts.lockedAprFwd }) ?? 0;
  const legs: ShareLegV1[] = borosLegsAsSpread(pair.legs, sp).map((l) => {
    const leg: ShareLegV1 = {
      k: l.kind === 'yu' ? 'b' : 'p',
      x: l.kind === 'yu' && l.spreadVenues ? spreadShareVenue(l.spreadVenues) : l.venue,
      s: l.side === 'SHORT' ? 'S' : 'L',
      n: round100(l.notionalUsd),
    };
    // `r` is the leg's entry fixed rate (the codec's contract), which the
    // share page reads with the side: SHORT receives it, LONG pays it.
    // `lockedApr` is signed for the trader (LONG = −entry), so turn it back.
    if (l.kind === 'yu' && l.lockedApr !== null) leg.r = entryAprOf(l.side, l.lockedApr);
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
    a: opts.netApr,
    c: pair.capitalUsd,
    // The pair model carries one capital figure, not a perp/Boros split.
    cp: null,
    cb: null,
    p: opts.netUsd,
    // The card prints this as "N% locked spread", and a spread is a rate on
    // NOTIONAL, not the leveraged-on-capital `lockedAprFwd` (which read as a
    // 32% "spread" beside a 26% APR). Same helper as the pair card's
    // sub-line, so the link shows the figure the sharer saw.
    sp,
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
