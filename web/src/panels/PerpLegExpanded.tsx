/** Expanded content for a perp row inside a home box: Entry / Mark / Lev /
 * funding from the LIVE 4s-polled position, plus the [Close]/[Lev] actions.
 * The live position may momentarily be missing (closed between polls, or the
 * strategy feed is ahead of the positions feed) — render dashes, never guess. */
import { useRef, useState } from 'react';
import type { CrossexPosition } from '../api/types';
import { SignedNumber } from '../components/SignedNumber';
import { fmtPct, num, sig, signedClass } from '../lib/fmt';
import { ClosePopover } from '../trade/ClosePopover';
import { Modal } from '../components/Modal';
import { LeverageEditor } from '../trade/LeverageEditor';
import { useTradeFlowOptional } from '../trade/TradeFlow';

/** Row actions: [Close] anchors the close popover; [Lev] swaps to the inline
 * leverage editor. Both need the trade contexts — without them (provider-less
 * unit tests) the buttons stay disabled. */
export function PositionRowActions({
  position,
  attributedQty,
  closeOnly = false,
}: {
  position: CrossexPosition;
  /** Size the strategy showing this row owns, when the venue leg is shared. */
  attributedQty?: number;
  /** Drop [Lev] and keep [Close]. The collapsed leg row has six columns to fit
   * inside a fixed-width card, and leverage is not something you reach for at
   * a glance the way closing is — it stays in the expanded detail, where the
   * entry/mark/leverage figures it acts on are already shown. */
  closeOnly?: boolean;
}) {
  const flow = useTradeFlowOptional();
  const [open, setOpen] = useState<'close' | 'lev' | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const enabled = Boolean(flow);

  // The leverage editor used to REPLACE these buttons inline, which widened the
  // row and shoved everything to its right out of the card. Transient UI has to
  // overlay, never reflow — so it opens in a portaled modal instead.
  const levModal =
    open === 'lev' ? (
      <Modal
        title={`Leverage — ${position.symbol}`}
        onClose={() => setOpen(null)}
        widthClass="w-[420px]"
      >
        <div className="p-4">
          <LeverageEditor position={position} onDone={() => setOpen(null)} />
        </div>
      </Modal>
    ) : null;

  return (
    // Always at full opacity. These were `opacity-40` until hovered, which on
    // a real-money surface meant the only way to close a leg was to discover a
    // control that looked disabled — and on touch, never to see it at all.
    <span className="inline-flex gap-1.5">
      <button
        ref={closeBtnRef}
        type="button"
        className="btn-ghost-xs"
        disabled={!enabled}
        title={enabled ? `Close ${position.symbol}` : 'trading unavailable'}
        onClick={() => setOpen('close')}
      >
        Close
      </button>
      {!closeOnly && (
        <button
          type="button"
          className="btn-ghost-xs"
          disabled={!enabled}
          title={enabled ? `Set leverage for ${position.symbol}` : 'trading unavailable'}
          onClick={() => setOpen('lev')}
        >
          Lev
        </button>
      )}
      {open === 'close' && (
        <ClosePopover
          position={position}
          attributedQty={attributedQty}
          onDismiss={() => setOpen(null)}
        />
      )}
      {levModal}
    </span>
  );
}

export function PerpLegExpanded({
  position,
  attributedQty,
  share = 1,
}: {
  position: CrossexPosition | null;
  attributedQty?: number;
  /** This card's fraction of the venue leg. The live feed's uPnL covers the
   * WHOLE position, so a card owning part of a shared leg must scale it —
   * otherwise every sibling card shows the same dollars and the book appears
   * to have made them several times over. The RATE is per-unit and needs no
   * scaling. Used to live on the card's MTM column, which the leg table no
   * longer carries; the guarantee moved here with the number. */
  share?: number;
}) {
  if (!position) {
    return (
      <span className="text-xs text-ink-500">
        Live position not found — it may have just closed, or the positions feed is refreshing.
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="num text-xs text-ink-300">
        Entry <span className="text-ink-100">{sig(position.entryPrice)}</span> · Mark{' '}
        <span className="text-ink-100">{sig(position.markPrice)}</span> · Lev{' '}
        <span className="text-ink-100">{position.leverage}x</span>
        <span className="text-[10px] text-ink-500"> /max {position.maxLeverage}x</span> · uPnL{' '}
        <SignedNumber
          value={Number(position.upnl) * share}
          format={(n) => num(n)}
        />{' '}
        <span className={`text-[10px] ${signedClass(position.upnlRate)}`}>
          {Number(position.upnlRate) > 0 ? '+' : ''}
          {fmtPct(position.upnlRate)}
        </span>
      </span>
      <PositionRowActions position={position} attributedQty={attributedQty} />
    </span>
  );
}
