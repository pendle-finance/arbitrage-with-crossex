/**
 * execution engine — shared contracts. THE execution engine of the app:
 * every trade (maker+hedge pair, both-market pair, single open, close) is a
 * DEAL — converge leg A to a target, keeping leg B (when present) hedged to
 * A's fills.
 *
 * Design (docs/MAKER-HEDGE.md): one SQLite file is the system of record (intent +
 * write-ahead order registry + observed facts); one single-writer reconcile
 * loop is the only code that mutates state or calls venue-mutating endpoints;
 * every derived quantity is a pure fold recomputed each tick.
 */

export type PairMode = 'OPENING' | 'CONVERTING' | 'STOPPING' | 'HALTED' | 'DONE';
export type OrderState = 'PENDING' | 'OPEN' | 'CLOSED' | 'DEAD';
export type Leg = 'A' | 'B';
export type Side = 'BUY' | 'SELL';

/** Venue trading rules for one leg, snapshotted at deal creation (decimal strings). */
export interface LegSpec {
  contract: string;
  side: Side;
  lot: string;
  minSize: string;
  minNotional: string;
  /** Venue tick size — needed to price banded marketable-limit clips. */
  tick: string;
  /** Reduce-only leg (closes): every order on this leg is reduce-only. */
  reduceOnly?: boolean;
}

/**
 * THE intent row. User commands edit this row and nothing else.
 *
 * Deal shapes (all one machine):
 *  - maker pair:   a = POC maker (OPENING), b = hedge — the classic maker+hedge
 *  - taker pair:   born in CONVERTING — A clips + B hedges to target
 *  - single open:  b = null; maker (rests, no deadline) or taker (clips)
 *  - close:        taker with reduceOnly leg(s); close-pair = both legs reduceOnly
 */
export interface PairRow {
  id: string;
  mode: PairMode;
  a: LegSpec; // leg A = acquiring leg (post-only maker; taker clips when converting)
  b: LegSpec | null; // leg B = hedge leg (marketable LIMIT IOC, opposite exposure); null = single-leg deal
  targetQty: string;
  /** Current maker price intent. Placement writes the price it actually used back
   * here, so "maker price ≠ intent" is exactly "a re-peg was requested". */
  limitPrice: string | null;
  pricePolicy: 'fixed' | 'touch';
  deadlineAt: number | null;
  makerNotBefore: number; // anti-flap backoff after a POC/clip reject
  hedgeNotBefore: number; // anti-flap backoff after a hedge reject
  pocRejects: number;
  hedgeRejectStreak: number;
  /** Max A-leg clip size during CONVERTING (null = uncapped). */
  maxClip: string | null;
  /** A-clip marketable-limit band in BASIS POINTS (null = pure MARKET IOC).
   * Closes carry the user's slippage here — the clip becomes LIMIT IOC at
   * ref·(1 ± band), the close-protection semantics. */
  clipBandBp: number | null;
  /** Hedge marketable-limit band in basis points. Null is reserved for legacy
   * rows and resolves to TUNING.HEDGE_BAND_BP — there is no unpriced normal
   * hedge path. */
  hedgeBandBp: number | null;
  haltReason: string | null;
  reportJson: string | null;
  createdAt: number;
}

/** Write-ahead order registry row: exists (committed) BEFORE the wire call. */
export interface OrderRow {
  pairId: string;
  leg: Leg;
  seq: number;
  /** Deterministic: 't-<pairId>.<leg><seq>' — derivable from durable state, never reused. */
  clientId: string;
  kind: 'maker' | 'taker';
  side: Side;
  qty: string;
  price: string | null;
  tif: 'poc' | 'ioc';
  state: OrderState;
  venueOrderId: string | null;
  /** Venue cumulative fill; monotone (a shrink is corruption → alert + quarantine). */
  cumQty: string;
  /** Venue's average execution price for this order (executed_avg_price); '0'
   * until it fills. Persisted so a leg's realized avg fill survives to finish. */
  avgFillPrice: string;
  closeReason: string | null;
  cancelRequested: 0 | 1;
  /** Raw venue status string the open-world decoder could not classify. */
  quarantinedStatus: string | null;
  /** The venue's own explanation for the last status it reported (label +
   * message). A status alone ("FAIL") tells the user nothing; this is what
   * says whether to retry, resize, or switch venue. */
  venueReason: string | null;
  /** Consecutive failed venue reads on this order (reset by any successful one).
   * A read failure resolves nothing, so a persistent one silently freezes our
   * view of a live order while it keeps filling — this makes that visible. */
  readFailStreak: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AlertRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  pairId: string | null;
  message: string;
  ack: 0 | 1;
}

// ---------------------------------------------------------------------------
// Venue port — the ONLY surface the loop talks to. Implemented by the real
// Gate adapter (venueGate.ts) and by the simulation's fake venue.
// ---------------------------------------------------------------------------

export interface OrderSnapshot {
  venueOrderId: string;
  /** Verbatim venue status string; decoded open-world by the loop. */
  rawStatus: string;
  cumQty: string;
  /** Venue's own average execution price for THIS order (Gate executed_avg_price);
   * '0' when nothing has filled. The only trustworthy realized fill price for
   * an IOC order. */
  avgFillPrice: string;
  /** Venue's cancellation/rejection cause ('' when none). */
  reason: string;
}

/** Three-way, never two-way: 'unknown' is anything that is not a definitively
 * parsed venue business answer — timeouts, resets, ANY 5xx, unmatched labels. */
export type CreateOutcome =
  | { kind: 'ok'; snapshot: OrderSnapshot }
  | { kind: 'reject'; label: string; message: string }
  | { kind: 'unknown'; message: string };

export type CancelOutcome =
  | { kind: 'ok' } // canceled, or already terminal/not found ("no further fills" holds)
  | { kind: 'unknown'; message: string };

export type ReadOutcome =
  | { kind: 'found'; snapshot: OrderSnapshot }
  | { kind: 'notFound' } // AUTHORITATIVE not-found (the read itself succeeded)
  | { kind: 'error'; message: string }; // read failed — resolves NOTHING

export interface SweepResult {
  /** True only when the listings PROVABLY covered [fromMs, now] (symbol-filtered,
   * paginated to exhaustion, every page read succeeded). covered=false must never
   * be treated as absence (hazard 5). */
  covered: boolean;
  found?: OrderSnapshot;
}

export interface VenuePort {
  create(req: {
    contract: string;
    side: Side;
    qty: string;
    price?: string;
    tif: 'poc' | 'ioc';
    reduceOnly?: boolean;
    clientText: string;
  }): Promise<CreateOutcome>;
  cancel(ref: { venueOrderId?: string; clientText: string }): Promise<CancelOutcome>;
  getOrder(ref: { venueOrderId?: string; clientText: string }): Promise<ReadOutcome>;
  sweepForOrder(contract: string, clientText: string, fromMs: number): Promise<SweepResult>;
  /** Best same-side touch price for a resting maker, formatted for the venue
   * (tick-snapped + Hyperliquid 5-sig-fig cap — `tick` is the leg's tick size);
   * null when the book is unavailable. */
  touch(contract: string, side: Side, tick: string): Promise<string | null>;
  /** Sane fresh book midpoint for sizing and band pricing; null when the book
   * is unavailable, crossed, one-sided, or absurdly wide. */
  refPrice(contract: string): Promise<string | null>;
}

export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface Projection {
  aFilled: string;
  aReserved: string;
  bFilled: string;
  bReserved: string;
  /** max(0, aFilled − bReserved) — what may still be hedged (raw, un-floored). */
  unhedged: string;
  /** max(0, target − aReserved) — what may still be acquired (raw, un-floored). */
  residualA: string;
  /** Newest leg-A maker order, if any. */
  makerOrder: OrderRow | null;
  anyPending: boolean;
  anyQuarantined: boolean;
  /** The first order stuck on a status the decoder cannot classify (any leg).
   * Stop / a halted pair cancels THIS to break the freeze — see decide(). */
  quarantinedOrder: OrderRow | null;
  /** Every order in a settled state (nothing PENDING/OPEN/quarantined). */
  allSettled: boolean;
}

export interface Report {
  aFilled: string;
  bFilled: string;
  unhedged: string;
  reason: string;
  /** Quantity-weighted average fill price per leg (decimal string), populated at
   * finish from the recorded fills. Null when the leg took no fills. Leg A is the
   * maker (limit) leg; leg B is the taker (hedge) leg. */
  aAvgFill?: string | null;
  bAvgFill?: string | null;
}

export type Action =
  | { type: 'idle'; reason?: string }
  | { type: 'setMode'; mode: PairMode; reason: string; haltReason?: string }
  | { type: 'place'; leg: Leg; kind: 'maker' | 'taker'; tif: 'poc' | 'ioc'; qty: string; price?: string }
  | { type: 'cancel'; order: OrderRow }
  | { type: 'finish'; report: Report };

export interface Tuning {
  TICK_MS: number;
  /** Re-tick interval right after the loop ACTED (placed/canceled/mode-edited):
   * convergence sequences (a Stop = hedge → cancel → observe → finish) run at
   * this cadence instead of one step per TICK_MS. Venue reads pace it naturally. */
  FAST_TICK_MS: number;
  /** Before this age an authoritative not-found may still mean "create in flight"
   * (or inside Gate's 60s post-terminal text-lookup grace) — stay PENDING. */
  AMBIGUITY_MS: number;
  POC_BACKOFF_MS: number;
  HEDGE_BACKOFF_MS: number;
  MAX_POC_REJECTS: number;
  HEDGE_REJECT_HALT: number;
  /** Default normal hedge slippage guard, basis points. */
  HEDGE_BAND_BP: number;
  /** Maximum hedge band while draining already-naked exposure. */
  HEDGE_EMERGENCY_MAX_BP: number;
  /** Failed attempts at which STOPPING/HALTED may lift the cap and use MARKET. */
  HEDGE_EMERGENCY_STREAK: number;
  /** Maximum sane relative bid/ask spread (0.05 = 5%). */
  MAX_BOOK_SPREAD: number;
  /** Convert clips: caps peak unhedged exposure during completion. */
  MAX_CLIP: string;
  /** Consecutive failed reads on ONE live order before alerting. A live order we
   * cannot read is filling untracked, so this is deliberately small — but not 1,
   * which would fire on any transient blip. */
  READ_FAIL_ALERT: number;
}

export const TUNING: Tuning = {
  TICK_MS: 1_000,
  FAST_TICK_MS: 150,
  AMBIGUITY_MS: 90_000,
  POC_BACKOFF_MS: 2_000,
  HEDGE_BACKOFF_MS: 3_000,
  MAX_POC_REJECTS: 5,
  HEDGE_REJECT_HALT: 3,
  HEDGE_BAND_BP: 50,
  HEDGE_EMERGENCY_MAX_BP: 300,
  HEDGE_EMERGENCY_STREAK: 6,
  MAX_BOOK_SPREAD: 0.05,
  MAX_CLIP: '1000000000', // effectively uncapped by default; pairs may be created with less
  READ_FAIL_ALERT: 5,
};
