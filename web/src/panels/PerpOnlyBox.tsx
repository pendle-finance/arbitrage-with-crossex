/**
 * ClosePairForm — close both perp legs of a 4-leg pair from the Positions
 * asset card's pairs table. (The strategy-box that once surrounded it is
 * gone; this is the one piece the asset view still needs.)
 */
import { useMemo, useState } from 'react';
import type { ActionInput, CrossexPosition } from '../api/types';
import { fieldValue, prettyVenue, sig } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import { ExecuteControl } from '../trade/ExecuteControl';
import { ClosePreviewPanel } from '../trade/previewBits';
import { usePreviewDebounced } from '../trade/usePreview';
import { useTradeFlowOptional } from '../trade/TradeFlow';

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

  return (
    <div className="flex flex-col gap-3">
      {/* One size, both legs, capped at this pair's allocation — see
          maxCloseQty. Defaults to the whole allocation, so leaving it alone
          closes the pair exactly as before. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-xs text-ink-400">
          <label htmlFor={`close-pair-qty-${base}`}>Close size</label>
          {/* The ceiling — this pair's own allocation — stated where the
              number is typed, and clickable. */}
          <span className="num">
            max{' '}
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-ink-200"
              title="Close this pair's whole allocation on both legs"
              onClick={() => setQtyEdited(fieldValue(maxCloseQty))}
            >
              {sig(maxCloseQty)} {base}
            </button>
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <input
            id={`close-pair-qty-${base}`}
            className={`input num h-7 flex-1 px-2 py-0.5 ${qtyInvalid ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            value={qtyStr}
            onChange={(e) => setQtyEdited(e.target.value)}
            aria-label="Close size, applied to both legs"
          />
          <span className="text-ink-500">{base}</span>
        </div>
      </div>
      {qtyInvalid && (
        <span className="text-[11px] text-rose-300">
          size must be above 0 and at most {sig(maxCloseQty)} {base}
        </span>
      )}
      <ClosePreviewPanel
        previews={preview.previews}
        estimating={preview.estimating}
        isError={preview.isError}
        error={preview.error}
        labelFor={(_p, i) => prettyVenue(legs[i]?.venue ?? '')}
        realizedFor={(p, i) => {
          const live = livePositions?.get(legs[i]?.symbol ?? '');
          if (!live) return null;
          // A partial close realises only its slice of the position's uPnL:
          // scale by the close qty the resolver actually stamped over what
          // the venue holds. A whole close is the ratio 1.
          const held = Math.abs(Number(live.positionQty));
          const closing = Number(p.qty);
          const frac = held > 0 && Number.isFinite(closing) ? Math.min(1, closing / held) : 1;
          return Number(live.upnl) * frac;
        }}
        /**
         * ⚠ Accurate for a PAIR, which is not what the single-leg note says.
         *
         * Only the first leg carries the mid ± slippage band; the hedge leg
         * is sent as a plain MARKET IOC on purpose, because a book-mid limit
         * band cannot reliably stay inside the venue's OWN price-limit band
         * and gets rejected — which would leave the first leg closed and the
         * second still open (see decide.ts). Claiming the band covers both
         * would promise protection the hedge leg does not have.
         */
        note="The first leg is a reduce-only IOC limit at mid ± slippage; the hedge leg is sent at market, inside the venue's own price band. Neither can increase a position or rest on the book."
        hedgeAtMarket
      />
      {/* A plain input, deliberately NOT the Est./Max disclosure the Boros and
          single-leg closes use: the preview above already prints each leg's
          own slippage on its own row, so an "Est." summary here would restate
          a number the user is already looking at. */}
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor={`close-pair-slip-${base}`} className="w-24 text-ink-400">
          Slippage %
        </label>
        <input
          id={`close-pair-slip-${base}`}
          className={`input num h-8 flex-1 px-2 py-1 ${slipInvalid ? 'border-rose-500' : ''}`}
          inputMode="decimal"
          value={slipStr}
          onChange={(e) => setSlipStr(e.target.value)}
        />
      </div>
      {slipInvalid && (
        <span className="text-xs text-rose-400">slippage must be in (0, 10]</span>
      )}
      <ExecuteControl
        scope={`close-both-${base}`}
        actions={actions}
        tone="red"
        label="Close both ▸"
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
    </div>
  );
}
