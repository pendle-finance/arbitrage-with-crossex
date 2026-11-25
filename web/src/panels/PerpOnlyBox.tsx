/**
 * ClosePairForm — close both perp legs of a 4-leg pair from the Positions
 * asset card's pairs table. (The strategy-box that once surrounded it is
 * gone; this is the one piece the asset view still needs.)
 */
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { ActionInput, CrossexPosition, PreviewResult } from '../api/types';
import { ExecModeToggle } from '../components/ExecModeToggle';
import { SignedNumber } from '../components/SignedNumber';
import { SideChip } from '../components/VenueChip';
import { fieldValue, fmtUsd, parseSymbol, prettyVenue, sig } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import type { DealOpts } from '../trade/deal';
import { EstimateHeadline } from '../trade/EstimateHeadline';
import { ExecuteControl } from '../trade/ExecuteControl';
import { MakerSettings, REPEG_DEFAULT_BP } from '../trade/MakerSettings';
import { AffixedInput, EstimateCard, type ExecMode, LegCard, storedExecMode } from '../trade/PairTicketBits';
import { estFeeOf, PreviewFallback, SlippageBadge, ViolationList } from '../trade/previewBits';
import { FieldLabel } from '../trade/SymbolCombobox';
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

/** Largest single order a maker close sends on either leg, in dollars. A
 * resting maker fill or the timeout's leftover then reaches the books in
 * slices this size, not as one order that walks the whole book. */
const CLOSE_CLIP_USD = 100_000;

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
          ...(l.partial || closeQtyOf(l.qty) < l.qty - Math.max(1e-9, l.qty * 1e-7)
            ? { qty: fieldValue(closeQtyOf(l.qty)) }
            : {}),
        }))
      : null;
  const maker = mode === 'maker';
  const twapOn = allowTwap && maker && twap.on;
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

  // Maker + hedge: the previews price both legs as market closes; the resting
  // leg's fee is recomputed at the maker rate, and its slippage is not paid.
  const notionalOf = (p: PreviewResult): number | null => {
    const mid = p.fillEstimate?.midPrice;
    const q = Number(p.qty);
    return mid && Number.isFinite(q) ? q * mid : (p.estNotional ?? null);
  };
  const legFee = (p: PreviewResult, i: number): number | null => {
    if (!p.fees) return null;
    if (!maker || i !== makerIdx) return estFeeOf(p);
    const n = notionalOf(p);
    return n === null ? null : n * p.fees.makerRate;
  };
  const makerSaving = (() => {
    const p = makerIdx === null ? undefined : previews?.[makerIdx];
    const n = p ? notionalOf(p) : null;
    return !twapOn && p?.fees && n !== null ? n * (p.fees.takerRate - p.fees.makerRate) : null;
  })();
  /** Confirm-time only: the roles and maker settings never reach /preview. */
  const decorate = (acts: ActionInput[]): ActionInput[] => {
    if (!maker || !previews || previews.length !== 2 || makerIdx === null) return acts;
    const mp = previews[makerIdx];
    const mid = mp.fillEstimate?.midPrice ?? Number(mp.price);
    if (!(mid > 0)) return acts;
    const maxClip = fieldValue(CLOSE_CLIP_USD / mid);
    return acts.map((a, i) =>
      a.kind === 'close-position'
        ? {
            ...a,
            pairRole: i === makerIdx ? ('maker' as const) : ('hedge' as const),
            ...(i === makerIdx ? { makerPrice: String(mid) } : {}),
            maxClip,
          }
        : a,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* What is held, leg by leg — the sizes here are this pair's slice of
          each venue position, which is what the close is capped at. */}
      <div className="flex flex-col gap-1.5">
        {legs.map((l) => {
          const live = livePositions?.get(l.symbol);
          const held = live ? Math.abs(Number(live.positionQty)) : null;
          const { quote } = parseSymbol(l.symbol);
          const slice = l.partial === true;
          return (
            <LegCard
              key={l.symbol}
              kind="Perp"
              venue={prettyVenue(l.venue)}
              side={sideOf(l.symbol)}
              sub={`${base}-${quote || 'USDT'} · ${t(slice ? 'accounts.closePair.pairSlice' : 'accounts.closePair.wholePosition')}`}
              value={`${sig(l.qty)} ${base}`}
              valueSub={slice && held !== null ? t('accounts.closePair.ofHeld', { held: sig(held) }) : undefined}
            />
          );
        })}
      </div>

      {/* One size, both legs, capped at this pair's allocation — see
          maxCloseQty. Defaults to the whole allocation, so leaving it alone
          closes the pair exactly as before. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor={`close-pair-qty-${base}`}>{t('accounts.closePair.sizeLabel')}</FieldLabel>
          {/* The ceiling — this pair's own allocation — stated where the
              number is typed, and clickable. */}
          <button
            type="button"
            className="num text-[11px] text-ink-400 transition-colors hover:text-ink-100"
            title={t('accounts.closePair.maxTitle')}
            onClick={() => setQtyEdited(fieldValue(maxCloseQty))}
          >
            {t('accounts.closePair.max')}{' '}
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
            aria-label={t('accounts.closePair.sizeAria')}
          />
        </AffixedInput>
        {qtyInvalid ? (
          <span className="text-[11px] text-rose-300">
            {t('accounts.closePair.sizeInvalid', { max: sig(maxCloseQty), base })}
          </span>
        ) : (
          <span className="text-[11px] text-ink-400">{t('accounts.closePair.sizeHint')}</span>
        )}
      </div>

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
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`close-pair-slip-${base}`}>{t('accounts.closePair.twap.marketSlippage')}</FieldLabel>
          <AffixedInput affix={<span>%</span>}>
            <input
              id={`close-pair-slip-${base}`}
              className={`input num pr-10 ${slipInvalid ? '!border-rose-500/60' : ''}`}
              inputMode="decimal"
              value={slipStr}
              onChange={(e) => setSlipStr(e.target.value)}
            />
          </AffixedInput>
          {slipInvalid && <span className="text-[11px] text-rose-300">{t('accounts.closePair.slipInvalid')}</span>}
        </div>
      )}

      <EstimateCard
        dataUpdatedAt={preview.dataUpdatedAt}
        estimating={preview.estimating}
        isError={preview.isError}
        sub={twapOn ? t('trade.twap.area.wholeRun') : undefined}
      >
        {previews && previews.length > 0 ? (
          <>
            <EstimateHeadline
              label={t('accounts.closePair.pnlToRealise')}
              sub={t(twapOn ? 'accounts.closePair.twap.headlineSub' : 'accounts.closePair.pnlSub')}
              value={totalPnl !== null ? <SignedNumber value={totalPnl} format={(n) => fmtUsd(n)} /> : '—'}
            />
            <table className="w-full">
              <thead>
                <tr className="text-[12px] font-normal text-ink-300">
                  <th className="pb-1 text-left font-medium">{t('accounts.closePair.head.leg')}</th>
                  <th className="pb-1 text-right font-medium">{t('accounts.closePair.head.limitPx')}</th>
                  <th className="pb-1 text-right font-medium">{t('accounts.closePair.head.slip')}</th>
                  <th className="pb-1 text-right font-medium">{t('accounts.closePair.head.pnl')}</th>
                  <th className="pb-1 text-right font-medium">{t('accounts.closePair.head.estFee')}</th>
                </tr>
              </thead>
              <tbody>
                {previews.map((p, i) => (
                  <tr key={p.symbol} className="border-t border-ink-800/80">
                    <td className="py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <SideChip side={sideOf(p.symbol)} />
                        <span className="text-[12px] text-ink-50">{prettyVenue(legs[i]?.venue ?? '')}</span>
                        <span className="num text-[11px] text-ink-400">{p.qty ? sig(p.qty) : ''}</span>
                      </span>
                    </td>
                    {/* Market mode: only the first leg carries a limit; the
                        hedge leg is a plain market IOC and its cell says so.
                        Maker mode: one leg rests, the other is the market hedge. */}
                    <td className="num py-1.5 text-right text-[12.5px] text-ink-50">
                      {maker ? (
                        makerIdx === null ? (
                          '—'
                        ) : i === makerIdx ? (
                          <span className="text-[11px] text-cyan-300" title={t('accounts.closePair.restsTitle')}>
                            {t('accounts.closePair.rests')}
                          </span>
                        ) : (
                          <span className="text-[11px] text-ink-400" title={t('accounts.closePair.hedgeTitle')}>
                            {t('accounts.closePair.marketIoc')}
                          </span>
                        )
                      ) : i > 0 ? (
                        <span
                          className="text-[11px] text-ink-400"
                          title={t('accounts.closePair.marketTitle')}
                        >
                          {t('accounts.closePair.marketIoc')}
                        </span>
                      ) : p.price ? (
                        sig(p.price)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num py-1.5 text-right text-[12px]">
                      {maker && i === makerIdx ? '—' : p.fillEstimate ? <SlippageBadge est={p.fillEstimate} /> : '—'}
                    </td>
                    <td className="num py-1.5 text-right text-[12px]">
                      {realized[i] !== null && realized[i] !== undefined ? (
                        <SignedNumber value={realized[i] as number} format={(n) => fmtUsd(n)} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num py-1.5 text-right text-[12px] text-ink-50">
                      {p.fees && legFee(p, i) !== null ? (
                        <>
                          {sig(legFee(p, i) as number)} <span className="text-[10.5px] text-ink-400">{p.fees.quote}</span>
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
      </EstimateCard>

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
        {/* The mechanics, once, under the button — with the qualification
            about which leg carries the band as the hover text. */}
        <p
          className="text-[11px] leading-relaxed text-ink-400"
          title={t(maker ? 'accounts.closePair.pairNoteMaker' : 'accounts.closePair.pairNote')}
        >
          {twapOn ? (
            t('accounts.closePair.twap.reduceOnly')
          ) : (
            <Trans
              i18nKey={maker ? 'accounts.closePair.mechanicsMaker' : 'accounts.closePair.mechanics'}
              components={{ b: <span className="font-medium text-ink-200" /> }}
            />
          )}
        </p>
      </div>
    </div>
  );
}
