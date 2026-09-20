/**
 * One asset's card: hedge status ("what's missing for a perfect hedge"),
 * lifetime PnL / capital / approximate APR, the live legs with per-leg
 * exclusion controls, and a breakdown of where the PnL came from.
 *
 * All numbers arrive derived (assetModel.ts) — this file only renders.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import type {
  CrossexPosition,
  AssetBorosHistory,
  AssetBorosOpen,
  AssetGroup,
  AssetPerpClosedRow,
  AssetPerpOpen,
  BorosPairBlocker,
  BorosPairContext,
  BorosPairMarketRow,
  BorosPairRequest,
  BorosPairResult,
  BorosPairSimulation,
  BorosSimulatedLeg,
} from '../../api/types';
import { Chip } from '../../components/Chip';
import { microLabelClass } from '../../components/Th';
import { SharePositionModal } from '../SharePositionModal';
import { ClosePairForm } from '../PerpOnlyBox';
import { CloseBorosForm } from '../../trade/CloseBorosForm';
import { ClosePopover } from '../../trade/ClosePopover';
import { useTradeFlowOptional } from '../../trade/TradeFlow';
import { useTrackedAddressOptional } from '../trackedAddress';
import {
  useBorosAgent,
  useBorosCancelAndClose,
  useBorosPairContext,
  useBorosPairSimulation,
  useExecuteBorosPair,
  usePositions,
  useTopUpGas,
} from '../../api/queries';
import { HoldToConfirmButton } from '../../components/HoldToConfirmButton';
import { BlockerList, GasTopUp, LegFillLine, LiquidationRows, PairCosts, PositionArithmetic, SpreadReadout, legSubmitted } from '../../trade/BorosPairBits';
import { EstimateCard, EstimateRow, SlippageLine, StepBadge } from '../../trade/PairTicketBits';
import { QueryError } from '../../components/QueryError';
import { uuid } from '../../lib/uuid';
import { useNow } from '../../lib/useNow';
import { pairSharePayload } from '../sharePayload';
import type { SharePayloadV1 } from '../../lib/shareCodec';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, num, prettyVenue } from '../../lib/fmt';
import { describeLine, lineLabel, type LiquidationLine } from '../../lib/liquidation';
import {
  type AssetDerived,
  type ExclusionEntry,
  type Exclusions,
  type HedgeGapRow,
  type PairEstimate,
  type PairLegDetail,
  type PendingLeg,
  type PerpOnlyPair,
  type UnpairedPerp,
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
  pairCanRoll,
  pairLockedSpread,
  pairPerpCloseLegs,
  perpOnlyCloseLegs,
  perpOnlyPairs,
  sizeIn,
} from './assetModel';
import { knownRate } from '../../lib/boros';
import { useDebounced } from '../../lib/useDebounced';
import { AssetBars } from './AssetBars';
import { useRollPublisher, useRollSignalsOptional } from '../rollSignal';

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

/** The three lines of a summary-row stat cell — the bundle row's, and the
 * pair and ungrouped rows' too, so the two tabs read as one design. */
const statLabel = 'text-[10.5px] leading-none text-ink-500';
const statValue = 'num mt-1.5 text-[13px] leading-none';
const statSub = 'num mt-1.5 text-[10.5px] leading-none text-ink-500';

/** The columns of the pairs list — identity, maturity, the four figures,
 * the chevron. Declared once so the header band, every pair card and the
 * ungrouped card line up as one table. */
function PairColGroup() {
  return (
    <colgroup>
      <col style={{ width: '28%' }} />
      <col style={{ width: '13%' }} />
      <col style={{ width: '11%' }} />
      <col style={{ width: '11%' }} />
      <col style={{ width: '17%' }} />
      <col style={{ width: '14%' }} />
      <col style={{ width: '6%' }} />
    </colgroup>
  );
}

/** The one header band over the pairs list. The rows under it are a single
 * line each — the labels live here, once, so a list of pairs reads as a
 * table rather than a stack of stat cards (his call 2026-09-17). */
function PairListHeader() {
  return (
    <div className="overflow-x-auto px-px">
      <table className="w-full min-w-[880px] table-fixed border-collapse">
        <PairColGroup />
        <thead>
          <tr className="[&>th]:px-3 [&>th]:pb-1.5 [&>th]:text-[10px] [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-[0.12em] [&>th]:text-ink-500 [&>th:first-child]:pl-4 [&>th:last-child]:pr-4">
            <th className="text-left">Pair</th>
            <th className="text-left">Matures</th>
            <th className="text-right">Notional</th>
            <th className="text-right" title="Today's initial margin across all four legs (a Boros leg's margin decays toward maturity)">Capital</th>
            <th className="text-right" title="The locked rate with every charged fee taken out, on the pair's capital over the hedge's life; beside it in grey, the same lock as a SPREAD on notional (receive leg minus pay leg, net of settlement fees) — the cross-farm comparison basis, which leverage does not inflate">
              Est. fixed APR
            </th>
            <th className="text-right" title="Carry over the whole hedge at the locked rate minus the fees charged (see each row's fees popup)">Profit at maturity</th>
            <th />
          </tr>
        </thead>
      </table>
    </div>
  );
}

/** ↻ — the roll-over pill's mark. */
function RollIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  );
}

/** ⤴ — the share pill's mark. */
function ShareIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 10V2.5" />
      <path d="M5 5.5 8 2.5l3 3" />
      <path d="M3 9v4h10V9" />
    </svg>
  );
}

/**
 * The card's two projections of one book, as tabs under the hero: the
 * accounting (funding bundles, which foot to the waterfall) and the
 * estimate (4-leg pairs, split by today's sizes). Both panels stay mounted
 * so an expanded card survives a switch; count chips as on the top-level
 * tabs.
 */
function SectionTabs<T extends string>({
  id,
  value,
  onChange,
  options,
  right,
}: {
  /** Unique per asset card — several share the page. */
  id: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; count: number }>;
  /** What sits at the row's right edge — the active tab's one figure. */
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-1 border-b border-ink-800 px-1">
      <div role="tablist" aria-label="Position views" className="-mb-px flex items-stretch gap-1">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="tab"
              id={`${id}-tab-${o.value}`}
              aria-selected={active}
              aria-controls={`${id}-panel-${o.value}`}
              onClick={() => onChange(o.value)}
              className={`inline-flex items-center gap-2 border-b-2 px-2.5 pb-2 pt-1 text-[13px] font-semibold transition-colors ${
                active ? 'border-info text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-200'
              }`}
            >
              {o.label}
              <Chip sm tone="info" className="!px-1.5 !py-0 !text-[10px]">
                {o.count}
              </Chip>
            </button>
          );
        })}
      </div>
      {right && <div className="ml-auto flex flex-wrap items-baseline gap-2 pb-2">{right}</div>}
    </div>
  );
}

/**
 * One 4-LEG PAIR as a card. The summary row carries what the pairs table
 * used to — venues, maturity, notional, capital, the rate — and expands in
 * place to what the pair popup used to show: the timeline, the four
 * attributed legs, and the fee ladder with its charge switches, plus the
 * share and close actions. All slices are proportional estimates (shares
 * by TODAY'S sizes, not historical pairing) — stated in the footer.
 */
function PairCard({
  pair,
  base,
  nowSec,
  defaultOpen,
  showRollNonce = 0,
  onClosePerps,
  onCloseBoros,
  onRollOver,
  onRollSignal,
  focusOnShow = false,
}: {
  pair: PairEstimate;
  base: string;
  nowSec: number;
  defaultOpen: boolean;
  /** The roll-over banner's click counter: a rollable card opens on each bump. */
  showRollNonce?: number;
  /** This card is the one "Show me" scrolls to — the first that can roll,
   * with `scroll-mt-36` clearing the sticky header and the column band. */
  focusOnShow?: boolean;
  onClosePerps: () => void;
  onCloseBoros: () => void;
  /** Opens the roll-over popup for this pair (offered inside the window). */
  onRollOver: () => void;
  /** The card's roll signal for the asset's banner: the best maturity a
   * fifth of this pair could roll into at a better rate than it earns now,
   * or null. Reported whenever it changes. */
  onRollSignal?: (opportunity: RollOpportunity | null) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const canRoll = pairCanRoll(pair, nowSec);
  // "Show me" on the banner: expand every rollable pair, whatever the user
  // last left it at, and bring the one that matters to the top of the
  // viewport — the banner sits above the hero, the pairs list under it,
  // so a click that only switched tabs left the roll off-screen (his call
  // 2026-09-20). Only on the click (nonce > 0), never on mount.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!(showRollNonce > 0 && canRoll)) return;
    setOpen(true);
    if (focusOnShow && typeof rootRef.current?.scrollIntoView === 'function') {
      rootRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRollNonce]);
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
  /**
   * The share card says "I'm getting N% fixed APR" in public, so every number
   * on it has to be one we know. Below `MIN_APR_CAPITAL_USD` the model
   * withholds the APR on purpose, and a matured pair has no present tense —
   * both once published as a confident 0.00%. StrategyCard had this guard
   * (`canShare`) before the asset view replaced it.
   *
   * A `const`, not `pair.lockedAprFwd` inline: TS narrows an aliased condition
   * only through const bindings.
   */
  const lockedAprFwd = pair.lockedAprFwd;
  const canSharePair =
    netApr !== null && netUsd !== null && lockedAprFwd !== null && soonest > nowSec;

  // ---- the roll signal ----------------------------------------------------
  /**
   * Inside the window, each later maturity both venues list is probed at a
   * FIFTH of the position: the entry legs alone (the round trip's fees are
   * deliberately left out — the question is whether the market offers a
   * better rate, not what today's exit costs), against the rate this row
   * shows NET of the fees its own switches charge. A target that fills that
   * fifth inside its tolerance at a better rate is an opportunity; the best
   * one goes up to the banner (his call 2026-09-20).
   */
  const rollAddress = useTrackedAddressOptional()?.address ?? null;
  const rollCtx = useBorosPairContext(canRoll ? rollAddress : null);
  const rollMarkets = rollCtx.data?.markets;
  const probeTargets = useMemo(
    () => (canRoll && rollMarkets ? rollTargetsFor(rollMarkets, pair, base, soonest) : []),
    [canRoll, rollMarkets, pair, base, soonest],
  );
  const { yuLegs: rollYuLegs, heldSize: rollHeldSize, pairPerpImUsd: rollPerpImUsd } = pairRollGeometry(pair);
  const [probes, setProbes] = useState<Record<number, RollProbeResult>>({});
  const opportunity = useMemo(
    () => bestRollOpportunity(probes, probeTargets, netApr, soonest),
    [probes, probeTargets, netApr, soonest],
  );
  const signalRef = useRef(onRollSignal);
  signalRef.current = onRollSignal;
  const oppKey = opportunity ? `${opportunity.maturity}:${opportunity.rate}:${opportunity.current}:${opportunity.currentMaturity}` : '';
  useEffect(() => {
    signalRef.current?.(opportunity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oppKey]);
  // The spread on notional — the cross-farm comparison basis, and the number
  // the share card prints; the headline % is on margin, which leverage inflates.
  const lockedSpread = pairLockedSpread(pair);

  const cell = 'border-b border-ink-850 px-2.5 py-2';

  /** One switch of the charge row — a setting, not a figure: the amounts
   * live in the ladder below, next to the carry they come out of. */
  const feeSwitch = (label: string, title: string, on: boolean, set: (v: boolean) => void) => (
    <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap" title={title}>
      <input type="checkbox" className="chk" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="text-ink-100">{label}</span>
    </label>
  );
  /** One fee of the ledger, as a tile: the dollars, and under them the
   * same fee as APR drag on capital over the hedge's life. A fee that is
   * switched off stays visible, struck through, so what the switch removed
   * is never out of sight. */
  const feeTile = (key: string, label: string, title: string, usd: number, on: boolean) => {
    const drag = dragOf(usd);
    return (
      <div key={key} title={title}>
        <div className={`${statLabel} ${on ? '' : '!text-ink-600'}`}>{label}</div>
        <div className={`${statValue} ${on ? 'text-ink-100' : 'text-ink-600 line-through'}`}>−{fmtUsd(usd)}</div>
        <div className={`${statSub} ${on ? '' : '!text-ink-600'}`}>
          {!on ? 'not charged' : drag !== null ? `−${fmtPct(drag)} drag` : ' '}
        </div>
      </div>
    );
  };
  const carryTitle =
    earnedSoFarUsd !== null && carryUsd !== null && earnedSoFarUsd > 0
      ? `What the hedge earns over its full life at the locked rate — hedged date to maturity, on the pair's capital. Earned so far ≈ ${fmtUsd(earnedSoFarUsd)} · remaining ≈ ${fmtUsd(carryUsd - earnedSoFarUsd)}.`
      : "What the hedge earns over its full life at the locked rate — hedged date to maturity, on the pair's capital.";
  const [feesOpen, setFeesOpen] = useState(false);
  const pill = 'btn !rounded-full !bg-transparent !px-3.5 !py-1 !text-[12.5px]';

  return (
    <div ref={rootRef} className="scroll-mt-36 overflow-x-auto rounded-lg border border-ink-700 bg-ink-950/40">
      {/* The roll probes render nothing; they only quote. */}
      {probeTargets.map((t) => (
        <RollProbe
          key={t.maturity}
          target={t}
          pair={pair}
          yuLegs={rollYuLegs}
          heldSize={rollHeldSize}
          pairPerpImUsd={rollPerpImUsd}
          address={rollAddress}
          exitSlippageApr={seedSlipPctFor(rollMarkets ?? [], rollYuLegs.map((l) => l.marketId).filter((id): id is number => id !== undefined)) / 100}
          entrySlippageApr={seedSlipPctFor(rollMarkets ?? [], [t.longMarketId, t.shortMarketId]) / 100}
          nowSec={nowSec}
          onResult={(r) =>
            setProbes((prev) => {
              const cur = prev[t.maturity];
              return cur && cur.ok === r.ok && cur.rate === r.rate && cur.size === r.size ? prev : { ...prev, [t.maturity]: r };
            })
          }
        />
      ))}
      {/* ONE line per pair, on the list's shared columns: the labels are in
          the header band above, so nothing here is a caption. */}
      <table className="w-full min-w-[880px] table-fixed border-collapse">
        <PairColGroup />
        <tbody>
          <tr
            className="cursor-pointer transition-colors hover:bg-ink-850/30 [&>td]:py-3 [&>td]:align-middle"
            onClick={() => setOpen((v) => !v)}
          >
            <td className="pl-4 pr-3">
              <button
                type="button"
                aria-expanded={open}
                className="inline-flex min-w-0 flex-wrap items-center gap-[7px] text-left text-[13.5px] font-semibold leading-none text-ink-50"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((v) => !v);
                }}
              >
                <span className="inline-flex items-baseline gap-[5px]">
                  <span className="text-[9.5px] font-semibold tracking-[0.1em] text-grass">L</span>
                  {prettyVenue(pair.longVenue)}
                </span>
                <span className="text-ink-600">/</span>
                <span className="inline-flex items-baseline gap-[5px]">
                  <span className="text-[9.5px] font-semibold tracking-[0.1em] text-guava">S</span>
                  {prettyVenue(pair.shortVenue)}
                </span>
                {canRoll && opportunity !== null && (
                  <Chip
                    sm
                    tone="green"
                    className="!font-medium"
                    title={`${fmtTokenQty(opportunity.size, (rollMarkets ?? []).find((m) => rollYuLegs.some((l) => l.marketId === m.marketId))?.collateral ?? base)} of this pair rolls into ${fmtDateLocal(opportunity.maturity)} at ${fmtPct(opportunity.rate)} on capital after the round trip's fees — the figure the roll-over opens on — against the ${fmtPct(opportunity.current)} this row earns after the fees it charges, with ${daysLeftText(opportunity.currentMaturity, nowSec)}`}
                  >
                    roll opportunity
                  </Chip>
                )}
                {canRoll && opportunity === null && (
                  <Chip
                    sm
                    tone="blue"
                    className="!font-medium"
                    title={`The rate legs settle ${fmtDateLocal(soonest)} — inside the 14-day window, so this pair can be rolled to a later maturity now to stay hedged past it`}
                  >
                    ready to roll
                  </Chip>
                )}
              </button>
            </td>
            {/* One maturity per pair, by construction: a 4-leg unit settles
                on a single day, and a laddered book is several rows. */}
            <td className="num whitespace-nowrap px-3 text-[13px] text-ink-200">
              {soonest > 0 ? (
                <span title="Every leg of this pair settles here">
                  {fmtDateLocal(soonest)} <span className="text-ink-400">· {daysLeftText(soonest, nowSec)}</span>
                </span>
              ) : (
                <span className="text-ink-600">—</span>
              )}
            </td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px] text-ink-50" title={`${exactUsd(pair.notionalUsd)} — ${exactSize(pair.size, pair.unit, base)} paired`}>
              {fmtUsdCompact(pair.notionalUsd)}
            </td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px] text-ink-50" title={`${exactUsd(pair.capitalUsd)} — today's initial margin across all four legs`}>
              {fmtUsdCompact(pair.capitalUsd)}
            </td>
            {/* The APR on capital, then the same lock as a spread on
                notional in grey — one line, two bases (his call 2026-09-17). */}
            <td className="num whitespace-nowrap px-3 text-right text-[13px]">
              {netApr !== null ? (
                <SignedNumber value={netApr} format={fmtPct} />
              ) : (
                <span className="text-ink-600">—</span>
              )}
              {lockedSpread !== null && (
                <span className="ml-2 text-[11.5px] text-ink-400" title="The same lock as a spread on notional: what the receive leg locks minus what the pay leg locks, net of settlement fees">
                  <SignedNumber value={lockedSpread} format={fmtPct} className="!text-ink-400" /> spread
                </span>
              )}
            </td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px]">
              {netUsd !== null ? (
                <SignedNumber value={netUsd} format={fmtUsd} />
              ) : (
                <span className="text-ink-600">—</span>
              )}
              {/* The one affordance on the row besides the disclosure: the
                  fees that set this figure, and the switches that change it,
                  live in a popup so the row and the expansion stay short. */}
              <button
                type="button"
                className="ml-2 text-[11px] text-ink-400 underline decoration-dotted underline-offset-2 hover:text-ink-200"
                title={`Fees charged −${fmtUsd(chargedUsd)} — open the breakdown and the charge switches`}
                onClick={(e) => {
                  e.stopPropagation();
                  setFeesOpen(true);
                }}
              >
                fees ›
              </button>
            </td>
            <td className="whitespace-nowrap pl-3 pr-4 text-right">
              <span aria-hidden className={`inline-block text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}>
                <ChevronIcon />
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {open && (
        <div className="border-t border-ink-800 px-4 pb-4 pt-3">
          <PairTimeline openedSec={pair.hedgedSinceSec} maturitySec={soonest} nowSec={nowSec} />

          {/* No Fees and no Matures column: fees are behind the row's popup,
              and the maturity is the timeline's right edge. */}
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
                      {/* TODAY'S requirement, on every leg — the same figure
                          the Capital cell above sums, so the column foots to
                          it. A Boros leg's margin decays toward maturity;
                          that is the number, not a defect (his call
                          2026-09-09). */}
                      <span title={l.kind === 'yu' ? "Today's requirement — Boros margin decays toward maturity, and this is what the leg ties up now" : 'Initial margin this slice consumes'}>
                        {fmtUsdCompact(l.imUsd)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Share alone on the left — it is an export of what
              the card shows, so it sits apart from the
              trades. The trades on the right as pills; the roll-over is the
              one coloured control, and it appears exactly when the row's
              "ready to roll" chip does. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex flex-wrap items-center gap-2.5 text-[11px] text-ink-400">
              {canSharePair && (
                <button
                  type="button"
                  className="btn-ghost-xs inline-flex items-center gap-1.5 !py-[4px] !text-ink-200"
                  title="Share this pair — a public link + image; your wallet address is not included"
                  onClick={() =>
                    setSharePayload(
                      pairSharePayload(pair, base, {
                        nowSec,
                        inclPerpFees,
                        inclExitFee,
                        netApr,
                        netUsd,
                        lockedAprFwd,
                      }),
                    )
                  }
                >
                  <ShareIcon />
                  Share
                </button>
              )}
            </span>
            <span className="inline-flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${pill} hover:!border-guava/60 hover:!text-guava`}
                disabled={pair.unit !== 'base'}
                title={
                  pair.unit === 'base'
                    ? "Close both perp legs of this pair as one reduce-only action — you confirm in the form. A leg shared with another pair closes only this pair's share."
                    : 'This market sizes in USD; close its perps from the funding bundles instead'
                }
                onClick={onClosePerps}
              >
                Close perps
              </button>
              <button
                type="button"
                className={`${pill} hover:!border-guava/60 hover:!text-guava`}
                title="Close both Boros rate legs of this pair — you confirm in the form. A leg shared with another pair closes only this pair's share."
                onClick={onCloseBoros}
              >
                Close Boros
              </button>
              {canRoll && (
                <button
                  type="button"
                  className={`${pill} roll-nudge !border-grass/60 !text-grass hover:!border-grass hover:!bg-grass/10`}
                  title="Roll this pair's rate legs to a later maturity — the perps stay as they are"
                  onClick={onRollOver}
                >
                  <RollIcon />
                  Roll over
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      {/* The charge switches and the fee ledger, behind the row's "fees ›":
          the switches still drive the row's APR and profit, since the state
          lives in the card, not the popup. */}
      {feesOpen && (
        <Modal
          title={`Fees — ${prettyVenue(pair.longVenue)} / ${prettyVenue(pair.shortVenue)}`}
          onClose={() => setFeesOpen(false)}
          widthClass="w-[640px]"
        >
          <p className="mb-3 text-[11.5px] text-ink-300">
            What this pair's fixed earning is charged with. The switches change the row's Est. fixed APR and profit at maturity.
          </p>
          <div className="flex flex-col rounded border border-ink-700">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-800 bg-ink-100/[0.03] px-3 py-2 text-xs">
              <span className={microLabelClass}>Charge</span>
              {feeSwitch(
                'Perp Entry Fees',
                "Perp trading fees already paid on this pair's slices. Untick to see the rate without the perp side's cost.",
                inclPerpFees,
                setInclPerpFees,
              )}
              {feeSwitch(
                'Est. Perp Exit Fees',
                "Both perp legs closed at maturity at YOUR venues' taker rates (from the account's fee schedule where available). Untick if you mean to roll the perps rather than close them.",
                inclExitFee,
                setInclExitFee,
              )}
            </div>
            {/* The ledger read left to right, the way the sum goes: the
                carry, the three fees that come out of it, the net. */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-3 py-2.5 sm:grid-cols-4">
              <div title={carryTitle}>
                <div className={statLabel}>Fixed Earning</div>
                <div className={`${statValue} text-ink-100`}>
                  {carryUsd !== null ? <SignedNumber value={carryUsd} format={fmtUsd} /> : '—'}
                </div>
                <div className={statSub}>
                  {lockedAprFwd !== null ? (
                    <>
                      <SignedNumber value={lockedAprFwd} format={fmtPct} className="!text-ink-500" /> on capital
                    </>
                  ) : (
                    ' '
                  )}
                </div>
              </div>
              {feeTile(
                'boros',
                'Boros Trade Fees',
                'What crossing the Boros book cost when these legs were opened. Settlement fees are NOT here: they accrue to maturity however you enter or roll, so they are already netted out of the locked rate.',
                pair.borosFeesPaidUsd,
                true,
              )}
              {feeTile(
                'perp',
                'Perp Entry Fees',
                "Perp trading fees already paid on this pair's slices.",
                pair.perpFeesPaidUsd,
                inclPerpFees,
              )}
              {feeTile(
                'exit',
                'Est. Perp Exit Fees',
                "Both perp legs closed at maturity at YOUR venues' taker rates. The Boros legs mature on their own, no close cost.",
                pair.exitFeeUsd,
                inclExitFee,
              )}
              <div
                className="col-span-2 flex items-baseline justify-between gap-3 border-t border-ink-800 pt-3 sm:col-span-4"
                title="Carry over the whole hedge minus the fees charged above — dollars first, the APR is the same figure on capital over the hedge's life"
              >
                <span className={microLabelClass}>Profit at Maturity (est.)</span>
                <span className="num text-base font-semibold">
                  {netUsd !== null ? <SignedNumber value={netUsd} format={fmtUsd} /> : '—'}
                  {netApr !== null && (
                    <span className="ml-2 text-[12.5px] font-normal text-ink-300">
                      (<SignedNumber value={netApr} format={fmtPct} className="!text-ink-400" /> on capital)
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {sharePayload && (
        <SharePositionModal payload={sharePayload} onClose={() => setSharePayload(null)} />
      )}
    </div>
  );
}

/**
 * The roll-over panel: an OPPORTUNITY, not a comparison.
 *
 * An earlier version put "hold to maturity" beside "roll now" as two sides of
 * one choice. That framing flattered the wrong option: holding has no entry
 * cost and a shorter term, so it almost always shows the bigger rate -- but it
 * ENDS on the settlement date and becomes nothing. It is not an alternative the
 * trader can keep choosing, so presenting it as one made rolling look like the
 * worse deal when it is really the only way to keep earning (his call,
 * 2026-09-16).
 *
 * So: no comparison. These legs are close to maturity, here is what you can
 * lock next, pick one. Each option leads with the rate it locks and the days it
 * runs -- both NET of the round trip, so the headline is a number actually
 * received -- and the selected option opens its own fee breakdown underneath.
 */
/** Mirrors SIMULATION_MAX_AGE_MS in the ticket and src/core/boros/pair.ts. */
const ROLL_QUOTE_MAX_AGE_MS = 12_000;
/** The ticket's cap on the tolerance, in % APR. */
const ROLL_MAX_SLIP_PCT = 10;
/** Used when no market on a batch reports a usable deviation cap — the same
 * fallback the close form takes (CloseBorosForm's FALLBACK_SLIPPAGE_PCT). */
const ROLL_FALLBACK_SLIP_PCT = 1;
/** The slider's shortcuts, as shares of the position. */
const ROLL_SHARE_STEPS = [0.25, 0.5, 0.75, 1] as const;
/** One key per pair, for the cards and the roll signals alike. */
const pairKey = (p: Pick<PairEstimate, 'longVenue' | 'shortVenue' | 'soonestMaturitySec'>): string =>
  `${p.longVenue}:${p.shortVenue}:${p.soonestMaturitySec}`;

/** Largest 1-significant-figure value at or below `x` (0.8208 → 0.8) — the
 * ticket's and the close form's own rounding, so the three seed alike. Down
 * rather than to-nearest: a seeded bound must stay inside the venue's cap. */
function floorTo1Sf(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(x));
  // toPrecision trims the binary noise `Math.floor(x / step) * step` leaves.
  return Number((Math.floor(x / step) * step).toPrecision(12));
}

/**
 * The tolerance a batch is seeded with, in % APR: half each market's own
 * max rate deviation, averaged over the batch's markets, floored to one
 * significant figure — the same seed the ticket and the close form take
 * (`seedFor` there). The batch's worst case is twice it, i.e. the two legs'
 * combined deviation cap over two. The server's flat `defaultSlippageApr`
 * was 0.25% whatever the market, which on a normal book is tighter than the
 * fill and tripped "slippage past the bound" on rolls that were perfectly
 * fine (his catch 2026-09-18). Markets without a usable cap fall back to
 * the close form's 1%.
 */
function seedSlipPctFor(markets: ReadonlyArray<BorosPairMarketRow>, ids: number[]): number {
  const caps = ids
    .map((id) => markets.find((m) => m.marketId === id)?.maxRateDeviationApr)
    .filter((c): c is number => typeof c === 'number' && c > 0);
  if (caps.length === 0) return ROLL_FALLBACK_SLIP_PCT;
  const meanHalf = caps.reduce((sum, c) => sum + c / 2, 0) / caps.length;
  const pctVal = floorTo1Sf(meanHalf * 100);
  return pctVal > 0 ? pctVal : ROLL_FALLBACK_SLIP_PCT;
}

/**
 * The later maturities BOTH of this pair's venues list for its asset — what
 * it can roll into, soonest first.
 *
 * Venue names are spelled DIFFERENTLY by the two sources: the asset view
 * gives upper-case keys (GATE), /boros/pair/context gives display names
 * (Gate). A strict compare silently matched nothing and the panel reported
 * "nothing to roll into" while a real target sat in the list behind it.
 */
function rollTargetsFor(
  markets: ReadonlyArray<BorosPairMarketRow>,
  pair: Pick<PairEstimate, 'longVenue' | 'shortVenue'>,
  base: string,
  after: number,
): RollTarget[] {
  const sameVenue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const byMaturity = new Map<number, { long?: number; short?: number }>();
  for (const m of markets) {
    if (m.maturity <= after) continue;
    if (m.base.toLowerCase() !== base.toLowerCase()) continue;
    const slot = byMaturity.get(m.maturity) ?? {};
    if (sameVenue(m.venue, pair.longVenue)) slot.long = m.marketId;
    if (sameVenue(m.venue, pair.shortVenue)) slot.short = m.marketId;
    byMaturity.set(m.maturity, slot);
  }
  return [...byMaturity.entries()]
    .filter(([, v]) => v.long !== undefined && v.short !== undefined)
    .map(([maturity, v]) => ({ maturity, longMarketId: v.long!, shortMarketId: v.short! }))
    .sort((a, b) => a.maturity - b.maturity);
}

/** What a roll moves and what stays: the rate legs, the size held (the
 * smaller leg, as every pair size is) and the perps' margin, which a roll
 * never touches. */
function pairRollGeometry(pair: PairEstimate): { yuLegs: PairLegDetail[]; heldSize: number; pairPerpImUsd: number } {
  const yuLegs = pair.legs.filter((l) => l.kind === 'yu');
  const perpLegs = pair.legs.filter((l) => l.kind === 'perp');
  return {
    yuLegs,
    heldSize: yuLegs.length > 0 ? Math.min(...yuLegs.map((l) => l.sizeToken)) : 0,
    pairPerpImUsd: perpLegs.reduce((t, l) => t + l.imUsd, 0),
  };
}

/** The share of a pair the roll signal prices: "at least a fifth of the
 * position rolls at a better rate" is what makes an opportunity. */
const ROLL_OPPORTUNITY_SHARE = 0.2;

/** One maturity's answer from a probe: whether the roll the modal would
 * open on fills inside tolerance, the NET rate it locks, and that size. */
interface RollProbeResult {
  ok: boolean;
  rate: number | null;
  size: number;
}

/** The best maturity a pair could roll into at a better rate than it earns
 * today — the banner's reason to shout. */
export interface RollOpportunity {
  maturity: number;
  /** The rate the modal opens on for this maturity: NET of the round trip,
   * at the size it defaults to. */
  rate: number;
  /** What the pair earns now, net of the fees its row charges. */
  current: number;
  /** When the pair being held settles — the banner reads the two rates with
   * the days each one runs for, so a bigger number over a shorter term
   * cannot masquerade as the better deal. */
  currentMaturity: number;
  /** The size that rate is quoted at, collateral tokens. */
  size: number;
}

function bestRollOpportunity(
  probes: Record<number, RollProbeResult>,
  targets: RollTarget[],
  current: number | null,
  currentMaturity: number,
): RollOpportunity | null {
  if (current === null) return null;
  let best: RollOpportunity | null = null;
  for (const t of targets) {
    const r = probes[t.maturity];
    if (!r || !r.ok || r.rate === null || !(r.rate > current)) continue;
    if (best === null || r.rate > best.rate) best = { maturity: t.maturity, rate: r.rate, current, currentMaturity, size: r.size };
  }
  return best;
}

/**
 * One maturity, priced for the banner EXACTLY as the modal will price it.
 * Renders nothing; slow poll — it is a signal, the modal re-prices live.
 *
 * Two stages. First a quote at a FIFTH of the position: it says how much the
 * books take inside tolerance (`sizeWithinTolerance`, size-independent), and
 * so what size the modal will DEFAULT to — the smaller of that and the
 * position. A default under a fifth is no opportunity: the market cannot
 * take a meaningful slice. Then a quote AT that default size, both batches,
 * through the same `rollFigures` the option card uses, so the banner's rate
 * is the modal's opening headline to the decimal.
 */
function RollProbe({
  target,
  pair,
  yuLegs,
  heldSize,
  pairPerpImUsd,
  address,
  exitSlippageApr,
  entrySlippageApr,
  nowSec,
  onResult,
}: {
  target: RollTarget;
  pair: PairEstimate;
  yuLegs: PairLegDetail[];
  heldSize: number;
  pairPerpImUsd: number;
  address: string | null;
  exitSlippageApr: number;
  entrySlippageApr: number;
  nowSec: number;
  onResult: (r: RollProbeResult) => void;
}) {
  const longLeg = yuLegs.find((l) => l.venue === pair.longVenue);
  const shortLeg = yuLegs.find((l) => l.venue === pair.shortVenue);
  const reqs = (size: number): { exit: BorosPairRequest | null; entry: BorosPairRequest | null } => {
    if (address === null || !(size > 0) || longLeg?.marketId === undefined || shortLeg?.marketId === undefined) {
      return { exit: null, entry: null };
    }
    return {
      exit: {
        address,
        legA: { marketId: longLeg.marketId, direction: longLeg.side === 'LONG' ? 'short' : 'long', slippageApr: exitSlippageApr },
        legB: { marketId: shortLeg.marketId, direction: shortLeg.side === 'LONG' ? 'short' : 'long', slippageApr: exitSlippageApr },
        size,
        intent: 'close',
      },
      entry: {
        address,
        legA: { marketId: target.longMarketId, direction: longLeg.side === 'LONG' ? 'long' : 'short', slippageApr: entrySlippageApr },
        legB: { marketId: target.shortMarketId, direction: shortLeg.side === 'LONG' ? 'long' : 'short', slippageApr: entrySlippageApr },
        size,
        intent: 'open',
      },
    };
  };
  const opts = { refetchInterval: ROLL_PROBE_POLL_MS };

  // Stage 1: a fifth, for the fit.
  const fifth = heldSize * ROLL_OPPORTUNITY_SHARE;
  const r1 = reqs(fifth);
  const exit1 = useBorosPairSimulation(r1.exit, r1.exit !== null, opts);
  const entry1 = useBorosPairSimulation(r1.entry, r1.entry !== null, opts);
  const legs1 = [exit1.data?.simulation, entry1.data?.simulation].flatMap((x) => (x ? [x.legA, x.legB] : []));
  const fit =
    legs1.length === 4 && legs1.every((l) => typeof l.sizeWithinTolerance === 'number')
      ? Math.min(...legs1.map((l) => l.sizeWithinTolerance as number))
      : legs1.length === 4
        ? heldSize // an older server reports no fit; the modal then opens on the whole position
        : null;
  const size = fit === null ? null : Math.min(fit, heldSize);
  const enough = size !== null && size >= fifth - 1e-9;

  // Stage 2: the modal's default size. When that IS the fifth, stage 1
  // already holds the quote and the same keys are served from cache.
  const r2 = enough ? reqs(size) : { exit: null, entry: null };
  const exit2 = useBorosPairSimulation(r2.exit, r2.exit !== null, opts);
  const entry2 = useBorosPairSimulation(r2.entry, r2.entry !== null, opts);
  const exitSim = exit2.data?.simulation;
  const entrySim = entry2.data?.simulation;
  const legs2 = [exitSim, entrySim].flatMap((x) => (x ? [x.legA, x.legB] : []));
  const ok =
    enough &&
    legs2.length === 4 &&
    entrySim?.receiveLeg !== null &&
    legs2.every((l) => l.bookStatus === 'ok' && !l.slippageExceeded && !(l.shortfallSize > 0));
  const { netRate } = rollFigures({
    entrySim,
    exitSim,
    size: size ?? 0,
    perpImUsd: heldSize > 0 && size !== null ? pairPerpImUsd * (size / heldSize) : 0,
    maturity: target.maturity,
    longLeg,
    shortLeg,
    nowSec,
  });
  const cb = useRef(onResult);
  cb.current = onResult;
  const settled = size !== null && (!enough || legs2.length === 4);
  useEffect(() => {
    if (!settled) return;
    cb.current({ ok, rate: ok ? netRate : null, size: size ?? 0 });
  }, [settled, ok, netRate, size]);
  return null;
}
/** The probe's poll: a signal for a banner, not a quote for an order. */
const ROLL_PROBE_POLL_MS = 60_000;

/** Everything one roll option states, from its two quotes. */
interface RollFigures {
  /** The APR the roll would earn on the capital it ties up, NET of the
   * round trip (both batches' fees and the PnL of closing the old legs). */
  netRate: number | null;
  spreadApr: number | null;
  netByMaturityUsd: number | null;
  grossByMaturityUsd: number | null;
  totalCostUsd: number | null;
  exitCostUsd: number | null;
  entryCostUsd: number | null;
  exitPnlUsd: number | null;
  capitalUsd: number | null;
  newBorosImUsd: number | null;
}

/**
 * The roll's arithmetic, in ONE place: the option card and the banner's
 * probe both read it, so the rate the banner promises is the rate the
 * modal opens on (his catch 2026-09-20: the banner said 29% gross at a
 * fifth, the modal 20% net at the whole — two figures for one roll).
 */
function rollFigures({
  entrySim,
  exitSim,
  size,
  perpImUsd,
  maturity,
  longLeg,
  shortLeg,
  nowSec,
}: {
  entrySim: BorosPairSimulation | undefined;
  exitSim: BorosPairSimulation | undefined;
  /** The size being rolled, in the collateral token. */
  size: number;
  /** The perp margin behind THIS size (the pair's, scaled by the share rolled). */
  perpImUsd: number;
  maturity: number;
  longLeg: PairLegDetail | undefined;
  shortLeg: PairLegDetail | undefined;
  nowSec: number;
}): RollFigures {
  const termYears = Math.max(0, maturity - nowSec) / SECONDS_IN_YEAR;

  /**
   * ⚠ Everything the simulation sizes is in COLLATERAL TOKENS, not dollars.
   * `borosInitialMarginUsd` returns `N × rate × days/365 × kIM` in the units of
   * N, and `simulateLeg` hands it `sizing.resultingSize` -- "collateral units
   * in, collateral units out". So `marginRequiredTotal` is a TOKEN quantity
   * despite the name, exactly as `costToCrossSize` is. Both are converted here
   * through the simulation's own collateral price; when that price is unknown
   * nothing is quoted, rather than publishing a figure in the wrong unit.
   */
  const px = entrySim?.collateralPriceUsd ?? exitSim?.collateralPriceUsd ?? null;
  const usdOf = (tokens: number | null | undefined): number | null =>
    tokens === null || tokens === undefined || px === null || !(px > 0) ? null : tokens * px;

  // The margin this roll ADDS on the new markets, never the whole netted
  // position's — see addedMarginOf.
  const newBorosImUsd = usdOf(addedMarginOf(entrySim));
  const capitalUsd = newBorosImUsd !== null ? perpImUsd + newBorosImUsd : null;

  const exitCostUsd = usdOf(exitSim?.costToCrossSize);
  const entryCostUsd = usdOf(entrySim?.costToCrossSize);
  // Closing the old legs realises their remaining locked spread against
  // today's book — money the roll makes or costs on day one, counted in
  // the earnings and the rate alongside the fees (his call 2026-09-17).
  const exitPnlUsd = usdOf(exitPnlOf(exitSim, longLeg, shortLeg, nowSec).total);
  const totalCostUsd =
    exitCostUsd !== null && entryCostUsd !== null ? exitCostUsd + entryCostUsd : null;
  const dragApr =
    totalCostUsd !== null && capitalUsd !== null && capitalUsd > 0 && termYears > 0
      ? totalCostUsd / capitalUsd / termYears
      : null;

  /**
   * The APR this roll would EARN, on the capital it ties up.
   *
   * `estSpreadApr` is a rate on NOTIONAL, and the notional being rolled is the
   * BOROS leg's -- not `pair.notionalUsd`, which is the two PERP legs and runs
   * several times larger. Scaling by the perp notional inflated the carry by
   * that ratio before dividing by capital, which is how this read 20.49% while
   * the card's own 30 Oct pair read 29.77% for the same maturity.
   *
   * Carry per year = spread x rolled notional; APR on capital = that / capital,
   * then less the round-trip drag so the headline is a figure actually earned.
   */
  const rolledNotionalUsd = usdOf(size) ?? 0;
  const spreadApr = entrySim?.estSpreadApr ?? null;
  const carryPerYearUsd =
    spreadApr !== null && rolledNotionalUsd > 0 ? spreadApr * rolledNotionalUsd : null;
  const rateOnCapital =
    carryPerYearUsd !== null && capitalUsd !== null && capitalUsd > 0
      ? carryPerYearUsd / capitalUsd
      : null;
  const exitPnlApr =
    exitPnlUsd !== null && capitalUsd !== null && capitalUsd > 0 && termYears > 0 ? exitPnlUsd / capitalUsd / termYears : null;
  const netRate =
    rateOnCapital !== null && dragApr !== null && exitPnlApr !== null ? rateOnCapital - dragApr + exitPnlApr : rateOnCapital;
  /**
   * What the roll is worth in dollars by the new maturity: the carry it earns
   * over the term, less the fees paid to get into it. The percentage is the
   * comparable figure; this is the one that reads as money.
   */
  const grossByMaturityUsd = carryPerYearUsd !== null ? carryPerYearUsd * termYears : null;
  const netByMaturityUsd =
    grossByMaturityUsd !== null && totalCostUsd !== null && exitPnlUsd !== null
      ? grossByMaturityUsd - totalCostUsd + exitPnlUsd
      : null;

  return {
    netRate,
    spreadApr,
    netByMaturityUsd,
    grossByMaturityUsd,
    totalCostUsd,
    exitCostUsd,
    entryCostUsd,
    exitPnlUsd,
    capitalUsd,
    newBorosImUsd,
  };
}


/**
 * The margin a trade ADDS, in collateral tokens — not what the resulting
 * position needs in total.
 *
 * ⚠ Boros nets to ONE position per (account, market), so `marginRequired` is
 * quoted on `sizing.resultingSize`: open 0.4 ETH on a market already holding
 * 42 and it answers for 42.4. Charging that whole figure as the trade's
 * capital made a 13% roll read almost the same capital as a 100% one — the
 * carry scaled with the size, the denominator did not, so the rate collapsed
 * (his catch 2026-09-18, the same class as the perp-margin bug on 09-17).
 *
 * IM is linear in notional at a fixed rate, so the increment is the resulting
 * margin scaled by the share of the position this trade opens. A leg that
 * opens nothing adds nothing; a leg opening its whole position adds all of it.
 */
function addedMarginOf(sim: BorosPairSimulation | null | undefined): number | null {
  if (!sim) return null;
  let total = 0;
  for (const leg of [sim.legA, sim.legB]) {
    if (leg.marginRequired === null) return null;
    const result = Math.abs(leg.sizing.resultingSize);
    const delta = Math.abs(leg.sizing.deltaSize);
    if (!(delta > 0)) continue;
    total += result > 0 ? leg.marginRequired * Math.min(1, delta / result) : leg.marginRequired;
  }
  return total;
}
/** What the projected post-exit margin is scaled by before it is compared
 * with what the re-entry needs: room for a bad fill or a moved mark. */
const ROLL_MARGIN_HAIRCUT = 0.95;

/** One leg of the exit as PnL: the rate the position locked against the
 * rate the book would close it at, over what is left of its life. */
interface ExitPnlLeg {
  venue: string;
  side: 'LONG' | 'SHORT';
  lockedApr: number;
  execApr: number | null;
  /** Collateral units, before fees — null without an execution rate. */
  pnl: number | null;
}

/**
 * The PnL of closing the pair's rate legs at the simulated rates, the way
 * CloseBorosForm quotes a close: (locked − exec) × size × years to
 * maturity, signed by the side held (a LONG gains when rates rose, a SHORT
 * when they fell), in COLLATERAL units and BEFORE fees — the fee is in
 * costToCrossSize, charged once. `PairLegDetail.lockedApr` is signed by
 * side (SHORT +, LONG −); the rate itself is its magnitude.
 */
function exitPnlOf(
  sim: BorosPairSimulation | null | undefined,
  legA: PairLegDetail | undefined,
  legB: PairLegDetail | undefined,
  nowSec: number,
  /** `worst` prices each leg at the bound its order carries (mid ± the
   * tolerance) instead of the book's estimate — the floor of what the exit
   * can realise if every leg fills at its limit. */
  at: 'exec' | 'worst' = 'exec',
): { legs: ExitPnlLeg[]; total: number | null } {
  const one = (s: BorosSimulatedLeg | undefined, l: PairLegDetail | undefined): ExitPnlLeg | null => {
    if (!s || !l || l.lockedApr === null) return null;
    const locked = Math.abs(l.lockedApr);
    const years = Math.max(0, l.maturity - nowSec) / SECONDS_IN_YEAR;
    const rate = at === 'worst' ? s.worstApr : s.execApr;
    const pnl = rate !== null ? (l.side === 'LONG' ? rate - locked : locked - rate) * s.estFillSize * years : null;
    return { venue: l.venue, side: l.side, lockedApr: locked, execApr: rate, pnl };
  };
  const legs = [one(sim?.legA, legA), one(sim?.legB, legB)].filter((x): x is ExitPnlLeg => x !== null);
  const total = legs.length > 0 && legs.every((x) => x.pnl !== null) ? legs.reduce((a, x) => a + (x.pnl ?? 0), 0) : null;
  return { legs, total };
}

/** One step's outcome: the venue's result, or the reason nothing was sent. */
type RollStep = { result: BorosPairResult } | { error: string };

/** Four order ids per roll — two batches, each replay-protected on its own. */
const newRollIds = () => ({ xa: `xa-${uuid()}`, xb: `xb-${uuid()}`, ea: `ea-${uuid()}`, eb: `eb-${uuid()}` });

/** What the exit actually closed: the smaller fill of the legs that were
 * sent — the size the entry can honestly re-open. */
const filledOf = (r: BorosPairResult): number => {
  const sent = [r.legA, r.legB].filter(legSubmitted);
  return sent.length === 0 ? 0 : Math.min(...sent.map((l) => l.filledSize));
};
const unknownOutcome = (r: BorosPairResult): boolean =>
  [r.legA, r.legB].some((l) => l.failure?.code === 'unknown');
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface RollTarget {
  maturity: number;
  longMarketId: number;
  shortMarketId: number;
}

/**
 * The roll-over, in two pages.
 *
 * PICK: how much, and which maturity — each option priced live at the default
 * tolerance so the rates compare. REVIEW: the two batches as the venue would
 * fill them, the tolerance to adjust, the margin the re-entry needs against
 * what is available, the acknowledgement the close requires, and the one
 * hold-to-confirm. Two pages because the pick has to read as rates and the
 * review has to read as an order (his call 2026-09-17).
 */
export function RollOverModal({
  pair,
  base,
  nowSec,
  onClose,
}: {
  pair: PairEstimate;
  base: string;
  nowSec: number;
  onClose: () => void;
}) {
  const soonest = pair.soonestMaturitySec;
  const address = useTrackedAddressOptional()?.address ?? null;
  const ctx = useBorosPairContext(address);
  const markets = ctx.data?.markets;
  /** The perps never move in a roll; the whole pair's perp margin, of which
   * a partial roll counts only its share (below). */
  const { yuLegs, heldSize, pairPerpImUsd } = pairRollGeometry(pair);

  const targets = useMemo(
    (): RollTarget[] => rollTargetsFor(markets ?? [], pair, base, soonest),
    [markets, soonest, base, pair],
  );

  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked ?? targets[0]?.maturity ?? null;
  const target = targets.find((t) => t.maturity === selected) ?? null;
  /**
   * Each batch's tolerance, seeded per market as the review page and the
   * ticket seed theirs — so the options are priced at the bound the order
   * will actually carry, not the server's flat default.
   */
  const exitSlippageApr =
    seedSlipPctFor(markets ?? [], yuLegs.map((l) => l.marketId).filter((id): id is number => id !== undefined)) / 100;
  /**
   * How much to roll, in the collateral token the legs are sized in.
   * Anything larger than the position is capped — there is no more to close
   * than is held. The DEFAULT is the largest slice that fills inside each
   * leg's tolerance on both batches (`sizeWithinTolerance`, a property of
   * the books), applied once the selected option has quoted and the trader
   * has not touched the size; the whole position until then, and whenever
   * the books take it all (his call 2026-09-20).
   */
  const collateral =
    (markets ?? []).find((m) => yuLegs.some((l) => l.marketId === m.marketId))?.collateral ?? base;
  const fmtSize = (v: number) => String(+v.toFixed(6));
  const [sizeStr, setSizeStr] = useState(() => fmtSize(heldSize));
  const [touched, setTouched] = useState(false);
  const [fits, setFits] = useState<Record<number, number>>({});
  const [appliedFor, setAppliedFor] = useState<number | null>(null);
  const selectedFit = selected !== null ? fits[selected] : undefined;
  useEffect(() => {
    if (touched || selected === null || selectedFit === undefined || appliedFor === selected) return;
    setSizeStr(fmtSize(Math.min(selectedFit, heldSize)));
    setAppliedFor(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched, selected, selectedFit, appliedFor, heldSize]);
  const setSize = (v: string) => {
    setTouched(true);
    setSizeStr(v);
  };
  const parsedSize = Number(sizeStr);
  const sizeOk = Number.isFinite(parsedSize) && parsedSize > 0;
  const size = sizeOk ? Math.min(parsedSize, heldSize) : 0;
  // The slider re-simulates on every step; the options only see a size that
  // has stood still for a beat, so a drag is one quote, not forty.
  const simSize = useDebounced(size, 250);
  /**
   * The perp margin BEHIND THE SLICE being rolled, not the whole pair's.
   * The option's APR is carry on the rolled size over the capital that
   * size ties up; charging the full perp margin against a half-size roll
   * halved the rate as the slider came down — the carry shrank, the
   * denominator did not (his catch 2026-09-17).
   */
  const perpImUsd = heldSize > 0 ? pairPerpImUsd * (simSize / heldSize) : 0;
  const pct = heldSize > 0 ? Math.round((size / heldSize) * 100) : 0;

  const [step, setStep] = useState<'pick' | 'review'>('pick');
  // The review page locks the modal while a batch is in flight.
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      // Venues only: the maturity being left heads the Exit card, and the
      // pick page states the days remaining on each option (his call
      // 2026-09-18).
      title={`Roll over — ${prettyVenue(pair.longVenue)} / ${prettyVenue(pair.shortVenue)}`}
      onClose={onClose}
      locked={busy}
      // Wide enough for the review's two batches side by side.
      widthClass="w-[780px] max-w-[calc(100vw-32px)]"
    >
      {step === 'review' && target !== null && address !== null && ctx.data ? (
        <RollReview
          pair={pair}
          yuLegs={yuLegs}
          target={target}
          size={size}
          collateral={collateral}
          address={address}
          ctx={ctx.data}
          oldMaturity={soonest}
          nowSec={nowSec}
          perpImUsd={heldSize > 0 ? pairPerpImUsd * (size / heldSize) : 0}
          onBack={() => setStep('pick')}
          onBusy={setBusy}
          onClose={onClose}
        />
      ) : (
        <>
          {/* A slider for the share of the position, a box for the exact
              figure — the same value, two grips. */}
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <span className={microLabelClass}>Size to roll</span>
            <input
              type="range"
              className="min-w-[160px] flex-1 accent-info"
              min={0}
              max={heldSize}
              step={heldSize > 0 ? heldSize / 200 : 1}
              value={size}
              onChange={(e) => setSize(fmtSize(Number(e.target.value)))}
              aria-label="Share of the position to roll"
            />
            <span className="num w-10 text-right text-ink-400">{pct}%</span>
            <input
              className={`input num w-32 !py-1.5 text-xs ${sizeStr !== '' && !sizeOk ? 'border-guava/60' : ''}`}
              inputMode="decimal"
              value={sizeStr}
              onChange={(e) => setSize(e.target.value)}
              aria-label={`Size to roll (${collateral})`}
            />
            <span className="text-ink-400">{collateral}</span>
            {/* Four grips on the same value: a quarter, half, three
                quarters, all. Each is a choice, so it counts as touching. */}
            <span className="inline-flex gap-1" role="group" aria-label="Share shortcuts">
              {ROLL_SHARE_STEPS.map((share) => (
                <button
                  key={share}
                  type="button"
                  className={`btn-ghost-xs num ${pct === Math.round(share * 100) && sizeOk ? '!text-ink-50' : ''}`}
                  onClick={() => setSize(fmtSize(heldSize * share))}
                  title={share === 1 ? 'The whole position' : `${Math.round(share * 100)}% of the position`}
                >
                  {Math.round(share * 100)}%
                </button>
              ))}
            </span>
          </div>

          {targets.length === 0 ? (
            <div className="rounded border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-ink-500">
              {ctx.isLoading
                ? 'Loading the maturities these venues list…'
                : 'No later maturity lists a market at BOTH venues — there is nothing to roll into yet.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {targets.map((t) => (
                <RollOption
                  key={t.maturity}
                  target={t}
                  pair={pair}
                  yuLegs={yuLegs}
                  size={simSize}
                  perpImUsd={perpImUsd}
                  address={address}
                  exitSlippageApr={exitSlippageApr}
                  entrySlippageApr={seedSlipPctFor(markets ?? [], [t.longMarketId, t.shortMarketId]) / 100}
                  nowSec={nowSec}
                  selected={selected === t.maturity}
                  onSelect={() => setPicked(t.maturity)}
                  onFit={(fit) => setFits((prev) => (prev[t.maturity] === fit ? prev : { ...prev, [t.maturity]: fit }))}
                />
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            {/* Not the confirm: this opens the review, where the order is
                checked and held. */}
            <button
              type="button"
              className="btn-primary"
              disabled={target === null || !(size > 0) || address === null || !ctx.data}
              title={target === null ? 'Pick a maturity to roll into' : 'Review the two batches, the tolerance and the margin before confirming'}
              onClick={() => setStep('review')}
            >
              Roll over →
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** One batch of the roll as the venue reported it, or why it was not sent. */
function RollStepReport({ label, step, collateral }: { label: string; step: RollStep; collateral: string }) {
  if ('error' in step) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.04] px-3 py-2.5 text-[11.5px]" role="status">
        <span className="font-semibold text-rose-200">{label} — not sent.</span>{' '}
        <span className="text-rose-200/80">{step.error}</span>
      </div>
    );
  }
  const r = step.result;
  const nothing = r.filledNothing;
  const short = !nothing && r.partial;
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        nothing ? 'border-rose-500/30 bg-rose-500/[0.04]' : short ? 'border-amber-500/30 bg-amber-500/[0.04]' : 'border-emerald-500/25 bg-emerald-500/5'
      }`}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-ink-100">{label}</span>
        <Chip sm tone={nothing ? 'red' : short ? 'amber' : 'green'}>
          {nothing ? 'nothing filled' : short ? 'partially filled' : 'filled'}
        </Chip>
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-ink-300">
        <LegFillLine label="Leg A" fill={r.legA} collateral={collateral} />
        <LegFillLine label="Leg B" fill={r.legB} collateral={collateral} />
      </div>
    </div>
  );
}

/** One batch of the roll, read exactly as the ticket reads a pair: the
 * spread readout, the costs, the position arithmetic, the simulator's own
 * notes — so a roll is two of the same thing the trader already knows. */
/** One batch's tolerance, as the review page holds it: the typed percent,
 * whether it is usable, and whether its editor is open. */
interface BatchSlip {
  str: string;
  onChange: (v: string) => void;
  invalid: boolean;
  open: boolean;
  onToggle: () => void;
  /** The batch's per-leg tolerance as an APR fraction. */
  apr: number;
}

function BatchSection({
  label,
  sub,
  sim,
  dataUpdatedAt,
  estimating,
  pending,
  error,
  onRetry,
  exitPnl,
  slip,
  step,
  heading,
}: {
  label: string;
  /** What the card's header SAYS, when that differs from the batch's name
   * (`label` still names it in the tolerance box and the blockers). */
  heading?: string;
  sub: string;
  step?: number;
  sim: BorosPairSimulation | null;
  dataUpdatedAt: number;
  estimating: boolean;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  /** For the EXIT: the PnL of closing, shown in place of a spread —
   * a close locks nothing, it realises what was locked. */
  exitPnl?: { legs: ExitPnlLeg[]; total: number | null };
  slip: BatchSlip;
}) {
  // The server's own per-leg verdict: the fill sits past the bound, so that
  // leg would be refused before the wire. Said here, on the batch it is
  // about, rather than as one line about "the roll".
  const exceeded = sim ? [sim.legA, sim.legB].filter((l) => l.slippageExceeded) : [];
  const [more, setMore] = useState(false);
  /** A quiet label/value line for the folded detail. */
  const Row = ({ label, value, title }: { label: string; value: string; title?: string }) => (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <span className="pl-3 text-[11.5px] text-ink-400">{label} margin</span>
      <span className="num text-[12px] text-ink-300">{value}</span>
    </div>
  );
  const slipLine = (
    <SlippageLine
      est={sim?.slippageApr !== null && sim?.slippageApr !== undefined ? fmtPct(sim.slippageApr) : null}
      max={fmtPct(slip.apr * 2)}
      unit="APR"
      open={slip.open}
      onToggle={slip.onToggle}
      value={slip.str}
      onChange={slip.onChange}
      invalid={slip.invalid}
      invalidText={`Must be greater than 0 and at most ${ROLL_MAX_SLIP_PCT}%.`}
      inputAriaLabel={`${label} max slippage, % APR`}
      title={`How far this size walks the ${label.toLowerCase()}'s two books away from mid, against the bound that caps it. Set per leg (${slip.str}% each), so the batch's worst case is twice it. The bound caps the RATE, not the fill — a leg that cannot fill inside it simply stops filling.`}
      hint="Max rate each leg of this batch will accept. A wider tolerance may be needed for a large size or a thin book."
    />
  );
  return (
    <EstimateCard label={heading ?? label} sub={sub} step={step} dataUpdatedAt={dataUpdatedAt} estimating={estimating} isError={Boolean(error)}>
      {error ? (
        <QueryError title={`Couldn’t price the ${label.toLowerCase()}`} error={error} onRetry={onRetry} />
      ) : sim ? (
        <>
          {exitPnl ? (
            <ExitPnlReadout sim={sim} exitPnl={exitPnl} between={slipLine} />
          ) : (
            <SpreadReadout sim={sim} between={slipLine} compact />
          )}
          {exceeded.length > 0 && (
            <p
              className="alert-amber text-[11px] leading-relaxed text-amber-100"
              role="alert"
              title="That leg's fill sits past the Max above, so it would be refused before it is sent. Widen the tolerance, or roll a smaller size."
            >
              Slippage too high on {exceeded.map((l) => prettyVenue(l.venue)).join(' and ')} leg
            </p>
          )}
          {/* The batch's headline, its tolerance, the margin it moves and
              its fee are the decision; where each position ends up, where
              each leg liquidates and which bucket carries what are the
              detail, folded until asked for — the two cards were a wall of
              figures (his call 2026-09-20). */}
          <PairCosts sim={sim} freeing={Boolean(exitPnl)} compact />
          <button
            type="button"
            className="self-start text-[11px] text-ink-400 underline decoration-dotted underline-offset-2 hover:text-ink-200"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
          >
            {more ? 'Less' : 'Details'} {more ? '‹' : '›'}
          </button>
          {more && (
            <>
              {!exitPnl && (
                <div className="flex flex-col gap-1 border-t border-ink-800/80 pt-2">
                  <Row
                    label={sim.legA.venue}
                    title="Initial margin this leg's bucket must carry"
                    value={fmtTokenQty(sim.legA.marginRequired ?? 0, sim.collateral)}
                  />
                  <Row
                    label={sim.legB.venue}
                    title="Initial margin this leg's bucket must carry"
                    value={fmtTokenQty(sim.legB.marginRequired ?? 0, sim.collateral)}
                  />
                </div>
              )}
              {!exitPnl && <LiquidationRows sim={sim} />}
              <PositionArithmetic sim={sim} />
              {sim.reasons.length > 0 && (
                <ul className="flex flex-col gap-1 border-t border-ink-800/80 pt-2 text-[10.5px] leading-relaxed text-ink-400">
                  {sim.reasons.map((r) => (
                    <li key={r}>· {r}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <span className="text-[11.5px] text-ink-500">{pending ? 'Pricing…' : 'No quote.'}</span>
          {slipLine}
        </>
      )}
    </EstimateCard>
  );
}

/** The exit's headline: what closing realises, per leg and in total —
 * locked rate → execution rate, priced in dollars where the collateral
 * has a price, else in the token. Before fees; PairCosts has those. */
function ExitPnlReadout({
  sim,
  exitPnl,
  between,
}: {
  sim: BorosPairSimulation;
  exitPnl: { legs: ExitPnlLeg[]; total: number | null };
  /** Rendered under the headline, before the per-leg lines (the slippage line). */
  between?: React.ReactNode;
}) {
  const px = sim.collateralPriceUsd;
  const money = (n: number) =>
    px !== null && px > 0 ? <SignedNumber value={n * px} format={fmtUsd} /> : <SignedNumber value={n} format={(v) => fmtTokenQty(v, sim.collateral)} />;
  const plain = (n: number) =>
    px !== null && px > 0 ? fmtUsd(n * px) : fmtTokenQty(n, sim.collateral);
  /**
   * The per-leg split, as hover text. The total is the figure a roll is
   * judged on; which venue contributed what — and the rate move behind it —
   * is detail, so it rides on the label rather than taking two rows (his
   * call 2026-09-18).
   */
  const breakdown = exitPnl.legs
    .map(
      (l) =>
        `${prettyVenue(l.venue)} ${l.pnl !== null ? plain(l.pnl) : '—'} · locked ${fmtPct(l.lockedApr)} → ${
          l.execApr !== null ? fmtPct(l.execApr) : '—'
        }`,
    )
    .join('\n');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className="cursor-help text-[12.5px] text-ink-50"
          title={`(locked − execution rate) × size × time to maturity on each leg closed, before fees.${
            breakdown ? `\n\n${breakdown}` : ''
          }`}
        >
          Est. total trade PnL <span className="text-ink-400">ⓘ</span>
        </span>
        <span className="num text-lg font-semibold">{exitPnl.total !== null ? money(exitPnl.total) : <span className="text-ink-500">—</span>}</span>
      </div>
      {between}
    </div>
  );
}

/** Entry-side blockers that describe margin the EXIT has not freed yet. */
const MARGIN_CODES = new Set(['cross-short-margin', 'isolated-short-margin']);

/**
 * The review page: both batches priced at the chosen tolerance, the margin
 * check, the acknowledgement, the blockers, and the roll itself.
 *
 * The roll is EXIT first, then ENTRY sized to what the exit filled. Exit
 * first because the entry's margin check depends on the old legs' margin
 * being freed (open-first would trip cross-short-margin on a full book).
 * The cost is the window between the two batches: an entry that fails after
 * a good exit leaves the perps' rate side short, which the report says
 * outright and offers to retry — the exit is never re-sent. Each batch is
 * accepted atomically by Boros (both legs or neither) but can still fill
 * short; a leg with no confirmation stops everything, as the venue's own
 * wording asks (his calls 2026-09-17).
 */
function RollReview({
  pair,
  yuLegs,
  target,
  size,
  collateral,
  address,
  ctx,
  oldMaturity,
  nowSec,
  perpImUsd,
  onBack,
  onBusy,
  onClose,
}: {
  pair: PairEstimate;
  yuLegs: PairLegDetail[];
  target: RollTarget;
  size: number;
  collateral: string;
  address: string;
  ctx: BorosPairContext;
  oldMaturity: number;
  nowSec: number;
  /** The perp margin behind THIS size — the capital base of the headline. */
  perpImUsd: number;
  onBack: () => void;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const agent = useBorosAgent();
  const execute = useExecuteBorosPair();
  const cancelClose = useBorosCancelAndClose();
  const topUpGas = useTopUpGas();
  const [gasTopUpStr, setGasTopUpStr] = useState('5');
  const longLeg = yuLegs.find((l) => l.venue === pair.longVenue);
  const shortLeg = yuLegs.find((l) => l.venue === pair.shortVenue);

  // ---- tolerance --------------------------------------------------------
  /**
   * One tolerance PER BATCH, in % APR as the ticket takes it: the old legs'
   * books and the new legs' books are different books, and a thin one on
   * either side should not force the other wider. Invalid (empty, zero, over
   * the cap) blocks the confirm rather than falling back to a bound the
   * trader did not choose.
   *
   * ⚠ Seeded THE SAME WAY as the ticket and the close form (`seedFor` there):
   * half each market's own max rate deviation, floored to one significant
   * figure. The server's flat `defaultSlippageApr` was 0.25% whatever the
   * market, which on a normal book is tighter than the fill and tripped
   * "slippage past the bound" on rolls that were perfectly fine — the other
   * forms never had that problem because they seed per market (his catch
   * 2026-09-18).
   */
  const seedFor = (ids: number[]): number => seedSlipPctFor(ctx.markets, ids);
  const useSlip = (seedPct: number): BatchSlip => {
    const [edited, onChange] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const str = edited ?? String(seedPct);
    const n = Number(str);
    const invalid = str.trim() === '' || !Number.isFinite(n) || n <= 0 || n > ROLL_MAX_SLIP_PCT;
    return { str, onChange, invalid, open, onToggle: () => setOpen((v) => !v), apr: invalid ? seedPct / 100 : n / 100 };
  };
  // Each batch from ITS OWN two markets: the exit closes the old maturity,
  // the re-entry opens the new one.
  const exitSlip = useSlip(seedFor([longLeg?.marketId, shortLeg?.marketId].filter((id): id is number => id !== undefined)));
  const entrySlip = useSlip(seedFor([target.longMarketId, target.shortMarketId]));
  const slipInvalid = exitSlip.invalid || entrySlip.invalid;

  // ---- the two requests -------------------------------------------------
  /** Closing reverses each leg: a LONG position is closed by selling. The
   * close is acknowledged up front: a roll is, by its name, closing these
   * legs — asking the trader to tick that they know so was a box with one
   * possible answer. */
  const exitReq: BorosPairRequest | null =
    size > 0 && longLeg?.marketId !== undefined && shortLeg?.marketId !== undefined
      ? {
          address,
          legA: { marketId: longLeg.marketId, direction: longLeg.side === 'LONG' ? 'short' : 'long', slippageApr: exitSlip.apr },
          legB: { marketId: shortLeg.marketId, direction: shortLeg.side === 'LONG' ? 'short' : 'long', slippageApr: exitSlip.apr },
          size,
          intent: 'close',
          opposingAcknowledged: true,
        }
      : null;
  /** Re-opening takes the same sides the pair holds today, at the new maturity. */
  const entryReq: BorosPairRequest | null =
    size > 0 && longLeg !== undefined && shortLeg !== undefined
      ? {
          address,
          legA: { marketId: target.longMarketId, direction: longLeg.side === 'LONG' ? 'long' : 'short', slippageApr: entrySlip.apr },
          legB: { marketId: target.shortMarketId, direction: shortLeg.side === 'LONG' ? 'long' : 'short', slippageApr: entrySlip.apr },
          size,
          intent: 'open',
        }
      : null;
  const exit = useBorosPairSimulation(exitReq, exitReq !== null);
  const entry = useBorosPairSimulation(entryReq, entryReq !== null);
  const exitSim = exit.data?.simulation ?? null;
  const entrySim = entry.data?.simulation ?? null;
  const pending = exit.isPending || entry.isPending;

  // ---- margin -----------------------------------------------------------
  /**
   * What the re-entry needs against what the account can spend NOW. The
   * exit frees the old legs' margin first, so a shortfall here is a warning
   * — the venue re-checks at the moment the entry is sent, and a refusal
   * then lands in the "retry the re-entry" path with the same figures. The
   * entry sim's own margin blockers are read the same way: they were judged
   * before the exit ran.
   */
  const byId = new Map(ctx.markets.map((m) => [m.marketId, m]));
  const availableFor = (marketId: number): number | null => {
    const row = byId.get(marketId);
    if (!row) return null;
    if (row.onIsolatedMargin) return ctx.isolatedByMarket.find((i) => i.marketId === marketId)?.available ?? null;
    return ctx.crossByToken.find((c) => c.tokenId === row.tokenId)?.available ?? null;
  };
  const availA = availableFor(target.longMarketId);
  const availB = availableFor(target.shortMarketId);
  const available = availA === null ? availB : availB === null ? availA : Math.min(availA, availB);
  // What the re-entry ADDS on those markets — the netted total counts margin
  // the account already posts there (see addedMarginOf).
  const marginNeed = addedMarginOf(entrySim);
  /**
   * What will be spendable once the exit has run, in collateral tokens —
   * the figure the re-entry is actually checked against:
   *   available now
   *   + the old legs' margin the exit frees (this slice's share)
   *   + what the exit realises, priced at the WORST rate its bound allows
   *   − the exit's own trade fee
   * then a 5% haircut, so a bad fill or a moved mark does not turn "enough"
   * into a refused re-entry. The old legs' margin is known in dollars (the
   * asset view's figure) and comes back to tokens at the quote's price.
   */
  const px = exitSim?.collateralPriceUsd ?? entrySim?.collateralPriceUsd ?? null;
  const freedByExit =
    px !== null && px > 0
      ? [longLeg, shortLeg].reduce(
          (t, l) => t + (l && l.sizeToken > 0 ? (l.imUsd / px) * Math.min(1, size / l.sizeToken) : 0),
          0,
        )
      : null;
  const worstExitPnl = exitPnlOf(exitSim, longLeg, shortLeg, nowSec, 'worst').total;
  const exitFee = exitSim?.costToCrossSize ?? null;
  const availableAfter =
    available !== null && freedByExit !== null && worstExitPnl !== null && exitFee !== null
      ? Math.max(0, (available + freedByExit + worstExitPnl - exitFee) * ROLL_MARGIN_HAIRCUT)
      : null;
  const marginShort =
    marginNeed !== null && availableAfter !== null && marginNeed > availableAfter ? marginNeed - availableAfter : 0;
  const usdNote = (tokens: number) =>
    px !== null && px > 0 ? <span className="text-[11px] text-ink-400"> ≈ {fmtUsd(tokens * px)}</span> : null;

  // ---- blockers ---------------------------------------------------------
  const now = useNow(1_000);
  const ageOf = (at: number) => (at > 0 ? Math.max(0, now - at) : Number.POSITIVE_INFINITY);
  const stale = ageOf(exit.dataUpdatedAt) > ROLL_QUOTE_MAX_AGE_MS || ageOf(entry.dataUpdatedAt) > ROLL_QUOTE_MAX_AGE_MS;
  const entryGate = entry.data?.gate.blockers ?? [];
  const blockers: BorosPairBlocker[] = [
    ...(exit.data?.gate.blockers ?? []).map((b) => ({ ...b, message: `Exit: ${b.message}` })),
    ...entryGate.filter((b) => !MARGIN_CODES.has(b.code)).map((b) => ({ ...b, message: `Re-entry: ${b.message}` })),
    ...(slipInvalid
      ? [{ code: 'slippage-out-of-range', message: `Max slippage must be greater than 0 and at most ${ROLL_MAX_SLIP_PCT}% APR — the order would otherwise carry a rate bound you did not choose.` }]
      : []),
    ...(exit.isError || entry.isError ? [{ code: 'quote-failed', message: 'Could not price this roll.' }] : []),
    ...(!exit.data || !entry.data
      ? [{ code: 'no-quote', message: 'Waiting for a quote.' }]
      : stale
        ? [{ code: 'stale-simulation', message: 'The quote is out of date — waiting for a fresh one.' }]
        : []),
    ...(agent.data?.expired
      ? [{ code: 'agent-expired', message: 'The Boros agent approval has expired — approve a new agent key before trading.' }]
      : []),
  ];

  // ---- execution --------------------------------------------------------
  const [exitOut, setExitOut] = useState<RollStep | null>(null);
  const [entryOut, setEntryOut] = useState<RollStep | null>(null);
  /** The size the entry re-opens: what the exit filled, not what was asked. */
  const [entrySize, setEntrySize] = useState<number | null>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusy(b);
  };
  const ids = useRef(newRollIds());
  const canConfirm = exitReq !== null && entryReq !== null && blockers.length === 0 && !busy && exitOut === null;

  const runEntry = async (req: BorosPairRequest, sizeToOpen: number) => {
    setEntryOut(null);
    try {
      const res = await execute.mutateAsync({ ...req, size: sizeToOpen, clientOrderIdA: ids.current.ea, clientOrderIdB: ids.current.eb });
      setEntryOut({ result: res.result });
    } catch (e) {
      setEntryOut({ error: errorText(e) });
    }
  };
  const run = async () => {
    if (!exitReq || !entryReq) return;
    ids.current = newRollIds();
    setBusy(true);
    setExitOut(null);
    setEntryOut(null);
    setEntrySize(null);
    try {
      let exitRes: BorosPairResult;
      try {
        const res = await execute.mutateAsync({ ...exitReq, clientOrderIdA: ids.current.xa, clientOrderIdB: ids.current.xb });
        exitRes = res.result;
        setExitOut({ result: exitRes });
      } catch (e) {
        setExitOut({ error: errorText(e) });
        return;
      }
      const filled = filledOf(exitRes);
      if (unknownOutcome(exitRes) || !(filled > 0)) return;
      setEntrySize(filled);
      await runEntry(entryReq, filled);
    } finally {
      setBusy(false);
    }
  };
  const retryEntry = async () => {
    if (!entryReq || entrySize === null) return;
    // Fresh ids: the failed attempt's memo (if any) must not swallow the retry.
    ids.current = { ...ids.current, ea: `ea-${uuid()}`, eb: `eb-${uuid()}` };
    setBusy(true);
    try {
      await runEntry(entryReq, entrySize);
    } finally {
      setBusy(false);
    }
  };
  const exitFilled = exitOut !== null && 'result' in exitOut ? filledOf(exitOut.result) : 0;
  const exitUnknown = exitOut !== null && 'result' in exitOut && unknownOutcome(exitOut.result);
  const entryOk = entryOut !== null && 'result' in entryOut && !entryOut.result.filledNothing && !unknownOutcome(entryOut.result);
  const entryUnknown = entryOut !== null && 'result' in entryOut && unknownOutcome(entryOut.result);
  // The rate side is short exactly when the exit closed something and the
  // entry did not re-open it (failed, refused, or filled nothing).
  const rateSideShort = exitFilled > 0 && !exitUnknown && !entryOk && !entryUnknown && !busy;
  const canRetryEntry = rateSideShort && entryReq !== null && entrySize !== null;
  const canRetryExit = exitOut !== null && !busy && exitFilled === 0 && !exitUnknown;

  if (exitOut !== null) {
    /* The roll has been sent: what the venue did with each batch is the
       whole screen. */
    return (
      <div className="flex flex-col gap-2">
        <RollStepReport label="Exit" step={exitOut} collateral={collateral} />
        {entryOut !== null && <RollStepReport label="Re-entry" step={entryOut} collateral={collateral} />}
        {busy && entryOut === null && exitFilled > 0 && (
          <p className="text-[11.5px] text-ink-300" role="status">Opening the new legs…</p>
        )}
        {rateSideShort && (
          <p className="rounded border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-200" role="alert">
            The old legs are closed and the new ones are not open — the perps’ rate side is short by{' '}
            {fmtTokenQty(entrySize ?? exitFilled, collateral)} until you retry the re-entry.
            {marginShort > 0 && ` If the venue refused it for margin, add about ${fmtTokenQty(marginShort, collateral)} of cross margin first.`}
          </p>
        )}
        {(exitUnknown || entryUnknown) && (
          <p className="rounded border border-rose-500/30 bg-rose-500/[0.04] px-2.5 py-2 text-[11.5px] leading-relaxed text-rose-200" role="alert">
            A leg came back without confirmation — it may or may not have filled. Check Boros before re-issuing anything.
          </p>
        )}
        {entryOk && exitFilled > 0 && (
          <p className="text-[11.5px] text-ink-300" role="status">
            Rolled {fmtTokenQty(entrySize ?? exitFilled, collateral)} to {fmtDateLocal(target.maturity)}.
            {exitFilled < size - 1e-9 && ` ${fmtTokenQty(size - exitFilled, collateral)} of the old legs stayed open at ${fmtDateLocal(oldMaturity)}.`}
          </p>
        )}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          {canRetryExit && (
            <HoldToConfirmButton tone="cyan" onConfirm={run} title="Press and hold: sends the exit batch again with fresh order ids">
              Retry exit
            </HoldToConfirmButton>
          )}
          {canRetryEntry && (
            <HoldToConfirmButton tone="cyan" onConfirm={retryEntry} title="Press and hold: opens the new legs again, at the size the exit closed, with fresh order ids — the exit is not re-sent">
              Retry re-entry
            </HoldToConfirmButton>
          )}
        </div>
      </div>
    );
  }

  /**
   * The strip at the top answers the only question first: what does this
   * roll lock, for how long, and what does it cost today — the SAME figures
   * the option card showed, re-priced at these tolerances. The two batches
   * under it are how it executes; the margin line is whether it can. Three
   * ranks, so the page reads top-down instead of as one wall of
   * simulation output (his call 2026-09-20).
   */
  const fig = rollFigures({ entrySim: entrySim ?? undefined, exitSim: exitSim ?? undefined, size, perpImUsd, maturity: target.maturity, longLeg, shortLeg, nowSec });
  const termDays = Math.max(0, Math.ceil((target.maturity - nowSec) / 86_400));
  const dayOneUsd = fig.totalCostUsd !== null && fig.exitPnlUsd !== null ? fig.exitPnlUsd - fig.totalCostUsd : null;
  const marginOk = marginNeed !== null && availableAfter !== null && marginShort === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-ink-700 bg-ink-850/40 px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className={microLabelClass}>You lock</div>
            <div className="num mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]">
              {fig.netRate !== null ? <SignedNumber value={fig.netRate} format={fmtPct} /> : <span className="text-ink-600">{pending ? '…' : '—'}</span>}
              <span className="ml-2 text-[13px] font-normal text-ink-300">{termDays}d</span>
            </div>
            <div className="mt-1.5 text-[11.5px] text-ink-400">net of fees and exit P&L</div>
          </div>
          <div className="grid grid-cols-3 gap-x-5">
            <div title="The size being rolled — the smaller of the two rate legs' fills, closed at the old maturity and re-opened at the new">
              <div className={statLabel}>Size</div>
              <div className={`${statValue} font-semibold text-ink-50`}>{fmtTokenQty(size, collateral)}</div>
            </div>
            <div title="Carry to the new maturity at the locked spread, less the round trip">
              <div className={statLabel}>Est. earnings by maturity</div>
              <div className={`${statValue} font-semibold`}>
                {fig.netByMaturityUsd !== null ? <SignedNumber value={fig.netByMaturityUsd} format={fmtUsd} /> : <span className="text-ink-600">—</span>}
              </div>
            </div>
            <div
              title={`Exit fee ${fig.exitCostUsd !== null ? `−${fmtUsd(fig.exitCostUsd)}` : '—'} · Re-entry fee ${fig.entryCostUsd !== null ? `−${fmtUsd(fig.entryCostUsd)}` : '—'} · Exit PnL ${fig.exitPnlUsd !== null ? `${fig.exitPnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(fig.exitPnlUsd))}` : '—'}`}
            >
              <div className={statLabel}>Cost today</div>
              <div className={statValue}>
                {dayOneUsd !== null ? <SignedNumber value={dayOneUsd} format={fmtUsd} /> : <span className="text-ink-600">—</span>}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The two batches side by side: how the roll executes — what closing
          realises against what re-opening locks, each with its own
          tolerance and the margin it moves. */}
      <div className={microLabelClass}>How it executes</div>
      {/* 1 then 2: the order the two batches are sent in, a numbered disc
          on each card. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">
        <BatchSection
          label="Exit"
          step={1}
          sub={fmtDateLocal(oldMaturity)}
          sim={exitSim}
          dataUpdatedAt={exit.dataUpdatedAt}
          estimating={exit.isPlaceholderData}
          pending={pending}
          error={exit.isError ? exit.error : null}
          onRetry={() => exit.refetch()}
          exitPnl={exitPnlOf(exitSim, longLeg, shortLeg, nowSec)}
          slip={exitSlip}
        />
        <BatchSection
          label="Re-entry"
          // Reads as one phrase with the maturity beside it: "Renew to 2026-10-30".
          heading="Renew to"
          step={2}
          sub={fmtDateLocal(target.maturity)}
          sim={entrySim}
          dataUpdatedAt={entry.dataUpdatedAt}
          estimating={entry.isPlaceholderData}
          pending={pending}
          error={entry.isError ? entry.error : null}
          onRetry={() => entry.refetch()}
          slip={entrySlip}
        />
      </div>

      {/* Margin: two numbers — what the new legs need, and what will be
          there to pay for it once the exit has run. Green when it clears. */}
      <div
        className={`flex flex-col gap-1.5 rounded-lg border px-3.5 py-3 ${
          marginShort > 0 ? 'border-amber-500/40 bg-amber-500/[0.05]' : marginOk ? 'border-emerald-500/25 bg-emerald-500/[0.03]' : 'border-ink-700 bg-ink-850/40'
        }`}
        role={marginShort > 0 ? 'alert' : undefined}
      >
        <span className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-400">
          <StepBadge n={3} />
          Can it fund? {marginOk ? '✓' : ''}
        </span>
        <EstimateRow
          label="Required margin"
          sub="for the new legs"
          title="Initial margin the two new legs post at the rates they lock, summed — each bucket must carry its own."
          value={
            marginNeed !== null ? (
              <>
                {fmtTokenQty(marginNeed, collateral)}
                {usdNote(marginNeed)}
              </>
            ) : (
              '—'
            )
          }
          strong
        />
        <EstimateRow
          label="Available margin after exit"
          sub="worst-case exit, 5% buffer"
          title="What is spendable now, plus the margin the exit frees from the old legs, plus what the exit realises if every leg fills at the worst rate its tolerance allows, less the exit's fee — then 5% off for safety."
          value={
            availableAfter !== null ? (
              <>
                {fmtTokenQty(availableAfter, collateral)}
                {usdNote(availableAfter)}
              </>
            ) : (
              '—'
            )
          }
          strong
        />
        {marginShort > 0 && (
          <p className="text-[11.5px] leading-relaxed text-amber-100">
            About {fmtTokenQty(marginShort, collateral)} short. Top up before rolling, or roll a smaller size.
          </p>
        )}
      </div>
      <BlockerList
        // A fill past the tolerance still blocks (it is in `blockers`), but
        // its batch already says so, in amber, next to the Max that fixes
        // it — a second, red copy here explained nothing new.
        blockers={blockers.filter((b) => b.code !== 'slippage-exceeds-max')}
        busyMarketId={cancelClose.isPending ? (cancelClose.variables?.marketId ?? null) : null}
        onCancelAndClose={(marketId) => cancelClose.mutate({ marketId })}
      />
      <GasTopUp
        gasBalanceUsd={entry.data?.gasBalanceUsd ?? exit.data?.gasBalanceUsd}
        amount={gasTopUpStr}
        onAmountChange={setGasTopUpStr}
        onTopUp={() => topUpGas.mutate(Number(gasTopUpStr))}
        busy={topUpGas.isPending}
      />
      {topUpGas.isSuccess && (
        <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-emerald-200">
          Sent a ${topUpGas.data.sentUsd} gas top-up. Boros credits it once the transaction is indexed, so the balance catches up within a minute — no need to send it again.
        </p>
      )}
      {topUpGas.isError && <QueryError title="The gas top-up did not confirm" error={topUpGas.error} />}

      <div className="mt-1 flex items-center justify-between gap-2">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          ← Back
        </button>
        <HoldToConfirmButton
          tone="cyan"
          disabled={!canConfirm}
          onConfirm={run}
          title="Press and hold: closes the two rate legs at market, then opens them at the new maturity"
        >
          {busy ? 'Rolling…' : 'Roll over'}
        </HoldToConfirmButton>
      </div>
    </div>
  );
}

/**
 * One maturity you could roll into, priced live.
 *
 * TWO simulations, because a roll at market is two market orders: `close` on
 * the legs held now and `open` on the new ones. Both cross a book, so both pay
 * taker fees and slippage -- quoting only the entry would understate the roll.
 * The headline is net of BOTH, so "continue earning 18.95%" is a rate actually
 * received; the breakdown behind it opens only on the selected option.
 */
function RollOption({
  target,
  pair,
  yuLegs,
  size,
  perpImUsd,
  address,
  exitSlippageApr,
  entrySlippageApr,
  nowSec,
  selected,
  onSelect,
  onFit,
}: {
  target: { maturity: number; longMarketId: number; shortMarketId: number };
  pair: PairEstimate;
  yuLegs: PairLegDetail[];
  /** The size being rolled, in the collateral token — the modal's input. */
  size: number;
  perpImUsd: number;
  address: string | null;
  /** Per-leg tolerance of each batch, as an APR fraction. */
  exitSlippageApr: number;
  entrySlippageApr: number;
  nowSec: number;
  selected: boolean;
  onSelect: () => void;
  /** The largest size that fills inside tolerance on BOTH batches (the
   * smallest of the four legs' own figures), once both have quoted. */
  onFit: (fit: number) => void;
}) {
  const longLeg = yuLegs.find((l) => l.venue === pair.longVenue);
  const shortLeg = yuLegs.find((l) => l.venue === pair.shortVenue);

  /** Closing reverses each leg: a LONG position is closed by selling. */
  const exitReq: BorosPairRequest | null =
    address !== null && size > 0 && longLeg?.marketId !== undefined && shortLeg?.marketId !== undefined
      ? {
          address,
          legA: { marketId: longLeg.marketId, direction: longLeg.side === 'LONG' ? 'short' : 'long', slippageApr: exitSlippageApr },
          legB: { marketId: shortLeg.marketId, direction: shortLeg.side === 'LONG' ? 'short' : 'long', slippageApr: exitSlippageApr },
          size,
          intent: 'close',
        }
      : null;

  /** Re-opening takes the same sides the pair holds today, at the new maturity. */
  const entryReq: BorosPairRequest | null =
    address !== null && size > 0 && longLeg !== undefined && shortLeg !== undefined
      ? {
          address,
          legA: { marketId: target.longMarketId, direction: longLeg.side === 'LONG' ? 'long' : 'short', slippageApr: entrySlippageApr },
          legB: { marketId: target.shortMarketId, direction: shortLeg.side === 'LONG' ? 'long' : 'short', slippageApr: entrySlippageApr },
          size,
          intent: 'open',
        }
      : null;

  const exit = useBorosPairSimulation(exitReq, exitReq !== null);
  const entry = useBorosPairSimulation(entryReq, entryReq !== null);

  /**
   * The size the books take inside tolerance, per leg, from the freshest
   * quote of each batch — the figure does not depend on the size asked, so
   * any quote will do, but all four legs must have one. Reported upward so
   * the modal can default the slider to it.
   */
  const fitLegs = [exit.data?.simulation, entry.data?.simulation].flatMap((s) => (s ? [s.legA, s.legB] : []));
  const fit =
    fitLegs.length === 4 && fitLegs.every((l) => typeof l.sizeWithinTolerance === 'number')
      ? Math.min(...fitLegs.map((l) => l.sizeWithinTolerance as number))
      : null;
  const onFitRef = useRef(onFit);
  onFitRef.current = onFit;
  useEffect(() => {
    if (fit !== null) onFitRef.current(fit);
  }, [fit]);

  const entrySim = entry.data?.simulation;
  const exitSim = exit.data?.simulation;
  const {
    netRate,
    spreadApr,
    netByMaturityUsd,
    grossByMaturityUsd,
    totalCostUsd,
    exitCostUsd,
    entryCostUsd,
    exitPnlUsd,
    capitalUsd,
    newBorosImUsd,
  } = rollFigures({ entrySim, exitSim, size, perpImUsd, maturity: target.maturity, longLeg, shortLeg, nowSec });

  const pending = exit.isPending || entry.isPending;
  /**
   * Two quotes, one size: the figures are only consistent when BOTH sims
   * answer for the size being shown. The hook keeps the previous quote while
   * a new one is in flight, so after a slider move the card briefly holds a
   * new entry against an old exit (or the slice's perp margin against the
   * old size's Boros margin) — a wrong number for a round-trip, then the
   * right one: the flicker he saw. So a snapshot is taken only when neither
   * quote is a placeholder, and the last consistent one stays up, dimmed,
   * until the next.
   */
  const fresh = !entry.isPlaceholderData && !exit.isPlaceholderData;
  const live = {
    netRate,
    spreadApr,
    netByMaturityUsd,
    grossByMaturityUsd,
    totalCostUsd,
    exitCostUsd,
    entryCostUsd,
    exitPnlUsd,
    capitalUsd,
    newBorosImUsd,
    perpImUsd,
  };
  const held = useRef(live);
  if (fresh) held.current = live;
  const v = fresh ? live : held.current;
  const settling = fresh ? '' : 'opacity-60 transition-opacity';


  return (
    <div
      className={`rounded border transition-colors ${
        selected ? 'border-sky-500/50 bg-sky-500/[0.06]' : 'border-ink-700 bg-ink-950/40 hover:border-ink-600'
      }`}
    >
      <button type="button" className="flex w-full items-center gap-3 p-3 text-left" onClick={onSelect}>
        <span
          aria-hidden
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
            selected ? 'border-sky-400 bg-sky-400/30' : 'border-ink-600'
          }`}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={`num text-[20px] font-semibold leading-none tracking-[-0.02em] ${settling}`}>
            {v.netRate !== null ? (
              <SignedNumber value={v.netRate} format={fmtPct} />
            ) : (
              <span className="text-ink-600">{pending ? '…' : '—'}</span>
            )}
            <span className="ml-1.5 text-[12px] font-normal text-ink-300">fixed</span>
          </span>
          <span className="num text-[11.5px] text-ink-400" title="The new maturity — how long the rolled legs run, and the day they settle">
            {Math.max(0, Math.ceil((target.maturity - nowSec) / 86_400))}d ({fmtDateLocal(target.maturity)})
          </span>
        </span>
      </button>

      {/* Under the rate: what it locks, what that is worth, what it ties up
          — three figures of one rank. The fees that were netted out of the
          headline come last and small: they explain the number, they are
          not the number (his call 2026-09-17). */}
      {selected && (
        <div className={`border-t border-ink-800 px-3 pb-3 pt-2.5 ${settling}`}>
          <div className="grid grid-cols-3 gap-x-4">
            <div title="The spread the new legs would lock, on notional, from the live books: what the receive leg locks minus what the pay leg locks">
              <div className={statLabel}>Locked spread</div>
              <div className={statValue}>
                {v.spreadApr !== null ? (
                  <SignedNumber value={v.spreadApr} format={fmtPct} />
                ) : (
                  <span className="text-ink-600">{pending ? '…' : '—'}</span>
                )}
              </div>
            </div>
            <div
              title={
                v.grossByMaturityUsd !== null
                  ? `${fmtUsd(v.grossByMaturityUsd)} of carry to ${fmtDateLocal(target.maturity)}, less ${v.totalCostUsd !== null ? fmtUsd(v.totalCostUsd) : 'the'} of fees, ${v.exitPnlUsd !== null ? `${v.exitPnlUsd >= 0 ? 'plus' : 'less'} ${fmtUsd(Math.abs(v.exitPnlUsd))} realised closing the old legs` : 'plus the PnL of closing the old legs'}`
                  : 'Carry to the new maturity, less the fees paid to get into it, plus the PnL of closing the old legs'
              }
            >
              <div className={statLabel}>Est. earnings by maturity</div>
              <div className={`${statValue} font-semibold`}>
                {v.netByMaturityUsd !== null ? (
                  <SignedNumber value={v.netByMaturityUsd} format={fmtUsd} />
                ) : (
                  <span className="text-ink-600">{pending ? '…' : '—'}</span>
                )}
              </div>
            </div>
            <div
              title={
                v.newBorosImUsd !== null
                  ? `Perp margin behind this size ${fmtUsd(v.perpImUsd)} (the perps themselves are untouched) + fresh Boros margin ${fmtUsd(v.newBorosImUsd)}`
                  : 'Perp margin behind this size (the perps themselves are untouched) + the fresh Boros margin the new legs need'
              }
            >
              <div className={statLabel}>Capital</div>
              <div className={`${statValue} text-ink-100`}>{v.capitalUsd !== null ? fmtUsdCompact(v.capitalUsd) : '—'}</div>
            </div>
          </div>
          {/* The split sits behind an ⓘ after the number, the house pattern
              (reduce-only ⓘ, dust assets ⓘ): the number is what the option
              states, the split is what explains it. */}
          {/* ONE figure for what the roll costs on day one: the two batches'
              fees, and what closing the old legs realises of their remaining
              locked spread (which can pay for the fees, or add to them). The
              split is behind the ⓘ. */}
          <div className="num mt-2.5 flex items-baseline justify-between gap-3 border-t border-ink-800 pt-2 text-[11px] text-ink-500">
            <span>Rollover Cost</span>
            <span>
              {v.totalCostUsd !== null && v.exitPnlUsd !== null ? (
                <SignedNumber value={v.exitPnlUsd - v.totalCostUsd} format={fmtUsd} />
              ) : (
                <span className="text-ink-600">—</span>
              )}
              <span
                className="ml-1 cursor-help text-ink-500"
                title={`Exit fee ${v.exitCostUsd !== null ? `−${fmtUsd(v.exitCostUsd)}` : '—'} · Re-entry fee ${v.entryCostUsd !== null ? `−${fmtUsd(v.entryCostUsd)}` : '—'} · Exit PnL ${v.exitPnlUsd !== null ? `${v.exitPnlUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v.exitPnlUsd))}` : '—'} (what closing the old legs at today's rates realises of their remaining locked spread). All counted in the rate and the earnings above.`}
              >
                ⓘ
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Two perps that offset each other with the rate side missing behind them:
 * the hedge a roll was missed on. Drawn on the pairs list's own columns so
 * it reads as a pair that is INCOMPLETE, not as loose legs — and its one job
 * is to get the missing Boros legs opened: both at once, or the single one
 * a side still lacks (his call 2026-09-20).
 */
function PerpOnlyPairCard({
  pair,
  base,
  nowSec,
  onOpenBoros,
  onClosePerps,
}: {
  pair: PerpOnlyPair;
  base: string;
  nowSec: number;
  /** Opens the close form on this unit's two perp slices — the other way
   * out of a hedge with no rate side: stop farming it. */
  onClosePerps: () => void;
  /** Arms the Boros ticket for the named side(s) at this size; null when
   * there is no trade flow to arm (a provider-less render). */
  onOpenBoros: ((sides: { long: boolean; short: boolean }) => void) | null;
}) {
  const [open, setOpen] = useState(true);
  const needLong = pair.missingLong > 0;
  const needShort = pair.missingShort > 0;
  const both = needLong && needShort;
  const held = pair.longYu ?? pair.shortYu;
  const cell = 'border-b border-ink-850 px-2.5 py-2';
  const pill = 'btn !rounded-full !bg-transparent !px-3.5 !py-1 !text-[12.5px]';
  const sizeText = (n: number) => sizeLabel(n, pair.unit, base);
  const sideChip = (side: 'LONG' | 'SHORT') => (
    <Chip sm tone={side === 'LONG' ? 'green' : 'red'}>
      {side}
    </Chip>
  );
  const legName = (venue: string, kind: 'perp' | 'yu', side: 'LONG' | 'SHORT') => (
    <span className="inline-flex items-center gap-[7px]">
      <span className="font-medium text-ink-50">{prettyVenue(venue)}</span>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${kind === 'yu' ? 'text-link' : 'text-ink-400'}`}>
        {kind === 'yu' ? 'Boros' : 'CrossEx'}
      </span>
      {sideChip(side)}
    </span>
  );
  /** One rate-leg row: the leg that is there, or the gap where one belongs. */
  const yuRow = (venue: string, side: 'LONG' | 'SHORT', yu: PendingLeg | null, missing: number) =>
    yu && !(missing > 0) ? (
      <tr key={`yu-${venue}`}>
        <td className={`${cell} whitespace-nowrap`}>{legName(venue, 'yu', side)}</td>
        <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>{sizeText(sizeIn(yu, yu.unit))}</td>
        <td className={`${cell} num whitespace-nowrap text-right`}>
          <SignedNumber value={yu.lockedApr} format={fmtPct} />
        </td>
        <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>{fmtUsdCompact(yu.imUsd)}</td>
      </tr>
    ) : (
      <tr key={`yu-${venue}`} className="bg-amber-500/[0.04]">
        <td className={`${cell} whitespace-nowrap`}>
          <span className="inline-flex items-center gap-[7px]">
            {legName(venue, 'yu', side)}
            <Chip sm tone="amber">
              missing
            </Chip>
          </span>
        </td>
        <td className={`${cell} num whitespace-nowrap text-right text-amber-200/90`}>{sizeText(missing)}</td>
        <td className={`${cell} num text-right text-ink-600`}>—</td>
        <td className={`${cell} whitespace-nowrap text-right`}>
          <button
            type="button"
            className="btn-ghost-xs !py-[5px] !text-grass hover:!border-grass/60"
            disabled={!onOpenBoros}
            title={`Open only the ${prettyVenue(venue)} ${side} Boros leg, at ${sizeText(missing)}`}
            onClick={() => onOpenBoros?.({ long: side === 'LONG', short: side === 'SHORT' })}
          >
            Open leg
          </button>
        </td>
      </tr>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-amber-500/40 bg-ink-950/40">
      <table className="w-full min-w-[880px] table-fixed border-collapse">
        <PairColGroup />
        <tbody>
          <tr className="cursor-pointer transition-colors hover:bg-ink-850/30 [&>td]:py-3 [&>td]:align-middle" onClick={() => setOpen((v) => !v)}>
            <td className="pl-4 pr-3">
              <button
                type="button"
                aria-expanded={open}
                className="inline-flex min-w-0 flex-wrap items-center gap-[7px] text-left text-[13.5px] font-semibold leading-none text-ink-50"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((v) => !v);
                }}
              >
                <span className="inline-flex items-baseline gap-[5px]">
                  <span className="text-[9.5px] font-semibold tracking-[0.1em] text-grass">L</span>
                  {prettyVenue(pair.longVenue)}
                </span>
                <span className="text-ink-600">/</span>
                <span className="inline-flex items-baseline gap-[5px]">
                  <span className="text-[9.5px] font-semibold tracking-[0.1em] text-guava">S</span>
                  {prettyVenue(pair.shortVenue)}
                </span>
                <Chip
                  sm
                  tone="amber"
                  className="!font-medium"
                  title="These two perps cancel each other's price risk, but the rate side behind them is not there — so they pay and receive FLOATING funding and lock nothing"
                >
                  {both ? 'Boros legs missing' : 'Boros leg missing'}
                </Chip>
              </button>
            </td>
            <td className="num whitespace-nowrap px-3 text-[13px] text-ink-200">
              {held ? (
                <span title="The one rate leg this unit still has settles here">
                  {fmtDateLocal(held.maturity)} <span className="text-ink-400">· {daysLeftText(held.maturity, nowSec)}</span>
                </span>
              ) : (
                <span className="text-ink-600">—</span>
              )}
            </td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px] text-ink-50" title={`${exactUsd(pair.notionalUsd)} — ${exactSize(pair.size, pair.unit, base)} per side`}>
              {fmtUsdCompact(pair.notionalUsd)}
            </td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px] text-ink-50" title={`${exactUsd(pair.imUsd)} — today's initial margin on these legs`}>
              {fmtUsdCompact(pair.imUsd)}
            </td>
            <td className="px-3 text-right text-[13px] text-ink-600" title="No rate is locked until both Boros legs are open">—</td>
            <td className="px-3 text-right text-[13px] text-ink-600" title="No rate is locked, so there is no profit to estimate">—</td>
            <td className="whitespace-nowrap pl-3 pr-4 text-right">
              <span aria-hidden className={`inline-block text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}>
                <ChevronIcon />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      {open && (
        <div className="border-t border-ink-800 px-4 pb-4 pt-3">
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
                {[pair.long, pair.short].map((l) => (
                  <tr key={`p-${l.symbol}`}>
                    <td className={`${cell} whitespace-nowrap`}>{legName(l.venue, 'perp', l.side)}</td>
                    <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>{sizeText(sizeIn(l, l.unit))}</td>
                    <td className={`${cell} num text-right text-ink-600`}>—</td>
                    <td className={`${cell} num whitespace-nowrap text-right text-ink-100`}>{fmtUsdCompact(l.imUsd)}</td>
                  </tr>
                ))}
                {yuRow(pair.longVenue, 'LONG', pair.longYu, pair.missingLong)}
                {yuRow(pair.shortVenue, 'SHORT', pair.shortYu, pair.missingShort)}
              </tbody>
            </table>
          </div>
          {/* The two ways out: finish the hedge, or stop farming it. */}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className={`${pill} hover:!border-guava/50 hover:!text-guava`}
              title={`Close both perps of this unit — ${sizeText(pair.size)} on each side`}
              onClick={onClosePerps}
            >
              Close perps
            </button>
            {both && (
              <button
                type="button"
                className={`${pill} !border-grass/60 !text-grass hover:!border-grass hover:!bg-grass/10`}
                disabled={!onOpenBoros}
                title={`Open both Boros legs together — long ${prettyVenue(pair.longVenue)}, short ${prettyVenue(pair.shortVenue)}, ${sizeText(Math.min(pair.missingLong, pair.missingShort))} each`}
                onClick={() => onOpenBoros?.({ long: true, short: true })}
              >
                Open both Boros legs
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every leg no 4-leg unit claimed, as one card at the end of the pairs
 * list: perps at a venue with no YU to pair against (or the slice left once
 * the YU ran out), and YU legs with no counterpart at their maturity — the
 * far end of a ladder mid-roll, a rate leg opened ahead of its hedge. They
 * hedge nothing as a unit and lock no rate, so they are listed apart
 * rather than blended into a pair that settles on another day.
 */
function UngroupedCard({
  perps,
  yus,
  group,
  base,
  nowSec,
  defaultOpen,
  livePositions,
  onCloseLeg,
}: {
  perps: UnpairedPerp[];
  yus: PendingLeg[];
  group: AssetGroup;
  base: string;
  nowSec: number;
  defaultOpen: boolean;
  livePositions: Map<string, CrossexPosition>;
  onCloseLeg: (leg: { kind: 'perp'; leg: AssetPerpOpen } | { kind: 'boros'; leg: AssetBorosOpen }) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const notionalUsd = perps.reduce((t, l) => t + l.notionalUsd, 0) + yus.reduce((t, l) => t + l.notionalUsd, 0);
  const imUsd = perps.reduce((t, l) => t + l.imUsd, 0) + yus.reduce((t, l) => t + l.imUsd, 0);
  const unit = (perps[0] ?? yus[0])?.unit ?? 'usd';
  const size = perps.reduce((t, l) => t + sizeIn(l, unit), 0) + yus.reduce((t, l) => t + sizeIn(l, unit), 0);
  /** A close from here is only for a WHOLE leg: the close forms size
   * against the venue position, and closing all of a leg that is partly
   * paired would break the pair it belongs to. */
  const whole = (share: number) => share >= 0.9995;
  const sideChip = (side: 'LONG' | 'SHORT') => (
    <Chip sm tone={side === 'LONG' ? 'green' : 'red'}>
      {side}
    </Chip>
  );
  const closeBtn = (label: string, onClick: (() => void) | undefined, title: string) => (
    <button
      type="button"
      aria-label={label}
      className="btn-ghost-xs !py-[5px] hover:!border-guava/50 hover:!text-guava"
      title={title}
      disabled={!onClick}
      onClick={onClick}
    >
      Close leg
    </button>
  );
  return (
    <div className="overflow-x-auto rounded-lg border border-dashed border-ink-600 bg-ink-950/40">
      <table className="w-full min-w-[880px] table-fixed border-collapse">
        <PairColGroup />
        <tbody>
          <tr
            className="cursor-pointer transition-colors hover:bg-ink-850/30 [&>td]:py-3 [&>td]:align-middle"
            onClick={() => setOpen((v) => !v)}
          >
            <td className="pl-4 pr-3">
              <button
                type="button"
                aria-expanded={open}
                className="inline-flex min-w-0 flex-wrap items-center gap-[7px] text-left leading-none"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((v) => !v);
                }}
              >
                <span className="text-[13.5px] font-semibold leading-none text-ink-50">Ungrouped legs</span>
                <Chip sm tone="amber" title="These legs are in no 4-leg pair: no counterpart at their venue or maturity to lock a rate against">
                  not in a pair
                </Chip>
                <span className="num text-[11.5px] leading-none text-ink-400">
                  {[
                    perps.length > 0 ? `${perps.length} perp` : null,
                    yus.length > 0 ? `${yus.length} YU` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </td>
            <td className="px-3 text-[13px] text-ink-600" title="No single settlement day: each leg matures on its own">—</td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px] text-ink-50" title={`${exactUsd(notionalUsd)} — ${exactSize(size, unit, base)} unpaired`}>
              {fmtUsdCompact(notionalUsd)}
            </td>
            <td className="num whitespace-nowrap px-3 text-right text-[13px] text-ink-50" title={`${exactUsd(imUsd)} — today's initial margin on these legs`}>
              {fmtUsdCompact(imUsd)}
            </td>
            <td className="px-3 text-right text-[13px] text-ink-600" title="No 4-leg unit, no locked rate: a lone YU earns its own fixed rate, a lone perp pays floating funding">—</td>
            <td className="px-3 text-right text-[13px] text-ink-600" title="No 4-leg unit, so there is no profit to estimate">—</td>
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
          <table className="w-full min-w-[880px] table-fixed border-collapse text-[12.5px] [&_td]:border-b [&_td]:border-ink-800/70 [&_td]:px-3 [&_td]:py-[9px] [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_tr:last-child_td]:border-b-0">
            <colgroup>
              <col style={{ width: '30%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '18%' }} />
            </colgroup>
            <thead>
              <tr className="bg-ink-900/60 [&>th]:px-3 [&>th]:py-2 [&>th]:text-[10px] [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-[0.12em] [&>th]:text-ink-500 [&>th:first-child]:pl-4 [&>th:last-child]:pr-4">
                <th className="text-left">Leg</th>
                <th className="text-right">Size</th>
                <th className="text-right">Locked</th>
                <th className="text-right">Initial margin</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {perps.map((l) => {
                const leg = group.perpOpen.find((p) => p.symbol === l.symbol);
                const live = leg !== undefined && livePositions.has(l.symbol);
                const can = whole(l.share) && live && leg !== undefined;
                return (
                  <tr key={`p-${l.symbol}`}>
                    <td className="whitespace-nowrap">
                      <LegIdentity
                        kind="perp"
                        name={prettyVenue(l.venue)}
                        sub={whole(l.share) ? 'CrossEx · not in a pair' : `CrossEx · ${fmtPct(l.share)} of the leg unpaired`}
                        chips={sideChip(l.side)}
                      />
                    </td>
                    <td className="num text-right">
                      <span title={exactSize(sizeIn(l, l.unit), l.unit, base)}>{sizeLabel(sizeIn(l, l.unit), l.unit, base)}</span>
                      <span className="ml-1 text-ink-500">({fmtUsdCompact(l.notionalUsd)})</span>
                    </td>
                    <td className="num text-right text-ink-600" title="A perp locks no rate — it pays or receives floating funding">
                      —
                    </td>
                    <td className="num text-right text-ink-100" title={exactUsd(l.imUsd)}>
                      {fmtUsdCompact(l.imUsd)}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {closeBtn(
                        `Close ${prettyVenue(l.venue)} ${l.side} perp`,
                        can ? () => onCloseLeg({ kind: 'perp', leg: leg }) : undefined,
                        !whole(l.share)
                          ? 'Part of this leg is in a pair — close it from its funding bundle'
                          : !live
                            ? 'Live position not loaded yet'
                            : 'Close this perp leg — reduce-only at mark',
                      )}
                    </td>
                  </tr>
                );
              })}
              {yus.map((l) => {
                const leg = group.borosOpen.find((b) => b.marketId === l.marketId);
                const can = whole(l.share) && leg !== undefined;
                const days = Math.ceil((l.maturity - nowSec) / 86_400);
                return (
                  <tr key={`y-${l.marketId}`}>
                    <td className="whitespace-nowrap">
                      <LegIdentity
                        kind="boros"
                        name={prettyVenue(l.venue)}
                        sub={
                          <span title="Maturity — no counterpart at the other venue settles on this day">
                            {fmtDateLocal(l.maturity)}
                            {days > 0 && (
                              <>
                                {' · '}
                                <span className="text-ink-200">{days}d</span>
                              </>
                            )}
                          </span>
                        }
                        chips={sideChip(l.side)}
                      />
                    </td>
                    <td className="num text-right">
                      <span title={exactSize(sizeIn(l, l.unit), l.unit, base)}>{sizeLabel(sizeIn(l, l.unit), l.unit, base)}</span>
                      <span className="ml-1 text-ink-500">({fmtUsdCompact(l.notionalUsd)})</span>
                      {!whole(l.share) && (
                        <span className="ml-1 text-ink-500" title="The rest of this leg is in a pair; only this slice is unpaired">
                          ({fmtPct(l.share)})
                        </span>
                      )}
                    </td>
                    <td className="num text-right font-semibold" title="The fixed rate this leg locks on its own, signed by side (+ receives, − pays), net of settlement fees">
                      <SignedNumber value={l.lockedApr} format={fmtPct} />
                    </td>
                    <td className="num text-right text-ink-100" title={exactUsd(l.imUsd)}>
                      {fmtUsdCompact(l.imUsd)}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {closeBtn(
                        `Close ${prettyVenue(l.venue)} ${l.side} YU`,
                        can ? () => onCloseLeg({ kind: 'boros', leg: leg }) : undefined,
                        whole(l.share)
                          ? 'Close this Boros leg — market order on Boros'
                          : 'Part of this leg is in a pair — close it from its funding bundle',
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
            </td>
            <td
              className="px-3 text-right"
              title={`Perp funding + Boros settlements (net of settle fees), live and finished legs — this venue's share of the Fixed funding bar.${
                b.feesUsd > 0
                  ? ` Trading fees on this venue's legs: −${fmtUsd(b.feesUsd)} (perp fees + Boros trade fees), itemised per leg below.`
                  : ' No trading fees on this venue.'
              }`}
            >
              <div className={statLabel}>Funding settlement</div>
              <div className={statValue}>
                <SignedNumber value={b.settleUsd} format={fmtUsd} />
              </div>
            </td>
            <td
              className="px-3 text-right"
              title={`Not funding: Boros realised rate PnL + perp realised price PnL on closes + perp uPnL. Funding settlement − fees + this = the bundle's PnL.${
                multiVenue && Math.abs(b.tradePnlUsd) >= 0.005 ? ' Offsets across venues — the pairs tab reads it per unit.' : ''
              }`}
            >
              <div className={statLabel}>Trade PnL</div>
              <div className={statValue}>
                {Math.abs(b.tradePnlUsd) >= 0.005 ? (
                  <SignedNumber value={b.tradePnlUsd} format={fmtUsd} />
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </div>
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
  /** Which projection of the book is showing: the accounting (bundles) or
   * the estimate (4-leg pairs). Per card — an ETH book open on pairs says
   * nothing about the BTC card below it. */
  const [view, setView] = useState<'bundles' | 'pairs'>('pairs');
  /** Bumped by the roll-over banner: every rollable pair card re-opens on it,
   * even one the user folded by hand — "Show me" must show them. */
  const [showRollNonce, setShowRollNonce] = useState(0);
  /** Each rollable pair's best roll opportunity, keyed as the cards are —
   * what the banner shouts about, when there is one. */
  const [rollSignals, setRollSignals] = useState<Record<string, RollOpportunity | null>>({});
  /** Publish every rollable pair to the app-wide banner, and take its
   * "Show me" as the cue to open them here. */
  const publishRoll = useRollPublisher();
  const rollApi = useRollSignalsOptional();
  const appShowNonce = rollApi?.showNonce ?? 0;
  useEffect(() => {
    // Only on a real click: the provider starts at 0, and opening every
    // rollable card on mount would fight the user's own folding. The tab
    // moves with it — the banner's job is to put the roll on screen, and
    // the actions live in the pairs view.
    if (appShowNonce === 0) return;
    setView('pairs');
    setShowRollNonce((n) => n + 1);
  }, [appShowNonce]);
  const [closedOpen, setClosedOpen] = useState(false);
  const [closePerps, setClosePerps] = useState<PairEstimate | null>(null);
  const [closePerpOnly, setClosePerpOnly] = useState<PerpOnlyPair | null>(null);
  const [closeBoros, setCloseBoros] = useState<PairEstimate | null>(null);
  const [rollOver, setRollOver] = useState<PairEstimate | null>(null);
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
  const hasLegs = group.perpOpen.length > 0 || group.borosOpen.length > 0;

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
  // Pairs inside the roll window — the banner's count, and the cards it
  // points at carry the same flag.
  const rollable = derived.pairs.filter((p) => pairCanRoll(p, nowSec));
  /** Where "Show me" lands: the FIRST pair inside the window, so every
   * rollable pair below it is in view too. Landing on the best opportunity
   * scrolled the first pair off the top (his catch 2026-09-20). */
  const showTarget: PairEstimate | null = rollable[0] ?? null;
  /**
   * What this asset contributes to the app-wide banner: one entry per
   * rollable pair, carrying its opportunity when a card found one. Keyed by
   * asset + pair so two assets never collide, and cleared on unmount — a
   * card that stops rendering must not leave a stale line in the banner.
   */
  const rollKeys = rollable.map((p) => `${group.base}:${pairKey(p)}`).join('|');
  const rollJson = JSON.stringify(rollable.map((p) => rollSignals[pairKey(p)] ?? null));
  useEffect(() => {
    const live = new Set<string>();
    for (const p of rollable) {
      const key = `${group.base}:${pairKey(p)}`;
      live.add(key);
      publishRoll(key, {
        key,
        asset: group.base,
        longVenue: p.longVenue,
        shortVenue: p.shortVenue,
        maturity: p.soonestMaturitySec,
        opportunity: rollSignals[pairKey(p)] ?? null,
      });
    }
    return () => {
      for (const key of live) publishRoll(key, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollKeys, rollJson, group.base, publishRoll]);
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
      // Known, not positive: a negative-funding market has a real float too.
      const floatingApr = boros.find((l) => knownRate(l.floatingApr))?.floatingApr ?? null;
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
  // Several asset cards share the page, so the tab/panel ids carry the coin.
  const tabsId = `asset-${group.base}`;
  /**
   * Offsetting perps with no rate side are PAIRS with something missing, not
   * loose legs: they are lifted out of the ungrouped list into cards of their
   * own, and only what they did not claim stays ungrouped.
   */
  const perpOnly = useMemo(
    () => perpOnlyPairs(derived.unpairedPerps, derived.pendingLegs),
    [derived.unpairedPerps, derived.pendingLegs],
  );
  const ungroupedCount = perpOnly.restPerps.length + perpOnly.restYus.length;
  /**
   * Arm the Boros ticket for a perp-only pair's missing side(s). The
   * maturity is the one rate leg the unit still holds, when it has one —
   * the missing leg must settle with it; otherwise the latest maturity this
   * asset already farms, so the new legs join the ladder rather than landing
   * on whichever market the ticket lists first.
   */
  const openBorosFor = (p: PerpOnlyPair, sides: { long: boolean; short: boolean }) => {
    if (!flow) return;
    const held = p.longYu ?? p.shortYu;
    const laddered = derived.pairs.map((x) => x.soonestMaturitySec).filter((m) => m > nowSec);
    const size = sides.long && sides.short ? Math.min(p.missingLong, p.missingShort) : sides.long ? p.missingLong : p.missingShort;
    const perSideUsd = p.size > 0 ? (p.notionalUsd / 2) * (size / p.size) : 0;
    flow.prefillBorosOpen({
      base: group.base,
      longVenue: sides.long ? p.longVenue : null,
      shortVenue: sides.short ? p.shortVenue : null,
      maturity: held ? held.maturity : laddered.length > 0 ? Math.max(...laddered) : undefined,
      size: perSideUsd,
      sizeBase: p.unit === 'base' ? size : undefined,
    });
    flow.openRail();
  };
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
            {/* Cost is a COMPONENT of PnL (PnL = carry − cost), not a peer of
                it, so it reads as this figure's sub-line rather than a fourth
                hero number — matching the APR's "≈ $X/day" line opposite. Not
                a control of its own: the PnL figure above opens the one
                breakdown, which already itemises these fees per leg. */}
            <div
              className="num mt-2 text-[11px] leading-none text-ink-400"
              title={`Everything that eats into the carry, whenever it was paid: perp fees ${fmtUsd(totals.perpFeesAllUsd)} + Boros fees ${fmtUsd(totals.borosFeesAllUsd)} − price basis ${fmtUsd(totals.priceResidualUsd)}. PnL = carry − cost.`}
            >
              All time Cost {fmtUsd(Math.abs(totals.costUsd))}
            </div>
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
              Current Capital
            </div>
            <div className="num mt-2 text-2xl font-semibold leading-none tracking-[-0.02em] text-ink-50">
              {fmtUsd(totals.capitalUsd)}
            </div>
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
      {/* The roll-over banner moved to the app shell (RollOverBanner) — a
          hedge about to settle is not news for the Positions tab alone. This
          card PUBLISHES its pairs' signals; only the hedge warning is drawn
          here (his call 2026-09-20). */}
      {hasLegs && !derived.deltaNeutral && (
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
        </div>
      )}

      {/* Two projections of one book. Funding bundles are the accounting —
          they foot to the waterfall to the cent; 4-leg pairs are the
          estimate — the same legs regrouped into fixed-term units, split by
          today's sizes. A tab each, so neither is a popup away. */}
      <SectionTabs
        id={tabsId}
        value={view}
        onChange={setView}
        options={[
          { value: 'bundles', label: 'Funding Bundles', count: activeBundles.length },
          { value: 'pairs', label: '4 Leg Pairs', count: derived.pairs.length + perpOnly.pairs.length },
        ]}
        right={
          view === 'bundles' ? (
            <>
              <span className={microLabelClass}>Funding bundles</span>
              <span className="num text-sm font-semibold" title="Perp funding + Boros settlements, live and finished legs — the Fixed funding bar">
                <SignedNumber value={fixedFundingUsd} format={fmtUsd} />
              </span>
            </>
          ) : (
null
          )
        }
      />

      {/* FUNDING BUNDLES — one row per exchange: its perp and every YU leg
          hedging it, at every maturity. What the venue holds, the fixed
          rate it is hedged at, what it has settled, what it cost. One card
          per bundle, expanding into its legs in place. Finished legs stay
          inside their bundle; a bundle whose every leg is gone moves to the
          closed strip at the panel's end. */}
      <div
        role="tabpanel"
        id={`${tabsId}-panel-bundles`}
        aria-labelledby={`${tabsId}-tab-bundles`}
        hidden={view !== 'bundles'}
        className="mb-3"
      >
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

      {/* CLOSED BUNDLES — exchanges where both sides are gone. A strip
          states the one number that still matters (their settlement is in
          the book's PnL); the bundles themselves open in a modal, in the
          same table as the live ones. */}
      {closedBundles.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setClosedOpen(true)}
            className="mt-3 flex w-full flex-wrap items-center gap-2 rounded border border-ink-700 bg-ink-950/60 px-3.5 py-2.5 text-left text-xs transition-colors hover:border-ink-500"
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

      </div>

      {/* 4 LEG PAIRS — the same book as a DIFFERENT PROJECTION: an estimated
          4-leg regrouping, one card per venue pairing at one maturity,
          each expanding in place to the legs and the fee ladder. Whatever
          no unit claimed sits in one ungrouped card at the end. */}
      <div
        role="tabpanel"
        id={`${tabsId}-panel-pairs`}
        aria-labelledby={`${tabsId}-tab-pairs`}
        hidden={view !== 'pairs'}
        className="mb-3"
      >
        {derived.pairs.length > 0 || perpOnly.pairs.length > 0 || ungroupedCount > 0 ? (
          <div className="flex flex-col gap-2">
            <PairListHeader />
            {derived.pairs.map((p) => (
              <PairCard
                key={pairKey(p)}
                pair={p}
                base={group.base}
                nowSec={nowSec}
                // A pair that can roll opens expanded: its Roll over action
                // lives in the expansion, and the flag on the summary row
                // is the reason the user came to this tab.
                defaultOpen={pairCanRoll(p, nowSec)}
                showRollNonce={showRollNonce}
                focusOnShow={p === showTarget}
                onClosePerps={() => setClosePerps(p)}
                onCloseBoros={() => setCloseBoros(p)}
                onRollOver={() => setRollOver(p)}
                onRollSignal={(opp) =>
                  setRollSignals((prev) => {
                    const k = pairKey(p);
                    const cur = prev[k] ?? null;
                    const same =
                      cur === opp || (cur !== null && opp !== null && cur.maturity === opp.maturity && cur.rate === opp.rate && cur.current === opp.current);
                    return same ? prev : { ...prev, [k]: opp };
                  })
                }
              />
            ))}
            {perpOnly.pairs.map((p) => (
              <PerpOnlyPairCard
                key={`po:${p.longVenue}:${p.shortVenue}`}
                pair={p}
                base={group.base}
                nowSec={nowSec}
                onOpenBoros={flow ? (sides) => openBorosFor(p, sides) : null}
                onClosePerps={() => setClosePerpOnly(p)}
              />
            ))}
            {ungroupedCount > 0 && (
              <UngroupedCard
                perps={perpOnly.restPerps}
                yus={perpOnly.restYus}
                group={group}
                base={group.base}
                nowSec={nowSec}
                defaultOpen={false}
                livePositions={livePositions}
                onCloseLeg={setCloseLeg}
              />
            )}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-ink-700 px-3 py-3 text-center text-sm text-ink-500">
            No open legs to pair.
          </p>
        )}
      </div>

      {closePerps !== null && (
        <Modal
          title={
            <>
              Close pair
              <span className="ml-2 text-[12px] font-normal text-ink-400">
                {group.base} · {prettyVenue(closePerps.longVenue)} ⇄ {prettyVenue(closePerps.shortVenue)}
                {closePerps.soonestMaturitySec > 0 ? ` · ${fmtDateLocal(closePerps.soonestMaturitySec)}` : ''}
              </span>
            </>
          }
          onClose={() => setClosePerps(null)}
          widthClass="w-[620px]"
        >
          <div className="flex flex-col gap-3">
            {/* The form's own leg rows say which leg is a pair slice of a
                larger venue position and how much of it. */}
            <ClosePairForm
              base={group.base}
              legs={pairPerpCloseLegs(closePerps)}
              livePositions={livePositions}
            />
          </div>
        </Modal>
      )}
      {closePerpOnly !== null && (
        <Modal
          title={
            <>
              Close pair
              <span className="ml-2 text-[12px] font-normal text-ink-400">
                {group.base} · {prettyVenue(closePerpOnly.longVenue)} ⇄ {prettyVenue(closePerpOnly.shortVenue)} · no rate legs
              </span>
            </>
          }
          onClose={() => setClosePerpOnly(null)}
          widthClass="w-[620px]"
        >
          <div className="flex flex-col gap-3">
            <ClosePairForm base={group.base} legs={perpOnlyCloseLegs(closePerpOnly)} livePositions={livePositions} />
          </div>
        </Modal>
      )}
      {closeLeg?.kind === 'perp' && livePositions.get(closeLeg.leg.symbol) && (
        <ClosePopover
          position={livePositions.get(closeLeg.leg.symbol)!}
          // The opposite perp at another venue is what cancels this leg's
          // price delta; without naming it the popover's "closing leaves
          // that one unhedged" warning could never show.
          hedgedSibling={(() => {
            const me = closeLeg.leg;
            const other = group.perpOpen.find((p) => p.venue !== me.venue && p.side !== me.side);
            return other ? { venue: other.venue, side: other.side } : null;
          })()}
          onDismiss={() => setCloseLeg(null)}
        />
      )}
      {closeLeg?.kind === 'boros' && (
        <Modal
          title={
            <>
              Close Boros leg
              <span className="ml-2 text-[12px] font-normal text-ink-400">
                {prettyVenue(closeLeg.leg.venue)} · {group.base}
                {closeLeg.leg.maturity ? ` · ${fmtDateLocal(closeLeg.leg.maturity)}` : ''} ·{' '}
                {closeLeg.leg.side.toLowerCase()}
              </span>
            </>
          }
          onClose={() => setCloseLeg(null)}
          widthClass="w-[480px]"
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
          title={
            <>
              Close pair
              <span className="ml-2 text-[12px] font-normal text-ink-400">
                {group.base} · {prettyVenue(closeBoros.longVenue)} ⇄ {prettyVenue(closeBoros.shortVenue)}
                {closeBoros.soonestMaturitySec > 0 ? ` · ${fmtDateLocal(closeBoros.soonestMaturitySec)}` : ''}
              </span>
            </>
          }
          onClose={() => setCloseBoros(null)}
          widthClass="w-[620px]"
        >
          <div className="flex flex-col gap-3">
            <CloseBorosForm
              legs={pairBorosCloseLegs(closeBoros, group)}
              onDone={() => setCloseBoros(null)}
            />
          </div>
        </Modal>
      )}
      {rollOver !== null && (
        <RollOverModal pair={rollOver} base={group.base} nowSec={nowSec} onClose={() => setRollOver(null)} />
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
                                title={r.deduped ? 'Carried in the open position’s cumulative funding above (split-position dedupe).' : undefined}
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