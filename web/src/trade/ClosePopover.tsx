/**
 * Close-position dialog for a position row: one close size (pre-filled with
 * the maximum and validated against the live position), a live preview of the
 * reduce-only IOC marketable-limit close, and the slippage band below it.
 * "Close now" is inline hold-to-confirm.
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
import { fieldValue, fmtUsd, parseSymbol, prettyVenue, sig } from '../lib/fmt';
import { sizeUnitForBase } from '../lib/boros';
import { ExecuteControl } from './ExecuteControl';
import { feeText, PreviewFallback, ViolationList } from './previewBits';
import { usePreviewDebounced } from './usePreview';

const CLOSE_INFO =
  'The close is sent as a reduce-only IOC limit at mid ± slippage — it can never increase the position and never rests on the book.';

interface Props {
  position: CrossexPosition;
  /** Size THIS strategy owns, when the venue position is shared with another
   * one. It caps the close and pre-fills the box, so the default never takes
   * size out of the position that shares the leg. */
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
  /**
   * This leg is one side of a hedge, so closing it leaves the other side naked.
   *
   * A delta-neutral pair earns because the two floating legs cancel; close one
   * and what remains is a directional funding bet the user did not choose to
   * put on. The card-level "Close perp pair" says what it does by its name —
   * this row-level control did not, and said nothing about the consequence.
   */
  hedgedSibling?: { venue: string; side: 'LONG' | 'SHORT' } | null;
  onDismiss: () => void;
}

export function ClosePopover({
  position,
  attributedQty,
  onClosed,
  hedgedSibling,
  onDismiss,
}: Props) {
  const wholeQty = Math.abs(Number(position.positionQty));
  // A shared leg: this card owns less than the venue holds.
  const shared =
    attributedQty !== undefined &&
    Number.isFinite(attributedQty) &&
    attributedQty > 0 &&
    attributedQty < wholeQty * 0.999;
  const [slipStr, setSlipStr] = useState('0.5');
  /**
   * ONE size box, pre-filled with the maximum, exactly as the Boros and pair
   * closes work. The old full/partial toggle made the common case (close it
   * all) a mode rather than a default, and hid the number the other close
   * forms put front and centre — so the same decision looked like two
   * different controls depending on which row you clicked.
   *
   * `null` means untouched: the field shows the max and follows it as the
   * position refreshes, rather than latching a figure the user never typed.
   */
  const [qtyEdited, setQtyEdited] = useState<string | null>(null);
  /**
   * Which unit the size box is in.
   *
   * A close has to be sizeable in DOLLARS because that is the unit the other
   * half of the trade uses: a HYPE position's Boros leg is USDT-collateral and
   * its notional reads $100, so closing "0.63 HYPE" to match it means doing an
   * FX conversion by eye — on the leg where a slip leaves a naked remainder.
   * Follows the same rule as the tickets (ETH/BTC in the coin, everything else
   * in dollars) so one strategy is sized in one unit end to end.
   *
   * The wire format is unchanged: the server's close action takes `qty` only,
   * so a USD figure is converted here, at the mark the dialog already shows.
   */
  const base = parseSymbol(position.symbol).base;
  /**
   * ⚠ A shared leg PREFILLS the box with a base quantity (the size this card
   * owns), so the unit must start as `base` regardless of the coin's default —
   * otherwise 0.63 HYPE would be relabelled as $0.63. The user can switch, and
   * the toggle converts the figure with it.
   */
  const [unit, setUnit] = useState<'base' | 'usd'>(() =>
    shared ? 'base' : sizeUnitForBase(base),
  );
  /**
   * ⚠ LATCHED at dialog open, not read live. The `position` prop refreshes
   * from the 4s positions poll while the dialog is up, and `effUnit` below is
   * derived from the mark — so a mark that turned empty/zero mid-dialog would
   * silently re-read a typed "$300" as 300 COINS (and a recovering mark would
   * divide typed coins by it), with only the label quietly changing. The
   * conversion price the user was shown when they started typing is the one
   * every read uses until the dialog closes; the preview below still quotes
   * live prices server-side.
   */
  const [mark] = useState(() => Number(position.markPrice));
  const markOk = Number.isFinite(mark) && mark > 0;
  /**
   * ⚠ USD is only a legal unit while there is a mark to convert AT.
   *
   * Gating the toggle on `markOk` was not enough: the DEFAULT is 'usd' for
   * every non-ETH/BTC coin, so a position whose `markPrice` arrives empty,
   * zero or unparseable sat in 'usd' with the toggle hidden — and the
   * conversion fell through to `entered`, sending a DOLLAR figure as a base
   * quantity. A "$50" partial close of HYPE would have sent 50 HYPE. Every
   * read of the unit goes through this, so the box, the validation, the wire
   * value and `onClosed` can never disagree about what the number means.
   */
  const effUnit: 'base' | 'usd' = markOk ? unit : 'base';
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const posQty = Math.abs(Number(position.positionQty));
  /**
   * The cap, in BASE units.
   *
   * A shared leg's max is what THIS card owns — closing past it eats size
   * belonging to another position. Unshared, the venue position is the limit.
   * A shared venue leg is therefore closed from each position that holds a
   * share of it, one close per position (his call 2026-09-09) — there is no
   * "flatten the whole venue leg" path here.
   */
  const maxQtyBase = shared ? (attributedQty as number) : posQty;
  const slip = Number(slipStr);
  const slipInvalid = !Number.isFinite(slip) || slip <= 0 || slip > 10;
  // The cap in whatever unit the box is currently in — what the "max" hint
  // shows and what the MAX button fills in.
  const maxInUnit = effUnit === 'usd' ? maxQtyBase * mark : maxQtyBase;
  const qtyStr = qtyEdited ?? fieldValue(maxInUnit);
  const entered = Number(qtyStr);
  /**
   * The order is always sent in base units. A USD entry converts at the mark —
   * the same price the preview below quotes — and with no usable mark the USD
   * option is not offered at all, so this cannot silently divide by a stale or
   * zero price.
   */
  const rawQty = effUnit === 'usd' ? entered / mark : entered;
  /**
   * The displayed maximum is `sig()`-rounded to-nearest, so typing the
   * dialog's OWN stated limit ("≤ 151.2019") can convert to a hair above
   * `posQty` — refusing it would reject the very figure the placeholder and
   * the error message name. Sizes within rounding distance are accepted and
   * clamped to the position, so nothing can over-close.
   */
  const qtyNum = Math.min(rawQty, posQty);
  /**
   * A relative tolerance, as in the Boros close: the field carries the max
   * `sig()`-rounded, so the round-trip of the dialog's own stated maximum
   * lands a hair above it on a large position.
   */
  // The tolerance is at least the rounding the DISPLAY applied: `sig()` keeps
  // 4 dp from 1 and 2 dp from 1,000, so a flat 1e-7 relative slack refused
  // "151.202" typed against a 151.20195 position — the very figure the max
  // hint printed. Converted back to base units when the box is in USD.
  const displayRounding = (() => {
    const shown = Number(sig(maxInUnit));
    if (!Number.isFinite(shown)) return 0;
    const slack = Math.abs(shown - maxInUnit);
    return effUnit === 'usd' && mark > 0 ? slack / mark : slack;
  })();
  const qtyEps = Math.max(1e-9, maxQtyBase * 1e-7, displayRounding);
  const qtyInvalid =
    qtyStr.trim() === '' ||
    !Number.isFinite(entered) ||
    entered <= 0 ||
    !Number.isFinite(rawQty) ||
    rawQty <= 0 ||
    rawQty > maxQtyBase + qtyEps;
  // Below the cap ⇒ a reduce-only partial; at the cap on an UNSHARED leg it is
  // the whole venue position, which the server closes best by qty-less action.
  const closesEverything = !shared && rawQty >= posQty - qtyEps;

  const action = useMemo<ActionInput | null>(() => {
    if (slipInvalid || qtyInvalid) return null;
    return {
      kind: 'close-position',
      symbol: position.symbol,
      slippagePct: slip,
      ...(closesEverything ? {} : { qty: fieldValue(qtyNum) }),
    };
  }, [slipInvalid, qtyInvalid, position.symbol, slip, closesEverything, qtyNum]);

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
          {/* The venue holds one position; this card may own only part of it.
              Say so where the size is chosen, not after the fact. */}
          {shared && (
            <p className="leading-relaxed text-amber-400/90">
              This position holds {sig(attributedQty ?? 0)} of the {sig(wholeQty)} on the venue; the
              rest belongs to another position.
            </p>
          )}
          {hedgedSibling && (
            /* The consequence, not the mechanics: this pair earns because the
               two floating legs cancel, and closing one end leaves the other
               running as a directional funding bet. */
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-1.5 leading-relaxed text-amber-100">
              This leg hedges the {prettyVenue(hedgedSibling.venue)} {hedgedSibling.side.toLowerCase()}{' '}
              leg. Closing it leaves that one unhedged — its funding stops cancelling and becomes a
              directional position.
            </p>
          )}
          {/* Same shape as the Boros and pair closes: the size leads, the max
              sits beside its label as a button, the simulation follows. */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <label htmlFor={`close-qty-${position.symbol}`} className="text-ink-400">
                Close size
              </label>
              <span className="num text-ink-400">
                max{' '}
                <button
                  type="button"
                  className="underline decoration-dotted underline-offset-2 hover:text-ink-200"
                  title={
                    shared
                      ? 'Close everything this position owns on the venue'
                      : 'Close the whole position'
                  }
                  onClick={() => setQtyEdited(fieldValue(maxInUnit))}
                >
                  {sig(maxInUnit)} {effUnit === 'usd' ? 'USDT' : base}
                </button>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                id={`close-qty-${position.symbol}`}
                className={`input num h-8 flex-1 px-2 py-1 ${qtyInvalid ? 'border-rose-500' : ''}`}
                inputMode="decimal"
                value={qtyStr}
                onChange={(e) => setQtyEdited(e.target.value)}
                /* The visible label reads "Close size" in both units, but the
                   ACCESSIBLE name still says which unit the box is in — a
                   screen reader (and the tests that guard the fallback to coin
                   units) would otherwise have no way to tell 50 dollars from
                   50 coins. */
                aria-label={effUnit === 'usd' ? 'Close value' : 'Close qty'}
              />
              {/* Only when a mark is available to convert with. */}
              {markOk && (
                <SegmentedToggle<'base' | 'usd'>
                  ariaLabel="Close size unit"
                  value={unit}
                  onChange={(u) => {
                    // Carry the SIZE across the switch, not the digits: the box
                    // holds one number and relabelling it would silently resize
                    // the close by the mark price.
                    const n = Number(qtyStr);
                    if (Number.isFinite(n) && n > 0) {
                      const asQty = unit === 'usd' ? n / mark : n;
                      setQtyEdited(fieldValue(u === 'usd' ? asQty * mark : asQty));
                    }
                    setUnit(u);
                  }}
                  options={[
                    { value: 'base', label: <span className="text-xs">{base}</span> },
                    { value: 'usd', label: <span className="text-xs">USDT</span> },
                  ]}
                />
              )}
            </div>
          </div>
          {qtyInvalid && qtyStr.trim() !== '' && (
            <span className="text-rose-400">
              close size exceeds {shared ? "this position's share" : 'position'} (
              {effUnit === 'usd' ? `${sig(maxInUnit)} USDT` : `${sig(maxInUnit)} ${base}`})
            </span>
          )}
          {effUnit === 'usd' && !qtyInvalid && qtyStr.trim() !== '' && (
            // The converted figure is what actually goes to the venue, so it
            // is shown rather than left to be inferred from the preview.
            <span className="text-ink-500">
              ≈ <span className="num">{sig(qtyNum)}</span> {base} at mark{' '}
              <span className="num">{sig(mark)}</span>
            </span>
          )}

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
                    <span title="Reduce-only IOC limit at mid ± slippage — fills what it can at once, never rests, never adds">limit px</span>{' '}
                    <span className="num text-ink-100">{p.price ? sig(p.price) : '—'}</span>
                  </span>
                  <span className="text-ink-400">
                    uPnL to realize{' '}
                    {upnlToRealize !== null ? <SignedNumber value={upnlToRealize} format={(n) => fmtUsd(n)} /> : '—'}
                  </span>
                  <span className="text-ink-400">est fee {feeText(p.fees)}</span>
                  <span className="cursor-help text-ink-500" title={CLOSE_INFO}>
                    reduce-only ⓘ
                  </span>
                  <ViolationList violations={p.violations} warnings={p.warnings} />
                </>
              ) : (
                <PreviewFallback isError={preview.isError} error={preview.error} />
              )}
            </div>
          )}

          {/* A plain input, deliberately NOT the Est./Max disclosure the Boros
              close uses: the preview above already states the limit price this
              band produced, so an "Est." summary would restate it. Kept below
              the simulation so the size still leads the form. */}
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
              // A qty-less close acts on the WHOLE venue position, so it takes
              // this card's claim with it whatever the card owns.
              onClosed?.(closesEverything ? wholeQty : qtyNum);
              onDismiss();
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
