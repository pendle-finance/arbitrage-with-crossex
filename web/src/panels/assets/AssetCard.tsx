/**
 * One asset's card: hedge status ("what's missing for a perfect hedge"),
 * lifetime PnL / capital / approximate APR, the live legs with per-leg
 * exclusion controls, and a breakdown of where the PnL came from.
 *
 * All numbers arrive derived (assetModel.ts) — this file only renders.
 */
import { useState } from 'react';
import { Modal } from '../../components/Modal';
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
import { AssetBars } from './AssetBars';

interface Props {
  group: AssetGroup;
  derived: AssetDerived;
  /** THIS asset's window start (0 = all time) — per asset, not app-wide. */
  sinceSec: number;
  /** True while a newly-chosen window's fetch is still in flight (the
   * all-time numbers stand in meanwhile). */
  windowPending: boolean;
  onChangeSince: (sec: number) => void;
  exclusions: Exclusions;
  /** value: excluded qty in the leg's unit, 'all', or undefined to clear. */
  onExclude: (key: string, value: number | 'all' | undefined) => void;
}

/** Unix seconds → the value an <input type="date"> wants (local). */
const toDateInput = (sec: number): string => {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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
      <td
        className="num text-right"
        title={`uPnL ${fmtUsd(leg.upnlUsd)} · fees ${fmtUsd(leg.feesUsd)} · IM ${fmtUsd(leg.imUsd)}`}
      >
        <SignedNumber value={leg.fundingUsd} format={fmtUsd} />
      </td>
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
  windowedGrossUsd,
  exclusions,
  onExclude,
}: {
  leg: AssetBorosOpen;
  /** This market's settle+trade GROSS inside the window — the exact number
   * that feeds PnL (the leg's own cumulative is a different window). Split
   * kept for the tooltip: a PARTIAL close's trade PnL rides here. */
  windowedGrossUsd: { gross: number; settle: number; trade: number } | null;
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
      <td
        className="num text-right"
        title={
          windowedGrossUsd === null
            ? `No settlements or trades inside this window · MtM ${fmtUsd(leg.mtmUsd)} · IM ${fmtUsd(leg.imUsd)}`
            : `Inside your window, GROSS of fees (fees sit in the Boros-fees line): settle ${fmtUsd(windowedGrossUsd.settle)} · trade ${fmtUsd(windowedGrossUsd.trade)} (a partial close's trade PnL rides here). Position-lifetime settled ${fmtUsd(leg.settleUsd)} · MtM ${fmtUsd(leg.mtmUsd)} · IM ${fmtUsd(leg.imUsd)}`
        }
      >
        {windowedGrossUsd === null ? (
          <span className="text-ink-600">—</span>
        ) : (
          <SignedNumber value={windowedGrossUsd.gross} format={fmtUsd} />
        )}
      </td>
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

export function AssetCard({ group, derived, sinceSec, windowPending, onChangeSince, exclusions, onExclude }: Props) {
  const { totals, gaps, venues } = derived;
  const [feesOpen, setFeesOpen] = useState(false);
  const hasLegs = group.perpOpen.length > 0 || group.borosOpen.length > 0;
  const expiring = venues.filter((v) => v.expiresSoon);

  // One visual block per venue: perp rows then Boros rows.
  const venueOrder = venues.map((v) => v.venue);
  const orderOf = (venue: string): number => {
    const i = venueOrder.indexOf(venue);
    return i === -1 ? venueOrder.length : i;
  };
  const histByMarket = new Map(group.borosHistory.map((h) => [h.marketId, h]));
  // Mirror the model: a market matured before the window neither shows nor
  // counts (assetModel filters it out of hedge/capital too).
  const borosVisible =
    sinceSec > 0 ? group.borosOpen.filter((l) => l.maturity >= sinceSec) : group.borosOpen;
  const perpSorted = [...group.perpOpen].sort((a, b) => orderOf(a.venue) - orderOf(b.venue));
  const borosSorted = [...borosVisible].sort((a, b) => orderOf(a.venue) - orderOf(b.venue));

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
        {windowPending && <span className="text-xs text-ink-600">updating window…</span>}
        <label className="flex items-center gap-1.5 text-xs text-ink-500">
          since
          <input
            type="date"
            className="input w-32 px-2 py-1 text-xs"
            value={sinceSec > 0 ? toDateInput(sinceSec) : ''}
            max={toDateInput(Math.floor(Date.now() / 1000))}
            title={`Count THIS asset's PnL from this date (local midnight). Empty = all time${derived.clockStartSec !== null ? ` — activity starts ${fmtDateLocal(derived.clockStartSec)}` : ''}.`}
            onChange={(e) => {
              const v = e.target.value;
              const sec = v ? Math.floor(new Date(`${v}T00:00`).getTime() / 1000) : 0;
              onChangeSince(Number.isFinite(sec) && sec > 0 ? sec : 0);
            }}
          />
          {sinceSec > 0 && (
            <button type="button" className="btn-ghost-xs" onClick={() => onChangeSince(0)}>
              all time
            </button>
          )}
        </label>
      </div>

      {/* Hero — exactly what he asked to know: PnL (ROI in brackets),
          the CURRENT locked APR, and capital. Carry lives on the stats
          strip below; nothing else competes up here. */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="Lifetime PnL since the start date (ROI = PnL over current capital, in brackets)">
            PnL
          </div>
          <div className="num text-lg font-semibold">
            <SignedNumber value={totals.pnlUsd} format={fmtUsd} />
            {derived.roi !== null && (
              <span className="ml-1.5 text-sm text-ink-400">
                (<SignedNumber value={derived.roi} format={fmtPct} className="!text-ink-400" />)
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="The rate the hedge locks RIGHT NOW: on covered venues the floating sides cancel, leaving each Boros leg's fixed side — deterministic while the hedge holds. Steps down as legs mature (maturities differ per leg). Dash = the hedge isn't complete.">
            Current APR
          </div>
          <div className="num text-lg font-semibold">
            {derived.lockedAprFwd !== null ? (
              <SignedNumber value={derived.lockedAprFwd} format={fmtPct} />
            ) : (
              '—'
            )}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="Initial margin currently required across every counted leg">
            Capital
          </div>
          <div className="num text-lg font-semibold text-ink-200">{fmtUsd(totals.capitalUsd)}</div>
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
                <BorosRow
                  key={l.marketId}
                  leg={l}
                  windowedGrossUsd={(() => {
                    const h = histByMarket.get(l.marketId);
                    if (!h) return null;
                    const settle = h.settleUsd + h.settleFeeUsd;
                    const trade = h.tradePnlUsd + h.tradeFeeUsd;
                    return { gross: settle + trade, settle, trade };
                  })()}
                  exclusions={exclusions}
                  onExclude={onExclude}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-ink-700 px-3 py-3 text-center text-sm text-ink-500">
          No open legs — the totals above are history since the start date.
        </p>
      )}

      {/* Breakdown: the strip (price package + fee aggregates), the
          waterfall, and a fees pop-up with the per-venue / per-market rows. */}
      {/* The cost line: PnL = all funding/settlement, minus these three. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-400">
        <span>
          Perp fees <span className="num text-ink-300">{fmtUsd(totals.perpFeesAllUsd)}</span>
        </span>
        <span>
          Boros fees <span className="num text-ink-300">{fmtUsd(totals.borosFeesAllUsd)}</span>
        </span>
        <span title="Open perp uPnL + closed positions' realized price PnL — a delta-neutral book expects this near 0">
          Price slippage (perps){' '}
          <span className="num">
            <SignedNumber value={totals.priceResidualUsd} format={fmtUsd} />
          </span>
        </span>
        <button type="button" className="btn-ghost-xs" onClick={() => setFeesOpen(true)}>
          breakdown
        </button>
        <span className="ml-auto text-ink-600" title="Mark value of the open Boros rate streams — converges to zero at maturity; excluded from PnL">
          Boros MtM <span className="num"><SignedNumber value={totals.mtmUsd} format={fmtUsd} className="!text-ink-500" /></span>
        </span>
      </div>

      {(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        const completedPerps = group.perpClosed.flatMap((r) =>
          r.rows
            .filter((row) => row.complete)
            .map((row) => ({ ...row, symbol: r.symbol, venue: r.venue })),
        );
        const openMarketIds = new Set(group.borosOpen.map((l) => l.marketId));
        const doneBoros = group.borosHistory.filter(
          (h) => h.maturity < nowSec || !openMarketIds.has(h.marketId),
        );
        if (!completedPerps.length && !doneBoros.length) return null;
        const perpCarry = completedPerps.reduce(
          (t, r) => t + (r.dedupedIntoOpen ? 0 : r.fundingUsd),
          0,
        );
        const borosCarry = doneBoros.reduce(
          (t, h) => t + h.settleUsd + h.settleFeeUsd + h.tradePnlUsd + h.tradeFeeUsd,
          0,
        );
        const ribbon = (label: string, sub: string, carry: number, body: React.ReactNode) => (
          <details className="mt-2 overflow-hidden rounded-md border border-ink-700">
            <summary
              className="flex cursor-pointer flex-wrap items-center gap-2 bg-ink-950/60 px-3 py-2 text-xs hover:bg-ink-950"
              title="Carry contribution only — fees and price PnL are not repeated here; they sit in the fee and price-slippage lines."
            >
              <span className="font-semibold uppercase tracking-wider text-ink-300">{label}</span>
              <span className="text-ink-500">{sub}</span>
              <span className="ml-auto num">
                carry contribution{' '}
                <span className="text-sm font-semibold">
                  <SignedNumber value={carry} format={fmtUsd} />
                </span>
              </span>
            </summary>
            <div className="flex flex-col gap-0.5 p-2 pt-1 text-xs">{body}</div>
          </details>
        );
        return (
          <>
            {completedPerps.length > 0 &&
              ribbon(
                'Closed perps',
                `${completedPerps.length} position${completedPerps.length === 1 ? '' : 's'}`,
                perpCarry,
                completedPerps.map((row) => (
                  <div
                    key={`${row.symbol}:${row.closedAt}`}
                    className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-ink-950/40 px-3 py-1 text-ink-400"
                  >
                    <span className="text-ink-300">{prettyVenue(row.venue)}</span>
                    <span className="num">
                      {fmtTokenQty(row.qty, group.base)} · {fmtUsd(row.openPx)} → {fmtUsd(row.closePx)}
                    </span>
                    {row.closedAt !== null && (
                      <span className="text-ink-600">closed {fmtDateLocal(row.closedAt)}</span>
                    )}
                    <span className="ml-auto num">
                      {row.dedupedIntoOpen ? (
                        <span className="text-ink-600" title="This slice's funding/fees are booked on the surviving open row">
                          carry in open ↑
                        </span>
                      ) : (
                        <>
                          funding <SignedNumber value={row.fundingUsd} format={fmtUsd} />
                        </>
                      )}
                      <span className="text-ink-600" title="Already in their own strip lines — reference only">
                        {' '}· fees {fmtUsd(row.feesUsd)} → fees line · price{' '}
                        <SignedNumber value={row.priceUsd} format={fmtUsd} className="!text-ink-500" /> → slippage
                      </span>
                    </span>
                  </div>
                )),
              )}
            {doneBoros.length > 0 &&
              ribbon(
                'Completed Boros',
                `${doneBoros.length} market${doneBoros.length === 1 ? '' : 's'}`,
                borosCarry,
                doneBoros.map((h) => (
                  <div
                    key={h.marketId}
                    className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-ink-950/40 px-3 py-1 text-ink-400"
                  >
                    <span className="text-ink-300">{prettyVenue(h.venue)}</span>
                    <span className="text-ink-600">
                      {h.maturity < nowSec
                        ? `matured ${fmtDateLocal(h.maturity)}`
                        : `closed early (was ${fmtDateLocal(h.maturity)})`}
                    </span>
                    <span className="ml-auto num">
                      settle <SignedNumber value={h.settleUsd + h.settleFeeUsd} format={fmtUsd} />
                      {' '}· trade <SignedNumber value={h.tradePnlUsd + h.tradeFeeUsd} format={fmtUsd} />
                      <span className="text-ink-600" title="Inside the Boros-fees strip line — reference only">
                        {' '}· fees {fmtUsd(h.settleFeeUsd + h.tradeFeeUsd)} → fees line
                      </span>
                    </span>
                  </div>
                )),
              )}
          </>
        );
      })()}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink-500">
          PnL waterfall
        </summary>
        <AssetBars totals={totals} />
        <p className="mt-2 text-xs text-ink-600">
          Partial exclusions scale the open legs only; closed positions and Boros history are
          dropped only by excluding the whole leg. With a start date set, funding and fees are
          summed from the venue’s per-tick ledgers inside the window (a resize before the window
          counts only at post-resize size); without one they are the venue’s whole-position
          cumulatives.
        </p>
      </details>

      {feesOpen && (
        <Modal title={`${group.base} — fees & history breakdown`} onClose={() => setFeesOpen(false)} widthClass="w-[640px]">
          {(() => {
            const cell = 'px-2 py-1.5';
            const th = 'px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-600';
            const perpRows = [
              ...group.perpOpen.map((l) => ({
                key: `o:${l.symbol}`,
                venue: prettyVenue(l.venue),
                status: 'open',
                note: '',
                fundingUsd: l.fundingUsd as number | null,
                priceUsd: l.upnlUsd as number | null,
                priceIsUpnl: true,
                feesUsd: l.feesUsd,
                deduped: false,
                excluded: exclusions[perpKey(l.symbol)] === 'all',
              })),
              ...group.perpClosed.map((r) => ({
                key: `c:${r.symbol}`,
                venue: prettyVenue(r.venue),
                status: `${r.count} closed`,
                note: r.lastClosedAt !== null ? `last ${fmtDateLocal(r.lastClosedAt)}` : '',
                fundingUsd: (r.fundingUsd !== 0 ? r.fundingUsd : null) as number | null,
                priceUsd: r.closedPnlUsd as number | null,
                priceIsUpnl: false,
                feesUsd: r.feesUsd,
                deduped: r.dedupedIntoOpen === true,
                excluded: exclusions[perpKey(r.symbol)] === 'all',
              })),
            ];
            const perpTotals = perpRows.reduce(
              (t, r) => ({
                funding: t.funding + (r.excluded ? 0 : (r.fundingUsd ?? 0)),
                price: t.price + (r.excluded ? 0 : (r.priceUsd ?? 0)),
                fees: t.fees + (r.excluded ? 0 : r.feesUsd),
              }),
              { funding: 0, price: 0, fees: 0 },
            );
            const borosRows = group.borosHistory.map((h) => ({
              key: h.marketId,
              venue: prettyVenue(h.venue),
              maturity: fmtDateLocal(h.maturity),
              // GROSS of their own fees: an open-only market then shows ≈$0
              // trade PnL (the wire's net figure was really just the entry
              // fee), and all cost lives in the fee column once.
              settleUsd: h.settleUsd + h.settleFeeUsd,
              tradeUsd: h.tradePnlUsd + h.tradeFeeUsd,
              feesUsd: h.settleFeeUsd + h.tradeFeeUsd,
              excluded: exclusions[borosKey(h.marketId)] === 'all',
            }));
            const borosTotals = borosRows.reduce(
              (t, r) =>
                r.excluded
                  ? t
                  : { settle: t.settle + r.settleUsd, trade: t.trade + r.tradeUsd, fees: t.fees + r.feesUsd },
              { settle: 0, trade: 0, fees: 0 },
            );
            const dim = (ex: boolean) => (ex ? 'opacity-40' : '');
            return (
              <>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  Perps — by venue
                </p>
                {perpRows.length ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left">
                        <th className={th}>Venue</th>
                        <th className={th}>Position</th>
                        <th className={`${th} text-right`}>Funding</th>
                        <th className={`${th} text-right`}>Price PnL</th>
                        <th className={`${th} text-right`}>Fees</th>
                      </tr>
                    </thead>
                    <tbody className="num">
                      {perpRows.map((r) => (
                        <tr key={r.key} className={dim(r.excluded)}>
                          <td className={`${cell} text-ink-300`}>{r.venue}</td>
                          <td className={`${cell} text-xs text-ink-500`}>
                            {r.status}
                            {r.note && ` · ${r.note}`}
                            {r.excluded && ' · excluded'}
                          </td>
                          <td className={`${cell} text-right`}>
                            {r.fundingUsd === null ? (
                              <span
                                className="text-ink-600"
                                title={r.deduped ? 'Carried in the open position\u2019s cumulative funding above (split-position dedupe).' : undefined}
                              >
                                {r.deduped ? 'in open ↑' : '—'}
                              </span>
                            ) : (
                              <SignedNumber value={r.fundingUsd} format={fmtUsd} />
                            )}
                          </td>
                          <td
                            className={`${cell} text-right`}
                            title={r.priceIsUpnl ? 'Live uPnL — unrealized' : undefined}
                          >
                            {r.priceUsd === null ? (
                              <span className="text-ink-600">—</span>
                            ) : (
                              <SignedNumber value={r.priceUsd} format={fmtUsd} />
                            )}
                          </td>
                          <td className={`${cell} text-right text-ink-300`}>
                            {r.deduped ? (
                              <span
                                className="text-ink-600"
                                title="Not free — this venue reports whole-life fees and funding on the SURVIVING open position's row (the close's ~costs are inside the open line above); shown once to avoid double-counting."
                              >
                                in open ↑
                              </span>
                            ) : (
                              fmtUsd(r.feesUsd)
                            )}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t border-ink-700 font-semibold">
                        <td className={`${cell} text-xs uppercase tracking-wider text-ink-500`} colSpan={2}>
                          Total
                        </td>
                        <td className={`${cell} text-right`}>
                          <SignedNumber value={perpTotals.funding} format={fmtUsd} />
                        </td>
                        <td className={`${cell} text-right`}>
                          <SignedNumber value={perpTotals.price} format={fmtUsd} />
                        </td>
                        <td className={`${cell} text-right text-ink-200`}>{fmtUsd(perpTotals.fees)}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm text-ink-600">No perp activity in this window.</p>
                )}

                <p className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  Boros — by market
                </p>
                {borosRows.length ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left">
                        <th className={th}>Venue</th>
                        <th className={th}>Maturity</th>
                        <th className={`${th} text-right`}>Settlement</th>
                        <th className={`${th} text-right`}>Trade PnL</th>
                        <th className={`${th} text-right`}>Fees</th>
                      </tr>
                    </thead>
                    <tbody className="num">
                      {borosRows.map((r) => (
                        <tr key={r.key} className={dim(r.excluded)}>
                          <td className={`${cell} text-ink-300`}>{r.venue}</td>
                          <td className={`${cell} text-xs text-ink-500`}>
                            {r.maturity}
                            {r.excluded && ' · excluded'}
                          </td>
                          <td className={`${cell} text-right`}>
                            <SignedNumber value={r.settleUsd} format={fmtUsd} />
                          </td>
                          <td className={`${cell} text-right`}>
                            <SignedNumber value={r.tradeUsd} format={fmtUsd} />
                          </td>
                          <td className={`${cell} text-right text-ink-300`}>{fmtUsd(r.feesUsd)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-ink-700 font-semibold">
                        <td className={`${cell} text-xs uppercase tracking-wider text-ink-500`} colSpan={2}>
                          Total
                        </td>
                        <td className={`${cell} text-right`}>
                          <SignedNumber value={borosTotals.settle} format={fmtUsd} />
                        </td>
                        <td className={`${cell} text-right`}>
                          <SignedNumber value={borosTotals.trade} format={fmtUsd} />
                        </td>
                        <td className={`${cell} text-right text-ink-200`}>{fmtUsd(borosTotals.fees)}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm text-ink-600">No Boros activity in this window.</p>
                )}
                <p className="mt-3 text-[11px] text-ink-600">
                  Boros settlement and trade PnL are shown GROSS here; the fee column is what
                  subtracts (gross − fees = the card's net figures). Excluded legs are dimmed and
                  left out of the totals. Open perps' Price PnL is live uPnL.
                </p>
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}