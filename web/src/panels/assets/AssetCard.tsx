/**
 * One asset's card: hedge status ("what's missing for a perfect hedge"),
 * lifetime PnL / capital / approximate APR, the live legs with per-leg
 * exclusion controls, and a breakdown of where the PnL came from.
 *
 * All numbers arrive derived (assetModel.ts) — this file only renders.
 */
import { Fragment, useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import type {
  CrossexPosition,
  StrategyLeg,
  AssetBorosHistory,
  AssetBorosOpen,
  AssetGroup,
  AssetPerpClosedRow,
  AssetPerpOpen,
} from '../../api/types';
import { Chip } from '../../components/Chip';
import { microLabelClass } from '../../components/Th';
import { SharePositionModal } from '../SharePositionModal';
import { ClosePairForm } from '../PerpOnlyBox';
import { CloseBorosForm } from '../../trade/CloseBorosForm';
import { ClosePopover } from '../../trade/ClosePopover';
import { useTradeFlowOptional } from '../../trade/TradeFlow';
import { usePositions } from '../../api/queries';
import { pairSharePayload } from '../sharePayload';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, prettyVenue } from '../../lib/fmt';
import {
  type AssetDerived,
  type ExclusionEntry,
  type Exclusions,
  type HedgeGapRow,
  type PairEstimate,
  SECONDS_IN_YEAR,
  borosKey,
  defaultChargePerpFees,
  excludedFraction,
  exclusionAt,
  exclusionQty,
  keptSlice,
  perpKey,
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
  /** value: the excluded slice ({qty, at?} in the leg's unit), 'all', or
   * undefined to include the whole leg again. */
  onExclude: (key: string, value: ExclusionEntry | undefined) => void;
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
/** The pair's life as one bar: opened → now → maturity. A pair is a fixed-term
 * trade, so "how far in are we" is a fact the numbers around it all depend on
 * (the carry splits earned/remaining on exactly this axis) and no column can
 * express. */
function PairTimeline({
  openedSec,
  maturitySec,
  nowSec,
}: {
  openedSec: number | null;
  maturitySec: number;
  nowSec: number;
}) {
  if (maturitySec <= 0) return null;
  const start = openedSec ?? maturitySec - SECONDS_IN_YEAR / 12;
  const span = Math.max(1, maturitySec - start);
  const pct = Math.max(0, Math.min(100, ((nowSec - start) / span) * 100));
  const daysLeft = Math.max(0, Math.ceil((maturitySec - nowSec) / 86_400));
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <div className="relative h-1 rounded-full bg-ink-800">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-grass/70"
          style={{ width: `${pct}%` }}
        />
        {/* The "now" marker rides the same axis rather than sitting in a
            legend, so elapsed and remaining are read in one glance. */}
        <div
          className="absolute -top-1 h-3 w-px bg-ink-50"
          style={{ left: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-ink-400">
        <span className="num">
          {openedSec !== null ? fmtDateLocal(openedSec) : 'start unknown'}
        </span>
        <span className="num">
          matures {fmtDateLocal(maturitySec)} · {daysLeft}d left
        </span>
      </div>
    </div>
  );
}

function PairModal({
  pair,
  base,
  onClose,
  onBack,
}: {
  pair: PairEstimate;
  base: string;
  onClose: () => void;
  /** Return to the popup this one was opened from (the pairs table). */
  onBack?: () => void;
}) {
  // Perp-side costs are optional because the perp legs are the part you can
  // choose to roll instead of close. The BOROS fees carry no switch: that side
  // is held to maturity by construction, so they are structural, never a
  // choice — a tick beside them would imply an option that does not exist.
  // Defaults: entry fees only when the perp was opened for THIS hedge (not
  // more than three days before its Boros leg); the exit fee off, because
  // the rate side matures on its own and the perps are usually rolled.
  const [inclPerpFees, setInclPerpFees] = useState(() => defaultChargePerpFees(pair));
  const [inclExitFee, setInclExitFee] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const nowSec = Date.now() / 1000;
  const soonest = pair.soonestMaturitySec;
  // Fee → APR: one-off fees spread over the pair's FULL hedged life
  // (first-fully-hedged → soonest maturity), on the same capital base as the
  // locked APR. Falls back to the remaining term when no leg start is known.
  const termYears =
    soonest > 0 ? (soonest - (pair.hedgedSinceSec ?? nowSec)) / SECONDS_IN_YEAR : 0;
  const dragOf = (feeUsd: number): number | null =>
    termYears > 0 && pair.capitalUsd > 0 ? feeUsd / pair.capitalUsd / termYears : null;
  const perYearUsd = pair.lockedAprFwd !== null ? pair.lockedAprFwd * pair.capitalUsd : null;
  const carryUsd = perYearUsd !== null && termYears > 0 ? perYearUsd * termYears : null;
  const elapsedYears =
    pair.hedgedSinceSec !== null && soonest > 0
      ? Math.max(0, Math.min(nowSec, soonest) - pair.hedgedSinceSec) / SECONDS_IN_YEAR
      : 0;
  const earnedSoFarUsd = perYearUsd !== null ? perYearUsd * elapsedYears : null;
  const chargedUsd =
    pair.borosFeesPaidUsd +
    (inclPerpFees ? pair.perpFeesPaidUsd : 0) +
    (inclExitFee ? pair.exitFeeUsd : 0);
  const netUsd = carryUsd === null ? null : carryUsd - chargedUsd;
  // THE headline: the locked rate with every charged fee taken out of it.
  const netApr =
    netUsd !== null && termYears > 0 && pair.capitalUsd > 0
      ? netUsd / pair.capitalUsd / termYears
      : null;
  const cell = 'border-b border-ink-850 px-2.5 py-2';

  /** One switch of the charge row — a setting, not a figure: the amounts
   * live in the ladder below, next to the carry they come out of. */
  const feeSwitch = (label: string, title: string, on: boolean, set: (v: boolean) => void) => (
    <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap" title={title}>
      <input type="checkbox" className="chk" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="text-ink-100">{label}</span>
    </label>
  );
  /** One line of the opened ladder. */
  const ledgerRow = (key: string, label: string, title: string, usd: number, on: boolean) => {
    const drag = dragOf(usd);
    return (
      <div key={key} className="flex items-baseline justify-between gap-3 text-xs">
        <span className={on ? 'text-ink-200' : 'text-ink-600'} title={title}>
          {label}
          {!on && <span className="ml-1.5 text-[10px] uppercase tracking-[0.1em]">not charged</span>}
        </span>
        <span className={`num whitespace-nowrap ${on ? 'text-ink-100' : 'text-ink-600 line-through'}`}>
          −{fmtUsd(usd)}
          {drag !== null && (
            <span className={on ? 'text-ink-400' : 'text-ink-600'}> · −{fmtPct(drag)}</span>
          )}
        </span>
      </div>
    );
  };
  const carryTitle =
    earnedSoFarUsd !== null && carryUsd !== null && earnedSoFarUsd > 0
      ? `What the hedge earns over its full life at the locked rate — hedged date to maturity, on the pair's capital. Earned so far ≈ ${fmtUsd(earnedSoFarUsd)} · remaining ≈ ${fmtUsd(carryUsd - earnedSoFarUsd)}.`
      : "What the hedge earns over its full life at the locked rate — hedged date to maturity, on the pair's capital.";

  return (
    <Modal
      title={`Pair detail — ${prettyVenue(pair.longVenue)} / ${prettyVenue(pair.shortVenue)}`}
      onClose={onClose}
      widthClass="w-[620px]"
    >
      <p className="mb-4 text-[11.5px] text-ink-300">
        One pair of the asset book, split out of the venue-blended position by today’s sizes.
      </p>
      <PairTimeline openedSec={pair.hedgedSinceSec} maturitySec={soonest} nowSec={nowSec} />

      {/* The charge switches sit ABOVE everything they move — the headline
          APR, the ladder and the shared payload all follow them — rather than
          inside the ladder they used to live in, where a collapsed ladder
          would have hidden the control that set the number beside it. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-ink-700 bg-ink-100/[0.03] px-3 py-2 text-xs">
        <span className={microLabelClass}>Charge</span>
        {feeSwitch(
          'Perp fees paid',
          "Perp trading fees already paid on this pair's slices. Untick to see the rate without the perp side's cost.",
          inclPerpFees,
          setInclPerpFees,
        )}
        {feeSwitch(
          'Est. exit fee',
          "Both perp legs closed at maturity at YOUR venues' taker rates (from the account's fee schedule where available). Untick if you mean to roll the perps rather than close them.",
          inclExitFee,
          setInclExitFee,
        )}
      </div>

      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-4">
        <span className="flex flex-col gap-2">
          <span className={microLabelClass}>Est. fixed APR</span>
          <span
            className="num text-2xl font-semibold leading-none tracking-[-0.02em]"
            title="The locked rate with every charged fee taken out, on the pair's capital over the hedge's life. Moves with the switches above."
          >
            {netApr !== null ? (
              <SignedNumber value={netApr} format={fmtPct} />
            ) : (
              <span className="text-ink-500">—</span>
            )}
          </span>
          <span className="num text-[11px] leading-none text-ink-400">
            {pair.lockedAprFwd !== null ? (
              <>
                locked <SignedNumber value={pair.lockedAprFwd} format={fmtPct} className="!text-ink-300" />{' '}
                before fees
              </>
            ) : (
              'no locked rate'
            )}
          </span>
        </span>
        <span className="flex flex-col gap-2">
          <span className={microLabelClass}>Capital</span>
          <span className="num text-2xl font-semibold leading-none tracking-[-0.02em] text-ink-50">
            {fmtUsdCompact(pair.capitalUsd)}
          </span>
          <span className="num text-[11px] leading-none text-ink-400">
            {fmtTokenQty(pair.size, base)} · {fmtUsdCompact(pair.notionalUsd)} notional
          </span>
        </span>
      </div>

      {/* No Fees and no Matures column: fees are grouped once in the ladder
          below, and the maturity is the timeline's right edge. */}
      <div className="overflow-x-auto rounded border border-ink-700">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className="th text-left">Leg</th>
              <th className="th text-right">Size</th>
              <th className="th text-right">Locked</th>
              <th className="th text-right">Initial margin</th>
            </tr>
          </thead>
          <tbody>
            {pair.legs.map((l, i) => (
              <tr key={i}>
                <td className={`${cell} whitespace-nowrap`}>
                  <span className="inline-flex items-center gap-[7px]">
                    <span className="font-medium text-ink-50">{prettyVenue(l.venue)}</span>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${
                        l.kind === 'yu' ? 'text-link' : 'text-ink-400'
                      }`}
                    >
                      {l.kind === 'yu' ? 'Boros' : 'CrossEx'}
                    </span>
                    <Chip sm tone={l.side === 'LONG' ? 'green' : 'red'}>
                      {l.side}
                    </Chip>
                  </span>
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>
                  {fmtTokenQty(l.size, base)}
                  {l.share < 0.9995 && (
                    <span
                      className="text-ink-500"
                      title="This leg is shared with another pair in the book; only this slice counts here."
                    >
                      {' '}
                      ({fmtPct(l.share)})
                    </span>
                  )}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right`}>
                  {l.lockedApr !== null ? (
                    <SignedNumber value={l.lockedApr} format={fmtPct} />
                  ) : (
                    <span className="text-ink-600">—</span>
                  )}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>
                  {l.kind === 'yu' && l.imAtOpenUsd !== null ? (
                    <span
                      title={`At open, ESTIMATED: Boros margin decays toward maturity and the venue reports only today's requirement (${fmtUsdCompact(l.imUsd)}), so this scales it back over the leg's life assuming the requirement is linear in time to maturity.`}
                    >
                      ≈{fmtUsdCompact(l.imAtOpenUsd)}
                    </span>
                  ) : (
                    <span title={l.kind === 'yu' ? "Today's requirement — the leg's start is unknown, so the figure at open can't be reconstructed" : 'Initial margin this slice consumes'}>
                      {fmtUsdCompact(l.imUsd)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Collapsed, the ladder is its one answer; opened, it shows the carry
          the fees come out of and each fee as charged (or not) above. */}
      <details className="group mt-3 rounded border border-ink-700">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline gap-2">
            <span aria-hidden="true" className="text-[10px] text-ink-400 group-open:rotate-90">
              ▸
            </span>
            <span
              className={microLabelClass}
              title="Carry over the whole hedge minus the fees charged above — dollars first, the APR is the same figure on capital over the hedge's life"
            >
              Net over the hedge (est.)
            </span>
          </span>
          <span className="num text-base font-semibold">
            {netUsd !== null ? <SignedNumber value={netUsd} format={fmtUsd} /> : '—'}
            {netApr !== null && (
              <span className="ml-2 text-[12.5px] font-normal text-ink-300">
                (<SignedNumber value={netApr} format={fmtPct} className="!text-ink-400" />)
              </span>
            )}
          </span>
        </summary>
        <div className="flex flex-col gap-1.5 border-t border-ink-800 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-ink-200 underline decoration-ink-600 decoration-dotted underline-offset-[3px]" title={carryTitle}>
              Carry over the hedge (locked)
            </span>
            <span className="num text-ink-100">
              {carryUsd !== null ? (
                <>
                  <SignedNumber value={carryUsd} format={fmtUsd} />
                  {pair.lockedAprFwd !== null && (
                    <span className="text-ink-400">
                      {' · '}
                      <SignedNumber value={pair.lockedAprFwd} format={fmtPct} className="!text-ink-400" />
                    </span>
                  )}
                </>
              ) : (
                '—'
              )}
            </span>
          </div>
          <div className="mt-1 flex flex-col gap-1.5 border-t border-ink-800 pt-2">
            {ledgerRow(
              'boros',
              'Boros fees paid',
              'Boros settle + trade fees paid — structural, never excludable: the Boros side is held to maturity, so these always apply.',
              pair.borosFeesPaidUsd,
              true,
            )}
            {ledgerRow(
              'perp',
              'Perp fees paid',
              "Perp trading fees already paid on this pair's slices.",
              pair.perpFeesPaidUsd,
              inclPerpFees,
            )}
            {ledgerRow(
              'exit',
              'Est. exit fee',
              "Both perp legs closed at maturity at YOUR venues' taker rates. The Boros legs mature on their own, no close cost.",
              pair.exitFeeUsd,
              inclExitFee,
            )}
          </div>
        </div>
      </details>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          {onBack && (
            <button type="button" className="btn" onClick={onBack} title="Back to the pairs table">
              ← Pairs
            </button>
          )}
          <button type="button" className="btn" onClick={() => setShareOpen(true)}>
            Share this pair
          </button>
        </span>
        <span className="text-[11px] text-ink-400">
          Proportional split by today’s sizes — reference only.
        </span>
      </div>
      {shareOpen && (
        <SharePositionModal
          payload={pairSharePayload(pair, base, { nowSec, inclPerpFees, inclExitFee, netApr, netUsd })}
          onClose={() => setShareOpen(false)}
        />
      )}
    </Modal>
  );
}

/** Matured Boros legs, as the mock's table: one row per market, and the carry
 * they contributed footed at the bottom. */
function CompletedBorosModal({
  rows,
  base,
  carry,
  nowSec,
  onClose,
}: {
  rows: AssetBorosHistory[];
  base: string;
  carry: number;
  nowSec: number;
  onClose: () => void;
}) {
  const cell = 'border-b border-ink-850 px-2.5 py-2';
  return (
    <Modal
      title={`Closed/matured Boros legs — ${rows.length} market${rows.length === 1 ? '' : 's'}`}
      onClose={onClose}
      widthClass="w-[620px]"
    >
      <p className="mb-4 text-[11.5px] text-ink-300">
        Matured rate legs. Their settled carry stays in the book’s PnL.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className="th text-left">Market</th>
              <th className="th text-right">Notional</th>
              <th className="th text-right">Matured</th>
              <th className="th text-right">Settled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.marketId}>
                <td className={`${cell} whitespace-nowrap text-ink-50`}>
                  {base} {prettyVenue(h.venue)}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>
                  {(h.peakNotionalUsd ?? 0) > 0 ? (
                    <span title="Largest position seen at any settlement in the window, at today's price">
                      {fmtUsdCompact(h.peakNotionalUsd ?? 0)}
                    </span>
                  ) : (
                    <span className="text-ink-600">—</span>
                  )}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-300`}>
                  {h.maturity < nowSec ? (
                    fmtDateLocal(h.maturity)
                  ) : (
                    <span title={`Closed early — was due ${fmtDateLocal(h.maturity)}`}>
                      closed early
                    </span>
                  )}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right`}>
                  <SignedNumber
                    value={h.settleUsd + h.settleFeeUsd + h.tradePnlUsd + h.tradeFeeUsd}
                    format={fmtUsd}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span
          className="text-[11.5px] text-ink-200"
          title="Funding settlement only — fees sit in Cost and any closing price PnL in price basis, so nothing is counted twice."
        >
          Funding settlement
        </span>
        <span className="num text-base font-semibold">
          <SignedNumber value={carry} format={fmtUsd} />
        </span>
      </div>
    </Modal>
  );
}

/** Closed perp positions, same shape as the Boros table above. */
function CompletedPerpsModal({
  rows,
  base,
  carry,
  onClose,
}: {
  rows: (AssetPerpClosedRow & { symbol: string; venue: string })[];
  base: string;
  carry: number;
  onClose: () => void;
}) {
  const cell = 'border-b border-ink-850 px-2.5 py-2';
  return (
    <Modal
      title={`Closed perps legs — ${rows.length} closed pair${rows.length === 1 ? '' : 's'}`}
      onClose={onClose}
      widthClass="w-[620px]"
    >
      <p className="mb-4 text-[11.5px] text-ink-300">
        Closed hedge legs. Their funding stays in the book’s PnL; fees and price
        PnL sit in the lines below the legs, not here.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className="th text-left">Venue</th>
              <th className="th text-right">Size</th>
              <th className="th text-right">Open → Close</th>
              <th className="th text-right">Closed</th>
              <th className="th text-right">Funding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.symbol}:${row.closedAt}`}>
                <td className={`${cell} whitespace-nowrap text-ink-50`}>
                  {prettyVenue(row.venue)}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>
                  {fmtTokenQty(row.qty, base)}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-300`}>
                  {fmtUsd(row.openPx)} → {fmtUsd(row.closePx)}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right text-ink-300`}>
                  {row.closedAt !== null ? fmtDateLocal(row.closedAt) : '—'}
                </td>
                <td className={`${cell} num whitespace-nowrap text-right`}>
                  {row.dedupedIntoOpen ? (
                    <span
                      className="text-ink-600"
                      title="This slice's funding/fees are booked on the surviving open row"
                    >
                      in open ↑
                    </span>
                  ) : (
                    <SignedNumber value={row.fundingUsd} format={fmtUsd} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span
          className="text-[11.5px] text-ink-200"
          title="Funding settlement only — fees sit in Cost and any closing price PnL in price basis, so nothing is counted twice."
        >
          Funding settlement
        </span>
        <span className="num text-base font-semibold">
          <SignedNumber value={carry} format={fmtUsd} />
        </span>
      </div>
    </Modal>
  );
}

/** What a gap asks the trader to add, as a phrase: "LONG 120 ETH YU on Boros". */
function gapAsk(gap: HedgeGapRow, base: string): string {
  const dir = gap.action.startsWith('long') ? 'LONG' : 'SHORT';
  const what = gap.leg === 'boros' ? 'YU on Boros' : 'perp';
  return `${dir} ${sizeLabel(gap.size, gap.unit, base)} ${what}`;
}

/** The chip on a leg that exists but is smaller than its partner. */
function DeficitChip({ gap, base }: { gap: HedgeGapRow; base: string }) {
  return (
    <Chip
      sm
      tone="amber"
      title={`This leg is ${sizeLabel(gap.size, gap.unit, base)} short of its partner (${sizeLabel(gap.want, gap.unit, base)}) — open ${gapAsk(gap, base)} to cover it`}
    >
      deficit {sizeLabel(gap.size, gap.unit, base)}
    </Chip>
  );
}

/**
 * A leg that does not exist yet, drawn where it would sit. Dimmed so it
 * reads as absent, with the one action that fixes it — the surplus side is
 * never flagged, only the side the trader needs to open.
 */
function MissingRow({ gap, base, onOpen, asPair }: { gap: HedgeGapRow; base: string; onOpen?: () => void; asPair?: boolean }) {
  const boros = gap.leg === 'boros';
  return (
    <tr className="opacity-50">
      <td className="whitespace-nowrap">
        <span className="flex flex-col gap-1 leading-none">
          <span className="inline-flex items-center gap-[7px]">
            <span className="text-[12.5px] font-medium leading-none text-ink-50">{prettyVenue(gap.venue)}</span>
            <Chip sm tone="amber">missing</Chip>
          </span>
          <span className={`text-[10px] font-semibold uppercase leading-none tracking-[0.1em] ${boros ? 'text-link' : 'text-ink-400'}`}>
            {boros ? 'Boros' : 'CrossEx'}
          </span>
        </span>
      </td>
      <td className="num text-right text-ink-300">
        {sizeLabel(gap.want, gap.unit, base)}
        <span className="ml-1 text-ink-500">needed</span>
      </td>
      <td className="text-right text-ink-600">—</td>
      <td className="text-right text-ink-600">—</td>
      <td className="whitespace-nowrap text-right">
        <button
          type="button"
          className="btn-ghost-xs !text-gold hover:!border-gold/50"
          disabled={!onOpen}
          title={onOpen ? (asPair ? 'Both legs of this side are missing — arms the PAIR ticket with the two of them' : `Arms the order ticket with ${gapAsk(gap, base)}`) : 'Order ticket unavailable here'}
          onClick={onOpen}
        >
          {asPair ? `open both ${boros ? 'Boros' : 'perp'} legs →` : `open ${boros ? 'Boros' : 'perp'} leg →`}
        </button>
      </td>
    </tr>
  );
}

/** The last cell of a leg row: exclude all / part / undo. */
/**
 * The per-leg edit popup. One decision — include the whole leg, or carve a
 * slice out of it — and, for a slice, the price (perp) or fixed rate (Boros)
 * it was put on at, so the remainder's entry is the weighted residual rather
 * than the venue's blended average. A slice the size of the leg IS "exclude
 * the whole leg".
 */
export function LegEditModal({
  exKey,
  label,
  unit,
  legQty,
  entry,
  entryKind,
  current,
  onExclude,
  onClose,
}: {
  exKey: string;
  label: string;
  unit: string;
  legQty: number;
  entry: number;
  entryKind: 'price' | 'rate';
  current: ExclusionEntry | undefined;
  onExclude: Props['onExclude'];
  onClose: () => void;
}) {
  const curQty = current === 'all' ? legQty : exclusionQty(current);
  const curAt = exclusionAt(current);
  const [mode, setMode] = useState<'all' | 'portion'>(current === undefined ? 'all' : 'portion');
  const [qtyStr, setQtyStr] = useState(curQty !== null ? String(curQty) : '');
  const fmtAt = (v: number) => (entryKind === 'rate' ? String(+(v * 100).toFixed(4)) : String(+v.toFixed(2)));
  const [atStr, setAtStr] = useState(fmtAt(curAt ?? entry));
  const qty = Number(qtyStr);
  const qtyOk = Number.isFinite(qty) && qty > 0;
  const atRaw = Number(atStr);
  const at = Number.isFinite(atRaw) && atRaw >= 0 ? (entryKind === 'rate' ? atRaw / 100 : atRaw) : null;
  const whole = mode === 'all' ? false : qtyOk && qty >= legQty;
  // Live preview of what the farm keeps.
  const preview =
    mode === 'portion' && qtyOk && !whole
      ? keptSlice({ [exKey]: at !== null ? { qty, at } : qty }, exKey, legQty, entry)
      : null;
  const showEntry = (v: number) => (entryKind === 'rate' ? fmtPct(v) : fmtUsd(v));
  const save = () => {
    if (mode === 'all') onExclude(exKey, undefined);
    else if (!qtyOk) return;
    else if (whole) onExclude(exKey, 'all');
    else onExclude(exKey, at !== null ? { qty, at } : qty);
    onClose();
  };
  return (
    <Modal title={`Edit leg — ${label}`} onClose={onClose} widthClass="w-[460px]">
      <p className="mb-4 text-[11.5px] text-ink-300">
        What part of this leg is the funding farm. Everything else is set aside in the
        Excluded section and leaves the hedge, PnL and capital.
      </p>
      <div role="radiogroup" aria-label="Include" className="mb-4 flex flex-col gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-100">
          <input type="radio" name="leg-edit-mode" className="chk" checked={mode === 'all'} onChange={() => setMode('all')} />
          Include all — {fmtTokenQty(legQty, unit)} at {showEntry(entry)}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-100">
          <input type="radio" name="leg-edit-mode" className="chk" checked={mode === 'portion'} onChange={() => setMode('portion')} />
          Exclude a portion
        </label>
      </div>
      {mode === 'portion' && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={microLabelClass}>Exclude ({unit})</span>
            <span className="flex items-center gap-1.5">
              <input
                className={`input num !py-1.5 text-xs ${qtyStr !== '' && !qtyOk ? 'border-guava/60' : ''}`}
                inputMode="decimal"
                autoFocus
                value={qtyStr}
                onChange={(e) => setQtyStr(e.target.value)}
                aria-label={`Quantity to exclude (${unit})`}
              />
              <button type="button" className="btn-ghost-xs whitespace-nowrap" onClick={() => setQtyStr(String(legQty))} title="Exclude the whole leg">
                all
              </button>
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={microLabelClass}>{entryKind === 'rate' ? 'at fixed rate (%)' : 'at price (USD)'}</span>
            <input
              className="input num !py-1.5 text-xs"
              inputMode="decimal"
              value={atStr}
              onChange={(e) => setAtStr(e.target.value)}
              aria-label={entryKind === 'rate' ? 'Rate the excluded slice was locked at' : 'Price the excluded slice was opened at'}
              title="The remainder's entry becomes the weighted residual once this slice is carved out at its own level. Leave it at the leg's average for a plain pro-rata split."
            />
          </label>
        </div>
      )}
      <div className="mb-4 rounded border border-ink-700 bg-ink-100/[0.03] px-3 py-2 text-xs">
        {mode === 'all' ? (
          <span className="text-ink-200">The farm keeps the whole leg.</span>
        ) : whole ? (
          <span className="text-gold">The whole leg is excluded — it moves to the Excluded section.</span>
        ) : preview ? (
          <span className="num text-ink-200">
            Farm keeps <span className="text-ink-50">{fmtTokenQty(legQty * preview.keep, unit)}</span> at{' '}
            <span className="text-ink-50">{showEntry(preview.entry)}</span>
            {preview.at !== null && preview.entry !== entry && (
              <span className="text-ink-400"> (was {showEntry(entry)})</span>
            )}
          </span>
        ) : (
          <span className="text-ink-400">Enter how much to exclude.</span>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={mode === 'portion' && !qtyOk} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

/** The trailing cell of a leg row: ✎ opens the exclude popup, ✕ the close
 * ticket for that one leg. Icons, labelled for the reader that cannot see
 * them; the tooltip says what each does. */
function EditCell({
  onCloseLeg,
  closeTitle,
  leading,
  ...props
}: Omit<React.ComponentProps<typeof LegEditModal>, 'onClose'> & {
  /** Absent when the leg cannot be closed from here (no live position). */
  onCloseLeg?: () => void;
  /** Absent (the Excluded section) ⇒ no ✕ at all. */
  closeTitle?: string;
  /** An extra control before the icons (the deficit row's "open more") —
   * inside the same flex row so it centres with them. */
  leading?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const has = props.current !== undefined;
  return (
    <span className="inline-flex items-center gap-1">
      {leading}
      <button
        type="button"
        aria-label={`Edit ${props.label}`}
        className={`btn-ghost-xs !px-1.5 !py-[5px] ${has ? 'text-gold' : ''}`}
        title={has ? 'Part of this leg is excluded — edit or restore' : 'Exclude some or all of this leg from the farm'}
        onClick={() => setOpen(true)}
      >
        <PencilIcon />
      </button>
      {closeTitle && (
        <button
          type="button"
          aria-label={`Close ${props.label}`}
          className="btn-ghost-xs !px-1.5 !py-[5px] hover:!border-guava/50 hover:!text-guava"
          title={closeTitle}
          disabled={!onCloseLeg}
          onClick={onCloseLeg}
        >
          <CrossIcon />
        </button>
      )}
      {open && <LegEditModal {...props} onClose={() => setOpen(false)} />}
    </span>
  );
}

function OpenMoreButton({ gap, base, onOpen }: { gap: HedgeGapRow; base: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className="btn-ghost-xs !text-gold hover:!border-gold/50"
      disabled={!onOpen}
      title={onOpen ? `Arms the order ticket with ${gapAsk(gap, base)}` : 'Order ticket unavailable here'}
      onClick={onOpen}
    >
      open more
    </button>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11.5 2.5l2 2L5 13H3v-2z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function PerpRow({
  leg,
  base,
  exclusions,
  onExclude,
  onClose,
  deficit,
  onOpenMore,
}: {
  leg: AssetPerpOpen;
  base: string;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
  /** Opens the single-leg close ticket; absent while the live position is
   * not loaded (there is nothing to size the close against). */
  onClose?: () => void;
  /** This leg is smaller than its partner on the venue. */
  deficit?: HedgeGapRow;
  onOpenMore?: () => void;
}) {
  const key = perpKey(leg.symbol);
  const slice = keptSlice(exclusions, key, leg.qty, leg.entryPrice);
  const exFrac = 1 - slice.keep;
  return (
    <tr className="group">
      {/* One identity column: the venue and its side on top, the instrument
          under it. Two columns split a single fact across the table's widest
          gap; stacked, each leg reads as one label. */}
      <td className="whitespace-nowrap">
        <span className="flex flex-col gap-1 leading-none">
          <span className="inline-flex items-center gap-[7px]">
            <span className="text-[12.5px] font-medium leading-none text-ink-50">
              {prettyVenue(leg.venue)}
            </span>
            <Chip sm tone={leg.side === 'LONG' ? 'green' : 'red'}>
              {leg.side}
            </Chip>
            {deficit && <DeficitChip gap={deficit} base={base} />}
          </span>
          <span className="text-[10px] font-semibold uppercase leading-none tracking-[0.1em] text-ink-400">
            CrossEx
          </span>
        </span>
      </td>
      {/* The KEPT slice: the farm's size and its entry once any excluded
          slice is carved out at its own price. The whole leg is on hover. */}
      <td className="num text-right" title={exFrac > 0 ? `Whole leg ${fmtTokenQty(leg.qty, base)} (${fmtUsdCompact(leg.notionalUsd)}) — ${fmtTokenQty(exFrac * leg.qty, base)} excluded` : undefined}>
        {fmtTokenQty(leg.qty * slice.keep, base)}
        <span className="ml-1 text-ink-500">({fmtUsdCompact(leg.notionalUsd * slice.keep)})</span>
        {exFrac > 0 && <span className="ml-1 text-gold" title="Part of this leg is excluded from the farm">of {fmtTokenQty(leg.qty, base)}</span>}
      </td>
      <td className="num text-right text-ink-100" title={slice.at !== null && slice.entry !== leg.entryPrice ? `Venue average ${fmtUsd(leg.entryPrice)} — the remainder's entry after carving out ${fmtTokenQty(exFrac * leg.qty, base)} at ${fmtUsd(slice.at)}` : undefined}>
        {leg.entryPrice > 0 && leg.markPrice > 0
          ? `${fmtUsd(slice.entry)} → ${fmtUsd(leg.markPrice)}`
          : '—'}
      </td>
      <td
        className="num text-right"
        title={`uPnL ${fmtUsd(leg.upnlUsd)} · fees ${fmtUsd(leg.feesUsd)} · IM ${fmtUsd(leg.imUsd)}`}
      >
        <SignedNumber value={leg.fundingUsd} format={fmtUsd} />
      </td>
      <td className="whitespace-nowrap text-right">
        <EditCell
          leading={deficit && <OpenMoreButton gap={deficit} base={base} onOpen={onOpenMore} />}
          exKey={key}
          label={`${prettyVenue(leg.venue)} ${leg.side} perp`}
          unit={base}
          legQty={leg.qty}
          entry={leg.entryPrice}
          entryKind="price"
          current={exclusions[key]}
          onExclude={onExclude}
          onCloseLeg={onClose}
          closeTitle={onClose ? 'Close this perp leg — reduce-only at mark' : 'Live position not loaded yet'}
        />
      </td>
    </tr>
  );
}

function BorosRow({
  leg,
  windowedGrossUsd,
  windowedFeesUsd,
  exclusions,
  onExclude,
  onClose,
  deficit,
  onOpenMore,
  base,
}: {
  leg: AssetBorosOpen;
  /** This market's settle+trade GROSS inside the window — the exact number
   * that feeds PnL (the leg's own cumulative is a different window). Split
   * kept for the tooltip: a PARTIAL close's trade PnL rides here. */
  windowedGrossUsd: { gross: number; settle: number; trade: number } | null;
  /** This market's settle + trade fees inside the window — a MEMO on the row
   * (Boros fees are attributable per market); charged once, in COST. */
  windowedFeesUsd: number | null;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
  onClose: () => void;
  deficit?: HedgeGapRow;
  onOpenMore?: () => void;
  base: string;
}) {
  const key = borosKey(leg.marketId);
  const slice = keptSlice(exclusions, key, leg.sizeToken, leg.entryApr);
  const exFrac = 1 - slice.keep;
  return (
    <tr className="group">
      <td className="whitespace-nowrap">
        <span className="flex flex-col gap-1 leading-none">
          <span className="inline-flex items-center gap-[7px]">
            <span className="text-[12.5px] font-medium leading-none text-ink-50">
              {prettyVenue(leg.venue)}
            </span>
            <Chip sm tone={leg.side === 'LONG' ? 'green' : 'red'}>
              {leg.side}
            </Chip>
            {deficit && <DeficitChip gap={deficit} base={base} />}
          </span>
          <span className="inline-flex items-baseline gap-1.5 leading-none">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-link">
              Boros
            </span>
            <span
              className="num text-[11px] text-ink-400"
              title="Maturity — coverage lapses here; the position itself just settles and ends"
            >
              {fmtDateLocal(leg.maturity)}
              {(() => {
                const days = Math.ceil((leg.maturity - Date.now() / 1000) / 86400);
                return days > 0 ? ` (${days}d)` : '';
              })()}
            </span>
          </span>
        </span>
      </td>
      <td className="num text-right" title={exFrac > 0 ? `Whole leg ${fmtTokenQty(leg.sizeToken, leg.collateral)} (${fmtUsdCompact(leg.notionalUsd)}) — ${fmtTokenQty(exFrac * leg.sizeToken, leg.collateral)} excluded` : undefined}>
        {fmtTokenQty(leg.sizeToken * slice.keep, leg.collateral)}
        <span className="ml-1 text-ink-500">({fmtUsdCompact(leg.notionalUsd * slice.keep)})</span>
        {exFrac > 0 && <span className="ml-1 text-gold" title="Part of this leg is excluded from the farm">of {fmtTokenQty(leg.sizeToken, leg.collateral)}</span>}
      </td>
      <td className="num text-right text-ink-100" title={slice.at !== null && slice.entry !== leg.entryApr ? `Venue average ${fmtPct(leg.entryApr)} — the remainder's rate after carving out ${fmtTokenQty(exFrac * leg.sizeToken, leg.collateral)} at ${fmtPct(slice.at)}` : undefined}>
        {fmtPct(slice.entry)} → {fmtPct(leg.markApr)}
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
        {windowedFeesUsd !== null && windowedFeesUsd > 0 && (
          <div className="text-[10px] text-ink-500" title="This market's settlement + trade fees — a memo here; charged once in Cost">
            fees −{fmtUsd(windowedFeesUsd)}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap text-right">
        <EditCell
          leading={deficit && <OpenMoreButton gap={deficit} base={base} onOpen={onOpenMore} />}
          exKey={key}
          label={`${prettyVenue(leg.venue)} ${leg.side} YU`}
          unit={leg.collateral}
          legQty={leg.sizeToken}
          entry={leg.entryApr}
          entryKind="rate"
          current={exclusions[key]}
          onExclude={onExclude}
          onCloseLeg={onClose}
          closeTitle="Close this Boros leg — market order on Boros"
        />
      </td>
    </tr>
  );
}

export function AssetCard({ group, derived, sinceSec, windowPending, onChangeSince, exclusions, onExclude }: Props) {
  const { totals, gaps, venues } = derived;
  const flow = useTradeFlowOptional();
  /**
   * Arm the order ticket with exactly what a gap asks for — one leg, one
   * venue, one size — and open it. A Boros leg is pinned to the maturity the
   * asset already trades at that venue (else the asset's soonest), so the
   * ticket lands on the market the hedge needs rather than the first match.
   */
  const deficitFor = (venue: string, leg: 'perp' | 'boros') =>
    gaps.find((g) => g.venue === venue && g.leg === leg && g.kind === 'deficit');
  const missing = (leg: 'perp' | 'boros') => gaps.filter((g) => g.leg === leg && g.kind === 'missing');
  /**
   * When BOTH legs of a side are missing — a long at one venue and a short
   * at another — the repair is one PAIR, not two single legs: the pair
   * ticket opens both at once and hedges them against each other. The
   * partner is the opposite-direction missing gap on the same side.
   */
  const pairPartner = (g: HedgeGapRow): HedgeGapRow | undefined =>
    missing(g.leg).find((o) => o.venue !== g.venue && o.action.startsWith('long') !== g.action.startsWith('long'));
  const armGap = (g: HedgeGapRow): (() => void) | undefined => {
    if (!flow) return undefined;
    return () => {
      const long = g.action.startsWith('long');
      const partner = pairPartner(g);
      // A pair has ONE size: the smaller of the two asks. Any remainder
      // shows up as a deficit on the bigger side afterwards.
      const size = partner ? Math.min(g.size, partner.size) : g.size;
      const sizeBase = g.unit === 'base' ? size : group.priceUsd > 0 ? size / group.priceUsd : undefined;
      const notionalUsd = g.unit === 'usd' ? size : size * group.priceUsd;
      if (partner) {
        const longVenue = long ? g.venue : partner.venue;
        const shortVenue = long ? partner.venue : g.venue;
        if (g.leg === 'boros') {
          const anyM = group.borosOpen.map((b) => b.maturity);
          flow.prefillBorosOpen({
            base: group.base,
            longVenue,
            shortVenue,
            maturity: anyM.length > 0 ? Math.min(...anyM) : undefined,
            size: notionalUsd,
            sizeBase,
          });
        } else {
          flow.prefillPair({ base: group.base, longVenue, shortVenue, notionalUsd, sizeBase, sizeUnit: g.unit });
        }
        flow.openRail();
        return;
      }
      if (g.leg === 'boros') {
        const atVenue = group.borosOpen.filter((b) => b.venue === g.venue).map((b) => b.maturity);
        const anyM = group.borosOpen.map((b) => b.maturity);
        const pool = atVenue.length > 0 ? atVenue : anyM;
        flow.prefillBorosOpen({
          base: group.base,
          longVenue: long ? g.venue : null,
          shortVenue: long ? null : g.venue,
          maturity: pool.length > 0 ? Math.min(...pool) : undefined,
          size: notionalUsd,
          sizeBase,
        });
      } else {
        flow.prefillSinglePerp({
          base: group.base,
          venue: g.venue,
          side: long ? 'BUY' : 'SELL',
          notionalUsd,
          sizeBase,
          sizeUnit: g.unit,
        });
      }
      flow.openRail();
    };
  };
  const [feesOpen, setFeesOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState<'boros' | 'perps' | null>(null);
  const [pairsOpen, setPairsOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [closePerps, setClosePerps] = useState<PairEstimate | null>(null);
  const [closeBoros, setCloseBoros] = useState<PairEstimate | null>(null);
  /** One leg's close, from its row's ✕. */
  const [closeLeg, setCloseLeg] = useState<
    { kind: 'perp'; leg: AssetPerpOpen } | { kind: 'boros'; leg: AssetBorosOpen } | null
  >(null);
  // The close form realises each leg's uPnL off the live position.
  const positionsData = usePositions().data;
  const livePositions = useMemo(() => {
    const map = new Map<string, CrossexPosition>();
    for (const p of positionsData?.positions ?? []) map.set(p.symbol, p);
    return map;
  }, [positionsData?.positions]);
  const [wfOpen, setWfOpen] = useState(false);
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
  const byVenue = (a: { venue: string }, b: { venue: string }) => orderOf(a.venue) - orderOf(b.venue);
  // The table holds what the farm KEEPS. A leg excluded whole is orphaned in
  // the Excluded section below with every partial slice, so nothing set aside
  // is ever out of sight — and nothing set aside dims a row it no longer is.
  const perpSorted = group.perpOpen
    .filter((l) => excludedFraction(exclusions, perpKey(l.symbol), l.qty) < 1)
    .sort(byVenue);
  const borosSorted = borosVisible
    .filter((l) => excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken) < 1)
    .sort(byVenue);
  const excludedRows = [
    ...group.perpOpen.map((l) => ({
      key: perpKey(l.symbol),
      label: `${prettyVenue(l.venue)} ${l.side} perp`,
      unit: group.base,
      legQty: l.qty,
      entry: l.entryPrice,
      entryKind: 'price' as const,
      frac: excludedFraction(exclusions, perpKey(l.symbol), l.qty),
    })),
    ...borosVisible.map((l) => ({
      key: borosKey(l.marketId),
      label: `${prettyVenue(l.venue)} ${l.side} YU · ${fmtDateLocal(l.maturity)}`,
      unit: l.collateral,
      legQty: l.sizeToken,
      entry: l.entryApr,
      entryKind: 'rate' as const,
      frac: excludedFraction(exclusions, borosKey(l.marketId), l.sizeToken),
    })),
  ].filter((r) => r.frac > 0);

  // Completed legs — matured Boros markets and closed perps — rendered inside
  // CARRY beside the open legs: same kind of fact, same ledger.
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
  const perpCarry = completedPerps.reduce(
    (t, r) => t + (r.dedupedIntoOpen ? 0 : r.fundingUsd),
    0,
  );
  const borosCarry = doneBoros.reduce(
    (t, h) => t + h.settleUsd + h.settleFeeUsd + h.tradePnlUsd + h.tradeFeeUsd,
    0,
  );
  // A strip that OPENS A MODAL, not a <details> dropdown: expanding in
  // place pushed everything below it down and the rows landed in a
  // cramped 2px-padded list. The modal gives the finished legs a real
  // table, and the strip keeps stating the one number that matters here.
  const ribbon = (
    label: string,
    sub: string,
    carry: number,
    carryLabel: string,
    onOpen: () => void,
    empty = false,
  ) => (
    <button
      type="button"
      onClick={onOpen}
      disabled={empty}
      title="Funding settlement only — fees sit in Cost and any closing price PnL in price basis, so nothing is counted twice."
      className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-ink-700 bg-ink-950/60 px-3.5 py-2.5 text-left text-xs transition-colors hover:border-ink-500 disabled:cursor-default disabled:hover:border-ink-700"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-200">
        {label}
      </span>
      <span className="text-ink-400">{sub}</span>
      <span className="ml-auto num text-ink-400">
        {carryLabel}{' '}
        <span className="text-sm font-semibold">
          <SignedNumber value={carry} format={fmtUsd} />
        </span>
      </span>
    </button>
  );

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
            <Chip
              sm
              tone="green"
              title={
                derived.grossPerp > 0 && derived.netPerp !== 0
                  ? `Every floating leg is covered and the perps cancel within the 2% tolerance. Residual price exposure: net ${derived.netPerp > 0 ? 'LONG' : 'SHORT'} ${sizeLabel(Math.abs(derived.netPerp), venues[0]?.unit ?? 'usd', group.base)}${venues[0]?.unit === 'base' && group.priceUsd > 0 ? ` ≈ ${fmtUsdCompact(Math.abs(derived.netPerp) * group.priceUsd)}` : ''} — live exposure, not zero.`
                  : 'Every floating leg is covered and the perps cancel each other exactly.'
              }
            >
              hedged ✓
            </Chip>
          ) : gaps.length > 0 ? (
            <Chip
              sm
              tone="amber"
              title={gaps.map((g) => `${prettyVenue(g.venue)}: ${g.kind} — open ${gapAsk(g, group.base)}`).join(' · ')}
            >
              missing hedge
            </Chip>
          ) : (
            <Chip sm tone="amber" title="Every floating leg is covered but the perps do not cancel across venues — price risk is live">
              perps don’t cancel
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

      {/* The hero in its own panel, bordered in the accent so it reads as
          the ONE set of numbers; the ledgers below wear the plain hairline. */}
      <div className="mb-3 rounded border border-info/30 bg-info/[0.04] px-4 pb-1 pt-3.5">
        {/* Hero — exactly what he asked to know: PnL (ROI in brackets),
            the CURRENT locked APR, and capital. Carry lives on the stats
            strip below; nothing else competes up here. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-7 gap-y-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400" title="Lifetime PnL since the start date (ROI = PnL over current capital, in brackets)">
              Total PnL
            </div>
            <button
              type="button"
              className="num mt-2 text-left text-2xl font-semibold leading-none tracking-[-0.02em] hover:opacity-80"
              title={`Click for the full breakdown. Carry − fees ${fmtUsd(totals.pnlUsd - totals.priceResidualUsd)} (settled — doesn't move with the tick) + price basis ${fmtUsd(totals.priceResidualUsd)} (open marks ${fmtUsd(totals.breakdown.perpUpnlUsd)} + closed realized price ${fmtUsd(totals.priceResidualUsd - totals.breakdown.perpUpnlUsd)} — the two sides of the hedge; expected near 0 on a delta-neutral book, and the only part that breathes with the market).`}
              onClick={() => setFeesOpen(true)}
            >
              <SignedNumber value={totals.pnlUsd} format={fmtUsd} />
              {derived.roi !== null && (
                <span className="ml-2 text-[12.5px] font-normal text-ink-300">
                  (<SignedNumber value={derived.roi} format={fmtPct} className="!text-ink-400" />)
                </span>
              )}
            </button>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400" title="The rate the hedge locks RIGHT NOW: on covered venues the floating sides cancel, leaving each Boros leg's fixed side — deterministic while the hedge holds. Steps down as legs mature (maturities differ per leg). Dash = the hedge isn't complete.">
              Current APR (Fixed)
            </div>
            <div className="num mt-2 text-2xl font-semibold leading-none tracking-[-0.02em]">
              {derived.lockedAprFwd !== null ? (
                <SignedNumber value={derived.lockedAprFwd} format={fmtPct} />
              ) : (
                '—'
              )}
            </div>
            {derived.lockedCarryPerYearUsd !== null && (
              <div
                className="num mt-2 text-[11px] leading-none text-ink-400"
                title={`The locked rate in dollars per day at today's notionals — deterministic while the hedge holds; steps down as legs mature.${derived.lockedNotionalUsd !== null ? ` Quoted on the Boros legs' notional it is ${fmtPct(derived.lockedCarryPerYearUsd / derived.lockedNotionalUsd)} on ${fmtUsdCompact(derived.lockedNotionalUsd)} (the cross-farm comparison basis; the headline % is on margin, which leverage inflates).` : ''}`}
              >
                ≈ <SignedNumber value={derived.lockedCarryPerYearUsd / 365} format={fmtUsd} className="!text-ink-400" />
                /day
              </div>
            )}
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400" title="Initial margin currently required across every counted leg">
              Capital
            </div>
            <div className="num mt-2 text-2xl font-semibold leading-none tracking-[-0.02em] text-ink-50">
              {fmtUsd(totals.capitalUsd)}
            </div>
          </div>
          {/* Cost as the fourth hero number: PnL = carry − cost, and the
              composition lives on hover; the per-leg audit on click. */}
          <div>
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400"
              title="Everything that eats into the carry, whenever it was paid: perp fees + Boros fees − price basis. PnL = carry − cost."
            >
              Lifetime Cost
            </div>
            <button
              type="button"
              className="num mt-2 text-left text-2xl font-semibold leading-none tracking-[-0.02em] text-ink-50 hover:opacity-80"
              title={`Perp fees ${fmtUsd(totals.perpFeesAllUsd)} + Boros fees ${fmtUsd(totals.borosFeesAllUsd)} − price basis ${fmtUsd(totals.priceResidualUsd)}. Click to open.`}
              onClick={() => setCostOpen(true)}
            >
              {totals.costUsd < 0 ? '+' : '−'}{fmtUsd(Math.abs(totals.costUsd))}
            </button>
          </div>
        </div>

        {/* The waterfall is the hero drawn as bars, so it opens from the hero
            rather than living in a box of its own at the bottom. */}
        {/* The toggle rides BELOW the bars when they're open, so "see less"
            is where the eye already is after reading the chart — which a
            <details> can't do, its summary always comes first. */}
        <div className="mt-1">
          {/* pt-3: the plot draws each bar's value label above the bar, so the
              tallest one needs headroom or it lands on the tile row. */}
          {wfOpen && (
            <div className="pt-3">
              <AssetBars totals={totals} />
            </div>
          )}
          <button
            type="button"
            className="mx-auto flex items-center gap-1.5 py-1 text-[11px] text-ink-400 hover:text-ink-100"
            aria-expanded={wfOpen}
            onClick={() => setWfOpen((v) => !v)}
          >
            {wfOpen ? 'see less ▴' : 'see PnL waterfall ▾'}
          </button>
        </div>
      </div>

      {/* Hedge status — only what needs doing. A perfect hedge says so in
          the header badge; a ribbon repeating it was a box for nothing. */}
      {hasLegs && (!derived.deltaNeutral || expiring.length > 0) && (
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
        </div>
      )}

      {/* CARRY — what the farm pays. Open legs (gross), everything set aside,
          and the completed legs, footed to one number. Collapsible so the
          card reads as the equation above when you don't need the rows. */}
      <details open className="group/carry mb-3 rounded border border-ink-700">
        <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-[10px] text-ink-400 group-open/carry:rotate-90">▸</span>
          <span className={microLabelClass}>Funding Legs</span>
          <span className="text-[11px] text-ink-400">what the farm pays — open legs and completed, before fees</span>
          <span className="num ml-auto text-sm font-semibold">
            <SignedNumber value={totals.carryGrossUsd} format={fmtUsd} />
          </span>
        </summary>
        <div className="border-t border-ink-800 px-3.5 pb-3.5 pt-2">
        {/* Legs */}
        {hasLegs ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-ink-850 [&_td]:px-2.5 [&_td]:py-[9px]">
              <thead>
                <tr>
                  <th className="th text-left">Leg</th>
                  <th className="th text-right">Size</th>
                  <th className="th text-right">Entry → Mark</th>
                  <th className="th text-right">Funding / Settled</th>
                  <th className="th text-right"> </th>
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
                    onClose={livePositions.has(l.symbol) ? () => setCloseLeg({ kind: 'perp', leg: l }) : undefined}
                    deficit={deficitFor(l.venue, 'perp')}
                    onOpenMore={(() => { const g = deficitFor(l.venue, 'perp'); return g ? armGap(g) : undefined; })()}
                  />
                ))}
                {missing('perp').map((g) => (
                  <MissingRow key={`missing-perp-${g.venue}`} gap={g} base={group.base} onOpen={armGap(g)} asPair={!!pairPartner(g)} />
                ))}
                {borosSorted.map((l) => (
                  <BorosRow
                    key={l.marketId}
                    leg={l}
                    base={group.base}
                    deficit={deficitFor(l.venue, 'boros')}
                    onOpenMore={(() => { const g = deficitFor(l.venue, 'boros'); return g ? armGap(g) : undefined; })()}
                    onClose={() => setCloseLeg({ kind: 'boros', leg: l })}
                    windowedGrossUsd={(() => {
                      const h = histByMarket.get(l.marketId);
                      if (!h) return null;
                      const settle = h.settleUsd + h.settleFeeUsd;
                      const trade = h.tradePnlUsd + h.tradeFeeUsd;
                      return { gross: settle + trade, settle, trade };
                    })()}
                    windowedFeesUsd={(() => {
                      const h = histByMarket.get(l.marketId);
                      return h ? h.settleFeeUsd + h.tradeFeeUsd : null;
                    })()}
                    exclusions={exclusions}
                    onExclude={onExclude}
                  />
                ))}
                {missing('boros').map((g) => (
                  <MissingRow key={`missing-boros-${g.venue}`} gap={g} base={group.base} onOpen={armGap(g)} asPair={!!pairPartner(g)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-ink-700 px-3 py-3 text-center text-sm text-ink-500">
            No open legs — the totals above are history since the start date.
          </p>
        )}

        {/* Everything set aside from the farm, orphaned together: whole legs
            and partial slices alike, each with the level it was carved out at,
            so what left the hedge/PnL/capital is never out of sight. */}
        {excludedRows.length > 0 && (
          <div className="mt-3 overflow-hidden rounded border border-ink-700">
            <div className="flex flex-wrap items-center gap-2 border-b border-ink-850 bg-ink-100/[0.04] px-3.5 py-2">
              <span className={microLabelClass}>Excluded</span>
              <span className="text-[11px] text-ink-400">
                set aside from the farm — not in the hedge, PnL or capital
              </span>
            </div>
            <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-ink-850 [&_td]:px-2.5 [&_td]:py-2 [&_tr:last-child_td]:border-b-0">
              <tbody>
                {excludedRows.map((r) => {
                  const at = exclusionAt(exclusions[r.key]);
                  const show = (v: number) => (r.entryKind === 'rate' ? fmtPct(v) : fmtUsd(v));
                  return (
                    <tr key={r.key}>
                      <td className="whitespace-nowrap text-ink-50">{r.label}</td>
                      <td className="num whitespace-nowrap text-right text-ink-100">
                        {fmtTokenQty(r.frac * r.legQty, r.unit)}
                        <span className="ml-1 text-ink-400">{r.frac >= 1 ? 'whole leg' : 'slice'}</span>
                      </td>
                      <td className="num whitespace-nowrap text-right text-ink-300">
                        {at !== null ? (
                          <span title="The level this slice was carved out at; the remainder's entry is the weighted residual">
                            at {show(at)}
                          </span>
                        ) : (
                          <span className="text-ink-500" title="No level given — split pro-rata at the leg's average">
                            at avg {show(r.entry)}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            className="btn-ghost-xs"
                            title="Count this leg in the farm again, whole"
                            onClick={() => onExclude(r.key, undefined)}
                          >
                            restore
                          </button>
                          <EditCell
                            exKey={r.key}
                            label={r.label}
                            unit={r.unit}
                            legQty={r.legQty}
                            entry={r.entry}
                            entryKind={r.entryKind}
                            current={exclusions[r.key]}
                            onExclude={onExclude}
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasLegs && (
          // Side by side: the two are the same KIND of fact (what this asset's
          // finished legs contributed), so the mock reads them as one row.
          // They stack only when the viewport can't seat both.
          <div className="mt-2 grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
            {/* Both strips always, so the row never leaves a hole: an empty one
                says "none yet" and stays flat. */}
            {ribbon(
              'Closed/Matured Boros Legs',
              doneBoros.length > 0 ? `${doneBoros.length} market${doneBoros.length === 1 ? '' : 's'}` : 'none yet',
              borosCarry,
              'funding settlement',
              () => setDoneOpen('boros'),
              doneBoros.length === 0,
            )}
            {ribbon(
              'Closed Perps Legs',
              completedPerps.length > 0
                ? `${completedPerps.length} closed pair${completedPerps.length === 1 ? '' : 's'}`
                : 'none yet',
              perpCarry,
              'funding settlement',
              () => setDoneOpen('perps'),
              completedPerps.length === 0,
            )}
            {doneOpen === 'boros' && (
              <CompletedBorosModal
                rows={doneBoros}
                base={group.base}
                carry={borosCarry}
                nowSec={nowSec}
                onClose={() => setDoneOpen(null)}
              />
            )}
            {doneOpen === 'perps' && (
              <CompletedPerpsModal
                rows={completedPerps}
                base={group.base}
                carry={perpCarry}
                onClose={() => setDoneOpen(null)}
              />
            )}
          </div>
        )}
        </div>
      </details>





      {/* Pairs are a DIFFERENT PROJECTION of the same total — an estimated
          4-leg regrouping — so they sit at the very bottom, away from the
          accounting: dashed, muted, and one click away. */}
      {derived.pairs.length > 0 && (
        <button
          type="button"
          onClick={() => setPairsOpen(true)}
          className="mt-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded border border-dashed border-ink-600 px-3.5 py-2 text-left text-xs transition-colors hover:border-ink-500"
          title="Rough 4-leg sub-strategies: the short side and its Boros legs sliced proportionally by today's sizes — reference only. Opens the pair table."
        >
          <span className={microLabelClass}>4 Leg Arbitrage Pairs Breakdown</span>
          {derived.pairs.map((p) => (
            <span key={`${p.longVenue}:${p.shortVenue}`} className="num whitespace-nowrap text-ink-200">
              {prettyVenue(p.longVenue)}/{prettyVenue(p.shortVenue)}{' '}
              {p.lockedAprFwd !== null ? (
                <SignedNumber value={p.lockedAprFwd} format={fmtPct} />
              ) : (
                <span className="text-ink-600">—</span>
              )}
            </span>
          ))}
          <span className="ml-auto text-[11px] text-ink-400">a different view of the same PnL ›</span>
        </button>
      )}
      {pairsOpen && (
        <Modal title={`${group.base} — 4 leg arbitrage pairs breakdown`} onClose={() => setPairsOpen(false)} widthClass="w-[860px] max-w-[calc(100vw-32px)]">
          <p className="mb-3 text-[11.5px] text-ink-300">
            The book as 4-leg pairs, split by today’s sizes — reference only.
          </p>
    <div className="overflow-x-auto rounded border border-ink-700">
      <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-ink-850">
        <thead>
          <tr>
            <th className="th text-left">Pair</th>
            <th className="th text-right">Size</th>
            <th className="th text-right">Notional</th>
            <th className="th text-right">Capital</th>
            <th className="th text-right">Locked APR</th>
            <th className="th text-right">Matures</th>
                  <th className="th text-right" />
          </tr>
        </thead>
        <tbody>
          {derived.pairs.map((p) => (
            <Fragment key={`${p.longVenue}:${p.shortVenue}`}>
                  <tr className="[&>td]:!border-b-0">
              <td className="whitespace-nowrap px-2.5 py-2 text-ink-100">
                <span className="inline-flex items-center gap-[7px]">
                  <span className="inline-flex items-baseline gap-[5px]">
                    <span className="text-[9.5px] font-semibold tracking-[0.1em] text-grass">
                      L
                    </span>
                    <span className="font-medium text-ink-50">
                      {prettyVenue(p.longVenue)}
                    </span>
                  </span>
                  <span className="text-ink-600">/</span>
                  <span className="inline-flex items-baseline gap-[5px]">
                    <span className="text-[9.5px] font-semibold tracking-[0.1em] text-guava">
                      S
                    </span>
                    <span className="font-medium text-ink-50">
                      {prettyVenue(p.shortVenue)}
                    </span>
                  </span>
                </span>
              </td>
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                {sizeLabel(p.size, p.unit, group.base)}
              </td>
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                {fmtUsdCompact(p.notionalUsd)}
              </td>
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                {fmtUsdCompact(p.capitalUsd)}
              </td>
              <td
                className="num whitespace-nowrap px-2.5 py-2 text-right font-semibold"
                title="Locked forward APR of this pair (no fees) — the trustworthy per-pair number"
              >
                {p.lockedAprFwd !== null ? (
                  <SignedNumber value={p.lockedAprFwd} format={fmtPct} />
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </td>
              {/* Every maturity the pair's YU legs sit at — a pair laddered
                  over two terms shows both, soonest first. */}
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-200">
                {(() => {
                  const ms = [...new Set(p.legs.filter((l) => l.kind === 'yu' && l.maturity > 0).map((l) => l.maturity))].sort((a, b) => a - b);
                  return ms.length === 0 ? <span className="text-ink-600">—</span> : ms.map((m, i) => (
                    <span key={m} title={fmtDateLocal(m)}>
                      {i > 0 && <span className="text-ink-600"> · </span>}
                      {fmtDateLocal(m)}
                    </span>
                  ));
                })()}
              </td>
              
            
                    <td className="whitespace-nowrap px-2.5 py-2 text-right">
                      <button
                        type="button"
                        className="btn-ghost-xs"
                        title="Reconstruct this pair: per-leg funding, Boros settlements and fees, with entry/exit-fee toggles"
                        onClick={() => {
                          setPairsOpen(false);
                          setPairOpen(p);
                        }}
                      >
                        details
                      </button>
                    </td>
                  </tr>
                  {/* Actions on their own row: three buttons beside five
                      columns overflowed the popup; under the pair they read
                      as what you can do WITH that pair. */}
                  <tr>
                    <td colSpan={7} className="px-2.5 pb-2.5 pt-1">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                      
                      <button
                        type="button"
                        className="btn-ghost-xs text-guava"
                        disabled={p.unit !== 'base'}
                        title={
                          p.unit === 'base'
                            ? "Close both perp legs of this pair as one reduce-only action — you confirm in the form. A leg shared with another pair closes only this pair's share."
                            : 'This market sizes in USD; close its perps from the legs table instead'
                        }
                        onClick={() => {
                          setPairsOpen(false);
                          setClosePerps(p);
                        }}
                      >
                        close perps
                      </button>
                      <button
                        type="button"
                        className="btn-ghost-xs text-guava"
                        title="Close both Boros rate legs of this pair — you confirm in the form. A leg shared with another pair closes only this pair's share."
                        onClick={() => {
                          setPairsOpen(false);
                          setCloseBoros(p);
                        }}
                      >
                        close Boros
                      </button>
                    </span>
                    </td>
                  </tr>
                </Fragment>
          ))}
        </tbody>
      </table>
    </div>
        </Modal>
      )}

      {costOpen && (
        <Modal title={`${group.base} — cost`} onClose={() => setCostOpen(false)} widthClass="w-[420px]">
          <p className="mb-3 text-[11.5px] text-ink-300">
            Everything that eats into the carry, whenever it was paid. PnL = carry − cost.
          </p>
          <div className="flex flex-col gap-2 text-xs">
            {(
              [
                { k: 'perp', label: 'Perp fees', value: -totals.perpFeesAllUsd, title: 'Trading fees paid on the perp legs, open and closed. Paid once per trade, so they are charged here rather than on a leg.' },
                { k: 'boros', label: 'Boros fees', value: -totals.borosFeesAllUsd, title: 'Settlement and trade fees paid on the Boros legs, open and matured. Each Boros row shows its own share; they are charged once, here.' },
                { k: 'price', label: 'Price basis', value: totals.priceResidualUsd, title: "How the perp prices moved against you: open positions at today's mark plus the price gain or loss on closed ones. A hedged book expects this near zero — it is the one part of PnL that moves with the market." },
              ] as const
            ).map((r) => (
              <div key={r.k} className="flex items-baseline justify-between gap-3">
                <span className="text-ink-200 underline decoration-ink-700 decoration-dotted underline-offset-[3px]" title={r.title}>
                  {r.label}
                </span>
                <span className="num"><SignedNumber value={r.value} format={fmtUsd} /></span>
              </div>
            ))}
            <div className="mt-1 flex items-baseline justify-between border-t border-ink-800 pt-2">
              <span className={microLabelClass}>Cost</span>
              <span className="num text-base font-semibold text-ink-50">{totals.costUsd < 0 ? '+' : '−'}{fmtUsd(Math.abs(totals.costUsd))}</span>
            </div>
          </div>
          <div className="mt-3 text-right">
            <button type="button" className="btn-ghost-xs" onClick={() => { setCostOpen(false); setFeesOpen(true); }}>
              full PnL breakdown
            </button>
          </div>
        </Modal>
      )}
      {closePerps !== null && (
        <Modal
          title={`Close ${group.base} — ${prettyVenue(closePerps.longVenue)} / ${prettyVenue(closePerps.shortVenue)} perp legs`}
          onClose={() => setClosePerps(null)}
          widthClass="w-[460px]"
        >
          <div className="flex flex-col gap-3">
            {/* The preview below lists each leg and its size; only a SHARED
                leg needs a word, because its size is less than the venue
                holds. Everything else this ticket does is on hover. */}
            {closePerps.legs.some((l) => l.kind === 'perp' && l.share < 0.9995) && (
              <div className="text-[11px] text-gold">
                {closePerps.legs
                  .filter((l) => l.kind === 'perp' && l.share < 0.9995)
                  .map((l) => `${prettyVenue(l.venue)} ${fmtPct(l.share)} share`)
                  .join(' · ')}
                <span className="text-ink-500" title="The rest of that venue position belongs to another pair and stays open"> — rest stays open</span>
              </div>
            )}
            <ClosePairForm
              base={group.base}
              legs={closePerps.legs
                .filter((l) => l.kind === 'perp' && l.symbol)
                .map((l) => ({
                  symbol: l.symbol as string,
                  qty: l.size,
                  venue: l.venue,
                  partial: l.share < 0.9995,
                }))}
              livePositions={livePositions}
            />
            <button
              type="button"
              className="btn self-start"
              onClick={() => {
                setClosePerps(null);
                setPairsOpen(true);
              }}
            >
              ← Pairs
            </button>
          </div>
        </Modal>
      )}
      {closeLeg?.kind === 'perp' && livePositions.get(closeLeg.leg.symbol) && (
        <ClosePopover
          position={livePositions.get(closeLeg.leg.symbol)!}
          onDismiss={() => setCloseLeg(null)}
        />
      )}
      {closeLeg?.kind === 'boros' && (
        <Modal
          title={`Close ${group.base} — ${prettyVenue(closeLeg.leg.venue)} ${closeLeg.leg.side} Boros leg`}
          onClose={() => setCloseLeg(null)}
          widthClass="w-[460px]"
        >
          <CloseBorosForm
            legs={[
              {
                kind: 'boros',
                venue: closeLeg.leg.venue,
                base: group.base,
                side: closeLeg.leg.side,
                notionalUsd: closeLeg.leg.notionalUsd,
                collateral: closeLeg.leg.collateral,
                notionalToken: closeLeg.leg.sizeToken,
                marketId: closeLeg.leg.marketId,
                entryApr: closeLeg.leg.entryApr,
                markApr: closeLeg.leg.markApr,
                maturity: closeLeg.leg.maturity,
                share: 1,
                cashFlowUsd: 0,
                mtmUsd: 0,
                tradePnlUsd: 0,
                feesUsd: 0,
                netUsd: 0,
                openedAt: null,
                warnings: [],
              },
            ]}
            onDone={() => setCloseLeg(null)}
          />
        </Modal>
      )}
      {closeBoros !== null && (
        <Modal
          title={`Close ${group.base} — ${prettyVenue(closeBoros.longVenue)} / ${prettyVenue(closeBoros.shortVenue)} Boros legs`}
          onClose={() => setCloseBoros(null)}
          widthClass="w-[460px]"
        >
          <div className="flex flex-col gap-3">
            <CloseBorosForm
              legs={closeBoros.legs
                .filter((l) => l.kind === 'yu' && l.marketId !== undefined)
                .flatMap((l): StrategyLeg[] => {
                  const b = group.borosOpen.find((x) => x.marketId === l.marketId);
                  if (!b) return [];
                  // The pair's attributed slice of the venue position — a
                  // shared leg closes only its share.
                  return [
                    {
                      kind: 'boros',
                      venue: b.venue,
                      base: group.base,
                      side: b.side,
                      notionalUsd: b.notionalUsd * (l.size / b.sizeToken),
                      collateral: b.collateral,
                      notionalToken: l.size,
                      marketId: b.marketId,
                      entryApr: b.entryApr,
                      markApr: b.markApr,
                      maturity: b.maturity,
                      share: l.share,
                      cashFlowUsd: 0,
                      mtmUsd: 0,
                      tradePnlUsd: 0,
                      feesUsd: 0,
                      netUsd: 0,
                      openedAt: null,
                      warnings: [],
                    },
                  ];
                })}
              onDone={() => setCloseBoros(null)}
            />
            <button
              type="button"
              className="btn self-start"
              onClick={() => {
                setCloseBoros(null);
                setPairsOpen(true);
              }}
            >
              ← Pairs
            </button>
          </div>
        </Modal>
      )}
      {pairOpen !== null && (
        <PairModal
          pair={pairOpen}
          base={group.base}
          onClose={() => setPairOpen(null)}
          onBack={() => {
            setPairOpen(null);
            setPairsOpen(true);
          }}
        />
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
                  <span
                    className="text-ink-600"
                    title="Mark value of the open Boros rate streams — converges to zero at maturity; excluded from PnL"
                  >
                    Boros MtM{' '}
                    <span className="num">
                      <SignedNumber value={totals.mtmUsd} format={fmtUsd} className="!text-ink-500" />
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
                        <td className={`${cell} text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400`} colSpan={2}>
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
                        <td className={`${cell} text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400`} colSpan={2}>
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