/**
 * PREVIEW: the new tracking home. Strategies are durable objects assembled
 * from an event ledger (see ledgerStore.ts); every venue leg either belongs to
 * a strategy or sits in the UNASSIGNED tray below, from which it can be pulled
 * into any position in one step.
 *
 * Reads the same strategy/positions queries as the classic view (shared
 * react-query cache) but persists ONLY to `crossex.ledger.v1`.
 */
import { useEffect, useMemo, useState } from 'react';
import { usePositions, useStrategy } from '../../api/queries';
import type { CrossexPosition } from '../../api/types';
import { Chip } from '../../components/Chip';
import { EmptyState } from '../../components/EmptyState';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, prettyVenue } from '../../lib/fmt';
import { useBookId } from '../bookId';
import { loadOverrides } from '../entryOverrideStore';
import { AddressForm, short } from '../HomeControls';
import { encodeRows, legRefKey, loadRows } from '../partitionStore';
import { useTrackedAddress } from '../trackedAddress';
import { buildPool, deriveView, type TrayLeg } from './model';
import { EnrollModal, LegLine } from './modals';
import { StrategyCardV2 } from './StrategyCardV2';
import { useLedger, type EnrollSpec } from './useLedger';
import { useReplay } from './useReplay';

interface Props {
  onExit: () => void;
}

export function TrackingHome({ onExit }: Props) {
  const { address, since, capitalBasis, setAddress } = useTrackedAddress();
  const bookId = useBookId(address);

  // The classic view's saved pins still shape the SERVER solve (so the pool
  // and the solver proposals match what the user already curated there); they are
  // read-only here — this view writes only the ledger.
  const encodedPins = useMemo(() => {
    const rows = loadRows(bookId);
    const overrides = loadOverrides(bookId);
    const byKey = new Map(overrides.map((e) => [`${e.positionId}|${legRefKey(e.leg)}`, e.value]));
    if (!byKey.size) return encodeRows(rows);
    return encodeRows(
      rows.map((r) => {
        if (r.positionId === undefined) return r;
        const v = byKey.get(`${r.positionId}|${legRefKey(r.leg)}`);
        return v === undefined ? r : { ...r, entry: v };
      }),
    );
  }, [bookId]);

  const strategyQuery = useStrategy(address, since, encodedPins, capitalBasis);
  const rollups = strategyQuery.data?.strategies;
  const positionsQuery = usePositions();
  const livePositions = useMemo(() => {
    const map = new Map<string, CrossexPosition>();
    for (const p of positionsQuery.data?.positions ?? []) map.set(p.symbol, p);
    return map;
  }, [positionsQuery.data?.positions]);

  const ledger = useLedger(bookId);
  // Pinned per feed refresh — recomputing every render busted the memos.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [rollups]);

  const pool = useMemo(() => buildPool(rollups ?? []), [rollups]);
  // Source-rollup future settlement estimates, for the classic-shape left
  // waterfall's dashed →maturity bar (pro-rata to this strategy's share).
  const futureSettle = useMemo(() => {
    const m = new Map<string, { usd: number; borosUsd: number; slipUsd: number | null; perpUsd: number }>();
    for (const r of rollups ?? []) {
      m.set(r.strategyId, {
        usd: r.feesUsd.future.borosSettlementUsd,
        borosUsd: r.legs.filter((l) => l.kind === 'boros').reduce((s, l) => s + l.notionalUsd, 0),
        slipUsd: r.feesUsd.paid.perpEntrySlippageUsd,
        perpUsd: r.legs.filter((l) => l.kind === 'perp').reduce((s, l) => s + l.notionalUsd, 0),
      });
    }
    return m;
  }, [rollups]);
  const perpEntryBySymbol = useMemo(() => {
    const m = new Map<string, number>();
    for (const [sym, pos] of livePositions) {
      const e = Number(pos.entryPrice);
      if (Number.isFinite(e) && e > 0) m.set(sym, e);
    }
    return m;
  }, [livePositions]);
  const replay = useReplay(address, ledger.book, pool);
  const view = useMemo(
    () => deriveView(ledger.book, pool, nowSec, futureSettle, perpEntryBySymbol, replay),
    [ledger.book, pool, nowSec, futureSettle, perpEntryBySymbol, replay],
  );

  // Adopt solver proposals the ledger hasn't seen. After the render, so the
  // enrolled-qty map it consults is the one just derived.
  const { materialize } = ledger;
  useEffect(() => {
    if (rollups) materialize(rollups, pool, view.enrolledQty);
  }, [rollups, pool, view.enrolledQty, materialize]);

  const [trayTarget, setTrayTarget] = useState<TrayLeg | null>(null);

  const totalPnl = view.strategies.reduce((s, v) => s + v.pnlUsd, 0);
  const totalCapital = view.strategies.reduce((s, v) => s + v.capitalUsd, 0);

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
        Fixed-return positions
      </h2>
      <Chip tone="violet" sm title="Prototype of the new tracking model — PnL = banked + change since each leg's enrollment; ~est. figures become exact once event replay moves server-side. State lives under its own storage keys; the classic view and its groupings are untouched; nothing here places orders.">
        tracking preview
      </Chip>
      <button type="button" className="btn-ghost-xs ml-auto" onClick={onExit}>
        ← Back to classic view
      </button>
    </div>
  );

  if (!address) {
    return (
      <div>
        {header}
        <EmptyState
          icon="◈"
          title="Track your 4-leg strategy"
          hint="Enter the EVM address holding your Boros legs. The preview groups your legs into durable positions you can rearrange freely."
          action={<AddressForm submitLabel="Track" onTrack={setAddress} />}
        />
      </div>
    );
  }
  if (strategyQuery.isPending) {
    return (
      <div>
        {header}
        <TableSkeleton rows={4} cols={6} />
      </div>
    );
  }
  if (strategyQuery.isError && !strategyQuery.data) {
    return (
      <div>
        {header}
        <QueryError
          title="Couldn't load Boros strategy data"
          error={strategyQuery.error}
          onRetry={() => void strategyQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div>
      {header}

      {view.strategies.length > 1 && (
        <div className="card mb-3 flex flex-wrap items-center gap-x-8 gap-y-1 px-4 py-2 text-sm">
          <span>
            <span className="text-xs uppercase tracking-wider text-ink-500">Total PnL </span>
            <SignedNumber value={totalPnl} format={(n) => fmtUsd(n)} />
          </span>
          <span>
            <span className="text-xs uppercase tracking-wider text-ink-500">Capital </span>
            <span className="num text-ink-200">{fmtUsdCompact(totalCapital)}</span>
          </span>
          <span className="ml-auto text-xs text-ink-500 num">{short(address)}</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {view.strategies.length === 0 && view.tray.length === 0 && (
          <EmptyState
            icon="◎"
            title="No positions"
            hint={`No live legs found for ${short(address)} or the connected Gate account.`}
          />
        )}

        {view.strategies.map((v) => (
          <StrategyCardV2
            key={v.s.sid}
            view={v}
            tray={view.tray}
            nowSec={nowSec}
            livePositions={livePositions}
            poolByKey={pool}
            actions={{
              enroll: ledger.enroll,
              retire: ledger.retire,
              adjust: ledger.adjust,
              rename: ledger.rename,
              setStartedAt: ledger.setStartedAt,
              dissolve: ledger.dissolve,
            }}
          />
        ))}

        {/* Unassigned tray -------------------------------------------------- */}
        {view.tray.length > 0 && (
          <div className="card border-dashed p-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                Unassigned legs
              </h3>
              <Chip tone="neutral" sm>
                {view.tray.length}
              </Chip>
              <span className="text-xs text-ink-500">
                — live at the venues, part of no position. Pull one into a position, or start a new
                one from it.
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {view.tray.map((t) => (
                <div
                  key={t.pool.key}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-ink-800 px-3 py-1.5 text-sm"
                >
                  <LegLine p={t.pool} qty={t.freeQty} />
                  <span className="text-xs text-ink-500">
                    {t.pool.kind === 'boros' && t.pool.entry !== null && `locked ${fmtPct(t.pool.entry)} · `}
                    {t.pool.openedAt ? `opened ${fmtDateLocal(t.pool.openedAt)}` : ''}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <button type="button" className="btn-ghost-xs" onClick={() => setTrayTarget(t)}>
                      Assign →
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {trayTarget && (
        <TrayAddModal
          leg={trayTarget}
          strategies={[
            ...[...view.strategies]
              // The natural destination — same coin — reads first and is the default.
              .sort((a, b) => {
                const hit = (v: (typeof view.strategies)[number]) =>
                  v.base.toUpperCase() === trayTarget.pool.base.toUpperCase() ? 0 : 1;
                return hit(a) - hit(b) || b.capitalUsd - a.capitalUsd;
              })
              .map((v) => ({
                sid: v.s.sid,
                label: v.s.label ?? `${v.base || '—'}${v.venues.length ? ` · ${v.venues.map(prettyVenue).join(' ⇄ ')}` : ''} · ${fmtUsdCompact(v.capitalUsd)}`,
                startedAt: v.startedAt,
                bankedUsdByLeg: Object.fromEntries(
                  v.banked.map((b) => [
                    b.leg.kind === 'perp' ? `perp:${b.leg.symbol}` : `boros:${b.leg.marketId}`,
                    b.banked.pnlUsd,
                  ]),
                ),
              })),
            { sid: '__new__', label: '＋ New position', startedAt: null, bankedUsdByLeg: {} },
          ]}
          onEnroll={(sid, spec) => {
            if (sid === '__new__') {
              ledger.createStrategy({ provenance: 'user', startedAt: spec.t, enroll: [spec] });
            } else {
              ledger.enroll(sid, spec);
            }
            setTrayTarget(null);
          }}
          onClose={() => setTrayTarget(null)}
        />
      )}
    </div>
  );
}

/** Tray → position: pick the destination, then the standard enroll dialog
 * (qty, effective date, what counts) preloaded with just this leg. */
function TrayAddModal({
  leg,
  strategies,
  onEnroll,
  onClose,
}: {
  leg: TrayLeg;
  strategies: {
    sid: string;
    label: string;
    startedAt: number | null;
    bankedUsdByLeg: Record<string, number>;
  }[];
  onEnroll: (sid: string, spec: EnrollSpec) => void;
  onClose: () => void;
}) {
  const [sid, setSid] = useState<string | null>(strategies[0]?.sid ?? null);
  if (sid === null) return null;
  const dest = strategies.find((s) => s.sid === sid);
  return (
    <EnrollModal
      title={`Add ${fmtTokenQty(leg.freeQty, leg.pool.kind === 'perp' ? leg.pool.base : (leg.pool.collateral ?? leg.pool.base))} to…`}
      candidates={[leg]}
      onClose={onClose}
      onConfirm={(spec) => onEnroll(sid, spec)}
      destinations={{ options: strategies, value: sid, onChange: setSid }}
      bankedUsdByLeg={dest?.bankedUsdByLeg}
      minT={dest?.startedAt ?? undefined}
    />
  );
}
