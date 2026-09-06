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
  SECONDS_IN_YEAR,
  type AssetDerived,
  type Exclusions,
  type HedgeGapRow,
  type PairEstimate,
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

/**
 * The pair reconstruction popup: every attributed leg slice with its
 * windowed carry and paid fees, then a net with entry-fee / exit-fee
 * toggles. All slices are proportional estimates (shares by TODAY'S
 * sizes, not historical pairing) — stated in the modal.
 */
function PairModal({
  pair,
  base,
  onClose,
}: {
  pair: PairEstimate;
  base: string;
  onClose: () => void;
}) {
  const [inclPerpFees, setInclPerpFees] = useState(true);
  const [inclExitFee, setInclExitFee] = useState(false);
  const nowSec = Date.now() / 1000;
  const soonest = pair.soonestMaturitySec;
  // Fee → APR: one-off fees spread over the pair's FULL hedged life
  // (first-fully-hedged → soonest maturity), on the same capital base as
  // the locked APR. Falls back to the remaining term when no leg start is
  // known.
  const termYears =
    soonest > 0
      ? (soonest - (pair.hedgedSinceSec ?? nowSec)) / SECONDS_IN_YEAR
      : 0;
  const dragOf = (feeUsd: number): number | null =>
    termYears > 0 && pair.capitalUsd > 0 ? feeUsd / pair.capitalUsd / termYears : null;
  const borosDrag = dragOf(pair.borosFeesPaidUsd);
  const perpDrag = dragOf(pair.perpFeesPaidUsd);
  const exitDrag = dragOf(pair.exitFeeUsd);
  const netApr =
    pair.lockedAprFwd === null
      ? null
      : pair.lockedAprFwd -
        (borosDrag ?? 0) -
        (inclPerpFees ? (perpDrag ?? 0) : 0) -
        (inclExitFee ? (exitDrag ?? 0) : 0);
  const cell = 'px-2 py-1.5';
  const th = 'px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-600';
  return (
    <Modal
      title={`${prettyVenue(pair.longVenue)} long ⇄ ${prettyVenue(pair.shortVenue)} short — pair estimate`}
      onClose={onClose}
      widthClass="w-[560px]"
    >
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-400">
        <span>
          Size <span className="num text-ink-300">{fmtTokenQty(pair.size, base)}</span>
        </span>
        <span>
          Notional <span className="num text-ink-300">{fmtUsdCompact(pair.notionalUsd)}</span>
        </span>
        <span>
          Capital <span className="num text-ink-300">{fmtUsdCompact(pair.capitalUsd)}</span>
        </span>
        {pair.hedgedSinceSec !== null && (
          <span title="When the pair was first FULLY hedged — the latest of its legs' start times (perp open; Boros first settlement). Fee drags amortize from here to maturity.">
            Hedged <span className="num text-ink-300">{fmtDateLocal(pair.hedgedSinceSec)}</span>
          </span>
        )}
        {soonest > 0 && (
          <span>
            Matures{' '}
            <span className="num text-ink-300">
              {fmtDateLocal(soonest)} ({Math.ceil((soonest - nowSec) / 86400)}d)
            </span>
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className={th}>Venue</th>
            <th className={th}>Leg</th>
            <th className={`${th} text-right`}>Share</th>
            <th className={`${th} text-right`}>Size</th>
            <th className={`${th} text-right`} title="YU rows: the fixed rate this leg locks, signed by side (SHORT receives, LONG pays)">
              Locked
            </th>
            <th className={`${th} text-right`}>Fees paid</th>
          </tr>
        </thead>
        <tbody className="num">
          {pair.legs.map((l, i) => (
            <tr key={i}>
              <td className={`${cell} text-ink-300`}>{prettyVenue(l.venue)}</td>
              <td className={cell}>
                <span className="text-ink-200">{l.kind === 'perp' ? 'Perp' : 'YU'}</span>{' '}
                <Chip sm tone={l.side === 'LONG' ? 'green' : 'red'}>
                  {l.side}
                </Chip>
              </td>
              <td className={`${cell} text-right text-ink-500`}>
                {l.share >= 0.9995 ? 'all' : fmtPct(l.share)}
              </td>
              <td className={`${cell} text-right text-ink-400`}>{fmtTokenQty(l.size, base)}</td>
              <td className={`${cell} text-right`}>
                {l.lockedApr !== null ? (
                  <SignedNumber value={l.lockedApr} format={fmtPct} />
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </td>
              <td className={`${cell} text-right text-ink-300`}>{fmtUsd(l.feesUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-ink-800 p-3">
        <div className="flex items-baseline justify-between text-xs text-ink-400">
          <span title="Forward rate the pair's Boros legs lock, on the pair's capital — deterministic while the hedge holds">
            Locked APR
          </span>
          <span className="num text-ink-200">
            {pair.lockedAprFwd !== null ? (
              <SignedNumber value={pair.lockedAprFwd} format={fmtPct} />
            ) : (
              '—'
            )}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs text-ink-400">
          <span title="Boros settle + trade fees paid — structural, never excludable: the Boros side is held to maturity, so these always apply. Amortized over the pair's full hedged life.">
            Boros fees ({fmtUsd(pair.borosFeesPaidUsd)})
          </span>
          <span className="num text-ink-300">
            {borosDrag !== null ? `−${fmtPct(borosDrag)}` : '—'}
          </span>
        </div>
        <label className="flex cursor-pointer items-baseline justify-between gap-2 text-xs text-ink-400">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              className="chk"
              checked={inclPerpFees}
              onChange={(e) => setInclPerpFees(e.target.checked)}
            />
            <span title={`Perp trading fees already paid (${fmtUsd(pair.perpFeesPaidUsd)}), amortized over the pair's full hedged life`}>
              perp fees paid ({fmtUsd(pair.perpFeesPaidUsd)})
            </span>
          </span>
          <span className="num text-ink-300">
            {perpDrag !== null ? `−${fmtPct(perpDrag)}` : '—'}
          </span>
        </label>
        <label className="flex cursor-pointer items-baseline justify-between gap-2 text-xs text-ink-400">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              className="chk"
              checked={inclExitFee}
              onChange={(e) => setInclExitFee(e.target.checked)}
            />
            <span title={`Both perp legs closed at maturity at YOUR venues' taker rates (from the account's fee schedule where available; ${fmtUsd(pair.exitFeeUsd)}). The Boros legs mature on their own. Amortized over the pair's full hedged life.`}>
              est. exit fee ({fmtUsd(pair.exitFeeUsd)})
            </span>
          </span>
          <span className="num text-ink-300">
            {exitDrag !== null ? `−${fmtPct(exitDrag)}` : '—'}
          </span>
        </label>
        <div className="mt-1 flex items-baseline justify-between border-t border-ink-800 pt-2">
          <span className="text-xs uppercase tracking-wider text-ink-500">Net APR (est.)</span>
          <span className="num text-base font-semibold">
            {netApr !== null ? <SignedNumber value={netApr} format={fmtPct} /> : '—'}
          </span>
        </div>
      </div>
      <p
        className="mt-3 text-[11px] text-ink-600"
        title="The short side and its Boros legs are sliced by today's size proportions, not historical pairing. Dollar carry per pair is deliberately not shown: windowed funding mixes eras already settled by completed Boros legs."
      >
        Proportional split by today’s sizes — reference only.
      </p>
    </Modal>
  );
}

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
          {(() => {
            const days = Math.ceil((leg.maturity - Date.now() / 1000) / 86400);
            return days > 0 ? ` (${days}d)` : '';
          })()}
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
        {leg.floatingApr > 0 && (
          <div
            className="text-[10px] text-ink-500"
            title={`The venue's floating funding runs at ${fmtPct(leg.floatingApr)} right now vs the ${fmtPct(leg.entryApr)} fixed you locked. A SHORT YU (receive fixed) is winning while fixed > float; a LONG YU (pay fixed, receive float) while float > fixed. Your carry stays locked either way — this shows which side of today's market your lock is on.`}
          >
            float now {fmtPct(leg.floatingApr)}
          </div>
        )}
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
  const [pairOpen, setPairOpen] = useState<PairEstimate | null>(null);
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

  // Per-venue net carry: perp funding (open + kept-closed) + Boros settle &
  // trade (gross, open + completed) — the float-swap check a farmer runs per
  // venue: each venue's perp funding and YU stream should roughly net to its
  // fixed leg. Pure regrouping of the table + ribbon numbers, no estimation.
  const venueCarry = (() => {
    const m = new Map<string, number>();
    const add = (v: string, x: number) => m.set(v, (m.get(v) ?? 0) + x);
    for (const l of group.perpOpen) {
      const keep = 1 - excludedFraction(exclusions, perpKey(l.symbol), l.qty);
      if (keep > 0) add(l.venue, l.fundingUsd * keep);
    }
    for (const r of group.perpClosed) {
      if (exclusions[perpKey(r.symbol)] !== 'all') add(r.venue, r.fundingUsd);
    }
    for (const h of group.borosHistory) {
      if (exclusions[borosKey(h.marketId)] !== 'all') {
        add(h.venue, h.settleUsd + h.settleFeeUsd + h.tradePnlUsd + h.tradeFeeUsd);
      }
    }
    return [...m.entries()].sort(
      (a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]),
    );
  })();

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
          <button
            type="button"
            className="num text-left text-lg font-semibold hover:opacity-80"
            title={`Click for the full breakdown. Carry − fees ${fmtUsd(totals.pnlUsd - totals.priceResidualUsd)} (settled — doesn't move with the tick) + price basis ${fmtUsd(totals.priceResidualUsd)} (open marks ${fmtUsd(totals.breakdown.perpUpnlUsd)} + closed realized price ${fmtUsd(totals.priceResidualUsd - totals.breakdown.perpUpnlUsd)} — the two sides of the hedge; expected near 0 on a delta-neutral book, and the only part that breathes with the market).`}
            onClick={() => setFeesOpen(true)}
          >
            <SignedNumber value={totals.pnlUsd} format={fmtUsd} />
            {derived.roi !== null && (
              <span className="ml-1.5 text-sm text-ink-400">
                (<SignedNumber value={derived.roi} format={fmtPct} className="!text-ink-400" />)
              </span>
            )}
          </button>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500" title="The rate the hedge locks RIGHT NOW: on covered venues the floating sides cancel, leaving each Boros leg's fixed side — deterministic while the hedge holds. Steps down as legs mature (maturities differ per leg). Dash = the hedge isn't complete.">
            Current APR (locked)
          </div>
          <div className="num text-lg font-semibold">
            {derived.lockedAprFwd !== null ? (
              <SignedNumber value={derived.lockedAprFwd} format={fmtPct} />
            ) : (
              '—'
            )}
          </div>
          {derived.lockedCarryPerYearUsd !== null && (
            <div
              className="num text-[11px] text-ink-500"
              title={`The locked rate in dollars per day at today's notionals — deterministic while the hedge holds; steps down as legs mature.${derived.lockedNotionalUsd !== null ? ` Quoted on the Boros legs' notional it is ${fmtPct(derived.lockedCarryPerYearUsd / derived.lockedNotionalUsd)} on ${fmtUsdCompact(derived.lockedNotionalUsd)} (the cross-farm comparison basis; the headline % is on margin, which leverage inflates).` : ''}`}
            >
              ≈ <SignedNumber value={derived.lockedCarryPerYearUsd / 365} format={fmtUsd} className="!text-ink-400" />
              /day
            </div>
          )}
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
            <div
              className="flex items-baseline gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-400"
              title="Perps cancel each other's price risk (within the 2% tolerance — the residual shown is live exposure, not zero) and every venue's floating funding is covered by a Boros leg."
            >
              <span>Perfect hedge — every floating leg covered</span>
              {derived.grossPerp > 0 && derived.netPerp !== 0 && (
                <span className="num ml-auto text-emerald-500/80">
                  net {derived.netPerp > 0 ? 'LONG' : 'SHORT'}{' '}
                  {sizeLabel(Math.abs(derived.netPerp), venues[0]?.unit ?? 'usd', group.base)}
                  {venues[0]?.unit === 'base' && group.priceUsd > 0
                    ? ` ≈ ${fmtUsdCompact(Math.abs(derived.netPerp) * group.priceUsd)}`
                    : ''}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pairs (rough) — the per-pair view: locked APR up front, the full
          reconstruction (per-leg carry/fees + entry/exit-fee toggles)
          behind the details popup. */}
      {derived.pairs.length > 0 && (
        <div className="mb-3 rounded-md border border-ink-800 px-3 py-2">
          <div className="mb-1 flex flex-wrap items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              Pairs (est.)
            </span>
            <span className="text-[10px] text-ink-600">
              proportional split — reference only
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {derived.pairs.map((p) => (
              <div
                key={`${p.longVenue}:${p.shortVenue}`}
                className="flex flex-wrap items-baseline gap-x-3 text-sm"
              >
                <span className="text-ink-200">
                  {prettyVenue(p.longVenue)} <span className="text-ink-600">long</span> ⇄{' '}
                  {prettyVenue(p.shortVenue)} <span className="text-ink-600">short</span>
                </span>
                <span className="num text-xs text-ink-500">
                  {sizeLabel(p.size, p.unit, group.base)} · ntl {fmtUsdCompact(p.notionalUsd)} · cap{' '}
                  {fmtUsdCompact(p.capitalUsd)}
                </span>
                <span className="ml-auto num text-xs">
                  <span title="Locked forward APR of this pair (no fees) — the trustworthy per-pair number">
                    locked{' '}
                    {p.lockedAprFwd !== null ? (
                      <SignedNumber value={p.lockedAprFwd} format={fmtPct} />
                    ) : (
                      <span className="text-ink-600">—</span>
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-ghost-xs"
                  title="Reconstruct this pair: per-leg funding, Boros settlements and fees, with entry/exit-fee toggles"
                  onClick={() => setPairOpen(p)}
                >
                  details
                </button>
              </div>
            ))}
          </div>
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
        <span
          title={`Open perp uPnL + closed positions' realized price PnL — the cross-venue price package, not execution slippage; a delta-neutral book expects it near 0. Here: open marks ${fmtUsd(totals.breakdown.perpUpnlUsd)} + closed realized price ${fmtUsd(totals.priceResidualUsd - totals.breakdown.perpUpnlUsd)}. The account header's uPnL shows the open marks alone — its size is the two sides of the hedge, not a loss.`}
        >
          Price basis (perps){' '}
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
              title="Carry contribution only — fees and price PnL are not repeated here; they sit in the fee and price-basis lines."
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
                      <span className="text-ink-600" title="Shown so the row reads complete — these amounts are ALREADY INCLUDED in the Perp-fees and Price-basis figures below, not added again.">
                        {' '}· fees {fmtUsd(row.feesUsd)} · price{' '}
                        <SignedNumber value={row.priceUsd} format={fmtUsd} className="!text-ink-500" />
                      </span>
                    </span>
                  </div>
                )),
              )}
            {doneBoros.length > 0 &&
              (() => {
                // ONE ribbon for finished Boros markets. Markets sharing a
                // past maturity were the two rate legs of a finished 4-leg
                // strategy, so they render as a PAIR group (est.) with its
                // combined carry; loners render flat. Grouping only — every
                // dollar here appears exactly once.
                const grossOf = (h: (typeof doneBoros)[number]) =>
                  h.settleUsd + h.settleFeeUsd + h.tradePnlUsd + h.tradeFeeUsd;
                const marketRow = (h: (typeof doneBoros)[number], indent = false) => (
                  <div
                    key={h.marketId}
                    className={`flex flex-wrap items-baseline gap-x-2 rounded-md bg-ink-950/40 px-3 py-1 text-ink-400 ${indent ? 'ml-4' : ''}`}
                  >
                    <span className="text-ink-300">{prettyVenue(h.venue)}</span>
                    <span className="text-ink-600">
                      {h.maturity < nowSec
                        ? `matured ${fmtDateLocal(h.maturity)}`
                        : `closed early (was ${fmtDateLocal(h.maturity)})`}
                    </span>
                    {(h.peakNotionalUsd ?? 0) > 0 && (
                      <span className="num text-ink-600" title="Largest position seen at any settlement in the window, at today's price">
                        ntl {fmtUsdCompact(h.peakNotionalUsd ?? 0)}
                      </span>
                    )}
                    <span className="ml-auto num">
                      settle <SignedNumber value={h.settleUsd + h.settleFeeUsd} format={fmtUsd} />
                      {' '}· trade <SignedNumber value={h.tradePnlUsd + h.tradeFeeUsd} format={fmtUsd} />
                      <span className="text-ink-600" title="Shown so the row reads complete — this amount is ALREADY INCLUDED in the Boros-fees figure below, not added again (settle & trade here are gross of it).">
                        {' '}· fees {fmtUsd(h.settleFeeUsd + h.tradeFeeUsd)}
                      </span>
                    </span>
                  </div>
                );
                const byMat = new Map<number, typeof doneBoros>();
                for (const h of doneBoros) {
                  if (h.maturity >= nowSec) continue;
                  const list = byMat.get(h.maturity) ?? [];
                  list.push(h);
                  byMat.set(h.maturity, list);
                }
                const paired = new Set(
                  [...byMat.values()].filter((l) => l.length >= 2).flatMap((l) => l.map((h) => h.marketId)),
                );
                const loners = doneBoros.filter((h) => !paired.has(h.marketId));
                return ribbon(
                  'Completed Boros',
                  `${doneBoros.length} market${doneBoros.length === 1 ? '' : 's'}`,
                  borosCarry,
                  <>
                    {[...byMat.entries()]
                      .filter(([, list]) => list.length >= 2)
                      .map(([mat, list]) => (
                        <div key={`pair:${mat}`} className="flex flex-col gap-0.5">
                          <div
                            className="flex flex-wrap items-baseline gap-x-2 px-3 pt-1 text-ink-300"
                            title="These markets matured together — the two rate legs of a finished 4-leg strategy (est.). Their carry is the per-market rows below, counted once; the era's perp funding sits inside the funding totals above (the venues don't attribute it per era)."
                          >
                            <span className="font-semibold">
                              {list.map((h) => prettyVenue(h.venue)).join(' ⇄ ')}
                            </span>
                            <span className="text-ink-600">
                              past 4-leg (est.) · matured {fmtDateLocal(mat)}
                              {list.some((h) => (h.peakNotionalUsd ?? 0) > 0) && (
                                <span className="num" title="Largest position seen at any settlement, per leg, at today's price">
                                  {' '}· ntl {fmtUsdCompact(Math.max(...list.map((h) => h.peakNotionalUsd ?? 0)))}
                                </span>
                              )}
                            </span>
                            <span className="ml-auto num">
                              pair carry{' '}
                              <SignedNumber value={list.reduce((x, h) => x + grossOf(h), 0)} format={fmtUsd} />
                            </span>
                          </div>
                          {list.map((h) => marketRow(h, true))}
                        </div>
                      ))}
                    {loners.map((h) => marketRow(h))}
                  </>,
                );
              })()}
          </>
        );
      })()}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink-500">
          PnL waterfall
        </summary>
        <AssetBars totals={totals} />
        <p
          className="mt-2 text-xs text-ink-600"
          title="With a start date, funding and fees are summed from the venue's per-tick ledgers inside the window (per-tick amounts embody size-at-tick, so resizes are exact); without one they are whole-position cumulatives, and a closed batch's fees are its symbol's in-window fills, counted once. YU Funding/Settled is gross of fees (the Boros-fees line subtracts them once). Entry → Mark, uPnL and capital are whole-position regardless of the date; closes are windowed by close time. Partial exclusions scale open legs only."
        >
          Windowing rules ⓘ
        </p>
      </details>

      {pairOpen !== null && (
        <PairModal pair={pairOpen} base={group.base} onClose={() => setPairOpen(null)} />
      )}

      {feesOpen && (
        <Modal title={`${group.base} — PnL breakdown`} onClose={() => setFeesOpen(false)} widthClass="w-[640px]">
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
                <div
                  className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-ink-800 px-3 py-2 text-xs text-ink-400"
                  title="Carry − fees is the settled part (doesn't move with the tick); price basis is open marks + closed realized price — the two sides of the hedge, expected near 0 and the only part that breathes with the market."
                >
                  <span>
                    carry − fees{' '}
                    <span className="num">
                      <SignedNumber value={totals.pnlUsd - totals.priceResidualUsd} format={fmtUsd} />
                    </span>
                  </span>
                  <span>
                    price basis{' '}
                    <span className="num">
                      <SignedNumber value={totals.priceResidualUsd} format={fmtUsd} />
                    </span>
                  </span>
                  <span className="ml-auto font-semibold text-ink-300">
                    PnL{' '}
                    <span className="num">
                      <SignedNumber value={totals.pnlUsd} format={fmtUsd} />
                    </span>
                  </span>
                </div>
                {venueCarry.length > 1 && (
                  <div
                    className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500"
                    title="Per venue: perp funding (open + closed) + its Boros settle & trade (gross, open + completed markets) inside the window. On a working farm each venue's floating flows cancel and this nets to roughly the venue's fixed leg — a venue deeply negative here without its Boros offset is the mis-setup signal. Fees and price basis not included."
                  >
                    <span className="text-[10px] uppercase tracking-wider text-ink-600">
                      Net carry by venue
                    </span>
                    {venueCarry.map(([v, usd]) => (
                      <span key={v} className="num">
                        {prettyVenue(v)} <SignedNumber value={usd} format={fmtUsd} />
                      </span>
                    ))}
                  </div>
                )}
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
                  Boros rows are gross; the fee column is what subtracts. Dimmed = excluded.
                </p>
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}