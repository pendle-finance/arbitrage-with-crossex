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
 * Owns the persisted assumptions — capital, Boros entry, perp entry, exit and
 * the simulated VIP tier, each an independent knob — and the single query they
 * drive. Executing only PREFILLS the pair ticket — submission stays behind its
 * hold-to-confirm control.
 */
import { ArrowRight, ArrowUpRight, Info } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { amountError } from '../lib/amount';
import {
  isValidOpportunitySize,
  opportunitySizeBounds,
  PERP_SLIPPAGE_CLIP_USD,
  useBorosPairContext,
  useOpportunities,
  usePositions,
  useRebate,
} from '../api/queries';
import type {
  BorosEntryMode,
  EntryMode,
  ExitMode,
  OpportunityBorosLeg,
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
import { SpreadIcon, TokenIcon, VenueIcon } from '../components/AssetIcon';
import { SideVenue } from '../components/VenueChip';
import { borosMarketUrl, isUsdCollateral } from '../lib/boros';
import { spreadName } from '../lib/spread';
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
import { heldBorosOf, heldPerpsOf, repriceHeld, type HeldBook, type HeldTag } from './heldPerps';
import { applyRebate } from './opportunityRebate';
import { rebateAccountLabel, rebateAppliesTo, rebateChipLabel, rebateLegsNote } from '../lib/rebate';
import { useActiveWallet, useTrackedAddressOptional } from './trackedAddress';
import {
  applyFilters,
  hasActiveFilter,
  loadFilters,
  maturityDays,
  NO_FILTERS,
  saveFilters,
  toRows,
  type OpportunityFilters,
} from './opportunityFilters';
import { localizeServerText } from '../i18n/serverMessages';

export const OPPORTUNITIES_STORAGE_KEY = 'crossex.opportunities.v2';

/** v1 coupled the notional to the Boros entry mode ('market-100k'); v2 splits
 * them into two independent knobs, so v1 blobs are migrated once and dropped. */
const LEGACY_STORAGE_KEY = 'crossex.opportunities.v1';

/** Shortcuts that fill the size box. The box is the size; a preset is lit only
 * while the box holds exactly its amount. */
type SizePreset = '10k' | '100k' | '500k' | '1m';

const SIZE_PRESETS: { value: SizePreset; label: string; usd: number }[] = [
  { value: '10k', label: '$10k', usd: 10_000 },
  { value: '100k', label: '$100k', usd: 100_000 },
  { value: '500k', label: '$500k', usd: 500_000 },
  { value: '1m', label: '$1M', usd: 1_000_000 },
];

const ENTRY_MODE_LABEL = {
  'both-market': 'opportunities.panel.entryBothMarket',
  'maker-hedge': 'opportunities.panel.entryMakerHedge',
} as const satisfies Record<EntryMode, string>;

const EXIT_MODE_LABEL = {
  close: 'opportunities.panel.exitClose',
  roll: 'opportunities.panel.exitRoll',
} as const satisfies Record<ExitMode, string>;

/** Long-form forms of the same knobs — the buttons are terse, the summary line
 * and the empty state read as sentences. */
const ENTRY_MODE_PROSE = {
  'both-market': 'opportunities.panel.entryProseBothMarket',
  'maker-hedge': 'opportunities.panel.entryProseMakerHedge',
} as const satisfies Record<EntryMode, string>;

const EXIT_MODE_PROSE = {
  close: 'opportunities.panel.exitProseClose',
  roll: 'opportunities.panel.exitProseRoll',
} as const satisfies Record<ExitMode, string>;

export interface StoredControls {
  /** Every card is sized by capital: it is what the APR is on, and what a
   * trader budgets. */
  capitalUsd: number;
  borosEntry: BorosEntryMode;
  entryMode: EntryMode;
  exitMode: ExitMode;
  /** Credit the account's settlement-fee rebate into every APR. Default on —
   * the rebate is a real, unconditional discount for a rebated account. Only
   * ever shown/applied when the account has a rebate at all. */
  includeRebate: boolean;
}

const DEFAULTS: StoredControls = {
  capitalUsd: 200_000,
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

/** The saved capital. Saves from 1.7.7 hold a preset name beside a separate
 * custom size, and the preset name wins, as it did on screen. A saved notional
 * size is dropped: the same figure means a ~7× smaller trade as capital. */
const storedCapital = (
  usd: unknown,
  legacyChoice: unknown,
  legacyCustom: unknown,
  fallback: number,
): number => {
  if (typeof usd === 'number' && isValidOpportunitySize('capital', usd)) return usd;
  const preset = SIZE_PRESETS.find((o) => o.value === legacyChoice);
  if (preset) return preset.usd;
  if (legacyChoice === 'custom' && typeof legacyCustom === 'number' && isValidOpportunitySize('capital', legacyCustom))
    return legacyCustom;
  return fallback;
};

/** v1 → v2: keep the entry and exit modes. v1's size was a notional, so the
 * capital starts at its default, and v1's 'mark' choice has no home any more —
 * every card is priced market-at-size. */
function migrateLegacy(): StoredControls | null {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (raw === null) return null;
  const p = JSON.parse(raw) as { entryMode?: unknown; exitMode?: unknown } | null;
  return {
    ...DEFAULTS,
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
          capitalUsd?: unknown;
          capitalChoice?: unknown;
          customCapitalUsd?: unknown;
          borosEntry?: unknown;
          entryMode?: unknown;
          exitMode?: unknown;
          includeRebate?: unknown;
        }
      | null;
    return {
      capitalUsd: storedCapital(p?.capitalUsd, p?.capitalChoice, p?.customCapitalUsd, base.capitalUsd),
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
const THIN_BOOK_WHY = 'opportunities.card.thinBookWhy';

/**
 * Warning chips for one card, derived only from the pair's own field status.
 * The server's warnings are full prose sentences, not codes — they read as the
 * notes they are, in the hero's title, never squeezed into an inline badge.
 */
function cardChips(pair: OpportunityPair): CardChip[] {
  const chips: CardChip[] = [];
  if (pair.execSpreadApr === null) {
    chips.push({ key: 'thin', label: t('opportunities.card.chipThin'), title: t(THIN_BOOK_WHY) });
  }
  if (pair.costs.totalUsd === null) {
    chips.push({
      key: 'costs',
      label: t('opportunities.card.chipCosts'),
      title: t('opportunities.card.chipCostsTitle'),
    });
  }
  for (const [side, leg] of [
    ['short', pair.shortLeg],
    ['long', pair.longLeg],
  ] as const) {
    if (!leg.crossexSymbol) {
      chips.push({
        key: `sym:${side}`,
        label: t('opportunities.card.chipNoSymbol', { venue: prettyVenue(leg.venue) }),
        title: t('opportunities.card.chipNoSymbolTitle', { venue: prettyVenue(leg.venue), base: leg.base }),
      });
    }
  }
  return chips;
}

/** The one sentence every null capital number carries. */
const CAPITAL_WHY = 'opportunities.card.capitalWhy';

/** The hero's title: same wording as the Positions card, plus what "capital"
 * means for a trade that isn't open yet. */
const CAPITAL_APR_TITLE = 'opportunities.card.capitalAprTitle';

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
  const { t } = useTranslation();
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
            title={t(side === 'short' ? 'opportunities.card.openOnBorosShort' : 'opportunities.card.openOnBorosLong')}
            /* The visible label is the mock's bare "Short BTC" + a Boros tag; the
               tag disambiguates it on screen, but a link's accessible name has to
               stand alone, so it says which book and which rate it is. */
            aria-label={t('opportunities.card.fundingOnBoros', { label })}
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
  icon,
  why,
  fixedApr,
  positive,
  wide = false,
  children,
}: {
  venue: string;
  icon?: ReactNode;
  why?: string;
  fixedApr: number | null;
  /** Receives fixed (green, unsigned) vs pays fixed (guava, "−"). */
  positive: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`min-w-0 rounded border border-wash/10 p-5${wide ? ' xl:col-span-2' : ''}`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {icon ?? <VenueIcon venue={venue} size={20} />}
        <span className="whitespace-nowrap text-[16px] font-bold leading-[19.36px] text-ink-50">{venue}</span>
        {why && <span className="whitespace-nowrap text-[12px] text-ink-500">{why}</span>}
        {fixedApr !== null && Number.isFinite(fixedApr) && (
          <span
            className={`num ml-auto whitespace-nowrap rounded px-3 py-1.5 text-[14px] font-bold ${
              positive ? 'bg-grass/10 text-grass' : 'bg-guava/10 text-guava'
            }`}
          >
            {t('opportunities.card.fixedApr', { apr: `${positive ? '' : '−'}${fmtPct(Math.abs(fixedApr), 1)}` })}
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
  const { t } = useTranslation();
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
  // THIS pair's own notional: under a capital target each pair solves its own.
  const notionalUsd = served.notionalUsd;
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
  const rebatedLegs = rebate ? pair.borosLegs.filter((leg) => rebateAppliesTo(rebate, leg.marketId)) : [];
  const rebatedMarketIds = rebatedLegs.map((leg) => leg.marketId);
  const rebateChip = rebate && rebatedLegs.length > 0 ? rebate : null;
  const rebateLegs = rebateChip ? rebateLegsNote(rebateChip, rebatedLegs) : '';
  const chips = cardChips(pair);
  const spreadLeg = pair.borosLegs.find((leg) => leg.spreadVenues !== null) ?? null;
  const shortBoros = pair.borosLegs.find((leg) => leg.side === 'SHORT');
  const longBoros = pair.borosLegs.find((leg) => leg.side === 'LONG');
  // Only the PAIR's own reasons — they explain this card's own numbers. The
  // group's warnings are about the other markets in the cohort ("… has no
  // CrossEx perp venue"), and those rows stopped being displayed with the
  // markets table.
  const reasons = [...new Set(pair.reasons)].map(localizeServerText);
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
  const days = maturityDays(group.secondsToMaturity);
  const maturityTitle = t('opportunities.card.maturityTitle', {
    date: fmtDateLocal(group.maturity),
    left: fmtAge(group.secondsToMaturity * 1000),
  });
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
    ? t('opportunities.card.basesDiffer', { short: pair.shortLeg.base, long: pair.longLeg.base })
    : noSymbols
      ? t('opportunities.card.noSymbols', {
          short: prettyVenue(pair.shortLeg.venue),
          long: prettyVenue(pair.longLeg.venue),
          base: pair.base,
        })
      : t('opportunities.card.executeTitle');
  const detailsDisabled =
    !canChartProfit(pair) && !canChartCapital(pair) && pair.execSpreadApr === null;
  const detailsTitle = detailsDisabled
    ? t('opportunities.card.detailsDisabled')
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
          title={t('opportunities.card.baseFunding', { base })}
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
              ? t('opportunities.card.heldSoonerTitle')
              : t('opportunities.card.hasPerpsTitle')
          }
        >
          <input type="checkbox" className="chk" checked={hasPerps} onChange={(e) => setHasPerpsChoice(e.target.checked)} />
          {t('opportunities.card.hasPerps')}
        </label>
        {rebateChip && (
          <Chip
            sm
            tone="green"
            title={
              rebateLegs
                ? t('opportunities.card.rebateLegsTitle', { legs: rebateLegs })
                : rebateChip.startTimestamp
                  ? t('opportunities.card.rebateSinceTitle', { date: fmtDateLocal(rebateChip.startTimestamp) })
                  : t('opportunities.card.rebateTitle')
            }
          >
            {rebateChipLabel(rebateChip, rebatedMarketIds)}
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
          {t('opportunities.card.matures', { date: fmtDateLocal(group.maturity) })}
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
                title={reasons.length > 0 ? reasons.join('\n') : t(CAPITAL_WHY)}
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
                    ? `${t(CAPITAL_APR_TITLE)}\n\n${reasons.join('\n')}`
                    : t(CAPITAL_APR_TITLE)
                }
              >
                {(capitalApr * 100).toFixed(1)}%
              </span>
            )}
            {/* "APR" is its own muted label in the mock, not part of the
                number — the figure stays the loudest thing on the card. */}
            <span className="text-sm font-medium text-ink-200">{t('common.apr')}</span>
            <span className="text-[12.5px] text-ink-400" title={maturityTitle}>
              {t('opportunities.card.days', { days })}
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
              aria-label={t(open ? 'opportunities.card.hideDetailsFor' : 'opportunities.card.showDetailsFor', {
                base,
                short: prettyVenue(pair.shortLeg.venue),
                long: prettyVenue(pair.longLeg.venue),
                collateral: group.collateral,
                date: fmtDateLocal(group.maturity),
              })}
              disabled={detailsDisabled}
              title={detailsTitle}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? t('opportunities.card.hideDetails') : t('opportunities.card.moreDetails')}
            </button>
            </span>
            <Stat label={t('common.capital')} tip>
              {capitalUsd === null ? (
                <Dash why={t(CAPITAL_WHY)} />
              ) : (
                <span title={t(spreadLeg ? 'opportunities.card.capitalTitleThree' : 'opportunities.card.capitalTitleFour')}>
                  ~{fmtUsd(capitalUsd, 0)}
                </span>
              )}
            </Stat>
            <Stat label={t('opportunities.card.return')} tip>
              {estProfitUsd === null ? (
                <Dash why={t('opportunities.card.noNetApr')} />
              ) : (
                <span
                  className={estProfitUsd < 0 ? 'text-rose-400' : undefined}
                  title={t('opportunities.card.returnTitle', { notional: fmtUsd(notionalUsd, 0) })}
                >
                  {fmtUsd(estProfitUsd, 0)}
                </span>
              )}
            </Stat>
            <Stat label={t('common.notional')}>
              <span
                title={
                  collateralQty
                    ? t('opportunities.card.notionalTitleQty', {
                        notional: fmtUsd(notionalUsd, 0),
                        qty: sig(collateralQty.qty),
                        symbol: collateralQty.symbol,
                      })
                    : t('opportunities.card.notionalTitle', { notional: fmtUsd(notionalUsd, 0) })
                }
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
              <Stat label={t('opportunities.card.grossSpread')}>
                <span
                  className="text-amber-400"
                  title={t('opportunities.card.grossSpreadTitle')}
                >
                  {fmtPct(pair.grossSpreadApr, 1)}
                </span>{' '}
                <span className="text-[10px] text-amber-400/80">{t('opportunities.card.grossOnly')}</span>
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
              aria-label={t('opportunities.card.openStrategyFor', {
                base,
                short: prettyVenue(pair.shortLeg.venue),
                long: prettyVenue(pair.longLeg.venue),
                collateral: group.collateral,
                date: fmtDateLocal(group.maturity),
              })}
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
              {t('opportunities.card.openStrategy')} <ArrowRight size={14} aria-hidden className="inline" />
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
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
              <span className="whitespace-nowrap text-[11.5px] text-ink-200">
                <Trans
                  i18nKey={spreadLeg ? 'opportunities.card.legsEachThree' : 'opportunities.card.legsEachFour'}
                  values={{
                    notional: `${fmtNotionalShort(notionalUsd)}${
                      collateralQty ? ` (${fmtTokenQty(collateralQty.qty, collateralQty.symbol)})` : ''
                    }`,
                  }}
                  components={{ hl: <span className="text-link" /> }}
                />
              </span>
              <span aria-hidden="true" className="min-w-[24px] flex-1 border-t border-dashed border-ink-300/25" />
              <span className="whitespace-nowrap rounded-full border border-wash/[0.15] bg-ink-950/60 px-4 py-[5px] text-[12px] text-ink-300">
                {t('opportunities.card.netsToZero')}
              </span>
            </div>
            {/* Two columns only from xl: the content column is the viewport less
                ~400px of chrome, so at md each box would be ~175px and the rows
                below would overflow. */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <VenueBox
                venue={prettyVenue(pair.shortLeg.venue)}
                why={t('opportunities.card.fundingRich')}
                fixedApr={spreadLeg || !shortBoros ? null : (shortBoros.execApr ?? shortBoros.midApr)}
                positive
              >
                <LegRow
                  n={1}
                  side="short"
                  label={t('opportunities.card.shortBase', { base })}
                  kind="CrossEx"
                  note={
                    pair.capital.shortLeverageMax === null
                      ? ''
                      : t('opportunities.card.upToLeverage', { max: pair.capital.shortLeverageMax })
                  }
                />
                {!spreadLeg && shortBoros && (
                  <BorosLegRow n={2} leg={shortBoros} label={t('opportunities.card.shortBase', { base })} />
                )}
              </VenueBox>
              <VenueBox
                venue={prettyVenue(pair.longLeg.venue)}
                why={t('opportunities.card.fundingCheap')}
                fixedApr={spreadLeg || !longBoros ? null : (longBoros.execApr ?? longBoros.midApr)}
                positive={false}
              >
                <LegRow
                  n={spreadLeg ? 2 : 3}
                  side="long"
                  label={t('opportunities.card.longBase', { base })}
                  kind="CrossEx"
                  note={
                    pair.capital.longLeverageMax === null
                      ? ''
                      : t('opportunities.card.upToLeverage', { max: pair.capital.longLeverageMax })
                  }
                />
                {!spreadLeg && longBoros && (
                  <BorosLegRow n={4} leg={longBoros} label={t('opportunities.card.longBase', { base })} />
                )}
              </VenueBox>
              {spreadLeg?.spreadVenues && (
                <VenueBox
                  venue={spreadName(base, spreadLeg.spreadVenues)}
                  icon={<SpreadIcon venues={spreadLeg.spreadVenues} size={20} />}
                  fixedApr={spreadLeg.execApr ?? spreadLeg.midApr}
                  positive={(spreadLeg.side === 'SHORT' ? 1 : -1) * (spreadLeg.execApr ?? spreadLeg.midApr) >= 0}
                  wide
                >
                  <BorosLegRow
                    n={3}
                    leg={spreadLeg}
                    label={t(spreadLeg.side === 'SHORT' ? 'opportunities.card.shortBase' : 'opportunities.card.longBase', {
                      base: spreadName(base, spreadLeg.spreadVenues),
                    })}
                  />
                </VenueBox>
              )}
            </div>
            {/* Kept from the app: the mock never says this, but it is the one
                line that explains why four legs are not four risks. */}
            <div className="text-[11px] leading-relaxed text-ink-400">
              {t('opportunities.card.deltaNeutralNote')}
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
                  <span className={'mr-1.5 font-semibold text-ink-50'}>{t('opportunities.card.netEffect')}</span>
                  <span className="whitespace-nowrap">
                    <Trans
                      i18nKey="opportunities.card.netLocks"
                      values={{ spread: fmtPct(pair.execSpreadApr, 1) }}
                      components={{ b: <span className="num font-semibold text-ink-50" /> }}
                    />
                  </span>
                  {pair.effectiveLeverage !== null && Number.isFinite(pair.effectiveLeverage) && (
                    <span className="whitespace-nowrap">
                      <Trans
                        i18nKey="opportunities.card.netLeverage"
                        values={{ lev: `${pair.effectiveLeverage.toFixed(1)}x` }}
                        components={{ b: <span className="num font-semibold text-ink-50" /> }}
                      />
                    </span>
                  )}
                  <span className="whitespace-nowrap">
                    <Trans
                      i18nKey="opportunities.card.netApr"
                      values={{
                        apr: `${(pair.netFixedAprOnCapital * 100).toFixed(1)}%`,
                        capital: fmtNotionalShort(pair.capitalUsd),
                      }}
                      components={{
                        apr: <span className={`num font-semibold ${netTone}`} />,
                        b: <span className="num font-semibold text-ink-50" />,
                      }}
                    />
                  </span>
                </div>
              )}
  
          </div>
        )}
      </div>
    </div>
  );
});

function BorosLegRow({ n, leg, label }: { n: number; leg: OpportunityBorosLeg; label: string }) {
  const side = leg.side === 'SHORT' ? 'short' : 'long';
  return (
    <LegRow
      n={n}
      side={side}
      label={label}
      kind="Boros"
      note={<RateNote midApr={leg.midApr} execApr={leg.execApr} />}
      href={borosMarketUrl(leg.marketId, side)}
    />
  );
}

/** "at 8.0% → 7.8% after impact" — the Boros leg's mid rate and what it locks. */
function RateNote({ midApr, execApr }: { midApr: number; execApr: number | null }) {
  // Only the rate this leg actually LOCKS. The mid → exec arrow that used to
  // sit here showed a number the trade never gets; the mid is still one hover
  // away, where it belongs as provenance rather than as a second headline.
  return (
    <span title={t('opportunities.card.midTitle', { mid: fmtPct(midApr, 1) })}>
      <Trans
        i18nKey="opportunities.card.afterImpact"
        values={{ apr: execApr === null ? '' : fmtPct(execApr, 1) }}
        components={{ v: execApr === null ? <Dash why={t(THIN_BOOK_WHY)} /> : <span className="num text-ink-50" /> }}
      />
    </span>
  );
}

export function OpportunitiesPanel() {
  const { t } = useTranslation();
  const [stored] = useState<StoredControls>(() => loadControls());
  // Always market-at-size. The "at mark rate" alternative priced cards at a
  // number no order could get, so the knob only made a card disagree with the
  // book under it. The stored value is still read for compatibility.
  const borosEntry: BorosEntryMode = 'market';
  const [entryMode, setEntryMode] = useState<EntryMode>(stored.entryMode);
  const [exitMode, setExitMode] = useState<ExitMode>(stored.exitMode);
  const [includeRebate, setIncludeRebate] = useState<boolean>(stored.includeRebate);
  const [sizeStr, setSizeStr] = useState(String(stored.capitalUsd));
  const [sizeFocused, setSizeFocused] = useState(false);
  // The last VALID capital: a half-typed entry must never blank the list.
  const [capitalUsd, setCapitalUsd] = useState(stored.capitalUsd);
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

  const persist = (next: Partial<StoredControls>) =>
    writeJson(OPPORTUNITIES_STORAGE_KEY, {
      capitalUsd,
      borosEntry,
      entryMode,
      exitMode,
      includeRebate,
      ...next,
    } satisfies StoredControls);

  const setSize = (usd: number) => {
    setCapitalUsd(usd);
    persist({ capitalUsd: usd });
  };

  useEffect(() => {
    const n = Number(debouncedSize);
    if (!isValidOpportunitySize('capital', n)) return;
    setSize(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSize]);

  const sizeUsd = capitalUsd;
  const sizeErr = amountError(sizeStr, opportunitySizeBounds('capital'));
  const sizeBad = !isValidOpportunitySize('capital', Number(sizeStr));
  // Grouped digits while the box is at rest; raw digits while typing, since
  // amountError refuses commas.
  const sizeShown = sizeFocused || sizeBad ? sizeStr : Number(sizeStr).toLocaleString('en-US');

  const query = useOpportunities({
    sizeBy: 'capital',
    sizeUsd,
    borosEntry,
    entryMode,
    exitMode,
  });
  const data = query.data;

  // The account's settlement-fee rebate config (null when not rebated / no agent).
  // The chip shows whenever there IS an active rebate; the toggle decides whether
  // it lands in the APR. Every affordance stays hidden for a non-rebated account.
  // The rebate is the logged-in owner's: a view-only wallet does not see it.
  const viewOnly = useActiveWallet().viewOnly;
  const ownRebate = useRebate().data ?? null;
  const rebate = viewOnly ? null : ownRebate;
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
  const pairContext = useBorosPairContext(trackedAddress).data;
  const borosMarkets = pairContext?.markets;
  const spreadMarkets = pairContext?.spreadMarkets;
  const held = useMemo(() => {
    if (!exposure) return undefined;
    const books: HeldBook[] = exposure.map((g) => ({
      base: g.base,
      perps: g.legs.map((l) => ({ venue: l.exchange, side: l.side })),
      boros: heldBorosOf([...(borosMarkets ?? []), ...(spreadMarkets ?? [])], g.base),
    }));
    return heldPerpsOf(books);
  }, [exposure, borosMarkets, spreadMarkets]);
  const rows = useMemo(
    () =>
      toRows(
        data?.groups ?? [],
        shownKeysRef.current,
        held,
        // Fold the rebate into ranking AND the viability cutoff exactly when the
        // cards credit it, so a pair only profitable after the rebate is neither
        // hidden nor mis-ranked against the discounted APR it displays.
        hasRebate && includeRebate ? rebate : null,
      ),
    [data?.groups, held, hasRebate, includeRebate, rebate],
  );
  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters]);

  // What the NEXT toRows call treats as already on screen — the hysteresis band
  // that stops near-zero pairs flickering in and out under the reader's cursor.
  useEffect(() => {
    shownKeysRef.current = new Set(rows.map((r) => r.key));
  }, [rows]);

  // Any card past one perp clip has its slippage priced at the clip's rate.
  const slippageClipped = visible.some((r) => r.pair.notionalUsd > PERP_SLIPPAGE_CLIP_USD);

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
        // The pair's own priced notional, never the live control: during a
        // size change `keepPreviousData` shows cards costed at the OLD size,
        // and arming the ticket at the new one would stage a trade none of the
        // numbers on screen describe.
        notionalUsd: Math.round(pair.notionalUsd),
        // Present only for token-margined cohorts, where the collateral IS the
        // base coin and every leg can be sized in the same unit.
        ...(sizeBase !== undefined && sizeBase > 0 ? { sizeBase } : {}),
        perpMode: entryMode === 'maker-hedge' ? 'maker' : 'market',
      });
    },
    [flow, entryMode],
  );

  // One row of fields, each a label over one 35px control, that wraps when
  // the card is too narrow. The perp knobs sit in their own wrapping group so
  // a wrap moves them together; a flat wrap split them across rows.
  const field = 'flex flex-col items-start gap-1.5';
  const row = 'flex flex-wrap items-end gap-x-8 gap-y-4';
  const controls = (
    <div className="mb-5 flex flex-col gap-4 rounded border border-wash/[0.14] bg-wash/[0.07] p-5">
      <div className={row}>
        <div className={field}>
          <div className={microLabelClass}>{t('common.capital')}</div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex h-[35px] w-[7.5rem] items-center gap-1 rounded border bg-wash/[0.05] px-2.5 focus-within:border-info/70 ${
                sizeBad ? 'border-guava/60' : 'border-ink-700'
              }`}
            >
              <span className="text-[11.5px] text-ink-400">$</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-label={t('opportunities.panel.capitalAria')}
                value={sizeShown}
                onChange={(e) => setSizeStr(e.target.value)}
                onFocus={() => setSizeFocused(true)}
                onBlur={() => setSizeFocused(false)}
                title={t('opportunities.panel.capitalTitle')}
                className="num w-full min-w-0 bg-transparent text-sm font-semibold text-ink-50 outline-none placeholder:text-ink-500"
              />
            </span>
            <SegmentedToggle<SizePreset | ''>
              className="seg-info seg-lg max-sm:[&_.seg-btn]:px-3"
              ariaLabel={t('opportunities.panel.capitalPresets')}
              value={SIZE_PRESETS.find((o) => o.usd === sizeUsd)?.value ?? ''}
              onChange={(v) => {
                const usd = SIZE_PRESETS.find((o) => o.value === v)?.usd;
                if (usd === undefined) return;
                setSizeStr(String(usd));
                setSize(usd);
              }}
              options={SIZE_PRESETS}
            />
          </div>
        </div>

        <div className={row}>
          <div className={field}>
            <div className={microLabelClass}>{t('opportunities.panel.perpEntry')}</div>
            <SegmentedToggle<EntryMode>
              className="seg-info seg-lg"
              ariaLabel={t('opportunities.panel.perpEntryAria')}
              value={entryMode}
              onChange={(next) => {
                setEntryMode(next);
                persist({ entryMode: next });
              }}
              options={[
                { value: 'both-market', label: t(ENTRY_MODE_LABEL['both-market']) },
                { value: 'maker-hedge', label: t(ENTRY_MODE_LABEL['maker-hedge']) },
              ]}
            />
          </div>

          <div className={field}>
            <div className={microLabelClass}>{t('opportunities.panel.perpExit')}</div>
            <SegmentedToggle<ExitMode>
              className="seg-info seg-lg"
              ariaLabel={t('opportunities.panel.perpExitAria')}
              value={exitMode}
              onChange={(next) => {
                setExitMode(next);
                persist({ exitMode: next });
              }}
              options={[
                { value: 'close', label: t(EXIT_MODE_LABEL.close) },
                { value: 'roll', label: t(EXIT_MODE_LABEL.roll) },
              ]}
            />
          </div>

          {hasRebate && (
            <div className={field}>
              <div className={microLabelClass}>{t('opportunities.panel.settlementRebate')}</div>
              <label
                className="flex h-[35px] cursor-pointer items-center gap-2 whitespace-nowrap text-[12px] text-ink-200"
                title={t('opportunities.panel.includeRebateTitle', { account: rebateAccountLabel(rebate as Rebate) })}
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
                {t('opportunities.panel.includeRebate')}
              </label>
            </div>
          )}
        </div>

        <span className="ml-auto flex h-[35px] items-center gap-2">
          {query.isPlaceholderData && <span className="text-xs text-ink-400">{t('opportunities.panel.recomputing')}</span>}
          <StrategyFreshness
            dataUpdatedAt={query.dataUpdatedAt || 0}
            staleError={query.isError && data !== undefined}
            onRefetch={() => void query.refetch()}
          />
        </span>
      </div>

      {sizeErr && (
        <span role="alert" className="text-[11px] text-guava">
          {sizeErr}
        </span>
      )}
      {/* Above one clip the cards price perp slippage as a TWAP in $1M
          orders (src/core/boros/opportunities.ts). The open ticket still
          walks the full book. */}
      {slippageClipped && (
        <span className="flex items-start gap-1.5 text-[11px] text-ink-400">
          <Info size={12} aria-hidden className="mt-px flex-none text-amber-400" />
          {t('opportunities.panel.slippageClipped')}
        </span>
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
        <QueryError title={t('opportunities.panel.loadError')} error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <div>
      {controls}
      {data && <Notes items={data.warnings.map(localizeServerText)} className="mb-2" />}
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
          title={t('opportunities.panel.emptyTitle')}
          hint={t('opportunities.panel.emptyHint', {
            capital: fmtUsd(sizeUsd, 0),
            entry: t(ENTRY_MODE_PROSE[entryMode]),
            exit: t(EXIT_MODE_PROSE[exitMode]),
          })}
        />
      ) : visible.length === 0 ? (
        // Distinct from the one above: the assumptions DO price opportunities,
        // the filters are just hiding all of them — so the fix is here, not in
        // the assumptions strip.
        <EmptyState
          icon="◎"
          title={t('opportunities.panel.noMatchTitle')}
          hint={t('opportunities.panel.noMatchHint', { count: rows.length })}
          action={
            hasActiveFilter(filters) ? (
              <button type="button" className="btn" onClick={() => updateFilters(NO_FILTERS)}>
                {t('opportunities.panel.clearFilters')}
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
