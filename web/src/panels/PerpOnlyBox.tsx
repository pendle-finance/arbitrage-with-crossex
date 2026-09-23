/**
 * ClosePairForm — close both perp legs of a 4-leg pair from the Positions
 * asset card's pairs table. (The strategy-box that once surrounded it is
 * gone; this is the one piece the asset view still needs.)
 */
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ActionInput, CrossexPosition, PreviewResult } from '../api/types';
import { Chip } from '../components/Chip';
import { SignedNumber } from '../components/SignedNumber';
import { fieldValue, fmtUsd, parseSymbol, prettyVenue, sig } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import { ExecuteControl } from '../trade/ExecuteControl';
import { AffixedInput, EstimateCard, LegCard, SlippageLine } from '../trade/PairTicketBits';
import { estFeeOf, PreviewFallback, SlippageBadge, ViolationList } from '../trade/previewBits';
import { FieldLabel } from '../trade/SymbolCombobox';
import { usePreviewDebounced } from '../trade/usePreview';
import { useTradeFlowOptional } from '../trade/TradeFlow';

/**
 * ⚠ Accurate for a PAIR, which is not what the single-leg note says.
 *
 * Only the first leg carries the mid ± slippage band; the hedge leg is sent
 * as a plain MARKET IOC on purpose, because a book-mid limit band cannot
 * reliably stay inside the venue's OWN price-limit band and gets rejected —
 * which would leave the first leg closed and the second still open (see
 * decide.ts). Claiming the band covers both would promise protection the
 * hedge leg does not have.
 */
const PAIR_NOTE =
  "The first leg is a reduce-only IOC limit at mid ± slippage; the hedge leg is sent at market, inside the venue's own price band. Neither can increase a position or rest on the book.";

/**
 * The pair close as a FORM: what is being closed, at what price, for what fee.
 *
 * `CloseBoth` is the same execution behind a bare button, with its review on a
 * hover card — fine as a row action, wrong inside a dialog the user opened in
 * order to read exactly these numbers. Hovering to find out what you are about
 * to pay is not a review, and on touch there is no hover at all.
 */
export function ClosePairForm({
  base,
  legs,
  livePositions,
}: {
  base: string;
  /** `partial`: close exactly `qty` rather than the whole venue position —
   * a pair's attributed share of a leg two pairs sit on. */
  legs: Array<{ symbol: string; qty: number; venue: string; partial?: boolean }>;
  /** symbol → live position, for the uPnL each close realises. */
  livePositions?: Map<string, CrossexPosition>;
}) {
  const flow = useTradeFlowOptional();
  const pairGroupId = useMemo(() => uuid(), []);
  /**
   * The same control the single-leg close offers.
   *
   * Without it this path sent no `slippagePct` at all and silently took the
   * 0.5% default — the setting was not "respected" because it could not be
   * expressed. Validated on the same (0,10] band the server enforces.
   */
  const [slipStr, setSlipStr] = useState('0.5');
  const [slipOpen, setSlipOpen] = useState(false);
  const slip = Number(slipStr);
  const slipInvalid = !Number.isFinite(slip) || slip <= 0 || slip > 10;
  /**
   * ONE close size for both legs, capped at this pair's own allocation.
   *
   * The pair is a hedge: taking more off one leg than the other leaves the
   * difference naked, so a single box drives both. The cap is the smaller
   * leg's attributed share — going past it would eat into a size this pair
   * does not own (another pair's share of a leg they sit on).
   */
  const maxCloseQty = legs.length ? Math.min(...legs.map((l) => l.qty)) : 0;
  const [qtyEdited, setQtyEdited] = useState<string | null>(null);
  const qtyStr = qtyEdited ?? fieldValue(maxCloseQty);
  const qtyNum = Number(qtyStr);
  const qtyEps = Math.max(1e-9, maxCloseQty * 1e-7);
  const qtyInvalid =
    qtyStr.trim() === '' || !Number.isFinite(qtyNum) || qtyNum <= 0 || qtyNum > maxCloseQty + qtyEps;
  // null, not [] — ExecuteControl disables on `!actions`, and an empty array
  // is truthy, so [] would leave the button live with nothing to send.
  const actions: ActionInput[] | null =
    legs.length === 2 && !slipInvalid && !qtyInvalid
      ? legs.map((l) => ({
          kind: 'close-position' as const,
          symbol: l.symbol,
          pairGroupId,
          slippagePct: slip,
          // Whole legs omit qty so the venue re-derives the exact position;
          // a shared leg names its share, or it would flatten the other
          // pair's hedge too — as does a partial close typed here. Judged
          // per LEG, not against the pair-wide cap: with unequal legs the
          // typed size can be the whole of the smaller leg and only part of
          // the larger one, and a qty-less action there would close the
          // larger leg entirely — leaving the difference naked.
          ...(l.partial || Math.min(qtyNum, l.qty) < l.qty - Math.max(1e-9, l.qty * 1e-7)
            ? { qty: String(Math.min(qtyNum, l.qty)) }
            : {}),
        }))
      : null;
  // Not lazy: the dialog exists to show this, so it loads with the form.
  const preview = usePreviewDebounced(`close-pair-${base}`, actions, {
    refetchInterval: 5000,
  });
  if (!flow || legs.length !== 2) return null;

  /** The uPnL a leg's close realises: its slice of the position's uPnL,
   * scaled by the close qty the resolver stamped over what the venue holds. */
  const realizedFor = (p: PreviewResult, i: number): number | null => {
    const live = livePositions?.get(legs[i]?.symbol ?? '');
    if (!live) return null;
    const held = Math.abs(Number(live.positionQty));
    const closing = Number(p.qty);
    const frac = held > 0 && Number.isFinite(closing) ? Math.min(1, closing / held) : 1;
    return Number(live.upnl) * frac;
  };
  const previews = preview.previews;
  const realized = previews?.map(realizedFor) ?? [];
  const totalPnl = realized.some((r) => r !== null)
    ? realized.reduce<number>((s, r) => s + (r ?? 0), 0)
    : null;
  // Which leg is the hedge (market IOC) vs the band-carrying first leg: see PAIR_NOTE.
  const sideOf = (symbol: string): 'LONG' | 'SHORT' => {
    const live = livePositions?.get(symbol);
    const q = Number(live?.positionQty ?? NaN);
    if (Number.isFinite(q) && q !== 0) return q > 0 ? 'LONG' : 'SHORT';
    const p = previews?.find((x) => x.symbol === symbol);
    // A close SELLs a long and BUYs a short.
    return p?.side === 'SELL' ? 'LONG' : 'SHORT';
  };
  const estSlip = previews?.length
    ? Math.max(...previews.map((p) => p.fillEstimate?.slippagePct ?? 0))
    : null;

  return (
    <div className="flex flex-col gap-4">
      {/* What is held, leg by leg — the sizes here are this pair's slice of
          each venue position, which is what the close is capped at. */}
      <div className="flex flex-col gap-1.5">
        {legs.map((l) => {
          const live = livePositions?.get(l.symbol);
          const held = live ? Math.abs(Number(live.positionQty)) : null;
          const { quote } = parseSymbol(l.symbol);
          const slice = held !== null && l.qty < held * 0.9995;
          return (
            <LegCard
              key={l.symbol}
              kind="Perp"
              venue={prettyVenue(l.venue)}
              side={sideOf(l.symbol)}
              sub={`${base}-${quote || 'USDT'} · ${slice ? 'pair slice' : 'whole position'}`}
              value={`${sig(l.qty)} ${base}`}
              valueSub={slice && held !== null ? `of ${sig(held)} on the venue` : undefined}
            />
          );
        })}
      </div>

      {/* One size, both legs, capped at this pair's allocation — see
          maxCloseQty. Defaults to the whole allocation, so leaving it alone
          closes the pair exactly as before. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor={`close-pair-qty-${base}`}>Close size · both legs</FieldLabel>
          {/* The ceiling — this pair's own allocation — stated where the
              number is typed, and clickable. */}
          <button
            type="button"
            className="num text-[11px] text-ink-400 transition-colors hover:text-ink-100"
            title="Close this pair's whole allocation on both legs"
            onClick={() => setQtyEdited(fieldValue(maxCloseQty))}
          >
            max{' '}
            <span className="text-link underline decoration-link/40 underline-offset-2">
              {sig(maxCloseQty)} {base}
            </span>
          </button>
        </div>
        <AffixedInput affix={<span>{base}</span>}>
          <input
            id={`close-pair-qty-${base}`}
            className={`input num pr-16 ${qtyInvalid ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            value={qtyStr}
            onChange={(e) => setQtyEdited(e.target.value)}
            aria-label="Close size, applied to both legs"
          />
        </AffixedInput>
        {qtyInvalid ? (
          <span className="text-[11px] text-rose-300">
            size must be above 0 and at most {sig(maxCloseQty)} {base}
          </span>
        ) : (
          <span className="text-[11px] text-ink-400">each venue floors to its own lot — see the rows above</span>
        )}
      </div>

      <EstimateCard dataUpdatedAt={preview.dataUpdatedAt} estimating={preview.estimating} isError={preview.isError}>
        {previews && previews.length > 0 ? (
          <>
            {/* The aggregate only: each leg's own figure is in the table. */}
            <div className="flex items-end justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[12.5px] text-ink-50">PnL to realise</span>
                <span className="text-[11px] text-ink-400">both legs · before fees</span>
              </div>
              <span className="num text-lg font-semibold">
                {totalPnl !== null ? <SignedNumber value={totalPnl} format={(n) => fmtUsd(n)} /> : '—'}
              </span>
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-[12px] font-normal text-ink-300">
                  <th className="pb-1 text-left font-medium">leg</th>
                  <th className="pb-1 text-right font-medium">limit px</th>
                  <th className="pb-1 text-right font-medium">slip</th>
                  <th className="pb-1 text-right font-medium">pnl</th>
                  <th className="pb-1 text-right font-medium">est fee</th>
                </tr>
              </thead>
              <tbody>
                {previews.map((p, i) => (
                  <tr key={p.symbol} className="border-t border-ink-800/80">
                    <td className="py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <Chip sm tone={p.side === 'BUY' ? 'green' : 'red'} className="font-semibold">
                          {p.side}
                        </Chip>
                        <span className="text-[12px] text-ink-50">{prettyVenue(legs[i]?.venue ?? '')}</span>
                        <span className="num text-[11px] text-ink-400">{p.qty ? sig(p.qty) : ''}</span>
                      </span>
                    </td>
                    {/* Only the first leg carries a limit; the hedge leg is a
                        plain market IOC and its cell says so. */}
                    <td className="num py-1.5 text-right text-[12.5px] text-ink-50">
                      {i > 0 ? (
                        <span
                          className="text-[11px] text-ink-400"
                          title="Sent as a market IOC inside the venue's price-limit band."
                        >
                          market IOC
                        </span>
                      ) : p.price ? (
                        sig(p.price)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num py-1.5 text-right text-[12px]">
                      {p.fillEstimate ? <SlippageBadge est={p.fillEstimate} /> : '—'}
                    </td>
                    <td className="num py-1.5 text-right text-[12px]">
                      {realized[i] !== null && realized[i] !== undefined ? (
                        <SignedNumber value={realized[i] as number} format={(n) => fmtUsd(n)} />
                      ) : (
                        '—'
                      )}
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
                ))}
              </tbody>
            </table>
            <ViolationList
              violations={previews.flatMap((p) => p.violations ?? [])}
              warnings={previews.flatMap((p) => p.warnings ?? [])}
            />
          </>
        ) : (
          <div className="text-[11px]">
            <PreviewFallback isError={preview.isError} error={preview.error} />
          </div>
        )}
        {/* Outside the preview branch on purpose: an out-of-range band
            empties the preview, and the editor must stay on screen to be
            corrected. */}
        <div className="border-t border-ink-800/80 pt-2">
          <SlippageLine
            est={estSlip !== null ? `${estSlip >= 0 ? '+' : ''}${estSlip.toFixed(3)}%` : null}
            max={`${slipStr}%`}
            open={slipOpen}
            onToggle={() => setSlipOpen((v) => !v)}
            value={slipStr}
            onChange={setSlipStr}
            invalid={slipInvalid}
            invalidText="slippage must be in (0, 10]"
            inputAriaLabel="Slippage %"
            title="The band on the first leg's limit: mid ± this much. The hedge leg goes at market."
            hint="Max distance from mid the first leg's limit will accept. A wider band may be needed for a large size or a thin book."
            quick={['0.2', '0.5', '1', '2']}
          />
        </div>
      </EstimateCard>

      <div className="flex flex-col gap-1.5">
        <ExecuteControl
          scope={`close-both-${base}`}
          actions={actions}
          tone="red"
          label={
            <>
              Close both
              <ChevronRight size={14} aria-hidden />
            </>
          }
          // See CloseBoth: the per-mount pairGroupId would otherwise change the
          // intent identity on every remount and break idempotent recovery.
          // ⚠ `slip` is part of the intent — it rides the wire as `slippagePct`
          // and sets the close's price band. Without it here, a lost-response
          // confirm followed by a slippage edit produced a byte-identical key,
          // so the persisted deal id was resent and the server deduped it into
          // the ORIGINAL band while the form showed the new one — the same bug
          // class PairTicket's intentKey fixes by carrying `sizeUnit`.
          // ⚠ And the TYPED size, for the same reason: `l.qty` is the leg's
          // attributed allocation (a prop), not what the box says. Without it a
          // lost-response confirm at 0.5 followed by "max" resent the same deal
          // id, the server deduped it to the 0.5 close, and the form reported
          // the full close as done.
          intentKey={['closeBoth', String(slip), qtyStr, ...legs.map((l) => `${l.symbol}:${l.qty}`)].join('|')}
          buttonClassName="w-full"
          // The panel above already reviews this close; the hover card would
          // repeat it on top of the dialog. Errors still surface.
          hoverCard={false}
        />
        {/* The mechanics, once, under the button — with the qualification
            about which leg carries the band as the hover text. */}
        <p className="text-[11px] leading-relaxed text-ink-400" title={PAIR_NOTE}>
          <span className="font-medium text-ink-200">Reduce-only</span> — first leg limit at mid ± slippage;
          hedge leg at market. Neither can increase a position or rest on the book.
        </p>
      </div>
    </div>
  );
}
