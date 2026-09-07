/** PairTicket sub-renders: venue picker rows, the per-leg preview table rows,
 * the maker-hedge control box, and the preview readout. Pure/prop-driven —
 * PairTicket owns all state and the preview query. */
import { useMemo } from 'react';
import type { PreviewResult, SymbolRule } from '../api/types';
import { Chip } from '../components/Chip';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { bpsOf, parseSymbol, sig } from '../lib/fmt';
import { estFeeOf, PreviewFallback, SlippageBadge, ViolationList } from './previewBits';
import { VenuePickChip } from './SymbolCombobox';

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

/** LONG/SHORT venue picker row — the other leg's venue is disabled. */
export function VenueRow({
  label,
  tone,
  value,
  otherValue,
  onPick,
  venues,
  loading,
}: {
  label: string;
  tone: 'long' | 'short';
  value: string | null;
  otherValue: string | null;
  onPick: (s: string) => void;
  venues: SymbolRule[] | undefined;
  loading: boolean;
}) {
  const otherVenue = otherValue ? parseSymbol(otherValue).exchange : null;
  const activeClass =
    tone === 'long'
      ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
      : 'border-rose-500/60 bg-rose-500/15 text-rose-300';
  return (
    <div className="flex flex-col gap-1">
      <span className={`text-[11px] font-medium ${tone === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {(venues ?? []).map((r) => (
          <VenuePickChip
            key={r.symbol}
            rule={r}
            active={value === r.symbol}
            activeClass={activeClass}
            disabled={r.exchange === otherVenue}
            disabledTitle={`already the ${tone === 'long' ? 'SHORT' : 'LONG'} venue`}
            onPick={() => onPick(value === r.symbol ? '' : r.symbol)}
          />
        ))}
        {loading && <span className="text-[11px] text-ink-500">loading venues…</span>}
      </div>
    </div>
  );
}

/** One leg of the preview table: venue chip, est px, slippage, est fee. */
function LegRow({ label, tone, p }: { label: string; tone: 'green' | 'red'; p: PreviewResult | undefined }) {
  if (!p) return null;
  const isMaker = 'pairRole' in p.input && p.input.pairRole === 'maker';
  return (
    <tr>
      <td className="py-0.5">
        <span className="inline-flex items-center gap-1">
          <Chip sm tone={tone}>
            {parseSymbol(p.symbol).exchange}
          </Chip>
          {isMaker && (
            <Chip sm tone="cyan" title="Rests post-only one bid–ask gap behind the same-side touch; the other leg auto-hedges as it fills">
              maker
            </Chip>
          )}
        </span>
      </td>
      <td className="num py-0.5 text-right text-ink-200">
        {p.fillEstimate ? sig(p.fillEstimate.avgPrice) : isMaker && p.price ? sig(p.price) : '—'}
      </td>
      <td className="num py-0.5 text-right text-ink-500">
        {p.fillEstimate ? <SlippageBadge est={p.fillEstimate} /> : isMaker ? 'rests' : '—'}
      </td>
      <td className="num py-0.5 text-right text-ink-300">
        {p.fees ? `${sig(estFeeOf(p))} ${p.fees.quote}` : '—'}
      </td>
      <td className="sr-only">{label}</td>
    </tr>
  );
}

/** Maker-hedge control box: the auto-chosen maker leg (fee-minimizing, no
 * manual override), the touch-tracking price input, and the convert-to-taker
 * timeout. */
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
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-100/[0.03] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-ink-400">Maker leg:</span>
        <Chip sm tone="cyan">
          {makerLegPick === 'long' ? (longSym ? parseSymbol(longSym).exchange : 'LONG') : shortSym ? parseSymbol(shortSym).exchange : 'SHORT'}
        </Chip>
        <span className="text-ink-500" title="Auto-chosen: the cheapest maker+taker fee combo">auto</span>
        {makerSaving !== null && makerSaving > 0 && (
          <span className="num text-emerald-400" title="Open-fee saving vs both legs taker">
            saves ≈ {sig(makerSaving)} USDT
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="pair-maker-price"
          className="text-[11px] text-ink-400"
          title="Defaults to one bid–ask gap behind the touch (bid − gap for a BUY, ask + gap for a SELL) and follows the book until you type a price"
        >
          Maker price{' '}
          <span className="text-ink-500">
            {pricePinned ? '(pinned — ' : '(tracking the book — '}
            {pricePinned ? (
              <button type="button" className="underline" onClick={onTrackTouch}>
                track book
              </button>
            ) : (
              'type to pin'
            )}
            )
          </span>
          {!pricePinned && touchIsFallback && (
            <span className="ml-1 text-amber-400/90" title="The maker venue's order book is unavailable — the price is seeded from a cross-venue mid estimate. Verify before executing.">
              ≈ est. (book unavailable)
            </span>
          )}
        </label>
        <input
          id="pair-maker-price"
          className="input num"
          inputMode="decimal"
          placeholder="fetching touch…"
          value={priceStr}
          onChange={(e) => onPriceInput(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-ink-400" title="Unfilled remainder cancels and completes as market orders on both venues after this long">
          Convert to taker after
        </span>
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

/** Preview readout: per-leg table, shared qty + lot binding, round-trip cost,
 * net entry spread, violations/warnings. Derives its own summary numbers from
 * the two legs. */
export function PairPreview({
  previews,
  isError,
  error,
  estimating,
  legLong,
  legShort,
  mode,
}: {
  previews: PreviewResult[] | undefined;
  isError: boolean;
  error: unknown;
  estimating: boolean;
  legLong: PreviewResult | undefined;
  legShort: PreviewResult | undefined;
  mode: ExecMode;
}) {
  const sharedQty = legLong?.qty || legShort?.qty || '';
  const binding = useMemo(() => {
    if (!legLong?.rule || !legShort?.rule) return null;
    const ll = Number(legLong.rule.lotSize);
    const ls = Number(legShort.rule.lotSize);
    if (!Number.isFinite(ll) || !Number.isFinite(ls)) return null;
    const leg = ll >= ls ? legLong : legShort;
    return { exchange: parseSymbol(leg.symbol).exchange, lot: leg.rule!.lotSize };
  }, [legLong, legShort]);

  // Open cost per leg = whichever side the leg previews (maker-only for POC);
  // closes are always taker on both venues.
  const closeFeeOf = (p: PreviewResult | undefined) =>
    p?.fees && p.estNotional > 0 ? p.estNotional * p.fees.takerRate : undefined;
  const closeLong = closeFeeOf(legLong);
  const closeShort = closeFeeOf(legShort);
  const roundTrip =
    legLong && legShort && closeLong !== undefined && closeShort !== undefined
      ? estFeeOf(legLong) + estFeeOf(legShort) + closeLong + closeShort
      : null;
  const refPx = legLong?.refPrice?.value ?? legShort?.refPrice?.value;
  const spreadBps =
    legLong?.fillEstimate && legShort?.fillEstimate && refPx
      ? bpsOf((legLong.fillEstimate.avgPrice - legShort.fillEstimate.avgPrice) / refPx)
      : null;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2 text-[11px]">
      {previews ? (
        <>
          {estimating && <span className="text-amber-400">estimating…</span>}
          <table className="w-full">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-ink-500">
                <th className="text-left font-semibold">leg</th>
                <th className="text-right font-semibold">est px</th>
                <th className="text-right font-semibold">slip</th>
                <th className="text-right font-semibold">est fee</th>
                <th className="sr-only">side</th>
              </tr>
            </thead>
            <tbody>
              <LegRow label="long" tone="green" p={legLong} />
              <LegRow label="short" tone="red" p={legShort} />
            </tbody>
          </table>
          {sharedQty && (
            <span className="text-ink-300">
              shared qty <span className="num text-ink-100">{sig(sharedQty)}</span>
              {binding && (
                <span className="text-ink-500">
                  {' '}
                  — lot bound by {binding.exchange} (lot {binding.lot})
                </span>
              )}
            </span>
          )}
          {roundTrip !== null && (
            <span className="text-ink-300">
              round-trip cost ≈ <span className="num text-ink-100">{sig(roundTrip)} USDT</span>{' '}
              <span className="text-ink-500">
                {mode === 'maker' ? '(open maker+taker, close ×2 taker)' : '(open ×2 + close ×2, taker)'}
              </span>
            </span>
          )}
          {spreadBps !== null && (
            <span className="text-ink-300">
              net entry spread{' '}
              <span className={`num ${spreadBps <= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {spreadBps.toFixed(1)} bps
              </span>{' '}
              <span className="text-ink-500">(long − short, of ref)</span>
            </span>
          )}
          <ViolationList
            violations={dedupeByMessage([...(legLong?.violations ?? []), ...(legShort?.violations ?? [])])}
            warnings={[...new Set([...(legLong?.warnings ?? []), ...(legShort?.warnings ?? [])])]}
          />
        </>
      ) : (
        <PreviewFallback isError={isError} error={error} />
      )}
    </div>
  );
}
