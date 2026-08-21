/** Expanded content for a perp row inside a home box: Entry / Mark / Lev /
 * funding from the LIVE 4s-polled position, plus the [Close]/[Lev] actions.
 * The live position may momentarily be missing (closed between polls, or the
 * strategy feed is ahead of the positions feed) — render dashes, never guess. */
import { useRef, useState } from 'react';
import type { CrossexPosition } from '../api/types';
import { SignedNumber } from '../components/SignedNumber';
import { fmtPct, num, sig, signedClass } from '../lib/fmt';
import { ClosePopover } from '../trade/ClosePopover';
import { LeverageEditor } from '../trade/LeverageEditor';
import { useTradeFlowOptional } from '../trade/TradeFlow';

/** Row actions: [Close] anchors the close popover; [Lev] swaps to the inline
 * leverage editor. Both need the trade contexts — without them (provider-less
 * unit tests) the buttons stay disabled. */
export function PositionRowActions({
  position,
  attributedQty,
}: {
  position: CrossexPosition;
  /** Size the strategy showing this row owns, when the venue leg is shared. */
  attributedQty?: number;
}) {
  const flow = useTradeFlowOptional();
  const [open, setOpen] = useState<'close' | 'lev' | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const enabled = Boolean(flow);

  if (open === 'lev') return <LeverageEditor position={position} onDone={() => setOpen(null)} />;

  return (
    <span
      className={`inline-flex gap-1.5 transition-opacity group-hover:opacity-100 ${
        open ? 'opacity-100' : 'opacity-40'
      }`}
    >
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
      <button
        type="button"
        className="btn-ghost-xs"
        disabled={!enabled}
        title={enabled ? `Set leverage for ${position.symbol}` : 'trading unavailable'}
        onClick={() => setOpen('lev')}
      >
        Lev
      </button>
      {open === 'close' && (
        <ClosePopover
          position={position}
          attributedQty={attributedQty}
          anchorRef={closeBtnRef}
          onDismiss={() => setOpen(null)}
        />
      )}
    </span>
  );
}

export function PerpLegExpanded({
  position,
  attributedQty,
}: {
  position: CrossexPosition | null;
  attributedQty?: number;
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
        <SignedNumber value={position.upnl} format={(n) => num(n)} />{' '}
        <span className={`text-[10px] ${signedClass(position.upnlRate)}`}>
          {Number(position.upnlRate) > 0 ? '+' : ''}
          {fmtPct(position.upnlRate)}
        </span>
      </span>
      <PositionRowActions position={position} attributedQty={attributedQty} />
    </span>
  );
}
