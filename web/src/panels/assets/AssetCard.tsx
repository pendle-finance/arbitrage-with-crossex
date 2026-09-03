/**
 * One asset's card: hedge status ("what's missing for a perfect hedge"),
 * lifetime PnL / capital / approximate APR, the live legs with per-leg
 * exclusion controls, and a breakdown of where the PnL came from.
 *
 * All numbers arrive derived (assetModel.ts) — this file only renders.
 */
import { useState } from 'react';
import type { AssetBorosOpen, AssetGroup, AssetPerpOpen } from '../../api/types';
import { Chip } from '../../components/Chip';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, prettyVenue } from '../../lib/fmt';
import {
  borosKey,
  excludedFraction,
  perpKey,
  type AssetDerived,
  type Exclusions,
  type HedgeGapRow,
} from './assetModel';

interface Props {
  group: AssetGroup;
  derived: AssetDerived;
  exclusions: Exclusions;
  /** value: excluded qty in the leg's unit, 'all', or undefined to clear. */
  onExclude: (key: string, value: number | 'all' | undefined) => void;
}

const sizeLabel = (size: number, unit: 'base' | 'usd', base: string): string =>
  unit === 'base' ? fmtTokenQty(size, base) : fmtUsdCompact(size);

function GapRow({ gap, base }: { gap: HedgeGapRow; base: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
      <span className="font-semibold">{prettyVenue(gap.venue)}</span>
      <span>
        add{' '}
        <span className="num font-semibold">
          {gap.action === 'long-boros' ? 'LONG' : 'SHORT'} {sizeLabel(gap.size, gap.unit, base)}
        </span>{' '}
        YU on Boros to cover the floating leg
      </span>
    </div>
  );
}

/** The last cell of a leg row: exclude all / part / undo. */
function ExcludeCell({
  exKey,
  legQty,
  unit,
  exclusions,
  onExclude,
}: {
  exKey: string;
  legQty: number;
  unit: string;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
}) {
  const current = exclusions[exKey];
  const [draft, setDraft] = useState('');
  if (current === 'all') {
    return (
      <button
        type="button"
        className="btn-ghost-xs text-amber-400"
        title="This leg is excluded from the farm — click to count it again"
        onClick={() => onExclude(exKey, undefined)}
      >
        excluded — undo
      </button>
    );
  }
  return (
    <span className="flex items-center justify-end gap-1">
      <input
        className="input w-24 px-2 py-1 text-right text-xs"
        inputMode="decimal"
        placeholder={current !== undefined ? String(current) : `part (${unit})`}
        value={draft}
        title={`Exclude part of this leg: quantity in ${unit} that is NOT part of the farm`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (draft === '') return;
          if (Number.isFinite(n) && n > 0) onExclude(exKey, Math.min(n, legQty));
          else onExclude(exKey, undefined);
          setDraft('');
        }}
      />
      {current !== undefined && (
        <button
          type="button"
          className="btn-ghost-xs text-amber-400"
          title={`${current} ${unit} excluded — click to clear`}
          onClick={() => onExclude(exKey, undefined)}
        >
          ↩
        </button>
      )}
      <button
        type="button"
        className="btn-ghost-xs"
        title="Exclude this whole leg from the farm (hedge status, PnL and capital)"
        onClick={() => onExclude(exKey, 'all')}
      >
        ✕
      </button>
    </span>
  );
}

function PerpRow({
  leg,
  base,
  exclusions,
  onExclude,
}: {
  leg: AssetPerpOpen;
  base: string;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
}) {
  const key = perpKey(leg.symbol);
  const exFrac = excludedFraction(exclusions, key, leg.qty);
  return (
    <tr className={exFrac >= 1 ? 'opacity-40' : ''}>
      <td className="text-ink-300">{prettyVenue(leg.venue)}</td>
      <td>
        <span className="text-ink-200">Perp</span>{' '}
        <Chip sm tone={leg.side === 'LONG' ? 'green' : 'red'}>
          {leg.side}
        </Chip>
      </td>
      <td className="num text-right">
        {fmtTokenQty(leg.qty, base)}
        <span className="ml-1 text-ink-500">({fmtUsdCompact(leg.notionalUsd)})</span>
        {exFrac > 0 && exFrac < 1 && (
          <span className="ml-1 text-amber-400" title="Part of this leg is excluded from the farm">
            −{fmtTokenQty(exFrac * leg.qty, base)}
          </span>
        )}
      </td>
      <td className="num text-right text-ink-400">
        {leg.entryPrice > 0 && leg.markPrice > 0
          ? `${fmtUsd(leg.entryPrice)} → ${fmtUsd(leg.markPrice)}`
          : '—'}
      </td>
      <td className="num text-right">
        <SignedNumber value={leg.fundingUsd} format={fmtUsd} />
      </td>
      <td className="num text-right">
        <SignedNumber value={leg.upnlUsd} format={fmtUsd} />
      </td>
      <td className="num text-right text-ink-400">{fmtUsd(leg.imUsd)}</td>
      <td className="text-right">
        <ExcludeCell
          exKey={key}
          legQty={leg.qty}
          unit={base}
          exclusions={exclusions}
          onExclude={onExclude}
        />
      </td>
    </tr>
  );
}

function BorosRow({
  leg,
  exclusions,
  onExclude,
}: {
  leg: AssetBorosOpen;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
}) {
  const key = borosKey(leg.marketId);
  const exFrac = excludedFraction(exclusions, key, leg.sizeToken);
  return (
    <tr className={exFrac >= 1 ? 'opacity-40' : ''}>
      <td className="text-ink-300">{prettyVenue(leg.venue)}</td>
      <td>
        <span className="text-ink-200">YU</span>{' '}
        <Chip sm tone={leg.side === 'LONG' ? 'green' : 'red'}>
          {leg.side}
        </Chip>
        <span className="ml-1 text-xs text-ink-500" title="Maturity — coverage lapses here; the position itself just settles and ends">
          {fmtDateLocal(leg.maturity)}
        </span>
      </td>
      <td className="num text-right">
        {fmtTokenQty(leg.sizeToken, leg.collateral)}
        <span className="ml-1 text-ink-500">({fmtUsdCompact(leg.notionalUsd)})</span>
        {exFrac > 0 && exFrac < 1 && (
          <span className="ml-1 text-amber-400" title="Part of this leg is excluded from the farm">
            −{fmtTokenQty(exFrac * leg.sizeToken, leg.collateral)}
          </span>
        )}
      </td>
      <td className="num text-right text-ink-400">
        {fmtPct(leg.entryApr)} → {fmtPct(leg.markApr)}
      </td>
      <td className="num text-right" title="Cumulative settlement of the current position (already inside the asset's Boros settlement total)">
        <SignedNumber value={leg.settleUsd} format={fmtUsd} />
      </td>
      <td className="num text-right text-ink-400" title="Mark value of the remaining rate stream — informational, not in the headline PnL">
        <SignedNumber value={leg.mtmUsd} format={fmtUsd} />
      </td>
      <td className="num text-right text-ink-400">{fmtUsd(leg.imUsd)}</td>
      <td className="text-right">
        <ExcludeCell
          exKey={key}
          legQty={leg.sizeToken}
          unit={leg.collateral}
          exclusions={exclusions}
          onExclude={onExclude}
        />
      </td>
    </tr>
  );
}

export function AssetCard({ group, derived, exclusions, onExclude }: Props) {
  const { totals, gaps, venues } = derived;
  const hasLegs = group.perpOpen.length > 0 || group.borosOpen.length > 0;
  const expiring = venues.filter((v) => v.expiresSoon);

  // One visual block per venue: perp rows then Boros rows.
  const venueOrder = venues.map((v) => v.venue);
  const orderOf = (venue: string): number => {
    const i = venueOrder.indexOf(venue);
    return i === -1 ? venueOrder.length : i;
  };
  const perpSorted = [...group.perpOpen].sort((a, b) => orderOf(a.venue) - orderOf(b.venue));
  const borosSorted = [...group.borosOpen].sort((a, b) => orderOf(a.venue) - orderOf(b.venue));

  return (
    <div className="card p-4">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-ink-600 px-2 py-0.5 text-sm font-semibold text-ink-100">
          {group.base}
        </span>
        {group.priceUsd > 0 && <span className="num text-xs text-ink-500">{fmtUsd(group.priceUsd)}</span>}
        {hasLegs &&
          (derived.perfect ? (
            <Chip sm tone="green" title="Perps cancel each other's price risk and every venue's floating funding is covered by a Boros leg">
              hedged ✓
            </Chip>
          ) : (
            <Chip sm tone="amber">
              {(derived.deltaNeutral ? 0 : 1) + gaps.length} to fix
            </Chip>
          ))}
        <span className="ml-auto" />
        {derived.clockStartSec !== null && (
          <span className="text-xs text-ink-500" title="The APR clock: your start date, or the asset's earliest recorded activity">
            since {fmtDateLocal(derived.clockStartSec)}
          </span>
        )}
      </div>

      {/* Hero */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500">PnL</div>
          <div className="num text-lg font-semibold">
            <SignedNumber value={totals.pnlUsd} format={fmtUsd} />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="Initial margin currently required across every counted leg">
            Capital
          </div>
          <div className="num text-lg font-semibold text-ink-200">{fmtUsd(totals.capitalUsd)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="PnL over current capital, annualized since the clock start — approximate: capital is today's requirement, not a time-weighted history">
            APR ≈
          </div>
          <div className="num text-lg font-semibold">
            {derived.aprEst !== null ? <SignedNumber value={derived.aprEst} format={fmtPct} /> : '—'}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="Mark value of the open Boros rate streams. Converges to zero at maturity — shown for context, excluded from PnL">
            Boros MtM
          </div>
          <div className="num text-lg text-ink-400">
            <SignedNumber value={totals.mtmUsd} format={fmtUsd} />
          </div>
        </div>
      </div>

      {/* Hedge status */}
      {hasLegs && (
        <div className="mb-3 flex flex-col gap-1.5">
          {!derived.deltaNeutral && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
              <span className="font-semibold">Perps don’t cancel</span>
              <span>
                net{' '}
                <span className="num font-semibold">
                  {derived.netPerp > 0 ? 'LONG' : 'SHORT'}{' '}
                  {sizeLabel(Math.abs(derived.netPerp), venues[0]?.unit ?? 'usd', group.base)}
                </span>{' '}
                across venues — price risk is live
              </span>
            </div>
          )}
          {gaps.map((g) => (
            <GapRow key={g.venue} gap={g} base={group.base} />
          ))}
          {expiring.map((v) => (
            <div
              key={v.venue}
              className="flex items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-400"
            >
              <span className="font-semibold">{prettyVenue(v.venue)}</span>
              <span>
                Boros coverage starts maturing {fmtDateLocal(v.soonestMaturity)} — roll it to stay
                hedged
              </span>
            </div>
          ))}
          {derived.perfect && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-400">
              Perfect hedge: perps cancel and every venue’s floating leg is covered.
            </div>
          )}
        </div>
      )}

      {/* Legs */}
      {hasLegs ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:font-semibold">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-600">
                <th className="text-left">Venue</th>
                <th className="text-left">Leg</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry → Mark</th>
                <th className="text-right">Funding / Settled</th>
                <th className="text-right">uPnL / MtM</th>
                <th className="text-right">IM</th>
                <th className="text-right"> </th>
              </tr>
            </thead>
            <tbody>
              {perpSorted.map((l) => (
                <PerpRow
                  key={l.symbol}
                  leg={l}
                  base={group.base}
                  exclusions={exclusions}
                  onExclude={onExclude}
                />
              ))}
              {borosSorted.map((l) => (
                <BorosRow key={l.marketId} leg={l} exclusions={exclusions} onExclude={onExclude} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-ink-700 px-3 py-3 text-center text-sm text-ink-500">
          No open legs — the totals above are history since the start date.
        </p>
      )}

      {/* Breakdown */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink-500">
          PnL breakdown
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          {(
            [
              ['Perp uPnL (open)', totals.breakdown.perpUpnlUsd],
              ['Perp funding (open)', totals.breakdown.perpFundingUsd],
              ['Perp fees (open)', -totals.breakdown.perpFeesUsd],
              ['Closed perps (PnL + funding − fees)', totals.breakdown.perpClosedPnlUsd],
              ['Boros settlements (net of fees)', totals.breakdown.borosSettleUsd],
              ['Boros trade PnL (net of fees)', totals.breakdown.borosTradePnlUsd],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-ink-500">{label}</span>
              <span className="num">
                <SignedNumber value={v} format={fmtUsd} />
              </span>
            </div>
          ))}
        </div>
        {(group.perpClosed.length > 0 || group.borosHistory.length > 0) && (
          <div className="mt-2 flex flex-col gap-1 text-xs text-ink-500">
            {group.perpClosed.map((r) => (
              <div key={r.symbol} className="flex items-baseline justify-between gap-2">
                <span>
                  {prettyVenue(r.venue)} · {r.count} closed position{r.count === 1 ? '' : 's'}
                  {r.lastClosedAt !== null && ` (last ${fmtDateLocal(r.lastClosedAt)})`}
                  {exclusions[perpKey(r.symbol)] === 'all' && ' — excluded'}
                </span>
                <span className="num">
                  <SignedNumber
                    value={r.closedPnlUsd + r.fundingUsd - r.feesUsd}
                    format={fmtUsd}
                  />
                </span>
              </div>
            ))}
            {group.borosHistory.map((h) => (
              <div key={h.marketId} className="flex items-baseline justify-between gap-2">
                <span>
                  {prettyVenue(h.venue)} · Boros {fmtDateLocal(h.maturity)}
                  {exclusions[borosKey(h.marketId)] === 'all' && ' — excluded'}
                </span>
                <span className="num">
                  <SignedNumber value={h.settleUsd + h.tradePnlUsd} format={fmtUsd} />
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-ink-600">
          Partial exclusions scale the open legs only; closed positions and Boros history are
          dropped only by excluding the whole leg. Open-position funding and fees are the venue’s
          whole-position numbers, so a position opened before the start date counts in full.
        </p>
      </details>
    </div>
  );
}
