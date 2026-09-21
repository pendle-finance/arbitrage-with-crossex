/** PairTicket sub-renders: the LONG/SHORT venue selects, the maker-hedge
 * controls, the estimate card (per-leg table, costs, leverage, margin) and
 * the shared row/affix primitives the single ticket reuses. Pure/prop-driven —
 * PairTicket owns all state and the preview query. */
import { useMemo, useState, type ReactNode } from 'react';
import type { PreviewResult, SymbolRule } from '../api/types';
import { Chip } from '../components/Chip';
import { VenueIcon } from '../components/AssetIcon';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { bpsOf, fmtAge, fmtUsd, parseSymbol, prettyVenue, sig } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { estFeeOf, PreviewFallback, SlippageBadge, ViolationList } from './previewBits';
import { FieldLabel } from './SymbolCombobox';

export type ExecMode = 'market' | 'maker';
export const TIMEOUT_CHOICES = [
  { value: '60', label: '1m' },
  { value: '300', label: '5m' },
  { value: '900', label: '15m' },
] as const;
export type TimeoutChoice = (typeof TIMEOUT_CHOICES)[number]['value'];

function dedupeByMessage<T extends { message: string }>(list: T[]): T[] {
  return [...new Map(list.map((v) => [v.message, v])).values()];
}

// ---------------------------------------------------------------------------
// Primitives shared by both perp tickets
// ---------------------------------------------------------------------------

/** An input with a fixed unit (or a control) pinned inside its right edge. */
export function AffixedInput({ affix, children }: { affix: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] text-ink-400 [&>*]:pointer-events-auto">
        {affix}
      </div>
    </div>
  );
}

/** One "label … value" line of the estimate card. `sub` is a dim
 * qualification beside the label; `title` is hover text on the label. */
export function EstimateRow({
  label,
  sub,
  value,
  title,
  strong,
}: {
  label: ReactNode;
  sub?: ReactNode;
  value: ReactNode;
  title?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex items-baseline gap-1.5 text-[12px] text-ink-200" title={title}>
        <span>{label}</span>
        {sub && <span className="text-[11px] text-ink-400">{sub}</span>}
      </span>
      <span className={`num text-right text-[12.5px] ${strong ? 'font-semibold text-ink-50' : 'text-ink-50'}`}>{value}</span>
    </div>
  );
}

/** A small numbered disc — the order of things, without a word of prose. */
export function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="num inline-flex h-[18px] w-[18px] shrink-0 -translate-y-px items-center justify-center rounded-full border border-info/60 bg-info/15 text-[10.5px] font-semibold leading-none text-pastel-blue"
    >
      {n}
    </span>
  );
}

/** The estimate card's frame: an "ESTIMATE" caption, the preview's age, and
 * whatever the caller puts in the top-right (the pair's Book toggle). */
export function EstimateCard({
  dataUpdatedAt,
  estimating,
  isError,
  aside,
  label = 'Estimate',
  sub,
  step,
  children,
}: {
  dataUpdatedAt: number;
  estimating: boolean;
  isError: boolean;
  aside?: ReactNode;
  /** A step number before the caption, when the card is one of an ordered
   * sequence (a roll's 1 Exit → 2 Re-entry). */
  step?: number;
  /** The caption — "Estimate" unless the card is one of several (a roll's
   * Exit / Re-entry). */
  label?: string;
  /** A dim qualifier after the caption, e.g. the maturity a batch trades at. */
  sub?: ReactNode;
  children: ReactNode;
}) {
  const now = useNow(1_000);
  const age = dataUpdatedAt > 0 ? fmtAge(now - dataUpdatedAt) : null;
  return (
    <div className="flex flex-col gap-2.5 card px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-2">
          {step !== undefined && <StepBadge n={step} />}
          {/* A card that is one of SEVERAL (a roll's Exit / Re-entry) leads
              with its name at full weight — it is what tells the two columns
              apart. A lone "Estimate" stays a quiet caption. */}
          <span
            className={
              sub
                ? 'text-[13px] font-semibold text-ink-50'
                : 'text-[12px] font-normal leading-[14.52px] text-ink-300'
            }
          >
            {label}
          </span>
          {sub && <span className="num text-[11px] text-ink-400">{sub}</span>}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-ink-400">
          <span className="num">
            {isError ? 'preview failed' : estimating ? 'estimating…' : age !== null ? `⟳ ${age} ago` : '⟳ —'}
          </span>
          {aside}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * One leg as a boxed summary row — the close dialogs' "what you hold" block:
 * a kind chip (Perp / Boros), the venue with its side chip, a dim descriptor
 * line, and the size on the right with its own dim line.
 */
export function LegCard({
  kind,
  venue,
  side,
  sub,
  value,
  valueSub,
}: {
  kind: 'Perp' | 'Boros';
  venue: string;
  side: 'LONG' | 'SHORT';
  sub?: ReactNode;
  value: ReactNode;
  valueSub?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 card px-3 py-2">
      <Chip tone={kind === 'Boros' ? 'blue' : 'neutral'} className="shrink-0 font-semibold">
        {kind}
      </Chip>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-50">
          <VenueIcon venue={venue} size={16} />
          <span className="truncate">{venue}</span>
          <Chip sm tone={side === 'LONG' ? 'green' : 'red'} className="font-semibold">
            {side}
          </Chip>
        </span>
        {sub && <span className="truncate text-[11px] text-ink-400">{sub}</span>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="num text-[12.5px] font-semibold text-ink-50">{value}</span>
        {valueSub && <span className="num text-[11px] text-ink-400">{valueSub}</span>}
      </div>
    </div>
  );
}

/**
 * The estimate card's slippage line: "Est. X / Max: Y" with the bound as a
 * button that reveals the tolerance editor (quick picks + a box). The same
 * shape on every close and ticket, whether the unit is % of price or APR.
 */
export function SlippageLine({
  est,
  max,
  unit,
  open,
  onToggle,
  value,
  onChange,
  invalid,
  invalidText,
  inputAriaLabel,
  title,
  hint,
  quick = ['0.2', '0.4', '1', '2'],
}: {
  /** The estimated give-up, already formatted; null while unknown. */
  est: string | null;
  /** The bound, already formatted (what the button shows). */
  max: string;
  /** Trailing unit word after the bound, e.g. "APR"; omitted for % of price. */
  unit?: string;
  open: boolean;
  onToggle: () => void;
  /** The editor's raw value (percent). */
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  invalidText: string;
  inputAriaLabel: string;
  title?: string;
  /** The editor's explanatory line. */
  hint: string;
  quick?: string[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-ink-200" title={title}>
          Slippage
        </span>
        <span className="num text-[12px] text-ink-400">
          Est. <span className="text-ink-50">{est ?? '—'}</span>
          {' / '}Max:{' '}
          <button
            type="button"
            className="text-link underline decoration-link/40 underline-offset-2 hover:text-ink-50"
            title="Change the tolerance"
            onClick={onToggle}
          >
            {max}
          </button>
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 rounded border border-ink-700 bg-ink-900/60 px-2.5 py-2">
          <span className="text-[10.5px] leading-relaxed text-ink-400">{hint}</span>
          <div className="flex items-center gap-1.5">
            {quick.map((q) => (
              <button
                key={q}
                type="button"
                className={`btn-ghost-xs ${value === q ? '!border-info/60 !text-pastel-blue' : ''}`}
                onClick={() => onChange(q)}
              >
                {q}%
              </button>
            ))}
            <input
              className={`input num h-7 flex-1 px-2 py-0.5 text-[12px] ${invalid ? '!border-rose-500/60' : ''}`}
              inputMode="decimal"
              aria-label={inputAriaLabel}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            <span className="text-[11px] text-ink-400">%</span>
          </div>
          {invalid && <span className="text-[11px] text-rose-300">{invalidText}</span>}
        </div>
      )}
    </div>
  );
}

/** A leverage figure, "10x long / 50x short" or "50x", with the "venue max"
 * qualification dimmed beside it. */
export function LeverageValue({ text }: { text: string | null }) {
  return text ? (
    <>
      {text} <span className="text-[11px] font-normal text-ink-400">venue max</span>
    </>
  ) : (
    '—'
  );
}

// ---------------------------------------------------------------------------
// Venue selection
// ---------------------------------------------------------------------------

/** LONG or SHORT venue as a dropdown — the other leg's venue is disabled. */
function VenueSelect({
  tone,
  value,
  otherValue,
  onPick,
  venues,
  loading,
}: {
  tone: 'long' | 'short';
  value: string | null;
  otherValue: string | null;
  onPick: (s: string) => void;
  venues: SymbolRule[] | undefined;
  loading: boolean;
}) {
  const otherVenue = otherValue ? parseSymbol(otherValue).exchange : null;
  const long = tone === 'long';
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Chip sm tone={long ? 'green' : 'red'} className="font-semibold">
          {long ? 'LONG' : 'SHORT'}
        </Chip>
        <span className="text-[12px] font-normal text-ink-300">
          {long ? 'pays funding' : 'receives funding'}
        </span>
      </div>
      <div className="relative">
        <select
          aria-label={`${long ? 'LONG' : 'SHORT'} venue`}
          className="select"
          value={value ?? ''}
          onChange={(e) => onPick(e.target.value)}
        >
          <option value="">{loading ? 'loading venues…' : 'Select venue'}</option>
          {(venues ?? []).map((r) => (
            <option key={r.symbol} value={r.symbol} disabled={r.exchange === otherVenue}>
              {prettyVenue(r.exchange)}
              {r.quote !== 'USDT' ? ` · ${r.quote}` : ''}
              {r.exchange === otherVenue ? ` (${long ? 'short' : 'long'} venue)` : ''}
            </option>
          ))}
        </select>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-400">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 4.5 6 8l3.5-3.5" />
          </svg>
        </span>
      </div>
    </div>
  );
}

/** The two venue selects side by side, with a swap between them. */
export function PairVenues({
  longSym,
  shortSym,
  venues,
  loading,
  onLong,
  onShort,
  onSwap,
}: {
  longSym: string | null;
  shortSym: string | null;
  venues: SymbolRule[] | undefined;
  loading: boolean;
  onLong: (s: string) => void;
  onShort: (s: string) => void;
  onSwap: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
      <VenueSelect tone="long" value={longSym} otherValue={shortSym} onPick={onLong} venues={venues} loading={loading} />
      <button
        type="button"
        aria-label="Swap venues"
        title="Swap the long and short venues"
        disabled={!longSym && !shortSym}
        onClick={onSwap}
        className="mb-[7px] flex h-6 w-6 items-center justify-center rounded-full border border-ink-600 bg-ink-900 text-[11px] text-ink-300 transition-colors hover:border-ink-400 hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ⇄
      </button>
      <VenueSelect tone="short" value={shortSym} otherValue={longSym} onPick={onShort} venues={venues} loading={loading} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maker-hedge controls
// ---------------------------------------------------------------------------

/** Maker-hedge controls: the auto-chosen maker leg (fee-minimizing, no
 * manual override), the touch-tracking price input, and the convert-to-taker
 * timeout. Flat in the form — they are fields of the ticket, not an aside. */
export function MakerHedgeControls({
  makerLegPick,
  longSym,
  shortSym,
  makerSaving,
  priceStr,
  pricePinned,
  touchIsFallback,
  onPriceInput,
  onTrackTouch,
  timeoutSec,
  onTimeout,
}: {
  makerLegPick: 'long' | 'short';
  longSym: string | null;
  shortSym: string | null;
  /** Open-fee saving vs both legs taker (null while fees are unknown). */
  makerSaving: number | null;
  priceStr: string;
  pricePinned: boolean;
  touchIsFallback: boolean;
  /** User typed a price — pin it. */
  onPriceInput: (v: string) => void;
  /** Un-pin and resume tracking the book (one gap behind the touch). */
  onTrackTouch: () => void;
  timeoutSec: TimeoutChoice;
  onTimeout: (v: TimeoutChoice) => void;
}) {
  const makerSym = makerLegPick === 'long' ? longSym : shortSym;
  const makerVenue = makerSym ? parseSymbol(makerSym).exchange : makerLegPick === 'long' ? 'LONG' : 'SHORT';
  const makerQuote = makerSym ? parseSymbol(makerSym).quote || 'USDT' : 'USDT';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2" data-maker-panel>
        <span className="flex items-center gap-2 text-[11.5px]">
          <span className="text-ink-200">Maker leg</span>
          <Chip sm tone="cyan">
            {makerVenue}
          </Chip>
          <span className="text-ink-400" title="Auto-chosen: the cheapest maker+taker fee combo">
            auto
          </span>
        </span>
        {makerSaving !== null && makerSaving > 0 && (
          <span className="text-[11px] text-ink-400" title="Open-fee saving vs both legs taker">
            <span className="num text-emerald-400">saves ≈ {sig(makerSaving)} USDT</span> vs both taker
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor="pair-maker-price">Maker price</FieldLabel>
          <span
            className="text-[11px] text-ink-400"
            title="Defaults to one bid–ask gap behind the touch and follows the book until you type a price."
          >
            {pricePinned ? (
              <>
                pinned —{' '}
                <button type="button" className="underline underline-offset-2 hover:text-ink-100" onClick={onTrackTouch}>
                  track book
                </button>
              </>
            ) : (
              'tracking the book — type to pin'
            )}
            {!pricePinned && touchIsFallback && (
              <span
                className="ml-1 text-amber-400/90"
                title="Order book unavailable. The price is a cross-venue mid estimate — verify before executing."
              >
                ≈ est. (book unavailable)
              </span>
            )}
          </span>
        </div>
        <AffixedInput affix={<span>{makerQuote}</span>}>
          <input
            id="pair-maker-price"
            className="input num pr-14"
            inputMode="decimal"
            placeholder="fetching touch…"
            value={priceStr}
            onChange={(e) => onPriceInput(e.target.value)}
          />
        </AffixedInput>
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel>
          <span title="Unfilled remainder cancels and completes as market orders on both venues after this long">
            Convert to taker after
          </span>
        </FieldLabel>
        <SegmentedToggle
          ariaLabel="Maker timeout"
          fill
          value={timeoutSec}
          onChange={onTimeout}
          options={TIMEOUT_CHOICES.map((t) => ({ value: t.value, label: t.label }))}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estimate card
// ---------------------------------------------------------------------------

/** One leg of the estimate table: venue chip (+ maker), est price, slippage, est fee. */
function LegRow({ label, tone, p }: { label: string; tone: 'green' | 'red'; p: PreviewResult | undefined }) {
  if (!p) return null;
  const isMaker = 'pairRole' in p.input && p.input.pairRole === 'maker';
  return (
    <>
      <tr className="border-t border-ink-800/80">
        <td className="py-1.5">
          <span className="inline-flex items-center gap-1.5">
            <VenueIcon venue={parseSymbol(p.symbol).exchange} size={16} />
            <Chip sm tone={tone} className="font-semibold">
              {parseSymbol(p.symbol).exchange}
            </Chip>
            {isMaker && (
              <Chip sm tone="cyan" title="Rests post-only one bid–ask gap behind the same-side touch; the other leg auto-hedges as it fills">
                maker
              </Chip>
            )}
            <span className="text-[11px] text-ink-400">{label}</span>
          </span>
        </td>
        <td className="num py-1.5 text-right text-[12.5px] text-ink-50">
          {p.fillEstimate ? sig(p.fillEstimate.avgPrice) : isMaker && p.price ? sig(p.price) : '—'}
        </td>
        <td className="num py-1.5 text-right text-[12px] text-ink-300">
          {p.fillEstimate ? <SlippageBadge est={p.fillEstimate} /> : isMaker ? 'rests' : '—'}
        </td>
        <td className="num py-1.5 text-right text-[12px] text-ink-50">
          {p.fees ? (
            <>
              {sig(estFeeOf(p))} <span className="text-[10.5px] text-ink-400">{p.fees.quote}</span>
            </>
          ) : (
            '—'
          )}
        </td>
      </tr>
      {/* The walk ran past the book: the tail of the size was priced at the
          last level, so the avg price and the badge above are partly invented.
          Said inline, as the single ticket does — a tooltip is not a warning. */}
      {p.fillEstimate?.partialDepth && (
        <tr>
          <td colSpan={4} className="pb-1 text-[10.5px] text-amber-400">
            {parseSymbol(p.symbol).exchange}: partial depth — estimate extrapolated past the book
          </td>
        </tr>
      )}
    </>
  );
}

/** The pair's estimate card: trade cost headline, the book graph (toggled),
 * the per-leg table, shared qty + lot binding, net entry spread, leverage,
 * margin, and violations/warnings. Derives its summary numbers from the two
 * legs. */
export function PairEstimate({
  previews,
  isError,
  error,
  estimating,
  dataUpdatedAt,
  legLong,
  legShort,
  mode,
  leverage,
  marginRequired,
  book,
}: {
  previews: PreviewResult[] | undefined;
  isError: boolean;
  error: unknown;
  estimating: boolean;
  dataUpdatedAt: number;
  legLong: PreviewResult | undefined;
  legShort: PreviewResult | undefined;
  mode: ExecMode;
  /** "10x long / 50x short" once both caps are known; null while loading. */
  leverage: string | null;
  /** Total initial margin the two legs post, in USD; null while unknown. */
  marginRequired: number | null;
  /** The book + market-impact graph (already sized to this ticket). */
  book: ReactNode;
}) {
  const [showBook, setShowBook] = useState(true);
  const sharedQty = legLong?.qty || legShort?.qty || '';
  const base = legLong ? parseSymbol(legLong.symbol).base : legShort ? parseSymbol(legShort.symbol).base : '';
  const binding = useMemo(() => {
    if (!legLong?.rule || !legShort?.rule) return null;
    const ll = Number(legLong.rule.lotSize);
    const ls = Number(legShort.rule.lotSize);
    if (!Number.isFinite(ll) || !Number.isFinite(ls)) return null;
    const leg = ll >= ls ? legLong : legShort;
    return { exchange: prettyVenue(parseSymbol(leg.symbol).exchange), lot: leg.rule!.lotSize };
  }, [legLong, legShort]);

  // What OPENING costs: the maker leg at its maker rate (POC) and the other
  // at taker, or both taker. Closing is a separate trade with its own ticket.
  const tradeCost = legLong?.fees && legShort?.fees ? estFeeOf(legLong) + estFeeOf(legShort) : null;
  const refPx = legLong?.refPrice?.value ?? legShort?.refPrice?.value;
  const spreadBps =
    legLong?.fillEstimate && legShort?.fillEstimate && refPx
      ? bpsOf((legLong.fillEstimate.avgPrice - legShort.fillEstimate.avgPrice) / refPx)
      : null;

  return (
    <EstimateCard
      dataUpdatedAt={dataUpdatedAt}
      estimating={estimating}
      isError={isError}
      aside={
        <button
          type="button"
          aria-pressed={showBook}
          onClick={() => setShowBook((v) => !v)}
          title="Show or hide the live book and market-impact graph"
          className={`btn-ghost-xs ${
            showBook
              ? '!border-info/50 bg-info/[0.14] !text-pastel-blue'
              : ''
          }`}
        >
          <span aria-hidden>▤</span> Book
        </button>
      }
    >
      {previews ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-[12.5px] text-ink-50">Trade cost</span>
              <span className="text-[11px] text-ink-400">
                {mode === 'maker' ? 'open maker + taker' : 'open ×2 taker'}
              </span>
            </div>
            <span className="num text-lg font-semibold text-ink-50">
              {tradeCost !== null ? `≈ ${sig(tradeCost)} USDT` : '—'}
            </span>
          </div>

          {showBook && <div className="pt-1">{book}</div>}

          <table className="w-full">
            <thead>
              <tr className="text-[12px] font-normal text-ink-300">
                <th className="pb-1 text-left">leg</th>
                <th className="pb-1 text-right">est price</th>
                <th className="pb-1 text-right">slip</th>
                <th className="pb-1 text-right">est fee</th>
              </tr>
            </thead>
            <tbody>
              <LegRow label="long" tone="green" p={legLong} />
              <LegRow label="short" tone="red" p={legShort} />
            </tbody>
          </table>

          <div className="flex flex-col gap-1.5 border-t border-ink-800/80 pt-2">
            {sharedQty && (
              <EstimateRow
                label="Shared qty"
                sub={binding ? `lot-bound by ${binding.exchange} (${binding.lot})` : undefined}
                value={`${sig(sharedQty)}${base ? ` ${base}` : ''}`}
              />
            )}
            {spreadBps !== null && (
              <EstimateRow
                label="Net entry spread"
                sub="long − short, of ref"
                value={
                  <span className={spreadBps <= 0 ? 'text-emerald-400' : 'text-rose-400'}>{spreadBps.toFixed(1)} bps</span>
                }
              />
            )}
            <EstimateRow label="Leverage" value={<LeverageValue text={leverage} />} />
            <EstimateRow
              label="Margin required"
              title="Initial margin the two legs post together — each leg's notional over its leverage"
              value={marginRequired !== null ? `≈ ${fmtUsd(marginRequired)}` : '—'}
              strong
            />
          </div>
          <ViolationList
            violations={dedupeByMessage([...(legLong?.violations ?? []), ...(legShort?.violations ?? [])])}
            warnings={[...new Set([...(legLong?.warnings ?? []), ...(legShort?.warnings ?? [])])]}
          />
        </>
      ) : (
        <div className="text-[11px]">
          <PreviewFallback isError={isError} error={error} />
        </div>
      )}
    </EstimateCard>
  );
}
