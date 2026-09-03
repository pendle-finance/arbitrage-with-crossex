/**
 * PREVIEW: the ASSET-GROUPED tracking home. One card per underlying asset
 * (ETH, BTC, …) — no strategies, no enrollment, no rollover lifecycle:
 *
 *   1. Hedge status: what's missing, per venue, for a perfect hedge — and
 *      per-leg exclusions for positions that aren't part of the farm.
 *   2. Lifetime PnL + capital since a user-chosen start date, from the
 *      venues' own records (open positions live, closed ones from history).
 *
 * Durable state is ONLY `crossex.assetView.v1` (start date + exclusions);
 * every number is a pure function of the venue feeds.
 */
import { useMemo, useState } from 'react';
import { useAssetView } from '../../api/queries';
import { Chip } from '../../components/Chip';
import { EmptyState } from '../../components/EmptyState';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtDateLocal, fmtPct, fmtUsd } from '../../lib/fmt';
import { useBookId } from '../bookId';
import { AddressForm, short } from '../HomeControls';
import { useTrackedAddress } from '../trackedAddress';
import { deriveAsset, SECONDS_IN_YEAR } from './assetModel';
import { loadPrefs, savePrefs, type AssetViewPrefs } from './assetPrefsStore';
import { AssetCard } from './AssetCard';

interface Props {
  onExit: () => void;
}

/** Unix seconds → the value an <input type="date"> wants (local). */
const toDateInput = (sec: number): string => {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function AssetsHome({ onExit }: Props) {
  const { address, setAddress } = useTrackedAddress();
  const bookId = useBookId(address);

  const [prefs, setPrefs] = useState<AssetViewPrefs>(() => loadPrefs(bookId));
  // A book switch swaps the whole prefs record — reload, don't carry over.
  const [prefsBook, setPrefsBook] = useState(bookId);
  if (prefsBook !== bookId) {
    setPrefsBook(bookId);
    setPrefs(loadPrefs(bookId));
  }
  const update = (next: AssetViewPrefs) => {
    savePrefs(bookId, next);
    setPrefs(next);
  };

  const query = useAssetView(address, prefs.sinceSec);
  const data = query.data;

  const allDerived = useMemo(
    () =>
      (data?.assets ?? []).map((g) => ({
        group: g,
        derived: deriveAsset(g, prefs.exclusions, data?.sinceSec ?? 0, data?.nowSec ?? 0),
      })),
    [data, prefs.exclusions],
  );
  // Dust fold: an asset with nothing open and a negligible history total is
  // real (the sums keep it) but not worth a card — one muted line names them.
  const derived = allDerived.filter(
    (a) =>
      a.group.perpOpen.length > 0 ||
      a.group.borosOpen.length > 0 ||
      Math.abs(a.derived.totals.pnlUsd) >= 1,
  );
  const dust = allDerived.filter((a) => !derived.includes(a));

  const totalPnl = derived.reduce((s, a) => s + a.derived.totals.pnlUsd, 0);
  const totalCapital = derived.reduce((s, a) => s + a.derived.totals.capitalUsd, 0);
  // Blended APR: Σpnl over Σ(capital · its own elapsed clock) — each asset
  // keeps its clock, so a young asset doesn't dilute an old one's rate.
  const capitalYears = derived.reduce((s, a) => {
    const d = a.derived;
    if (d.clockStartSec === null || !data) return s;
    return s + d.totals.capitalUsd * ((data.nowSec - d.clockStartSec) / SECONDS_IN_YEAR);
  }, 0);
  const blendedApr = capitalYears > 0 ? totalPnl / capitalYears : null;
  const gapCount = derived.reduce(
    (s, a) => s + a.derived.gaps.length + (a.derived.deltaNeutral ? 0 : 1),
    0,
  );

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
        Funding farm by asset
      </h2>
      <Chip
        tone="violet"
        sm
        title="Preview of the asset-grouped tracking model — every leg grouped by its underlying asset; PnL and capital are the venues' own lifetime numbers since your start date. Stores only the start date and exclusions; the classic view is untouched; nothing here places orders."
      >
        asset view (preview)
      </Chip>
      {address && <span className="num text-xs text-ink-500">{short(address)}</span>}
      <span className="ml-auto" />
      <label className="flex items-center gap-1.5 text-xs text-ink-500">
        since
        <input
          type="date"
          className="input w-36 px-2 py-1 text-xs"
          value={prefs.sinceSec > 0 ? toDateInput(prefs.sinceSec) : ''}
          max={toDateInput(Math.floor(Date.now() / 1000))}
          title="Count PnL from this date (local midnight). Empty = all time."
          onChange={(e) => {
            const v = e.target.value;
            const sec = v ? Math.floor(new Date(`${v}T00:00`).getTime() / 1000) : 0;
            update({ ...prefs, sinceSec: Number.isFinite(sec) && sec > 0 ? sec : 0 });
          }}
        />
        {prefs.sinceSec > 0 && (
          <button
            type="button"
            className="btn-ghost-xs"
            onClick={() => update({ ...prefs, sinceSec: 0 })}
          >
            all time
          </button>
        )}
      </label>
      <button type="button" className="btn-ghost-xs" onClick={onExit}>
        ← Back to classic view
      </button>
    </div>
  );

  if (!address) {
    return (
      <section>
        {header}
        <EmptyState
          icon="✦"
          title="Track an address to see your farm by asset"
          hint="The asset view groups every perp and Boros leg by its underlying coin and reports the venues' own lifetime numbers."
          action={<AddressForm submitLabel="Track" onTrack={setAddress} />}
        />
      </section>
    );
  }

  if (query.isError) {
    return (
      <section>
        {header}
        <QueryError title="Couldn't load the asset view" error={query.error} onRetry={() => query.refetch()} />
      </section>
    );
  }

  if (!data) {
    return (
      <section>
        {header}
        <TableSkeleton rows={6} cols={5} />
      </section>
    );
  }

  const coverageNotes: string[] = [];
  if (data.coverage.settlementsFromSec > 0) {
    coverageNotes.push(
      `Boros settlement history could only be read back to ${fmtDateLocal(data.coverage.settlementsFromSec)} — older settlements are missing from the sums.`,
    );
  }
  if (data.coverage.perpClosedFromSec > 0) {
    coverageNotes.push(
      `Closed-position history could only be read back to ${fmtDateLocal(data.coverage.perpClosedFromSec)} — older closed positions are missing from the sums.`,
    );
  }
  if (!data.coverage.borosTxnsComplete) {
    coverageNotes.push(
      'Boros trade history came back truncated — trade PnL sums may be missing old fills.',
    );
  }

  return (
    <section>
      {header}

      {/* Totals strip */}
      <div className="card mb-3 flex flex-wrap items-center gap-x-8 gap-y-2 p-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500">Total PnL</div>
          <div className="num text-xl font-semibold">
            <SignedNumber value={totalPnl} format={fmtUsd} />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500">Capital at work</div>
          <div className="num text-xl font-semibold text-ink-200">{fmtUsd(totalCapital)}</div>
        </div>
        <div>
          <div
            className="text-xs uppercase tracking-wider text-ink-500"
            title="Σ PnL over Σ (capital × each asset's own elapsed time), annualized — approximate: capital is today's requirement"
          >
            APR ≈
          </div>
          <div className="num text-xl font-semibold">
            {blendedApr !== null ? <SignedNumber value={blendedApr} format={fmtPct} /> : '—'}
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs uppercase tracking-wider text-ink-500">Hedge</div>
          {gapCount === 0 ? (
            <Chip tone="green">all covered ✓</Chip>
          ) : (
            <Chip tone="amber">
              {gapCount} thing{gapCount === 1 ? '' : 's'} to fix
            </Chip>
          )}
        </div>
      </div>

      {[...data.warnings, ...coverageNotes].map((w) => (
        <p
          key={w}
          className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400"
        >
          {w}
        </p>
      ))}

      {derived.length === 0 ? (
        <EmptyState
          icon="◦"
          title="No positions or history found for this address"
          hint="Open a position (or move the start date back) and the assets will appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {derived.map(({ group, derived: d }) => (
            <AssetCard
              key={group.base}
              group={group}
              derived={d}
              exclusions={prefs.exclusions}
              onExclude={(key, value) => {
                const exclusions = { ...prefs.exclusions };
                if (value === undefined) delete exclusions[key];
                else exclusions[key] = value;
                update({ ...prefs, exclusions });
              }}
            />
          ))}
          {dust.length > 0 && (
            <p className="text-xs text-ink-600">
              {dust.length} more asset{dust.length === 1 ? '' : 's'} with nothing open and under $1
              of history (
              {dust
                .map(
                  (a) => `${a.group.base} ${a.derived.totals.pnlUsd < 0 ? '−' : '+'}$${Math.abs(a.derived.totals.pnlUsd).toFixed(2)}`,
                )
                .join(' · ')}
              ) — included in the totals above.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
