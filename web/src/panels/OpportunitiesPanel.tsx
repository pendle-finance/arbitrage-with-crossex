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
import { ArrowRight, ArrowUpRight } from 'lucide-react';
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
  useBorosPairContext,
  useOpportunities,
  usePositions,
  useRebate,
} from '../api/queries';
import type {
  BorosEntryMode,
  EntryMode,
  ExitMode,
  OpportunityGroup,
  OpportunityPair,
  Rebate,
} from '../api/types';
import { Chip, type ChipTone } from '../components/Chip';
import { EmptyState } from '../components/EmptyState';
import { Notes } from '../components/Notes';
import { QueryError } from '../components/QueryError';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { Skeleton } from '../components/Skeleton';
import { microLabelClass } from '../components/Th';
import { TokenIcon, VenueIcon } from '../components/AssetIcon';
import { SideVenue } from '../components/VenueChip';
import { borosMarketUrl, isUsdCollateral } from '../lib/boros';
import {
  fmtAge,
  fmtDateLocal,
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
import { heldPerpsOf, repriceHeld, type HeldBook, type HeldTag } from './heldPerps';
import { applyRebate } from './opportunityRebate';
import { rebateAppliesTo, rebateChipLabel } from '../lib/rebate';
import { useActiveWallet, useTrackedAddressOptional } from './trackedAddress';
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

export interface StoredControls {
  notionalChoice: NotionalChoice;
  /** The size behind "Custom…" (USD). */
  customNotionalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** Credit the account's settlement-fee rebate into every APR. Default on —
   * the rebate is a real, unconditional discount for a rebated account. Only
   * ever shown/applied when the account has a rebate at all. */
  includeRebate: boolean;
}

const DEFAULTS: StoredControls = {
  notionalChoice: '10k',
  customNotionalUsd: 10_000,
  borosEntry: 'market',
  entryMode: 'both-market',
  // 'roll' by default: an assumed exit cost is a decision the user has not
  // made yet, and it understates every quote.
  exitMode: 'roll',
  includeRebate: true,
};

const validEntryMode = (v: unknown): EntryMode =>
  v === 'both-market' || v === 'maker-hedge' ? v : DEFAULTS.entryMode;

const validExitMode = (v: unknown): ExitMode =>
  v === 'close' || v === 'roll' ? v : DEFAULTS.exitMode;

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
    | { choice?: unknown; customSize?: unknown; entryMode?: unknown; exitMode?: unknown }
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
    // v1's 'mark' choice has no home any more — every card is priced
    // market-at-size — so the size migrates and the entry lands on market.
    borosEntry: 'market',
    entryMode: validEntryMode(p?.entryMode),
    exitMode: validExitMode(p?.exitMode),
    includeRebate: DEFAULTS.includeRebate,
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
          includeRebate?: unknown;
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
      includeRebate: typeof p?.includeRebate === 'boolean' ? p.includeRebate : base.includeRebate,
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
function Stat({ label, tip, children }: { label: string; tip?: boolean; children: ReactNode }) {
  // Measured against the mock: the label's TOP lines up with the APR's top and
  // the value's baseline then lands within ~3px of the APR's, because a 30px
  // number and a 10px label + 7px gap + 14px value happen to span the same box.
  // So this is plain top-alignment — no height box, which only pushed the
  // values a full line below the APR.
  return (
    <span className="flex flex-col items-start gap-1.5">
      <span className={`${microLabelClass}${tip ? ' tip-label' : ''}`}>{label}</span>
      <span className="num text-[14px] font-medium leading-[16.94px] text-ink-50">{children}</span>
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
const THIN_BOOK_WHY = "The Boros books can't lock this size.";

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
        label: `no CX symbol · ${prettyVenue(leg.venue)}`,
        title: `${prettyVenue(leg.venue)} lists no CrossEx perp for ${leg.base} — that leg won't prefill`,
      });
    }
  }
  return chips;
}

/** The one sentence every null capital number carries. */
const CAPITAL_WHY =
  "The capital can't be modelled. A rate, margin input or max leverage is missing.";

/** The hero's title: same wording as the Positions card, plus what "capital"
 * means for a trade that isn't open yet. */
const CAPITAL_APR_TITLE =
  'Locked fixed spread annualized on the minimum capital this trade posts.';

/** One "$10k · Short ETH · BYBIT · <note>" row of the 4-leg explainer. The four
 * cells are a fragment so the parent grid keeps both rows aligned. */
function LegRow({
  n,
  side,
  label,
  kind,
  note,
  href,
}: {
  /** 1–4. The mock numbers the legs in the order they are opened. */
  n: number;
  side: 'short' | 'long';
  label: string;
  /** Which book the leg is on — "CrossEx" or "Boros". */
  kind: 'CrossEx' | 'Boros';
  /** Trailing annotation; empty keeps the row's 3rd cell in the grid. */
  note: ReactNode;
  /** Link the label out (the Boros legs → the market page, side prefilled). */
  href?: string;
}) {
  // The mock's leg box: a dark inset per leg — number, what it is, and WHERE it
  // trades as a rounded tag at the right (CrossEx grey, Boros the brand blue) —
  // with the leg's one note on a line underneath, indented under the label.
  const tag = (
    <span
      className={`ml-auto whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-semibold tracking-[0.06em] ${
        kind === 'Boros' ? 'bg-info/[0.16] text-pastel-blue' : 'bg-wash/[0.10] text-ink-300'
      }`}
    >
      {kind}
      {href && <ArrowUpRight size={12} aria-hidden className="ml-0.5 inline" />}
    </span>
  );
  return (
    <div className="rounded border border-wash/[0.07] bg-ink-950/60 px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`num inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-[12px] font-bold ${
            side === 'short' ? 'bg-guava/10 text-guava' : 'bg-grass/[0.12] text-grass'
          }`}
        >
          {n}
        </span>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`Open this market on Boros with the ${side} side prefilled`}
            /* The visible label is the mock's bare "Short BTC" + a Boros tag; the
               tag disambiguates it on screen, but a link's accessible name has to
               stand alone, so it says which book and which rate it is. */
            aria-label={`${label} funding on Boros`}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-[14px] font-semibold leading-[16.94px] text-ink-50 transition-opacity hover:opacity-80"
          >
            <span className="num min-w-0">{label}</span>
            {tag}
          </a>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2.5 text-[14px] font-semibold leading-[16.94px] text-ink-50">
            <span className="num min-w-0">{label}</span>
            {tag}
          </span>
        )}
      </div>
      <div className="mt-2.5 pl-8 text-[12px] text-ink-300">{note}</div>
    </div>
  );
}

/** One venue's pane: its name, why it is on this side, and the fixed rate the
 * two legs there lock. The mock groups by VENUE (where the funding is rich vs
 * cheap), not by book — the numbered legs carry the book. */
function VenueBox({
  venue,
  why,
  fixedApr,
  positive,
  children,
}: {
  venue: string;
  why: string;
  fixedApr: number | null;
  /** Receives fixed (green, "+") vs pays fixed (guava, "−"). */
  positive: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded border border-wash/10 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <VenueIcon venue={venue} size={20} />
        <span className="whitespace-nowrap text-[16px] font-bold leading-[19.36px] text-ink-50">{venue}</span>
        <span className="whitespace-nowrap text-[12px] text-ink-500">{why}</span>
        {fixedApr !== null && Number.isFinite(fixedApr) && (
          <span
            className={`num ml-auto whitespace-nowrap rounded px-3 py-1.5 text-[14px] font-bold ${
              positive ? 'bg-grass/10 text-grass' : 'bg-guava/10 text-guava'
            }`}
          >
            {positive ? '+' : '−'}
            {fmtPct(Math.abs(fixedApr), 1)} Fixed
          </span>
        )}
      </div>
      {/* One inset box per leg, joined by a short dashed connector. */}
      <div className="flex flex-col [&>*+*]:relative [&>*+*]:mt-[18px] [&>*+*]:before:absolute [&>*+*]:before:-top-[18px] [&>*+*]:before:left-[26px] [&>*+*]:before:h-[18px] [&>*+*]:before:border-l [&>*+*]:before:border-dashed [&>*+*]:before:border-ink-300/30 [&>*+*]:before:content-['']">
        {children}
      </div>
    </div>
  );
}

const OpportunityCard = memo(function OpportunityCard({
  group,
  pair: served,
  notionalUsd,
  rebate = null,
  includeRebate = false,
  onOpenStrategy,
  held = null,
}: {
  /** Set when this row is a later maturity of a hedge the reader runs: the
   * band says so, and the "existing perp position" toggle starts ON. */
  held?: HeldTag | null;
  /** The cohort the pair belongs to — collateral, maturity, underlying. */
  group: OpportunityGroup;
  /** THE trade this card is about. One group serves several: every viable venue
   * combination in it is its own card. */
  pair: OpportunityPair;
  /** The notional the RESPONSE priced — the waterfall converts APRs with it. */
  notionalUsd: number;
  /** The account's settlement-fee rebate config — drives the "fee rebate" chip
   * (shown when it reaches either leg) and, with `includeRebate`, the reprice.
   * Null = no rebate, chip hidden. */
  rebate?: Rebate | null;
  /** Whether to CREDIT the rebate into this card's APR (the "Include rebate in
   * APR" toggle). The chip shows regardless; only the reprice honours this. */
  includeRebate?: boolean;
  /** Opens the guided 2-step wizard for this pair — Boros rate legs first,
   * then the perp hedge. null when there is no trade-flow provider (the
   * landing build); the button then explains itself. `sizeBase` sizes the
   * legs in the Boros collateral when that IS the base coin, so all four
   * match without an eyeballed conversion. */
  onOpenStrategy:
    | ((pair: OpportunityPair, maturitySec: number, sizeBase?: number) => void)
    | null;
}) {
  const [open, setOpen] = useState(false);
  /**
   * "I have existing perp position": prices THIS row with no perp entry cost
   * (see heldPerps.repriceHeld). On by default exactly when the row was
   * detected as a rollover opportunity, off otherwise — and the reader's own
   * click wins from then on. `null` = untouched, so a detection that lands
   * AFTER mount (the positions feed warms up a beat behind the list) still
   * turns the default on (his call 2026-09-20).
   */
  const [hasPerpsChoice, setHasPerpsChoice] = useState<boolean | null>(null);
  const hasPerps = hasPerpsChoice ?? held === 'rollover';
  // repriceHeld first (drops perp entry cost), then applyRebate (credits the
  // settlement-fee rebate) — both pure OpportunityPair → OpportunityPair, so
  // they compose and every downstream identity still closes.
  const pair = useMemo(() => {
    const priced = hasPerps ? repriceHeld(served, notionalUsd) : served;
    return rebate && includeRebate ? applyRebate(priced, rebate, notionalUsd) : priced;
  }, [hasPerps, served, notionalUsd, rebate, includeRebate]);
  // The chip shows whenever the rebate actually reaches one of this card's two
  // markets (active window + market filter) — independent of the toggle.
  const rebateChip =
    rebate &&
    (rebateAppliesTo(rebate, pair.shortLeg.marketId) || rebateAppliesTo(rebate, pair.longLeg.marketId))
      ? rebate
      : null;
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
  // No "caveats" chip: the same `reasons` already hang off the two numbers they
  // qualify (the APR and Capital titles below), so a third copy on the header
  // strip only added a badge the mock doesn't carry and the reader can't act on.
  // Costs can swallow the whole spread — the server ranks those groups last but
  // still serves them, so a loss must never wear the profit colour.
  const netNegative = capitalApr !== null && capitalApr < 0;
  const netTone = netNegative ? 'text-rose-400' : 'text-emerald-400';
  const days = Math.max(1, Math.round(group.secondsToMaturity / 86_400));
  const maturityTitle = `Matures ${fmtDateLocal(group.maturity)} · ${fmtAge(group.secondsToMaturity * 1000)} left`;
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
  const executeDisabled = noSymbols || basesDiffer || onOpenStrategy === null;
  const executeTitle = basesDiffer
    ? `The legs trade different assets (${pair.shortLeg.base} vs ${pair.longLeg.base}) — the pair ticket takes one base`
    : noSymbols
      ? `Neither ${prettyVenue(pair.shortLeg.venue)} nor ${prettyVenue(pair.longLeg.venue)} lists a CrossEx perp for ${pair.base}`
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
    if ((e.target as HTMLElement).closest('button, a, input, select, label')) return;
    if (window.getSelection()?.toString()) return;
    setOpen((v) => !v);
  };

  return (
    <div
      // overflow-hidden lets the identity band's darker ground clip cleanly at
      // the card's rounded corners.
      className={`overflow-hidden rounded bg-wash/[0.05] ${detailsDisabled ? '' : 'cursor-pointer transition-colors hover:bg-wash/[0.08]'}`}
      onClick={toggleFromCard}
    >
      {/* Identity band — WHAT the trade is, before how much it pays: ticker,
          the two legs, warnings pushed right. Its darker ground and hairline
          give the list a ledger rhythm and keep warnings out of the hero's
          way. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-5 pt-[18px]">
        <span
          className="num inline-flex items-center gap-2 text-[16px] font-bold leading-[19.36px] text-ink-50"
          title={`${base} funding rate`}
        >
          <TokenIcon symbol={base} size={20} />
          {base}
        </span>
        <SideVenue side="SHORT" venue={pair.shortLeg.venue} />
        <SideVenue side="LONG" venue={pair.longLeg.venue} />
        {/* On the LEFT with the trade's identity, not beside "matures": the
            date is the band's one right-hand fact. No separate "rollover
            opportunity" chip — a box that starts ticked says the same thing
            (his call 2026-09-20). */}
        <label
          className="ml-1 flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-300"
          title={
            held
              ? 'You hold this pair at a sooner maturity. Prices the row with no perp entry cost.'
              : 'Prices this row with no perp entry cost.'
          }
        >
          <input type="checkbox" className="chk" checked={hasPerps} onChange={(e) => setHasPerpsChoice(e.target.checked)} />
          I have existing perp position
        </label>
        {rebateChip && (
          <Chip
            sm
            tone="green"
            title={`Boros settlement-fee rebate on this account${rebateChip.startTimestamp ? ` since ${fmtDateLocal(rebateChip.startTimestamp)}` : ''}`}
          >
            {rebateChipLabel(rebateChip)}
          </Chip>
        )}
        {chips.map((c) => (
          <Chip key={c.key} sm tone={c.tone ?? 'amber'} title={c.title}>
            {c.label}
          </Chip>
        ))}
        {/* Line 1 ends on WHEN it settles; the rate leads line 2, next to the
            asset and the legs it belongs to (his call 2026-09-21 — the APR
            reads better close to what it is the rate OF). */}
        <span className="num ml-auto whitespace-nowrap text-[12px] text-ink-400" title={maturityTitle}>
          matures {fmtDateLocal(group.maturity)}
        </span>
      </div>

      <div className="px-5 pb-[18px]">
        <div className="mt-4 border-t border-wash/10 pt-4" />
        {/* Stacked on phones: the shrink-0 action column is 184px, which left
            the APR hero and the stat row ~112px to fight over and spilling.
            items-CENTER, not items-end: the action column runs ~22px taller
            than the figures (two buttons over their caption), and ending them
            together dropped that whole gap above the APR, which read as a
            bloated top margin on every card. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          {/* Hero + stats share one baseline (items-end): the APR leads, the
              labelled figures columnize across cards. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-[34px] gap-y-4">
            {/* One row: the APR leads and CAPITAL / RETURN / NOTIONAL sit beside
                it, so a column of cards reads as a table. They wrap together
                only when the viewport actually runs out. */}
            <span className="flex flex-col items-start gap-1.5">
              <span className="flex items-baseline gap-2">
            {capitalApr === null || !Number.isFinite(capitalApr) ? (
              <span
                className="num text-[28px] font-bold leading-none text-ink-400"
                title={reasons.length > 0 ? reasons.join('\n') : CAPITAL_WHY}
              >
                —%
              </span>
            ) : (
              <span
                className={`num text-[28px] font-bold leading-none ${
                  capitalApr < 0 ? 'text-guava' : 'text-grass'
                }`}
                title={
                  reasons.length > 0
                    ? `${CAPITAL_APR_TITLE}\n\n${reasons.join('\n')}`
                    : CAPITAL_APR_TITLE
                }
              >
                {(capitalApr * 100).toFixed(1)}%
              </span>
            )}
            {/* "APR" is its own muted label in the mock, not part of the
                number — the figure stays the loudest thing on the card. */}
            <span className="text-sm font-medium text-ink-200">APR</span>
            <span className="text-[12.5px] text-ink-400" title={maturityTitle}>
              ({days}d)
            </span>
              </span>
            {/* Details as a dotted-underline text link rather than a button:
                expanding is the quiet, reversible move and should not carry
                the weight of the one that opens a position. Still a real
                <button> — it owns aria-expanded and must stay keyboard- and
                screen-reader-addressable; only its chrome is gone. */}
            <button
            type="button"
              className="text-[12px] text-ink-300 underline decoration-ink-400 decoration-dotted underline-offset-[3px] transition-colors hover:text-ink-50 hover:decoration-ink-200 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 disabled:hover:text-ink-300"
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} details for ${base} short ${prettyVenue(pair.shortLeg.venue)} / long ${prettyVenue(pair.longLeg.venue)}, ${group.collateral}-margined ${fmtDateLocal(group.maturity)}`}
              disabled={detailsDisabled}
              title={detailsTitle}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide details' : 'More details'}
            </button>
            </span>
            <Stat label="Capital" tip>
              {capitalUsd === null ? (
                <Dash why={CAPITAL_WHY} />
              ) : (
                <span title="The minimum capital this trade posts across the four legs.">
                  ~{fmtUsd(capitalUsd, 0)}
                </span>
              )}
            </Stat>
            <Stat label="Return" tip>
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
                title={`${fmtUsd(notionalUsd, 0)} per leg${collateralQty ? ` ≈ ${sig(collateralQty.qty)} ${collateralQty.symbol}` : ''}`}
              >
                {fmtNotionalShort(notionalUsd)}
                {collateralQty && (
                  <span className="text-[12px] font-normal text-ink-300">
                    {' '}
                    ({fmtTokenQty(collateralQty.qty, collateralQty.symbol)})
                  </span>
                )}
              </span>
            </Stat>
            {/* The net story needs fees/books/leverage; when those are missing
                (Gate down) the raw Boros spread is still the headline worth
                showing — it is what the trade captures. */}
            {pair.netFixedApr === null && Number.isFinite(pair.grossSpreadApr) && (
              <Stat label="Gross spread">
                <span
                  className="text-amber-400"
                  title="Short mid rate − long mid rate, before execution and costs."
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
          <div className="flex shrink-0 items-center gap-3">

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
              aria-label={`Open this strategy — ${base} short ${prettyVenue(pair.shortLeg.venue)} / long ${prettyVenue(pair.longLeg.venue)}, ${group.collateral}-margined ${fmtDateLocal(group.maturity)}`}
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
              Open this strategy <ArrowRight size={14} aria-hidden className="inline" />
            </button>
          </div>
        </div>


        {open && (
          // Clicks inside the expanded breakdown must not collapse it — closing
          // is the header's or the Hide-details button's job.
          <div
            className="mt-4 flex cursor-auto flex-col gap-3.5 border-t border-ink-800 pt-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            {/* "four legs · $10k notional each", then a rule, then the
                no-price-risk reassurance — the mock's divider line. */}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
              <span className="whitespace-nowrap text-[11.5px] text-ink-200">
                four legs ·{' '}
                <span className="text-link">
                  {fmtNotionalShort(notionalUsd)}
                  {collateralQty
                    ? ` (${fmtTokenQty(collateralQty.qty, collateralQty.symbol)})`
                    : ''}{' '}
                  notional each
                </span>
              </span>
              <span aria-hidden="true" className="min-w-[24px] flex-1 border-t border-dashed border-ink-300/25" />
              <span className="whitespace-nowrap rounded-full border border-wash/[0.15] bg-ink-950/60 px-4 py-[5px] text-[12px] text-ink-300">
                nets to 0 · no price risk
              </span>
            </div>
            {/* Two columns only from xl: the content column is the viewport less
                ~400px of chrome, so at md each box would be ~175px and the rows
                below would overflow. */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <VenueBox
                venue={prettyVenue(pair.shortLeg.venue)}
                why="funding is rich here"
                fixedApr={pair.shortLeg.execApr ?? pair.shortLeg.midApr}
                positive
              >
                <LegRow
                  n={1}
                  side="short"
                  label={`Short ${base}`}
                  kind="CrossEx"
                  note={
                    pair.capital.shortLeverageMax === null
                      ? ''
                      : `up to ${pair.capital.shortLeverageMax}× leverage`
                  }
                />
                <LegRow
                  n={2}
                  side="short"
                  label={`Short ${base}`}
                  kind="Boros"
                  note={<RateNote midApr={pair.shortLeg.midApr} execApr={pair.shortLeg.execApr} />}
                  href={borosMarketUrl(pair.shortLeg.marketId, 'short')}
                />
              </VenueBox>
              <VenueBox
                venue={prettyVenue(pair.longLeg.venue)}
                why="funding is cheap here"
                fixedApr={pair.longLeg.execApr ?? pair.longLeg.midApr}
                positive={false}
              >
                <LegRow
                  n={3}
                  side="long"
                  label={`Long ${base}`}
                  kind="CrossEx"
                  note={
                    pair.capital.longLeverageMax === null
                      ? ''
                      : `up to ${pair.capital.longLeverageMax}× leverage`
                  }
                />
                <LegRow
                  n={4}
                  side="long"
                  label={`Long ${base}`}
                  kind="Boros"
                  note={<RateNote midApr={pair.longLeg.midApr} execApr={pair.longLeg.execApr} />}
                  href={borosMarketUrl(pair.longLeg.marketId, 'long')}
                />
              </VenueBox>
            </div>
            {/* Kept from the app: the mock never says this, but it is the one
                line that explains why four legs are not four risks. */}
            <div className="text-[11px] leading-relaxed text-ink-400">
              The terminal opens both perp legs delta-neutral in one cross-margin account — minimal
              liquidation risk.
            </div>

            {/* No shared heading: each plot now carries its own titled pane,
                so one above both only repeated them. */}
            {chartable && <OpportunityWaterfall pair={pair} notionalUsd={notionalUsd} />}
            {pair.execSpreadApr !== null &&
              pair.netFixedAprOnCapital !== null &&
              pair.capitalUsd !== null && (
                // The strip's own colour is `info` in every state: it frames
                // the summary rather than grading it, and the sign already
                // lives on the APR inside it.
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded bg-info/10 px-4 py-3 text-[12px] leading-[1.5] text-ink-100">
                  <span className={'mr-1.5 font-semibold text-ink-50'}>Net effect</span>
                  <span className="whitespace-nowrap">
                    Locks a{' '}
                    <span className="num font-semibold text-ink-50">
                      {fmtPct(pair.execSpreadApr, 1)}
                    </span>{' '}
                    funding spread at
                  </span>
                  {pair.effectiveLeverage !== null && Number.isFinite(pair.effectiveLeverage) && (
                    <span className="whitespace-nowrap">
                      <span className="num font-semibold text-ink-50">
                        {pair.effectiveLeverage.toFixed(1)}x
                      </span>{' '}
                      effective leverage →
                    </span>
                  )}
                  <span className="whitespace-nowrap">
                    <span className={`num font-semibold ${netTone}`}>
                      {(pair.netFixedAprOnCapital * 100).toFixed(1)}% APR
                    </span>{' '}
                    on{' '}
                    <span className="num font-semibold text-ink-50">
                      {fmtNotionalShort(pair.capitalUsd)}
                    </span>{' '}
                    capital
                  </span>
                </div>
              )}
  
          </div>
        )}
      </div>
    </div>
  );
});

/** "at 8.0% → 7.8% after impact" — the Boros leg's mid rate and what it locks. */
function RateNote({ midApr, execApr }: { midApr: number; execApr: number | null }) {
  // Only the rate this leg actually LOCKS. The mid → exec arrow that used to
  // sit here showed a number the trade never gets; the mid is still one hover
  // away, where it belongs as provenance rather than as a second headline.
  return (
    <span title={`Mid ${fmtPct(midApr, 1)} before book impact`}>
      at{' '}
      {execApr === null ? (
        <Dash why={THIN_BOOK_WHY} />
      ) : (
        <span className="num text-ink-50">{fmtPct(execApr, 1)}</span>
      )}{' '}
      after impact
    </span>
  );
}

export function OpportunitiesPanel() {
  const [stored] = useState<StoredControls>(() => loadControls());
  const [notionalChoice, setNotionalChoice] = useState<NotionalChoice>(stored.notionalChoice);
  // Always market-at-size. The "at mark rate" alternative priced cards at a
  // number no order could get, so the knob only made a card disagree with the
  // book under it. The stored value is still read for compatibility.
  const borosEntry: BorosEntryMode = 'market';
  const [entryMode, setEntryMode] = useState<EntryMode>(stored.entryMode);
  const [exitMode, setExitMode] = useState<ExitMode>(stored.exitMode);
  const [includeRebate, setIncludeRebate] = useState<boolean>(stored.includeRebate);
  const [sizeStr, setSizeStr] = useState(String(stored.customNotionalUsd));
  // The last VALID size: a half-typed entry must never blank the list.
  const [size, setSize] = useState(stored.customNotionalUsd);
  const debouncedSize = useDebounced(sizeStr, 400);
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

  const persist = (next: Partial<StoredControls>) =>
    writeJson(OPPORTUNITIES_STORAGE_KEY, {
      notionalChoice,
      customNotionalUsd: size,
      borosEntry,
      entryMode,
      exitMode,
      includeRebate,
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

  const query = useOpportunities({
    notionalUsd,
    borosEntry,
    entryMode,
    exitMode,
  });
  const data = query.data;

  // The account's settlement-fee rebate config (null when not rebated / no agent).
  // The chip shows whenever there IS an active rebate; the toggle decides whether
  // it lands in the APR. Every affordance stays hidden for a non-rebated account.
  const rebate = useRebate().data ?? null;
  const hasRebate = !!rebate && rebate.active;

  // Every viable PAIR, not one per group: a cohort with three markets offers
  // three venue combinations, and the two the group's best pair outranked are
  // still real trades — often on the only venue a given reader can reach.
  // `data.groups`, not `data`: meta.asOfSec moves on every poll, so keying on
  // the whole response would rebuild every card even when no number changed.
  /**
   * What the reader already holds, from the two light feeds the app polls
   * anyway: the live perp exposure and the Boros markets carrying a position.
   * Only with a tracked address — the landing build has neither.
   */
  const trackedAddress = useTrackedAddressOptional()?.address ?? null;
  const exposure = usePositions(trackedAddress !== null).data?.exposure;
  const borosMarkets = useBorosPairContext(trackedAddress).data?.markets;
  // The perp exposure is the logged-in account's: never pair it with another wallet's Boros legs.
  const viewOnly = useActiveWallet().viewOnly;
  const held = useMemo(() => {
    if (viewOnly || !exposure) return undefined;
    const books: HeldBook[] = exposure.map((g) => ({
      base: g.base,
      perps: g.legs.map((l) => ({ venue: l.exchange, side: l.side })),
      boros: (borosMarkets ?? [])
        .filter((m) => m.currentSize !== 0 && m.base.toUpperCase() === g.base.toUpperCase())
        .map((m) => ({ venue: m.venue, maturity: m.maturity })),
    }));
    return heldPerpsOf(books);
  }, [viewOnly, exposure, borosMarkets]);
  const pricedAtUsd = data?.meta.notionalUsd;
  const rows = useMemo(
    () =>
      toRows(
        data?.groups ?? [],
        shownKeysRef.current,
        held && pricedAtUsd !== undefined ? { held, notionalUsd: pricedAtUsd } : undefined,
        // Fold the rebate into ranking AND the viability cutoff exactly when the
        // cards credit it, so a pair only profitable after the rebate is neither
        // hidden nor mis-ranked against the discounted APR it displays.
        hasRebate && includeRebate && rebate && pricedAtUsd !== undefined
          ? { config: rebate, notionalUsd: pricedAtUsd }
          : null,
      ),
    [data?.groups, held, pricedAtUsd, hasRebate, includeRebate, rebate],
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
    [flow, pricedNotionalUsd, entryMode],
  );

  const controls = (
    <div className="mb-5 flex flex-wrap items-end gap-x-8 gap-y-5 rounded border border-wash/[0.14] bg-wash/[0.07] p-5">
      {/* One row, nothing folded away: the size every card is priced at, the
          two execution assumptions, the clock. With the account connected
          there is no fee tier to simulate, and two knobs do not earn a panel
          of their own. */}
      <div className="flex flex-col items-start gap-1.5">
        <div className={microLabelClass}>Notional per leg</div>
        <div className="flex flex-wrap items-center gap-2">
        <span
          className={`flex h-9 items-center gap-1 rounded border border-ink-800/50 bg-wash/[0.05] px-2.5 focus-within:border-info/70 ${
            sizeBad ? 'border-guava/60' : 'border-ink-600'
          }`}
        >
          <span className="text-[11.5px] text-ink-400">$</span>
          {notionalChoice === 'custom' ? (
            <input
              id={sizeId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Custom notional (USD)"
              value={sizeStr}
              onChange={(e) => setSizeStr(e.target.value)}
              title="The notional each leg is priced at."
              className="num w-24 bg-transparent text-sm font-semibold text-ink-50 outline-none placeholder:text-ink-500"
            />
          ) : (
            <span className="num text-sm font-semibold text-ink-50">
              {notionalUsd.toLocaleString('en-US')}
            </span>
          )}
        </span>
        {/* The one and only notional control. It used to be repeated inside
            the advanced panel as a second segmented toggle. */}
        <span role="radiogroup" aria-label="Notional" className="inline-flex items-center">
          {NOTIONAL_OPTIONS.map((o) => {
            const on = notionalChoice === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setNotionalChoice(o.value);
                  persist({ notionalChoice: o.value });
                }}
                className={`num -mr-px inline-flex h-[35px] items-center whitespace-nowrap border px-5 text-[12px] transition-colors first:rounded-l last:mr-0 last:rounded-r ${
                  on
                    ? 'relative z-[1] border-ink-700 bg-wash/[0.15] font-medium text-ink-300'
                    : 'border-ink-700 text-ink-500 hover:bg-wash/[0.05]'
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </span>
        </div>
        {sizeErr && (
          <span role="alert" className="text-[10.5px] text-guava">
            {sizeErr}
          </span>
        )}
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <div className={microLabelClass}>Perp entry</div>
        <SegmentedToggle<EntryMode>
          className="seg-info seg-lg"
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
          className="seg-info seg-lg"
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
      </div>

      {hasRebate && (
        <div className="flex flex-col items-start gap-1.5">
          <div className={microLabelClass}>Settlement rebate</div>
          <label
            className="flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap text-[12px] text-ink-200"
            title={`Credit this account's Boros settlement-fee rebate (${rebateChipLabel(rebate as Rebate)}) into every APR, Return and profit.`}
          >
            <input
              type="checkbox"
              className="chk"
              checked={includeRebate}
              onChange={(e) => {
                setIncludeRebate(e.target.checked);
                persist({ includeRebate: e.target.checked });
              }}
            />
            Include rebate in APR
          </label>
        </div>
      )}

        <span className="ml-auto flex items-center gap-2">
          {query.isPlaceholderData && <span className="text-xs text-ink-400">recomputing…</span>}
          <StrategyFreshness
            dataUpdatedAt={query.dataUpdatedAt || 0}
            staleError={query.isError && data !== undefined}
            onRefetch={() => void query.refetch()}
          />
        </span>
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
          hint={`No Boros arb pair prices out at ${fmtUsd(notionalUsd, 0)} notional at market size, ${ENTRY_MODE_PROSE[entryMode]} perp entry and ${EXIT_MODE_PROSE[exitMode]}. Try another notional or another assumption.`}
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
              held={row.held}
              notionalUsd={pricedNotionalUsd}
              rebate={hasRebate ? rebate : null}
              includeRebate={includeRebate}
              onOpenStrategy={flow ? openStrategy : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
