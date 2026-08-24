/**
 * Forward-looking fixed-return opportunities — one collapsible card per viable
 * Boros PAIR (a group with three markets offers three of them), best APR first,
 * narrowed by the facet bar above the list.
 *   Collapsed — an identity band (asset, the two venue legs, warning chips)
 *               over the net fixed APR ON CAPITAL as the hero (the Positions
 *               view's basis) beside labelled capital / return / notional
 *               stats, Details + Execute.
 *   Expanded  — the four legs the trade opens, the spread it locks, and the
 *               profit + capital waterfalls.
 * Owns the persisted assumptions — notional, Boros entry, perp entry, exit and
 * the simulated VIP tier, each an independent knob — and the single query they
 * drive. Executing only PREFILLS the pair ticket — submission stays behind its
 * hold-to-confirm control.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { amountError } from '../lib/amount';
import {
  isValidOpportunityNotional,
  OPPORTUNITY_NOTIONAL_MAX,
  OPPORTUNITY_NOTIONAL_MIN,
  OPPORTUNITY_FEE_TIERS,
  useOpportunities,
  type OpportunityFeeTier,
} from '../api/queries';
import type {
  BorosEntryMode,
  EntryMode,
  ExitMode,
  OpportunityGroup,
  OpportunityPair,
} from '../api/types';
import { Chip, type ChipTone } from '../components/Chip';
import { EmptyState } from '../components/EmptyState';
import { Notes } from '../components/Notes';
import { QueryError } from '../components/QueryError';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { Skeleton } from '../components/Skeleton';
import { microLabelClass } from '../components/Th';
import { SideVenue } from '../components/VenueChip';
import { borosMarketUrl, isUsdCollateral } from '../lib/boros';
import {
  fmtAge,
  fmtDateUtc,
  fmtNotionalShort,
  fmtPct,
  fmtTokenQty,
  fmtUsd,
  prettyVenue,
  sig,
} from '../lib/fmt';
import { readJson, writeJson } from '../lib/storage';
import { useDebounced } from '../lib/useDebounced';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { StrategyFreshness } from './HomeControls';
import { OpportunityFilterBar } from './OpportunityFilterBar';
import { canChartCapital, canChartProfit, OpportunityWaterfall } from './OpportunityWaterfall';
import {
  applyFilters,
  hasActiveFilter,
  loadFilters,
  NO_FILTERS,
  saveFilters,
  toRows,
  type OpportunityFilters,
} from './opportunityFilters';

export const OPPORTUNITIES_STORAGE_KEY = 'crossex.opportunities.v2';

/** v1 coupled the notional to the Boros entry mode ('market-100k'); v2 splits
 * them into two independent knobs, so v1 blobs are migrated once and dropped. */
const LEGACY_STORAGE_KEY = 'crossex.opportunities.v1';

/** The notional every card is priced at: three presets or a typed size. */
type NotionalChoice = '10k' | '100k' | '500k' | 'custom';

const NOTIONAL_PRESETS: Record<Exclude<NotionalChoice, 'custom'>, number> = {
  '10k': 10_000,
  '100k': 100_000,
  '500k': 500_000,
};

const NOTIONAL_OPTIONS: { value: NotionalChoice; label: string }[] = [
  { value: '10k', label: '$10k' },
  { value: '100k', label: '$100k' },
  { value: '500k', label: '$500k' },
  { value: 'custom', label: 'Custom…' },
];

const BOROS_ENTRY_OPTIONS: { value: BorosEntryMode; label: string }[] = [
  { value: 'mark', label: 'At mark rate' },
  { value: 'market', label: 'Market at size' },
];

const ENTRY_MODE_LABEL: Record<EntryMode, string> = {
  'both-market': '2 market orders',
  'maker-hedge': 'Limit + hedge',
};

const EXIT_MODE_LABEL: Record<ExitMode, string> = {
  close: 'Close positions',
  roll: 'Roll over',
};

/** Long-form forms of the same knobs — the buttons are terse, the summary line
 * and the empty state read as sentences. */
const ENTRY_MODE_PROSE: Record<EntryMode, string> = {
  'both-market': 'both legs market',
  'maker-hedge': 'limit + hedge',
};

const EXIT_MODE_PROSE: Record<ExitMode, string> = {
  close: 'close at maturity',
  roll: 'roll over',
};

const BOROS_ENTRY_PROSE: Record<BorosEntryMode, string> = {
  mark: 'at mark rate',
  market: 'market at size',
};

export interface StoredControls {
  notionalChoice: NotionalChoice;
  /** The size behind "Custom…" (USD). */
  customNotionalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** Simulated Gate CrossEx VIP fee tier — only sent while unconfigured. */
  feeTier: OpportunityFeeTier;
}

const DEFAULTS: StoredControls = {
  notionalChoice: '10k',
  customNotionalUsd: 10_000,
  borosEntry: 'market',
  entryMode: 'both-market',
  // 'roll' by default — see StrategyCard: an assumed exit cost is a decision
  // the user has not made yet, and it understates every quote.
  exitMode: 'roll',
  feeTier: 'vip0',
};

/** 'vip3' → 'VIP 3'. */
const feeTierLabel = (t: OpportunityFeeTier) => `VIP ${t.slice(3)}`;

const validEntryMode = (v: unknown): EntryMode =>
  v === 'both-market' || v === 'maker-hedge' ? v : DEFAULTS.entryMode;

const validExitMode = (v: unknown): ExitMode =>
  v === 'close' || v === 'roll' ? v : DEFAULTS.exitMode;

const validFeeTier = (v: unknown): OpportunityFeeTier =>
  (OPPORTUNITY_FEE_TIERS as readonly unknown[]).includes(v)
    ? (v as OpportunityFeeTier)
    : DEFAULTS.feeTier;

const validSize = (v: unknown): number =>
  typeof v === 'number' && isValidOpportunityNotional(v) ? v : DEFAULTS.customNotionalUsd;

/** A preset-sized custom size reads back as that preset, so a v1 user lands on
 * the same button they left. */
const snapToPreset = (usd: number): NotionalChoice =>
  (Object.entries(NOTIONAL_PRESETS).find(([, n]) => n === usd)?.[0] as NotionalChoice | undefined) ??
  'custom';

/** v1 → v2: split the coupled `choice` into {notionalChoice, borosEntry}. */
function migrateLegacy(): StoredControls | null {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (raw === null) return null;
  const p = JSON.parse(raw) as
    | { choice?: unknown; customSize?: unknown; entryMode?: unknown; exitMode?: unknown; feeTier?: unknown }
    | null;
  const size = validSize(p?.customSize);
  const choice = p?.choice;
  return {
    notionalChoice:
      choice === 'market-10k'
        ? '10k'
        : choice === 'market-100k'
          ? '100k'
          : choice === 'market-500k'
            ? '500k'
            : // 'mark' and 'market-custom' both carried their size in customSize.
              snapToPreset(size),
    customNotionalUsd: size,
    borosEntry: choice === 'mark' ? 'mark' : 'market',
    entryMode: validEntryMode(p?.entryMode),
    exitMode: validExitMode(p?.exitMode),
    feeTier: validFeeTier(p?.feeTier),
  };
}

/** Read the persisted controls; anything corrupt falls back to its default. */
export function loadControls(base: StoredControls = DEFAULTS): StoredControls {
  try {
    if (localStorage.getItem(OPPORTUNITIES_STORAGE_KEY) === null) {
      const migrated = migrateLegacy();
      if (migrated) {
        writeJson(OPPORTUNITIES_STORAGE_KEY, migrated);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
    }
  } catch {
    /* best-effort: an unreadable v1 blob just leaves the v2 read below */
  }
  return readJson<StoredControls>(OPPORTUNITIES_STORAGE_KEY, base, (parsed) => {
    const p = parsed as
      | {
          notionalChoice?: unknown;
          customNotionalUsd?: unknown;
          borosEntry?: unknown;
          entryMode?: unknown;
          exitMode?: unknown;
          feeTier?: unknown;
        }
      | null;
    return {
      notionalChoice: NOTIONAL_OPTIONS.some((o) => o.value === p?.notionalChoice)
        ? (p?.notionalChoice as NotionalChoice)
        : base.notionalChoice,
      customNotionalUsd:
        typeof p?.customNotionalUsd === 'number' && isValidOpportunityNotional(p.customNotionalUsd)
          ? p.customNotionalUsd
          : base.customNotionalUsd,
      borosEntry:
        p?.borosEntry === 'mark' || p?.borosEntry === 'market' ? p.borosEntry : base.borosEntry,
      entryMode:
        p?.entryMode === 'both-market' || p?.entryMode === 'maker-hedge'
          ? p.entryMode
          : base.entryMode,
      exitMode: p?.exitMode === 'close' || p?.exitMode === 'roll' ? p.exitMode : base.exitMode,
      feeTier: validFeeTier(p?.feeTier),
    };
  });
}

/** The value when it is a real number, else null. Covers a key that is ABSENT
 * as well as one that is explicitly null: the API response is cast, not
 * validated, and `fmtUsd(undefined)` prints the literal string "undefined". */
const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Missing number → an em dash carrying the reason, never "NaN". */
function Dash({ why }: { why: string }) {
  return (
    <span className="num text-ink-500" title={why}>
      —
    </span>
  );
}

/** One labelled figure of the collapsed card's stat row. Label over value puts
 * every card's CAPITAL / RETURN / NOTIONAL at the same x, so a column of cards
 * reads as a table — the inline sentence it replaces couldn't line up. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex flex-col gap-1">
      <span className={microLabelClass}>{label}</span>
      <span className="num text-sm leading-none text-ink-100">{children}</span>
    </span>
  );
}

interface CardChip {
  key: string;
  label: string;
  title: string;
  /** Warnings stay amber (the default); informational chips mute to neutral. */
  tone?: ChipTone;
}

/** The one sentence a thin Boros book puts on every number it nulls. */
const THIN_BOOK_WHY = "The Boros books can't lock this size — no net APR is quoted";

/**
 * Warning chips for one card, derived only from the pair's own field status.
 * The server's warnings are full prose sentences, not codes — they read as the
 * notes they are, in the hero's title, never squeezed into an inline badge.
 */
function cardChips(pair: OpportunityPair): CardChip[] {
  const chips: CardChip[] = [];
  if (pair.execSpreadApr === null) {
    chips.push({ key: 'thin', label: 'thin book', title: THIN_BOOK_WHY });
  }
  if (pair.costs.totalUsd === null) {
    chips.push({
      key: 'costs',
      label: 'costs incomplete',
      title: 'Some perp cost components are unknown — the profit waterfall can’t close',
    });
  }
  for (const [side, leg] of [
    ['short', pair.shortLeg],
    ['long', pair.longLeg],
  ] as const) {
    if (!leg.crossexSymbol) {
      chips.push({
        key: `sym:${side}`,
        label: `no CX symbol · ${leg.venue}`,
        title: `${leg.venue} lists no CrossEx perp for ${leg.base} — that leg won't prefill`,
      });
    }
  }
  return chips;
}

/** The one sentence every null capital number carries. */
const CAPITAL_WHY =
  "The capital can't be modelled — a leg's locked rate, a Boros margin input, or a venue's max leverage is missing; see the pair's notes";

/** The hero's title: same wording as the Positions card, plus what "capital"
 * means for a trade that isn't open yet. */
const CAPITAL_APR_TITLE =
  'Locked fixed spread annualized on the capital this strategy consumes. Capital here is MODELLED — the minimum this trade would post: Boros initial margin on both legs plus perp initial margin at each venue’s max leverage.';

/** One "$10k · Short ETH · BYBIT · <note>" row of the 4-leg explainer. The four
 * cells are a fragment so the parent grid keeps both rows aligned. */
function LegRow({
  notionalUsd,
  collateral,
  side,
  label,
  venue,
  note,
  href,
}: {
  notionalUsd: number;
  /** Token-margined groups: the same notional in the collateral token. */
  collateral?: { qty: number; symbol: string } | null;
  side: 'short' | 'long';
  label: string;
  venue: string;
  /** Trailing annotation; empty keeps the row's 4th cell in the grid. */
  note: ReactNode;
  /** Link the label out (the Boros legs → the market page, side prefilled). */
  href?: string;
}) {
  return (
    // `sm:contents` hands the four cells back to the parent grid on real
    // screens. Below that the grid's three max-content tracks have a ~270px
    // floor that no phone can pay — it pushed the page body sideways — so the
    // row becomes a plain wrapping line instead.
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 sm:contents">
      <span className="num justify-self-start rounded-md border border-cyan-500/30 bg-cyan-500/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-cyan-300/85">
        {fmtNotionalShort(notionalUsd)}
        {collateral ? ` (${fmtTokenQty(collateral.qty, collateral.symbol)})` : ''}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={`Open this market on Boros with the ${side} side prefilled`}
          className={`num text-xs font-medium underline decoration-current/40 underline-offset-2 transition-opacity hover:opacity-80 ${
            side === 'short' ? 'text-rose-400' : 'text-emerald-400'
          }`}
        >
          <span>{label}</span>{' '}
          <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <span
          className={`num text-xs font-medium ${side === 'short' ? 'text-rose-400' : 'text-emerald-400'}`}
        >
          {label}
        </span>
      )}
      <span className="num justify-self-start rounded-md border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-300">
        {venue}
      </span>
      <span className="text-[11.5px] text-ink-300">{note}</span>
    </div>
  );
}

const OpportunityCard = memo(function OpportunityCard({
  group,
  pair,
  notionalUsd,
  onOpenStrategy,
  unconfigured,
}: {
  /** The cohort the pair belongs to — collateral, maturity, underlying. */
  group: OpportunityGroup;
  /** THE trade this card is about. One group serves several: every viable venue
   * combination in it is its own card. */
  pair: OpportunityPair;
  /** The notional the RESPONSE priced — the waterfall converts APRs with it. */
  notionalUsd: number;
  /** Opens the guided 2-step wizard for this pair — Boros rate legs first,
   * then the perp hedge. null when there is no trade-flow provider (the
   * landing build); the button then explains itself. `sizeBase` sizes the
   * legs in the Boros collateral when that IS the base coin, so all four
   * match without an eyeballed conversion. */
  onOpenStrategy:
    | ((pair: OpportunityPair, maturitySec: number, sizeBase?: number) => void)
    | null;
  /** First-run view: symbols are expectedly absent, so the CTA stays enabled
   * and clicking it nudges the setup guide instead of dead-ending. */
  unconfigured: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chips = cardChips(pair);
  // Only the PAIR's own reasons — they explain this card's own numbers. The
  // group's warnings are about the other markets in the cohort ("… has no
  // CrossEx perp venue"), and those rows stopped being displayed with the
  // markets table.
  const reasons = [...new Set(pair.reasons)];
  const base = pair.base || group.underlying;
  const capitalApr = pair.netFixedAprOnCapital;
  const capitalUsd = finite(pair.capitalUsd);
  const estProfitUsd = finite(pair.estProfitUsd);
  // A resting maker leg or an extrapolated book still prices a number, so these
  // caveats have no dash to hang off — without a chip they would be invisible.
  if (capitalApr !== null && reasons.length > 0) {
    chips.push({ key: 'caveats', label: 'caveats', title: reasons.join('\n'), tone: 'neutral' });
  }
  // Costs can swallow the whole spread — the server ranks those groups last but
  // still serves them, so a loss must never wear the profit colour.
  const netNegative = capitalApr !== null && capitalApr < 0;
  const netTone = netNegative ? 'text-rose-400' : 'text-emerald-400';
  const days = Math.max(1, Math.round(group.secondsToMaturity / 86_400));
  const maturityTitle = `Matures ${fmtDateUtc(group.maturity)} UTC · ${fmtAge(group.secondsToMaturity * 1000)} left`;
  // Token-margined groups also size in the collateral token — bracket the
  // notional with that amount (USDT groups stay pure-dollar).
  // ⚠ USDC counts as dollars too — testing `!== 'USDT'` alone handed a
  // USDC-collateral group a token quantity, which then armed both tickets in
  // "base" units for a market whose size is already dollars.
  const collateralQty =
    !isUsdCollateral(group.collateral) &&
    group.collateralPriceUsd !== null &&
    group.collateralPriceUsd > 0
      ? { qty: notionalUsd / group.collateralPriceUsd, symbol: group.collateral }
      : null;
  // Both legs unmapped ⇒ the ticket would arm nothing; one missing is fine (it
  // leaves that leg unselected by design). Fungible groups can collapse two
  // different assets, and the ticket only takes one base.
  const basesDiffer = pair.shortLeg.base !== pair.longLeg.base;
  const noSymbols = !pair.shortLeg.crossexSymbol && !pair.longLeg.crossexSymbol;
  const executeDisabled = (noSymbols && !unconfigured) || basesDiffer || onOpenStrategy === null;
  const executeTitle = basesDiffer
    ? `The legs trade different assets (${pair.shortLeg.base} vs ${pair.longLeg.base}) — the pair ticket takes one base`
    : unconfigured
      ? 'Add your Gate API key in the setup guide on the right — clicking walks you through the legs'
      : noSymbols
        ? `Neither ${pair.shortLeg.venue} nor ${pair.longLeg.venue} lists a CrossEx perp for ${pair.base}`
        : 'Opens this strategy step by step — lock the Boros rate first, then hedge with the perps. You confirm each order yourself.';
  const detailsDisabled =
    !canChartProfit(pair) && !canChartCapital(pair) && pair.execSpreadApr === null;
  const detailsTitle = detailsDisabled
    ? 'This pair prices neither a spread nor a capital stack — there is nothing to break down'
    : undefined;
  const chartable = canChartProfit(pair) || canChartCapital(pair);

  // The whole card toggles the details, not just the Details button — but never
  // when the click was really for a control inside it, or was a text selection
  // (copying the APR must not collapse the card). Keyboard users get the same
  // toggle through the Details button's aria-expanded.
  const toggleFromCard = (e: MouseEvent<HTMLDivElement>) => {
    if (detailsDisabled) return;
    if ((e.target as HTMLElement).closest('button, a, input, select')) return;
    if (window.getSelection()?.toString()) return;
    setOpen((v) => !v);
  };

  return (
    <div
      // overflow-hidden lets the identity band's darker ground clip cleanly at
      // the card's rounded corners.
      className={`card overflow-hidden ${detailsDisabled ? '' : 'cursor-pointer transition-colors hover:border-ink-600'}`}
      onClick={toggleFromCard}
    >
      {/* Identity band — WHAT the trade is, before how much it pays: ticker,
          the two legs, warnings pushed right. Its darker ground and hairline
          give the list a ledger rhythm and keep warnings out of the hero's
          way. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-ink-800 bg-ink-950/40 px-4 py-2">
        <span
          className="num text-[13px] font-semibold tracking-wide text-ink-100"
          title={`${base} funding rate`}
        >
          {base}
        </span>
        <SideVenue side="SHORT" venue={pair.shortLeg.venue} />
        <SideVenue side="LONG" venue={pair.longLeg.venue} />
        {chips.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <Chip key={c.key} sm tone={c.tone ?? 'amber'} title={c.title}>
                {c.label}
              </Chip>
            ))}
          </span>
        )}
      </div>

      <div className="p-4">
        {/* Stacked on phones: the shrink-0 action column is 184px, which left
            the APR hero and the stat row ~112px to fight over and spilling.
            items-CENTER, not items-end: the action column runs ~22px taller
            than the figures (two buttons over their caption), and ending them
            together dropped that whole gap above the APR, which read as a
            bloated top margin on every card. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          {/* Hero + stats share one baseline (items-end): the APR leads, the
              labelled figures columnize across cards. */}
          <div className="flex min-w-0 flex-wrap items-end gap-x-7 gap-y-3">
            {/* basis-full below 2xl: the hero takes its own row and the stats
                a second one, so every card keeps the same shape at the same
                viewport. The switch must hang on the VIEWPORT, never on fit:
                token-margined groups render "$10k (4.16 ETH)" where USDT ones
                render "$10k", and a fit-driven wrap breaks only those cards,
                stranding Notional on a ragged second line while the USDT card
                above it stays whole. 2xl, not xl: the content column is the
                viewport less ~400px of rail chrome, and at xl that leaves ~848
                inside the card for a row that wants ~851 with the token
                bracket — three pixels short, which is how the ragged wrap got
                in. (The expanded section's two-column grid stays at xl; its
                leg boxes fit where this row does not.) The min-width then
                starts every card's stat columns at the same x, however wide
                its APR. */}
            <span className="flex basis-full items-baseline gap-2 2xl:basis-auto 2xl:min-w-[15rem]">
              {capitalApr === null || !Number.isFinite(capitalApr) ? (
                <span
                  className="num text-3xl font-bold leading-none tracking-tight text-ink-400"
                  title={reasons.length > 0 ? reasons.join('\n') : CAPITAL_WHY}
                >
                  —% APR
                </span>
              ) : (
                <span
                  className={`num text-3xl font-bold leading-none tracking-tight ${
                    capitalApr < 0 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                  title={
                    reasons.length > 0
                      ? `${CAPITAL_APR_TITLE}\n\n${reasons.join('\n')}`
                      : CAPITAL_APR_TITLE
                  }
                >
                  {(capitalApr * 100).toFixed(1)}% APR
                </span>
              )}
              <span className="text-[13px] text-ink-300" title={maturityTitle}>
                ({days} {days === 1 ? 'day' : 'days'})
              </span>
            </span>

            <Stat label="Capital">
              {capitalUsd === null ? (
                <Dash why={CAPITAL_WHY} />
              ) : (
                <span title="The modelled minimum this trade posts across the four legs — expand for the breakdown">
                  ~{fmtUsd(capitalUsd, 0)}
                </span>
              )}
            </Stat>
            <Stat label="Return">
              {estProfitUsd === null ? (
                <Dash why="No net APR — nothing to project" />
              ) : (
                <span
                  className={estProfitUsd < 0 ? 'text-rose-400' : undefined}
                  title={`Estimated profit by maturity on ${fmtUsd(notionalUsd, 0)} per leg`}
                >
                  {fmtUsd(estProfitUsd, 0)}
                </span>
              )}
            </Stat>
            <Stat label="Notional">
              <span
                className="text-cyan-400/85"
                title={`${fmtUsd(notionalUsd, 0)} per leg${collateralQty ? ` ≈ ${sig(collateralQty.qty)} ${collateralQty.symbol}` : ''}`}
              >
                {fmtNotionalShort(notionalUsd)}
                {collateralQty && (
                  <span className="text-cyan-400/60">
                    {' '}
                    ({fmtTokenQty(collateralQty.qty, collateralQty.symbol)})
                  </span>
                )}
              </span>
            </Stat>
            {/* The net story needs fees/books/leverage; when those are missing
                (Gate down or unconfigured) the raw Boros spread is still the
                headline worth showing — it is what the trade captures. */}
            {pair.netFixedApr === null && Number.isFinite(pair.grossSpreadApr) && (
              <Stat label="Gross spread">
                <span
                  className="text-amber-400"
                  title="midApr(short) − midApr(long) — the raw Boros spread, before execution and costs"
                >
                  {fmtPct(pair.grossSpreadApr, 1)}
                </span>{' '}
                <span className="text-[10px] text-amber-400/80">only</span>
              </Stat>
            )}
          </div>
          {/* The action only. The sequence caption used to stack under the
              buttons here, which made this column ~22px taller than the
              figures beside it and left that much dead band inside the row;
              both it and Details are gone from this row now, so the two sides
              are naturally the same height. */}
          <div className="flex shrink-0 items-center gap-2">
            {/* ONE action: the strategy is two ordered executions, and two
                side-by-side buttons styled primary/secondary read as
                alternatives — the opposite of the truth. The wizard this opens
                states the order (rate legs, then the hedge) as numbered steps
                and hands off to Positions when both are on.

                Details is NOT here: it moved to the footer line below as a
                quiet text link, so this row holds only the action that opens
                a position. */}
            <button
              type="button"
              className="btn btn-primary px-4 font-semibold"
              aria-label={`Open this strategy — ${base} short ${prettyVenue(pair.shortLeg.venue)} / long ${prettyVenue(pair.longLeg.venue)}, ${group.collateral}-margined ${fmtDateUtc(group.maturity)}`}
              disabled={executeDisabled}
              title={executeTitle}
              onClick={() =>
                // Size in the Boros collateral when that IS the base coin, so
                // all four legs match without an eyeballed conversion;
                // USDT-margined cohorts keep the dollar figure.
                pair &&
                onOpenStrategy?.(
                  pair,
                  group.maturity,
                  collateralQty && collateralQty.symbol.toUpperCase() === pair.base.toUpperCase()
                    ? collateralQty.qty
                    : undefined,
                )
              }
            >
              Open this strategy →
            </button>
          </div>
        </div>

        {/* Footer line — the quiet note the card still owes, kept off the
            action row so it costs no band of its own: the expand toggle. */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {/* Details as a dotted-underline text link rather than a second
              button: expanding is the quiet, reversible move and should not
              carry the weight of the one that opens a position. Still a real
              <button> — it owns aria-expanded and must stay keyboard- and
              screen-reader-addressable; only its chrome is gone. */}
          <button
            type="button"
            className="text-xs text-ink-300 underline decoration-ink-400 decoration-dotted decoration-2 underline-offset-4 transition-colors hover:text-ink-100 hover:decoration-ink-200 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 disabled:hover:text-ink-300"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${base} short ${prettyVenue(pair.shortLeg.venue)} / long ${prettyVenue(pair.longLeg.venue)}, ${group.collateral}-margined ${fmtDateUtc(group.maturity)}`}
            disabled={detailsDisabled}
            title={detailsTitle}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide details' : 'More details'}
          </button>
          {/* The "lock the rate first, then hedge" caption that sat here is
              gone with the two buttons it captioned: one CTA now opens the
              whole strategy, and the wizard states that order as numbered
              steps instead of a 10px footnote nobody had to read. */}
        </div>

        {open && (
          // Clicks inside the expanded breakdown must not collapse it — closing
          // is the header's or the Hide-details button's job.
          <div
            className="mt-4 flex cursor-auto flex-col gap-3.5 border-t border-ink-800 pt-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={microLabelClass}>How it works — you open 4 legs</div>
            {/* Two columns only from xl: the content column is the viewport less
                ~400px of chrome (page padding + the 340px trade rail), so at md
                each leg box would be ~175px and the rows below would overflow. */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-ink-700 bg-ink-950 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
                  On CrossEx{' '}
                  <span className="font-normal normal-case tracking-normal text-ink-400">
                    (perp legs)
                  </span>
                </div>
                <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[max-content_max-content_max-content_minmax(0,1fr)] sm:items-center sm:gap-x-2.5 sm:gap-y-1.5">
                  <LegRow
                    notionalUsd={notionalUsd}
                    collateral={collateralQty}
                    side="short"
                    label={`Short ${base}`}
                    venue={pair.shortLeg.crossexVenue || pair.shortLeg.venue}
                    note={
                      pair.capital.shortLeverageMax === null
                        ? ''
                        : `up to ${pair.capital.shortLeverageMax}× leverage`
                    }
                  />
                  <LegRow
                    notionalUsd={notionalUsd}
                    collateral={collateralQty}
                    side="long"
                    label={`Long ${base}`}
                    venue={pair.longLeg.crossexVenue || pair.longLeg.venue}
                    note={
                      pair.capital.longLeverageMax === null
                        ? ''
                        : `up to ${pair.capital.longLeverageMax}× leverage`
                    }
                  />
                </div>
                <div className="text-[11px] leading-relaxed text-ink-300">
                  The terminal opens both legs delta-neutral in one cross-margin account — minimal
                  liquidation risk.
                </div>
              </div>
  
              <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-ink-700 bg-ink-950 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
                  On Boros{' '}
                  <span className="font-normal normal-case tracking-normal text-ink-400">
                    (rate legs)
                  </span>
                </div>
                <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[max-content_max-content_max-content_minmax(0,1fr)] sm:items-center sm:gap-x-2.5 sm:gap-y-1.5">
                  <LegRow
                    notionalUsd={notionalUsd}
                    collateral={collateralQty}
                    side="short"
                    label={`Short ${base} funding`}
                    venue={pair.shortLeg.venue}
                    note={<RateNote midApr={pair.shortLeg.midApr} execApr={pair.shortLeg.execApr} />}
                    href={borosMarketUrl(pair.shortLeg.marketId, 'short')}
                  />
                  <LegRow
                    notionalUsd={notionalUsd}
                    collateral={collateralQty}
                    side="long"
                    label={`Long ${base} funding`}
                    venue={pair.longLeg.venue}
                    note={<RateNote midApr={pair.longLeg.midApr} execApr={pair.longLeg.execApr} />}
                    href={borosMarketUrl(pair.longLeg.marketId, 'long')}
                  />
                </div>
              </div>
            </div>
  
            {pair.execSpreadApr !== null &&
              pair.netFixedAprOnCapital !== null &&
              pair.capitalUsd !== null && (
                <div
                  className={`rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-100 ${
                    netNegative
                      ? 'border-rose-500/20 bg-rose-500/5'
                      : 'border-emerald-500/20 bg-emerald-500/5'
                  }`}
                >
                  <span
                    className={`${microLabelClass} mr-2 ${netNegative ? '!text-rose-400' : '!text-emerald-400'}`}
                  >
                    Net effect
                  </span>
                  Locks a <span className={`num ${netTone}`}>{fmtPct(pair.execSpreadApr, 1)}</span>{' '}
                  funding spread → After leverage:{' '}
                  <span className={`num font-semibold ${netTone}`}>
                    {(pair.netFixedAprOnCapital * 100).toFixed(1)}% APR
                  </span>{' '}
                  on <span className={`num ${netTone}`}>{fmtNotionalShort(pair.capitalUsd)}</span>{' '}
                  capital
                </div>
              )}
  
            {chartable && (
              <>
                <div className={microLabelClass}>PnL &amp; capital breakdown</div>
                <OpportunityWaterfall pair={pair} notionalUsd={notionalUsd} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** "at 8.0% → 7.8% after impact" — the Boros leg's mid rate and what it locks. */
function RateNote({ midApr, execApr }: { midApr: number; execApr: number | null }) {
  return (
    <>
      at <span className="num text-ink-100">{fmtPct(midApr, 1)}</span> →{' '}
      {execApr === null ? (
        <Dash why={THIN_BOOK_WHY} />
      ) : (
        <span className="num text-ink-100">{fmtPct(execApr, 1)}</span>
      )}{' '}
      after impact
    </>
  );
}

export function OpportunitiesPanel({ unconfigured = false }: { unconfigured?: boolean } = {}) {
  const [stored] = useState<StoredControls>(() => loadControls());
  const [notionalChoice, setNotionalChoice] = useState<NotionalChoice>(stored.notionalChoice);
  const [borosEntry, setBorosEntry] = useState<BorosEntryMode>(stored.borosEntry);
  const [entryMode, setEntryMode] = useState<EntryMode>(stored.entryMode);
  const [exitMode, setExitMode] = useState<ExitMode>(stored.exitMode);
  const [feeTier, setFeeTier] = useState<OpportunityFeeTier>(stored.feeTier);
  const [sizeStr, setSizeStr] = useState(String(stored.customNotionalUsd));
  // The last VALID size: a half-typed entry must never blank the list.
  const [size, setSize] = useState(stored.customNotionalUsd);
  const debouncedSize = useDebounced(sizeStr, 400);
  // Deliberately NOT persisted: the strip explains itself once and folds away.
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  // Persisted, like the assumptions. A filter is the louder of the two — it
  // changes what is MISSING rather than how it is priced — so restoring one
  // leans on the affordances that keep it visible: the ✓ on a selected asset
  // chip, the count on the filter icon, and a selected value that still renders
  // at count 0 when the data no longer has it. See `loadFilters`.
  const [filters, setFilters] = useState<OpportunityFilters>(loadFilters);
  const updateFilters = useCallback((next: OpportunityFilters) => {
    setFilters(next);
    saveFilters(next);
  }, []);
  const shownKeysRef = useRef<ReadonlySet<string>>(new Set());
  const flow = useTradeFlowOptional();
  const sizeId = useId();
  const feeTierId = useId();
  const assumptionsId = useId();

  const persist = (next: Partial<StoredControls>) =>
    writeJson(OPPORTUNITIES_STORAGE_KEY, {
      notionalChoice,
      customNotionalUsd: size,
      borosEntry,
      entryMode,
      exitMode,
      feeTier,
      ...next,
    } satisfies StoredControls);

  useEffect(() => {
    const n = Number(debouncedSize);
    if (!isValidOpportunityNotional(n)) return;
    setSize(n);
    persist({ customNotionalUsd: n });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSize]);

  const notionalUsd = notionalChoice === 'custom' ? size : NOTIONAL_PRESETS[notionalChoice];
  const sizeErr =
    notionalChoice === 'custom'
      ? amountError(sizeStr, {
          min: OPPORTUNITY_NOTIONAL_MIN,
          max: OPPORTUNITY_NOTIONAL_MAX,
        })
      : null;
  const sizeBad = notionalChoice === 'custom' && !isValidOpportunityNotional(Number(sizeStr));

  // Configured accounts price from their own live fee schedule; the simulated
  // tier only exists where there is no account to read.
  const query = useOpportunities({
    notionalUsd,
    borosEntry,
    entryMode,
    exitMode,
    feeTier: unconfigured ? feeTier : undefined,
  });
  const data = query.data;

  // Every viable PAIR, not one per group: a cohort with three markets offers
  // three venue combinations, and the two the group's best pair outranked are
  // still real trades — often on the only venue a given reader can reach.
  // `data.groups`, not `data`: meta.asOfSec moves on every poll, so keying on
  // the whole response would rebuild every card even when no number changed.
  const rows = useMemo(
    () => toRows(data?.groups ?? [], shownKeysRef.current),
    [data?.groups],
  );
  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters]);

  // What the NEXT toRows call treats as already on screen — the hysteresis band
  // that stops near-zero pairs flickering in and out under the reader's cursor.
  useEffect(() => {
    shownKeysRef.current = new Set(rows.map((r) => r.key));
  }, [rows]);

  // The notional the RESPONSE priced, never the live control: during a size
  // change `keepPreviousData` shows cards costed at the OLD notional, and
  // arming the ticket at the new one would stage a trade none of the numbers
  // on screen describe. The cards read from this too.
  const pricedNotionalUsd = data?.meta.notionalUsd ?? notionalUsd;

  // Stable identity, or every card re-renders on each keystroke and the memo
  // above buys nothing.
  //
  // Venues travel twice because the two halves are addressed differently:
  // the Boros legs by their OWN venue keys (`longLeg.venue`), the perps by
  // the CrossEx ones — a card's Boros leg and its perp leg sit at the same
  // venue but under different keys, and crossing the two would arm tickets
  // with markets that do not exist.
  const openStrategy = useCallback(
    (pair: OpportunityPair, maturitySec: number, sizeBase?: number) => {
      // First run: there are no keys to execute with, so opening a two-step
      // execution wizard would dead-end. Ask for setup instead — the guide
      // answers by flashing the API-key form, the one step between this click
      // and a wizard that can actually trade.
      if (unconfigured) return flow?.requestSetup();
      return flow?.openWizard({
        base: pair.base,
        borosLongVenue: pair.longLeg.venue,
        borosShortVenue: pair.shortLeg.venue,
        // ⚠ Without this a venue+base match takes whichever maturity comes
        // first, so the two legs can land on DIFFERENT expiries — and since
        // each leg filters the other by maturity, both then vanish from their
        // own dropdowns and the ticket looks empty and broken.
        maturity: maturitySec,
        crossexLongVenue: pair.longLeg.crossexVenue,
        crossexShortVenue: pair.shortLeg.crossexVenue,
        notionalUsd: pricedNotionalUsd,
        // Present only for token-margined cohorts, where the collateral IS the
        // base coin and every leg can be sized in the same unit.
        ...(sizeBase !== undefined && sizeBase > 0 ? { sizeBase } : {}),
        perpMode: entryMode === 'maker-hedge' ? 'maker' : 'market',
      });
    },
    [flow, pricedNotionalUsd, entryMode, unconfigured],
  );

  const summary = assumptionsOpen
    ? ''
    : [
        unconfigured ? feeTierLabel(feeTier) : null,
        ENTRY_MODE_PROSE[entryMode],
        EXIT_MODE_PROSE[exitMode],
        BOROS_ENTRY_PROSE[borosEntry],
      ]
        .filter((s): s is string => s !== null)
        .map((s) => `· ${s}`)
        .join(' ');

  const controls = (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <button
          type="button"
          aria-expanded={assumptionsOpen}
          aria-controls={assumptionsId}
          onClick={() => setAssumptionsOpen((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:border-ink-500"
        >
          <span className="font-semibold text-ink-100">with these assumptions</span>
          <span className="num text-cyan-300">: {fmtNotionalShort(notionalUsd)} notional</span>
          {summary && <span className="num text-ink-400">{summary}</span>}
          <span aria-hidden="true" className="text-cyan-400">
            ⚙
          </span>
          <span aria-hidden="true" className="text-[10px] text-ink-400">
            {assumptionsOpen ? '▴' : '▾'}
          </span>
        </button>
        <span className="flex items-center gap-2">
          {query.isPlaceholderData && <span className="text-xs text-ink-500">recomputing…</span>}
          <StrategyFreshness
            dataUpdatedAt={query.dataUpdatedAt || 0}
            staleError={query.isError && data !== undefined}
            onRefetch={() => void query.refetch()}
          />
        </span>
      </div>

      {assumptionsOpen && (
        <div
          id={assumptionsId}
          className="flex flex-wrap gap-x-7 gap-y-4 rounded-xl border border-ink-700 bg-ink-900 p-4"
        >
          <div className="flex flex-col items-start gap-1.5">
            <div className={microLabelClass}>Notional</div>
            <SegmentedToggle<NotionalChoice>
              className="seg-cyan"
              ariaLabel="Notional"
              value={notionalChoice}
              onChange={(next) => {
                setNotionalChoice(next);
                persist({ notionalChoice: next });
              }}
              options={NOTIONAL_OPTIONS}
            />
            {notionalChoice === 'custom' && (
              <input
                id={sizeId}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Custom notional (USD)"
                value={sizeStr}
                onChange={(e) => setSizeStr(e.target.value)}
                title="The notional every card is priced at — both Boros legs and both perp legs"
                className={`input num w-28 !py-1 text-xs text-cyan-300 ${
                  sizeBad ? 'border-rose-500/60' : 'border-cyan-500/50'
                }`}
              />
            )}
            <span className={`text-[10.5px] ${sizeErr ? 'text-rose-300' : 'text-ink-400'}`} role={sizeErr ? 'alert' : undefined}>
              {sizeErr ?? '$1k – $100M — re-prices every card'}
            </span>
          </div>

          {unconfigured && (
            <div className="flex flex-col items-start gap-1.5">
              <label htmlFor={feeTierId} className={microLabelClass}>
                Gate VIP tier
              </label>
              <select
                id={feeTierId}
                value={feeTier}
                onChange={(e) => {
                  const next = e.target.value as OpportunityFeeTier;
                  setFeeTier(next);
                  persist({ feeTier: next });
                }}
                title="Perp fees assume this Gate CrossEx VIP tier — connect Gate keys to price from your real schedule"
                className="input num h-[30px] w-24 !py-0 text-xs"
              >
                {OPPORTUNITY_FEE_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {feeTierLabel(t)}
                  </option>
                ))}
              </select>
              <span className="max-w-[170px] text-[10.5px] leading-snug text-ink-400">
                simulated — connect keys to price from your real schedule
              </span>
            </div>
          )}

          <div className="flex flex-col items-start gap-1.5">
            <div className={microLabelClass}>Perp entry</div>
            <SegmentedToggle<EntryMode>
              className="seg-cyan"
              ariaLabel="Perp entry mode"
              value={entryMode}
              onChange={(next) => {
                setEntryMode(next);
                persist({ entryMode: next });
              }}
              options={[
                { value: 'both-market', label: ENTRY_MODE_LABEL['both-market'] },
                { value: 'maker-hedge', label: ENTRY_MODE_LABEL['maker-hedge'] },
              ]}
            />
          </div>

          <div className="flex flex-col items-start gap-1.5">
            <div className={microLabelClass}>Perp exit cost</div>
            <SegmentedToggle<ExitMode>
              className="seg-cyan"
              ariaLabel="Perp legs at maturity"
              value={exitMode}
              onChange={(next) => {
                setExitMode(next);
                persist({ exitMode: next });
              }}
              options={[
                { value: 'close', label: EXIT_MODE_LABEL.close },
                { value: 'roll', label: EXIT_MODE_LABEL.roll },
              ]}
            />
            {/* Only under "Roll over" — beneath a "Perp exit cost" label with
                "Close positions" picked, it reads as a flat contradiction. */}
            {exitMode === 'roll' && <span className="text-[10.5px] text-ink-400">no exit cost</span>}
          </div>

          <div className="flex flex-col items-start gap-1.5">
            <div className={microLabelClass}>Boros entry</div>
            <SegmentedToggle<BorosEntryMode>
              className="seg-cyan"
              ariaLabel="Boros entry"
              value={borosEntry}
              onChange={(next) => {
                setBorosEntry(next);
                persist({ borosEntry: next });
              }}
              options={BOROS_ENTRY_OPTIONS}
            />
          </div>
        </div>
      )}
    </div>
  );

  if (query.isPending) {
    return (
      <div>
        {controls}
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card overflow-hidden">
              <div className="border-b border-ink-800 bg-ink-950/40 px-4 py-2.5">
                <Skeleton className="h-3 w-56" />
              </div>
              <div className="flex items-end gap-7 p-4">
                <Skeleton className="h-8 w-36" />
                <Skeleton className="hidden h-8 w-64 sm:block" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (query.isError && !data) {
    return (
      <div>
        {controls}
        <QueryError title="Couldn't load opportunities" error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <div>
      {controls}
      {data && <Notes items={data.warnings} className="mb-2" />}
      {/* The bar only exists to narrow a list — with nothing to narrow it would
          be a row of dead chips above an empty state. */}
      {rows.length > 0 && (
        <OpportunityFilterBar
          rows={rows}
          filters={filters}
          onChange={updateFilters}
          shown={visible.length}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState
          icon="◎"
          title="No fixed-return opportunities"
          hint={`No Boros arb pair prices out at ${fmtUsd(notionalUsd, 0)} notional with a Boros entry ${
            borosEntry === 'mark' ? 'at mark rate' : 'at market size'
          }, ${ENTRY_MODE_PROSE[entryMode]} perp entry and ${EXIT_MODE_PROSE[exitMode]}. Try another notional or another assumption.`}
        />
      ) : visible.length === 0 ? (
        // Distinct from the one above: the assumptions DO price opportunities,
        // the filters are just hiding all of them — so the fix is here, not in
        // the assumptions strip.
        <EmptyState
          icon="◎"
          title="No opportunity matches these filters"
          hint={`All ${rows.length} priced ${rows.length === 1 ? 'opportunity is' : 'opportunities are'} filtered out. Drop a filter to bring them back.`}
          action={
            hasActiveFilter(filters) ? (
              <button type="button" className="btn" onClick={() => updateFilters(NO_FILTERS)}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div
          className={`flex flex-col gap-3 transition-opacity ${query.isPlaceholderData ? 'opacity-50' : ''}`}
        >
          {/* Ranked by the server's own primary key (net fixed APR on capital),
              which is the only order that survives flattening the groups. */}
          {visible.map((row) => (
            <OpportunityCard
              key={row.key}
              group={row.group}
              pair={row.pair}
              notionalUsd={pricedNotionalUsd}
              onOpenStrategy={flow ? openStrategy : null}
              unconfigured={unconfigured}
            />
          ))}
        </div>
      )}
    </div>
  );
}
