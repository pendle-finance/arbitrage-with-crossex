/**
 * Splitting one venue's leg across several strategies.
 *
 * A venue nets: CrossEx reports ONE position row per (venue, symbol) with a
 * single blended entry price, one cumulative fee and one open time, and Boros
 * reports ONE position per market with a single blended fixed APR. So a book
 * holding two strategies at once — say HL/OKX and HL/Binance on ETH — arrives
 * as three perp rows and three Boros positions with no marker saying which
 * part of the shared HL leg belongs to which strategy.
 *
 * The tranches DO exist, in the execution record: the local deal journal and
 * the venue's own fill history (whose `text` carries this engine's client id,
 * so a fill rejoins its deal even when the journal is gone). This module
 * rebuilds them from that record, and only guesses when no record explains the
 * book — and says so when it does.
 *
 * Doctrine, in order:
 *  1. Perps anchor. A perp long implies a real counterpart; a Boros leg can be
 *     a standalone directional trade, so it cannot anchor the matching.
 *  2. Match INDIVIDUAL positions, never a venue's net — otherwise a 3-venue
 *     ring (HL/Binance + HL/OKX + Binance/OKX) nets every venue to zero and
 *     disappears.
 *  3. Closes are FIFO, which is why the walk below runs NEWEST FIRST: if the
 *     oldest tranche is the first to be closed, whatever is still open is
 *     composed of the most recent opens. No close simulation needed.
 *  4. Where nothing explains a residual, pair it by price/time proximity and
 *     mark it `unconfirmed` — never present a guess as a measurement.
 */
import { norm18, type BorosTxn } from './client';

/** One live perp position, already normalized by the returns layer. */
export interface PerpLegSnapshot {
  symbol: string;
  venue: string;
  base: string;
  side: 'LONG' | 'SHORT';
  /** Absolute base-coin quantity. */
  qty: number;
  /** The venue's blended entry price (0 when unknown). */
  entryPrice: number;
  openedAtSec: number | null;
}

/** One fill from the venue's history. `text` is the client order id — this
 * engine writes `t{hash}{leg}{seq}`, which is how a fill rejoins its deal. */
export interface PerpFillRecord {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  /** Per-fill trading fee as a POSITIVE cost. */
  feeUsd: number;
  timeSec: number;
  text: string;
}

/** One finished two-leg deal from the local journal (shaped by the route). */
export interface DealFillRecord {
  dealId: string;
  aContract: string;
  aSide: 'BUY' | 'SELL';
  bContract: string;
  bSide: 'BUY' | 'SELL';
  aFilled: number;
  bFilled: number;
  aAvgFill: number;
  bAvgFill: number;
  createdAtSec: number;
}

/**
 * One live leg, named the way its VENUE names it.
 *
 * ⚠ Not `(base, venue[, maturity])`. Binance lists ETH under both USDT and
 * USDC, so venue+base names two different perp positions; Boros lists the same
 * Hyperliquid BTC market in a BTC zone and a USDT zone, so venue+base+maturity
 * is ambiguous there too. A perp symbol and a Boros marketId each name exactly
 * one position, and both are already on the rows the server reads — which is
 * also what lets a stale assertion be DETECTED, by looking for the leg it
 * names and not finding it.
 */
export type LegRef =
  | { kind: 'perp'; symbol: string }
  | { kind: 'boros'; marketId: number };

export const legRefKey = (l: LegRef): string =>
  l.kind === 'perp' ? `perp:${l.symbol}` : `boros:${l.marketId}`;

/**
 * A user's assertion that one leg belongs to one position.
 *
 * ⚠ THIS NAMES A LEG, NOT A GROUPING, and that is the whole point. The pins
 * this replaces were keyed by `(base, longVenue, shortVenue)` — the shape of a
 * grouping — so they could not be checked against anything, could not survive
 * the grouping changing, and could not express two strategies on one venue
 * pair at all (the key collides, and the decoder deduped it on purpose).
 *
 * A position that has ANY rows is exactly its rows: the solver proposes
 * nothing into it. That makes "detach" mean simply deleting a row, rather than
 * asserting a size of zero and hoping the solver agrees.
 */
export interface MembershipRow {
  /**
   * The position this leg belongs to — an opaque minted id, never derived from
   * the legs, so it survives a re-pair, a venue swap or a maturity roll.
   *
   * ABSENT means the leg belongs to no position at all: the solver must not
   * group it, and it is reported as unhedged. That is the old qty-0 detach.
   */
  positionId?: string;
  leg: LegRef;
  /** How much of the leg. Absent = all of it that no other row claims. */
  qty?: number;
  /**
   * What this position asserts it actually PAID for its share — a price for a
   * perp, an APR fraction for a Boros leg. Absent = it has not said, and takes
   * whatever balances the venue's own blended entry.
   *
   * ⚠ The venue's average is never restated by this: it is ground truth over
   * the whole position, and an assertion only divides it. Claims that have not
   * asserted absorb the difference — see `applyEntryAssertions`.
   */
  entry?: number;
}

export type TrancheSource = 'journal' | 'fill-history' | 'forced' | 'proximity' | 'user';
export type TrancheConfidence = 'measured' | 'unconfirmed';

export interface TrancheLeg {
  symbol: string;
  venue: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  /** This tranche's OWN entry price. Null when no execution record explains
   * it — the strategy then reports null slippage rather than splitting the
   * venue's blended entry, which would be a fabrication. */
  entryPrice: number | null;
  /** Exact per-fill fees when the fill history covers this tranche; null means
   * the caller must fall back to a pro-rata split of the venue's cumulative
   * fee. */
  feesUsd: number | null;
  /** qty / live position qty — the pro-rata weight for every shared number. */
  share: number;
  /** True when ANOTHER strategy also holds part of this venue position. Only
   * then is the venue's blended entry price ambiguous, and only then is its
   * `createTime` (the first tranche's open) the wrong open for this one. */
  shared: boolean;
}

export interface PerpTranche {
  id: string;
  base: string;
  qty: number;
  long: TrancheLeg;
  short: TrancheLeg;
  openedAtSec: number | null;
  source: TrancheSource;
  confidence: TrancheConfidence;
  pinned: boolean;
  executionIds: string[];
}

/** Live size no tranche could claim: a genuinely unhedged leg. */
export interface UnhedgedResidual {
  symbol: string;
  venue: string;
  base: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  share: number;
}

export interface PerpPartition {
  tranches: PerpTranche[];
  residuals: UnhedgedResidual[];
  /** False when the split does not reconcile to the venue-reported sizes; the
   * caller must then fall back to the merged view rather than display it. */
  reconciled: boolean;
  notes: string[];
}

export interface SolvePartitionInput {
  positions: PerpLegSnapshot[];
  fills?: PerpFillRecord[] | null;
  deals?: DealFillRecord[] | null;
}

/** Relative tolerance for every quantity comparison. Absolute epsilons break on
 * a 20,000-unit book; lot dust is always relative. */
const QTY_BAND = 1e-6;

/** Two partitions whose scores sit within this band of each other are not
 * meaningfully distinguishable — the winner is reported `unconfirmed`. */
const SCORE_TIE_BAND = 0.15;

/** Time normalizer for the proximity score: the engine hedges each fill within
 * seconds, so a quarter-hour is already "a different execution". Matches
 * PERP_ENTRY_SYNC_MAX_SEC in returns.ts on purpose. */
export const TIME_SCALE_SEC = 15 * 60;

/** Relative weights of the two proximity terms. Both are dimensionless (see
 * proximityScore), so tuning them against real books is a one-line change
 * here — the only place the objective is defined. */
const PRICE_WEIGHT = 1;
const TIME_WEIGHT = 1;

/** FNV-1a → base36, mirroring src/engine/db.ts's order-text hash. Duplicated
 * rather than imported: core must not depend on the engine layer. */
function fnv1a36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

/** `t{7-char pair hash}{A|B}{seq}` — this engine's client order id. */
const ENGINE_TEXT_RE = /^t([0-9a-z]{7})[AB]\d+$/;

interface ExecLeg {
  symbol: string;
  qty: number;
  price: number;
  feeUsd: number | null;
}

/** One execution that opened (or reduced) two opposing legs together. Both
 * fills are contemporaneous by construction, so the gap between their prices
 * is crossing cost — never market drift. */
interface Execution {
  id: string;
  timeSec: number;
  source: 'journal' | 'fill-history';
  long: ExecLeg;
  short: ExecLeg;
}

/** Fill history → executions, grouped by the engine's pair hash. Untagged
 * fills (Gate's web UI, other clients) carry no joinable id and are left to
 * the proximity tier rather than clustered on a guess. */
function executionsFromFills(fills: readonly PerpFillRecord[]): Map<string, Execution> {
  const groups = new Map<string, PerpFillRecord[]>();
  for (const f of fills) {
    const m = ENGINE_TEXT_RE.exec(f.text ?? '');
    if (!m || !(f.qty > 0) || !(f.price > 0)) continue;
    const list = groups.get(m[1]) ?? [];
    list.push(f);
    groups.set(m[1], list);
  }
  const out = new Map<string, Execution>();
  for (const [hash, rows] of groups) {
    const perSide = new Map<string, { symbol: string; side: 'BUY' | 'SELL'; qty: number; notional: number; fee: number }>();
    for (const r of rows) {
      const key = `${r.symbol}/${r.side}`;
      const agg = perSide.get(key) ?? { symbol: r.symbol, side: r.side, qty: 0, notional: 0, fee: 0 };
      agg.qty += r.qty;
      agg.notional += r.qty * r.price;
      agg.fee += Math.abs(r.feeUsd);
      perSide.set(key, agg);
    }
    const sides = [...perSide.values()];
    const buys = sides.filter((s) => s.side === 'BUY');
    const sells = sides.filter((s) => s.side === 'SELL');
    // One BUY symbol against one SELL symbol is a hedged execution. Anything
    // else (a single-leg close, a same-side pair) is not a tranche.
    if (buys.length !== 1 || sells.length !== 1) continue;
    const [b] = buys;
    const [s] = sells;
    const qty = Math.min(b.qty, s.qty);
    if (!(qty > 0)) continue;
    const scale = (agg: typeof b): ExecLeg => ({
      symbol: agg.symbol,
      qty,
      price: agg.notional / agg.qty,
      // Fees are for the whole leg; charge this tranche its filled share.
      feeUsd: (agg.fee * qty) / agg.qty,
    });
    out.set(hash, {
      id: `fill:${hash}`,
      timeSec: Math.min(...rows.map((r) => r.timeSec)),
      source: 'fill-history',
      long: scale(b),
      short: scale(s),
    });
  }
  return out;
}

/** Journal deals → executions. Used for deals the fill history could not
 * cover; fill history wins where both know a deal, because it carries fees. */
function executionsFromDeals(
  deals: readonly DealFillRecord[],
  covered: ReadonlySet<string>,
): Execution[] {
  const out: Execution[] = [];
  for (const d of deals) {
    if (d.aSide === d.bSide) continue;
    if (covered.has(fnv1a36(d.dealId.toLowerCase()))) continue;
    const qty = Math.min(d.aFilled, d.bFilled);
    if (!(qty > 0) || !(d.aAvgFill > 0) || !(d.bAvgFill > 0)) continue;
    const buy = d.aSide === 'BUY' ? { symbol: d.aContract, price: d.aAvgFill } : { symbol: d.bContract, price: d.bAvgFill };
    const sell = d.aSide === 'BUY' ? { symbol: d.bContract, price: d.bAvgFill } : { symbol: d.aContract, price: d.aAvgFill };
    out.push({
      id: `journal:${d.dealId}`,
      timeSec: d.createdAtSec,
      source: 'journal',
      long: { ...buy, qty, feeUsd: null },
      short: { ...sell, qty, feeUsd: null },
    });
  }
  return out;
}

const pairKey = (a: string, b: string): string => [a, b].sort().join('|');

interface AccSide {
  symbol: string;
  qty: number;
  notional: number;
  fee: number;
  feeKnown: boolean;
  /** True when any part of this side's price came from the VENUE's blended
   * entry rather than from an execution. A blend is only this tranche's own
   * price when the tranche is the whole position — see legOf. */
  blended: boolean;
}

interface Accumulator {
  long: AccSide;
  short: AccSide;
  openedAtSec: number | null;
  source: TrancheSource;
  executionIds: string[];
}

/**
 * Rebuild the tranches that compose the live perp book.
 *
 * The result always reconciles: every tranche leg's quantity is taken out of a
 * live position's remaining size, and whatever is left over is reported as an
 * unhedged residual rather than dropped.
 */
export function solvePerpPartition(input: SolvePartitionInput): PerpPartition {
  const notes: string[] = [];

  const bySymbol = new Map<string, PerpLegSnapshot>();
  const remaining = new Map<string, number>();
  for (const p of input.positions) {
    if (!(p.qty > 0)) continue;
    bySymbol.set(p.symbol, p);
    remaining.set(p.symbol, (remaining.get(p.symbol) ?? 0) + p.qty);
  }

  const fillExecs = executionsFromFills(input.fills ?? []);
  const execs = [
    ...fillExecs.values(),
    ...executionsFromDeals(input.deals ?? [], new Set(fillExecs.keys())),
  ]
    // Newest first: FIFO closes mean the live book is the most recent opens.
    .sort((a, b) => b.timeSec - a.timeSec);

  const accs = new Map<string, Accumulator>();

  const legSide = (symbol: string): 'LONG' | 'SHORT' | null => bySymbol.get(symbol)?.side ?? null;
  const take = (symbol: string, want: number): number => {
    const left = remaining.get(symbol) ?? 0;
    const got = Math.min(left, want);
    if (got <= 0) return 0;
    remaining.set(symbol, left - got);
    return got;
  };

  /**
   * The accumulator one execution joins.
   *
   * Every execution on a venue pair lands in the SAME bucket. The spec pairs
   * positions, not fills — "take the best pair, size it min(qtyLong,
   * qtyShort), decrement both, repeat" — so a venue pair yields one tranche,
   * and a position's size splits across the several PAIRS it hedges, never
   * across time on one pair.
   *
   * `auto` is its own bucket: the proximity pass resolves one residual per
   * pair, and must not be folded into the executions it could not explain.
   */
  const accKey = (longSymbol: string, shortSymbol: string, bucket: string): string =>
    `${longSymbol}>${shortSymbol}#${bucket}`;
  /** Executions on one venue pair are one strategy being filled. */
  const EXEC_BUCKET = 'exec';
  /**
   * Where the proximity pass puts what no execution explained.
   *
   * A book part-built on the journal and part off it (a venue migration whose
   * old legs are gone, a top-up) is ONE strategy: its unexplained size belongs
   * with the execution tranche, not beside it.
   */
  const residualBucket = (longSymbol: string, shortSymbol: string): string => {
    const prefix = `${longSymbol}>${shortSymbol}#`;
    const existing = [...accs.keys()].filter((k) => k.startsWith(prefix));
    return existing.length === 1 ? existing[0].slice(prefix.length) : 'auto';
  };
  const accumulate = (
    longSymbol: string,
    shortSymbol: string,
    qty: number,
    long: { price: number | null; feeUsd: number | null },
    short: { price: number | null; feeUsd: number | null },
    timeSec: number | null,
    source: TrancheSource,
    bucket: string,
    execId?: string,
    blended = false,
  ): void => {
    const key = accKey(longSymbol, shortSymbol, bucket);
    const acc = accs.get(key) ?? {
      long: { symbol: longSymbol, qty: 0, notional: 0, fee: 0, feeKnown: true, blended: false },
      short: { symbol: shortSymbol, qty: 0, notional: 0, fee: 0, feeKnown: true, blended: false },
      openedAtSec: null,
      source,
      executionIds: [],
    };
    const add = (side: AccSide, px: number | null, fee: number | null) => {
      if (blended) side.blended = true;
      side.qty += qty;
      // A null price poisons the tranche's average: without every part's price
      // the gap is not this tranche's crossing cost. Track it as unknown.
      if (px === null || !(px > 0)) side.notional = Number.NaN;
      else side.notional += px * qty;
      if (fee === null) side.feeKnown = false;
      else side.fee += fee;
    };
    add(acc.long, long.price, long.feeUsd);
    add(acc.short, short.price, short.feeUsd);
    if (timeSec !== null && timeSec > 0) {
      acc.openedAtSec = acc.openedAtSec === null ? timeSec : Math.min(acc.openedAtSec, timeSec);
    }
    // A tranche assembled from several sources reports the weakest one.
    if (source === 'proximity' || acc.source === 'proximity') acc.source = 'proximity';
    else if (source === 'user' || acc.source === 'user') acc.source = 'user';
    if (execId) acc.executionIds.push(execId);
    accs.set(key, acc);
  };

  // --- 2. Executions, newest first.
  for (const e of execs) {
    if (!(e.long.qty > 0)) continue;
    const longSym = e.long.symbol;
    const shortSym = e.short.symbol;
    // The execution's directions must match how the book is actually held: a
    // deal that BOUGHT a venue we are now short of was a close, not an open.
    if (legSide(longSym) !== 'LONG' || legSide(shortSym) !== 'SHORT') continue;
    const q = Math.min(e.long.qty, remaining.get(longSym) ?? 0, remaining.get(shortSym) ?? 0);
    if (!(q > 0)) continue;
    take(longSym, q);
    take(shortSym, q);
    accumulate(
      longSym,
      shortSym,
      q,
      { price: e.long.price, feeUsd: scaleFee(e.long.feeUsd, q, e.long.qty) },
      { price: e.short.price, feeUsd: scaleFee(e.short.feeUsd, q, e.short.qty) },
      e.timeSec,
      e.source === 'journal' ? 'journal' : 'fill-history',
      EXEC_BUCKET,
      e.id,
    );
  }

  /**
   * What the still-unexplained size of a leg must have been entered at.
   *
   * The venue reports ONE average over the whole position. Where executions
   * already explain part of it at known prices, the rest is
   * `(blend × liveQty − explainedNotional) / (liveQty − explainedQty)`; only
   * when nothing is explained is the blend itself the answer. Null when the
   * arithmetic cannot stand (no venue price, or an implied price ≤ 0, which
   * means the explained part does not belong to this position).
   */
  const impliedRemainderPrice = (live: PerpLegSnapshot, qty: number): number | null => {
    if (!(live.entryPrice > 0)) return null;
    let explainedQty = 0;
    let explainedNotional = 0;
    for (const acc of accs.values()) {
      for (const side of [acc.long, acc.short]) {
        if (side.symbol !== live.symbol || !(side.qty > 0)) continue;
        if (!Number.isFinite(side.notional)) return null; // an unpriced part poisons the average
        explainedQty += side.qty;
        explainedNotional += side.notional;
      }
    }
    if (!(explainedQty > 0)) return live.entryPrice;
    const rest = live.qty - explainedQty;
    if (!(rest > 0) || !(rest + QTY_BAND >= qty)) return null;
    const implied = (live.entryPrice * live.qty - explainedNotional) / rest;
    return implied > 0 ? implied : null;
  };

  // --- 3. Proximity over what no execution explained.
  const residualLongs = [...bySymbol.values()].filter(
    (p) => p.side === 'LONG' && (remaining.get(p.symbol) ?? 0) > 0,
  );
  const residualShorts = [...bySymbol.values()].filter(
    (p) => p.side === 'SHORT' && (remaining.get(p.symbol) ?? 0) > 0,
  );
  // A single long against a single short is a FORCED pairing, not a guess:
  // there is no other partition to choose. That keeps the ordinary two-leg
  // book `measured` even with no execution record at all.
  // Per BASE: one long against one short of the SAME coin is forced. Judged
  // across the whole book it would call a BTC-long/ETH-short pairing forced.
  const countsByBase = new Map<string, { long: number; short: number }>();
  for (const p of [...residualLongs, ...residualShorts]) {
    const c = countsByBase.get(p.base) ?? { long: 0, short: 0 };
    if (p.side === 'LONG') c.long += 1;
    else c.short += 1;
    countsByBase.set(p.base, c);
  }
  const isForced = (base: string): boolean => {
    const c = countsByBase.get(base);
    return c !== undefined && c.long === 1 && c.short === 1;
  };
  // Per BASE, not global: a near-tie only puts THAT coin's residual pairings
  // in doubt. One flag for the whole solve would let an unrelated tie
  // downgrade tranches proven by the journal or fill history — a factually
  // wrong "matched by proximity" label on execution-backed cards.
  const ambiguousBases = new Set<string>();
  while (true) {
    const candidates: Array<{ long: PerpLegSnapshot; short: PerpLegSnapshot; score: number }> = [];
    for (const lo of residualLongs) {
      if (!((remaining.get(lo.symbol) ?? 0) > 0)) continue;
      for (const sh of residualShorts) {
        if (!((remaining.get(sh.symbol) ?? 0) > 0)) continue;
        // Never across coins: an ETH short does not hedge a BTC long, and the
        // score would happily pair them when nothing better is left.
        if (lo.base !== sh.base) continue;
        candidates.push({ long: lo, short: sh, score: proximityScore(lo, sh) });
      }
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    // Deliberately NOT minimising the price gap alone: an objective that only
    // sought the closest prices would be selecting for the answer that makes
    // slippage look smallest.
    //
    // A tie only exists between ALTERNATIVES for the same legs, so the rival
    // must share the best candidate's base — candidates never pair across
    // coins, so a similar score in a DIFFERENT base is not a competing
    // partition of anything.
    const rival = candidates.find((c, i) => i > 0 && c.long.base === best.long.base);
    if (rival && rival.score - best.score <= SCORE_TIE_BAND * Math.max(best.score, 1e-9)) {
      ambiguousBases.add(best.long.base);
    }
    const q = Math.min(remaining.get(best.long.symbol) ?? 0, remaining.get(best.short.symbol) ?? 0);
    if (!(q > 0)) break;
    take(best.long.symbol, q);
    take(best.short.symbol, q);
    const opens = [best.long.openedAtSec, best.short.openedAtSec].filter(
      (t): t is number => t !== null && t > 0,
    );
    accumulate(
      best.long.symbol,
      best.short.symbol,
      q,
      // NOT the venue's blended entry: that average already contains whatever
      // fills the execution pass explained, so handing it to the remainder
      // counts those fills twice. What is left must be priced at the implied
      // remainder — the blend with the explained part backed out.
      { price: impliedRemainderPrice(best.long, q), feeUsd: null },
      { price: impliedRemainderPrice(best.short, q), feeUsd: null },
      opens.length ? Math.min(...opens) : null,
      isForced(best.long.base) ? 'forced' : 'proximity',
      residualBucket(best.long.symbol, best.short.symbol),
      undefined,
      true,
    );
  }

  // --- Assemble.
  // How many tranches claim each venue leg. A blended entry price is only
  // ambiguous when the leg is SHARED: if one tranche owns it (the rest being
  // simply unhedged), the venue's average is that tranche's entry.
  const trancheCountBySymbol = new Map<string, number>();
  for (const acc of accs.values()) {
    if (!(acc.long.qty > 0)) continue;
    for (const sym of [acc.long.symbol, acc.short.symbol]) {
      trancheCountBySymbol.set(sym, (trancheCountBySymbol.get(sym) ?? 0) + 1);
    }
  }
  const tranches: PerpTranche[] = [];
  for (const [key, acc] of accs) {
    if (!(acc.long.qty > 0)) continue;
    const lo = bySymbol.get(acc.long.symbol);
    const sh = bySymbol.get(acc.short.symbol);
    if (!lo || !sh) continue;
    const liveLong = lo.qty;
    const liveShort = sh.qty;
    // Per TRANCHE, not per pair: the sibling the solver matched around a pin
    // is not itself pinned, and must not claim to be.
    const pinned = key.endsWith('#pin');
    const measured =
      acc.source === 'journal' || acc.source === 'fill-history' || acc.source === 'forced';
    tranches.push({
      id: trancheId(lo.base, lo.venue, sh.venue, key),
      base: lo.base,
      qty: acc.long.qty,
      long: legOf(lo, acc.long, liveLong, (trancheCountBySymbol.get(acc.long.symbol) ?? 1) > 1),
      short: legOf(sh, acc.short, liveShort, (trancheCountBySymbol.get(acc.short.symbol) ?? 1) > 1),
      openedAtSec: acc.openedAtSec,
      source: acc.source,
      // A near-tie means the solver had to choose between partitions that
      // scored alike — the pairing may be measured-by-construction (`forced`)
      // and still be the wrong one, so the tie downgrades it. Only tranches
      // the residual solver produced, and only in the tied base: a
      // journal/fill-history tranche was never part of that choice.
      confidence:
        measured &&
        !(
          (acc.source === 'forced' || acc.source === 'proximity') &&
          ambiguousBases.has(lo.base)
        )
          ? 'measured'
          : 'unconfirmed',
      pinned,
      executionIds: acc.executionIds,
    });
  }
  tranches.sort((a, b) => (b.openedAtSec ?? 0) - (a.openedAtSec ?? 0) || b.qty - a.qty);

  const residuals: UnhedgedResidual[] = [];
  for (const [symbol, left] of remaining) {
    const p = bySymbol.get(symbol);
    if (!p || !(left > QTY_BAND * p.qty)) continue;
    residuals.push({
      symbol,
      venue: p.venue,
      base: p.base,
      side: p.side,
      qty: left,
      share: left / p.qty,
    });
  }

  // --- Reconciliation: every venue's size must be fully accounted for.
  let reconciled = true;
  for (const p of bySymbol.values()) {
    let claimed = 0;
    for (const t of tranches) {
      if (t.long.symbol === p.symbol) claimed += t.long.qty;
      if (t.short.symbol === p.symbol) claimed += t.short.qty;
    }
    for (const r of residuals) if (r.symbol === p.symbol) claimed += r.qty;
    if (Math.abs(claimed - p.qty) > QTY_BAND * Math.max(p.qty, 1)) reconciled = false;
  }
  if (!reconciled) {
    notes.push(
      'The per-strategy split does not add back up to the venue-reported position sizes — showing the combined position instead.',
    );
  }
  return { tranches, residuals, reconciled, notes };
}

function scaleFee(fee: number | null, q: number, total: number): number | null {
  if (fee === null || !(total > 0)) return null;
  return (fee * q) / total;
}

function legOf(
  live: PerpLegSnapshot,
  acc: AccSide,
  liveQty: number,
  shared: boolean,
): TrancheLeg {
  const share = liveQty > 0 ? acc.qty / liveQty : 0;
  // On a leg SHARED by several strategies the venue's blended entry is an
  // average across them, and handing it to each would invent a crossing cost.
  // The strategy reports null slippage instead of a plausible number.
  const priceKnown = Number.isFinite(acc.notional) && acc.qty > 0 && !(acc.blended && shared);
  return {
    symbol: live.symbol,
    venue: live.venue,
    side: live.side,
    qty: acc.qty,
    entryPrice: priceKnown ? acc.notional / acc.qty : null,
    feesUsd: acc.feeKnown ? acc.fee : null,
    share,
    shared,
  };
}

/** Normalized so the weights are dimensionless: price gap as a fraction of
 * mid, open gap in units of TIME_SCALE_SEC. Unknown open times score as one
 * full time unit apart — worse than contemporaneous, better than a day. */
function proximityScore(lo: PerpLegSnapshot, sh: PerpLegSnapshot): number {
  const mid = (lo.entryPrice + sh.entryPrice) / 2;
  const priceTerm = mid > 0 ? Math.abs(lo.entryPrice - sh.entryPrice) / mid : 0;
  const timeTerm =
    lo.openedAtSec !== null && sh.openedAtSec !== null
      ? Math.abs(lo.openedAtSec - sh.openedAtSec) / TIME_SCALE_SEC
      : 1;
  return PRICE_WEIGHT * priceTerm + TIME_WEIGHT * timeTerm;
}

/**
 * One tranche's identity: the venue pair plus the accumulator it came from.
 *
 * The accumulator key is what actually distinguishes two tranches on one pair
 * (an execution bucket, `pin`, or `auto`), so naming it here makes collisions
 * impossible — an id derived from the open DAY would let a residual tranche
 * and an execution tranche opened the same day share one id, and with it one
 * Boros rate, one React key and one set of excluded entry-cost parts.
 *
 * It is stable while the evidence is: a tranche re-solved from the same fills
 * keeps its bucket. When the fill history is unavailable the same size may
 * resolve into a different tranche set, and the id moves with it — that is
 * inherent to identifying something by how it was measured.
 */
function trancheId(base: string, longVenue: string, shortVenue: string, accKey: string): string {
  const venues = [longVenue, shortVenue].sort().join('-');
  return `${base}#${venues}#${accKey.slice(accKey.indexOf('#') + 1)}`;
}

// ---------------------------------------------------------------------------
// Boros side
// ---------------------------------------------------------------------------

/** One opening (or increasing) Boros fill that is still part of the live
 * position, with the rate it actually traded at. */
export interface BorosIncrement {
  timeSec: number;
  /** Token-unit size, absolute. */
  qty: number;
  fixedApr: number;
}

/**
 * The live Boros position, decomposed into the fills that built it.
 *
 * Verified against the venue: replaying the fills as a notional-weighted
 * running average of `fixedApr` reproduces the API's own `entryApr` on every
 * reducing fill (117/117 rows on a live account, worst delta 2.5e-16). So the
 * blended rate a position reports is exactly this average — which means it can
 * be taken apart again, and each strategy can keep the rate it actually
 * locked instead of the book's blend.
 *
 * ⚠ NOT the perp side's FIFO. A partial close SCALES every open rather than
 * dropping the oldest — see the note at the end of the function: the venue
 * does not re-average on a reduce, so the survivor still carries the blend of
 * all its opens, and dropping oldest-first would report a rate it never
 * charged.
 * Returns null when the history cannot explain the live size.
 */
export function borosIncrements(
  txns: readonly BorosTxn[],
  marketId: number,
  liveSize: number,
): BorosIncrement[] | null {
  const target = Math.abs(liveSize);
  if (!(target > 0)) return null;
  const byTime = txns
    .filter((t) => t.marketId === marketId)
    .slice()
    .sort((a, b) => a.time - b.time);
  if (!byTime.length) return null;

  // `time` collides whenever one order fills across several book levels, and a
  // close plus its re-open can share a second too — so within a timestamp the
  // rows must be CHAINED, each one starting where the last ended, not sorted
  // by size in either direction. Getting this wrong scrambles a multi-level
  // fill and mis-weights the rates it traded at.
  const forMarket: BorosTxn[] = [];
  const links = (t: BorosTxn, from: number): boolean =>
    Math.abs(norm18(t.prevPositionS) - from) <= 1e-9 * Math.max(1, Math.abs(from));
  let chain = Number.NaN; // no position established yet — the first group seeds it
  for (let i = 0; i < byTime.length; ) {
    let j = i;
    while (j < byTime.length && byTime[j].time === byTime[i].time) j += 1;
    const group = byTime.slice(i, j);
    // Where this second starts: normally where the last one ended. At the head
    // of the history (or across a gap) find it inside the group instead — the
    // row whose `prev` no other row in the group produced.
    if (!group.some((t) => links(t, chain))) {
      const posts = group.map((t) => norm18(t.postPositionS));
      const head = group.find((t) => !posts.some((p) => links(t, p)));
      chain = norm18((head ?? group[0]).prevPositionS);
    }
    while (group.length) {
      const at = group.findIndex((t) => links(t, chain));
      const [next] = group.splice(at >= 0 ? at : 0, 1);
      forMarket.push(next);
      chain = norm18(next.postPositionS);
    }
    i = j;
  }

  // Replay the whole chain, keeping only the fills that built the position as
  // it stands now. Two events wipe the slate: a return to flat, and a FLIP
  // through zero (one fill that closes one side and opens the other, which the
  // venue really does report — tradeDirection 2). A flip's opening size is the
  // WHOLE new side, not post − prev, and everything before it belonged to the
  // side that was closed.
  const opens: BorosIncrement[] = [];
  let running = 0;
  let avg = 0;
  for (const t of forMarket) {
    const prev = norm18(t.prevPositionS);
    const post = norm18(t.postPositionS);
    const apr = t.fixedApr;
    // The venue states the average entry of the position being reduced. Our
    // replay must reproduce it; where it doesn't, the history is not the one
    // that built this position (a gap, an unmodelled event) and a per-strategy
    // rate would be a confident guess. Fall back to the blended rate instead.
    if (t.entryApr !== undefined && running !== 0 && Math.abs(avg - t.entryApr) > 1e-6) return null;
    const grew = Math.abs(post) > Math.abs(prev);
    const flipped = prev !== 0 && post !== 0 && Math.sign(post) !== Math.sign(prev);
    if (post === 0) {
      opens.length = 0;
      running = 0;
      avg = 0;
      continue;
    }
    if (!grew && !flipped) {
      running = post; // a plain reduce: size shrinks, the average does not move
      continue;
    }
    if (!Number.isFinite(apr)) return null; // no usable rate — cannot tranche
    if (flipped) {
      opens.length = 0;
      opens.push({ timeSec: t.time, qty: Math.abs(post), fixedApr: apr });
      avg = apr;
    } else {
      const added = Math.abs(post) - Math.abs(prev);
      opens.push({ timeSec: t.time, qty: added, fixedApr: apr });
      avg = (Math.abs(prev) * avg + added * apr) / Math.abs(post);
    }
    running = post;
  }
  if (!opens.length) return null;

  // Scale every open to the size still held, rather than keeping the newest
  // and dropping the oldest.
  //
  // A reduce does NOT re-average the venue's rate — the replay above proves
  // it, and the cross-check would fail if it did — so the position that
  // survives a partial close still carries the blend of ALL its opens.
  // Keeping only the newest would hand a strategy a rate the venue never
  // charged (open 100 @9% then 200 @5%, reduce to 200 → the venue says 6.33%,
  // newest-first says 5%). Scaling by one factor leaves the weighted average
  // untouched, so the per-strategy rates still decompose the venue's number.
  const openTotal = opens.reduce((s, o) => s + o.qty, 0);
  if (!(openTotal > 0) || openTotal + QTY_BAND * target < target) return null;
  const factor = target / openTotal;
  return opens.map((o) => ({ ...o, qty: o.qty * factor }));
}

/**
 * Divide ONE Boros leg between the strategies that could hold it, anchored on
 * the Boros fills themselves.
 *
 * ⚠ THIS IS THE INVERSE OF SIZING BOROS PRO-RATA TO PERP, and the inversion is
 * the point. A perp position is FUNGIBLE: one netted short, no maturity, one
 * funding stream — "which part of it" is pure accounting. A Boros leg is not.
 * It carries a maturity, a locked rate and a fill record, so identity lives on
 * this side, and the fungible side is what should be divided to cover it.
 * Sizing the identity-bearing side by the fungible one is what hands a
 * half-built strategy notional it never traded and leaves BOTH cards reading
 * as partly hedged.
 *
 * Greedy on evidence: repeatedly take the (strategy, fill) pair whose open
 * times are closest, and give that strategy as much of that fill as it can
 * absorb. `demand` caps a strategy at the perp exposure it actually has to
 * hedge — past that, more Boros is not covering anything of its.
 *
 * Deliberately NOT a fixed oldest-first service order. That would be a fair
 * tie-break when only a RATE is being attributed, but for NOTIONAL it lets the
 * oldest strategy take a fill that plainly belongs to a newer one — which is
 * exactly how a perp pair opened weeks later ends up owning a third of a Boros
 * leg it never traded.
 */
export function allocateBorosByEvidence(
  increments: readonly BorosIncrement[],
  targets: ReadonlyArray<{ id: string; demand: number; openedAtSec: number | null }>,
): Map<string, { qty: number; fixedApr: number | null }> {
  const pool = increments.map((i) => ({ ...i }));
  // Stable order so equal gaps resolve the same way every solve: earlier open
  // first, then the LARGER claim, then id.
  //
  // Demand breaks the tie ahead of the id because a shared venue leg's own
  // `createTime` is its FIRST tranche's open — so without a fill record every
  // tranche on it can end up reporting the same open time. On that tie the
  // strategy that can absorb more of the leg is the better match, and it stops
  // a sliver of leftover capacity taking the first bite of a leg it barely
  // overlaps.
  const ordered = [...targets].sort(
    (a, b) =>
      (a.openedAtSec ?? 0) - (b.openedAtSec ?? 0) ||
      b.demand - a.demand ||
      (a.id < b.id ? -1 : 1),
  );
  const need = new Map(ordered.map((t) => [t.id, Math.max(0, t.demand)]));
  const took = new Map(ordered.map((t) => [t.id, 0]));
  const notional = new Map(ordered.map((t) => [t.id, 0]));

  for (;;) {
    let best: { id: string; idx: number; gap: number } | null = null;
    for (const t of ordered) {
      if ((need.get(t.id) ?? 0) <= QTY_BAND * Math.max(t.demand, 1)) continue;
      for (let i = 0; i < pool.length; i += 1) {
        if (!(pool[i].qty > 0)) continue;
        // A target with no open time has no evidence either way; treat every
        // fill as equally near so it simply takes what is left in order.
        const gap = t.openedAtSec === null ? 0 : Math.abs(pool[i].timeSec - t.openedAtSec);
        if (!best || gap < best.gap - 1e-9) best = { id: t.id, idx: i, gap };
      }
    }
    if (!best) break;
    const q = Math.min(need.get(best.id) as number, pool[best.idx].qty);
    took.set(best.id, (took.get(best.id) as number) + q);
    notional.set(best.id, (notional.get(best.id) as number) + q * pool[best.idx].fixedApr);
    need.set(best.id, (need.get(best.id) as number) - q);
    pool[best.idx].qty -= q;
  }

  const out = new Map<string, { qty: number; fixedApr: number | null }>();
  for (const t of ordered) {
    const qty = took.get(t.id) as number;
    // The rate covers exactly the size allocated — they come from the same
    // fills — so unlike the old two-stage split there is no way for a strategy
    // to be credited a rate for a size it was not given.
    out.set(t.id, { qty, fixedApr: qty > 0 ? (notional.get(t.id) as number) / qty : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Membership transport
// ---------------------------------------------------------------------------

/** Compact wire shape for one row. Terse because it rides in a query string
 * next to `?since=`: `p` position, `k` kind, `r` reference, `q` quantity,
 * `e` the entry this position asserts it paid (price for a perp, APR fraction
 * for a Boros leg). */
interface WireRow {
  p?: string;
  k: 'p' | 'b';
  r: string | number;
  q?: number;
  e?: number;
}

/** 8 hex is 4 billion positions per book — collision is not a concern, and a
 * short id keeps a whole book's rows inside a comfortable URL. */
const POSITION_ID_RE = /^[0-9a-f]{1,32}$/;
const SYMBOL_RE = /^[A-Z0-9_]{1,64}$/;

/**
 * Decode the `?partition=` payload: base64url of `{v:3,r:[...]}`.
 *
 * Every field is validated — the payload comes from a URL a user can edit, and
 * a malformed row must degrade to "no assertion" rather than throw the whole
 * strategy view away. `null` means the payload could not be READ at all; an
 * empty array means it read fine and asks for nothing, which is not something
 * to warn a user about.
 */
export function decodeMembership(encoded: string): MembershipRow[] | null {
  let json: unknown;
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const body = json as { v?: unknown; r?: unknown };
  if (body.v !== 3 || !Array.isArray(body.r)) return null;

  // Keyed by (position, leg): a payload naming one leg twice for one position
  // states one intent, and applying both would claim the size twice. Last one
  // wins, like the client's own writer.
  const byKey = new Map<string, MembershipRow>();
  for (const row of body.r as WireRow[]) {
    const positionId = row?.p === undefined ? undefined : String(row.p);
    if (positionId !== undefined && !POSITION_ID_RE.test(positionId)) continue;

    let leg: LegRef;
    if (row?.k === 'p') {
      const symbol = String(row?.r ?? '').toUpperCase();
      if (!SYMBOL_RE.test(symbol)) continue;
      leg = { kind: 'perp', symbol };
    } else if (row?.k === 'b') {
      const marketId = typeof row?.r === 'number' ? row.r : Number.NaN;
      if (!Number.isInteger(marketId) || marketId <= 0) continue;
      leg = { kind: 'boros', marketId };
    } else {
      continue;
    }

    // NOT Number(row?.q): `null`, `''` and `[]` all coerce to 0, and 0 is a
    // meaningful size — a truncated link must not invent one.
    let qty: number | undefined;
    if (row?.q !== undefined) {
      if (typeof row.q !== 'number' || !Number.isFinite(row.q) || row.q < 0 || row.q > 1e12) {
        continue;
      }
      qty = row.q;
    }
    // Same discipline as `q`: an asserted entry must be a real positive number.
    // A price or rate of zero is not a fill, and a negative one is nonsense —
    // both would poison the weighted average this feeds.
    let entry: number | undefined;
    if (row?.e !== undefined) {
      if (typeof row.e !== 'number' || !Number.isFinite(row.e) || row.e <= 0 || row.e > 1e12) {
        continue;
      }
      entry = row.e;
    }
    byKey.set(`${positionId ?? ''}|${legRefKey(leg)}`, { positionId, leg, qty, entry });
  }
  return [...byKey.values()];
}

/** Inverse of `decodeMembership` — used by tests and any server-side caller;
 * the client has its own copy (web/src/panels/partitionStore.ts), the same
 * duplication the share codec uses. Empty in, empty out, so a book with no
 * assertions keeps a clean URL. */
export function encodeMembership(rows: readonly MembershipRow[]): string {
  if (!rows.length) return '';
  const body = {
    v: 3,
    r: rows.map((x) => ({
      ...(x.positionId === undefined ? {} : { p: x.positionId }),
      k: x.leg.kind === 'perp' ? 'p' : 'b',
      r: x.leg.kind === 'perp' ? x.leg.symbol : x.leg.marketId,
      ...(x.qty === undefined ? {} : { q: x.qty }),
      ...(x.entry === undefined ? {} : { e: x.entry }),
    })),
  };
  return Buffer.from(JSON.stringify(body), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
