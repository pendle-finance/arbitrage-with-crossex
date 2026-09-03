/**
 * Derivation layer for the preview tracking UX: fold the ledger's events
 * against the live feeds into view models.
 *
 * The venue truth is the LEG POOL — every venue leg the strategy feed knows,
 * reassembled from the rollups (which partition each venue leg between cards,
 * so summing the claims reconstructs the venue total). The ledger then says
 * which slices of the pool belong to which strategy since when; everything on
 * screen is `banked + (live − baseline)`.
 *
 * PROTOTYPE APPROXIMATIONS (all move server-side in the production slice):
 *  - a tranche's live PnL share is `qty/venueQty × venue net` — exact only
 *    while the venue leg isn't also being traded outside the strategy (the
 *    rebase mechanism handles that in the real slice);
 *  - capital per leg is apportioned from the rollup's capitalUsd by notional;
 *  - a leg that vanishes from the feeds banks at the value last computed for
 *    it on the previous poll (kept in a session cache), or $0 with a warning.
 */
import type { StrategyRollup, StrategyLeg } from '../../api/types';
import { legRefKey, type LegRef } from '../partitionStore';
import {
  foldStrategy,
  type BankedItem,
  type LedgerBook,
  type LedgerStrategy,
  type Tranche,
} from './ledgerStore';

export const SECONDS_IN_YEAR = 365 * 24 * 3600;

/** One enrollment window reconstructed by POST /boros/replay. Token sums are
 * in the leg's settlement token; the view converts with the pool's price. */
export interface ReplayResult {
  id: string;
  exact: boolean;
  coveredFromSec: number;
  settleToken?: number;
  settleFeeToken?: number;
  tradePnlToken?: number;
  tradeFeeToken?: number;
  fundingUsd?: number;
  sharedApprox?: boolean;
}
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Leg pool
// ---------------------------------------------------------------------------

export interface PoolLeg {
  key: string;
  ref: LegRef;
  kind: 'perp' | 'boros';
  venue: string;
  base: string;
  side: 'LONG' | 'SHORT';
  /** Venue totals — the sum over every rollup's claim on this leg. */
  qty: number;
  notionalUsd: number;
  netUsd: number;
  /** Gross flow components (venue totals) — what the classic waterfalls
   * decompose. Perp: cashFlow = funding, fees = trading fees; Boros:
   * cashFlow = settlements NET of settle fees (add settleFeePaid back for a
   * gross reading), mtm+tradePnl the rest. netUsd = their leg-kind sum. */
  cashFlowUsd: number;
  feesUsd: number;
  mtmUsd: number;
  tradePnlUsd: number;
  settleFeePaidUsd: number;
  capitalUsd: number;
  /** Venue blended entry: price (perp) / APR fraction (Boros). */
  entry: number | null;
  markApr: number | null;
  openedAt: number | null;
  /** The venue position's own open — differs from openedAt on a re-stamped
   * tranche (prior trading / DCA). */
  venueOpenedAt: number | null;
  maturity: number | null;
  collateral: string | null;
  /** Perp only — join key to the live 4s positions feed. */
  symbol: string | null;
  marketId: number | null;
  /** Boros only: the venue position's own fill history (oldest first). */
  venueFills: Array<{ timeSec: number; qty: number; apr: number }> | null;
}

const refOf = (l: StrategyLeg): LegRef | null => {
  if (l.kind === 'perp') return l.symbol ? { kind: 'perp', symbol: l.symbol } : null;
  return typeof l.marketId === 'number' ? { kind: 'boros', marketId: l.marketId } : null;
};

/** Reassemble venue legs from the rollups' partitioned claims. */
export function buildPool(rollups: readonly StrategyRollup[]): Map<string, PoolLeg> {
  const pool = new Map<string, PoolLeg>();
  for (const r of rollups) {
    const gross = r.legs.reduce((s, l) => s + l.notionalUsd, 0);
    for (const l of r.legs) {
      const ref = refOf(l);
      if (!ref) continue;
      const key = legRefKey(ref);
      const capital = gross > EPS ? r.capitalUsd * (l.notionalUsd / gross) : 0;
      const entry = l.kind === 'perp' ? (l.venueEntry ?? l.entryPrice ?? null) : (l.venueEntry ?? l.entryApr ?? null);
      const prev = pool.get(key);
      if (!prev) {
        pool.set(key, {
          key,
          ref,
          kind: l.kind,
          venue: l.venue,
          base: l.base,
          side: l.side,
          qty: l.notionalToken ?? 0,
          notionalUsd: l.notionalUsd,
          netUsd: l.netUsd,
          cashFlowUsd: l.cashFlowUsd,
          feesUsd: l.feesUsd,
          mtmUsd: l.kind === 'boros' ? l.mtmUsd : 0,
          tradePnlUsd: l.kind === 'boros' ? l.tradePnlUsd : 0,
          settleFeePaidUsd: l.settlementFeePaidUsd ?? 0,
          capitalUsd: capital,
          entry,
          markApr: l.markApr ?? null,
          openedAt: l.openedAt,
          venueOpenedAt: l.venueOpenedAt ?? l.openedAt,
          maturity: l.maturity ?? null,
          collateral: l.collateral ?? null,
          symbol: l.symbol ?? null,
          marketId: typeof l.marketId === 'number' ? l.marketId : null,
          venueFills: l.venueFills ?? null,
        });
      } else {
        prev.qty += l.notionalToken ?? 0;
        prev.notionalUsd += l.notionalUsd;
        prev.netUsd += l.netUsd;
        prev.cashFlowUsd += l.cashFlowUsd;
        prev.feesUsd += l.feesUsd;
        prev.mtmUsd += l.kind === 'boros' ? l.mtmUsd : 0;
        prev.tradePnlUsd += l.kind === 'boros' ? l.tradePnlUsd : 0;
        prev.settleFeePaidUsd += l.settlementFeePaidUsd ?? 0;
        prev.capitalUsd += capital;
        if (prev.entry === null && entry !== null) prev.entry = entry;
        if (prev.openedAt === null || (l.openedAt !== null && l.openedAt < prev.openedAt)) {
          prev.openedAt = l.openedAt;
        }
        const vo = l.venueOpenedAt ?? l.openedAt;
        if (prev.venueOpenedAt === null || (vo !== null && vo < prev.venueOpenedAt)) {
          prev.venueOpenedAt = vo;
        }
        if (prev.venueFills === null && l.venueFills) prev.venueFills = l.venueFills;
      }
    }
  }
  return pool;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface TrancheView {
  tranche: Tranche;
  key: string;
  /** Live venue leg — null when the venue no longer reports it. */
  pool: PoolLeg | null;
  /** qty / venue qty, clamped to 1. */
  share: number;
  notionalUsd: number;
  /** Entry shown for this tranche: asserted at enrollment, else venue blended. */
  entry: number | null;
  /** banked-style live contribution: share×venue net − baseline. */
  contributionUsd: number;
  capitalUsd: number;
  /** True when the window was reconstructed from the venue's own settlement
   * records (or needed no reconstruction); false = an estimate stands in. */
  exact: boolean;
}

export interface StrategyView {
  s: LedgerStrategy;
  tranches: TrancheView[];
  banked: BankedItem[];
  base: string;
  venues: string[];
  /** The strategy's creation instant (rate lock for adopted ones) — the floor
   * under every enrollment, and the timeline's left edge. */
  startedAt: number | null;
  /** Earliest Boros maturity among live tranches; null = none. */
  maturity: number | null;
  matured: boolean;
  livePnlUsd: number;
  bankedPnlUsd: number;
  pnlUsd: number;
  capitalUsd: number;
  /** Money-weighted denominator: Σ capital·elapsed (live) + banked cap·time. */
  capUsdSec: number;
  /** Annualized money-weighted return; null = too early / no capital. */
  estApr: number | null;
  /** Fixed-leg carry per year (SHORT receives fixed, LONG pays). */
  netFixedPerYearUsd: number;
  lockedAprOnCapital: number | null;
  /** Classic identity: spreadLocked − paid fees − future settle fees. */
  projectedPnlUsd: number | null;
  /** THE headline: the locked, net-of-fees return on capital, annualized
   * over the strategy's life (startedAt → maturity). Known the moment the
   * rate is locked — unlike realized-so-far APR, it doesn't explode on a
   * young position. */
  fixedAprOnCapital: number | null;
  /**
   * The waterfall decomposition, all WINDOWED to each tranche's membership
   * (the same 1−f proration that shapes contributionUsd, so the components
   * sum exactly to livePnlUsd). Signs: flows signed as earned, fees POSITIVE
   * costs. spreadLockedUsd runs each Boros tranche from its own enrollment
   * to maturity — the locked spread over the strategy's actual windows.
   */
  flows: {
    perpFundingUsd: number;
    borosFundingGrossUsd: number;
    borosMtmTradeUsd: number;
    perpFeesUsd: number;
    borosTradeFeesUsd: number;
    settleFeesPaidUsd: number;
    /** Estimated remaining settlement fees to maturity — from the source
     * rollup pro-rata when resolvable, else 0 (chart omits the bar). */
    futureSettleFeesUsd: number;
    /** The strategy's ONE slippage charge. Perp price MtM is structurally
     * excluded from nets (house doctrine), so the price gap between the two
     * sides must be charged once, explicitly — as the recorded venue-switch
     * cost when a leg was migrated (close A, open B), else as the source
     * rollup's simultaneous-entry gap estimate. Included in pnlUsd. */
    slippageUsd: number;
    slippageKind: 'switch' | 'entry' | null;
    spreadLockedUsd: number;
  };
  /** Long/short perp notionals within 10%? Boros covered by perps? */
  balance: { perpOk: boolean; borosOk: boolean };
  warnings: string[];
}

export interface TrayLeg {
  pool: PoolLeg;
  /** Venue qty no strategy has enrolled. */
  freeQty: number;
  freeUsd: number;
}

export interface TrackingView {
  strategies: StrategyView[];
  tray: TrayLeg[];
  /** legKey → Σ enrolled qty, across all strategies. */
  enrolledQty: Map<string, number>;
}

const fixedSign = (side: 'LONG' | 'SHORT'): number => (side === 'SHORT' ? 1 : -1);

export function deriveView(
  book: LedgerBook,
  pool: Map<string, PoolLeg>,
  nowSec: number,
  /** sourceId → the rollup's cost estimates for pro-rata bars: future Boros
   * settlement (usd/borosUsd) and paid entry slippage (slipUsd/perpUsd).
   * Optional — 0 when absent. */
  futureSettleBySource?: Map<
    string,
    { usd: number; borosUsd: number; slipUsd: number | null; perpUsd: number }
  >,
  /** symbol → the live feed's venue entry price, filling the blends the wire
   * withholds on shared legs — feeds the composite-slippage fallback. */
  perpEntryBySymbol?: Map<string, number>,
  /** eventId → its ledger-replayed window (see useReplay). When present and
   * exact, it REPLACES the stored-baseline estimate — numbers become a pure
   * function of (events, venue history): deterministic on any device. */
  replay?: Map<string, ReplayResult>,
): TrackingView {
  const enrolledQty = new Map<string, number>();
  const strategies: StrategyView[] = [];

  for (const s of book.strategies) {
    const { tranches, banked } = foldStrategy(book.events, s.sid);
    const views: TrancheView[] = [];
    const warnings: string[] = [];
    let livePnl = 0;
    let capital = 0;
    let capUsdSec = 0;
    let netFixedPerYear = 0;
    let spreadLocked = 0;
    const flows = {
      perpFundingUsd: 0,
      borosFundingGrossUsd: 0,
      borosMtmTradeUsd: 0,
      perpFeesUsd: 0,
      borosTradeFeesUsd: 0,
      settleFeesPaidUsd: 0,
      futureSettleFeesUsd: 0,
      slippageUsd: 0,
      slippageKind: null as 'switch' | 'entry' | null,
      spreadLockedUsd: 0,
    };
    let maturity: number | null = null;
    const venues = new Set<string>();
    let base = '';
    const perpBySide = { LONG: 0, SHORT: 0 };
    let borosUsd = 0;
    let perpUsd = 0;

    let migrationCost = 0;
    let hasMigration = false;
    for (const tr of tranches) {
      if (tr.migration) {
        migrationCost += tr.migration.costUsd;
        hasMigration = true;
      }
      const key = legRefKey(tr.leg);
      enrolledQty.set(key, (enrolledQty.get(key) ?? 0) + tr.qty);
      const p = pool.get(key) ?? null;
      const share = p && p.qty > EPS ? Math.min(1, tr.qty / p.qty) : 0;
      const notionalUsd = p ? p.notionalUsd * share : 0;
      const entry = tr.base.entry ?? p?.entry ?? null;
      /**
       * Contribution, best evidence first:
       *  1. LEDGER REPLAY (exact): the venue's own per-settlement records
       *     summed over [t, now] — plus the components a ledger cannot carry
       *     (current mark value belongs to whoever holds the stream now;
       *     trade PnL windows fall back below).
       *  2. Stored-baseline estimate: share×net − baseline (the ~est path).
       */
      const rep = replay?.get(tr.eventId);
      const usdPerToken = p && p.qty > EPS ? p.notionalUsd / p.qty : 0;
      let contribution = p ? p.netUsd * share - tr.base.netUsd : 0;
      let exact = !tr.base.netEstimated;
      if (p) {
        venues.add(p.venue);
        base = base || p.base;
        /**
         * Fallback window fraction (estimate path): baseline = f×share×net,
         * so what stays is (1−f) of every component. Clamped — a net decayed
         * below its baseline would flip bars at 4x scale otherwise.
         */
        const shareNet = p.netUsd * share;
        const w = Math.abs(shareNet) > EPS ? Math.min(1, Math.max(0, 1 - tr.base.netUsd / shareNet)) : 1;
        // Trade-PnL window: exact only when the window IS the position's
        // whole life (enrolled at its open-from-flat); otherwise the w-share
        // estimate stands in — usually $0 on a pure hold.
        const wholeLife = p.venueOpenedAt === null || tr.t <= p.venueOpenedAt + 60;
        if (p.kind === 'boros' && rep?.settleToken !== undefined) {
          const settleUsd = rep.settleToken * usdPerToken;
          const settleFeeUsd = (rep.settleFeeToken ?? 0) * usdPerToken;
          // Trade windows: exact when the replay carried them (fills have
          // timestamps); the w-estimate only as a degraded fallback.
          const tradeExact = rep.tradePnlToken !== undefined;
          const tradeTerm = tradeExact
            ? (rep.tradePnlToken as number) * usdPerToken
            : p.tradePnlUsd * share * (wholeLife ? 1 : w);
          const tradeFeeUsd = tradeExact
            ? (rep.tradeFeeToken ?? 0) * usdPerToken
            : p.feesUsd * share * (wholeLife ? 1 : w);
          contribution = settleUsd + p.mtmUsd * share + tradeTerm;
          exact = rep.exact && (tradeExact || wholeLife || Math.abs(p.tradePnlUsd * share) < 1);
          flows.borosFundingGrossUsd += settleUsd + settleFeeUsd;
          flows.settleFeesPaidUsd += settleFeeUsd;
          flows.borosTradeFeesUsd += tradeFeeUsd;
          flows.borosMtmTradeUsd += p.mtmUsd * share + tradeTerm + tradeFeeUsd;
        } else if (p.kind === 'perp' && rep?.fundingUsd !== undefined) {
          const feeTerm = p.feesUsd * share * (wholeLife ? 1 : w);
          contribution = rep.fundingUsd - feeTerm;
          exact = rep.exact && !rep.sharedApprox && (wholeLife || feeTerm < 1);
          flows.perpFundingUsd += rep.fundingUsd;
          flows.perpFeesUsd += feeTerm;
        } else if (p.kind === 'boros') {
          flows.borosFundingGrossUsd += (p.cashFlowUsd + p.settleFeePaidUsd) * share * w;
          flows.settleFeesPaidUsd += p.settleFeePaidUsd * share * w;
          flows.borosTradeFeesUsd += p.feesUsd * share * w;
          // tradePnl is already net of trade fees on the wire, so the fee bar
          // is display decomposition: add it back into the gross component.
          flows.borosMtmTradeUsd += (p.mtmUsd + p.tradePnlUsd + p.feesUsd) * share * w;
        } else {
          flows.perpFundingUsd += p.cashFlowUsd * share * w;
          flows.perpFeesUsd += p.feesUsd * share * w;
        }
        livePnl += contribution;
        capital += tr.base.capitalUsd;
        capUsdSec += tr.base.capitalUsd * Math.max(0, nowSec - tr.t);
        if (p.kind === 'boros') {
          borosUsd += notionalUsd;
          if (entry !== null) {
            netFixedPerYear += fixedSign(p.side) * entry * notionalUsd;
            // Locked over THIS tranche's actual window: enrollment → maturity.
            const legMat = p.maturity !== null && p.maturity > 0 ? p.maturity : null;
            if (legMat !== null && legMat > tr.t) {
              spreadLocked +=
                (fixedSign(p.side) * entry * notionalUsd * (legMat - tr.t)) / SECONDS_IN_YEAR;
            }
          }
          if (p.maturity !== null && p.maturity > 0) {
            maturity = maturity === null ? p.maturity : Math.min(maturity, p.maturity);
          }
        } else {
          perpUsd += notionalUsd;
          perpBySide[p.side] += notionalUsd;
        }
      } else {
        warnings.push(
          `A ${tr.leg.kind === 'perp' ? tr.leg.symbol : `Boros market ${tr.leg.marketId}`} tranche is no longer reported by the venue — retire it to bank its final PnL.`,
        );
      }
      views.push({
        tranche: tr,
        key,
        pool: p,
        share,
        notionalUsd,
        entry,
        contributionUsd: contribution,
        capitalUsd: tr.base.capitalUsd,
        exact,
      });
    }

    let bankedPnl = 0;
    for (const b of banked) {
      bankedPnl += b.banked.pnlUsd;
      capUsdSec += b.banked.capUsdSec;
    }

    const eventTimes = [...tranches.map((t) => t.t), ...banked.map((b) => b.t)];
    const startedAt = s.startedAt ?? (eventTimes.length ? Math.min(...eventTimes) : null);

    // Future settlement fees: the source rollup's estimate, scaled to this
    // strategy's share of that rollup's Boros book.
    const src = s.sourceId ? futureSettleBySource?.get(s.sourceId) : undefined;
    if (src && src.borosUsd > EPS) {
      flows.futureSettleFeesUsd = src.usd * Math.min(1, borosUsd / src.borosUsd);
    }
    // One slippage charge: a recorded venue switch REPLACES the entry-gap
    // estimate (the two legs were never entered simultaneously).
    if (hasMigration) {
      flows.slippageUsd = migrationCost;
      flows.slippageKind = 'switch';
    } else if (src && src.slipUsd !== null && src.perpUsd > EPS) {
      flows.slippageUsd = src.slipUsd * Math.min(1, perpUsd / src.perpUsd);
      flows.slippageKind = flows.slippageUsd !== 0 ? 'entry' : null;
    } else {
      /**
       * COMPOSITE FALLBACK — the server's estimate is null exactly on the
       * split/shared books this preview exists to fix, so compute the entry
       * gap from THIS card's own legs: (long entry − short entry) × matched
       * qty, entries from the tranche/venue blend or the live feed. Signed —
       * a favorable crossing is negative, same as classic.
       */
      const sides = { LONG: { qty: 0, notional: 0 }, SHORT: { qty: 0, notional: 0 } };
      let known = true;
      for (const tv2 of views) {
        const p2 = tv2.pool;
        if (!p2 || p2.kind !== 'perp') continue;
        const entry =
          tv2.entry ?? p2.entry ?? (p2.symbol ? perpEntryBySymbol?.get(p2.symbol) : undefined) ?? null;
        if (entry === null || !(entry > 0)) {
          known = false;
          break;
        }
        sides[p2.side].qty += tv2.tranche.qty;
        sides[p2.side].notional += entry * tv2.tranche.qty;
      }
      if (known && sides.LONG.qty > EPS && sides.SHORT.qty > EPS) {
        const eLong = sides.LONG.notional / sides.LONG.qty;
        const eShort = sides.SHORT.notional / sides.SHORT.qty;
        const matched = Math.min(sides.LONG.qty, sides.SHORT.qty);
        flows.slippageUsd = (eLong - eShort) * matched;
        flows.slippageKind = flows.slippageUsd !== 0 ? 'entry' : null;
      }
    }

    const pnl = livePnl + bankedPnl - flows.slippageUsd;
    // Under an hour of capital-time annualizes noise into three digits.
    const estApr = capUsdSec > Math.max(capital, 1) * 3600 ? (pnl / capUsdSec) * SECONDS_IN_YEAR : null;
    const lockedApr = capital > EPS ? netFixedPerYear / capital : null;
    flows.spreadLockedUsd = spreadLocked;
    /**
     * The CLASSIC projection identity, over the ledger's windows: what the
     * locked spread pays across each tranche's enrollment→maturity, less the
     * fees already paid in-window and the settlement fees still ahead. This
     * is what the left waterfall steps down to, so hero and chart agree by
     * construction.
     */
    const projected =
      maturity !== null && maturity > nowSec
        ? spreadLocked -
          flows.perpFeesUsd -
          flows.borosTradeFeesUsd -
          flows.settleFeesPaidUsd -
          flows.slippageUsd -
          flows.futureSettleFeesUsd
        : null;
    const perpMax = Math.max(perpBySide.LONG, perpBySide.SHORT);
    const perpOk = perpMax < EPS || Math.min(perpBySide.LONG, perpBySide.SHORT) / perpMax > 0.9;
    const borosOk =
      borosUsd < EPS || perpUsd < EPS
        ? borosUsd < EPS && perpUsd < EPS
        : Math.min(borosUsd, perpUsd) / Math.max(borosUsd, perpUsd) > 0.8;

    const lifeSec = startedAt !== null && maturity !== null ? maturity - startedAt : null;
    const fixedApr =
      projected !== null && capital > EPS && lifeSec !== null && lifeSec > 0
        ? (projected / capital) * (SECONDS_IN_YEAR / lifeSec)
        : null;

    strategies.push({
      s,
      tranches: views,
      banked,
      base,
      venues: [...venues],
      startedAt,
      maturity,
      matured: maturity !== null && maturity <= nowSec,
      livePnlUsd: livePnl,
      bankedPnlUsd: bankedPnl,
      pnlUsd: pnl,
      capitalUsd: capital,
      capUsdSec,
      estApr,
      netFixedPerYearUsd: netFixedPerYear,
      lockedAprOnCapital: lockedApr,
      projectedPnlUsd: projected,
      fixedAprOnCapital: fixedApr,
      flows,
      balance: { perpOk, borosOk },
      warnings,
    });
  }

  const tray: TrayLeg[] = [];
  for (const p of pool.values()) {
    const free = p.qty - (enrolledQty.get(p.key) ?? 0);
    if (p.qty > EPS && free / p.qty > 1e-6 && free > EPS) {
      tray.push({ pool: p, freeQty: free, freeUsd: p.notionalUsd * (free / p.qty) });
    }
  }
  tray.sort((a, b) => b.freeUsd - a.freeUsd);

  // Finished books read first, then the biggest — same doctrine as homeBoxes.
  strategies.sort((a, b) => {
    const done = (v: StrategyView) => (v.balance.perpOk && v.balance.borosOk && v.tranches.length > 1 ? 0 : 1);
    return done(a) - done(b) || b.capitalUsd - a.capitalUsd;
  });

  return { strategies, tray, enrolledQty };
}

/**
 * Rank tray legs as candidates for a strategy: same base first, then opposite
 * perp side / hedging shape, then open-time proximity to the strategy's legs —
 * a client-side echo of the solver's proximity score.
 */
export function rankCandidates(view: StrategyView, tray: readonly TrayLeg[]): TrayLeg[] {
  const opens = view.tranches
    .map((t) => t.pool?.openedAt ?? null)
    .filter((x): x is number => x !== null);
  const anchor = opens.length ? Math.min(...opens) : null;
  const score = (t: TrayLeg): number => {
    let s = 0;
    if (view.base && t.pool.base.toUpperCase() !== view.base.toUpperCase()) s += 1000;
    if (anchor !== null && t.pool.openedAt !== null) {
      s += Math.min(100, Math.abs(t.pool.openedAt - anchor) / 3600);
    }
    return s;
  };
  return [...tray].sort((a, b) => score(a) - score(b));
}
