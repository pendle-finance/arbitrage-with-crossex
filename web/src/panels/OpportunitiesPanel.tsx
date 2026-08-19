/**
 * Forward-looking fixed-return opportunities — one collapsible card per Boros
 * arb group, in the server's ranking (never re-sorted here).
 *   Collapsed — the net fixed APR ON CAPITAL as the hero (the Positions view's
 *               basis), the capital / return / notional line, the asset and its
 *               two venue legs, warning chips, Details + Execute.
 *   Expanded  — the four legs the trade opens, the spread it locks, and the
 *               profit + capital waterfalls.
 * Owns the persisted assumptions — notional, Boros entry, perp entry, exit and
 * the simulated VIP tier, each an independent knob — and the single query they
 * drive. Executing only PREFILLS the pair ticket — submission stays behind its
 * hold-to-confirm control.
 */
import { useEffect, useId, useState, type MouseEvent, type ReactNode } from 'react';
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
import { borosMarketUrl } from '../lib/boros';
import { fmtAge, fmtDateUtc, fmtNotionalShort, fmtPct, fmtTokenQty, fmtUsd, sig } from '../lib/fmt';
import { IS_LANDING } from '../lib/landing';
import { readJson, writeJson } from '../lib/storage';
import { useDebounced } from '../lib/useDebounced';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { StrategyFreshness } from './HomeControls';
import { canChartCapital, canChartProfit, OpportunityWaterfall } from './OpportunityWaterfall';

/** SEPARATE KEYS PER BUILD. The two builds deliberately disagree on their
 * defaults ($10k/both-market in the terminal, $100k/maker-hedge on the landing
 * — see LANDING_DEFAULTS), and they can share an origin during development
 * (:5199 landing, :6688 terminal are both `localhost`). The panel persists on
 * MOUNT, not only on user action — the debounced-size effect below fires
 * immediately because `useDebounced` seeds its state with the input — so one
 * shared key meant whichever build painted last silently re-set the other's
 * controls, making each build's own defaults unreachable after a single visit
 * to the other. Splitting the key is what keeps LANDING_DEFAULTS meaningful. */
export const OPPORTUNITIES_STORAGE_KEY = IS_LANDING
  ? 'crossex.opportunities.landing.v2'
  : 'crossex.opportunities.v2';

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
  exitMode: 'close',
  feeTier: 'vip0',
};

/** The landing build opens this panel from a headline number, so its first
 * paint MUST be priced the same way `landingOpportunities.ts` prices that
 * number — $100k at maker-hedge. With the shared DEFAULTS ($10k, both-market)
 * the top card contradicted the hero the visitor had just clicked.
 *
 * Only the FIRST paint: everything here is a normal control, so changing size
 * or entry mode works exactly as it does in the terminal, and any stored choice
 * still wins (see loadControls). Kept in sync with LANDING_NOTIONAL_USD and the
 * useLandingOpportunities params. */
const LANDING_DEFAULTS: StoredControls = {
  ...DEFAULTS,
  notionalChoice: '100k',
  customNotionalUsd: 100_000,
  entryMode: 'maker-hedge',
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

/** Missing number → an em dash carrying the reason, never "NaN". */
function Dash({ why }: { why: string }) {
  return (
    <span className="num text-ink-500" title={why}>
      —
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
function cardChips(pair: OpportunityPair | null): CardChip[] {
  const chips: CardChip[] = [];
  if (!pair) {
    chips.push({
      key: 'no-pair',
      label: 'no pairable legs',
      title: 'No two markets in this group can carry a perp leg on CrossEx',
    });
    return chips;
  }
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

function OpportunityCard({
  group,
  notionalUsd,
  onExecute,
  unconfigured,
}: {
  group: OpportunityGroup;
  /** The notional the RESPONSE priced — the waterfall converts APRs with it. */
  notionalUsd: number;
  /** null when there is no trade-flow provider — the button then explains itself. */
  onExecute: ((pair: OpportunityPair) => void) | null;
  /** First-run view: symbols are expectedly absent, so Execute stays enabled
   * and clicking it nudges the setup guide instead of dead-ending. */
  unconfigured: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pair = group.bestPair ?? group.pairs[0] ?? null;
  const chips = cardChips(pair);
  // Only the PAIR's own reasons — they explain this card's own numbers. The
  // group's warnings are about the other markets in the cohort ("… has no
  // CrossEx perp venue"), and those rows stopped being displayed with the
  // markets table.
  const reasons = [...new Set(pair?.reasons ?? [])];
  const base = pair?.base || group.underlying;
  const capitalApr = pair?.netFixedAprOnCapital ?? null;
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
  const collateralQty =
    group.collateral !== 'USDT' && group.collateralPriceUsd !== null && group.collateralPriceUsd > 0
      ? { qty: notionalUsd / group.collateralPriceUsd, symbol: group.collateral }
      : null;
  // Both legs unmapped ⇒ the ticket would arm nothing; one missing is fine (it
  // leaves that leg unselected by design). Fungible groups can collapse two
  // different assets, and the ticket only takes one base.
  const basesDiffer = pair !== null && pair.shortLeg.base !== pair.longLeg.base;
  const noSymbols = pair !== null && !pair.shortLeg.crossexSymbol && !pair.longLeg.crossexSymbol;
  const executeDisabled =
    pair === null || (noSymbols && !unconfigured) || basesDiffer || onExecute === null;
  const executeTitle =
    pair === null
      ? 'No pairable legs in this group'
      : basesDiffer
        ? `The legs trade different assets (${pair.shortLeg.base} vs ${pair.longLeg.base}) — the pair ticket takes one base`
        : unconfigured
          ? // No IS_LANDING branch: the landing build does not render this
            // button at all (see below), so a landing-specific tooltip here
            // would be unreachable.
            'Add your Gate API key in the setup guide on the right — clicking stages this pair for the ticket'
          : noSymbols
            ? `Neither ${pair.shortLeg.venue} nor ${pair.longLeg.venue} lists a CrossEx perp for ${pair.base}`
            : 'Prefills the pair ticket with these perp legs — you still confirm the order there';
  const detailsDisabled =
    pair === null || (!canChartProfit(pair) && !canChartCapital(pair) && pair.execSpreadApr === null);
  const detailsTitle = detailsDisabled
    ? pair === null
      ? 'No pairable legs in this group'
      : 'This pair prices neither a spread nor a capital stack — there is nothing to break down'
    : undefined;
  const chartable = pair !== null && (canChartProfit(pair) || canChartCapital(pair));

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
      className={`card p-4 ${detailsDisabled ? '' : 'cursor-pointer'}`}
      onClick={toggleFromCard}
    >
      {/* Stacked on phones: the shrink-0 button group is 184px, which left the
          APR hero and the capital line ~112px to fight over and spilling. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
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
            {chips.map((c) => (
              <Chip key={c.key} sm tone={c.tone ?? 'amber'} title={c.title}>
                {c.label}
              </Chip>
            ))}
          </div>

          <div className="num flex flex-wrap items-baseline gap-1.5 text-[13px]">
            <span className="text-ink-400">Capital</span>
            {pair?.capitalUsd === undefined || pair.capitalUsd === null ? (
              <Dash why={CAPITAL_WHY} />
            ) : (
              <span
                className="text-ink-100"
                title="The modelled minimum this trade posts across the four legs — expand for the breakdown"
              >
                ~{fmtUsd(pair.capitalUsd, 0)}
              </span>
            )}
            <span className="px-1 text-ink-500">·</span>
            <span className="text-ink-400">Return</span>
            {pair?.estProfitUsd === undefined || pair.estProfitUsd === null ? (
              <Dash why="No net APR — nothing to project" />
            ) : (
              <span
                className={pair.estProfitUsd < 0 ? 'text-rose-400' : 'text-ink-100'}
                title={`Estimated profit by maturity on ${fmtUsd(notionalUsd, 0)} per leg`}
              >
                {fmtUsd(pair.estProfitUsd, 0)}
              </span>
            )}
            <span className="px-1 text-ink-500">·</span>
            <span className="text-ink-400">Notional</span>
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
            {/* The net story needs fees/books/leverage; when those are missing
                (Gate down or unconfigured) the raw Boros spread is still the
                headline worth showing — it is what the trade captures. */}
            {pair && pair.netFixedApr === null && Number.isFinite(pair.grossSpreadApr) && (
              <>
                <span className="px-1 text-ink-500">·</span>
                <span className="text-ink-400">Gross spread</span>
                <span
                  className="text-amber-400"
                  title="midApr(short) − midApr(long) — the raw Boros spread, before execution and costs"
                >
                  {fmtPct(pair.grossSpreadApr, 1)}
                </span>
                <span className="text-ink-400">only</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className="num flex h-6 w-6 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[9px] font-semibold leading-none text-ink-300"
              title={`${base} funding rate`}
            >
              {base}
            </span>
            {pair ? (
              <span className="flex flex-col gap-0.5">
                <SideVenue side="SHORT" venue={pair.shortLeg.venue} />
                <SideVenue side="LONG" venue={pair.longLeg.venue} />
              </span>
            ) : (
              <span className="text-xs text-ink-500">no pairable legs</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <button
            type="button"
            className="btn-ghost"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${group.underlying} ${group.collateral}-margined ${fmtDateUtc(group.maturity)}`}
            disabled={detailsDisabled}
            title={detailsTitle}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
          {/* Not on the public site: executing needs the terminal on your own
              machine, so the button could only ever render disabled there —
              a dead control on every card, advertising something the page
              cannot do. The setup rail beside these cards is the real next
              step. `Details` stays: it works fully without keys. */}
          {!IS_LANDING && (
            <button
              type="button"
              className="btn btn-primary px-4 font-semibold"
              disabled={executeDisabled}
              title={executeTitle}
              onClick={() => pair && onExecute?.(pair)}
            >
              Execute it
            </button>
          )}
        </div>
      </div>

      {open && pair && (
        // Clicks inside the expanded breakdown must not collapse it — closing is
        // the header's or the Hide-details button's job.
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
  );
}

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
  // IS_LANDING, not `unconfigured`: a fresh terminal install is also
  // unconfigured and must keep the terminal's own $10k default.
  const [stored] = useState<StoredControls>(() =>
    loadControls(IS_LANDING ? LANDING_DEFAULTS : DEFAULTS),
  );
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

  const execute =
    flow &&
    ((pair: OpportunityPair) =>
      flow.prefillPair({
        base: pair.base,
        longVenue: pair.longLeg.crossexVenue,
        shortVenue: pair.shortLeg.crossexVenue,
        notionalUsd,
        mode: entryMode === 'maker-hedge' ? 'maker' : 'market',
      }));

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
            <div key={i} className="card flex flex-col gap-3 p-4">
              <Skeleton className="h-3 w-64" />
              <Skeleton className="h-7 w-40" />
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

  // Only VIABLE opportunities are shown. The server still serves groups whose
  // best pair prices no net APR on capital (degraded inputs) or a negative one
  // (costs swallow the spread) — those are noise in a list of things worth
  // executing, so they are dropped here, keeping the server's order otherwise.
  const groups = (data?.groups ?? []).filter((g) => {
    const pair = g.bestPair ?? g.pairs[0] ?? null;
    const apr = pair?.netFixedAprOnCapital ?? null;
    return apr !== null && Number.isFinite(apr) && apr >= 0;
  });

  return (
    <div>
      {controls}
      {data && <Notes items={data.warnings} className="mb-2" />}
      {groups.length === 0 ? (
        <EmptyState
          icon="◎"
          title="No fixed-return opportunities"
          hint={`No Boros arb group prices out at ${fmtUsd(notionalUsd, 0)} notional with a Boros entry ${
            borosEntry === 'mark' ? 'at mark rate' : 'at market size'
          }, ${ENTRY_MODE_PROSE[entryMode]} perp entry and ${EXIT_MODE_PROSE[exitMode]}. Try another notional or another assumption.`}
        />
      ) : (
        <div
          className={`flex flex-col gap-3 transition-opacity ${query.isPlaceholderData ? 'opacity-50' : ''}`}
        >
          {/* Server order IS the ranking — never re-sort here. */}
          {groups.map((g) => (
            <OpportunityCard
              key={`${g.tokenId}:${g.maturity}:${g.underlying}`}
              group={g}
              // The response's own notional, not the live control: during a
              // size change `keepPreviousData` shows costs priced at the OLD
              // notional, and the chart must convert with the same one.
              notionalUsd={data?.meta.notionalUsd ?? notionalUsd}
              onExecute={execute || null}
              unconfigured={unconfigured}
            />
          ))}
        </div>
      )}
    </div>
  );
}
