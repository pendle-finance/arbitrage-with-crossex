/**
 * PREVIEW TRACKING LEDGER — the durable state behind the new tracking UX.
 *
 * ⚠ Stored under its OWN key (`crossex.ledger.v1`). It never reads or writes
 * `crossex.partition.v1` / `crossex.entryOverride.v1`, so an installed
 * instance's existing annotations are untouched by the preview.
 *
 * The model: a strategy is a TIME-EXTENDED object. Its durable state is a list
 * of user-intent EVENTS, not a snapshot of venue positions:
 *   - enroll(leg, qty, t, baseline)  — this much of that venue leg is part of
 *     this strategy from time t. `baseline` freezes what the leg had already
 *     accumulated at t, so only the delta counts.
 *   - unenroll(tranche, qty, t, banked) — this much leaves the strategy
 *     ("retire": the venue position may live on). Its contribution up to t is
 *     BANKED — frozen into the event — so strategy PnL is conserved across
 *     rollovers, venue switches and retirements instead of vanishing with the
 *     leg.
 *
 * PnL = Σ banked + Σ (live − baseline) per open tranche. APR is money-weighted
 * over Σ capital·time. Every number is derived by folding the events against
 * the live feeds — nothing here stores a balance.
 *
 * PROTOTYPE NOTE: baselines and banked values are computed CLIENT-SIDE from
 * the strategy feed's per-leg numbers. The production slice moves this into
 * the server (event replay against venue history), which also removes the
 * approximations noted in model.ts. The event shapes are designed to survive
 * that move unchanged.
 */
import { readJson, writeJson } from '../../lib/storage';
import { bookKey, type LegRef } from '../partitionStore';

const KEY = 'crossex.ledger.v1';

/** Events describe finished maturities long after they close; keep them well
 * past any Boros maturity, then let the book expire as a unit. */
const MAX_AGE_SEC = 365 * 24 * 3600;

export interface LedgerStrategy {
  sid: string;
  /** User-facing name; absent = derived from the composition. */
  label?: string;
  /** 'auto' = materialized from a solver proposal; 'user' = built by hand.
   * Purely informational — both are edited the same way. */
  provenance: 'auto' | 'user';
  /** The solver strategyId this was adopted from, so the materializer can tell
   * "already adopted" from "new proposal" across polls. */
  sourceId?: string;
  /** Wall-clock instant the record was written. */
  createdAt: number;
  /**
   * When the STRATEGY began — its rate lock (earliest Boros fill) for adopted
   * ones. Enrollment never predates it: whatever a leg earned before belongs
   * to its previous life and is moot from this strategy's perspective.
   */
  startedAt?: number;
  /** Adoption-logic version this auto strategy was materialized under. The
   * materializer re-adopts (dissolve + fresh events) when its logic moves on,
   * or stale defaults would outlive every fix. */
  av?: number;
}

/** What the leg had already accumulated when it was enrolled — the subtrahend
 * that keeps pre-strategy history out of the strategy's numbers. */
export interface EnrollBaseline {
  /** The enrolled share's net PnL at enrollment (0 = "count from its open"). */
  netUsd: number;
  /** True when netUsd is a TIME-PRORATED estimate (the browser cannot read
   * historical flows; the server replay replaces it with the exact figure).
   * Exact baselines — 0 at the venue open, or the live net at "now" — omit it. */
  netEstimated?: boolean;
  /** Venue qty at enrollment — share drift detection (rebase trigger later). */
  venueQty: number;
  /** Capital (margin) the enrolled share required — the APR denominator. */
  capitalUsd: number;
  /** Asserted entry (price for a perp, APR fraction for Boros); absent = the
   * venue's own figure. */
  entry?: number;
  /** Where `entry` came from: 'fill' = read off the venue's own fill record
   * (a true per-tranche entry, not an override); 'user' (or absent) = the
   * user asserted it by hand. Display marks only the user kind. */
  entryFrom?: 'fill' | 'user';
  /** True when the user chose "only from now on" — the baseline was frozen
   * at the then-live net. Later edits must HONOR this: recomputing such a
   * baseline as a since-open proration would silently pull the leg's whole
   * past back into the strategy. */
  fresh?: boolean;
}

export interface EnrollEvent {
  id: string;
  sid: string;
  kind: 'enroll';
  leg: LegRef;
  /** Concrete size in the leg's own unit (base coin for perps, collateral
   * token for Boros). Always resolved at write time — never "all". */
  qty: number;
  /** Effective time (unix sec) — when this tranche's clock starts. Always
   * ≥ the strategy's startedAt AND ≥ `avail`. */
  t: number;
  /** When the leg itself became available (its fill or venue open) — kept
   * RAW so editing the strategy's start date can re-derive t = max(start,
   * avail) without losing the leg's own date under an earlier clamp. */
  avail?: number;
  /** A venue switch this enrollment completes (closed one exchange's leg,
   * opened this one): the price gap of that migration is this strategy's
   * slippage — the two SIMULTANEOUS legs' entry gap no longer applies. */
  migration?: { from: string; costUsd: number };
  base: EnrollBaseline;
}

/** A tranche's frozen contribution when (part of) it leaves the strategy. */
export interface BankedValue {
  pnlUsd: number;
  /** Capital·time this tranche accrued (USD·seconds) — keeps the retired
   * period inside the money-weighted APR denominator. */
  capUsdSec: number;
  /** Why it left: shown in the Banked section. */
  reason: 'retired' | 'closed' | 'rolled';
}

export interface UnenrollEvent {
  id: string;
  sid: string;
  kind: 'unenroll';
  /** The enroll event this draws down. */
  ref: string;
  /** How much leaves; null = all that remains. */
  qty: number | null;
  t: number;
  banked: BankedValue;
}

export type LedgerEvent = EnrollEvent | UnenrollEvent;

export interface LedgerBook {
  strategies: LedgerStrategy[];
  events: LedgerEvent[];
  savedAtSec: number;
}

const EMPTY_BOOK: LedgerBook = { strategies: [], events: [], savedAtSec: 0 };

type Stored = Record<string, LedgerBook>;

const isLeg = (v: unknown): v is LegRef => {
  if (!v || typeof v !== 'object') return false;
  const l = v as LegRef;
  if (l.kind === 'perp') return typeof l.symbol === 'string' && l.symbol.length > 0;
  if (l.kind === 'boros') return Number.isInteger(l.marketId);
  return false;
};

const isStrategy = (v: unknown): v is LedgerStrategy => {
  if (!v || typeof v !== 'object') return false;
  const s = v as LedgerStrategy;
  return (
    typeof s.sid === 'string' &&
    (s.provenance === 'auto' || s.provenance === 'user') &&
    typeof s.createdAt === 'number'
  );
};

const isEvent = (v: unknown): v is LedgerEvent => {
  if (!v || typeof v !== 'object') return false;
  const e = v as LedgerEvent;
  if (typeof e.id !== 'string' || typeof e.sid !== 'string' || typeof e.t !== 'number') {
    return false;
  }
  if (e.kind === 'enroll') {
    return (
      isLeg(e.leg) &&
      Number.isFinite(e.qty) &&
      Boolean(e.base) &&
      Number.isFinite(e.base.netUsd) &&
      Number.isFinite(e.base.venueQty) &&
      Number.isFinite(e.base.capitalUsd)
    );
  }
  if (e.kind === 'unenroll') {
    return (
      typeof e.ref === 'string' &&
      (e.qty === null || Number.isFinite(e.qty)) &&
      Boolean(e.banked) &&
      Number.isFinite(e.banked.pnlUsd) &&
      Number.isFinite(e.banked.capUsdSec)
    );
  }
  return false;
};

const readAll = (): Stored =>
  readJson<Stored>(KEY, {}, (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const b = v as LedgerBook;
      if (
        b &&
        Array.isArray(b.strategies) &&
        b.strategies.every(isStrategy) &&
        Array.isArray(b.events) &&
        b.events.every(isEvent) &&
        typeof b.savedAtSec === 'number'
      ) {
        out[k] = b;
      }
    }
    return out;
  });

export function loadBook(bookId: string | null): LedgerBook {
  return readAll()[bookKey(bookId)] ?? EMPTY_BOOK;
}

export function saveBook(bookId: string | null, book: LedgerBook, nowSec: number): void {
  const all = readAll();
  for (const [k, v] of Object.entries(all)) {
    if (nowSec - v.savedAtSec > MAX_AGE_SEC) delete all[k];
  }
  const key = bookKey(bookId);
  if (!book.strategies.length && !book.events.length) delete all[key];
  else all[key] = { ...book, savedAtSec: nowSec };
  writeJson(KEY, all);
}

/** Minted, never derived from legs — identity must survive a re-pair, a venue
 * swap and a maturity roll (same doctrine as partitionStore.newPositionId). */
export function newId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Folding — events → live tranches + banked items, per strategy.
// ---------------------------------------------------------------------------

/** One live tranche: an enroll event minus whatever unenrolls drew from it. */
export interface Tranche {
  eventId: string;
  leg: LegRef;
  qty: number;
  t: number;
  avail?: number;
  migration?: { from: string; costUsd: number };
  base: EnrollBaseline;
}

export interface BankedItem {
  eventId: string;
  leg: LegRef;
  qty: number | null;
  t: number;
  banked: BankedValue;
}

export interface Folded {
  tranches: Tranche[];
  banked: BankedItem[];
}

const QTY_EPS = 1e-9;

/**
 * Replay a strategy's events in order. A partial unenroll scales the tranche's
 * baseline pro-rata — the retired share took its share of the baseline with it
 * into the banked value, so what remains must subtract only what remains.
 */
export function foldStrategy(events: readonly LedgerEvent[], sid: string): Folded {
  const tranches = new Map<string, Tranche>();
  const banked: BankedItem[] = [];
  for (const e of events) {
    if (e.sid !== sid) continue;
    if (e.kind === 'enroll') {
      tranches.set(e.id, {
        eventId: e.id,
        leg: e.leg,
        qty: e.qty,
        t: e.t,
        ...(e.avail !== undefined ? { avail: e.avail } : {}),
        ...(e.migration ? { migration: e.migration } : {}),
        base: { ...e.base },
      });
    } else {
      const tr = tranches.get(e.ref);
      if (!tr) continue; // dangling unenroll: keep its banked value, lose nothing else
      const take = e.qty === null ? tr.qty : Math.min(e.qty, tr.qty);
      const keepFrac = tr.qty > QTY_EPS ? (tr.qty - take) / tr.qty : 0;
      banked.push({ eventId: e.id, leg: tr.leg, qty: take, t: e.t, banked: e.banked });
      if (keepFrac <= QTY_EPS) {
        tranches.delete(e.ref);
      } else {
        tr.qty -= take;
        tr.base = {
          ...tr.base,
          netUsd: tr.base.netUsd * keepFrac,
          capitalUsd: tr.base.capitalUsd * keepFrac,
        };
      }
    }
  }
  return { tranches: [...tranches.values()], banked };
}
