/**
 * One 4-leg fixed-return position box, in seven descending tiers:
 *
 *   1-3  identity — asset · the two venues · maturity, in one line and three
 *        weights. The timeline below it is progress texture, not the place a
 *        maturity date is read.
 *   4    stats — FOUR main numbers: Fixed APY · PnL now · PnL at maturity ·
 *        Capital, with spread and ROI as captions under the APY. PnL now is
 *        AFTER costs: it is what the account reflects. Every figure that
 *        describes a FINISHED position is shown only on one — PnL now is the
 *        sole exception, being real cash and value whatever the book's shape.
 *   5    legs — collapsed rows carrying venue+kind+side as one identity, size
 *        in tokens and dollars, the locked rate, and Net. A row states its own
 *        problem (short / over by / unverified) rather than deferring to prose.
 *        Expanding gives live Entry/Mark/Lev, Close/Lev, and where the leg
 *        belongs.
 *   6-7  the waterfalls, and the cost assumptions behind them — the latter in a
 *        settings dialog, since they configure the numbers rather than report.
 *
 * LAYOUT RULE: transient UI (assignment, leverage, close, cost settings) opens
 * as a portaled overlay. Nothing may push the card's content sideways or down;
 * an inline panel that reflows the table hides the rows a user was reading.
 *
 * The card names four shapes — complete, mismatched, partial, orphan — because
 * "not fully hedged" covered three different situations with one sentence: a
 * book with legs missing, a book whose legs are all present but unevenly
 * sized, and a lone leg that is not a half-built strategy at all.
 *
 * Purely prop-driven — PositionsHome owns the queries.
 */
import { useState, type ReactNode } from 'react';
import type {
  CrossexPosition,
  EntryCostMode,
  ExitMode,
  StrategyLeg,
  StrategyRollup,
} from '../api/types';
import { Chip } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { Notes } from '../components/Notes';
import { SignedNumber } from '../components/SignedNumber';
import { microLabelClass } from '../components/Th';
import { SideChip, VenueChip } from '../components/VenueChip';
import {
  fmtAge,
  fmtDateLocal,
  fmtDateUtc,
  fmtPct,
  fmtTime,
  fmtTokenQty,
  fmtUsd,
  fmtUsdCompact,
  parseSymbol,
  prettyVenue,
  sig,
  toDate,
} from '../lib/fmt';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { TimelineClockEdit } from './HomeControls';
import { ClosePairForm } from './PerpOnlyBox';
import { CloseBorosForm } from '../trade/CloseBorosForm';
import { PerpLegExpanded, PositionRowActions } from './PerpLegExpanded';
import { ProfitBars } from './ProfitBars';
import { EntryCostParts } from './EntryCostParts';
import {
  hasLapsedLegacyExclusions,
  loadExcludedPartIds,
  saveExcludedPartIds,
} from './entryPartsStore';
import {
  LegAssignment,
  legRefOf,
  positionVenues,
  SplitChip,
  type LegAssertion,
  type LegDestination,
} from './PartitionEditor';
import type { LegRef } from './partitionStore';
import { buildSharePayload } from './sharePayload';
import { SharePositionModal } from './SharePositionModal';
import type { SharePayloadV1 } from '../lib/shareCodec';
import { applyCostFlags, legTokenSize, SECONDS_IN_YEAR, type CostFlags } from './strategyMath';
import { crossexVenueFor } from '../lib/boros';

/**
 * A position matures only if it has a maturity to reach. `maturity` is 0 on a
 * card with no Boros legs — perp-only, either because the user assigned it that
 * way or because the solver found no Boros side — and the epoch is not a date
 * that has passed, it is the absence of one.
 */
const isMatured = (s: StrategyRollup): boolean => s.maturity > 0 && s.secondsToMaturity === 0;

function HedgeChip({ s }: { s: StrategyRollup }) {
  if (isMatured(s)) return <Chip sm title="The Boros legs have matured">matured</Chip>;
  if (s.hedge === 'hedged') return <Chip sm tone="green">hedged ✓</Chip>;
  if (s.hedge === 'partial') {
    return (
      <Chip sm tone="amber" title={`Residual floating notional ≈ ${fmtUsd(s.notionalMismatchUsd, 0)}`}>
        partial hedge
      </Chip>
    );
  }
  return <Chip sm tone="red" title="No matching perp legs found in the connected Gate account">unhedged</Chip>;
}

type LegRow = StrategyLeg & { _key: string };

/** A leg the book is missing, rendered in the position it would occupy. Not a
 * StrategyLeg: it has no size, no rate and no PnL, and pretending otherwise
 * (a zero-filled leg) would let it be summed into totals it is not part of. */
interface MissingLegRow {
  _key: string;
  kind: 'perp' | 'boros';
  venue: string;
  side: 'LONG' | 'SHORT';
  /** What it would need to be, taken from the leg it would offset. */
  targetUsd: number;
  /**
   * The same target in the leg's OWN token unit, when a same-kind counterpart
   * exists to copy it from — exact, with no price conversion.
   *
   * ⚠ `notionalToken` is NOT one unit: on a Boros leg it counts the COLLATERAL
   * token (ETH for an ETH-collateral market, USDT for a HYPE one), on a perp it
   * counts the BASE coin. So this is only ever copied from a leg of the SAME
   * kind. Absent when there is none, and the caller falls back to USD.
   */
  targetToken?: number;
  /** The unit `targetToken` is in, for labelling. */
  targetUnit?: string;
}

type TableRow = LegRow | MissingLegRow;
const isMissing = (r: TableRow): r is MissingLegRow => !('notionalUsd' in r);

/** Per-venue floating-cancellation summary for a leg's expanded row. */
function VenueCancellation({ legs, venue }: { legs: StrategyLeg[]; venue: string }) {
  const atVenue = legs.filter((l) => l.venue === venue);
  const perp = atVenue.filter((l) => l.kind === 'perp').reduce((s, l) => s + l.cashFlowUsd, 0);
  const boros = atVenue.filter((l) => l.kind === 'boros').reduce((s, l) => s + l.cashFlowUsd, 0);
  const hasBoth = atVenue.some((l) => l.kind === 'perp') && atVenue.some((l) => l.kind === 'boros');
  if (!hasBoth) {
    return (
      <span className="text-xs text-ink-500">
        No opposite leg on {venue} — its floating rate isn't cancelled within this view.
      </span>
    );
  }
  return (
    <span className="num text-xs text-ink-300">
      {venue} floating: perp funding <SignedNumber value={perp} format={(n) => fmtUsd(n)} /> · Boros
      settlements <SignedNumber value={boros} format={(n) => fmtUsd(n)} /> → residual{' '}
      <SignedNumber value={perp + boros} format={(n) => fmtUsd(n)} />
    </span>
  );
}

/** Resolve a perp leg to its live 4s-polled position: exact symbol first, then
 * a best-effort (venue, base) match for payloads without the symbol field. */
function liveFor(
  leg: StrategyLeg,
  livePositions: Map<string, CrossexPosition> | undefined,
): CrossexPosition | null {
  if (!livePositions) return null;
  if (leg.symbol) return livePositions.get(leg.symbol) ?? null;
  for (const p of livePositions.values()) {
    const { exchange, base } = parseSymbol(p.symbol);
    if (exchange === leg.venue && base.toUpperCase() === leg.base) return p;
  }
  return null;
}

export function StrategyCard({
  strategy,
  perpSource,
  since = null,
  onChangeSince,
  livePositions,
  onOpenPerpLegs,
  onOpenPerpLeg,
  onOpenBorosLegs,
  onAssert,
  destinations,
  entryOverrides,
  bookId = '',
  borosUnknown = false,
  borosUnknownCta,
}: {
  /** The custom strategy-start override (per wallet ?since=), editable from
   * the timeline's "Boros position open ✎" label. */
  since?: number | null;
  onChangeSince?: (since: number | null) => void;
  strategy: StrategyRollup;
  perpSource: 'connected-gate-account' | null;
  /** symbol → live CrossexPosition (4s poll) for perp rows and actions. */
  livePositions?: Map<string, CrossexPosition>;
  /** Prefill the pair ticket with this strategy's perp legs — the Boros-only
   * cue (full size) and the complete-the-hedge CTA (which passes the per-leg
   * top-up as `notionalUsd` so the ticket lands sized to the GAP, not the
   * whole book). */
  onOpenPerpLegs?: (s: StrategyRollup, notionalUsd?: number) => void;
  /** Arms the SINGLE perp ticket with one missing row's leg. */
  onOpenPerpLeg?: (
    s: StrategyRollup,
    row: { venue: string; side: 'LONG' | 'SHORT'; targetUsd: number; targetToken?: number; targetUnit?: string },
  ) => void;
  /** Arm the Boros ticket to open this position's missing Boros legs. */
  onOpenBorosLegs?: (
    s: StrategyRollup,
    only?: { side: 'LONG' | 'SHORT'; sizeUsd: number; sizeBase?: number },
  ) => void;
  /**
   * No Boros address is tracked, so we have NOT looked for this position's
   * Boros legs.
   *
   * The card must then state the absence of information, never the absence of
   * legs: "No Boros legs yet" is a claim about the user's book, and with
   * nothing tracked we are in no position to make it. Suppresses the
   * missing-leg rows and every cue that offers to open them, because both
   * assert the same thing.
   */
  borosUnknown?: boolean;
  /** Rendered in place of those cues — the "Add Boros address" control. */
  borosUnknownCta?: ReactNode;
  /** Say where one of this position's legs belongs. Absent = the grouping is
   * read-only (the share page, tests that don't wire it). */
  onAssert?: (a: LegAssertion) => void;
  /** Other cards a leg can be sent to. */
  destinations?: readonly LegDestination[];
  /** What this card has already asserted it paid for a leg — a price for a
   * perp, an APR fraction for a Boros leg. Absent = nothing asserted (or the
   * card has no stable id to have asserted under). */
  entryOverrides?: (leg: LegRef) => number | null;
  /** Which (wallet, Gate account) book this card belongs to — see bookId.ts.
   * Namespaces the excluded entry parts, which are otherwise keyed by a
   * strategyId that says nothing about whose account it is. */
  bookId?: string;
}) {
  const s = strategy;
  // The two waterfalls sit behind the hero boxes / See-more toggle — collapsed
  // by default; the bordered hero box + its "see more" strip invite the click.
  const [chartsOpen, setChartsOpen] = useState(false);
  /** The close form. A destructive action belongs behind a deliberate click,
   * and as an overlay so opening it cannot move the card underneath. */
  const [closeOpen, setCloseOpen] = useState(false);
  /** Boros legs the close dialog is acting on; empty = shut. One row's Close
   * passes that leg, "Close Boros legs" passes them all. */
  const [closingBoros, setClosingBoros] = useState<StrategyLeg[]>([]);
  /** The cost-assumption settings form. */
  const [costOpen, setCostOpen] = useState(false);
  // Per-position exit assumption: 'close' folds the estimated exit costs in
  // (maker+hedge fees + assumed slippage); 'roll' keeps the perps — no exit
  // costs charged. The profit formula includes future costs, so close is the
  // default.
  // Defaults to 'roll': most positions are held to maturity rather than closed
  // early, so charging an assumed exit understated every card by a cost the
  // user has not decided to incur.
  const [exitMode, setExitMode] = useState<ExitMode>('roll');
  // Per-position entry assumption. 'omit' says the perps were rolled into this
  // maturity, so their fees and entry crossing were paid before this strategy
  // existed — Gate reports the fee cumulatively and the entryPrice from the
  // original open, so both would otherwise be billed here. Include is the
  // default: most positions really were opened for this strategy.
  const [entryMode, setEntryMode] = useState<EntryCostMode>('include');
  // Which individual executions this position is NOT charged. Persisted (unlike
  // the toggles either side of it) because it records a fact about the book,
  // not a viewing preference — see entryPartsStore.
  // Keyed by the strategy's own id: it is distinct per maturity (a rolled
  // position starts fresh — the new maturity's entry cost is a different
  // question) AND per tranche when one venue leg is shared, so one
  // (base, maturity) can hold several strategies and an exclusion belongs to
  // exactly one of them.
  // ⚠ The BOOK, then the strategy. A strategyId is `ETH#BINANCE-HYPERLIQUID#exec`
  // — coin, venue pair, evidence tier, and nothing about whose account it is —
  // so on its own it is the same key for every account running that pair, and
  // one account's un-ticked fills quietly reduced another's cost basis.
  const partsKey = `${bookId}|${s.strategyId}`;
  const [excludedPartIds, setExcludedPartIds] = useState<ReadonlySet<string>>(() =>
    loadExcludedPartIds(partsKey),
  );
  const [partsOpen, setPartsOpen] = useState(false);
  // The share snapshot is built at click time and frozen — the 30s strategy
  // refetch can't mutate an open share modal.
  const [sharePayload, setSharePayload] = useState<SharePayloadV1 | null>(null);
  // A DOM id, not a storage key — the book adds nothing a reader can see and
  // its mask carries characters an id should not.
  const partsId = `entry-parts-${s.strategyId}`;
  const entryParts = s.perpEntryCostParts ?? [];
  const toggleEntryPart = (partId: string) => {
    setExcludedPartIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(partId)) next.add(partId);
      saveExcludedPartIds(partsKey, next, Math.floor(Date.now() / 1000));
      return next;
    });
  };
  const flags: CostFlags = {
    inclExitFees: exitMode === 'close',
    inclExitSlippage: exitMode === 'close',
    inclEntryCost: entryMode === 'include',
    excludedEntryPartIds: excludedPartIds,
  };
  // Display-side application of the cost assumptions: the server never bakes
  // the exit parts into any number, and always bakes the entry parts in.
  const { expectedUsd, currentNetUsd, entryAddBackUsd, entryAddBackFeesUsd, entryAddBackSlippageUsd } =
    applyCostFlags({
    flags,
    perpExitFeesUsd: s.feesUsd.future.perpExitFeesUsd,
    perpExitSlippageUsd: s.feesUsd.future.perpExitSlippageUsd,
    perpEntryFeesUsd: s.feesUsd.paid.perpTradingUsd,
    perpEntrySlippageUsd: s.feesUsd.paid.perpEntrySlippageUsd,
    perpEntryParts: entryParts,
    realizedPnlUsd: s.realizedPnlUsd,
    realizedApr: s.realizedApr,
    expectedPnlToMaturityUsd: s.expectedPnlToMaturityUsd,
    capitalUsd: s.capitalUsd,
    elapsedSeconds: s.elapsedSeconds,
  });
  // How many parts are still charged — the count on the Include button, so the
  // card says at a glance that something has been dropped.
  const chargedPartCount = entryParts.filter((p) => !excludedPartIds.has(p.id)).length;
  const chargedEntryUsd =
    s.feesUsd.paid.perpTradingUsd + (s.feesUsd.paid.perpEntrySlippageUsd ?? 0) - entryAddBackUsd;
  // Fixed APR on capital: the PnL expected by maturity (already exit-adjusted
  // for the chosen mode) as a return on the capital posted, annualized over the
  // FULL trade life — start → maturity. This is the net, whole-duration basis
  // the opportunity scanner uses (estProfit / (capital × yearsToMaturity)); the
  // difference for a live position is that the clock runs from when it opened.
  // Null when the clock or capital is unknowable (matches "PNL by maturity").
  //
  // The start is the notional-weighted mean Boros open, not `clockStartSec`.
  // The clock anchors at the EARLIEST leg, so a leg opened weeks later would be
  // annualized over a window it never earned across and the rate would read
  // low. Falls back to the clock when no Boros leg carries an open.
  //
  // A user-set clock is an explicit assertion about when the position started,
  // and the server honours it over every leg open, so the mean must step aside
  // or the rate would annualize over a window the PnL above it never used.
  let openWeightUsd = 0;
  let openWeightedSec = 0;
  if (s.clockBasis !== 'custom') {
    for (const l of s.legs) {
      if (l.kind !== 'boros') continue;
      // Mirror the server, which falls an unknown open back to the clock rather
      // than dropping the leg out of the window entirely.
      openWeightUsd += l.notionalUsd;
      openWeightedSec += l.notionalUsd * (l.openedAt ?? s.clockStartSec ?? 0);
    }
  }
  const lifeSeconds =
    s.clockStartSec === null
      ? null
      : s.maturity - (openWeightUsd > 0 ? openWeightedSec / openWeightUsd : s.clockStartSec);
  const fixedAprOnCapital =
    lifeSeconds !== null && lifeSeconds > 0 && s.capitalUsd > 0 && expectedUsd !== null
      ? expectedUsd / (s.capitalUsd * (lifeSeconds / SECONDS_IN_YEAR))
      : null;

  // One venue leg can now belong to several strategies, so the executions a
  // user un-ticked are remembered per STRATEGY rather than per maturity. The
  // old entries can't be carried over — applied to every strategy of the same
  // maturity they would hand the same cost back twice — so they lapse, and the
  // card says so instead of quietly re-charging.
  /**
   * The server's HEDGE-SHAPE warnings are dropped here, and only those.
   *
   * Each one restates something the card now says structurally: which legs are
   * missing (a dimmed row per absent leg), how far a leg is from the leg it
   * offsets (`short` / `over by` on the row), and whether the book has a Boros
   * side at all (the banner). Left in, they repeat the table back to the reader
   * as prose they then have to pair up with the rows — which is what the amber
   * block was.
   *
   * Everything else the server warns about STAYS: stale funding ledgers,
   * unknown entry slippage, unpriceable collateral zones, missing trade
   * history, fill-history outages, pinned attribution. None of those have a
   * row or a chip to live on, and several of them qualify numbers the card
   * shows as if they were exact — they are the warnings that still matter.
   */
  const isHedgeShapeWarning = (w: string) =>
    /legs are imbalanced by/.test(w) ||
    /perp found for .* in the connected Gate account/.test(w) ||
    /No matching perp legs for .* in the connected Gate account/.test(w) ||
    /No Boros legs in this .* position/.test(w) ||
    // "This X position holds the legs you assigned to it…" — the card already
    // says so structurally: the SplitChip reads "grouped by you" and each row
    // states its own membership. A card should not need a paragraph to explain
    // what it is showing.
    /position holds the legs you assigned to it/.test(w);
  const serverNotes = s.warnings.filter((w) => !isHedgeShapeWarning(w));
  const cardNotes =
    entryParts.length > 0 && hasLapsedLegacyExclusions()
      ? [
          ...serverNotes,
          'Executions you previously left out were reset — positions can now be split per strategy, and an old exclusion no longer says which one it belonged to.',
        ]
      : serverNotes;

  const perpLegs = s.legs.filter((l) => l.kind === 'perp');
  const borosLegs = s.legs.filter((l) => l.kind === 'boros');
  // Title venues — shared with the destination picker, so a position is named
  // the same wherever it appears.
  const { long: longVenue, short: shortVenue } = positionVenues(s);
  const venueForSide = (side: 'LONG' | 'SHORT'): string | null =>
    side === 'LONG' ? longVenue : shortVenue;

  // Sizing gate: while the 4-leg book is still being BUILT — a Boros leg
  // unmatched, the perp pair lopsided, or the two layers sized apart — the
  // headline numbers would be confidently wrong (a full-life spread projection
  // on half the notional reads as a great trade). Hide the title spread, APR,
  // Capital and PNL by maturity, and show how to COMPLETE the hedge instead.
  // Current PnL stays: real cash + MtM, whatever the book's shape. Thresholds
  // mirror src/core/boros/returns.ts (the server computes the verdict; these
  // only pick which cue lines to show).
  const checks = s.hedgeChecks;
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const hedgeCues: string[] = [];
  // When BOTH perp legs lag their Boros legs, one pair trade closes the gap —
  // sized to the SMALLER deficit, the largest top-up that overshoots neither
  // leg (a one-sided gap is a single order's job, not a pair's). Fuels the
  // "Execute a pair" CTA in the sizing note.
  let pairTopUpUsd: number | null = null;
  if (!checks.fullyHedged) {
    const sideSum = (kind: 'perp' | 'boros', side: 'LONG' | 'SHORT'): number =>
      s.legs
        .filter((l) => l.kind === kind && l.side === side)
        .reduce((sum, l) => sum + l.notionalUsd, 0);
    const bLong = sideSum('boros', 'LONG');
    const bShort = sideSum('boros', 'SHORT');
    const pLong = sideSum('perp', 'LONG');
    const pShort = sideSum('perp', 'SHORT');
    const grossBoros = bLong + bShort;
    const grossPerp = pLong + pShort;
    // ⚠ Every cue in this block is a claim that a Boros leg is MISSING. With
    // no address tracked we never looked, so none of them may be made.
    if (!(checks.borosMatchRatio > 0.9) && !borosUnknown) {
      if (grossBoros === 0) {
        // Both sides missing, not one — and there is no Boros size to quote a
        // top-up against, so the perp book sizes it. Mirrors the perp cue below.
        hedgeCues.push(
          `No Boros legs yet — lock the rate on both sides (~${fmtUsd(grossPerp / 2, 0)} each).`,
        );
      } else if (bLong === 0 || bShort === 0) {
        const missing = bLong === 0 ? 'pay-fixed (LONG)' : 'receive-fixed (SHORT)';
        hedgeCues.push(
          `Boros ${missing} leg is missing — lock ~${fmtUsd(Math.max(bLong, bShort), 0)} on the other side of the spread.`,
        );
      } else {
        const smaller = bLong < bShort ? 'LONG' : 'SHORT';
        hedgeCues.push(
          `Boros legs are ${pct(checks.borosMatchRatio)} matched — add ~${fmtUsd(Math.abs(bLong - bShort), 0)} to the ${smaller} side.`,
        );
      }
    }
    if (!(checks.perpMatchRatio > 0.9)) {
      if (perpSource === null) {
        hedgeCues.push('Connect the Gate account to verify the perp side of the hedge.');
      } else if (grossPerp === 0) {
        hedgeCues.push(
          `No perp legs yet — hedge the floating side (~${fmtUsd(grossBoros / 2, 0)} per side).`,
        );
      } else if (pLong === 0 || pShort === 0) {
        const side = pLong === 0 ? 'LONG' : 'SHORT';
        const venue = venueForSide(side);
        hedgeCues.push(
          `Perp ${side} leg is missing — open ~${fmtUsd(Math.max(pLong, pShort), 0)}${venue ? ` on ${venue}` : ''}.`,
        );
      } else {
        const smaller = pLong < pShort ? 'LONG' : 'SHORT';
        const venue = venueForSide(smaller);
        hedgeCues.push(
          `Perp legs are ${pct(checks.perpMatchRatio)} matched — open ~${fmtUsd(Math.abs(pLong - pShort), 0)} more ${smaller}${venue ? ` on ${venue}` : ''}.`,
        );
      }
    }
    if (!(checks.borosVsPerpRatio > 0.8) && perpSource !== null && grossPerp > 0) {
      if (grossPerp < grossBoros) {
        // Per-LEG deficits, never one aggregate number: each perp leg's target
        // is the Boros leg at its OWN venue (that is the floating rate it
        // cancels), so "how much more to open" is answered per venue+side.
        const deficits = borosLegs
          .map((b) => ({
            venue: b.venue,
            side: b.side,
            missingUsd:
              b.notionalUsd -
              perpLegs.filter((p) => p.venue === b.venue).reduce((s, p) => s + p.notionalUsd, 0),
          }))
          .filter((d) => d.missingUsd >= 1);
        if (deficits.some((d) => d.side === 'LONG') && deficits.some((d) => d.side === 'SHORT')) {
          pairTopUpUsd = Math.min(...deficits.map((d) => d.missingUsd));
        }
        hedgeCues.push(
          `The perp book is ${pct(checks.borosVsPerpRatio)} of the Boros book — open ` +
            (deficits.length
              ? deficits
                  .map((d) => `~${fmtUsd(d.missingUsd, 0)} more ${d.side} on ${d.venue}`)
                  .join(' and ')
              : `~${fmtUsd(grossBoros - grossPerp, 0)} more of perp notional`) +
            '.',
        );
      } else {
        hedgeCues.push(
          `The Boros book is ${pct(checks.borosVsPerpRatio)} of the perp book — add ~${fmtUsd(grossPerp - grossBoros, 0)} of Boros notional.`,
        );
      }
    }
  }
  /**
   * Which of the four card shapes this is. The legs are BUILDING BLOCKS; a
   * position is what they add up to, and only a COMPLETE one is measured.
   *
   *  - `complete`  — every leg present and sized; the headline numbers mean
   *                  something.
   *  - `mismatched`— all four legs open in the right directions, but the sizes
   *                  disagree. Only the matched part is hedged, so the rate is
   *                  still not locked; the per-leg markers say how far off.
   *  - `partial`   — one or more legs are absent. Say exactly which, and how
   *                  big, so the book can be finished.
   *  - `orphan`    — a single leg that pairs with nothing. Nothing is
   *                  "missing" from it: it is not a half-built strategy, so it
   *                  gets no completion cues, only assign-or-close.
   *
   * Ordering matters: `orphan` is tested before `partial` because a lone leg
   * would otherwise be reported as a position missing three others.
   */
  const legSideSum = (kind: 'perp' | 'boros', side: 'LONG' | 'SHORT'): number =>
    s.legs
      .filter((l) => l.kind === kind && l.side === side)
      .reduce((sum, l) => sum + l.notionalUsd, 0);
  const cardState: 'complete' | 'mismatched' | 'partial' | 'orphan' = checks.fullyHedged
    ? 'complete'
    : s.legs.length <= 1
      ? 'orphan'
      : // Every side that a 4-leg book needs is present; only the sizes differ.
        legSideSum('perp', 'LONG') > 0 &&
          legSideSum('perp', 'SHORT') > 0 &&
          legSideSum('boros', 'LONG') > 0 &&
          legSideSum('boros', 'SHORT') > 0
        ? 'mismatched'
        : 'partial';

  /**
   * Per-leg imbalance, as a number rather than a sentence.
   *
   * A leg's target is the leg it is meant to cancel: a perp's target is the
   * Boros leg at its OWN venue (that is the floating rate it offsets), and a
   * Boros leg's target is the opposite Boros side. Reported in the leg's own
   * token unit, because "short 1.53 ETH" is actionable in a way that "71%
   * matched" is not.
   *
   * `null` when the leg is within tolerance — the row then says nothing, which
   * is what keeps the clean rows clean.
   */
  const legImbalanceUsd = (l: StrategyLeg): number | null => {
    const target =
      l.kind === 'perp'
        ? borosLegs
            .filter((b) => b.venue === l.venue)
            .reduce((sum, b) => sum + b.notionalUsd, 0)
        : legSideSum('boros', l.side === 'LONG' ? 'SHORT' : 'LONG');
    if (target <= 0) return null;
    const delta = l.notionalUsd - target;
    // Same 10% band the server's match ratios use, so a leg the engine counts
    // as matched never gets flagged here.
    return Math.abs(delta) / target > 0.1 ? delta : null;
  };

  /**
   * A leg's bottom line BEFORE costs — the one definition of "Net" the card
   * uses, so the word means the same thing in the table and in the hero.
   *
   * The engine's `netUsd` is fee-inclusive, and differently so per kind: a
   * perp nets `cashFlow − fees`, a Boros leg `cashFlow + mtm + tradePnl` where
   * `tradePnl` already has its fees baked in and `cashFlow` already has the
   * settlement fee taken out. Reading those two as one column is what made
   * "net" ambiguous. Here every cost is added back and shown once, in Costs.
   *
   * Trade fees on the Boros side stay inside `tradePnl`: the venue reports the
   * fill net, so they cannot be separated without re-deriving from raw txns.
   * They are small relative to settlement and are disclosed in Costs.
   */
  const legNetBeforeCostsUsd = (l: StrategyLeg): number =>
    l.kind === 'perp'
      ? l.cashFlowUsd
      : l.netUsd + (l.settlementFeePaidUsd ?? 0);

  /** The plain return behind Fixed APY: same numerator, same denominator, just
   * not annualized. Null wherever the APY is null, so they appear together. */
  const roi =
    s.capitalUsd > 0 && expectedUsd !== null ? expectedUsd / s.capitalUsd : null;

  const hiddenStat = (
    <span className="num text-ink-400" title="Hidden until the position is fully hedged — see the sizing note below">
      —
    </span>
  );
  const borosNotionalPerSide = borosLegs.reduce((sum, l) => sum + l.notionalUsd, 0) / 2;
  const matured = isMatured(s);
  /** No Boros legs, so nothing here has an end date — see `isMatured`. */
  const openEnded = s.maturity <= 0;
  const borosOnly = perpLegs.length === 0 && perpSource !== null;
  // Share is offered only where the card itself shows the headline numbers: a
  // fully hedged, unmatured book with a knowable APR. The payload snapshots
  // the DISPLAYED values (post-applyCostFlags), so the link says what the
  // sharer saw. Everything present-tense on the card ("I'm getting") would lie
  // about a matured book, hence the gate.
  const canShare =
    s.hedge === 'hedged' &&
    checks.fullyHedged &&
    !matured &&
    fixedAprOnCapital !== null &&
    expectedUsd !== null;

  // Content-based row keys: expanded-row state must follow the LEG, not its
  // index (a leg set change between refetches would silently remap indexes).
  // Perp legs include the exact symbol so two same-venue same-side positions
  // (e.g. USDT + USDC quotes) can never swap identities on a feed reorder.
  const keyCounts = new Map<string, number>();
  const openRows: LegRow[] = s.legs.map((l) => {
    const base = `${l.kind}:${l.venue}:${l.side}${l.symbol ? `:${l.symbol}` : ''}`;
    const n = keyCounts.get(base) ?? 0;
    keyCounts.set(base, n + 1);
    return { ...l, _key: n === 0 ? base : `${base}:${n}` };
  });

  /**
   * The legs a complete book needs but this one does not have, as rows.
   *
   * A strategy is four legs: a perp and a Boros leg on each of two venues,
   * opposite sides. Anything absent from that grid is stated as its own dimmed
   * row — where the leg WOULD be — rather than described in a paragraph under
   * the table. A row can say "Boros LONG on Binance, about $12,311, not open"
   * in the same shape as the legs beside it; prose has to re-describe the
   * table in words and leaves the reader to match them up.
   *
   * Sized from the leg it would offset: the Boros leg at that venue for a perp,
   * the opposite Boros side for a Boros leg. Only emitted when the venue is
   * known — with no perp legs and no Boros legs there is no grid to complete,
   * and an orphan gets none of this by construction (`cardState`).
   */
  /**
   * The perp leg on the far side of this one, when the pair is genuinely a
   * hedge (both perp sides present and this book is fully hedged).
   *
   * Closing one side of a delta-neutral pair stops the funding cancelling and
   * leaves the other leg running directionally — a position the user did not
   * choose to put on. Only offered when there IS something to un-hedge: on a
   * half-built or already-lopsided book the row-level close is how the user
   * fixes it, and the warning would be noise.
   */
  const hedgedSiblingOf = (leg: StrategyLeg): { venue: string; side: 'LONG' | 'SHORT' } | null => {
    if (leg.kind !== 'perp' || !checks.fullyHedged) return null;
    const far = perpLegs.find((o) => o.side !== leg.side && o.venue !== leg.venue);
    return far ? { venue: far.venue, side: far.side } : null;
  };

  const missingRows: MissingLegRow[] =
    // ⚠ A missing row asserts the leg is NOT open, and offers to open it. With
    // no address tracked we never looked for the Boros legs, so the grid shows
    // the perps alone rather than two rows claiming an absence.
    cardState === 'complete' || cardState === 'orphan' || borosUnknown
      ? []
      : (['LONG', 'SHORT'] as const).flatMap((side) => {
          const venue = venueForSide(side);
          if (!venue) return [];
          return (['perp', 'boros'] as const).flatMap((kind) => {
            const present = s.legs.some((l) => l.kind === kind && l.side === side);
            if (present) return [];
            // The counterpart that sets this leg's size: for a perp, the Boros
            // leg at the same venue; for a Boros leg, the opposite Boros side.
            const targetUsd =
              kind === 'perp'
                ? s.legs
                    .filter((l) => l.kind === 'boros' && l.venue === venue)
                    .reduce((sum, l) => sum + l.notionalUsd, 0)
                : legSideSum('boros', side === 'LONG' ? 'SHORT' : 'LONG') ||
                  legSideSum('perp', side);
            if (targetUsd <= 0) return [];

            /**
             * The exact size in token terms, read off the leg that SETS it.
             *
             * That is the same leg `targetUsd` above uses, and it differs by
             * kind: a missing PERP is sized by the Boros leg at its OWN venue
             * (the floating rate it offsets), a missing BOROS leg by the Boros
             * leg on the other side (a pair shares its collateral, so the
             * number copies across with no price in the middle).
             *
             * ⚠ This used to require a twin of the SAME KIND, which for a perp
             * row meant another PERP — and a card with both Boros legs and no
             * perps (exactly the card that needs this CTA) has none. `twin`
             * came back undefined, so the row carried no token size and the
             * ticket fell back to USD on a BTC-collateral market.
             *
             * The unit is only usable when it IS the base coin: a HYPE market
             * margined in USDT reports a USDT quantity, which is not a base
             * quantity and must not be offered as one. The caller checks that
             * against `s.base`, so the honest thing here is to report the unit
             * as it actually is.
             */
            const sizer =
              kind === 'perp'
                ? s.legs.find(
                    (l) =>
                      l.kind === 'boros' &&
                      l.venue === venue &&
                      l.notionalToken !== undefined,
                  )
                : s.legs.find(
                    (l) =>
                      l.kind === 'boros' &&
                      l.side !== side &&
                      l.notionalToken !== undefined,
                  );
            // Last resort for a card with no Boros leg at all: the opposite
            // perp, which is already denominated in the base coin.
            const twin =
              sizer ??
              s.legs.find(
                (l) => l.kind === 'perp' && l.side !== side && l.notionalToken !== undefined,
              );
            const targetToken = twin?.notionalToken;
            const targetUnit = twin
              ? twin.kind === 'boros'
                ? twin.collateral
                : twin.base
              : undefined;
            return [
              {
                _key: `missing:${kind}:${venue}:${side}`,
                kind,
                venue,
                side,
                targetUsd,
                targetToken,
                targetUnit,
              },
            ];
          });
        });

  const columns: Column<TableRow>[] = [
    {
      key: 'leg',
      header: 'Leg',
      render: (r) => {
        // Venue, kind and side are ONE identity ("the Binance Boros long").
        // Split across three columns they read as unrelated facts, and the eye
        // has to reassemble them on every row.
        const head = (
          <>
            <VenueChip exchange={r.venue} crossex={r.kind === 'perp' && perpSource === 'connected-gate-account'} />
            <span
              className="text-[10px] uppercase tracking-wider text-ink-500"
              title={r.kind === 'perp' ? 'Perp position from your connected Gate account' : 'Boros position from the entered address'}
            >
              {r.kind === 'perp' ? 'perp' : 'Boros'}
            </span>
            <SideChip side={r.side} />
          </>
        );
        if (isMissing(r)) {
          return (
            <span className="inline-flex items-center gap-2 opacity-60">
              {head}
              <Chip sm tone="red" title="This leg is part of the strategy but is not open">
                missing
              </Chip>
            </span>
          );
        }
        const delta = legImbalanceUsd(r);
        const token = legTokenSize(r);
        // The gap in the leg's own unit where there is one, dollars otherwise:
        // "short 1.53 ETH" is actionable in a way that "71% matched" is not.
        const gapText =
          delta === null
            ? null
            : token && r.notionalUsd > 0
              ? fmtTokenQty(Math.abs(delta) * (token.qty / r.notionalUsd), token.symbol)
              : fmtUsdCompact(Math.abs(delta));
        return (
          <span className="inline-flex items-center gap-2">
            {head}
            {/* Unverifiable is not the same as unhedged: without the Gate
                account the perp side cannot be seen at all, so the row says so
                in neutral tone rather than accusing the leg of being wrong. */}
            {r.kind === 'perp' && perpSource === null && (
              <Chip sm tone="neutral" title="Connect the Gate account to verify the perp side of the hedge">
                unverified
              </Chip>
            )}
            {delta !== null && (
              <Chip
                sm
                tone={delta < 0 ? 'amber' : 'cyan'}
                title={
                  delta < 0
                    ? 'Smaller than the leg it offsets — the difference is unhedged'
                    : 'Larger than the leg it offsets — the excess is unhedged'
                }
              >
                {delta < 0 ? 'short' : 'over by'} {gapText}
              </Chip>
            )}
          </span>
        );
      },
    },
    {
      key: 'notional',
      header: 'Notional',
      align: 'right',
      render: (r) => {
        if (isMissing(r)) {
          return (
            <span
              className="num text-ink-500"
              title="The size this leg would need to be, taken from the leg it offsets"
            >
              ≈{fmtUsdCompact(r.targetUsd)}
              {r.targetToken !== undefined && r.targetUnit && (
                <span className="text-ink-600"> ({fmtTokenQty(r.targetToken, r.targetUnit)})</span>
              )}
            </span>
          );
        }
        const token = legTokenSize(r);
        return (
          <span
            className="num"
            title={`${fmtUsd(r.notionalUsd, 0)}${token ? ` = ${sig(token.qty)} ${token.symbol}` : ''}`}
          >
            {fmtUsdCompact(r.notionalUsd)}
            {token && (
              <span className="text-ink-400"> ({fmtTokenQty(token.qty, token.symbol)})</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      render: (r) => {
        const ref = isMissing(r) ? null : legRefOf(r);
        // The SERVER's reconciled rate first — every claim on an asserted leg
        // gets one, including sibling cards that asserted nothing themselves
        // (they carry the balancing figure). The local override is only the
        // fallback for the instant between the click and the refetch.
        const asserted =
          !isMissing(r) && r.venueEntry !== undefined && r.entryApr !== undefined
            ? r.entryApr
            : ref
              ? (entryOverrides?.(ref) ?? null)
              : null;
        return !isMissing(r) && r.kind === 'boros' && (r.entryApr !== undefined || asserted !== null) ? (
          // The LOCKED rate only. The live mark used to sit beside it behind an
          // arrow, which read as a rate that had moved — but the whole point of
          // this leg is that its rate cannot move. The mark still matters for
          // MtM, so it stays in the expanded row where it is about valuation.
          //
          // A rate the USER asserted is shown dotted, never silently swapped in
          // for the venue's: the number the venue reports is still the number
          // the venue reports, and a reader has to be able to tell which they
          // are looking at.
          <span
            className={asserted !== null ? 'num border-b border-dashed border-cyan-500/50 text-cyan-200' : 'num'}
            title={
              asserted !== null
                ? // `r.entryApr` is this CLAIM's rate once anyone asserts, so
                  // comparing against it printed the user's own number back at
                  // them as the venue's. `venueEntry` is the venue's own blend.
                  `This position's share locked ${fmtPct(asserted)}${
                    r.venueEntry !== undefined
                      ? ` — ${r.venue} reports ${fmtPct(r.venueEntry)} blended across every position holding it`
                      : ''
                  }`
                : 'The fixed APR this leg locked at entry — it does not change'
            }
          >
            {fmtPct(asserted ?? (r.entryApr as number))}
          </span>
        ) : !isMissing(r) && r.kind === 'perp' ? (
          <span className="text-xs text-ink-600" title="A perp pays the floating rate — there is nothing locked on this leg">
            floating
          </span>
        ) : (
          <span className="text-ink-600">—</span>
        );
      },
    },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
      render: (r) =>
        isMissing(r) ? (
          <span className="text-ink-600">—</span>
        ) : (
          <span
            title={
              r.kind === 'perp'
                ? 'Funding since the strategy start, before trading fees and slippage'
                : 'Settlements + rate MtM + trade P&L, with settlement fees added back — before costs'
            }
          >
            <SignedNumber
              value={legNetBeforeCostsUsd(r)}
              format={(n) => fmtUsd(n)}
              className="font-medium"
            />
          </span>
        ),
    },
    {
      key: 'belongs',
      header: 'Manual adjustment',
      align: 'right',
      render: (r) => {
        if (isMissing(r)) return <span className="text-[10px] text-ink-600">not open</span>;
        // Stated in the leg's OWN UNIT, and editable from the row.
        //
        // This used to read "51% of leg", which is not a quantity anyone holds
        // — you hold 50k YU, and the other 50k is somewhere else. A percentage
        // also cannot be typed back in: to move size you have to know the
        // venue total and do the arithmetic yourself. Amounts can.
        return (
          <LegAssignment
            leg={r}
            strategyId={s.strategyId}
            destinations={destinations}
            onAssert={onAssert}
            // This claim's CURRENT entry — the server's reconciled figure once
            // anyone has divided the leg, so the dialog opens on what this
            // portion is actually worth rather than blank. The local store is
            // only the fallback between the click and the refetch.
            entryOverride={
              (!isMissing(r) && r.venueEntry !== undefined
                ? r.kind === 'boros'
                  ? (r.entryApr ?? null)
                  : (r.entryPrice ?? null)
                : null) ??
              ((ref: LegRef | null) => (ref ? (entryOverrides?.(ref) ?? null) : null))(legRefOf(r))
            }
            // The VENUE's own blended entry over the whole position — what an
            // override divides up. The live perp position carries it for a
            // perp; a Boros leg's own `entryApr` is already the venue's.
            venueEntry={
              // `venueEntry` when present — once anyone asserts, this leg's own
              // entryApr/entryPrice is a per-claim figure and dividing it again
              // would compound the correction. Otherwise the two are the same
              // number and the venue's live/leg value is right.
              r.venueEntry ??
              (r.kind === 'perp'
                ? (() => {
                    const live = liveFor(r, livePositions);
                    const px = live ? Number(live.entryPrice) : Number.NaN;
                    return Number.isFinite(px) && px > 0 ? px : null;
                  })()
                : (r.entryApr ?? null))
            }
          />
        );
      },
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) => {
        // A missing leg's action is to open it; the ticket lands sized to
        // the gap this row already displays. Both kinds can be opened from
        // here — a Boros row arms the Boros ticket in SINGLE mode, so it
        // creates the one leg named and not the pair.
        if (isMissing(r)) {
          if (matured) return null;
          if (r.kind === 'perp') {
            // ONE row, ONE leg: this arms the SINGLE perp ticket. Routing it
            // through the pair ticket offered to open two legs on a position
            // that is short exactly one — the same mistake the Boros side made
            // before it grew a single mode.
            /**
             * No CrossEx perp at this venue ⇒ no button.
             *
             * A Boros venue with no perp listing (Lighter today) cannot be
             * hedged from this terminal at all. Offering "Open" there would
             * arm a ticket that can never resolve a symbol — a dead click that
             * says nothing, which is worse than the row simply stating that
             * the leg is not open.
             */
            if (!crossexVenueFor(r.venue)) return null;
            return onOpenPerpLeg ? (
              <button
                type="button"
                className="btn-ghost-xs !text-cyan-300"
                title={`Prefills the single perp ticket at ${fmtUsd(r.targetUsd, 0)} on ${r.venue}`}
                onClick={() => onOpenPerpLeg(s, r)}
              >
                Open
              </button>
            ) : null;
          }
          return onOpenBorosLegs ? (
            <button
              type="button"
              className="btn-ghost-xs !text-cyan-300"
              title={`Prefills the Boros ticket with this one ${r.venue} leg at ${fmtUsd(r.targetUsd, 0)}`}
              onClick={() =>
                onOpenBorosLegs(s, {
                  side: r.side,
                  sizeUsd: r.targetUsd,
                  /**
                   * A Boros row's `targetToken` is the twin's COLLATERAL
                   * quantity, and the ticket reads `sizeBase` as a BASE-COIN
                   * one. Those are the same number only when the market is
                   * margined in its own base coin, so it travels only then —
                   * a HYPE market's USDT figure sent as a base quantity would
                   * be a size wrong by the HYPE price.
                   */
                  sizeBase:
                    r.targetUnit && r.targetUnit.toUpperCase() === s.base.toUpperCase()
                      ? r.targetToken
                      : undefined,
                })
              }
            >
              Open
            </button>
          ) : null;
        }
        // Closing a leg is a row-level action, so it belongs on the row. It
        // used to live only inside the expanded detail, which meant closing a
        // single leg required discovering that rows expand at all.
        // A Boros leg closes through its own venue's ticket: Boros has no close
        // primitive, so the ticket's "Close" intent sends an opposite-direction
        // order sized to the position. The row hands over its market id rather
        // than making the user find it again in two dropdowns.
        if (r.kind === 'boros') {
          return r.marketId !== undefined && !matured ? (
            <button
              type="button"
              className="btn-ghost-xs"
              title={`Close this ${r.venue} Boros leg`}
              onClick={() => setClosingBoros([r])}
            >
              Close
            </button>
          ) : null;
        }
        const live = liveFor(r, livePositions);
        return live ? (
          <PositionRowActions
            position={live}
            // Only when this strategy owns part of the venue leg: the close
            // acts on the whole position, so the popover has to open on THIS
            // position's size, not the venue's.
            attributedQty={(r.share ?? 1) < 0.999 ? r.notionalToken : undefined}
            hedgedSibling={hedgedSiblingOf(r)}
            // …and the claim has to come down by what was closed, or the row
            // goes on asserting a size this card no longer holds.
            onClosed={(qty) => {
              const ref = legRefOf(r);
              if (ref) onAssert?.({ mode: 'closed', leg: ref, qty });
            }}
            closeOnly
          />
        ) : null;
      },
    },
  ];

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Identity, in three descending weights: WHAT · WHERE · WHEN. The
            venue pair reads as one unit rather than "long X short Y" — that
            phrasing named the PERP sides only, while the same card's Boros
            legs can both be long, so it stated something the table below it
            contradicted. Maturity is here, in words, instead of surviving as a
            9px axis label under the timeline: it is a decision input. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* The boxed asset badge from the Opportunities tab, so the same coin
              is recognisable as the same object on both screens. Format and
              hierarchy stay ours; only the styling is borrowed. */}
          <span
            className="num flex h-6 w-6 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[9px] font-semibold leading-none text-ink-300"
            title={`${s.base} funding rate`}
          >
            {s.base}
          </span>
          {(longVenue || shortVenue) && (
            <>
              <span className="text-ink-600">·</span>
              <span className="text-sm font-medium text-ink-200">
                {prettyVenue(longVenue ?? shortVenue ?? '')}
                {longVenue && shortVenue && (
                  <>
                    <span className="mx-1 font-normal text-ink-500">⇄</span>
                    {prettyVenue(shortVenue)}
                  </>
                )}
              </span>
            </>
          )}
          {!openEnded && (
            <>
              <span className="text-ink-600">·</span>
              <span className="text-xs text-ink-300">
                {matured ? 'matured' : 'matures'} {fmtDateUtc(s.maturity)}
                {!matured && (
                  <span className="text-ink-400"> · {fmtAge(s.secondsToMaturity * 1000)} left</span>
                )}
              </span>
            </>
          )}
          <SplitChip s={s} />
          <HedgeChip s={s} />
        </div>
        {/* Right rail: the card's ACTIONS. The badges that describe the
            position moved left onto the title, where the thing they describe
            is — leaving this side for what you can DO, so the cost-assumption
            control has a home that is not a whole empty row of its own. */}
        <div className="flex items-center gap-2">
          {cardState !== 'orphan' && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] font-medium text-ink-300 transition-colors hover:border-ink-500 hover:text-ink-100"
              onClick={() => setCostOpen(true)}
              title="How this position is charged for perp entry and exit — changes every number on this card"
            >
              <span aria-hidden>⚙</span>
              Costs
              {(entryMode !== 'include' ||
                exitMode !== 'close' ||
                chargedPartCount < entryParts.length) && (
                <span className="text-cyan-300" title="A non-default assumption is in force">
                  ·
                </span>
              )}
            </button>
          )}
          {canShare && (
            <button
              type="button"
              title="Share this position — a public link + image; your wallet address is not included"
              onClick={() =>
                setSharePayload(
                  buildSharePayload({
                    s,
                    fixedAprOnCapital,
                    expectedUsd,
                    flags,
                    nowSec: Math.floor(Date.now() / 1000),
                  }),
                )
              }
              className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-200"
            >
              Share ↗
            </button>
          )}
        </div>
      </div>

      <Notes items={cardNotes} className="mt-2" />

      {/* Cues for incomplete/matured states. */}
      {borosOnly && !matured && onOpenPerpLegs && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary !py-1 !px-3 text-sm" onClick={() => onOpenPerpLegs(s)}>
            Open the perp legs →
          </button>
          <span className="text-xs text-ink-500">
            prefills the pair ticket with the opposite floating exposure
          </span>
        </div>
      )}
      {/* The mirror of the cue above: both perps are on, and the Boros side
          that would lock their rate is missing. The card knows the venues and
          the size, so it hands them to the Boros ticket rather than leaving
          the user to rebuild that from the missing-leg rows one at a time. */}
      {/* Nothing tracked: the card offers the one action that can change that,
          in the slot the "Open the Boros legs" cue occupies on a tracked card.
          It is not a trade — it is the missing input that would let us answer
          whether these perps are hedged at all. */}
      {borosUnknown && borosUnknownCta && (
        <div className="mt-2 flex flex-wrap items-center gap-2">{borosUnknownCta}</div>
      )}
      {!borosUnknown && perpLegs.length === 2 && borosLegs.length === 0 && !matured && onOpenBorosLegs && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary !py-1 !px-3 text-sm"
            onClick={() => onOpenBorosLegs(s)}
          >
            Open the Boros legs →
          </button>
          <span className="text-xs text-ink-500">
            prefills the Boros ticket to lock the rate these perps are paying
          </span>
        </div>
      )}
      {matured && perpLegs.length > 0 && (
        <div className="mt-2 text-xs leading-relaxed text-amber-400/90">
          The Boros legs have matured — close the perp legs (expand a perp row → Close) to realize
          the locked return.
        </div>
      )}
      {/* Strategy timeline: start → now → maturity, as a full-width bar. */}
      {s.elapsedSeconds !== null && s.elapsedSeconds + s.secondsToMaturity > 0 && (
        <div
          className="relative mt-3 pt-3.5"
          data-progress="maturity"
          title={`${fmtAge(s.elapsedSeconds * 1000)} elapsed · ${openEnded ? 'no maturity' : matured ? 'matured' : `${fmtAge(s.secondsToMaturity * 1000)} left`}`}
        >
          {(() => {
            const pct = Math.min(
              100,
              (s.elapsedSeconds / (s.elapsedSeconds + s.secondsToMaturity)) * 100,
            );
            return (
              <>
                <div
                  className="absolute top-0 -translate-x-1/2 text-[9px] leading-none text-cyan-300"
                  style={{ left: `${Math.min(96, Math.max(4, pct))}%` }}
                >
                  now
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-cyan-400/70"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div
                  aria-hidden
                  className="absolute mt-[-9px] h-3 w-0.5 -translate-x-1/2 rounded bg-cyan-300"
                  style={{ left: `${pct}%` }}
                />
                <div className="mt-0.5 flex justify-between gap-4 text-[9px] text-ink-500">
                  <span className="flex flex-col gap-0.5">
                    <span className="num" title="Strategy start (the clock basis)">
                      {s.clockStartSec !== null ? fmtDateLocal(s.clockStartSec) : 'start'}
                    </span>
                    <TimelineClockEdit since={since} basis={s.clockBasis} onChange={onChangeSince} />
                  </span>
                  <span
                    className="num"
                    title={openEnded ? 'Only the Boros legs mature; this position has none' : 'Boros maturity'}
                  >
                    {openEnded
                      ? 'no maturity'
                      : matured
                        ? `matured ${fmtDateUtc(s.maturity)}`
                        : `matures ${fmtDateUtc(s.maturity)} · ${fmtAge(s.secondsToMaturity * 1000)} left`}
                  </span>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Tier 1 — the hero numbers and (when open) the waterfalls share ONE
          bordered box. The stats surface and the "see more/less" strip both
          toggle; the strip stays the box's bottom edge, so open order is
          stats → waterfalls → "see less". */}
      <div className="mt-3 overflow-hidden rounded-lg border border-cyan-500/40 transition-colors hover:border-cyan-400/70">
        <button
          type="button"
          aria-expanded={chartsOpen}
          title={chartsOpen ? 'Hide the waterfall breakdown' : 'Show the waterfall breakdown'}
          onClick={() => setChartsOpen((v) => !v)}
          className="block w-full text-left"
        >
          <div className="p-3">
            {/* Slot 4, in TWO tiers.
             *
             * MAIN — Fixed APY, PnL now, Capital: what it earns, what it has
             * made, what it ties up. SUPPLEMENTARY — the maturity projection,
             * the locked spread and ROI — ride underneath as captions, because
             * each one qualifies a main number rather than standing alone.
             *
             * PnL now is AFTER costs: it is the figure the account actually
             * reflects. "Net (before costs)" was a main number here and should
             * not have been — it is an intermediate step on the way to this
             * one, so it moved into the caption where its arithmetic is.
             *
             * The gate is unchanged: a figure describing a FINISHED position
             * appears only on a finished one; PnL now is the exception, being
             * real cash and value whatever shape the book is in.
             */}
            {/* An orphan has ONE number, so it gets one line rather than the
                three-slot grid with two empty columns — a single figure under a
                hero-height label left most of the card blank and made a lone leg
                look like a position missing its numbers. Label and value sit on
                the same baseline, sized to what it is: an unplaced leg. */}
            <div
              className={
                cardState === 'orphan'
                  ? 'flex flex-wrap items-baseline gap-x-3'
                  : 'flex flex-wrap items-start gap-x-12 gap-y-4'
              }
            >
              {/* An ORPHAN never gets an APY: it is one leg, not a strategy, so
                  there is no spread to lock and no capital base to divide by. */}
              {cardState !== 'orphan' && (
              <div>
                <div className={microLabelClass}>{matured ? 'Fixed APY (realized)' : 'Fixed APY'}</div>
                <div className="mt-0.5 text-3xl font-semibold">
                  {!checks.fullyHedged ? (
                    hiddenStat
                  ) : fixedAprOnCapital === null ? (
                    <span className="num text-ink-400" title="The strategy start or capital is unknown — no APR">
                      —
                    </span>
                  ) : (
                    <span title="The PnL expected by maturity as a return on the capital this strategy posts, annualized over the full trade life (start → maturity). Net of every cost, and it follows the perp cost assumptions in settings.">
                      <SignedNumber value={fixedAprOnCapital} format={(n) => fmtPct(n)} />
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-500">
                  {checks.fullyHedged ? (
                    <>
                      <span
                        className="num"
                        title={
                          s.spreadReturnUsd !== null
                            ? `Assumes ${fmtPct(s.spread)} locked on ${fmtUsdCompact(borosNotionalPerSide)}, each leg accruing from its own open date → spread return ≈${fmtUsd(s.spreadReturnUsd, 0)} by maturity`
                            : 'Locked fixed spread across the Boros legs'
                        }
                      >
                        {fmtPct(s.spread)} spread
                      </span>
                      {roi !== null && (
                        <span
                          className="num"
                          title={`The same expected PnL as a plain return on capital over this position's life${
                            lifeSeconds !== null ? ` (${fmtAge(lifeSeconds * 1000)})` : ''
                          } — Fixed APY is this figure annualized.`}
                        >
                          {fmtPct(roi)} ROI
                        </span>
                      )}
                    </>
                  ) : (
                    <span>appears once every leg is in place</span>
                  )}
                </div>
              </div>
              )}

              <div className={cardState === 'orphan' ? 'flex items-baseline gap-2' : undefined}>
                <div className={microLabelClass}>PnL now</div>
                <div className={cardState === 'orphan' ? 'text-xl font-semibold' : 'mt-0.5 text-3xl font-semibold'}>
                  <span title="What this position has actually made so far — funding, Boros settlements and rate MtM, net of the trading fees and slippage it has been charged.">
                    <SignedNumber value={currentNetUsd} format={(n) => fmtUsd(n, 0)} />
                  </span>
                </div>
              </div>

              {/* PnL at maturity is a MAIN number, and a gated one.
               *
               * It is the figure the whole trade is FOR — what the locked spread
               * pays out by the end — so it belongs beside what the position has
               * made so far, not in small type underneath it. But it only means
               * something once every leg is placed: on a half-built book there is
               * no locked spread to project, so the number would be an
               * extrapolation from a hedge that does not exist yet. */}
              {checks.fullyHedged && (
              <div>
                <div className={microLabelClass}>
                  {matured ? 'PnL (realized)' : 'PnL at maturity'}
                </div>
                <div className="mt-0.5 text-3xl font-semibold">
                  {expectedUsd === null ? (
                    <span className="num text-ink-400" title="The strategy start is unknown — no projection">
                      —
                    </span>
                  ) : (
                    <span title="The PnL this position is projected to end with at maturity, net of every cost">
                      <SignedNumber value={expectedUsd} format={(n) => fmtUsd(n, 0)} />
                    </span>
                  )}
                </div>
              </div>
              )}

              {/* Capital is a MAIN number: it is the denominator every return on
                  this card divides by, and the amount actually at work. */}
              {cardState !== 'orphan' && (
              <div>
                <div className={microLabelClass}>Capital</div>
                <div className="mt-0.5 text-3xl font-semibold">
                  {!checks.fullyHedged ? (
                    hiddenStat
                  ) : (
                    <span className="num text-ink-100" title="The capital this strategy posts">
                      {fmtUsd(s.capitalUsd, 0)}
                    </span>
                  )}
                </div>
              </div>
              )}
            </div>
          </div>
        </button>

        {!checks.fullyHedged && (
          <div
            data-card-state={cardState}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3 py-2 text-[12px] ${
              cardState === 'orphan'
                ? 'border-ink-700 bg-ink-800/40'
                : 'border-amber-500/20 bg-amber-500/5'
            }`}
          >
            {/* One line, not a paragraph. What each leg needs is stated ON the
                leg's own row — the match percentages and per-leg cue list that
                used to live here re-described the table in prose and left the
                reader to pair the sentences back up with the rows. */}
            <Chip sm tone={cardState === 'orphan' ? 'neutral' : 'amber'}>
              {cardState === 'orphan'
                ? 'Orphan leg'
                : cardState === 'mismatched'
                  ? 'Sizes don’t match'
                  : 'Incomplete position'}
            </Chip>
            <span className="text-ink-400">
              {cardState === 'orphan'
                ? 'Not part of any position. Assign it below, or close it.'
                : cardState === 'mismatched'
                  ? 'Every leg is open in the right direction, but only the matched part is hedged.'
                  : borosUnknown
                    ? // Nothing tracked ⇒ we never looked. Say what we know —
                      // the perps are here — without claiming the user holds
                      // no Boros legs.
                      'Track a Boros address to see whether these perps have a locked rate.'
                    : borosLegs.length === 0
                      ? // A perp pair with no Boros side at all: the funding is
                        // floating, and saying "once every leg is in place"
                        // would imply the missing legs are a formality rather
                        // than the whole trade.
                        'No Boros legs yet — the funding is floating, so there is no locked rate to show.'
                      : 'Rate, capital and ROI appear once every leg is in place.'}
            </span>
            {cardState !== 'orphan' && pairTopUpUsd !== null && !matured && onOpenPerpLegs && (
              <button
                type="button"
                className="btn-ghost-xs ml-auto !text-cyan-300"
                title={`Prefills the pair ticket at ${fmtUsd(pairTopUpUsd, 0)} per leg on this strategy's venues — the largest top-up that overshoots neither leg.`}
                onClick={() => onOpenPerpLegs(s, pairTopUpUsd ?? undefined)}
              >
                Complete the hedge →
              </button>
            )}
          </div>
        )}

        {/* The waterfalls uncollapse INSIDE the box, between the stats and
            the strip. */}
        {chartsOpen && (
          <div className="px-3 pb-2">
            <ProfitBars
              spreadReturnUsd={s.spreadReturnUsd}
              profitUsd={expectedUsd}
              // "now" is the CURRENT NET — the exit toggle only shapes the
              // TARGET (those are future costs, not money already made or
              // lost), but the entry toggle moves this line too: an omitted
              // entry cost is money this strategy never spent.
              mtmUsd={currentNetUsd}
              legs={s.legs}
              fees={s.feesUsd}
              flags={flags}
              entryAddBack={{ feesUsd: entryAddBackFeesUsd, slippageUsd: entryAddBackSlippageUsd }}
            />
          </div>
        )}

        {/* The inviting strip at the bottom of the box. An ORPHAN has no
            spread to decompose and no projection to walk down to, so both
            waterfalls would be empty scaffolding — the strip goes with them. */}
        {cardState !== 'orphan' && (
        <button
          type="button"
          aria-expanded={chartsOpen}
          title={chartsOpen ? 'Hide the waterfall breakdown' : 'Show the waterfall breakdown'}
          onClick={() => setChartsOpen((v) => !v)}
          className="flex w-full items-center justify-center gap-1 border-t border-cyan-500/25 py-1 text-[11px] font-medium text-cyan-300"
        >
          {chartsOpen ? 'see less ▲' : 'see more ▼'}
        </button>
        )}
      </div>

      {costOpen && (
        <Modal
          title={`Cost assumptions — ${s.base}`}
          onClose={() => setCostOpen(false)}
          widthClass="w-[560px]"
        >
          <div className="flex flex-col gap-4 p-4">
      {/* The PER-POSITION cost assumptions — entry first, in the order the
          money is spent (the spread now lives in the card title).

          Hidden on an ORPHAN: both toggles exist to move a by-maturity
          projection, and an orphan has none. Left in, they invited the reader
          to tune the inputs of a number that is not on the card. */}
      {/* One label-and-control row per assumption, each filling the dialog
          width: the label sits left, the control right, so the two rows line up
          as a settings list. This kept `justify-end` from when it lived on the
          card face, which inside a dialog stacked everything against the right
          edge and left the left half empty. */}
      <div className="flex flex-col gap-3">
        <span
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          title={
            'Include: this strategy is charged the perp entry fees and entry slippage it actually paid. Omit (rolled over): the perp legs were rolled into this maturity, so their fees and entry crossing were paid before this strategy started — Gate reports the fee cumulatively and the entry price from the original open, so both would otherwise be billed here. Omitting moves Current PnL as well as the projection.'
          }
        >
          <span className={`${microLabelClass} w-28 shrink-0`}>Perp entry cost</span>
          <SegmentedToggle<EntryCostMode>
            ariaLabel="Perp entry cost"
            value={entryMode}
            onChange={(next) => {
              // The Include segment doubles as the disclosure header: clicking
              // it when it is ALREADY the choice opens/closes the itemisation
              // (a segmented control fires onChange on every click, not just on
              // a change). Arriving from Omit always opens it — you have just
              // chosen to charge the entry cost, so show what that consists of.
              if (next === 'include') setPartsOpen((open) => (entryMode === 'include' ? !open : true));
              setEntryMode(next);
            }}
            options={[
              { value: 'include', label: 'Include' },
              { value: 'omit', label: 'Omit (rolled over)' },
            ]}
          />
          {entryMode === 'include' && (
            <button
              type="button"
              aria-expanded={partsOpen}
              aria-controls={partsId}
              aria-label="Itemise the perp entry cost"
              title="Itemise the perp entry cost — tick only the executions that belong to this position"
              onClick={() => setPartsOpen((v) => !v)}
              className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-200"
            >
              {/* The count carries the state a collapsed card would otherwise
                  hide: one with executions dropped must not look untouched. */}
              {entryParts.length > 0 ? `${chargedPartCount} of ${entryParts.length}` : 'itemise'}{' '}
              <span aria-hidden="true">{partsOpen ? '▴' : '▾'}</span>
            </button>
          )}
        </span>
        <span
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          title={
            'Include: folds this position’s estimated exit costs into its profit numbers — assumes a maker+hedge close (maker on one leg, taker hedge on the other, cheapest assignment) and exit slippage equal to the entry slippage. Omit (rolling over): the perp legs stay open past maturity — no exit costs are charged.'
          }
        >
          <span className={`${microLabelClass} w-28 shrink-0`}>Perp exit cost</span>
          <SegmentedToggle<ExitMode>
            ariaLabel="Perp exit cost"
            value={exitMode}
            onChange={setExitMode}
            options={[
              { value: 'close', label: 'Include' },
              { value: 'roll', label: 'Omit (rolling over)' },
            ]}
          />
        </span>
      </div>

      {entryMode === 'include' && partsOpen && (
        <EntryCostParts
          id={partsId}
          parts={entryParts}
          excluded={excludedPartIds}
          onToggle={toggleEntryPart}
          chargedUsd={chargedEntryUsd}
        />
      )}
          </div>
        </Modal>
      )}

      <div className="mt-3">
        <DataTable
          columns={columns}
          // Open legs first, then the ones the book still needs — the grid a
          // complete strategy would fill, with the gaps stated in place.
          rows={[...openRows, ...missingRows]}
          rowKey={(r) => r._key}
          maxHeightClass="max-h-96"
          rowClassName={(r) => (isMissing(r) ? 'opacity-60' : '')}
          renderExpanded={(r) => {
            // A missing leg has nothing to expand into: no live position, no
            // settlements, and no membership to assert about a leg that is not
            // there. Its row says what it is and offers the way to open it.
            if (isMissing(r)) return null;
            const l = r;
            return (
            <div className="flex flex-col gap-1.5">
              {l.kind === 'boros' && <VenueCancellation legs={s.legs} venue={l.venue} />}
              {l.kind === 'perp' && (
                <PerpLegExpanded
                  position={liveFor(l, livePositions)}
                  // Only when this strategy owns part of the venue leg: the
                  // close acts on the whole position, so the popover has to
                  // open on THIS position's size, not the venue's.
                  attributedQty={(l.share ?? 1) < 0.999 ? l.notionalToken : undefined}
                  hedgedSibling={hedgedSiblingOf(l)}
                  share={l.share ?? 1}
                  // The collapsed row this expands from already carries the
                  // dedicated [Close] (`closeOnly` above), so a second one here
                  // was two buttons for one action. [Lev] has no duplicate.
                  levOnly
                  // The SERVER's number first: once anyone asserts on a leg,
                  // every claim on it gets a reconciled entry, including the
                  // cards that asserted nothing. The local override is only a
                  // fallback for the instant between the click and the refetch.
                  entryOverride={
                    l.entryPrice ??
                    ((ref: LegRef | null) => (ref ? (entryOverrides?.(ref) ?? null) : null))(
                      legRefOf(l),
                    )
                  }
                  venueEntry={l.venueEntry ?? null}
                />
              )}
              {l.kind === 'boros' && (
                <span className="num text-xs text-ink-400">
                  Live floating APR {l.floatingApr !== undefined ? fmtPct(l.floatingApr) : '—'} · opened{' '}
                  {fmtTime(toDate(l.openedAt))}
                  {l.tradePnlUsd !== 0 && (
                    <>
                      {' '}
                      · trade P&L (net) <SignedNumber value={l.tradePnlUsd} format={(n) => fmtUsd(n)} />
                    </>
                  )}
                </span>
              )}
              {l.warnings.map((w) => (
                <span key={w} className="text-xs text-amber-400/90">
                  {w}
                </span>
              ))}
            </div>
            );
          }}
        />
      </div>

      {/* Closing the perp pair as one. Below the legs and right-aligned, where
          the perp-only box carried it: it acts on the rows above it, and in
          the cue stack at the top it read as one more thing to fix rather than
          the card's action. Never on a shared leg — the venue closes the WHOLE
          position, not this card's slice of it.

          This used to be gated to Boros-less cards. The gate was about the
          LEGS IT CLOSES, not about the card: on a 4-leg position the perp pair
          is still exactly two whole venue legs, and closing it is still one
          coherent action — the user just had no way to ask for it, and had to
          find two hover-revealed row buttons instead. The Boros legs are
          deliberately NOT included: they close through a different venue with
          its own flow, so one button cannot honestly promise all four. */}
      {perpLegs.length === 2 &&
        perpLegs.every((l) => l.symbol && (l.share ?? 1) >= 0.999) && (
          // A labelled bar rather than a lone button in the corner: closing is
          // the card's other action, and it was previously reachable only by
          // expanding a row and finding a control that rendered at 40% opacity.
          // A quiet strip, not a red box. Closing is a normal thing to do with
          // a position; the previous bordered rose panel read as a warning
          // about the position rather than an action available on it. The
          // buttons carry the colour, the container does not. Sized to hold
          // Boros close actions alongside these when they exist.
          <div className="-mx-4 mt-3 flex flex-wrap items-center gap-2 border-t border-ink-800 px-4 py-2.5">
            {/* A plain button that OPENS a form, not a hold-to-confirm sitting
                on the card. A destructive control that arms on press-and-hold,
                in the reading path, makes the card feel hazardous to touch;
                behind a click it is available without being underfoot. */}
            <button
              type="button"
              className="btn-ghost-xs !text-rose-300 hover:!border-rose-500/50"
              onClick={() => setCloseOpen(true)}
            >
              Close perp pair
            </button>
            {borosLegs.length > 0 && !matured && (
              <button
                type="button"
                className="btn-ghost-xs !text-rose-300 hover:!border-rose-500/50"
                title="Close this position's Boros legs"
                onClick={() => setClosingBoros(borosLegs)}
              >
                Close Boros legs
              </button>
            )}
            {borosLegs.length > 0 && (
              <span className="text-[11px] text-ink-500">
                each side closes on its own venue
              </span>
            )}
          </div>
        )}

      {closeOpen && (
        <Modal title={`Close ${s.base} — perp pair`} onClose={() => setCloseOpen(false)} widthClass="w-[460px]">
          <div className="flex flex-col gap-3 p-4">
            <div className="text-[12px] leading-relaxed text-ink-300">
              Closes both perp legs as one action, reduce-only at the current mark.
              {borosLegs.length > 0 && ' The Boros legs are not touched — they close on their own venue.'}
            </div>
            <table className="w-full text-[12px]">
              <tbody>
                {perpLegs.map((l) => (
                  <tr key={`${l.venue}:${l.side}:${l.symbol ?? ''}`} className="border-t border-ink-800 first:border-t-0">
                    <td className="py-1.5 text-ink-300">
                      {prettyVenue(l.venue)} <span className="text-ink-500">{l.side}</span>
                    </td>
                    <td className="num py-1.5 text-right text-ink-200">
                      {fmtUsdCompact(l.notionalUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ClosePairForm
              base={s.base}
              legs={perpLegs.map((l) => ({
                symbol: l.symbol as string,
                qty: l.notionalToken ?? 0,
                venue: l.venue,
              }))}
              livePositions={livePositions}
            />
          </div>
        </Modal>
      )}

      {closingBoros.length > 0 && (
        <Modal
          title={`Close ${s.base} — ${closingBoros.length === 1 ? 'Boros leg' : 'Boros legs'}`}
          onClose={() => setClosingBoros([])}
          widthClass="w-[460px]"
        >
          <div className="p-4">
            <CloseBorosForm
              legs={closingBoros}
              onClosed={(leg, filled) => {
                const ref = legRefOf(leg);
                if (ref) onAssert?.({ mode: 'closed', leg: ref, qty: filled });
              }}
              onDone={() => setClosingBoros([])}
            />
          </div>
        </Modal>
      )}

      {!perpSource && (
        <div className="mt-2 text-[10px] text-ink-500">
          Boros legs from the entered address — connect Gate keys to overlay perp legs 1–2
        </div>
      )}

      {sharePayload && (
        <SharePositionModal payload={sharePayload} onClose={() => setSharePayload(null)} />
      )}
    </div>
  );
}
