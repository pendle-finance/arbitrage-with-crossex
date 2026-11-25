/**
 * ClosePairForm — close both perp legs of a 4-leg pair from the Positions
 * asset card's pairs table. (The strategy-box that once surrounded it is
 * gone; this is the one piece the asset view still needs.)
 */
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSymbolDetail } from '../api/queries';
import type { ActionInput, CrossexPosition, PreviewResult } from '../api/types';
import { ExecModeToggle } from '../components/ExecModeToggle';
import { fieldValue, prettyVenue } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import type { DealOpts } from '../trade/deal';
import { ExecuteControl } from '../trade/ExecuteControl';
import { MakerSettings, REPEG_DEFAULT_BP } from '../trade/MakerSettings';
import { type ExecMode, storedExecMode } from '../trade/PairTicketBits';
import { ClosePairEstimate, matchedCloseOf } from './ClosePairFormBits';
import {
  buildCloseActions,
  closeBookOf,
  CloseHeldLegs,
  CloseMechanics,
  CloseRestNotes,
  CloseSizeField,
  CloseSlipField,
  closeCosts,
  decorateClose,
} from './ClosePairParts';
import { TwapArea, useTwapInput } from '../trade/TwapArea';
import { usePreviewDebounced } from '../trade/usePreview';
import { useTakerAfter, useTwapTakerAfter } from '../trade/useTwapTakerAfter';
import { useTradeFlowOptional } from '../trade/TradeFlow';

/**
 * ⚠ The pair note (`accounts.closePair.pairNote`) is accurate for a PAIR,
 * which is not what the single-leg note says.
 *
 * Only the first leg carries the mid ± slippage band; the hedge leg is sent
 * as a plain MARKET IOC on purpose, because a book-mid limit band cannot
 * reliably stay inside the venue's OWN price-limit band and gets rejected —
 * which would leave the first leg closed and the second still open (see
 * decide.ts). Claiming the band covers both would promise protection the
 * hedge leg does not have.
 */

type RepegBp = DealOpts['repegBehindBp'];

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
  allowTwap = false,
}: {
  base: string;
  /** `partial`: close exactly `qty` rather than the whole venue position —
   * a pair's attributed share of a leg two pairs sit on. */
  legs: Array<{ symbol: string; qty: number; venue: string; partial?: boolean }>;
  /** symbol → live position, for the uPnL each close realises. */
  livePositions?: Map<string, CrossexPosition>;
  allowTwap?: boolean;
}) {
  const { t } = useTranslation();
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
  /** Same default as the open ticket: the perp entry picked on Opportunities. */
  const [mode, setMode] = useState<ExecMode>(() => storedExecMode());
  const [makerLeg, setMakerLeg] = useState<'auto' | 'a' | 'b'>('auto');
  const taker = useTakerAfter();
  const [repeg, setRepeg] = useState<RepegBp>(REPEG_DEFAULT_BP);
  const twap = useTwapInput();
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
  const atMax = qtyNum >= maxCloseQty - qtyEps;
  const closeQtyOf = (legQty: number) => (atMax ? legQty : Math.min(qtyNum, legQty));
  const maker = mode === 'maker';
  const twapOn = allowTwap && maker && twap.on;
  const lotA = useSymbolDetail(twapOn ? (legs[0]?.symbol ?? null) : null).data?.lotSize;
  const lotB = useSymbolDetail(twapOn ? (legs[1]?.symbol ?? null) : null).data?.lotSize;
  const matched =
    twapOn && legs.length === 2 && !qtyInvalid
      ? matchedCloseOf(
          legs.map((l) => l.qty),
          atMax ? null : qtyNum,
          [lotA, lotB],
        )
      : null;
  // null, not [] — ExecuteControl disables on `!actions`, and an empty array
  // is truthy, so [] would leave the button live with nothing to send.
  const actions: ActionInput[] | null =
    legs.length === 2 && !slipInvalid && !qtyInvalid
      ? buildCloseActions({ legs, pairGroupId, slip, matched, closeQtyOf })
      : null;
  const restLegs = matched && atMax ? legs.flatMap((l, i) => (matched.rests[i] !== '0' ? [{ leg: l, qty: matched.rests[i] }] : [])) : [];
  // Not lazy: the dialog exists to show this, so it loads with the form.
  const preview = usePreviewDebounced(`close-pair-${base}`, actions, {
    refetchInterval: 5000,
    twap: twapOn ? twap.input : undefined,
  });
  const plan = preview.data?.twap?.plan ?? null;
  const takerBlocked = useTwapTakerAfter(taker, twapOn, plan?.takerAfterSec ?? null);
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
  // Which leg is the hedge (market IOC) vs the band-carrying first leg: see accounts.closePair.pairNote.
  const sideOf = (symbol: string): 'LONG' | 'SHORT' => {
    const live = livePositions?.get(symbol);
    const q = Number(live?.positionQty ?? NaN);
    if (Number.isFinite(q) && q !== 0) return q > 0 ? 'LONG' : 'SHORT';
    const p = previews?.find((x) => x.symbol === symbol);
    // A close SELLs a long and BUYs a short.
    return p?.side === 'SELL' ? 'LONG' : 'SHORT';
  };

  const autoPick = preview.data?.makerLeg ?? null;
  const picked = makerLeg !== 'auto' ? makerLeg : (autoPick?.auto ?? null);
  const makerIdx = picked === null ? null : picked === 'a' ? 0 : 1;
  const takerSec = taker.sec;
  const twapBlocked = twap.blockedBy(preview.data?.twap);
  const dealOpts: DealOpts | undefined = maker
    ? { makerLeg, repegBehindBp: repeg, timeoutSec: takerSec, clipBandPct: slip }
    : undefined;

  const { tradeCost, makerSaving } = closeCosts(previews, maker, makerIdx, twapOn);
  const planLines =
    maker && makerIdx !== null && previews
      ? previews.map((p, i) => ({
          symbol: p.symbol,
          side: sideOf(p.symbol),
          role: i === makerIdx ? ('rests' as const) : ('hedges' as const),
          qty: p.qty,
        }))
      : [];
  const book = closeBookOf({ previews, makerIdx, maker, qtyStr, estimating: preview.estimating, mode });
  const decorate = (acts: ActionInput[]) => decorateClose(acts, previews, makerIdx, maker);

  return (
    <div className="flex flex-col gap-4">
      <CloseHeldLegs base={base} legs={legs} livePositions={livePositions} sideOf={sideOf} />

      <CloseSizeField
        base={base}
        qtyStr={qtyStr}
        qtyInvalid={qtyInvalid}
        maxCloseQty={maxCloseQty}
        onChange={setQtyEdited}
      />

      <ExecModeToggle
        ariaLabel={t('accounts.closePair.executionAria')}
        fill
        value={mode}
        onChange={setMode}
        order={['maker', 'market']}
        labels={{ maker: t('pairTicket.orderType.limitHedge'), market: t('pairTicket.orderType.market') }}
      />

      {maker && allowTwap && (
        <TwapArea
          on={twap.on}
          onToggle={twap.setOn}
          input={twap.input}
          onInput={twap.setInput}
          preview={actions ? (preview.data?.twap ?? null) : null}
          impact={preview.data?.priceImpact ?? null}
          coin={base}
        />
      )}
      <CloseRestNotes base={base} restLegs={restLegs} sideOf={sideOf} />

      {maker ? (
        <MakerSettings
          legs={legs.map((l) => ({ name: prettyVenue(l.venue), side: sideOf(l.symbol) }))}
          makerLeg={makerLeg}
          autoPick={autoPick}
          saving={maker ? makerSaving : null}
          savingHint={t('accounts.closePair.savingHint')}
          onMakerLeg={setMakerLeg}
          takerAfter={taker.takerAfter}
          onTakerAfter={taker.pick}
          takerCapSec={twapOn ? (plan?.takerAfterSec ?? null) : null}
          repegBehindBp={repeg}
          repegLocked={false}
          onRepeg={(v) => setRepeg(v as RepegBp)}
          marketSlippage={{ value: slip, onChange: (v) => setSlipStr(String(v)) }}
        />
      ) : (
        <CloseSlipField base={base} slipStr={slipStr} slipInvalid={slipInvalid} onChange={setSlipStr} />
      )}

      <ClosePairEstimate
        previews={previews}
        isError={preview.isError}
        error={preview.error}
        estimating={preview.estimating}
        dataUpdatedAt={preview.dataUpdatedAt}
        twapOn={twapOn}
        totalPnl={totalPnl}
        tradeCost={tradeCost}
        plan={planLines}
        book={book}
      />

      <div className="sticky bottom-0 z-10 flex flex-col gap-1.5 bg-ink-950 pb-1 pt-2">
        <ExecuteControl
          scope={`close-both-${base}`}
          actions={actions}
          tone="red"
          label={
            <>
              {t(twapOn ? 'accounts.closePair.twap.start' : 'accounts.closePair.closeBoth')}
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
          // The mode and timeout too: a maker close and a market close of the
          // same size must not share a deal id.
          intentKey={[
            'closeBoth',
            mode,
            maker ? `${makerLeg}:${taker.takerAfter.kind}:${takerSec ?? ''}:${repeg ?? ''}` : '',
            twapOn ? JSON.stringify(twap.input) : '',
            String(slip),
            qtyStr,
            ...legs.map((l) => `${l.symbol}:${l.qty}`),
          ].join('|')}
          decorate={decorate}
          dealOpts={dealOpts}
          twap={twapOn && plan ? { plan, blocked: twapBlocked } : null}
          extraDisabled={(maker && (makerIdx === null || takerBlocked)) || (twapOn && (twapBlocked || !plan))}
          buttonClassName="w-full"
          // The panel above already reviews this close; the hover card would
          // repeat it on top of the dialog. Errors still surface.
          hoverCard={false}
        />
        <CloseMechanics maker={maker} twapOn={twapOn} />
      </div>
    </div>
  );
}
