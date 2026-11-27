/** PairTicket sub-renders: the LONG/SHORT venue selects, the maker-hedge
 * controls, the estimate card (per-leg table, costs, leverage, margin) and
 * the shared row/affix primitives the single ticket reuses. Pure/prop-driven —
 * PairTicket owns all state and the preview query. */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { BorosLegDirection, PreviewResult, SymbolRule } from '../api/types';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { ListPicker } from '../components/ListPicker';
import { SwapButton } from '../components/SwapButton';
import { SpreadIcon, VenueIcon } from '../components/AssetIcon';
import { OPPORTUNITIES_STORAGE_KEY, readJson } from '../lib/storage';
import { bpsOf, fmtAge, fmtUsd, parseSymbol, prettyVenue, qtyGrouped, sigGrouped } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { estFeeOf, PreviewFallback, SlippageBadge, ViolationList } from './previewBits';
import { fmtTradeCost } from './TicketEstimateBits';
import { RotateCw } from 'lucide-react';

export type ExecMode = 'market' | 'maker';

/** The ticket starts on the perp entry picked on Opportunities (default:
 * Limit + hedge), so one setting has one default on both screens. */
export function storedExecMode(): ExecMode {
  return readJson<ExecMode>(OPPORTUNITIES_STORAGE_KEY, 'maker', (p) =>
    (p as { entryMode?: unknown } | null)?.entryMode === 'both-market' ? 'market' : 'maker',
  );
}

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

export function EstimateAge({
  dataUpdatedAt,
  estimating,
  isError,
}: {
  dataUpdatedAt: number;
  estimating: boolean;
  isError: boolean;
}) {
  const { t } = useTranslation();
  const now = useNow(1_000);
  const age = dataUpdatedAt > 0 ? fmtAge(now - dataUpdatedAt) : null;
  return (
    <span className="num text-[11px] text-ink-400">
      {isError ? t('pairTicket.bits.previewFailed') : estimating ? t('common.refreshing') : (
        <>
          <RotateCw size={12} aria-hidden className="inline" /> {age !== null ? t('pairTicket.bits.ago', { age }) : '—'}
        </>
      )}
    </span>
  );
}

export function SummaryCard({
  title,
  sub,
  aside,
  children,
}: {
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="card flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold text-ink-50">{title}</span>
          {sub && <span className="num text-[11px] text-ink-400">{sub}</span>}
        </span>
        {aside && <span className="flex items-center gap-2">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** The estimate card's frame: an "ESTIMATE" caption, the preview's age, and
 * whatever the caller puts in the top-right (the pair's Book toggle). */
export function EstimateCard({
  dataUpdatedAt,
  estimating,
  isError,
  aside,
  label,
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
  const { t } = useTranslation();
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
            {label ?? t('pairTicket.bits.estimate')}
          </span>
          {sub && <span className="num text-[11px] text-ink-400">{sub}</span>}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-ink-400">
          <EstimateAge dataUpdatedAt={dataUpdatedAt} estimating={estimating} isError={isError} />
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
  spreadVenues,
  side,
  sub,
  value,
  valueSub,
}: {
  kind: 'Perp' | 'Boros';
  venue: string;
  spreadVenues?: readonly [string, string] | null;
  side: 'LONG' | 'SHORT';
  sub?: ReactNode;
  value: ReactNode;
  valueSub?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 card px-3 py-2">
      <Chip tone={kind === 'Boros' ? 'blue' : 'neutral'} className="shrink-0 font-semibold">
        {kind === 'Perp' ? t('common.perp') : kind}
      </Chip>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-50">
          {spreadVenues ? <SpreadIcon venues={spreadVenues} size={16} /> : <VenueIcon venue={venue} size={16} />}
          <span className="truncate">{venue}</span>
          <Chip sm tone={side === 'LONG' ? 'green' : 'red'} className="font-semibold">
            {t(side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}
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
export function SlippageCostHead({
  name,
  est,
  max,
  unit,
  cost,
  onToggle,
  title,
}: {
  name: string;
  est: string | null;
  max: string;
  unit?: string;
  cost: string | null;
  onToggle: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12px] text-ink-200">
        <HoverCard label={name} widthPx={240}>
          <span className="num flex flex-col gap-0.5">
            <span>{t('pairTicket.bits.est')} {est ?? '—'}</span>
            <span>{t('pairTicket.bits.max')} {max}{unit ? ` ${unit}` : ''}</span>
          </span>
        </HoverCard>
      </span>
      <button
        type="button"
        className="num text-[12px] text-link underline decoration-link/40 underline-offset-2 hover:text-ink-50"
        title={title ?? t('pairTicket.bits.changeTolerance')}
        onClick={onToggle}
      >
        {cost ?? '—'}
      </button>
    </div>
  );
}

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
  label,
  hint,
  cost,
  quick = ['0.2', '0.4', '1', '2'],
}: {
  /** The estimated give-up, already formatted; null while unknown. */
  est: string | null;
  cost?: string | null;
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
  label?: string;
  /** The editor's explanatory line. */
  hint: string;
  quick?: string[];
}) {
  const { t } = useTranslation();
  const name = label ?? t('pairTicket.bits.slippage');
  return (
    <div className="flex flex-col gap-1.5">
      {cost !== undefined ? (
        <SlippageCostHead name={name} est={est} max={max} unit={unit} cost={cost} onToggle={onToggle} />
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-ink-200" title={title}>
            {name}
          </span>
          <span className="num text-[12px] text-ink-400">
            {t('pairTicket.bits.est')} <span className="text-ink-50">{est ?? '—'}</span>
            {' / '}{t('pairTicket.bits.max')}{' '}
            <button
              type="button"
              className="text-link underline decoration-link/40 underline-offset-2 hover:text-ink-50"
              title={t('pairTicket.bits.changeTolerance')}
              onClick={onToggle}
            >
              {max}
            </button>
            {unit ? ` ${unit}` : ''}
          </span>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-1.5 rounded border border-ink-700 bg-ink-900/60 px-2.5 py-2">
          <span className="text-[10.5px] leading-relaxed text-ink-400">
            <span className="text-ink-200">{t('pairTicket.bits.thisTradeOnly')}</span> {hint}
          </span>
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
  const { t } = useTranslation();
  return text ? (
    <>
      {text} <span className="text-[11px] font-normal text-ink-400">· {t('pairTicket.bits.venueMax')}</span>
    </>
  ) : (
    '—'
  );
}

// ---------------------------------------------------------------------------
// Venue selection
// ---------------------------------------------------------------------------

/** LONG or SHORT venue as a dropdown — the other leg's venue is disabled. */
export function LegHeader({
  dir,
  caption,
  onDir,
  hints,
}: {
  dir: BorosLegDirection;
  caption: string;
  onDir?: (d: BorosLegDirection) => void;
  hints?: Record<BorosLegDirection, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <Chip sm tone={dir === 'long' ? 'green' : 'red'} className="font-semibold">
          {t(dir === 'long' ? 'common.longUpper' : 'common.shortUpper')}
        </Chip>
        <span className="text-[12px] font-normal text-ink-300">{caption}</span>
      </span>
      {onDir && (
        <div className="seg seg-xs inline-flex" role="radiogroup" aria-label={t('common.side')}>
          {(['long', 'short'] as const).map((d) => {
            const active = dir === d;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={active}
                data-active={active}
                className={`seg-btn text-center ${active ? (d === 'long' ? '!bg-emerald-500/15 !text-emerald-300' : '!bg-rose-500/15 !text-rose-300') : ''}`}
                title={hints?.[d]}
                onClick={() => onDir(d)}
              >
                {t(d === 'long' ? 'common.longAction' : 'common.shortAction')}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function VenueSelect({
  tone,
  onTone,
  value,
  otherValue,
  onPick,
  venues,
  loading,
}: {
  tone: BorosLegDirection;
  onTone?: (tone: BorosLegDirection) => void;
  value: string | null;
  otherValue: string | null;
  onPick: (s: string) => void;
  venues: SymbolRule[] | undefined;
  loading: boolean;
}) {
  const otherVenue = otherValue ? parseSymbol(otherValue).exchange : null;
  const long = tone === 'long';
  const none = !loading && (venues ?? []).length === 0;
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <LegHeader
        dir={tone}
        caption={t(long ? 'pairTicket.bits.paysFunding' : 'pairTicket.bits.receivesFunding')}
        onDir={onTone}
      />
      <ListPicker
        label={t(long ? 'pairTicket.bits.longVenue' : 'pairTicket.bits.shortVenue')}
        value={value ?? ''}
        onChange={onPick}
        disabled={none}
        placeholder={loading ? t('trade.symbol.loadingVenues') : none ? t('trade.symbol.pickCoin') : t('pairTicket.bits.selectVenue')}
        rows={(venues ?? []).map((r) => ({
          key: r.symbol,
          icon: <VenueIcon venue={r.exchange} size={16} />,
          name: `${prettyVenue(r.exchange)}${r.quote !== 'USDT' ? ` · ${r.quote}` : ''}`,
          value: r.exchange === otherVenue ? t(long ? 'pairTicket.bits.shortVenue' : 'pairTicket.bits.longVenue') : undefined,
          disabled: r.exchange === otherVenue,
        }))}
      />
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
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
      <VenueSelect tone="long" value={longSym} otherValue={shortSym} onPick={onLong} venues={venues} loading={loading} />
      <SwapButton label={t('pairTicket.bits.swapVenues')} title={t('pairTicket.bits.swapVenuesHint')} disabled={!longSym && !shortSym} onClick={onSwap} />
      <VenueSelect tone="short" value={shortSym} otherValue={longSym} onPick={onShort} venues={venues} loading={loading} />
    </div>
  );
}

function isMakerLeg(p: PreviewResult): boolean {
  return 'pairRole' in p.input && p.input.pairRole === 'maker';
}

function LegRow({ side, p, rests }: { side: 'LONG' | 'SHORT'; p: PreviewResult | undefined; rests?: boolean }) {
  const { t } = useTranslation();
  if (!p) return null;
  const isMaker = rests ?? isMakerLeg(p);
  const venue = parseSymbol(p.symbol).exchange;
  return (
    <>
      <tr className="border-t border-ink-800/80">
        <td className="py-1.5">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-50">
            <Chip sm tone={side === 'LONG' ? 'green' : 'red'} className="font-semibold">
              {t(side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}
            </Chip>
            <VenueIcon venue={venue} size={16} />
            {prettyVenue(venue)}
            {isMaker && (
              <Chip sm tone="cyan" title={t('pairTicket.bits.makerChipHint')}>
                {t('pairTicket.bits.maker')}
              </Chip>
            )}
          </span>
        </td>
        <td className="num py-1.5 text-right text-[12.5px] text-ink-50">
          {p.fillEstimate ? sigGrouped(p.fillEstimate.avgPrice) : isMaker && p.price ? sigGrouped(p.price) : '—'}
        </td>
        <td className="num py-1.5 text-right text-[12px] text-ink-300">
          {p.fillEstimate ? <SlippageBadge est={p.fillEstimate} /> : isMaker ? t('pairTicket.bits.rests') : '—'}
        </td>
        <td className="num py-1.5 text-right text-[12px] text-ink-50">
          {p.fees ? (
            <>
              {sigGrouped(estFeeOf(p))} <span className="text-[10.5px] text-ink-400">{p.fees.quote}</span>
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
            {t('pairTicket.bits.partialDepth', { venue: parseSymbol(p.symbol).exchange })}
          </td>
        </tr>
      )}
    </>
  );
}

export function LegTable({ rows }: { rows: { side: 'LONG' | 'SHORT'; p: PreviewResult | undefined; rests?: boolean }[] }) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[12px] font-normal text-ink-300">
          <th className="pb-1 text-left font-normal">{t('pairTicket.bits.colLeg')}</th>
          <th className="pb-1 text-right font-normal">{t('pairTicket.bits.colPrice')}</th>
          <th className="pb-1 text-right font-normal">{t('pairTicket.bits.colSlip')}</th>
          <th className="pb-1 text-right font-normal">{t('pairTicket.preview.estFee')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <LegRow key={row.side} side={row.side} p={row.p} rests={row.rests} />
        ))}
      </tbody>
    </table>
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
  leverage,
  marginRequired,
  twapOn = false,
  typedQty = null,
}: {
  previews: PreviewResult[] | undefined;
  isError: boolean;
  error: unknown;
  estimating: boolean;
  dataUpdatedAt: number;
  legLong: PreviewResult | undefined;
  legShort: PreviewResult | undefined;
  /** "10x long / 50x short" once both caps are known; null while loading. */
  leverage: string | null;
  /** Total initial margin the two legs post, in USD; null while unknown. */
  marginRequired: number | null;
  twapOn?: boolean;
  typedQty?: string | null;
}) {
  const { t } = useTranslation();
  const sharedQty = legLong?.qty || legShort?.qty || '';
  const rounded = typedQty !== null && Number(typedQty) !== Number(sharedQty);
  const showQty = sharedQty !== '' && (typedQty === null || rounded);
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

  const fold = previews ? null : (
    <div className="text-[11px]">
      <PreviewFallback isError={isError} error={error} />
    </div>
  );

  return (
    <>
      <SummaryCard
        title={t('accounts.moveCash.cost')}
        sub={twapOn ? t('trade.twap.area.wholeRun') : undefined}
        aside={<EstimateAge dataUpdatedAt={dataUpdatedAt} estimating={estimating} isError={isError} />}
      >
        {previews ? (
          <>
            <LegTable
              rows={[
                { side: 'LONG', p: legLong },
                { side: 'SHORT', p: legShort },
              ]}
            />

            {spreadBps !== null && (
              <EstimateRow
                label={
                  <HoverCard label={t('pairTicket.bits.netSpread')} widthPx={240}>
                    {t('pairTicket.bits.netSpreadSub')}
                  </HoverCard>
                }
                value={
                  <span className={spreadBps <= 0 ? 'text-emerald-400' : 'text-rose-400'}>{spreadBps.toFixed(1)} bps</span>
                }
              />
            )}
            <div className="mt-0.5 border-t border-ink-800 pt-1.5">
              <EstimateRow
                label={t('pairTicket.bits.tradeCost')}
                value={fmtTradeCost(tradeCost)}
                strong
              />
            </div>
          </>
        ) : (
          fold
        )}
      </SummaryCard>

      {previews && (
        <SummaryCard title={t('accounts.moveCash.after')}>
          {showQty && (
            <EstimateRow
              label={t('pairTicket.bits.sharedQty')}
              sub={rounded && binding ? t('pairTicket.bits.lotBound', { venue: binding.exchange, lot: binding.lot }) : undefined}
              value={`${qtyGrouped(sharedQty)}${base ? ` ${base}` : ''}`}
            />
          )}
          <EstimateRow label={t('pairTicket.bits.leverage')} value={<LeverageValue text={leverage} />} />
          <div className="mt-0.5 border-t border-ink-800 pt-1.5">
            <EstimateRow
              label={t('pairTicket.bits.marginRequired')}
              title={t('pairTicket.bits.marginRequiredHint')}
              value={marginRequired !== null ? `≈ ${fmtUsd(marginRequired)}` : '—'}
              strong
            />
          </div>
        </SummaryCard>
      )}

      {previews && (
        <ViolationList
          violations={dedupeByMessage([...(legLong?.violations ?? []), ...(legShort?.violations ?? [])])}
          warnings={[...new Set([...(legLong?.warnings ?? []), ...(legShort?.warnings ?? [])])]}
        />
      )}
    </>
  );
}

const SHARE_STOPS = [0, 25, 50, 75, 100];

/**
 * A 0–100% slider with checkpoint dots at each quarter, as the Boros app's
 * size slider has them. Clicking a dot snaps to it. `value` is whole percent.
 */
export function ShareSlider({
  value,
  onChange,
  label,
  title,
}: {
  value: number;
  onChange: (share: number) => void;
  label: string;
  title?: string;
}) {
  // Centre of the 14px thumb at p%: the travel is the width less one thumb.
  const at = (p: number) => `calc(7px + (100% - 14px) * ${p / 100})`;
  return (
    <div className="relative flex h-4 items-center" title={title}>
      <div className="absolute inset-x-[7px] h-1 rounded-full bg-ink-700" aria-hidden />
      <div className="absolute left-[7px] h-1 rounded-full bg-info" style={{ width: `calc((100% - 14px) * ${value / 100})` }} aria-hidden />
      {SHARE_STOPS.map((p) => (
        <button
          key={p}
          type="button"
          tabIndex={-1}
          aria-hidden
          className={`absolute z-[2] h-2 w-2 -translate-x-1/2 rounded-full border ${
            p <= value ? 'border-info bg-info' : 'border-ink-600 bg-ink-850'
          } ${p === value ? 'opacity-0' : ''}`}
          style={{ left: at(p) }}
          onClick={() => onChange(p)}
        />
      ))}
      <input
        type="range"
        className="share-range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={label}
        title={title}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
