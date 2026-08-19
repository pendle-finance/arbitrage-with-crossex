/** Pure view-model over a decoded share payload. Every number on the page is
 * displayed exactly as carried in the payload — nothing is recomputed from
 * live data (the page makes no API calls); only "has it matured since sharing"
 * is judged against the viewer's clock. */
import { fmtDateLocal, fmtDateUtc } from '../lib/fmt';
import { hedgeLabel } from '../lib/share';
import type { ShareLegV1, SharePayloadV1 } from '../lib/shareCodec';

export interface VenueColumn {
  venue: string;
  boros?: ShareLegV1;
  perp?: ShareLegV1;
}

export interface PositionView {
  matured: boolean;
  daysLeftAtShare: number;
  sharedOnLabel: string;
  maturityLabel: string;
  hedgeLabel: string;
  /** Every leg, payload order — the fallback list must not lose any. */
  legs: ShareLegV1[];
  /** The payload's own locked spread — the authoritative number for banners
   * (receive − pay can disagree with it on reshaped books). */
  lockedSpread: number;
  /** Boros SHORT = the rate received; Boros LONG = the rate paid. */
  receiveApr: number | null;
  payApr: number | null;
  /** SHORT column first (the receive side), then LONG — the 2×2 diagram
   * renders only when the book is the canonical two-venue shape. */
  columns: VenueColumn[];
  isCanonicalFourLegs: boolean;
  /** What the displayed numbers assumed, from the ce/cx flags. */
  costAssumptionLabel: string;
}

export type ExitMode = 'close' | 'roll';

/** The viewer's exit assumption applied to the shared numbers — the same
 * arithmetic the terminal's own exit toggle does. Rolling over hands the
 * modelled exit costs back to the PnL target; closing charges them. The APR
 * scales with the target (same capital, same clock basis: a′ = a·p′/p).
 * Returns the payload untouched when the mode already matches its cx flag. */
export function applyExitMode(p: SharePayloadV1, mode: ExitMode): SharePayloadV1 {
  const wantCx = mode === 'close' ? 1 : 0;
  if (wantCx === p.cx) return p;
  // The terminal's gates: exit fees only when known and > 0; slippage when
  // known (signed). Unknown parts simply can't move the number.
  const exitUsd = (p.f.fp !== null && p.f.fp > 0 ? p.f.fp : 0) + (p.f.fs ?? 0);
  const adjustedP = wantCx === 0 ? p.p + exitUsd : p.p - exitUsd;
  const adjustedA = p.p !== 0 ? p.a * (adjustedP / p.p) : p.a;
  return { ...p, cx: wantCx, p: adjustedP, a: adjustedA };
}

export function derivePositionView(p: SharePayloadV1, nowSec: number): PositionView {
  const borosLegs = p.l.filter((l) => l.k === 'b');
  const perpLegs = p.l.filter((l) => l.k === 'p');

  const venues: string[] = [];
  for (const l of p.l) if (!venues.includes(l.x)) venues.push(l.x);
  // SHORT column first: that's the venue whose fixed rate the position receives.
  venues.sort((a, b) => {
    const sideRank = (v: string) => (p.l.find((l) => l.x === v && l.k === 'b')?.s === 'S' ? 0 : 1);
    return sideRank(a) - sideRank(b) || (a < b ? -1 : 1);
  });
  const columns: VenueColumn[] = venues.map((venue) => ({
    venue,
    boros: borosLegs.find((l) => l.x === venue),
    perp: perpLegs.find((l) => l.x === venue),
  }));
  const isCanonicalFourLegs =
    p.l.length === 4 &&
    columns.length === 2 &&
    columns.every((c) => c.boros && c.perp && c.boros.s === c.perp.s) &&
    columns[0].boros?.s === 'S' &&
    columns[1].boros?.s === 'L';

  const receiveApr = borosLegs.find((l) => l.s === 'S')?.r ?? null;
  const payApr = borosLegs.find((l) => l.s === 'L')?.r ?? null;

  return {
    matured: nowSec > p.m,
    daysLeftAtShare: Math.max(1, Math.round((p.m - p.t) / 86_400)),
    sharedOnLabel: fmtDateLocal(p.t),
    maturityLabel: fmtDateUtc(p.m),
    hedgeLabel: hedgeLabel(p.h, true),
    legs: p.l,
    lockedSpread: p.sp,
    receiveApr,
    payApr,
    columns,
    isCanonicalFourLegs,
    costAssumptionLabel:
      p.ce === 1 && p.cx === 1
        ? 'Numbers are net of the perp entry costs and the estimated exit costs.'
        : p.ce === 1
          ? 'Numbers include the perp entry costs; exit costs are omitted (the perps roll over).'
          : p.cx === 1
            ? 'Numbers include the estimated exit costs; entry costs are omitted (the perps were rolled in).'
            : 'Entry and exit perp costs are omitted (the perps roll through this maturity).',
  };
}
