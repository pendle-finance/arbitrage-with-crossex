/**
 * One 4-leg fixed-return position box. Hierarchy per the revamp:
 *   Tier 1 — Fixed APR on Capital (hero) · Capital · Profit by maturity
 *   Tier 2 — locked-spread line + the spread-lock assumption caption,
 *            ProfitBars (spread return decomposed vs the MtM "now" row) and
 *            the always-visible paid/future fee legend with per-part exit
 *            checkboxes
 *   Legs   — collapsed rows; a perp row expands to live Entry/Mark/Lev +
 *            [Close]/[Lev] (joined to the 4s positions poll by symbol)
 * Purely prop-driven — PositionsHome owns the queries.
 */
import { useState } from 'react';
import type {
  CrossexPosition,
  EntryCostMode,
  ExitMode,
  StrategyLeg,
  StrategyRollup,
} from '../api/types';
import { Chip } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { Notes } from '../components/Notes';
import { SignedNumber } from '../components/SignedNumber';
import { Stat } from '../components/Stat';
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
  num,
  parseSymbol,
  prettyVenue,
  sig,
  toDate,
} from '../lib/fmt';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { TimelineClockEdit } from './HomeControls';
import { CloseBoth } from './PerpOnlyBox';
import { PerpLegExpanded } from './PerpLegExpanded';
import { ProfitBars } from './ProfitBars';
import { EntryCostParts } from './EntryCostParts';
import {
  hasLapsedLegacyExclusions,
  loadExcludedPartIds,
  saveExcludedPartIds,
} from './entryPartsStore';
import {
  LegMembership,
  positionVenues,
  SplitChip,
  type LegAssertion,
  type LegDestination,
} from './PartitionEditor';
import { buildSharePayload } from './sharePayload';
import { SharePositionModal } from './SharePositionModal';
import type { SharePayloadV1 } from '../lib/shareCodec';
import { applyCostFlags, legTokenSize, SECONDS_IN_YEAR, type CostFlags } from './strategyMath';

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
  onAssert,
  destinations,
  bookId = '',
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
  /** Say where one of this position's legs belongs. Absent = the grouping is
   * read-only (the share page, tests that don't wire it). */
  onAssert?: (a: LegAssertion) => void;
  /** Other cards a leg can be sent to. */
  destinations?: readonly LegDestination[];
  /** Which (wallet, Gate account) book this card belongs to — see bookId.ts.
   * Namespaces the excluded entry parts, which are otherwise keyed by a
   * strategyId that says nothing about whose account it is. */
  bookId?: string;
}) {
  const s = strategy;
  // The two waterfalls sit behind the hero boxes / See-more toggle — collapsed
  // by default; the bordered hero box + its "see more" strip invite the click.
  const [chartsOpen, setChartsOpen] = useState(false);
  // Per-position exit assumption: 'close' folds the estimated exit costs in
  // (maker+hedge fees + assumed slippage); 'roll' keeps the perps — no exit
  // costs charged. The profit formula includes future costs, so close is the
  // default.
  const [exitMode, setExitMode] = useState<ExitMode>('close');
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
  const lifeSeconds = s.clockStartSec === null ? null : s.maturity - s.clockStartSec;
  const fixedAprOnCapital =
    lifeSeconds !== null && lifeSeconds > 0 && s.capitalUsd > 0 && expectedUsd !== null
      ? expectedUsd / (s.capitalUsd * (lifeSeconds / SECONDS_IN_YEAR))
      : null;

  // One venue leg can now belong to several strategies, so the executions a
  // user un-ticked are remembered per STRATEGY rather than per maturity. The
  // old entries can't be carried over — applied to every strategy of the same
  // maturity they would hand the same cost back twice — so they lapse, and the
  // card says so instead of quietly re-charging.
  const cardNotes =
    entryParts.length > 0 && hasLapsedLegacyExclusions()
      ? [
          ...s.warnings,
          'Executions you previously left out were reset — positions can now be split per strategy, and an old exclusion no longer says which one it belonged to.',
        ]
      : s.warnings;

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
    if (!(checks.borosMatchRatio > 0.9)) {
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
  const rows: LegRow[] = s.legs.map((l) => {
    const base = `${l.kind}:${l.venue}:${l.side}${l.symbol ? `:${l.symbol}` : ''}`;
    const n = keyCounts.get(base) ?? 0;
    keyCounts.set(base, n + 1);
    return { ...l, _key: n === 0 ? base : `${base}:${n}` };
  });

  const isCrossexPerp = (l: StrategyLeg) =>
    l.kind === 'perp' && perpSource === 'connected-gate-account';

  const columns: Column<LegRow>[] = [
    {
      key: 'leg',
      header: 'Leg',
      render: (l) => (
        <span className="inline-flex items-center gap-2">
          <VenueChip exchange={l.venue} crossex={isCrossexPerp(l)} />
          <span
            className="text-[10px] uppercase tracking-wider text-ink-500"
            title={l.kind === 'perp' ? 'Perp position from your connected Gate account' : 'Boros position from the entered address'}
          >
            {l.kind === 'perp' ? 'perp' : 'Boros'}
          </span>
        </span>
      ),
    },
    { key: 'side', header: 'Side', render: (l) => <SideChip side={l.side} /> },
    {
      key: 'notional',
      header: 'Notional',
      align: 'right',
      render: (l) => {
        const token = legTokenSize(l);
        return (
          <span
            className="num"
            title={`${fmtUsd(l.notionalUsd, 0)}${token ? ` = ${sig(token.qty)} ${token.symbol}` : ''}`}
          >
            {fmtUsdCompact(l.notionalUsd)}
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
      render: (l) =>
        l.kind === 'boros' && l.entryApr !== undefined ? (
          <span className="num" title="entry fixed APR → current mark APR">
            {fmtPct(l.entryApr)}<span className="text-ink-500">→</span>
            {l.markApr !== undefined ? fmtPct(l.markApr) : '—'}
          </span>
        ) : (
          <span className="text-ink-600">—</span>
        ),
    },
    {
      key: 'cash',
      header: 'Cash flow',
      align: 'right',
      render: (l) => (
        <span title={l.kind === 'perp' ? 'Cumulative funding' : 'Funding settlements (net of settlement fees)'}>
          <SignedNumber value={l.cashFlowUsd} format={(n) => fmtUsd(n)} />
        </span>
      ),
    },
    {
      key: 'mtm',
      header: 'MTM',
      align: 'right',
      render: (l) => {
        // Perp rows: LIVE uPnL (4s feed), DISPLAY-ONLY — excluded from Net.
        // The delta-neutral pair's price MtMs cancel to entry-gap noise, which
        // the strategy accounts once as entry slippage. Boros MtM stays in Net.
        if (l.kind === 'perp') {
          const live = liveFor(l, livePositions);
          // Scaled by the leg's share: the live position's uPnL covers the
          // WHOLE venue leg, and rendering it whole on every card that owns a
          // slice double-counts it across the page.
          const value = live ? Number(live.upnl) * (l.share ?? 1) : l.mtmUsd;
          return (
            <span
              className="text-ink-500"
              title="Price MtM (display only — excluded from Net; the pair's uPnLs cancel, accounted as entry slippage)"
            >
              <SignedNumber value={value} format={(n) => num(n)} className="!text-ink-500" />
            </span>
          );
        }
        return <SignedNumber value={l.mtmUsd} format={(n) => num(n)} />;
      },
    },
    {
      key: 'fees',
      header: 'Fees',
      align: 'right',
      render: (l) =>
        l.feesUsd > 0 ? (
          <span className="num text-ink-300">−{fmtUsd(l.feesUsd)}</span>
        ) : (
          <span className="text-ink-600">—</span>
        ),
    },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
      render: (l) => (
        <span
          title={
            l.kind === 'perp'
              ? 'Funding (since the strategy start) − trading fees'
              : 'Settlements + rate MtM + trade P&L (net of fees)'
          }
        >
          <SignedNumber value={l.netUsd} format={(n) => fmtUsd(n)} className="font-medium" />
        </span>
      ),
    },
  ];

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold text-ink-100">{s.base}</span>
          <span className="text-xs text-ink-400">
            {longVenue && (
              <>
                <span className="text-emerald-400">long</span> {prettyVenue(longVenue)}
              </>
            )}
            {longVenue && shortVenue && ' '}
            {shortVenue && (
              <>
                <span className="text-rose-400">short</span> {prettyVenue(shortVenue)}
              </>
            )}
          </span>
          {/* The locked spread only means anything across a MATCHED pair of
              Boros legs: rate_A − rate_B on a common notional. On a half-built
              book the same ratio is an outright fixed rate wearing a spread's
              label — and on a SINGLE Boros leg it reads double that leg's rate
              (returns.ts divides by gross/2, calibrated for two legs). Gate it
              with the other headline numbers rather than print it. */}
          <span
            className={`num text-xs ${checks.fullyHedged ? 'text-ink-300' : 'text-ink-400'}`}
            title={
              !checks.fullyHedged
                ? 'Hidden until the position is fully hedged — a locked spread needs a matched pair of Boros legs; see the sizing note below'
                : s.spreadReturnUsd !== null
                  ? `Assumes ${fmtPct(s.spread)} locked on ${fmtUsdCompact(borosNotionalPerSide)} since the strategy start → spread return ≈${fmtUsd(s.spreadReturnUsd, 0)} by maturity`
                  : 'Locked fixed spread across the Boros legs'
            }
          >
            ({checks.fullyHedged ? fmtPct(s.spread) : '—'} spread)
          </span>
        </div>
        <div className="flex items-center gap-2">
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
          <SplitChip s={s} />
          <HedgeChip s={s} />
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
          <div className="flex flex-wrap items-end gap-x-10 gap-y-3 p-3">
        <Stat label="Fixed APR on capital" hero>
          {!checks.fullyHedged ? (
            hiddenStat
          ) : fixedAprOnCapital === null ? (
            <span className="num text-ink-400" title="The strategy start or capital is unknown — no APR">
              —
            </span>
          ) : (
            <span title="The PnL expected by maturity as a return on the capital this strategy posts, annualized over the full trade life (start → maturity). Net of every cost, and it follows the perp entry and exit cost assumptions below.">
              <SignedNumber value={fixedAprOnCapital} format={(n) => fmtPct(n)} />
            </span>
          )}
        </Stat>
        <Stat label="Capital">
          {!checks.fullyHedged ? (
            hiddenStat
          ) : (
            <span className="num text-ink-100">{fmtUsd(s.capitalUsd, 0)}</span>
          )}
        </Stat>
        <Stat label={matured ? 'PNL (realized at maturity)' : 'PNL by maturity'}>
          {!checks.fullyHedged ? (
            hiddenStat
          ) : expectedUsd === null ? (
            <span className="num text-ink-400" title="The strategy start is unknown — no projection">
              —
            </span>
          ) : (
            <SignedNumber value={expectedUsd} format={(n) => fmtUsd(n, 0)} className="font-medium" />
          )}
        </Stat>
          <Stat label="Current PnL">
            <span
              title={
                flags.inclEntryCost
                  ? 'Funding + Boros settlements & rate MtM − fees − entry slippage — the waterfalls below break it down'
                  : 'Funding + Boros settlements & rate MtM − Boros fees. The perp entry fees and entry slippage are not charged (rolled over) — the waterfalls below break it down'
              }
            >
              <SignedNumber value={currentNetUsd} format={(n) => fmtUsd(n, 0)} className="font-medium" />
            </span>
          </Stat>
          </div>
        </button>

        {!checks.fullyHedged && (
          <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[12px] leading-relaxed text-amber-300/90">
            <span className="font-medium">Position not fully hedged — numbers appear once the book is complete.</span>{' '}
            Boros legs {pct(checks.borosMatchRatio)} matched · perp legs {pct(checks.perpMatchRatio)} matched ·
            Boros↔perp sizing {pct(checks.borosVsPerpRatio)}.
            {hedgeCues.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {hedgeCues.map((cue) => (
                  <li key={cue}>{cue}</li>
                ))}
              </ul>
            )}
            {pairTopUpUsd !== null && !matured && onOpenPerpLegs && (
              <button
                type="button"
                className="btn-primary mt-2 !py-1 !px-3 text-sm"
                title={`Prefills the pair ticket at ${fmtUsd(pairTopUpUsd, 0)} per leg on this strategy's venues — the largest top-up that overshoots neither leg. Any residual single-leg gap keeps its cue above.`}
                onClick={() => onOpenPerpLegs(s, pairTopUpUsd ?? undefined)}
              >
                Execute a pair to complete the hedge →
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

        {/* The inviting strip at the bottom of the box. */}
        <button
          type="button"
          aria-expanded={chartsOpen}
          title={chartsOpen ? 'Hide the waterfall breakdown' : 'Show the waterfall breakdown'}
          onClick={() => setChartsOpen((v) => !v)}
          className="flex w-full items-center justify-center gap-1 border-t border-cyan-500/25 py-1 text-[11px] font-medium text-cyan-300"
        >
          {chartsOpen ? 'see less ▲' : 'see more ▼'}
        </button>
      </div>

      {/* The PER-POSITION cost assumptions — entry first, in the order the
          money is spent (the spread now lives in the card title). */}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <span
          className="flex items-center gap-1.5"
          title={
            'Include: this strategy is charged the perp entry fees and entry slippage it actually paid. Omit (rolled over): the perp legs were rolled into this maturity, so their fees and entry crossing were paid before this strategy started — Gate reports the fee cumulatively and the entry price from the original open, so both would otherwise be billed here. Omitting moves Current PnL as well as the projection.'
          }
        >
          <span className={microLabelClass}>Perp entry cost</span>
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
          className="flex items-center gap-1.5"
          title={
            'Include: folds this position’s estimated exit costs into its profit numbers — assumes a maker+hedge close (maker on one leg, taker hedge on the other, cheapest assignment) and exit slippage equal to the entry slippage. Omit (rolling over): the perp legs stay open past maturity — no exit costs are charged.'
          }
        >
          <span className={microLabelClass}>Perp exit cost</span>
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

      <div className="mt-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(l) => l._key}
          maxHeightClass="max-h-96"
          renderExpanded={(l) => (
            <div className="flex flex-col gap-1.5">
              {l.kind === 'boros' && <VenueCancellation legs={s.legs} venue={l.venue} />}
              {l.kind === 'perp' && (
                <PerpLegExpanded
                  position={liveFor(l, livePositions)}
                  // Only when this strategy owns part of the venue leg: the
                  // close acts on the whole position, so the popover has to
                  // open on THIS position's size, not the venue's.
                  attributedQty={(l.share ?? 1) < 0.999 ? l.notionalToken : undefined}
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
              {/* Where this leg belongs, asked about the leg it is about. */}
              <LegMembership s={s} leg={l} destinations={destinations} onAssert={onAssert} />
            </div>
          )}
        />
      </div>

      {/* A Boros-less pair owning both venue legs whole can be closed as one.
          Below the legs and right-aligned, where the perp-only box carried it:
          it acts on the rows above it, and in the cue stack at the top it read
          as one more thing to fix rather than the card's action. Never on a
          shared leg — the venue closes the WHOLE position, not this card's
          slice of it. */}
      {borosLegs.length === 0 &&
        perpLegs.length === 2 &&
        perpLegs.every((l) => l.symbol && (l.share ?? 1) >= 0.999) && (
          <div className="mt-2 flex justify-end">
            <CloseBoth
              base={s.base}
              legs={perpLegs.map((l) => ({ symbol: l.symbol as string, qty: l.notionalToken ?? 0 }))}
            />
          </div>
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
