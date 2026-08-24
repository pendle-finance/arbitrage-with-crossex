/**
 * Close-position dialog for a position row: slippage band, full vs partial qty
 * (validated against the live position), and a live preview of the reduce-only
 * IOC marketable-limit close. "Close now" is inline hold-to-confirm.
 *
 * Centred rather than anchored to its trigger. It used to position itself
 * below-right of the button, with clamping, scroll re-anchoring and a
 * ResizeObserver to survive a dialog that grows as its preview loads — all of
 * which existed to keep an anchored panel on screen. Closing one leg and
 * closing the whole pair are the same decision at different sizes, so they now
 * share one surface, and the anchoring machinery is gone with it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionInput, CrossexPosition } from '../api/types';
import { Modal } from '../components/Modal';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { SignedNumber } from '../components/SignedNumber';
import { SideChip, SymbolCell } from '../components/VenueChip';
import { fmtUsd, sig } from '../lib/fmt';
import { ExecuteControl } from './ExecuteControl';
import { feeText, PreviewFallback, ViolationList } from './previewBits';
import { usePreviewDebounced } from './usePreview';

const CLOSE_INFO =
  'The close is sent as a reduce-only IOC limit at mark ± slippage — it can never increase the position and never rests on the book.';

interface Props {
  position: CrossexPosition;
  /** Size THIS strategy owns, when the venue position is shared with another
   * one. The close acts on the whole venue position, so the popover opens on
   * partial, pre-filled with this size, and says what Full would really do. */
  attributedQty?: number;
  /**
   * How much this close took off the venue, fired once the deal is accepted.
   *
   * ⚠ ACCEPTED, NOT FILLED. `onExecuted` runs on the 202, and this is a
   * reduce-only IOC that can come back short. The caller uses it to shrink a
   * claim, so the error is one-directional: a short fill leaves the card
   * claiming LESS than it holds, and the difference surfaces as size no
   * position claims — visible, and re-assignable in one click. The reverse
   * (which is what happens with no callback at all) is a card silently
   * claiming size it already sold, taken out of whoever shares the leg.
   */
  onClosed?: (qty: number) => void;
  onDismiss: () => void;
}

export function ClosePopover({ position, attributedQty, onClosed, onDismiss }: Props) {
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



  // A centred dialog, not a control anchored to the button that opened it.
  // Closing one leg and closing the pair are the same decision at different
  // sizes, so they get the same surface — and an anchored panel next to a table
  // row competes with the row it is about.
  return (
    <Modal title={`Close ${position.symbol}`} onClose={onDismiss} widthClass="w-[420px]">
      <div ref={dialogRef} className="p-4">
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
            onExecuted={() => {
              // Full acts on the WHOLE venue position, so it takes this card's
              // claim with it whatever the card owns.
              onClosed?.(mode === 'full' ? wholeQty : qtyNum);
              onDismiss();
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
