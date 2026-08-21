/**
 * Anchored close-position popover for a position row: slippage band, full vs
 * partial qty (validated against the live position), and a live preview of the
 * reduce-only IOC marketable-limit close. "Close now" is inline hold-to-confirm.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ActionInput, CrossexPosition } from '../api/types';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { SignedNumber } from '../components/SignedNumber';
import { SideChip, SymbolCell } from '../components/VenueChip';
import { fmtUsd, sig } from '../lib/fmt';
import { ExecuteControl } from './ExecuteControl';
import { feeText, PreviewFallback, ViolationList } from './previewBits';
import { usePreviewDebounced } from './usePreview';

const CLOSE_INFO =
  'The close is sent as a reduce-only IOC limit at mark ± slippage — it can never increase the position and never rests on the book.';

const WIDTH = 300;
const MARGIN = 8;

interface Props {
  position: CrossexPosition;
  /** Size THIS strategy owns, when the venue position is shared with another
   * one. The close acts on the whole venue position, so the popover opens on
   * partial, pre-filled with this size, and says what Full would really do. */
  attributedQty?: number;
  /** Trigger button to anchor near (null → fallback placement, e.g. in tests).
   * A live ref, not a rect: the popover re-anchors on scroll/resize. */
  anchorRef: RefObject<HTMLElement> | null;
  onDismiss: () => void;
}

export function ClosePopover({ position, attributedQty, anchorRef, onDismiss }: Props) {
  const wholeQty = Math.abs(Number(position.positionQty));
  // A shared leg: this card owns less than the venue holds.
  const shared =
    attributedQty !== undefined &&
    Number.isFinite(attributedQty) &&
    attributedQty > 0 &&
    attributedQty < wholeQty * 0.999;
  const [slipStr, setSlipStr] = useState('0.5');
  const [mode, setMode] = useState<'full' | 'partial'>(shared ? 'partial' : 'full');
  const [qtyStr, setQtyStr] = useState(shared ? String(Number(attributedQty.toPrecision(8))) : '');
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const posQty = Math.abs(Number(position.positionQty));
  const slip = Number(slipStr);
  const slipInvalid = !Number.isFinite(slip) || slip <= 0 || slip > 10;
  const qtyNum = Number(qtyStr);
  const partialMissing = mode === 'partial' && qtyStr.trim() === '';
  const partialInvalid =
    mode === 'partial' && qtyStr.trim() !== '' && (!Number.isFinite(qtyNum) || qtyNum <= 0 || qtyNum > posQty);

  const action = useMemo<ActionInput | null>(() => {
    if (slipInvalid || partialMissing || partialInvalid) return null;
    return {
      kind: 'close-position',
      symbol: position.symbol,
      slippagePct: slip,
      ...(mode === 'partial' ? { qty: qtyStr } : {}),
    };
  }, [slipInvalid, partialMissing, partialInvalid, position.symbol, slip, mode, qtyStr]);

  const preview = usePreviewDebounced(`close-${position.symbol}`, action ? [action] : null, {
    debounceMs: 300,
    refetchInterval: 3_000,
  });
  const p = preview.previews?.[0];
  const estimating = preview.estimating;

  // Partial closes realize a proportional share of the position's uPnL.
  const upnlToRealize = p?.closing
    ? Number(p.closing.upnl) *
      (Number(p.closing.positionQty) !== 0 ? Math.min(1, Number(p.qty) / Math.abs(Number(p.closing.positionQty))) : 1)
    : null;

  // Anchored below-right of the trigger, but CLAMPED into the viewport: a row
  // near the bottom would otherwise push the dialog off-screen, where it can't
  // be scrolled to (it is position: fixed). The dialog also GROWS after opening
  // — partial-qty input, async preview, violation rows — so remeasure on resize
  // too, and re-anchor on scroll since fixed coords are viewport-relative.
  useLayoutEffect(() => {
    if (!anchorRef) return; // no anchor (tests) → keep the static fallback
    const reposition = () => {
      const btn = anchorRef.current;
      const dlg = dialogRef.current;
      if (!btn || !dlg) return;
      const r = btn.getBoundingClientRect();
      const top = Math.max(MARGIN, Math.min(r.bottom + 6, window.innerHeight - dlg.offsetHeight - MARGIN));
      const left = Math.max(MARGIN, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - MARGIN));
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
    if (ro && dialogRef.current) ro.observe(dialogRef.current);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      ro?.disconnect();
    };
  }, [anchorRef]);

  const style = pos ?? { top: 96, right: 16 };

  return (
    <div className="fixed inset-0 z-50" role="presentation" onClick={onDismiss}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={`Close ${position.symbol}`}
        // max-h + scroll is the last resort for viewports shorter than the
        // dialog; the hold-to-confirm error card is portaled, so it escapes it.
        className="fixed max-h-[calc(100vh-16px)] w-[300px] overflow-y-auto rounded-xl border border-ink-600 bg-ink-900 p-3 shadow-2xl"
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink-100">Close position</span>
          <button type="button" aria-label="dismiss" className="btn-ghost-xs px-1.5" onClick={onDismiss}>
            ✕
          </button>
        </div>
        <div className="mb-2">
          <SymbolCell symbol={position.symbol} />
        </div>

        <div className="flex flex-col gap-2 text-[11px]">
          <div className="flex items-center gap-2">
            <label htmlFor={`close-slip-${position.symbol}`} className="w-24 text-ink-400">
              Slippage %
            </label>
            <input
              id={`close-slip-${position.symbol}`}
              className={`input num h-8 flex-1 px-2 py-1 ${slipInvalid ? 'border-rose-500' : ''}`}
              inputMode="decimal"
              value={slipStr}
              onChange={(e) => setSlipStr(e.target.value)}
            />
          </div>
          {slipInvalid && <span className="text-rose-400">slippage must be in (0, 10]</span>}

          <div className="flex items-center gap-2">
            <span className="w-24 text-ink-400">Amount</span>
            <SegmentedToggle<'full' | 'partial'>
              ariaLabel="Close amount"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'full', label: <span className="text-xs">full</span> },
                { value: 'partial', label: <span className="text-xs">partial</span> },
              ]}
            />
          </div>
          {/* The venue holds one position; a close acts on all of it. Say so
              where the choice is made, not after the fact. */}
          {shared && (
            <p className="leading-relaxed text-amber-400/90">
              {mode === 'full'
                ? `Full closes all ${sig(wholeQty)} on the venue — including the ${sig(wholeQty - (attributedQty ?? 0))} that belongs to your other position.`
                : `This position holds ${sig(attributedQty ?? 0)} of the ${sig(wholeQty)} on the venue; the rest belongs to another position.`}
            </p>
          )}
          {mode === 'partial' && (
            <div className="flex items-center gap-2">
              <label htmlFor={`close-qty-${position.symbol}`} className="w-24 text-ink-400">
                Close qty
              </label>
              <input
                id={`close-qty-${position.symbol}`}
                className={`input num h-8 flex-1 px-2 py-1 ${partialInvalid ? 'border-rose-500' : ''}`}
                inputMode="decimal"
                placeholder={`≤ ${sig(posQty)}`}
                value={qtyStr}
                onChange={(e) => setQtyStr(e.target.value)}
              />
            </div>
          )}
          {partialInvalid && <span className="text-rose-400">close qty exceeds position ({sig(posQty)})</span>}

          {action && (
            <div className="flex flex-col gap-1 rounded-lg border border-ink-800 bg-ink-950/60 px-2.5 py-2">
              {p ? (
                <>
                  {estimating && <span className="text-amber-400">estimating…</span>}
                  <span className="flex items-center gap-1.5 text-ink-300">
                    <SideChip side={p.side} />
                    <span className="num text-ink-100">{p.qty ? sig(p.qty) : '—'}</span>
                  </span>
                  <span className="text-ink-400">
                    marketable limit px <span className="num text-ink-100">{p.price ? sig(p.price) : '—'}</span>
                  </span>
                  <span className="text-ink-400">
                    uPnL to realize{' '}
                    {upnlToRealize !== null ? <SignedNumber value={upnlToRealize} format={(n) => fmtUsd(n)} /> : '—'}
                  </span>
                  <span className="text-ink-400">est fee {feeText(p.fees)}</span>
                  <span className="cursor-help text-ink-500" title={CLOSE_INFO}>
                    reduce-only IOC marketable limit ⓘ
                  </span>
                  <ViolationList violations={p.violations} warnings={p.warnings} />
                </>
              ) : (
                <PreviewFallback isError={preview.isError} error={preview.error} />
              )}
            </div>
          )}

          <ExecuteControl
            scope={`close-${position.symbol}`}
            actions={action ? [action] : null}
            tone="red"
            label="Close now ▸"
            buttonClassName="mt-1 w-full"
            // The preview box right above already reviews this close — the hover
            // card would just repeat it on top of the popover. Errors still open it.
            hoverCard={false}
            previewOpts={{ debounceMs: 300, refetchInterval: 3_000 }}
            onExecuted={onDismiss}
          />
        </div>
      </div>
    </div>
  );
}
