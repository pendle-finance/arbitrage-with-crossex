/**
 * Rows the reader ALREADY HOLDS THE PERPS FOR.
 *
 * An opportunity is priced as a new position: two perps to open, so two
 * entry fees and two entry slips. A reader who already runs the same perps
 * (long on one venue, short on the other, same asset) pays none of that to
 * farm the pair again — they only add the Boros legs. Showing them the
 * full-cost APR understates the very rows they came for.
 *
 * So those rows are re-priced HERE, on the client, with perp entry cost at
 * zero — no new server mode, nothing else on the page changes (his call
 * 2026-09-20). Whatever size is held, however it compares with the notional
 * setting: a row is either the reader's pair or it is not (his call too —
 * partial sizing was not worth its complexity).
 *
 * Sides matter. Long OKX / short Hyperliquid is only matched by a row that is
 * long OKX and short Hyperliquid; the mirror image would mean closing and
 * re-opening both perps, which costs exactly what a new position does.
 */
import type { OpportunityPair } from '../api/types';

/** Mirrors the server's SECONDS_IN_YEAR (src/core/boros/venue.ts). */
const SECONDS_IN_YEAR = 365 * 24 * 3600;

/**
 * `rollover` — the reader holds the perps AND rate legs on both venues that
 * mature BEFORE this row's maturity, so the row is where that hedge rolls
 * to. It is the only case: holding September tags October and November;
 * holding October tags only November. A row at the maturity already held,
 * or perps with no rate legs behind them, is an ordinary row at full cost —
 * a second "you hold the perps" tag was tried and dropped (his call
 * 2026-09-20).
 */
export type HeldTag = 'rollover';

/** asset|LONGVENUE|SHORTVENUE → the soonest maturity at which BOTH venues
 * hold a Boros leg (null when they share none). */
export type HeldPerps = ReadonlyMap<string, number | null>;

const key = (asset: string, longVenue: string, shortVenue: string): string =>
  `${asset.trim().toUpperCase()}|${longVenue.trim().toUpperCase()}|${shortVenue.trim().toUpperCase()}`;

/** What the book holds on one asset, from the two light feeds the app
 * already polls: the live perp exposure, and the Boros markets that carry a
 * position. (Not the asset view — that is a heavy, history-bearing fetch.) */
export interface HeldBook {
  base: string;
  perps: ReadonlyArray<{ venue: string; side: 'LONG' | 'SHORT' }>;
  boros: ReadonlyArray<{ venue: string; maturity: number }>;
}

/** Every (asset, long venue, short venue) the book holds perps on. */
export function heldPerpsOf(books: ReadonlyArray<HeldBook>): HeldPerps {
  const out = new Map<string, number | null>();
  for (const g of books) {
    const longs = [...new Set(g.perps.filter((p) => p.side === 'LONG').map((p) => p.venue))];
    const shorts = [...new Set(g.perps.filter((p) => p.side === 'SHORT').map((p) => p.venue))];
    const maturitiesAt = (venue: string): Set<number> =>
      new Set(g.boros.filter((l) => l.venue.toUpperCase() === venue.toUpperCase()).map((l) => l.maturity));
    for (const l of longs) {
      for (const s of shorts) {
        if (l.toUpperCase() === s.toUpperCase()) continue;
        const atShort = maturitiesAt(s);
        const shared = [...maturitiesAt(l)].filter((m) => atShort.has(m));
        out.set(key(g.base, l, s), shared.length > 0 ? Math.min(...shared) : null);
      }
    }
  }
  return out;
}

/** 'rollover' when this row is a LATER maturity of a hedge the reader runs; null otherwise. */
export function heldTagFor(
  held: HeldPerps | undefined,
  asset: string,
  pair: Pick<OpportunityPair, 'longLeg' | 'shortLeg'>,
  rowMaturity: number,
): HeldTag | null {
  if (!held || held.size === 0) return null;
  const k = key(asset, pair.longLeg.crossexVenue || pair.longLeg.venue, pair.shortLeg.crossexVenue || pair.shortLeg.venue);
  if (!held.has(k)) return null;
  const soonest = held.get(k) ?? null;
  return soonest !== null && soonest < rowMaturity ? 'rollover' : null;
}

/**
 * The same pair with perp ENTRY cost at zero, every figure that depends on it
 * recomputed with the server's own identities:
 *   totalUsd        = Σ costs
 *   annualizedApr   = totalUsd / (N × T)
 *   netFixedApr     = execSpreadApr − annualizedApr
 *   estProfitUsd    = netFixedApr × N × T
 *   APR on capital  = estProfitUsd / (capitalUsd × T)
 * Capital is untouched: the margin is posted whether or not the perps are new.
 * A pair the server could not price stays unpriced.
 */
export function repriceHeld(pair: OpportunityPair, notionalUsd: number): OpportunityPair {
  const c = pair.costs;
  const years = pair.secondsToMaturity / SECONDS_IN_YEAR;
  const notionalYears = notionalUsd * years;
  if (c.totalUsd === null || !(notionalYears > 0)) return pair;
  const totalUsd = c.totalUsd - (c.perpEntryFeesUsd ?? 0) - (c.perpEntrySlippageUsd ?? 0);
  const annualizedApr = totalUsd / notionalYears;
  const netFixedApr = pair.execSpreadApr === null ? null : pair.execSpreadApr - annualizedApr;
  const estProfitUsd = netFixedApr === null ? null : netFixedApr * notionalYears;
  const capital = pair.capitalUsd !== null && pair.capitalUsd > 0 ? pair.capitalUsd : null;
  return {
    ...pair,
    costs: { ...c, perpEntryFeesUsd: 0, perpEntrySlippageUsd: 0, totalUsd, annualizedApr },
    netFixedApr,
    estProfitUsd,
    netFixedAprOnCapital: capital === null || estProfitUsd === null || !(years > 0) ? null : estProfitUsd / (capital * years),
  };
}
