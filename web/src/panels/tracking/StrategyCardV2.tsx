/**
 * The strategy as an OBJECT with a composition history — the preview card.
 *
 * Everything the classic card computed from the live snapshot is here derived
 * from the ledger: PnL = banked + live deltas (it conserves across rollovers
 * and retirements), APR is money-weighted over capital·time, and the
 * projection accrues remaining life only — never the past.
 */
import { useMemo, useState } from 'react';
import type { CrossexPosition } from '../../api/types';
import { Chip } from '../../components/Chip';
import { DataTable, type Column } from '../../components/DataTable';
import { SignedNumber } from '../../components/SignedNumber';
import { Stat } from '../../components/Stat';
import {
  fmtDateLocal,
  fmtPct,
  fmtTokenQty,
  fmtUsd,
  fmtUsdCompact,
  num,
  prettyVenue,
} from '../../lib/fmt';
import type { BankedItem } from './ledgerStore';
import type { StrategyView, TrancheView, TrayLeg } from './model';
import { rankCandidates } from './model';
import { AdjustModal, EnrollModal, RetireModal, StartDateModal, unitOf } from './modals';
import { LedgerBars } from './LedgerBars';
import type { EnrollSpec } from './useLedger';

const SIDE_TEXT: Record<'LONG' | 'SHORT', string> = {
  LONG: 'text-emerald-400',
  SHORT: 'text-rose-400',
};

interface Actions {
  enroll: (sid: string, spec: EnrollSpec) => void;
  retire: (sid: string, tv: TrancheView, qty: number | null, reason: 'retired' | 'closed' | 'rolled', pnlOverride?: number) => void;
  adjust: (
    eventId: string,
    pool: import('./model').PoolLeg | null,
    patch: { qty?: number; t?: number; entry?: number | null },
  ) => void;
  rename: (sid: string, label: string) => void;
  setStartedAt: (sid: string, startedAt: number, poolByKey: Map<string, import('./model').PoolLeg>) => void;
  dissolve: (sid: string) => void;
}

interface Props {
  view: StrategyView;
  tray: TrayLeg[];
  actions: Actions;
  nowSec: number;
  /** Live 4s perp feed by symbol — exact venue entry/mark for expanded rows. */
  livePositions?: Map<string, CrossexPosition>;
  /** legKey → live venue leg, for start-date cascades. */
  poolByKey: Map<string, import('./model').PoolLeg>;
}

const defaultLabel = (v: StrategyView): string => {
  const vs = v.venues.map(prettyVenue);
  return v.base ? `${v.base}${vs.length ? ` · ${vs.join(' ⇄ ')}` : ''}` : 'Empty position';
};

function bankedReason(b: BankedItem): string {
  return b.banked.reason === 'closed' ? 'closed at venue' : b.banked.reason === 'rolled' ? 'rolled over' : 'retired';
}

function legName(tv: TrancheView): string {
  if (tv.pool) {
    return `${tv.pool.kind === 'boros' ? 'Boros' : 'Perp'} · ${prettyVenue(tv.pool.venue)}`;
  }
  return tv.tranche.leg.kind === 'perp'
    ? `Perp · ${tv.tranche.leg.symbol}`
    : `Boros · market ${tv.tranche.leg.marketId}`;
}

const fmtStamp = (sec: number): string => {
  const d = new Date(sec * 1000);
  return `${fmtDateLocal(sec)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * One venue leg as this card holds it: the group of tranches (a DCA'd or
 * split leg has several — its BUILDING BLOCKS), summed for the row and
 * itemized on expand. The two truths stay separate: the venue's own history
 * (open, blend, fills) vs what this strategy claims of it (blocks, windows).
 */
export interface LegGroup {
  key: string;
  pool: TrancheView['pool'];
  tranches: TrancheView[];
  qty: number;
  notionalUsd: number;
  contributionUsd: number;
  capitalUsd: number;
  baselineUsd: number;
  baselineEstimated: boolean;
  /** Qty-weighted entry across blocks with a known entry; null = none known. */
  entry: number | null;
  tMin: number;
  tMax: number;
  /** Every block ledger-exact (or estimate-free)? Drives the ~ marker. */
  exact: boolean;
}

export function groupLegs(tranches: readonly TrancheView[]): LegGroup[] {
  const byKey = new Map<string, LegGroup>();
  for (const tv of tranches) {
    const g = byKey.get(tv.key);
    if (!g) {
      byKey.set(tv.key, {
        key: tv.key,
        pool: tv.pool,
        tranches: [tv],
        qty: tv.tranche.qty,
        notionalUsd: tv.notionalUsd,
        contributionUsd: tv.contributionUsd,
        capitalUsd: tv.capitalUsd,
        baselineUsd: tv.tranche.base.netUsd,
        baselineEstimated: tv.tranche.base.netEstimated === true,
        entry: tv.entry,
        tMin: tv.tranche.t,
        tMax: tv.tranche.t,
        exact: tv.exact,
      });
    } else {
      g.tranches.push(tv);
      // Weighted BEFORE qty grows, while g.qty still sums the prior blocks.
      if (tv.entry !== null) {
        g.entry =
          g.entry === null
            ? tv.entry
            : (g.entry * g.qty + tv.entry * tv.tranche.qty) / (g.qty + tv.tranche.qty);
      }
      g.qty += tv.tranche.qty;
      g.notionalUsd += tv.notionalUsd;
      g.contributionUsd += tv.contributionUsd;
      g.capitalUsd += tv.capitalUsd;
      g.baselineUsd += tv.tranche.base.netUsd;
      g.baselineEstimated = g.baselineEstimated || tv.tranche.base.netEstimated === true;
      g.tMin = Math.min(g.tMin, tv.tranche.t);
      g.tMax = Math.max(g.tMax, tv.tranche.t);
      g.exact = g.exact && tv.exact;
    }
  }
  return [...byKey.values()];
}

function GroupExpanded({
  g,
  live,
  onAdjust,
  onRetire,
}: {
  g: LegGroup;
  live?: CrossexPosition;
  onAdjust: (tv: TrancheView) => void;
  onRetire: (tv: TrancheView) => void;
}) {
  const p = g.pool;
  if (!p) {
    return (
      <p className="px-3 py-2 text-xs text-ink-500">
        The venue no longer reports this leg — only this card&apos;s record remains (enrolled{' '}
        {fmtStamp(g.tMin)}, size {g.qty}). Bank it to close the book on it.
      </p>
    );
  }
  const isBoros = p.kind === 'boros';
  const venueEntry = isBoros ? p.entry : live ? Number(live.entryPrice) : p.entry;
  const fmtE = (v: number) => (isBoros ? fmtPct(v) : fmtUsd(v));
  const sharePct = p.qty > 1e-9 ? Math.round((g.qty / p.qty) * 1000) / 10 : 0;
  const differentOpen = p.venueOpenedAt !== null && Math.abs(p.venueOpenedAt - g.tMin) > 3600;

  /**
   * ONE table tells the whole story: the venue's fills (Boros) or this
   * card's enrollments (perp/blend), each row carrying what's YOURS of it.
   * No separate blocks table, no repeated dates — a row is a moment, and
   * everything about that moment sits on it.
   */
  type HistRow = {
    key: string;
    t: number;
    qty: number;
    entry: number | null;
    tv: TrancheView | null; // null = held elsewhere / unassigned
    pnlUsd: number | null;
    partial: boolean; // yours < the venue fill
  };
  const rows: HistRow[] = [];
  if (isBoros && p.venueFills && p.venueFills.length > 0) {
    const timeMatched = (sec: number) =>
      g.tranches.find((s) => Math.abs(s.tranche.t - sec) <= 1) ?? null;
    const anyMatched = p.venueFills.some((f) => timeMatched(f.timeSec));
    const blendShare = p.qty > 1e-9 ? g.qty / p.qty : 0;
    for (const [i2, f] of p.venueFills.entries()) {
      const tv = anyMatched ? timeMatched(f.timeSec) : null;
      const mine = tv ? tv.tranche.qty : anyMatched ? 0 : f.qty * blendShare;
      rows.push({
        key: `${f.timeSec}:${i2}`,
        t: f.timeSec,
        qty: mine > 1e-9 ? mine : f.qty,
        entry: tv?.entry ?? f.apr,
        tv,
        pnlUsd: tv ? tv.contributionUsd : null,
        partial: mine > 1e-9 && mine < f.qty * 0.999,
      });
    }
    // Blend tranches that matched no fill still deserve their own rows.
    for (const tv of g.tranches) {
      if (!rows.some((r) => r.tv === tv) && anyMatched) {
        rows.push({
          key: tv.tranche.eventId,
          t: tv.tranche.t,
          qty: tv.tranche.qty,
          entry: tv.entry,
          tv,
          pnlUsd: tv.contributionUsd,
          partial: false,
        });
      }
    }
    rows.sort((a, b) => a.t - b.t);
  } else {
    for (const tv of g.tranches) {
      rows.push({
        key: tv.tranche.eventId,
        t: tv.tranche.t,
        qty: tv.tranche.qty,
        entry: tv.entry,
        tv,
        pnlUsd: tv.contributionUsd,
        partial: false,
      });
    }
  }

  return (
    <div className="px-3 py-2 text-xs">
      {/* Two dense fact lines — venue truth vs this position's claim. ------ */}
      <div className="flex flex-wrap items-baseline gap-x-2 text-ink-400">
        <span className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          Venue
        </span>
        <span className="num text-ink-300">
          open {p.venueOpenedAt === null ? '—' : fmtStamp(p.venueOpenedAt)}
          {venueEntry !== null && Number.isFinite(venueEntry) && (
            <> · {fmtE(venueEntry)} blend</>
          )}
          {isBoros && p.markApr !== null && <> → {fmtPct(p.markApr)} mark</>}
          {!isBoros && live && <> → {fmtUsd(Number(live.markPrice))} mark · {num(Number(live.leverage), 1)}x</>}
          {' · '}
          {fmtTokenQty(p.qty, unitOf(p))} total
          {isBoros && p.marketId !== null && <span className="text-ink-600"> · mkt {p.marketId}</span>}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-ink-400">
        <span className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          This position
        </span>
        <span className="num text-ink-300">
          {sharePct}% of leg · capital {fmtUsd(g.capitalUsd, 0)}
          {' · '}baseline <SignedNumber value={g.baselineUsd} format={(n) => fmtUsd(n)} />
          {g.baselineEstimated && (
            <span
              className="text-amber-400/90"
              title="Time-prorated estimate — the browser cannot read historical flows; the server replay replaces it with the exact figure."
            >
              {' '}~est.
            </span>
          )}
          {!isBoros && live && (
            <>
              {' · '}uPnL share{' '}
              <SignedNumber
                value={Number(live.upnl) * (p.qty > 1e-9 ? g.qty / p.qty : 0)}
                format={(n) => fmtUsd(n)}
              />
            </>
          )}
        </span>
      </div>

      {/* The history & split table. ---------------------------------------- */}
      <table className="mt-2 w-auto">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-600">
            <th className="pr-6 font-semibold">When</th>
            <th className="pr-6 text-right font-semibold">Size</th>
            <th className="pr-6 text-right font-semibold">Entry</th>
            <th className="pr-6 text-right font-semibold">PnL since</th>
            <th className="text-right font-semibold" />
          </tr>
        </thead>
        <tbody className="num text-ink-300">
          {rows.map((r) => (
            <tr key={r.key} className={r.tv ? '' : 'text-ink-600'}>
              <td className="pr-6">{fmtStamp(r.t)}</td>
              <td className="pr-6 text-right">
                {fmtTokenQty(r.qty, unitOf(p))}
                {r.partial && r.tv && (
                  <span className="text-ink-600" title="Your share of this fill; the rest is tracked elsewhere or unassigned.">
                    {' '}of a bigger fill
                  </span>
                )}
              </td>
              <td className="pr-6 text-right">
                {r.entry === null ? '—' : fmtE(r.entry)}
                {r.tv &&
                  r.tv.tranche.base.entry !== undefined &&
                  r.tv.tranche.base.entryFrom !== 'fill' && (
                    <span className="text-cyan-400" title="Asserted by you">
                      *
                    </span>
                  )}
                {r.tv?.tranche.migration && (
                  <span className="text-amber-400" title={`Venue switch from ${r.tv.tranche.migration.from} — recorded cost ${fmtUsd(r.tv.tranche.migration.costUsd)}`}>
                    {' '}⇄
                  </span>
                )}
              </td>
              <td className="pr-6 text-right">
                {r.pnlUsd === null ? (
                  <span title="Held elsewhere or unassigned — not this position's.">elsewhere</span>
                ) : (
                  <SignedNumber value={r.pnlUsd} format={(n) => fmtUsd(n)} />
                )}
              </td>
              <td className="text-right">
                {r.tv && (
                  <span className="flex justify-end gap-1">
                    <button type="button" className="btn-ghost-xs" onClick={() => onAdjust(r.tv!)}>
                      Adjust
                    </button>
                    <button type="button" className="btn-ghost-xs" onClick={() => onRetire(r.tv!)}>
                      Retire
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {differentOpen && (
        <p className="mt-2 text-[11px] text-amber-400/90">
          The venue position predates this position — what it earned before {fmtStamp(g.tMin)} sits
          outside its PnL via the baseline
          {g.baselineEstimated ? ' (time-prorated estimate; exact after server replay)' : ''}.
        </p>
      )}
    </div>
  );
}

export function StrategyCardV2({ view, tray, actions, nowSec, livePositions, poolByKey }: Props) {
  const { s } = view;
  const [addOpen, setAddOpen] = useState(false);
  const [retireOf, setRetireOf] = useState<TrancheView | null>(null);
  const [adjustOf, setAdjustOf] = useState<TrancheView | null>(null);
  const [bankedOpen, setBankedOpen] = useState(false);
  const [chartsOpen, setChartsOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const [startOpen, setStartOpen] = useState(false);

  const label = s.label ?? defaultLabel(view);
  const bankedUsdByLeg = useMemo(() => {
    const out: Record<string, number> = {};
    for (const b of view.banked) {
      const key = b.leg.kind === 'perp' ? `perp:${b.leg.symbol}` : `boros:${b.leg.marketId}`;
      out[key] = (out[key] ?? 0) + b.banked.pnlUsd;
    }
    return out;
  }, [view.banked]);
  // Same doctrine as the classic card's fullyHedged gate: a half-built book
  // annualizes into confidently wrong numbers, so the rate block waits.
  const ratesGated = !(view.balance.perpOk && view.balance.borosOk) || view.tranches.length < 2;
  const gatedDash = (
    <span className="text-ink-500" title="Appears once every leg is in place — annualizing a half-built position reports a rate it does not have.">
      —
    </span>
  );
  const candidates = useMemo(() => rankCandidates(view, tray), [view, tray]);
  // One ROW per venue leg; a DCA'd or split leg's per-fill tranches are its
  // building blocks, itemized on expand — never sibling rows.
  const groups = useMemo(() => groupLegs(view.tranches), [view.tranches]);
  const [retireGroupOf, setRetireGroupOf] = useState<LegGroup | null>(null);
  const maturedTranches = view.tranches.filter(
    (t) => t.pool?.kind === 'boros' && t.pool.maturity !== null && t.pool.maturity <= nowSec,
  );

  const columns: Column<LegGroup>[] = [
    {
      key: 'leg',
      header: 'Leg',
      render: (g) => (
        <span>
          {g.pool ? (
            <>
              <span className={`font-medium ${SIDE_TEXT[g.pool.side]}`}>
                {g.pool.side.toLowerCase()}
              </span>{' '}
              <span className="text-ink-100">{g.pool.base}</span>
              <span className="text-ink-500"> · {legName(g.tranches[0])}</span>
            </>
          ) : (
            <>
              <span className="text-ink-300">{legName(g.tranches[0])}</span>{' '}
              <Chip tone="amber" sm>
                closed at venue
              </Chip>
            </>
          )}
          {g.tranches.length > 1 && (
            <Chip tone="neutral" sm className="ml-1.5" title="Built from several enrollments — expand for the building blocks.">
              {g.tranches.length} fills
            </Chip>
          )}
          {g.pool && g.qty < g.pool.qty * 0.999 && (
            <Chip tone="blue" sm className="ml-1.5" title="Part of the venue position; the rest is tracked elsewhere or unassigned.">
              {Math.round((g.qty / g.pool.qty) * 100)}% of leg
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      align: 'right',
      render: (g) => (
        <span className="num text-ink-200">
          {g.pool ? fmtTokenQty(g.qty, unitOf(g.pool)) : String(g.qty)}
          {g.pool && <span className="text-ink-500"> · {fmtUsdCompact(g.notionalUsd)}</span>}
        </span>
      ),
    },
    {
      key: 'entry',
      header: 'Entry → mark',
      align: 'right',
      render: (g) => {
        if (!g.pool) return <span className="text-ink-500">—</span>;
        const isBoros = g.pool.kind === 'boros';
        // A shared perp leg's payload withholds the blend (it would misstate a
        // tranche's own price) — the live feed's venue blend still beats a dash.
        const liveEntry =
          !isBoros && g.pool.symbol ? Number(livePositions?.get(g.pool.symbol)?.entryPrice) : NaN;
        const entry = g.entry ?? (Number.isFinite(liveEntry) && liveEntry > 0 ? liveEntry : null);
        const asserted = g.tranches.some(
          (tv) => tv.tranche.base.entry !== undefined && tv.tranche.base.entryFrom !== 'fill',
        );
        const liveMark =
          !isBoros && g.pool.symbol ? Number(livePositions?.get(g.pool.symbol)?.markPrice) : NaN;
        return (
          <span
            className="num text-ink-200"
            title={
              asserted
                ? 'Includes an entry asserted by you (venue blend differs)'
                : g.tranches.length > 1
                  ? 'Weighted across this position’s fills — expand for each one.'
                  : undefined
            }
          >
            {entry === null ? '—' : isBoros ? fmtPct(entry) : fmtUsd(entry)}
            {asserted && <span className="text-cyan-400">*</span>}
            {isBoros && g.pool.markApr !== null && (
              <span className="text-ink-500"> → {fmtPct(g.pool.markApr)}</span>
            )}
            {!isBoros && Number.isFinite(liveMark) && liveMark > 0 && (
              <span className="text-ink-500"> → {fmtUsd(liveMark)}</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'since',
      header: 'PnL since enrolled',
      align: 'right',
      render: (g) =>
        g.pool ? (
          // Muted on purpose: on a delta-neutral book the two halves of a
          // hedge net out — the card's hero already carries the net. Loud
          // per-leg red/green made the reader re-derive it.
          <span
            className="num text-ink-300"
            title={`Enrolled ${fmtStamp(g.tMin)}${g.tMax - g.tMin > 43200 ? ` → ${fmtStamp(g.tMax)}` : ''}${g.exact ? ' · reconstructed from the venue\u2019s own settlement records' : ' · estimated — the venue ledger could not cover this window'}`}
          >
            {g.exact ? '' : '~'}
            {g.contributionUsd >= 0 ? '+' : '−'}
            {fmtUsd(Math.abs(g.contributionUsd))}
          </span>
        ) : (
          <span className="text-ink-500">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (g) => (
        <span className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {g.pool && g.tranches.length === 1 && (
            <button type="button" className="btn-ghost-xs" onClick={() => setAdjustOf(g.tranches[0])}>
              Adjust
            </button>
          )}
          <button
            type="button"
            className="btn-ghost-xs"
            onClick={() =>
              g.tranches.length === 1 ? setRetireOf(g.tranches[0]) : setRetireGroupOf(g)
            }
          >
            {g.pool ? 'Retire' : 'Bank'}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="card p-4">
      {/* Header ------------------------------------------------------------ */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {view.base && (
          <span className="rounded-md border border-ink-600 px-2 py-0.5 text-sm font-semibold text-ink-100">
            {view.base}
          </span>
        )}
        {editingLabel !== null ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              actions.rename(s.sid, editingLabel.trim());
              setEditingLabel(null);
            }}
          >
            <input
              className="input !py-0.5 w-56 text-sm"
              autoFocus
              value={editingLabel}
              onChange={(e) => setEditingLabel(e.target.value)}
              onBlur={() => setEditingLabel(null)}
            />
          </form>
        ) : (
          <button
            type="button"
            className="text-sm font-medium text-ink-100 hover:text-cyan-300"
            title={`Rename — ${s.provenance === 'auto' ? 'grouped automatically from your fills' : 'assembled by hand'}; every part can be adjusted.`}
            onClick={() => setEditingLabel(s.label ?? '')}
          >
            {label} <span className="text-ink-600">✎</span>
          </button>
        )}
        {view.matured ? (
          <Chip tone="amber" sm>
            matured
          </Chip>
        ) : !view.balance.borosOk ? (
          <Chip tone="amber" sm title="Boros and perp notionals differ by more than 20% — the rate lock does not cover the hedge.">
            hedge incomplete
          </Chip>
        ) : !view.balance.perpOk ? (
          <Chip tone="amber" sm title="Long and short perp notionals differ by more than 10%.">
            sizes off
          </Chip>
        ) : (
          view.tranches.length > 1 && (
            <Chip tone="green" sm>
              hedged ✓
            </Chip>
          )
        )}
        <span className="ml-auto flex items-center gap-1">
          {confirmDissolve ? (
            <>
              <span className="text-xs text-ink-400">Forget this grouping?</span>
              <button
                type="button"
                className="btn-ghost-xs !text-rose-400"
                onClick={() => actions.dissolve(s.sid)}
              >
                Yes, re-group automatically
              </button>
              <button type="button" className="btn-ghost-xs" onClick={() => setConfirmDissolve(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-ghost-xs"
              title="Forget this position's grouping and history; the solver proposes a fresh grouping from the live legs."
              onClick={() => setConfirmDissolve(true)}
            >
              Reset to automatic
            </button>
          )}
        </span>
      </div>

      {/* Hero — the two KNOWABLE numbers lead: the rate this strategy locked
          and what it pays by maturity. Realized-so-far APR is a footnote (it
          annualizes noise on a young position); PnL now and capital follow.
          The box IS the charts toggle — same learned gesture as classic. */}
      <button
        type="button"
        onClick={() => setChartsOpen((v) => !v)}
        title="How these numbers are built — click for the waterfalls."
        className={`mb-3 block w-full rounded-lg border px-4 py-2.5 text-left transition-colors ${chartsOpen ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-ink-700 hover:border-ink-500'}`}
      >
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <Stat label="Fixed APR" hero sm>
          {ratesGated || view.fixedAprOnCapital === null ? (
            gatedDash
          ) : (
            <span title={`The locked, net-of-fees return on capital, annualized over the strategy's life${view.lockedAprOnCapital !== null ? ` — gross spread on capital ${fmtPct(view.lockedAprOnCapital)}` : ''}. Known the moment the rate is locked.`}>
              <SignedNumber value={view.fixedAprOnCapital} format={(n) => fmtPct(n)} />
            </span>
          )}
        </Stat>
        <Stat label="PnL at maturity" hero sm>
          {ratesGated || view.projectedPnlUsd === null ? (
            gatedDash
          ) : (
            <SignedNumber value={view.projectedPnlUsd} format={(n) => fmtUsd(n)} />
          )}
        </Stat>
        <Stat label="PnL now" sm>
          <SignedNumber value={view.pnlUsd} format={(n) => fmtUsd(n)} />
        </Stat>
        <Stat label="Capital" sm>
          <span className="num text-ink-200">{fmtUsdCompact(view.capitalUsd)}</span>
        </Stat>
        <div className="pb-1 text-xs text-ink-500">
          {view.bankedPnlUsd !== 0 && (
            <>
              <SignedNumber value={view.bankedPnlUsd} format={(n) => fmtUsd(n)} className="!text-ink-400" /> banked ·{' '}
              <SignedNumber value={view.livePnlUsd} format={(n) => fmtUsd(n)} className="!text-ink-400" /> live
              {' · '}
            </>
          )}
          {!ratesGated && view.estApr !== null && (
            <span title="Money-weighted realized return so far — meaningful only once the position has lived a while; a young book annualizes noise.">
              realized{' '}
              {Math.abs(view.estApr) > 0.99 ? (
                <span className="num text-ink-400">{view.estApr > 0 ? '>+99%' : '<−99%'}</span>
              ) : (
                <SignedNumber value={view.estApr} format={(n) => fmtPct(n)} className="!text-ink-400" />
              )}{' '}
              so far
            </span>
          )}
          <span className="text-ink-600"> {chartsOpen ? '▾' : '▸'} charts</span>
        </div>
      </div>
      </button>
      {chartsOpen && (
        <div className="mb-3">
          <LedgerBars view={view} />
        </div>
      )}

      {/* Timeline — the event ledger made visible: every date lives HERE.
          Dots = enrollments (hover for the fill), hollow dots = retirements
          (hover for the banked amount); start is clickable to move it. */}
      {view.startedAt !== null && view.maturity !== null && view.maturity > view.startedAt && (
        <div className="mb-3">
          <div className="relative h-2.5">
            <div className="absolute inset-x-0 top-1 h-1.5 overflow-hidden rounded-full bg-ink-800">
              <div
                className="absolute inset-y-0 left-0 bg-cyan-500/60"
                style={{
                  width: `${Math.min(100, Math.max(0, ((nowSec - view.startedAt) / (view.maturity - view.startedAt)) * 100))}%`,
                }}
              />
            </div>
            {(() => {
              const x = (t: number) =>
                Math.min(100, Math.max(0, ((t - view.startedAt!) / (view.maturity! - view.startedAt!)) * 100));
              return (
                <>
                  {view.tranches.map((tv) => (
                    <span
                      key={tv.tranche.eventId}
                      className="absolute top-0.5 h-2 w-2 -translate-x-1/2 rounded-full border border-ink-950 bg-cyan-300"
                      style={{ left: `${x(tv.tranche.t)}%` }}
                      title={`${fmtStamp(tv.tranche.t)} — enrolled ${tv.pool ? fmtTokenQty(tv.tranche.qty, unitOf(tv.pool)) : tv.tranche.qty}${tv.entry !== null ? ` @ ${tv.pool?.kind === 'boros' ? fmtPct(tv.entry) : fmtUsd(tv.entry)}` : ''} (${tv.pool ? prettyVenue(tv.pool.venue) : '?'})`}
                    />
                  ))}
                  {view.banked.map((b) => (
                    <span
                      key={b.eventId}
                      className="absolute top-0.5 h-2 w-2 -translate-x-1/2 rounded-full border border-ink-400 bg-ink-950"
                      style={{ left: `${x(b.t)}%` }}
                      title={`${fmtStamp(b.t)} — ${bankedReason(b)}, banked ${fmtUsd(b.banked.pnlUsd)}`}
                    />
                  ))}
                </>
              );
            })()}
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] text-ink-500">
            <button
              type="button"
              className="num hover:text-ink-200"
              title="The strategy's start — click to change it; every leg re-enrolls at the later of this date and its own availability."
              onClick={() => setStartOpen(true)}
            >
              {fmtDateLocal(view.startedAt)} start ✎ · {Math.max(0, Math.round((nowSec - view.startedAt) / 86400))}d elapsed
            </button>
            <span className="num">
              {Math.max(0, Math.round((view.maturity - nowSec) / 86400))}d left · matures {fmtDateLocal(view.maturity)}
            </span>
          </div>
        </div>
      )}

      {/* Warnings / matured banner ----------------------------------------- */}
      {view.warnings.map((w) => (
        <p key={w} className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
          {w}
        </p>
      ))}
      {maturedTranches.length > 0 && (
        <div className="mb-2 flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
          <span>
            {maturedTranches.length === 1 ? 'A Boros leg has' : `${maturedTranches.length} Boros legs have`} matured —
            retire {maturedTranches.length === 1 ? 'it' : 'them'} to bank the locked return, then add the next
            maturity&apos;s legs to roll.
          </span>
          <button
            type="button"
            className="btn-ghost-xs shrink-0 !text-amber-300"
            onClick={() => {
              for (const tv of maturedTranches) actions.retire(s.sid, tv, null, 'rolled');
            }}
          >
            Retire matured legs
          </button>
        </div>
      )}

      {/* Composition ------------------------------------------------------- */}
      <DataTable
        columns={columns}
        rows={groups}
        rowKey={(g) => g.key}
        // A composition must be readable whole — a scrolled-away leg looks
        // like a missing one.
        maxHeightClass="max-h-none"
        renderExpanded={(g) => (
          <GroupExpanded
            g={g}
            live={g.pool?.symbol ? livePositions?.get(g.pool.symbol) : undefined}
            onAdjust={setAdjustOf}
            onRetire={setRetireOf}
          />
        )}
        emptyState={
          <p className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-center text-sm text-ink-500">
            No live legs — add one, or this position is fully realized.
          </p>
        }
      />

      {/* Banked ------------------------------------------------------------ */}
      {view.banked.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-ink-400 hover:text-ink-200"
            onClick={() => setBankedOpen((v) => !v)}
          >
            {bankedOpen ? '▾' : '▸'} Banked ({view.banked.length}) ·{' '}
            <SignedNumber value={view.bankedPnlUsd} format={(n) => fmtUsd(n)} />
          </button>
          {bankedOpen && (
            <div className="mt-1 flex flex-col gap-0.5">
              {view.banked.map((b) => (
                <div key={b.eventId} className="flex items-center gap-2 rounded-md bg-ink-950/40 px-3 py-1 text-xs text-ink-400">
                  <span>
                    {b.leg.kind === 'perp' ? b.leg.symbol : `Boros market ${b.leg.marketId}`}
                    {b.qty !== null && <span className="num"> · {b.qty}</span>}
                  </span>
                  <Chip tone="neutral" sm>
                    {bankedReason(b)}
                  </Chip>
                  <span className="text-ink-600">{fmtDateLocal(b.t)}</span>
                  <span className="ml-auto">
                    <SignedNumber value={b.banked.pnlUsd} format={(n) => fmtUsd(n)} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer actions ---------------------------------------------------- */}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn" onClick={() => setAddOpen(true)}>
          + Add leg
        </button>
        <span className="text-[11px] text-ink-600">
          Tracking only — orders stay on the trade tickets.
        </span>
      </div>

      {/* Dialogs ----------------------------------------------------------- */}
      {addOpen && (
        <EnrollModal
          title={`Add a leg to ${label}`}
          candidates={candidates}
          bankedUsdByLeg={bankedUsdByLeg}
          minT={view.startedAt ?? undefined}
          recentBanked={view.banked
            .filter((b) => nowSec - b.t < 7 * 86400)
            .map((b) => ({
              key: b.eventId,
              label: b.leg.kind === 'perp' ? b.leg.symbol : `Boros market ${b.leg.marketId}`,
            }))}
          onClose={() => setAddOpen(false)}
          onConfirm={(spec) => {
            actions.enroll(s.sid, spec);
            setAddOpen(false);
          }}
        />
      )}
      {retireOf && (
        <RetireModal
          tv={retireOf}
          onClose={() => setRetireOf(null)}
          onConfirm={(qty, pnlOverride) => {
            actions.retire(s.sid, retireOf, qty, retireOf.pool ? 'retired' : 'closed', pnlOverride);
            setRetireOf(null);
          }}
        />
      )}
      {retireGroupOf && (
        <RetireModal
          // The modal reads qty/contribution/pool/t off a TrancheView shape —
          // hand it the GROUP's aggregates, then distribute the confirmed qty
          // across the building blocks pro-rata (each banks its own share).
          tv={{
            tranche: {
              eventId: `group:${retireGroupOf.key}`,
              leg: retireGroupOf.tranches[0].tranche.leg,
              qty: retireGroupOf.qty,
              t: retireGroupOf.tMin,
              base: {
                netUsd: retireGroupOf.baselineUsd,
                venueQty: retireGroupOf.pool?.qty ?? retireGroupOf.qty,
                capitalUsd: retireGroupOf.capitalUsd,
              },
            },
            key: retireGroupOf.key,
            pool: retireGroupOf.pool,
            share: retireGroupOf.pool && retireGroupOf.pool.qty > 1e-9 ? retireGroupOf.qty / retireGroupOf.pool.qty : 0,
            notionalUsd: retireGroupOf.notionalUsd,
            entry: retireGroupOf.entry,
            contributionUsd: retireGroupOf.contributionUsd,
            capitalUsd: retireGroupOf.capitalUsd,
            exact: retireGroupOf.tranches.every((tv) => tv.exact),
          }}
          onClose={() => setRetireGroupOf(null)}
          onConfirm={(qty, pnlOverride) => {
            const g = retireGroupOf;
            const reason = g.pool ? ('retired' as const) : ('closed' as const);
            for (const tv of g.tranches) {
              const frac = g.qty > 1e-9 ? tv.tranche.qty / g.qty : 0;
              const q = qty === null ? null : qty * frac;
              // The user's stated final PnL splits pro-rata — dropping it
              // banked $0 for every vanished multi-fill leg.
              const po = pnlOverride === undefined ? undefined : pnlOverride * frac;
              actions.retire(s.sid, tv, q, reason, po);
            }
            setRetireGroupOf(null);
          }}
        />
      )}
      {startOpen && view.startedAt !== null && (
        <StartDateModal
          startedAt={view.startedAt}
          onClose={() => setStartOpen(false)}
          onConfirm={(t: number) => {
            actions.setStartedAt(s.sid, t, poolByKey);
            setStartOpen(false);
          }}
        />
      )}
      {adjustOf && (
        <AdjustModal
          tv={adjustOf}
          minT={Math.max(view.startedAt ?? 0, adjustOf.tranche.avail ?? 0) || undefined}
          onClose={() => setAdjustOf(null)}
          onConfirm={(patch) => {
            actions.adjust(adjustOf.tranche.eventId, adjustOf.pool, patch);
            setAdjustOf(null);
          }}
        />
      )}
    </div>
  );
}
