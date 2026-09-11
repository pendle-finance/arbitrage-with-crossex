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
import type { SharePayloadV1 } from '../../lib/shareCodec';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, num, prettyVenue, signedClass } from '../../lib/fmt';
import { describeLine, lineLabel, type LiquidationLine } from '../../lib/liquidation';
import {
  type AssetDerived,
  type ExclusionEntry,
  type Exclusions,
  type HedgeGapRow,
  type PairEstimate,
  type VenueHedge,
  SECONDS_IN_YEAR,
  borosKey,
  defaultChargePerpFees,
  borosHistoryKeep,
  excludedFraction,
  exclusionAt,
  exclusionQty,
  keptSlice,
  perpKey,
  pairBorosCloseLegs,
  pairPerpCloseLegs,
  sizeIn,
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
  /** Per-Boros-leg "counted from" (borosKey → unix sec) — history before it
   * is an earlier use of the market, not this farm's. */
  legSince?: Record<string, number>;
  onLegSince?: (key: string, sec: number | undefined) => void;
  /** Where the ACCOUNT liquidates if only this coin moves. 'far' = no line
   * within 10x, 'unknown' = Gate sent no margin figures, null = not loaded
   * or this coin has no priced leg in the connected account. */
  liquidation?: LiquidationLine | 'far' | 'unknown' | null;
}

/** Where this coin's move liquidates the account. Red inside 15%, amber
 * inside 30%: a hedged asset is delta-neutral but not margin-neutral — the
 * losing Hyperliquid leg drives its USDC wallet into a borrow, and Gate
 * charges maintenance margin on that. */
function LiquidationChip({ line, base }: { line: LiquidationLine | 'far' | 'unknown'; base: string }) {
  if (line === 'unknown') {
    return (
      <Chip sm title="Gate did not send the account's margin figures, so the line cannot be estimated.">
        No liquidation estimate
      </Chip>
    );
  }
  if (line === 'far') {
    return (
      <Chip
        sm
        title={`Estimate: the account is not liquidated if ${base} rises 10x or falls 98% and every other coin holds still.`}
      >
        {`Safe through a 10x ${base} pump or 98% dump`}
      </Chip>
    );
  }
  const near = Math.abs(line.move);
  return (
    <Chip sm tone={near < 0.15 ? 'red' : near < 0.3 ? 'amber' : 'neutral'} className="num" title={describeLine(line)}>
      {lineLabel(line)}
    </Chip>
  );
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
 * The unrounded figure behind an abbreviated one ("1.6k ETH" → "1,539.103
 * ETH"), for a `title`. Sizes here are abbreviated to keep the columns
 * narrow, but a trader sizing a close needs the real number — and reading
 * it should not require opening another view.
 */
const exactQty = (size: number, base: string): string =>
  `${num(size, size >= 1000 ? 3 : 6).replace(/\.?0+$/, '')} ${base}`;
const exactUsd = (usd: number): string => fmtUsd(usd);
/** The exact figure in whichever unit the size is in — a USD-unit asset's
 * sizes are dollars, and printing them with the coin ticker would read
 * "20k SOL" for a $20k position. */
const exactSize = (size: number, unit: 'base' | 'usd', base: string): string =>
  unit === 'base' ? exactQty(size, base) : exactUsd(size);

/** "16d left" / "matured" — the term in the unit a trader thinks in. */
const daysLeftText = (maturitySec: number, nowSec: number): string => {
  const days = Math.ceil((maturitySec - nowSec) / 86_400);
  return days > 0 ? `${days}d left` : 'matured';
};

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
  /**
   * The share payload is FROZEN when Share is clicked, never rebuilt while
   * the modal is open. Passing a freshly-built object on every render made
   * `SharePositionModal`'s effects (short-link mint, card render) see a new
   * `payload` identity each time; each one set state, which re-rendered this
   * card, which built another object — the link visibly reminted in a loop.
   * A frozen snapshot is also what the modal documents it receives.
   */
  const [sharePayload, setSharePayload] = useState<SharePayloadV1 | null>(null);
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
                <span title="The fixed rate these legs lock, already net of Boros settlement fees — those accrue to maturity whatever you do, so they are part of the rate, not a cost beside it. Trade and perp fees are the ones charged below.">
                  after settlement fees
                </span>
              </>
            ) : (
              'no locked rate'
            )}
          </span>
        </span>
        <span className="flex flex-col gap-2">
          <span className={microLabelClass}>Capital</span>
          <span
            className="num text-2xl font-semibold leading-none tracking-[-0.02em] text-ink-50"
            title={exactUsd(pair.capitalUsd)}
          >
            {fmtUsdCompact(pair.capitalUsd)}
          </span>
          <span className="num text-[11px] leading-none text-ink-400">
            <span title={exactSize(pair.size, pair.unit, base)}>{sizeLabel(pair.size, pair.unit, base)}</span> ·{' '}
            <span title={exactUsd(pair.notionalUsd)}>{fmtUsdCompact(pair.notionalUsd)} notional</span>
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
                  <span title={exactSize(sizeIn(l, pair.unit), pair.unit, base)}>{sizeLabel(sizeIn(l, pair.unit), pair.unit, base)}</span>
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
                  {/* TODAY'S requirement, on every leg — the same figure the
                      Capital hero above sums, so the column foots to it. A
                      Boros leg's margin decays toward maturity; that is the
                      number, not a defect (his call 2026-09-09). */}
                  {(
                    <span title={l.kind === 'yu' ? "Today's requirement — Boros margin decays toward maturity, and this is what the leg ties up now" : 'Initial margin this slice consumes'}>
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
              'Boros trade fees paid',
              'What crossing the Boros book cost when these legs were opened. Settlement fees are NOT here: they accrue to maturity however you enter or roll, so they are already netted out of the locked rate above.',
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
          <button
            type="button"
            className="btn"
            onClick={() =>
              setSharePayload(
                pairSharePayload(pair, base, { nowSec, inclPerpFees, inclExitFee, netApr, netUsd }),
              )
            }
          >
            Share this pair
          </button>
        </span>
        <span className="text-[11px] text-ink-400">
          Proportional split by today’s sizes — reference only.
        </span>
      </div>
      {sharePayload && (
        <SharePositionModal payload={sharePayload} onClose={() => setSharePayload(null)} />
      )}
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
        <LegIdentity
          kind={gap.leg}
          dim
          name={prettyVenue(gap.venue)}
          sub="not open yet"
          chips={<Chip sm tone="amber">missing</Chip>}
        />
      </td>
      <td className="num text-right text-ink-300">
        {sizeLabel(gap.want, gap.unit, base)}
        <span className="ml-1 text-ink-500">needed</span>
      </td>
      <td className="text-right text-ink-600">—</td>
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
  legSince,
  onLegSince,
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
  /** This leg's "counted from" instant (Boros only) and its setter. */
  legSince?: number;
  onLegSince?: (sec: number | undefined) => void;
}) {
  const [sinceStr, setSinceStr] = useState(legSince && legSince > 0 ? toDateInput(legSince) : '');
  const curQty = current === 'all' ? legQty : exclusionQty(current);
  const curAt = exclusionAt(current);
  const [mode, setMode] = useState<'all' | 'portion'>(current === undefined ? 'all' : 'portion');
  const [qtyStr, setQtyStr] = useState(curQty !== null ? String(curQty) : '');
  const fmtAt = (v: number) => (entryKind === 'rate' ? String(+(v * 100).toFixed(4)) : String(+v.toFixed(2)));
  const [atStr, setAtStr] = useState(fmtAt(curAt ?? entry));
  const qty = Number(qtyStr);
  const qtyOk = Number.isFinite(qty) && qty > 0;
  const atRaw = Number(atStr);
  // A rate may be negative (negative funding); a price may not.
  const at = Number.isFinite(atRaw) && (entryKind === 'rate' || atRaw >= 0) ? (entryKind === 'rate' ? atRaw / 100 : atRaw) : null;
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
    if (onLegSince) {
      const sec = sinceStr ? Math.floor(new Date(`${sinceStr}T00:00`).getTime() / 1000) : 0;
      onLegSince(Number.isFinite(sec) && sec > 0 ? sec : undefined);
    }
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
      {onLegSince && (
        /* A market traded before, closed, and re-opened for THIS farm carries
           settlements the farm never earned. The date says where this
           position starts; everything earlier on this market is dropped
           from its history — settlements, fees and trade PnL alike. */
        <label className="mb-4 flex flex-col gap-1.5">
          <span className={microLabelClass}>Counted from (optional)</span>
          <span className="flex items-center gap-2">
            <input
              type="date"
              className="input w-40 px-2 py-1 text-xs"
              value={sinceStr}
              max={toDateInput(Math.floor(Date.now() / 1000))}
              onChange={(e) => setSinceStr(e.target.value)}
              aria-label="Date this position is counted from"
              title="History on this market before this date (local midnight) belongs to an earlier position and is left out. Empty = from the asset's start date."
            />
            {sinceStr && (
              <button type="button" className="btn-ghost-xs" onClick={() => setSinceStr('')}>
                clear
              </button>
            )}
          </span>
        </label>
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

/** The trailing cell of a leg row: Edit opens the exclude popup, Close leg
 * the close ticket for that one leg. Words, not icons — the column is as
 * wide as a figure column, and words need no tooltip to be read. */
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
        className={`btn-ghost-xs !py-[5px] ${has ? '!text-gold' : ''}`}
        title={has ? 'Part of this leg is excluded — edit or restore' : 'Exclude some or all of this leg from the farm'}
        onClick={() => setOpen(true)}
      >
        Edit
      </button>
      {closeTitle && (
        <button
          type="button"
          aria-label={`Close ${props.label}`}
          className="btn-ghost-xs !py-[5px] hover:!border-guava/50 hover:!text-guava"
          title={closeTitle}
          disabled={!onCloseLeg}
          onClick={onCloseLeg}
        >
          Close leg
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


/** The first cell of every leg row: the leg's KIND as a chip, then the
 * venue with one line under it (what, or when). One shape for live, absent
 * and finished legs, so the column reads as one list. */
function LegIdentity({
  kind,
  dim,
  name,
  sub,
  chips,
}: {
  kind: 'perp' | 'boros';
  /** A finished or absent leg — drawn quieter. */
  dim?: boolean;
  name: string;
  sub: React.ReactNode;
  chips?: React.ReactNode;
}) {
  const boros = kind === 'boros';
  return (
    <span className="inline-flex items-center gap-3 leading-none">
      <Chip
        sm
        tone={boros ? 'link' : 'neutral'}
        className={`w-[52px] justify-center !px-0 !py-[3px] !text-[11px] ${dim ? 'opacity-60' : ''}`}
      >
        {boros ? 'Boros' : 'Perp'}
      </Chip>
      <span className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-[7px]">
          <span className={`text-[12.5px] font-medium leading-none ${dim ? 'text-ink-200' : 'text-ink-50'}`}>{name}</span>
          {chips}
        </span>
        <span className="num text-[11px] leading-none text-ink-400">{sub}</span>
      </span>
    </span>
  );
}

/** The six columns a bundle and its legs share — identity, then the four
 * figures (each leg column sums to the bundle figure above it), then the
 * actions. Declared once so the two tables cannot drift apart. */
function BundleColGroup() {
  return (
    <colgroup>
      <col style={{ width: '25%' }} />
      <col style={{ width: '13%' }} />
      <col style={{ width: '15%' }} />
      <col style={{ width: '16%' }} />
      <col style={{ width: '16%' }} />
      <col style={{ width: '15%' }} />
    </colgroup>
  );
}


/** Four bars of falling height — the waterfall, at 12px. */
function WaterfallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden className="text-ink-400">
      <rect x="1" y="2" width="3" height="12" rx="0.5" />
      <rect x="5.5" y="5" width="3" height="9" rx="0.5" />
      <rect x="10" y="8" width="3" height="6" rx="0.5" />
      <rect x="14" y="11" width="1.5" height="3" rx="0.5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
function PerpRow({
  leg,
  base,
  exclusions,
  onClose,
  deficit,
  onOpenMore,
}: {
  leg: AssetPerpOpen;
  base: string;
  exclusions: Exclusions;
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
      <td className="whitespace-nowrap">
        {/* The side is on the bundle row above; every leg of a bundle
            shares it, so repeating it per row said nothing new. */}
        <LegIdentity
          kind="perp"
          name={prettyVenue(leg.venue)}
          sub="CrossEx · hedge"
          chips={deficit && <DeficitChip gap={deficit} base={base} />}
        />
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
        title={`Venue cumulative funding on this position · fees ${fmtUsd(leg.feesUsd)} · IM ${fmtUsd(leg.imUsd)}`}
      >
        <SignedNumber value={leg.fundingUsd} format={fmtUsd} />
      </td>
      <td className="num text-right" title="Unrealised price PnL at today's mark — part of the perp basis, not of funding">
        <SignedNumber value={leg.upnlUsd} format={fmtUsd} />
      </td>
      <td className="whitespace-nowrap text-right">
        {/* No ✎ here: exclusions are Boros-only (his call 2026-09-09) — a
            perp leg is never set aside from the farm, so the row offers only
            the close. */}
        <span className="inline-flex items-center gap-1">
          {deficit && <OpenMoreButton gap={deficit} base={base} onOpen={onOpenMore} />}
          <button
            type="button"
            aria-label={`Close ${prettyVenue(leg.venue)} ${leg.side} perp`}
            className="btn-ghost-xs !py-[5px] hover:!border-guava/50 hover:!text-guava"
            title={onClose ? 'Close this perp leg — reduce-only at mark' : 'Live position not loaded yet'}
            disabled={!onClose}
            onClick={onClose}
          >
            Close leg
          </button>
        </span>
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
  legSince,
  onLegSince,
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
  legSince?: number;
  onLegSince?: (sec: number | undefined) => void;
}) {
  const key = borosKey(leg.marketId);
  const slice = keptSlice(exclusions, key, leg.sizeToken, leg.entryApr);
  const exFrac = 1 - slice.keep;
  return (
    <tr className="group">
      <td className="whitespace-nowrap">
        <LegIdentity
          kind="boros"
          name={prettyVenue(leg.venue)}
          chips={deficit && <DeficitChip gap={deficit} base={base} />}
          sub={
            <span title="Maturity — coverage lapses here; the position itself just settles and ends">
              {fmtDateLocal(leg.maturity)}
              {(() => {
                const days = Math.ceil((leg.maturity - Date.now() / 1000) / 86400);
                return days > 0 ? (
                  <>
                    {' · '}
                    <span className="text-ink-200">{days}d</span>
                  </>
                ) : null;
              })()}
            </span>
          }
        />
      </td>
      <td className="num text-right" title={exFrac > 0 ? `Whole leg ${fmtTokenQty(leg.sizeToken, leg.collateral)} (${fmtUsdCompact(leg.notionalUsd)}) — ${fmtTokenQty(exFrac * leg.sizeToken, leg.collateral)} excluded` : undefined}>
        {fmtTokenQty(leg.sizeToken * slice.keep, leg.collateral)}
        <span className="ml-1 text-ink-500">({fmtUsdCompact(leg.notionalUsd * slice.keep)})</span>
        {exFrac > 0 && <span className="ml-1 text-gold" title="Part of this leg is excluded from the farm">of {fmtTokenQty(leg.sizeToken, leg.collateral)}</span>}
      </td>
      <td className="num text-right text-ink-100" title={slice.at !== null && slice.entry !== leg.entryApr ? `Venue average ${fmtPct(leg.entryApr)} — the remainder's rate after carving out ${fmtTokenQty(exFrac * leg.sizeToken, leg.collateral)} at ${fmtPct(slice.at)}` : undefined}>
        {fmtPct(slice.entry)} → {fmtPct(leg.markApr)}

      </td>
      <td
        className="num text-right"
        title={
          windowedGrossUsd === null
            ? `No settlements or trades inside this window · MtM ${fmtUsd(leg.mtmUsd)} · IM ${fmtUsd(leg.imUsd)}`
            : `Funding settlements inside your window, net of their settlement fees — the part of this leg in the Fixed funding bar. Position-lifetime settled ${fmtUsd(leg.settleUsd)} · MtM ${fmtUsd(leg.mtmUsd)} · IM ${fmtUsd(leg.imUsd)}`
        }
      >
        {windowedGrossUsd === null ? (
          <span className="text-ink-600">—</span>
        ) : (
          <SignedNumber value={windowedGrossUsd.settle} format={fmtUsd} />
        )}
        {windowedFeesUsd !== null && windowedFeesUsd > 0 && (
          <div
            className="text-[10px] text-ink-500"
            title="Settlement fees this market charged inside your window — already taken out of the figure above, and out of the locked rate. Shown so the deduction is visible; trade fees are separate and sit in Cost."
          >
            settle fees −{fmtUsd(windowedFeesUsd)}
          </div>
        )}
      </td>
      {/* Realised rate PnL from a partial close — its own column, never
          folded into the settlement figure, so the settled column sums to
          the Fixed funding bar and this one to the Boros trade bar. */}
      <td className="num text-right" title="Realised rate PnL from closing part of this leg early, before its trade fee (the fee sits in Cost)">
        {windowedGrossUsd !== null && Math.abs(windowedGrossUsd.trade) >= 0.005 ? (
          <SignedNumber value={windowedGrossUsd.trade} format={fmtUsd} />
        ) : (
          <span className="text-ink-600">—</span>
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
          legSince={legSince}
          onLegSince={onLegSince}
          onCloseLeg={onClose}
          closeTitle="Close this Boros leg — market order on Boros"
        />
      </td>
    </tr>
  );
}


/** A finished YU market at this venue — matured, or closed early — with
 * the same columns as a live leg so the two read as one list. */
function InactiveBorosRow({
  h,
  leg,
  keep,
  base,
  nowSec,
  exclusions,
  onExclude,
}: {
  h: AssetBorosHistory;
  /** The chain's record of the position, when it still lists one: a
   * matured leg stays on-chain until settled, and it is the only place the
   * locked rate and side survive (fills carry no rate). */
  leg?: AssetBorosOpen;
  keep: number;
  base: string;
  nowSec: number;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
}) {
  const key = borosKey(h.marketId);
  const matured = h.maturity < nowSec;
  const unit = leg?.collateral ?? '';
  // The chain's record while it lists the position; else the rate replayed
  // from the opening fills (the server's entryApr), which outlives it.
  const entryApr = leg?.entryApr ?? h.entryApr ?? null;
  const side = leg?.side ?? h.side ?? null;
  return (
    <tr className="text-ink-300">
      <td className="whitespace-nowrap">
        <LegIdentity
          kind="boros"
          dim
          name={prettyVenue(h.venue)}
          sub={fmtDateLocal(h.maturity)}
          chips={
            <Chip sm tone="neutral" title={matured ? `Matured ${fmtDateLocal(h.maturity)}` : `Closed early — was due ${fmtDateLocal(h.maturity)}`}>
              {matured ? 'matured' : 'closed'}
            </Chip>
          }
        />
      </td>
      <td className="num text-right" title="Largest position seen at any settlement in the window">
        {(h.peakNotionalUsd ?? 0) > 0 ? (
          <>
            {fmtTokenQty((h.peakSizeToken ?? 0) * keep, unit)}
            <span className="ml-1 text-ink-500">({fmtUsdCompact((h.peakNotionalUsd ?? 0) * keep)})</span>
          </>
        ) : (
          <span className="text-ink-600">—</span>
        )}
      </td>
      {/* The rate it was locked at — the number a matured leg is judged by.
          Known while the chain still lists the position; a market closed
          early and gone from the account has no record left to read. */}
      <td className="num text-right" title={entryApr !== null ? `Locked ${fmtPct(entryApr)} fixed${side ? `, ${side === 'SHORT' ? 'received' : 'paid'} to maturity` : ''} — size-weighted over the opening fills` : 'No opening fill inside this window, so the locked rate cannot be replayed'}>
        {entryApr !== null ? (
          <>
            {fmtPct(entryApr)}
            <div className="text-[10px] text-ink-500">locked{side ? ` · ${side === 'SHORT' ? 'receive' : 'pay'}` : ''}</div>
          </>
        ) : (
          <span className="text-ink-600">—</span>
        )}
      </td>
      <td className="num text-right" title="Funding settlements, net of their settlement fees">
        <SignedNumber value={h.settleUsd * keep} format={fmtUsd} />
        {h.settleFeeUsd * keep > 0 && (
          <div className="text-[10px] text-ink-500">settle fees −{fmtUsd(h.settleFeeUsd * keep)}</div>
        )}
      </td>
      <td className="num text-right" title="Realised rate PnL from closing early or partially, before its trade fee">
        {Math.abs((h.tradePnlUsd + h.tradeFeeUsd) * keep) >= 0.005 ? (
          <SignedNumber value={(h.tradePnlUsd + h.tradeFeeUsd) * keep} format={fmtUsd} />
        ) : (
          <span className="text-ink-600">—</span>
        )}
      </td>
      <td className="whitespace-nowrap text-right">
        {/* Editable even though it is finished: an exclusion set while the
            leg was live must stay reachable once it has matured. */}
        <EditCell
          exKey={key}
          label={`${prettyVenue(h.venue)} YU · ${fmtDateLocal(h.maturity)}`}
          unit={base}
          legQty={h.peakSizeToken ?? 0}
          entry={entryApr ?? 0}
          entryKind="rate"
          current={exclusions[key]}
          onExclude={onExclude}
        />
      </td>
    </tr>
  );
}

/** A closed perp position at this venue, in the live row's columns. */
function ClosedPerpRow({ row, base }: { row: AssetPerpClosedRow & { symbol: string; venue: string }; base: string }) {
  return (
    <tr className="text-ink-300">
      <td className="whitespace-nowrap">
        <LegIdentity
          kind="perp"
          dim
          name={prettyVenue(row.venue)}
          sub={`CrossEx · ${row.closedAt !== null ? fmtDateLocal(row.closedAt) : '—'}`}
          chips={
            <Chip sm tone="neutral" title={row.complete ? 'The whole position was closed' : 'Part of the position was closed; the rest is the live row above'}>
              {row.complete ? 'closed' : 'partial close'}
            </Chip>
          }
        />
      </td>
      <td className="num text-right">{fmtTokenQty(row.qty, base)}</td>
      <td className="num text-right">{fmtUsd(row.openPx)} → {fmtUsd(row.closePx)}</td>
      <td className="num text-right" title={`Funding over the position's life · fees ${fmtUsd(row.feesUsd)}`}>
        {row.dedupedIntoOpen ? (
          <span className="text-ink-600" title="This slice's funding and fees are booked on the surviving open row">in open ↑</span>
        ) : (
          <SignedNumber value={row.fundingUsd} format={fmtUsd} />
        )}
      </td>
      <td className="num text-right" title="Realised price PnL on the close — part of the perp basis">
        <SignedNumber value={row.priceUsd} format={fmtUsd} />
      </td>
      <td />
    </tr>
  );
}

interface Bundle {
  venue: string;
  perps: AssetPerpOpen[];
  boros: AssetBorosOpen[];
  inactiveBoros: AssetBorosHistory[];
  closedPerps: (AssetPerpClosedRow & { symbol: string; venue: string })[];
  gapsHere: HedgeGapRow[];
  hedge: VenueHedge | undefined;
  /** Live: any open perp or active YU. Otherwise the bundle is closed. */
  active: boolean;
  notionalUsd: number;
  /** What the notional is of — the perp's size, else the YU legs' kept
   * size — in the unit its rows print. Zero when there is neither. */
  sizeToken: number;
  sizeUnit: string;
  sizeKind: 'perp' | 'yu';
  /** The venue's floating funding right now, read off its live YU legs —
   * the rate the fixed lock is measured against. Null without YU. */
  floatingApr: number | null;
  /** Signed blended fixed rate on the live YU legs, net of settle fees;
   * + receives, − pays. Null without YU. */
  fixedApr: number | null;
  /** Perp funding + Boros settlements, live and finished — this venue's
   * share of the Fixed funding bar. */
  settleUsd: number;
  /** Everything that is PnL but not funding: Boros realised rate PnL (gross
   * of its fee) + perp realised price PnL on closes + perp uPnL — this
   * venue's share of the Boros-trade and perp-basis bars. */
  tradePnlUsd: number;
  /** Perp fees + Boros trade fees, live and finished. */
  feesUsd: number;
}

/**
 * One FUNDING BUNDLE: an exchange's perp and every YU leg hedging it, at
 * every maturity, as one card — what the venue holds, the fixed rate it is
 * hedged at (blended across maturities), what it has settled and what its
 * trading made or cost. Expands to the legs. A perp with no YU, or YU with
 * no perp, is still a bundle: the missing side is drawn dimmed with the one
 * action that completes it (never a reduction).
 */
function BundleCard({
  b,
  base,
  nowSec,
  defaultOpen,
  histByMarket,
  chainLegs,
  histKeep,
  exclusions,
  onExclude,
  legSince,
  onLegSince,
  livePositions,
  onCloseLeg,
  deficitFor,
  armGap,
  pairPartner,
  multiVenue,
}: {
  b: Bundle;
  base: string;
  nowSec: number;
  defaultOpen: boolean;
  histByMarket: Map<number, AssetBorosHistory>;
  /** Every Boros position the chain still lists, matured ones included —
   * the locked rate of a finished leg lives only there. */
  chainLegs: Map<number, AssetBorosOpen>;
  histKeep: (h: AssetBorosHistory) => number;
  exclusions: Exclusions;
  onExclude: Props['onExclude'];
  legSince?: Record<string, number>;
  onLegSince?: Props['onLegSince'];
  livePositions: Map<string, CrossexPosition>;
  onCloseLeg: (leg: { kind: 'perp'; leg: AssetPerpOpen } | { kind: 'boros'; leg: AssetBorosOpen }) => void;
  deficitFor: (venue: string, leg: 'perp' | 'boros') => HedgeGapRow | undefined;
  armGap: (g: HedgeGapRow) => (() => void) | undefined;
  pairPartner: (g: HedgeGapRow) => HedgeGapRow | undefined;
  /** More than one live bundle on this asset — the perps' price PnL cancels
   * across them, which is what the Trade PnL caption says. */
  multiVenue?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [inactiveOpen, setInactiveOpen] = useState(!b.active);
  const side = b.perps[0]?.side ?? b.boros[0]?.side ?? null;
  const missing = b.gapsHere.filter((g) => g.kind === 'missing');
  const inactiveCount = b.inactiveBoros.length + b.closedPerps.length;
  const maturities = [...new Set(b.boros.map((l) => l.maturity))].sort((x, y) => x - y);
  const statLabel = 'text-[10.5px] leading-none text-ink-500';
  const statValue = 'num mt-1.5 text-[13px] leading-none';
  const statSub = 'num mt-1.5 text-[10.5px] leading-none text-ink-500';
  return (
    <div className={`overflow-x-auto rounded-lg border ${b.active ? 'border-ink-700' : 'border-ink-800'} bg-ink-950/40`}>
      {/* The bundle row is a one-row table on the SAME column widths as the
          leg table below, so each figure sits over the leg column it sums:
          Notional over Size, Fixed APR over Entry → Mark, and so on. */}
      <table className="w-full min-w-[880px] table-fixed border-collapse">
        <BundleColGroup />
        <tbody>
          <tr
            className="cursor-pointer transition-colors hover:bg-ink-850/30 [&>td]:py-3 [&>td]:align-middle"
            onClick={() => setOpen((v) => !v)}
          >
            <td className="pl-4 pr-3">
              <div className="flex min-w-0 items-center gap-3">
                {side && (
                  <Chip
                    sm
                    tone={side === 'LONG' ? 'green' : 'red'}
                    className="w-[64px] shrink-0 justify-center !px-0 !py-[5px] !text-[11px] !font-semibold uppercase tracking-[0.08em]"
                  >
                    {side}
                  </Chip>
                )}
                <button
                  type="button"
                  aria-expanded={open}
                  className="flex min-w-0 flex-col gap-1.5 text-left leading-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                  }}
                >
                  <span className="inline-flex flex-wrap items-center gap-[7px]">
                    <span className={`text-[13.5px] font-semibold leading-none ${b.active ? 'text-ink-50' : 'text-ink-200'}`}>
                      {prettyVenue(b.venue)}
                    </span>
                    {/* Badges only for a PROBLEM: the card's own "hedged ✓" already
                        covers the healthy case, and a tick on every row is noise. */}
                    {missing.map((g) => (
                      <Chip key={g.leg} sm tone="amber" title={`Open ${gapAsk(g, base)} to complete this bundle`}>
                        {g.leg === 'boros' ? 'Boros leg missing' : 'perp leg missing'}
                      </Chip>
                    ))}
                    {b.gapsHere.filter((g) => g.kind === 'deficit').map((g) => (
                      <DeficitChip key={`d-${g.leg}`} gap={g} base={base} />
                    ))}
                    {!b.active && <Chip sm tone="neutral">closed</Chip>}
                  </span>
                  {/* "N active · M inactive" — YU legs by count; a zero side is
                      simply not said. */}
                  {(maturities.length > 0 || inactiveCount > 0) && (
                    <span className="num text-[11.5px] leading-none text-ink-400">
                      {[
                        maturities.length > 0 ? `${maturities.length} active` : null,
                        inactiveCount > 0 ? `${inactiveCount} inactive` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </button>
              </div>
            </td>
            <td className="px-3 text-right" title="Notional of the live perp (or of the YU legs when there is no perp)">
              <div className={statLabel}>Notional</div>
              <div className={`${statValue} text-ink-50`}>
                {b.notionalUsd > 0 ? fmtUsdCompact(b.notionalUsd) : <span className="text-ink-600">—</span>}
              </div>
              <div className={statSub}>
                {b.sizeToken > 0 ? `${fmtTokenQty(b.sizeToken, b.sizeUnit)} ${b.sizeKind === 'perp' ? 'perp' : 'YU'}` : '\u00a0'}
              </div>
            </td>
            <td
              className="px-3 text-right"
              title="The fixed rate this venue is hedged at, blended across its live YU legs and net of settlement fees. Receive = the YU is short (you receive fixed); pay = long."
            >
              <div className={statLabel}>Fixed APR</div>
              <div className={statValue}>
                {b.fixedApr !== null ? (
                  <span className={b.fixedApr >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {b.fixedApr >= 0 ? 'receive ' : 'pay '}
                    {fmtPct(Math.abs(b.fixedApr))}
                  </span>
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </div>
              <div
                className={statSub}
                title={
                  b.floatingApr !== null
                    ? `The venue's floating funding runs at ${fmtPct(b.floatingApr)} right now vs the fixed you locked. A SHORT YU (receive fixed) is winning while fixed > float; a LONG YU (pay fixed, receive float) while float > fixed. Your carry stays locked either way — this shows which side of today's market your lock is on.`
                    : undefined
                }
              >
                {b.floatingApr !== null ? `float now ${fmtPct(b.floatingApr)}` : b.fixedApr === null ? 'no Boros leg' : '\u00a0'}
              </div>
            </td>
            <td
              className="px-3 text-right"
              title="Perp funding + Boros settlements (net of settle fees), live and finished legs — this venue's share of the Fixed funding bar"
            >
              <div className={statLabel}>Funding settlement</div>
              <div className={statValue}>
                <SignedNumber value={b.settleUsd} format={fmtUsd} />
              </div>
              <div className={statSub} title="Trading fees on this venue's legs, live and finished: perp fees + Boros trade fees">
                {b.feesUsd > 0 ? `fees −${fmtUsd(b.feesUsd)}` : 'no fees'}
              </div>
            </td>
            <td
              className="px-3 text-right"
              title="Not funding: Boros realised rate PnL + perp realised price PnL on closes + perp uPnL. Funding settlement − fees + this = the bundle's PnL."
            >
              <div className={statLabel}>Trade PnL</div>
              <div className={statValue}>
                {Math.abs(b.tradePnlUsd) >= 0.005 ? (
                  <SignedNumber value={b.tradePnlUsd} format={fmtUsd} />
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </div>
              <div className={statSub}>{multiVenue && Math.abs(b.tradePnlUsd) >= 0.005 ? 'offsets across venues' : '\u00a0'}</div>
            </td>
            <td className="pl-3 pr-4 text-right">
              <span aria-hidden className={`inline-block text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}>
                <ChevronIcon />
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {open && (
        <div className="border-t border-ink-800">
          {/* The legs: a nested table on the card's own ground, its header
              on a darker band. Finished legs stay inside their bundle,
              behind the footer's toggle. */}
          <table className="w-full min-w-[880px] table-fixed border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-ink-800/70 [&_td]:px-3 [&_td]:py-[9px] [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_tr:last-child_td]:border-b-0">
            <BundleColGroup />
            <thead>
              <tr className="bg-ink-900/60 [&>th]:px-3 [&>th]:py-2 [&>th]:text-[10px] [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-[0.12em] [&>th]:text-ink-500 [&>th:first-child]:pl-4 [&>th:last-child]:pr-4">
                <th className="text-left">Leg</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry → Mark</th>
                <th className="text-right">Funding / Settled</th>
                <th className="text-right">uPnL / Trade PnL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {/* A deficit is a VENUE fact (perp vs the sum of its YU legs), so its
                  chip and "open more" sit on the first leg of that side only —
                  on every YU row it read as several separate shortfalls. */}
              {b.perps.map((l, i) => (
                <PerpRow
                  key={l.symbol}
                  leg={l}
                  base={base}
                  exclusions={exclusions}
                  onClose={livePositions.has(l.symbol) ? () => onCloseLeg({ kind: 'perp', leg: l }) : undefined}
                  deficit={i === 0 ? deficitFor(l.venue, 'perp') : undefined}
                  onOpenMore={(() => { const g = i === 0 ? deficitFor(l.venue, 'perp') : undefined; return g ? armGap(g) : undefined; })()}
                />
              ))}
              {missing.filter((g) => g.leg === 'perp').map((g) => (
                <MissingRow key="missing-perp" gap={g} base={base} onOpen={armGap(g)} asPair={!!pairPartner(g)} />
              ))}
              {b.boros.map((l, i) => (
                <BorosRow
                  key={l.marketId}
                  leg={l}
                  base={base}
                  deficit={i === 0 ? deficitFor(l.venue, 'boros') : undefined}
                  onOpenMore={(() => { const g = i === 0 ? deficitFor(l.venue, 'boros') : undefined; return g ? armGap(g) : undefined; })()}
                  onClose={() => onCloseLeg({ kind: 'boros', leg: l })}
                  windowedGrossUsd={(() => {
                    const h = histByMarket.get(l.marketId);
                    if (!h) return null;
                    const keep = histKeep(h);
                    const settle = h.settleUsd * keep;
                    const trade = (h.tradePnlUsd + h.tradeFeeUsd) * keep;
                    return { gross: settle + trade, settle, trade };
                  })()}
                  windowedFeesUsd={(() => {
                    const h = histByMarket.get(l.marketId);
                    return h ? h.settleFeeUsd * histKeep(h) : null;
                  })()}
                  legSince={legSince?.[borosKey(l.marketId)]}
                  onLegSince={onLegSince ? (sec) => onLegSince(borosKey(l.marketId), sec) : undefined}
                  exclusions={exclusions}
                  onExclude={onExclude}
                />
              ))}
              {missing.filter((g) => g.leg === 'boros').map((g) => (
                <MissingRow key="missing-boros" gap={g} base={base} onOpen={armGap(g)} asPair={!!pairPartner(g)} />
              ))}
              {inactiveCount > 0 && b.active && (
                <tr>
                  <td colSpan={6} className="!py-2 text-right">
                    <button
                      type="button"
                      className="text-[11px] text-ink-400 underline decoration-dotted underline-offset-2 hover:text-ink-200"
                      aria-expanded={inactiveOpen}
                      onClick={() => setInactiveOpen((v) => !v)}
                    >
                      {inactiveOpen ? 'hide' : 'show'} {inactiveCount} inactive leg{inactiveCount === 1 ? '' : 's'} — matured or closed, still in this bundle's settlement
                    </button>
                  </td>
                </tr>
              )}
              {inactiveOpen &&
                b.inactiveBoros.map((h) => (
                  <InactiveBorosRow
                    key={`h-${h.marketId}`}
                    h={h}
                    leg={chainLegs.get(h.marketId)}
                    keep={histKeep(h)}
                    base={base}
                    nowSec={nowSec}
                    exclusions={exclusions}
                    onExclude={onExclude}
                  />
                ))}
              {inactiveOpen &&
                b.closedPerps.map((row) => (
                  <ClosedPerpRow key={`c-${row.symbol}:${row.closedAt}`} row={row} base={base} />
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export function AssetCard({ group, derived, sinceSec, windowPending, onChangeSince, exclusions, onExclude, legSince, onLegSince, liquidation = null }: Props) {
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
      // Only a MISSING leg pairs up with a missing leg elsewhere. A deficit
      // is one venue's shortfall on a leg that already exists, and "open
      // more" there must arm that one leg — pairing it with another venue's
      // missing leg armed a two-leg order the button never named.
      const partner = g.kind === 'missing' ? pairPartner(g) : undefined;
      // A pair has ONE size: the smaller of the two asks. Any remainder
      // shows up as a deficit on the bigger side afterwards.
      const ask = partner && partner.size < g.size ? partner : g;
      const sizeBase = ask.sizeBase > 0 ? ask.sizeBase : undefined;
      const notionalUsd = ask.notionalUsd;
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
  const [pairsOpen, setPairsOpen] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);
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
  // Unfiltered by maturity on purpose: see BundleCard.chainLegs.
  const chainLegs = new Map(group.borosOpen.map((l) => [l.marketId, l]));
  // Mirror the model: a market matured before the window neither shows nor
  // counts (assetModel filters it out of hedge/capital too).
  const nowSecCard = Math.floor(Date.now() / 1000);
  const borosVisible = group.borosOpen.filter(
    // Matured legs are finished: they live in the matured list below, and
    // the perp they covered shows as uncovered (mirrors assetModel).
    (l) => (sinceSec <= 0 || l.maturity >= sinceSec) && l.maturity > nowSecCard,
  );
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
  const venueHedge = new Map(venues.map((v) => [v.venue, v]));
  // Boros legs only — a perp is never excluded (his call 2026-09-09).
  const excludedRows = [
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
  // Every close at the venue, whole or partial: a partial close's realised
  // price PnL is PnL the bundle must show, or its trade PnL reads short.
  const closedPerpRows = group.perpClosed.flatMap((r) =>
    r.rows.map((row) => ({ ...row, symbol: r.symbol, venue: r.venue })),
  );
  // The kept fraction of a market's history under its exclusion — the same
  // scaling the model applies, so the bundles foot to the totals.
  const histKeep = (h: AssetBorosHistory) => borosHistoryKeep(exclusions, group, h);
  /**
   * The bundles: one per exchange, live legs first. Every venue that has
   * anything — an open leg, a finished one, or only a gap — gets one, so
   * nothing the venue booked can fall outside the list. Settlement here is
   * the venue's share of the Fixed funding bar (perp funding, live and
   * closed, plus Boros settlements on every market it ever hedged with).
   */
  const bundles: Bundle[] = (() => {
    const venueSet = new Set<string>([
      ...perpSorted.map((l) => l.venue),
      ...borosSorted.map((l) => l.venue),
      ...closedPerpRows.map((r) => r.venue),
      ...group.borosHistory.map((h) => h.venue),
      ...gaps.map((g) => g.venue),
    ]);
    const out: Bundle[] = [];
    for (const venue of venueSet) {
      const perps = perpSorted.filter((l) => l.venue === venue);
      const boros = borosSorted.filter((l) => l.venue === venue);
      const activeIds = new Set(boros.map((l) => l.marketId));
      const inactiveBoros = group.borosHistory.filter((h) => h.venue === venue && !activeIds.has(h.marketId) && histKeep(h) > 0);
      const closedPerps = closedPerpRows.filter((r) => r.venue === venue);
      const closedAgg = group.perpClosed.filter((r) => r.venue === venue);
      const gapsHere = gaps.filter((g) => g.venue === venue);
      const active = perps.length > 0 || boros.length > 0;
      let w = 0;
      let apr = 0;
      let yuNotional = 0;
      let yuQty = 0;
      for (const l of boros) {
        const slice = keptSlice(exclusions, borosKey(l.marketId), l.sizeToken, l.entryApr);
        const n = l.notionalUsd * slice.keep;
        apr += ((l.side === 'SHORT' ? 1 : -1) * slice.entry - (l.settleFeeApr ?? 0)) * n;
        w += n;
        yuNotional += n;
        yuQty += l.sizeToken * slice.keep;
      }
      const perpNotional = perps.reduce((t, l) => t + l.notionalUsd, 0);
      const perpQty = perps.reduce((t, l) => t + l.qty, 0);
      // Known, not positive: a negative-funding market has a real float too
      // (0 is the feed's "none").
      const floatingApr = boros.find((l) => Number.isFinite(l.floatingApr) && l.floatingApr !== 0)?.floatingApr ?? null;
      const hist = group.borosHistory.filter((h) => h.venue === venue);
      // Per-symbol AGGREGATES for the closed side, exactly as the model sums
      // them — so the bundles foot to the totals to the cent.
      const settleUsd =
        perps.reduce((t, l) => t + l.fundingUsd, 0) +
        closedAgg.reduce((t, r) => t + r.fundingUsd, 0) +
        hist.reduce((t, h) => t + h.settleUsd * histKeep(h), 0);
      const tradePnlUsd =
        hist.reduce((t, h) => t + (h.tradePnlUsd + h.tradeFeeUsd) * histKeep(h), 0) +
        closedAgg.reduce((t, r) => t + r.closedPnlUsd, 0) +
        perps.reduce((t, l) => t + l.upnlUsd, 0);
      const feesUsd =
        perps.reduce((t, l) => t + l.feesUsd, 0) +
        closedAgg.reduce((t, r) => t + r.feesUsd, 0) +
        hist.reduce((t, h) => t + h.tradeFeeUsd * histKeep(h), 0);
      if (!active && inactiveBoros.length === 0 && closedPerps.length === 0 && gapsHere.length === 0) continue;
      out.push({
        venue,
        perps,
        boros,
        inactiveBoros,
        closedPerps,
        gapsHere,
        hedge: venueHedge.get(venue),
        active,
        notionalUsd: perpNotional > 0 ? perpNotional : yuNotional,
        sizeToken: perpNotional > 0 ? perpQty : yuQty,
        sizeUnit: perpNotional > 0 ? group.base : boros[0]?.collateral ?? group.base,
        sizeKind: perpNotional > 0 ? 'perp' : 'yu',
        floatingApr,
        fixedApr: w > 0 ? apr / w : null,
        settleUsd,
        tradePnlUsd,
        feesUsd,
      });
    }
    return out.sort((x, y) => Number(y.active) - Number(x.active) || orderOf(x.venue) - orderOf(y.venue) || x.venue.localeCompare(y.venue));
  })();
  const activeBundles = bundles.filter((b) => b.active);
  const closedBundles = bundles.filter((b) => !b.active);
  // The bundles foot to the totals by construction (checked 2026-09-09:
  // Σ settlement = fixed funding, Σ fees = perp + trade fees, Σ (settlement −
  // fees + trade PnL) = total PnL, to the cent, on every asset).
  const fixedFundingUsd = totals.perpFundingAllUsd + totals.breakdown.borosSettleUsd;
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
      const keep = borosHistoryKeep(exclusions, group, h);
      if (keep > 0) add(h.venue, (h.settleUsd + h.tradePnlUsd + h.tradeFeeUsd) * keep);
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
        {hasLegs && liquidation && <LiquidationChip line={liquidation} base={group.base} />}
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
        <div className="flex items-end gap-6">
        <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-7 gap-y-4">
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
              <SignedNumber value={totals.pnlUsd} format={fmtUsd} plus={false} />
              {derived.roi !== null && (
                <span className="ml-2 text-[12.5px] font-normal text-ink-300">
                  (<SignedNumber value={derived.roi} format={fmtPct} className="!text-ink-400" plus={false} />)
                </span>
              )}
            </button>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400" title="The rate the hedge locks RIGHT NOW, net of Boros settlement fees: on covered venues the floating sides cancel, leaving each Boros leg's fixed side minus the settlement fee it pays to maturity — unavoidable however you enter or roll, so it is part of the rate you actually keep. Deterministic while the hedge holds; steps down as legs mature. Dash = the hedge isn't complete.">
              Current APR (Fixed)
            </div>
            <div className="num mt-2 text-2xl font-semibold leading-none tracking-[-0.02em]">
              {derived.lockedAprFwd !== null ? (
                <SignedNumber value={derived.lockedAprFwd} format={fmtPct} plus={false} />
              ) : (
                '—'
              )}
            </div>
            {/* Gated on the APR, not just the carry: the APR also needs a
                capital floor, and "—" over a live "$0.41/day" read as two
                answers to one question. */}
            {derived.lockedAprFwd !== null && derived.lockedCarryPerYearUsd !== null && (
              <div
                className="num mt-2 text-[11px] leading-none text-ink-400"
                title={`The locked rate in dollars per day at today's notionals — deterministic while the hedge holds; steps down as legs mature.${derived.lockedNotionalUsd !== null ? ` Quoted on the Boros legs' notional it is ${fmtPct(derived.lockedCarryPerYearUsd / derived.lockedNotionalUsd)} on ${fmtUsdCompact(derived.lockedNotionalUsd)} (the cross-farm comparison basis; the headline % is on margin, which leverage inflates).` : ''}`}
              >
                ≈ <SignedNumber value={derived.lockedCarryPerYearUsd / 365} format={fmtUsd} className="!text-ink-400" plus={false} />
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
              className={`num mt-2 text-left text-2xl font-semibold leading-none tracking-[-0.02em] ${signedClass(-totals.costUsd)} hover:opacity-80`}
              title={`Perp fees ${fmtUsd(totals.perpFeesAllUsd)} + Boros fees ${fmtUsd(totals.borosFeesAllUsd)} − price basis ${fmtUsd(totals.priceResidualUsd)}. Click to open.`}
              onClick={() => setCostOpen(true)}
            >
              {fmtUsd(Math.abs(totals.costUsd))}
            </button>
          </div>
        </div>
        {/* The waterfall is the hero drawn as bars, so its toggle lives on
            the hero: a bordered button at the right edge, the bars opening
            underneath. */}
        <button
          type="button"
          className="btn-ghost-xs mb-0.5 inline-flex shrink-0 items-center gap-2 !px-3 !py-1.5 !text-[12.5px] !text-ink-100"
          aria-expanded={wfOpen}
          onClick={() => setWfOpen((v) => !v)}
        >
          <WaterfallIcon />
          {wfOpen ? 'Hide waterfall' : 'PnL waterfall'}
        </button>
        </div>

        {/* pt-3: the plot draws each bar's value label above the bar, so the
            tallest one needs headroom or it lands on the tile row. */}
        {wfOpen && (
          <div className="pb-2 pt-3">
            <AssetBars totals={totals} />
          </div>
        )}
        {!wfOpen && <div className="h-2" />}
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

      {/* FUNDING BUNDLES — one row per exchange: its perp and every YU leg
          hedging it, at every maturity. What the venue holds, the fixed
          rate it is hedged at, what it has settled, what it cost. One card
          per bundle, expanding into its legs in place. Finished legs stay
          inside their bundle; a bundle whose every leg is gone moves to the
          closed section below. */}
      <div className="mb-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-2">
          <span className={microLabelClass}>Funding Bundles</span>
          <span className="num ml-auto text-sm font-semibold" title="Perp funding + Boros settlements, live and finished legs — the Fixed funding bar">
            <SignedNumber value={fixedFundingUsd} format={fmtUsd} />
          </span>
        </div>
        {activeBundles.length > 0 ? (
          <div className="flex flex-col gap-2">
            {activeBundles.map((b) => (
              <BundleCard
                key={b.venue}
                b={b}
                base={group.base}
                nowSec={nowSec}
                defaultOpen={false}
                histByMarket={histByMarket}
                chainLegs={chainLegs}
                histKeep={histKeep}
                exclusions={exclusions}
                onExclude={onExclude}
                legSince={legSince}
                onLegSince={onLegSince}
                livePositions={livePositions}
                onCloseLeg={setCloseLeg}
                deficitFor={deficitFor}
                armGap={armGap}
                pairPartner={pairPartner}
                multiVenue={activeBundles.length > 1}
              />
            ))}
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
                set aside from the farm — not in any bundle, the hedge, PnL or capital
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
      </div>

      {/* CLOSED BUNDLES — exchanges where both sides are gone. A strip
          states the one number that still matters (their settlement is in
          the book's PnL); the bundles themselves open in a modal, in the
          same table as the live ones. */}
      {closedBundles.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setClosedOpen(true)}
            className="mb-3 flex w-full flex-wrap items-center gap-2 rounded border border-ink-700 bg-ink-950/60 px-3.5 py-2.5 text-left text-xs transition-colors hover:border-ink-500"
            title="Every exchange whose perp and YU legs are all closed or matured — click for the legs"
          >
            <span className={microLabelClass}>Closed Funding Bundles</span>
            <span className="text-ink-400">
              {closedBundles.length} exchange{closedBundles.length === 1 ? '' : 's'} with every leg closed or matured
            </span>
            <span className="num ml-auto text-ink-400">
              funding settlement{' '}
              <span className="text-sm font-semibold">
                <SignedNumber value={closedBundles.reduce((t, b) => t + b.settleUsd, 0)} format={fmtUsd} />
              </span>
            </span>
          </button>
          {closedOpen && (
            <Modal
              title={`Closed funding bundles — ${group.base}`}
              onClose={() => setClosedOpen(false)}
              widthClass="w-[960px]"
            >
              <p className="mb-3 text-[11.5px] text-ink-300">
                Exchanges where every leg is closed or matured. Their funding settlement and realised PnL stay in this asset's totals.
              </p>
              <div className="flex flex-col gap-2">
                {closedBundles.map((b) => (
                  <BundleCard
                    key={b.venue}
                    b={b}
                    base={group.base}
                    nowSec={nowSec}
                    defaultOpen={false}
                    histByMarket={histByMarket}
                    chainLegs={chainLegs}
                    histKeep={histKeep}
                    exclusions={exclusions}
                    onExclude={onExclude}
                    legSince={legSince}
                    onLegSince={onLegSince}
                    livePositions={livePositions}
                    onCloseLeg={setCloseLeg}
                    deficitFor={deficitFor}
                    armGap={armGap}
                    pairPartner={pairPartner}
                  />
                ))}
              </div>
            </Modal>
          )}
        </>
      )}

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
          {/* A teaser, not a list: two units and a count. A laddered book
              across several venues runs to ten rows, which would push the
              strip's own affordance off the end — the table behind it is
              where they all live. Pairs are sorted biggest-first, so the
              two shown are the two that matter. */}
          {derived.pairs.slice(0, 2).map((p) => (
            <span key={`${p.longVenue}:${p.shortVenue}:${p.soonestMaturitySec}`} className="num whitespace-nowrap text-ink-200">
              {prettyVenue(p.longVenue)}/{prettyVenue(p.shortVenue)}{' '}
              {p.lockedAprFwd !== null ? (
                <SignedNumber value={p.lockedAprFwd} format={fmtPct} />
              ) : (
                <span className="text-ink-600">—</span>
              )}
              <span className="text-ink-500"> · {fmtDateLocal(p.soonestMaturitySec)}</span>
            </span>
          ))}
          {derived.pairs.length > 2 && (
            <span
              className="whitespace-nowrap text-[11px] text-ink-400"
              title={derived.pairs
                .slice(2)
                .map(
                  (p) =>
                    `${prettyVenue(p.longVenue)}/${prettyVenue(p.shortVenue)} ${p.lockedAprFwd !== null ? fmtPct(p.lockedAprFwd) : '—'} · ${fmtDateLocal(p.soonestMaturitySec)}`,
                )
                .join('\n')}
            >
              + {derived.pairs.length - 2} more pair{derived.pairs.length - 2 === 1 ? '' : 's'}
            </span>
          )}
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
            {/* Second: with one row per maturity, the term is part of WHICH
                unit this is, so it sits beside the venues rather than at the
                far end of the numbers. */}
            <th className="th text-left">Matures</th>
            <th className="th text-right">Size</th>
            <th className="th text-right">Notional</th>
            <th className="th text-right">Capital</th>
            <th className="th text-right">Locked APR</th>
                  <th className="th text-right" />
          </tr>
        </thead>
        <tbody>
          {derived.pairs.map((p) => (
            <Fragment key={`${p.longVenue}:${p.shortVenue}:${p.soonestMaturitySec}`}>
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
              {/* One maturity per row, by construction: a 4-leg unit settles
                  on a single day, and a laddered book is several rows. */}
              <td className="num whitespace-nowrap px-2.5 py-2 text-left text-ink-200">
                {p.soonestMaturitySec > 0 ? (
                  <span title={`${daysLeftText(p.soonestMaturitySec, nowSec)} — every leg of this pair settles here`}>
                    {fmtDateLocal(p.soonestMaturitySec)}
                  </span>
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </td>
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                <span title={exactSize(p.size, p.unit, group.base)}>
                  {sizeLabel(p.size, p.unit, group.base)}
                </span>
              </td>
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                <span title={exactUsd(p.notionalUsd)}>{fmtUsdCompact(p.notionalUsd)}</span>
              </td>
              <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                <span title={exactUsd(p.capitalUsd)}>{fmtUsdCompact(p.capitalUsd)}</span>
              </td>
              <td
                className="num whitespace-nowrap px-2.5 py-2 text-right font-semibold"
                title="The fixed rate this 4-leg unit locks to maturity, net of Boros settlement fees (unavoidable — they accrue however you enter or roll). Trade and perp fees are charged separately in the pair detail."
              >
                {p.lockedAprFwd !== null ? (
                  <SignedNumber value={p.lockedAprFwd} format={fmtPct} />
                ) : (
                  <span className="text-ink-600">—</span>
                )}
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
    {/* YU legs no 4-leg unit could claim: the far end of a ladder mid-roll,
        or a rate leg opened ahead of its hedge. Listed apart rather than
        blended into a unit that settles on a different day. */}
    {derived.pendingLegs.length > 0 && (
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className={microLabelClass}>Pending / rollover legs</span>
          <span className="text-[11px] text-ink-400">
            rate legs with no counterpart at their maturity — not part of a 4-leg pair yet
          </span>
        </div>
        <div className="overflow-x-auto rounded border border-ink-700">
          <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-ink-850 [&_tr:last-child_td]:border-b-0">
            <thead>
              <tr>
                <th className="th text-left">Leg</th>
                <th className="th text-right">Size</th>
                <th className="th text-right">Notional</th>
                <th className="th text-right">Locked</th>
                <th className="th text-right">Matures</th>
              </tr>
            </thead>
            <tbody>
              {derived.pendingLegs.map((l) => (
                <tr key={`${l.marketId}:${l.maturity}`}>
                  <td className="whitespace-nowrap px-2.5 py-2 text-ink-100">
                    <span className="inline-flex items-center gap-[7px]">
                      <span className="font-medium text-ink-50">{prettyVenue(l.venue)}</span>
                      <Chip sm tone={l.side === 'LONG' ? 'green' : 'red'}>
                        {l.side}
                      </Chip>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-link">
                        Boros
                      </span>
                    </span>
                  </td>
                  <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                    <span title={exactSize(sizeIn(l, l.unit), l.unit, group.base)}>{sizeLabel(sizeIn(l, l.unit), l.unit, group.base)}</span>
                  </td>
                  <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-100">
                    <span title={exactUsd(l.notionalUsd)}>{fmtUsdCompact(l.notionalUsd)}</span>
                  </td>
                  <td className="num whitespace-nowrap px-2.5 py-2 text-right font-semibold">
                    <SignedNumber value={l.lockedApr} format={fmtPct} />
                  </td>
                  <td className="num whitespace-nowrap px-2.5 py-2 text-right text-ink-200">
                    <span title={daysLeftText(l.maturity, nowSec)}>{fmtDateLocal(l.maturity)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}
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
                { k: 'boros', label: 'Boros fees', value: -totals.borosFeesAllUsd, title: 'Trade fees paid on the Boros legs, open and matured — what crossing the book cost. Settlement fees are NOT here: they are unavoidable and already netted out of the settlements and the locked rate. Each Boros row shows its own share; they are charged once, here.' },
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
              legs={pairPerpCloseLegs(closePerps)}
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
              legs={pairBorosCloseLegs(closeBoros, group)}
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
              keep: histKeep(h),
              // GROSS of their own fees: an open-only market then shows ≈$0
              // trade PnL (the wire's net figure was really just the entry
              // fee), and all cost lives in the fee column once.
              // Settlement net of its own fee; only the TRADE fee is a
              // separate, avoidable cost worth a column.
              settleUsd: h.settleUsd * histKeep(h),
              tradeUsd: (h.tradePnlUsd + h.tradeFeeUsd) * histKeep(h),
              feesUsd: h.tradeFeeUsd * histKeep(h),
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
                  Settlement is net of its own fee (unavoidable, and already in the locked rate); the fee column is the TRADE fee, which subtracts. Dimmed = excluded.
                </p>
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}