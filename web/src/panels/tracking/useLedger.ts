/**
 * Owns the preview ledger for one book: loads it, persists every change, and
 * exposes the event-writing actions the UX is built from. All writes land in
 * `crossex.ledger.v1` only — see ledgerStore.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StrategyRollup } from '../../api/types';
import { legRefKey } from '../partitionStore';
import {
  loadBook,
  newId,
  saveBook,
  type BankedValue,
  type LedgerBook,
  type LedgerEvent,
  type LedgerStrategy,
} from './ledgerStore';
import type { PoolLeg, TrancheView } from './model';

const nowSec = () => Math.floor(Date.now() / 1000);
const EPS = 1e-9;

/** Bump when the auto-adoption logic changes meaningfully: auto strategies
 * materialized under an older version are dissolved and re-adopted, so stale
 * defaults (a pre-fix enrollment date, a blend instead of per-fill tranches)
 * don't outlive the fix in everyone's localStorage. User edits on an affected
 * auto card are re-derived too — acceptable while this is a preview. */
const ADOPTION_V = 4;

export interface EnrollSpec {
  pool: PoolLeg;
  qty: number;
  /** Effective time; 'since-open' baselines at 0 (the leg's whole history
   * counts), 'fresh' baselines at the leg's current net (PnL counts from now). */
  t: number;
  /** The leg's own availability (fill/venue open), pre-clamp — see
   * EnrollEvent.avail. Defaults to t. */
  avail?: number;
  countFrom: 'since-open' | 'fresh';
  entry?: number;
  entryFrom?: 'fill' | 'user';
  migration?: { from: string; costUsd: number };
  /** Perp only: the leg's SIGNED funding accrual rate (APR fraction, + =
   * this side receives) — the venue's live floating rate with the side's
   * sign. Lets the baseline estimate the window by RATE×NOTIONAL×TIME
   * instead of time-prorating a lifetime counter, which overcharges any
   * window on a position that was bigger earlier. */
  estRateApr?: number;
}

export function useLedger(bookId: string) {
  const [book, setBook] = useState<LedgerBook>(() => loadBook(bookId));
  const [bookFor, setBookFor] = useState(bookId);
  if (bookFor !== bookId) {
    setBookFor(bookId);
    setBook(loadBook(bookId));
  }

  const write = useCallback(
    (fn: (prev: LedgerBook) => LedgerBook) => {
      setBook((prev) => {
        const next = fn(prev);
        if (next !== prev) saveBook(bookId, next, nowSec());
        return next;
      });
    },
    [bookId],
  );

  /**
   * The baseline follows the DATE: contribution counts from `t`, so the
   * subtrahend is what the share had accumulated by then — exactly 0 at the
   * venue open, exactly the live net at "now", and a TIME-PRORATED estimate
   * in between (flows accrue roughly continuously; the server replay later
   * replaces the estimate with the ledger-exact figure). This is also what
   * makes Adjusting a date genuinely move the numbers.
   */
  const baselineNetFor = (
    pool: PoolLeg,
    frac: number,
    t: number,
    fresh: boolean,
    estRateApr?: number,
  ): { netUsd: number; netEstimated: boolean } => {
    const now = nowSec();
    const vo = pool.venueOpenedAt;
    if (fresh || t >= now - 60) return { netUsd: pool.netUsd * frac, netEstimated: false };
    if (vo === null || t <= vo + 60) return { netUsd: 0, netEstimated: false };
    /**
     * With a funding rate in hand (perps), estimate the WINDOW forward —
     * rate × the share's current notional × window — and subtract it from
     * the live net. Time-prorating the lifetime counter instead silently
     * charged the window for months when the venue position was far larger
     * (and for its lifetime fees): a $17.6k lifetime × 27% time slice
     * "cost" $4.8k where the actual 9-day window was ~$1.3k.
     */
    if (estRateApr !== undefined) {
      const windowUsd = estRateApr * pool.notionalUsd * frac * ((now - t) / (365 * 24 * 3600));
      return { netUsd: pool.netUsd * frac - windowUsd, netEstimated: true };
    }
    const span = now - vo;
    return {
      netUsd: span > 0 ? pool.netUsd * frac * ((t - vo) / span) : 0,
      netEstimated: true,
    };
  };

  const enrollEventOf = (sid: string, spec: EnrollSpec): LedgerEvent => {
    const frac = spec.pool.qty > EPS ? spec.qty / spec.pool.qty : 0;
    const { netUsd, netEstimated } = baselineNetFor(
      spec.pool,
      frac,
      spec.t,
      spec.countFrom === 'fresh',
      spec.estRateApr,
    );
    return {
      id: newId(),
      sid,
      kind: 'enroll',
      leg: spec.pool.ref,
      qty: spec.qty,
      t: spec.t,
      avail: spec.avail ?? spec.t,
      ...(spec.migration ? { migration: spec.migration } : {}),
      base: {
        netUsd,
        ...(netEstimated ? { netEstimated: true } : {}),
        ...(spec.countFrom === 'fresh' ? { fresh: true } : {}),
        venueQty: spec.pool.qty,
        capitalUsd: spec.pool.capitalUsd * frac,
        ...(spec.entry === undefined ? {} : { entry: spec.entry }),
        ...(spec.entryFrom === undefined ? {} : { entryFrom: spec.entryFrom }),
      },
    };
  };

  /** Create a strategy (empty, or with initial enrollments) and return its id. */
  const createStrategy = useCallback(
    (opts: {
      label?: string;
      provenance: 'auto' | 'user';
      sourceId?: string;
      startedAt?: number;
      enroll?: EnrollSpec[];
    }) => {
      const sid = newId();
      write((prev) => {
        // ⚠ Adoption dedup lives HERE, against the state actually being
        // written — a caller's view of the book is one render old, and React's
        // StrictMode double-fires effects, so checking outside this updater
        // adopted every solver proposal twice.
        if (opts.sourceId && prev.strategies.some((x) => x.sourceId === opts.sourceId)) {
          return prev;
        }
        const s: LedgerStrategy = {
          sid,
          provenance: opts.provenance,
          createdAt: nowSec(),
          ...(opts.label ? { label: opts.label } : {}),
          ...(opts.sourceId ? { sourceId: opts.sourceId, av: ADOPTION_V } : {}),
          ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
        };
        const events = (opts.enroll ?? []).map((e) => enrollEventOf(sid, e));
        return { ...prev, strategies: [...prev.strategies, s], events: [...prev.events, ...events] };
      });
      return sid;
    },
    [write],
  );

  const enroll = useCallback(
    (sid: string, spec: EnrollSpec) => {
      write((prev) => ({ ...prev, events: [...prev.events, enrollEventOf(sid, spec)] }));
    },
    [write],
  );

  /** Retire qty (null = all) of a tranche, banking its live contribution. */
  const retire = useCallback(
    (sid: string, tv: TrancheView, qty: number | null, reason: BankedValue['reason'], pnlOverride?: number) => {
      write((prev) => {
        const take = qty === null ? tv.tranche.qty : Math.min(qty, tv.tranche.qty);
        const frac = tv.tranche.qty > EPS ? take / tv.tranche.qty : 0;
        const pnlUsd = pnlOverride ?? tv.contributionUsd * frac;
        const capUsdSec = tv.capitalUsd * frac * Math.max(0, nowSec() - tv.tranche.t);
        const e: LedgerEvent = {
          id: newId(),
          sid,
          kind: 'unenroll',
          ref: tv.tranche.eventId,
          qty: qty === null ? null : take,
          t: nowSec(),
          banked: { pnlUsd, capUsdSec, reason },
        };
        return { ...prev, events: [...prev.events, e] };
      });
    },
    [write],
  );

  /** Restate a tranche: its size, effective time, or asserted entry. A qty
   * change scales the baseline pro-rata ("only this much was ever part of the
   * strategy" — nothing is banked); a DATE change recomputes the baseline for
   * the new window when the live leg is still readable. */
  const adjust = useCallback(
    (eventId: string, pool: PoolLeg | null, patch: { qty?: number; t?: number; entry?: number | null }) => {
      write((prev) => ({
        ...prev,
        events: prev.events.map((e) => {
          if (e.id !== eventId || e.kind !== 'enroll') return e;
          const qty = patch.qty ?? e.qty;
          const t = patch.t ?? e.t;
          const scale = e.qty > EPS ? qty / e.qty : 1;
          const { entry: prevEntry, entryFrom: prevFrom, netEstimated: _ne, ...baseRest } = e.base;
          const entry = patch.entry === undefined ? prevEntry : patch.entry ?? undefined;
          const entryFrom = patch.entry === undefined ? prevFrom : patch.entry === null ? undefined : ('user' as const);
          // A FRESH enrollment's baseline is frozen intent — scale it with
          // qty, never re-derive it as a since-open proration (that would
          // silently re-import the leg's whole pre-enrollment past).
          const net = e.base.fresh
            ? { netUsd: e.base.netUsd * scale, netEstimated: e.base.netEstimated ?? false }
            : pool && pool.qty > EPS
              ? baselineNetFor(pool, qty / pool.qty, t, false)
              : { netUsd: e.base.netUsd * scale, netEstimated: e.base.netEstimated ?? false };
          return {
            ...e,
            qty,
            t,
            base: {
              ...baseRest,
              netUsd: net.netUsd,
              ...(net.netEstimated ? { netEstimated: true } : {}),
              capitalUsd: e.base.capitalUsd * scale,
              ...(entry === undefined ? {} : { entry }),
              ...(entryFrom === undefined ? {} : { entryFrom }),
            },
          };
        }),
      }));
    },
    [write],
  );

  /**
   * Move the strategy's start date; every enrollment follows suit at
   * max(newStart, its own availability) — his rule: "set the overall start
   * date and everything else follows, whichever's later of the strategy
   * start and when the leg became available." Baselines recompute for the
   * new windows wherever the live leg is still readable.
   */
  const setStartedAt = useCallback(
    (sid: string, startedAt: number, poolByKey: Map<string, PoolLeg>) => {
      write((prev) => ({
        ...prev,
        strategies: prev.strategies.map((s) => (s.sid === sid ? { ...s, startedAt } : s)),
        events: prev.events.map((e) => {
          if (e.sid !== sid || e.kind !== 'enroll') return e;
          const pool = poolByKey.get(legRefKey(e.leg)) ?? null;
          const avail = e.avail ?? pool?.venueOpenedAt ?? e.t;
          const t = Math.max(startedAt, avail);
          if (t === e.t) return e;
          const { netEstimated: _ne, ...baseRest } = e.base;
          // Fresh baselines are frozen intent (see adjust); others recompute
          // against the share the event was WRITTEN with — today's venue qty
          // may differ after later DCA.
          const frac = e.base.venueQty > EPS ? e.qty / e.base.venueQty : 0;
          const net = e.base.fresh
            ? { netUsd: e.base.netUsd, netEstimated: e.base.netEstimated ?? false }
            : pool && frac > 0
              ? baselineNetFor(pool, frac, t, false)
              : { netUsd: e.base.netUsd, netEstimated: e.base.netEstimated ?? false };
          return {
            ...e,
            t,
            avail,
            base: {
              ...baseRest,
              netUsd: net.netUsd,
              ...(net.netEstimated ? { netEstimated: true } : {}),
            },
          };
        }),
      }));
    },
    [write],
  );

  const rename = useCallback(
    (sid: string, label: string) => {
      write((prev) => ({
        ...prev,
        strategies: prev.strategies.map((s) =>
          s.sid === sid ? { ...s, ...(label ? { label } : (({ label: _drop, ...rest }) => rest)(s)) } : s,
        ),
      }));
    },
    [write],
  );

  /** Forget the strategy and everything it said. Its legs go back to the tray,
   * and the materializer may re-adopt them from the solver's current proposal —
   * this IS "reset to automatic". */
  const dissolve = useCallback(
    (sid: string) => {
      write((prev) => ({
        strategies: prev.strategies.filter((s) => s.sid !== sid),
        events: prev.events.filter((e) => e.sid !== sid),
        savedAtSec: prev.savedAtSec,
      }));
    },
    [write],
  );

  /**
   * Adopt solver proposals the ledger has not seen: one auto strategy per
   * rollup with no adoption record, enrolling only qty no strategy already
   * holds. Baseline 0 at the leg's own open — day one equals today's numbers.
   */
  const seen = useRef<Set<string>>(new Set());
  const materialize = useCallback(
    (rollups: readonly StrategyRollup[], pool: Map<string, PoolLeg>, enrolledQty: Map<string, number>) => {
      // Re-adopt what an older materializer wrote: dissolve now, and let the
      // next effect pass (enrolledQty freshly derived) adopt it under the
      // current logic. Deliberately NOT marked `seen`.
      const stale = book.strategies.filter((s) => s.sourceId && (s.av ?? 1) < ADOPTION_V);
      if (stale.length) {
        const drop = new Set(stale.map((s) => s.sid));
        // ⚠ Un-see the sourceIds too, or the loop below skips re-adopting them
        // (they were marked seen while the stale record still stood) and the
        // strategy vanishes instead of being rebuilt.
        for (const s of stale) if (s.sourceId) seen.current.delete(s.sourceId);
        write((prev) => ({
          strategies: prev.strategies.filter((s) => !drop.has(s.sid)),
          events: prev.events.filter((e) => !drop.has(e.sid)),
          savedAtSec: prev.savedAtSec,
        }));
        return;
      }
      const adopted = new Set(book.strategies.map((s) => s.sourceId).filter(Boolean));
      for (const r of rollups) {
        // A single leg is not a grouping — it goes to the tray, from which the
        // user pulls it wherever it belongs. Multi-leg cards ARE groupings and
        // are adopted even when `unclaimed` (a Boros pair awaiting its perps
        // reports unclaimed, and is exactly the half-built position to track).
        if (r.strategyId.includes('#unhedged:') || r.legs.length < 2) continue;
        if (adopted.has(r.strategyId) || seen.current.has(r.strategyId)) continue;
        /**
         * The strategy exists once its rate is locked — same doctrine as the
         * classic 'boros-open' clock. A perp opened EARLIER than that was
         * doing something else (an older strategy since rolled away, a plain
         * funding arb), so it enrolls at the anchor, not at its own open;
         * a perp opened later keeps its own open.
         */
        const borosAnchor = r.legs.reduce<number | null>((acc, l) => {
          if (l.kind !== 'boros') return acc;
          const first = l.fills?.[0]?.timeSec ?? l.venueFills?.[0]?.timeSec ?? l.venueOpenedAt ?? null;
          return first === null ? acc : acc === null ? first : Math.min(acc, first);
        }, null);
        // The strategy's CREATION instant: its rate lock, else the earliest
        // leg. Nothing enrolls before it — whatever a leg did earlier belongs
        // to its previous life.
        const birth =
          borosAnchor ??
          r.legs.reduce<number | null>((acc, l) => {
            const vo = l.venueOpenedAt ?? l.openedAt;
            return vo === null ? acc : acc === null ? vo : Math.min(acc, vo);
          }, null) ??
          nowSec();
        // venue → live floating funding APR, read off the Boros legs.
        const floatingByVenue = new Map<string, number>();
        for (const l of r.legs) {
          if (l.kind === 'boros' && typeof l.floatingApr === 'number') {
            floatingByVenue.set(l.venue, l.floatingApr);
          }
        }
        const enroll: EnrollSpec[] = [];
        for (const l of r.legs) {
          const ref =
            l.kind === 'perp'
              ? l.symbol
                ? ({ kind: 'perp', symbol: l.symbol } as const)
                : null
              : typeof l.marketId === 'number'
                ? ({ kind: 'boros', marketId: l.marketId } as const)
                : null;
          if (!ref) continue;
          const p = pool.get(legRefKey(ref));
          if (!p) continue;
          const free = p.qty - (enrolledQty.get(p.key) ?? 0);
          const want = Math.min(l.notionalToken ?? 0, free);
          if (want <= EPS) continue;
          // ⚠ Per-leg VENUE truth, not `openedAt` — the solver re-stamps
          // openedAt to the tranche's earliest evidence, which dated Boros
          // legs to an older reused perp's open.
          const venueOpen = l.venueOpenedAt ?? l.openedAt ?? nowSec();
          if (l.kind === 'boros') {
            // One tranche PER FILL where the record is usable: a DCA'd or
            // split leg becomes its own rows, each with the qty, date and
            // rate it actually traded — both truths on the card at once.
            const fills = l.fills ?? l.venueFills ?? null;
            if (fills && fills.length >= 2 && fills.length <= 12) {
              let left = want;
              for (const f of fills) {
                const q = Math.min(f.qty, left);
                if (q <= EPS) continue;
                enroll.push({
                  pool: p,
                  qty: q,
                  t: Math.max(f.timeSec, birth),
                  avail: f.timeSec,
                  countFrom: 'since-open',
                  entry: f.apr,
                  entryFrom: 'fill',
                });
                left -= q;
              }
              // Rounding dust between the fill records and the venue's live
              // size is not a tranche — folding it into a row of its own only
              // adds noise.
              if (left > Math.max(EPS, want * 1e-3)) {
                enroll.push({ pool: p, qty: left, t: Math.max(venueOpen, birth), avail: venueOpen, countFrom: 'since-open' });
              }
              continue;
            }
            enroll.push({ pool: p, qty: want, t: Math.max(venueOpen, birth), avail: venueOpen, countFrom: 'since-open' });
            continue;
          }
          // A SHORT perp receives funding when the rate is positive.
          const floating = floatingByVenue.get(l.venue);
          const estRateApr =
            floating === undefined ? undefined : (l.side === 'SHORT' ? 1 : -1) * floating;
          enroll.push({
            pool: p,
            qty: want,
            t: Math.max(venueOpen, birth),
            avail: venueOpen,
            countFrom: 'since-open',
            ...(estRateApr === undefined ? {} : { estRateApr }),
          });
        }
        // Nothing free to adopt: mark it seen so a user's rearrangement isn't
        // fought over on every poll.
        seen.current.add(r.strategyId);
        if (!enroll.length) continue;
        const totalUsd = enroll.reduce((s, e) => s + e.pool.notionalUsd * (e.qty / Math.max(e.pool.qty, EPS)), 0);
        if (totalUsd < 1) continue;
        createStrategy({ provenance: 'auto', sourceId: r.strategyId, startedAt: birth, enroll });
      }
    },
    [book.strategies, createStrategy, write],
  );

  // A book switch is a different ledger and a different solver conversation.
  useEffect(() => {
    seen.current = new Set();
  }, [bookId]);

  return { book, createStrategy, enroll, retire, adjust, rename, setStartedAt, dissolve, materialize };
}
