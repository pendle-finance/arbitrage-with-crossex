/**
 * Engine store — node:sqlite (DatabaseSync, synchronous: the single-writer loop
 * never overlaps a transaction). The SQLite file IS the system of record.
 *
 * Pragmas: WAL + synchronous=FULL (fsync per commit — power-loss safe);
 * locking_mode=EXCLUSIVE on file-backed DBs (a second process cannot open the
 * DB for write — the single-instance guard). All multi-statement writes use
 * BEGIN IMMEDIATE (write lock up front).
 */
import { DatabaseSync } from 'node:sqlite';
import { fx, fxDiv, fxMul, fxStr, FX_ZERO } from './fx';
import type { AlertRow, LegSpec, OrderRow, PairMode, PairRow } from './types';

/** FNV-1a → base36 hash: compresses a whole client uuid into 7 chars so order
 * texts fit Gate's 28-byte cap. */
function fnv1a36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pair (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('OPENING','CONVERTING','STOPPING','HALTED','DONE')),
  a_contract TEXT NOT NULL, a_side TEXT NOT NULL, a_lot TEXT NOT NULL,
  a_min_size TEXT NOT NULL, a_min_notional TEXT NOT NULL,
  a_tick TEXT NOT NULL DEFAULT '0.0001', a_reduce_only INTEGER NOT NULL DEFAULT 0,
  b_contract TEXT, b_side TEXT, b_lot TEXT,
  b_min_size TEXT, b_min_notional TEXT,
  b_tick TEXT, b_reduce_only INTEGER NOT NULL DEFAULT 0,
  target_qty TEXT NOT NULL,
  limit_price TEXT,
  price_policy TEXT NOT NULL DEFAULT 'touch' CHECK (price_policy IN ('fixed','touch')),
  deadline_at INTEGER,
  maker_not_before INTEGER NOT NULL DEFAULT 0,
  hedge_not_before INTEGER NOT NULL DEFAULT 0,
  poc_rejects INTEGER NOT NULL DEFAULT 0,
  hedge_reject_streak INTEGER NOT NULL DEFAULT 0,
  max_clip TEXT,
  clip_band_bp INTEGER,
  hedge_band_bp INTEGER,
  halt_reason TEXT,
  report_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  pair_id TEXT NOT NULL REFERENCES pair(id),
  leg TEXT NOT NULL CHECK (leg IN ('A','B')),
  seq INTEGER NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('maker','taker')),
  side TEXT NOT NULL,
  qty TEXT NOT NULL,
  price TEXT,
  tif TEXT NOT NULL CHECK (tif IN ('poc','ioc')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','OPEN','CLOSED','DEAD')),
  venue_order_id TEXT,
  cum_qty TEXT NOT NULL DEFAULT '0',
  avg_fill_price TEXT NOT NULL DEFAULT '0',
  close_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  quarantined_status TEXT,
  venue_reason TEXT,
  read_fail_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (pair_id, leg, seq)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  pair_id TEXT,
  message TEXT NOT NULL,
  ack INTEGER NOT NULL DEFAULT 0
);
`;

interface PairDbRow {
  id: string;
  mode: string;
  a_contract: string; a_side: string; a_lot: string; a_min_size: string; a_min_notional: string;
  a_tick: string; a_reduce_only: number;
  b_contract: string | null; b_side: string | null; b_lot: string | null;
  b_min_size: string | null; b_min_notional: string | null;
  b_tick: string | null; b_reduce_only: number;
  target_qty: string;
  limit_price: string | null;
  price_policy: string;
  deadline_at: number | null;
  maker_not_before: number;
  hedge_not_before: number;
  poc_rejects: number;
  hedge_reject_streak: number;
  max_clip: string | null;
  clip_band_bp: number | null;
  hedge_band_bp: number | null;
  halt_reason: string | null;
  report_json: string | null;
  created_at: number;
}

interface OrderDbRow {
  pair_id: string; leg: string; seq: number; client_id: string;
  kind: string; side: string; qty: string; price: string | null; tif: string;
  state: string; venue_order_id: string | null; cum_qty: string; avg_fill_price: string;
  close_reason: string | null; cancel_requested: number;
  quarantined_status: string | null; venue_reason: string | null; read_fail_streak: number;
  created_at: number; resolved_at: number | null;
}

function toPair(r: PairDbRow): PairRow {
  const a: LegSpec = {
    contract: r.a_contract,
    side: r.a_side as LegSpec['side'],
    lot: r.a_lot,
    minSize: r.a_min_size,
    minNotional: r.a_min_notional,
    tick: r.a_tick,
    ...(r.a_reduce_only ? { reduceOnly: true } : {}),
  };
  const b: LegSpec | null = r.b_contract
    ? {
        contract: r.b_contract,
        side: r.b_side as LegSpec['side'],
        lot: r.b_lot ?? '0.0001',
        minSize: r.b_min_size ?? '0',
        minNotional: r.b_min_notional ?? '0',
        tick: r.b_tick ?? '0.0001',
        ...(r.b_reduce_only ? { reduceOnly: true } : {}),
      }
    : null;
  return {
    id: r.id,
    mode: r.mode as PairMode,
    a,
    b,
    targetQty: r.target_qty,
    limitPrice: r.limit_price,
    pricePolicy: r.price_policy as PairRow['pricePolicy'],
    deadlineAt: r.deadline_at,
    makerNotBefore: r.maker_not_before,
    hedgeNotBefore: r.hedge_not_before,
    pocRejects: r.poc_rejects,
    hedgeRejectStreak: r.hedge_reject_streak,
    maxClip: r.max_clip,
    clipBandBp: r.clip_band_bp,
    hedgeBandBp: r.hedge_band_bp,
    haltReason: r.halt_reason,
    reportJson: r.report_json,
    createdAt: r.created_at,
  };
}

function toOrder(r: OrderDbRow): OrderRow {
  return {
    pairId: r.pair_id,
    leg: r.leg as OrderRow['leg'],
    seq: r.seq,
    clientId: r.client_id,
    kind: r.kind as OrderRow['kind'],
    side: r.side as OrderRow['side'],
    qty: r.qty,
    price: r.price,
    tif: r.tif as OrderRow['tif'],
    state: r.state as OrderRow['state'],
    venueOrderId: r.venue_order_id,
    cumQty: r.cum_qty,
    avgFillPrice: r.avg_fill_price,
    closeReason: r.close_reason,
    cancelRequested: (r.cancel_requested ? 1 : 0) as 0 | 1,
    quarantinedStatus: r.quarantined_status,
    venueReason: r.venue_reason,
    readFailStreak: r.read_fail_streak ?? 0,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/** Patchable pair fields (a patch is one small committed transaction). */
/** One finished two-leg deal's realized fills, verbatim journal strings —
 * consumed by the strategy route, which converts to numbers and seconds. */
export interface DealFillReportRow {
  /** The pair row's id — a stable identity for one execution, so the strategy
   * view can address a single deal's contribution to the entry cost. */
  dealId: string;
  aContract: string;
  aSide: string;
  bContract: string;
  bSide: string;
  aFilled: string;
  bFilled: string;
  aAvgFill: string;
  bAvgFill: string;
  createdAtMs: number;
}

export interface PairPatch {
  mode?: PairMode;
  limitPrice?: string | null;
  pricePolicy?: PairRow['pricePolicy'];
  deadlineAt?: number | null;
  makerNotBefore?: number;
  hedgeNotBefore?: number;
  pocRejects?: number;
  hedgeRejectStreak?: number;
  haltReason?: string | null;
  reportJson?: string | null;
}

export interface OrderPatch {
  state?: OrderRow['state'];
  venueOrderId?: string | null;
  cumQty?: string;
  avgFillPrice?: string;
  closeReason?: string | null;
  cancelRequested?: 0 | 1;
  quarantinedStatus?: string | null;
  venueReason?: string | null;
  readFailStreak?: number;
  resolvedAt?: number | null;
}

const PAIR_COLS: Record<keyof PairPatch, string> = {
  mode: 'mode',
  limitPrice: 'limit_price',
  pricePolicy: 'price_policy',
  deadlineAt: 'deadline_at',
  makerNotBefore: 'maker_not_before',
  hedgeNotBefore: 'hedge_not_before',
  pocRejects: 'poc_rejects',
  hedgeRejectStreak: 'hedge_reject_streak',
  haltReason: 'halt_reason',
  reportJson: 'report_json',
};

const ORDER_COLS: Record<keyof OrderPatch, string> = {
  state: 'state',
  venueOrderId: 'venue_order_id',
  cumQty: 'cum_qty',
  avgFillPrice: 'avg_fill_price',
  closeReason: 'close_reason',
  cancelRequested: 'cancel_requested',
  quarantinedStatus: 'quarantined_status',
  venueReason: 'venue_reason',
  readFailStreak: 'read_fail_streak',
  resolvedAt: 'resolved_at',
};

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      // Single-instance guard: the first process owns the file exclusively.
      this.db.exec('PRAGMA locking_mode = EXCLUSIVE');
    }
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent additive migrations for DBs created before a column existed —
   * SQLite has no "ADD COLUMN IF NOT EXISTS", so probe table_info and add when
   * missing. Additive-only: existing rows keep their data. */
  private migrate(): void {
    const orderCols = this.db.prepare(`PRAGMA table_info(orders)`).all() as unknown as { name: string }[];
    if (!orderCols.some((c) => c.name === 'avg_fill_price')) {
      this.db.exec(`ALTER TABLE orders ADD COLUMN avg_fill_price TEXT NOT NULL DEFAULT '0'`);
    }
    if (!orderCols.some((c) => c.name === 'venue_reason')) {
      this.db.exec(`ALTER TABLE orders ADD COLUMN venue_reason TEXT`);
    }
    if (!orderCols.some((c) => c.name === 'read_fail_streak')) {
      this.db.exec(`ALTER TABLE orders ADD COLUMN read_fail_streak INTEGER NOT NULL DEFAULT 0`);
    }
    const pairCols = this.db.prepare(`PRAGMA table_info(pair)`).all() as unknown as { name: string }[];
    if (!pairCols.some((c) => c.name === 'hedge_band_bp')) {
      this.db.exec(`ALTER TABLE pair ADD COLUMN hedge_band_bp INTEGER`);
    }
  }

  close(): void {
    this.db.close();
  }

  createPair(p: PairRow): void {
    this.db
      .prepare(
        `INSERT INTO pair (id, mode,
           a_contract, a_side, a_lot, a_min_size, a_min_notional, a_tick, a_reduce_only,
           b_contract, b_side, b_lot, b_min_size, b_min_notional, b_tick, b_reduce_only,
           target_qty, limit_price, price_policy, deadline_at,
           maker_not_before, hedge_not_before, poc_rejects, hedge_reject_streak,
           max_clip, clip_band_bp, hedge_band_bp, halt_reason, report_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id, p.mode,
        p.a.contract, p.a.side, p.a.lot, p.a.minSize, p.a.minNotional, p.a.tick, p.a.reduceOnly ? 1 : 0,
        p.b?.contract ?? null, p.b?.side ?? null, p.b?.lot ?? null,
        p.b?.minSize ?? null, p.b?.minNotional ?? null, p.b?.tick ?? null, p.b?.reduceOnly ? 1 : 0,
        p.targetQty, p.limitPrice, p.pricePolicy, p.deadlineAt,
        p.makerNotBefore, p.hedgeNotBefore, p.pocRejects, p.hedgeRejectStreak,
        p.maxClip, p.clipBandBp, p.hedgeBandBp, p.haltReason, p.reportJson, p.createdAt,
      );
  }

  getPair(id: string): PairRow | null {
    const r = this.db.prepare('SELECT * FROM pair WHERE id = ?').get(id) as unknown as
      | PairDbRow
      | undefined;
    return r ? toPair(r) : null;
  }

  listPairs(opts?: { activeOnly?: boolean }): PairRow[] {
    const sql = opts?.activeOnly
      ? "SELECT * FROM pair WHERE mode != 'DONE' ORDER BY created_at"
      : 'SELECT * FROM pair ORDER BY created_at';
    return (this.db.prepare(sql).all() as unknown as PairDbRow[]).map(toPair);
  }

  updatePair(id: string, patch: PairPatch): void {
    const keys = Object.keys(patch) as Array<keyof PairPatch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${PAIR_COLS[k]} = ?`).join(', ');
    this.db.prepare(`UPDATE pair SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id);
  }

  /** Allocate the next seq and insert a PENDING order in ONE transaction —
   * the write-ahead reservation. Returns the inserted row.
   *
   * The client text hashes the deal id (FNV-1a → base36):
   * deal ids are client-minted UUIDs (~36 chars) but Gate's order text caps at
   * 28 bytes — 't' + 7-char hash + leg + seq stays ≤ ~11 chars with negligible
   * collision odds, and the text is still deterministic from durable state (the
   * id + seq), which the resolution ladder requires. Gate CrossEx rejects any
   * non-alphanumeric text (TRADE_CLIENT_ORDER_ID_MATCH_ERROR, "Text only support
   * letters and numbers"), so NO separators: 't'+base36 hash+A/B+digits is all
   * letters and numbers, and the uppercase leg marks the hash/seq boundary. */
  insertPendingOrder(o: {
    pairId: string;
    leg: OrderRow['leg'];
    kind: OrderRow['kind'];
    side: OrderRow['side'];
    qty: string;
    price: string | null;
    tif: OrderRow['tif'];
    now: number;
  }): OrderRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM orders WHERE pair_id = ? AND leg = ?')
        .get(o.pairId, o.leg) as unknown as { next: number };
      const clientId = `t${fnv1a36(o.pairId.toLowerCase())}${o.leg}${next}`;
      this.db
        .prepare(
          `INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, price, tif,
             state, cum_qty, cancel_requested, created_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', '0', 0, ?)`,
        )
        .run(o.pairId, o.leg, next, clientId, o.kind, o.side, o.qty, o.price, o.tif, o.now);
      this.db.exec('COMMIT');
      return {
        pairId: o.pairId,
        leg: o.leg,
        seq: next,
        clientId,
        kind: o.kind,
        side: o.side,
        qty: o.qty,
        price: o.price,
        tif: o.tif,
        state: 'PENDING',
        venueOrderId: null,
        cumQty: '0',
        avgFillPrice: '0',
        readFailStreak: 0,
        closeReason: null,
        cancelRequested: 0,
        quarantinedStatus: null,
        venueReason: null,
        createdAt: o.now,
        resolvedAt: null,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listOrders(pairId: string): OrderRow[] {
    return (
      this.db
        .prepare('SELECT * FROM orders WHERE pair_id = ? ORDER BY created_at, leg, seq')
        .all(pairId) as unknown as OrderDbRow[]
    ).map(toOrder);
  }

  /** Find a LIVE engine-owned order by EITHER identifier a caller might hold.
   * The venue accepts our client TEXT on cancel just as it accepts its own
   * numeric id — venueGate.cancel relies on exactly that — so a guard keyed on
   * the venue id alone is bypassable by anyone holding the client text (it
   * rides in /api/deals and in the venue's `text` field on /api/orders/open).
   * NOCASE on the text: if the venue matches it case-insensitively, a
   * case-mangled id must not slip past a BINARY comparison. */
  findLiveEngineOrder(id: string): OrderRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE (venue_order_id = ? OR client_id = ? COLLATE NOCASE)
           AND state IN ('PENDING','OPEN') LIMIT 1`,
      )
      .get(id, id) as unknown as OrderDbRow | undefined;
    return r ? toOrder(r) : null;
  }

  /** True while some live engine order's venue id is still unknown to the
   * ledger (its create returned 'unknown', or the confirming read is still
   * owed). In that window the ledger alone cannot disprove that a venue id
   * handed to us belongs to the engine. */
  hasLiveOrderAwaitingVenueId(): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM orders WHERE venue_order_id IS NULL AND state IN ('PENDING','OPEN') LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  updateOrder(pairId: string, leg: OrderRow['leg'], seq: number, patch: OrderPatch): void {
    const keys = Object.keys(patch) as Array<keyof OrderPatch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${ORDER_COLS[k]} = ?`).join(', ');
    this.db
      .prepare(`UPDATE orders SET ${sets} WHERE pair_id = ? AND leg = ? AND seq = ?`)
      .run(...keys.map((k) => patch[k] as never), pairId, leg, seq);
  }

  /** Quantity-weighted average fill price for a leg — Σ(cum·avg) ÷ Σ(cum) over
   * the leg's ORDER rows, each weighted by its venue-reported cumulative fill and
   * average execution price. This is the price the leg actually executed at
   * across every partial + re-peg (leg A) or every clip (leg B). The venue
   * execution average, not the submitted limit, is the realized fill price.
   * Orders that never filled (cum 0) or lack a venue avg (0) are skipped; null
   * when no order on the leg has a usable fill. A malformed venue price is
   * skipped rather than crashing the fold. */
  avgFillPrice(pairId: string, leg: string): string | null {
    const rows = this.db
      .prepare('SELECT cum_qty, avg_fill_price FROM orders WHERE pair_id = ? AND leg = ?')
      .all(pairId, leg) as unknown as { cum_qty: string; avg_fill_price: string }[];
    let notional = FX_ZERO;
    let qtySum = FX_ZERO;
    for (const r of rows) {
      let cum: bigint;
      let avg: bigint;
      try {
        cum = fx(r.cum_qty);
        avg = fx(r.avg_fill_price);
      } catch {
        continue; // unparseable venue value — leave it out of the average
      }
      if (cum <= FX_ZERO || avg <= FX_ZERO) continue;
      qtySum += cum;
      notional += fxMul(cum, avg);
    }
    if (qtySum === FX_ZERO) return null;
    return fxStr(fxDiv(notional, qtySum));
  }

  /** Finished two-leg deals with both legs' realized fills, for the strategy
   * view's entry-slippage chain. Excluded by SQL: single-leg deals (no gap to
   * speak of) and both-reduce-only deals (those are exits, not entries — a
   * one-reduce/one-open venue migration stays in). Rows whose report_json is
   * missing or unusable are skipped rather than surfaced: the chain's qty
   * reconciliation then fails and the strategy falls back to its honest
   * "unknown" answer — never a wrong sum built on a partial read. */
  dealFillReports(): DealFillReportRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, a_contract, a_side, b_contract, b_side, report_json, created_at FROM pair
         WHERE mode = 'DONE' AND b_contract IS NOT NULL
           AND NOT (a_reduce_only = 1 AND b_reduce_only = 1)
         ORDER BY created_at`,
      )
      .all() as unknown as {
      id: string;
      a_contract: string;
      a_side: string;
      b_contract: string;
      b_side: string;
      report_json: string | null;
      created_at: number;
    }[];
    const out: DealFillReportRow[] = [];
    for (const r of rows) {
      let report: { aFilled?: unknown; bFilled?: unknown; aAvgFill?: unknown; bAvgFill?: unknown };
      try {
        report = JSON.parse(r.report_json ?? '') as typeof report;
      } catch {
        continue;
      }
      const str = (v: unknown): string | null =>
        typeof v === 'string' && Number.isFinite(Number(v)) && Number(v) > 0 ? v : null;
      const aFilled = str(report.aFilled);
      const bFilled = str(report.bFilled);
      const aAvgFill = str(report.aAvgFill);
      const bAvgFill = str(report.bAvgFill);
      if (!aFilled || !bFilled || !aAvgFill || !bAvgFill) continue;
      out.push({
        dealId: r.id,
        aContract: r.a_contract,
        aSide: r.a_side,
        bContract: r.b_contract,
        bSide: r.b_side,
        aFilled,
        bFilled,
        aAvgFill,
        bAvgFill,
        createdAtMs: r.created_at,
      });
    }
    return out;
  }

  alert(
    level: AlertRow['level'],
    pairId: string | null,
    message: string,
    now: number,
    opts?: { once?: boolean },
  ): void {
    // Deduplicate identical unacked alerts: alerts are LEVELS the UI re-renders,
    // not events — one row per distinct standing condition. `once` also dedupes
    // against ACKED rows (one-time notices like the legacy migration guard must not
    // re-nag after every restart).
    const existing = this.db
      .prepare(
        opts?.once
          ? 'SELECT id FROM alerts WHERE pair_id IS ? AND message = ?'
          : 'SELECT id FROM alerts WHERE ack = 0 AND pair_id IS ? AND message = ?',
      )
      .get(pairId, message);
    if (existing) return;
    this.db
      .prepare('INSERT INTO alerts (ts, level, pair_id, message, ack) VALUES (?,?,?,?,0)')
      .run(now, level, pairId, message);
  }

  listAlerts(opts?: { unackedOnly?: boolean }): AlertRow[] {
    const sql = opts?.unackedOnly
      ? 'SELECT * FROM alerts WHERE ack = 0 ORDER BY id'
      : 'SELECT * FROM alerts ORDER BY id';
    return this.db.prepare(sql).all() as unknown as AlertRow[];
  }

  ackAlert(id: number): void {
    this.db.prepare('UPDATE alerts SET ack = 1 WHERE id = ?').run(id);
  }
}
