import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, usePositions, useSymbolDetail, useSymbolsByBase, useVenueBook } from '../api/queries';
import type { ActionInput, DealRequest, PreviewResponse, RestEstimate } from '../api/types';
import { ExecModeToggle } from '../components/ExecModeToggle';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { amountError } from '../lib/amount';
import { sizeUnitForBase } from '../lib/boros';
import { fieldValue, fmtUsd, parseSymbol, prettyVenue } from '../lib/fmt';
import { useDebounced } from '../lib/useDebounced';
import { uuid } from '../lib/uuid';
import type { DealOpts } from './deal';
import { ExecuteControl } from './ExecuteControl';
import { LimitPriceBox } from './LimitPriceBox';
import { MakerSettings, REPEG_DEFAULT_BP } from './MakerSettings';
import { estimateMargin } from './previewBits';
import { AffixedInput, PairEstimate, PairVenues, type ExecMode, storedExecMode } from './PairTicketBits';
import { PairBookImpact } from './PriceImpactGraph';
import { CoinCombobox, FieldLabel } from './SymbolCombobox';
import { useTradeFlowOptional } from './TradeFlow';
import { TwapArea, twapControlOf, useTwapInput } from './TwapArea';
import { usePreviewDebounced } from './usePreview';
import { useTakerAfter, useTwapTakerAfter } from './useTwapTakerAfter';
import { TRACKED_PRICE_TOLERANCE, withinTrackedDrift } from './trackedPriceDrift';

type RepegBp = DealRequest['repegBehindBp'] & number;

/** The default maker resting price: one bid–ask gap BEHIND the touch (BUY at
 * bid − gap, SELL at ask + gap). Both edges sit on the venue tick so the offset
 * does too; toFixed re-round kills FP noise. Degenerate books (one-sided,
 * crossed, or an offset that would go non-positive) fall back to the plain
 * same-side touch. Mirrors the engine's venueGate.touch. */
function restOffsetPrice(rest: RestEstimate, isBuy: boolean): number {
  const { bestBid: bid, bestAsk: ask } = rest;
  const touch = isBuy ? bid : ask;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid) return touch;
  const px = isBuy ? 2 * bid - ask : 2 * ask - bid;
  return px > 0 ? Number(px.toFixed(12)) : touch;
}

/** `onExecuted` fires once the pair is ACCEPTED (the 202 that opens the deal
 * view) — execution itself is asynchronous and tracked by the DealModal. */
export function PairTicket({ onExecuted, allowTwap = true }: { onExecuted?: () => void; allowTwap?: boolean } = {}) {
  const { t } = useTranslation();
  const [base, setBase] = useState<string | null>(null);
  const [longSym, setLongSym] = useState<string | null>(null);
  const [shortSym, setShortSym] = useState<string | null>(null);
  const [notionalStr, setNotionalStr] = useState('');
  /**
   * The unit the size box is in.
   *
   * 'base' sends `qty` (ETH, BTC …); 'usd' sends `notional` (USDT). The engine
   * has always taken either — `resolveQty` converts notional→qty at preview —
   * so this is a labelling and routing choice, not new sizing maths.
   *
   * The default follows the coin, not a fixed preference: it is what makes a
   * hedge EXACT. An ETH-collateral Boros leg is denominated in ETH, so sizing
   * its perp in USDT means eyeballing an FX conversion and the error surfaces
   * later as a position the card flags as imbalanced. But the same argument
   * runs the other way for every USDT-collateral coin (HYPE and the rest),
   * where 'base' was imposing exactly that needless conversion — the Boros
   * side is in dollars, so the perp box should be too. See sizeUnitForBase.
   */
  const [sizeUnit, setSizeUnit] = useState<'base' | 'usd'>('usd');
  /** True once the user picks the unit by hand — stop following the coin. */
  const [unitPinned, setUnitPinned] = useState(false);
  const [nonce, setNonce] = useState(0);
  const flow = useTradeFlowOptional();
  const [mode, setMode] = useState<ExecMode>(storedExecMode);
  const [makerPriceStr, setMakerPriceStr] = useState('');
  /** True once the user typed a price — stop auto-tracking the touch. */
  const [pricePinned, setPricePinned] = useState(false);
  const [makerLeg, setMakerLeg] = useState<'auto' | 'a' | 'b'>('auto');
  const taker = useTakerAfter();
  const [repegBp, setRepegBp] = useState<RepegBp | null>(REPEG_DEFAULT_BP);
  const twap = useTwapInput();

  /**
   * Follow the coin until the user says otherwise.
   *
   * The size box is not a preference, it is half of a hedge: the unit that
   * makes the two legs match is a property of the coin's Boros market, so it
   * has to move when the coin does. Pinned the moment the toggle is touched —
   * an explicit choice must never be overwritten by picking a venue.
   *
   * A prefill pins too (see below): it puts one number in the box and names
   * its unit, so the coin must not relabel it afterwards.
   */
  useEffect(() => {
    if (unitPinned || !base) return;
    setSizeUnit(sizeUnitForBase(base));
  }, [base, unitPinned]);

  const venues = useSymbolsByBase(base);
  const positions = usePositions();
  const account = useAccount();
  const longDetail = useSymbolDetail(longSym);
  const shortDetail = useSymbolDetail(shortSym);

  // --- Strategy-box prefill ("Open the perp legs") --------------------------
  // Two phases keyed on the prefill nonce: set base+notional+mode immediately, then
  // resolve venue → symbol once the base's symbol rules arrive. A venue with no
  // CrossEx symbol stays unselected (the normal picker takes over).
  const prefill = flow?.pairPrefill ?? null;
  const [prefillDone, setPrefillDone] = useState(0);
  // The nonce whose base phase 2 has OBSERVED applied — phase 1's setBase
  // lands one commit later, so the very first phase-2 run still sees the old
  // base and must not be mistaken for the user navigating away.
  const prefillBaseSeen = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.nonce <= prefillDone) return;
    setBase(prefill.base);
    setLongSym(null);
    setShortSym(null);
    /**
     * Unit first, then the figure that matches it.
     *
     * ⚠ These two MUST move together: the box holds one number, so arming it
     * with a USD notional while the unit says ETH would read $10,000 as
     * 10,000 ETH. When the caller asks for base units it must also supply the
     * base quantity; without one there is nothing honest to put in the box but
     * the USD figure, so the unit falls back to USD rather than guessing.
     */
    const wantsBase = prefill.sizeUnit === 'base' && prefill.sizeBase !== undefined;
    if (wantsBase) {
      setSizeUnit('base');
      setNotionalStr(fieldValue(prefill.sizeBase!));
    } else {
      setSizeUnit('usd');
      setNotionalStr(String(Math.max(1, Math.round(prefill.notionalUsd))));
    }
    /**
     * ⚠ PIN it. The caller has just put ONE number in the box and named its
     * unit; the coin-following effect must not then relabel that number.
     *
     * The case that bites is an ETH prefill carrying no base quantity: it
     * falls back to the USD figure above, and an unpinned effect would flip
     * the unit to ETH underneath it — reading $1,235 as 1,235 ETH. The prefill
     * is always the more specific answer, because callers that know the Boros
     * collateral derive the unit from it rather than from the coin.
     */
    setUnitPinned(true);
    // Same invariant as the manual mode toggle: a mode switch un-pins the price
    // so the maker leg resumes tracking the touch.
    if (prefill.mode) {
      setMode(prefill.mode);
      setPricePinned(false);
    }
  }, [prefill, prefillDone]);
  useEffect(() => {
    if (!prefill || prefill.nonce <= prefillDone) return;
    if (base !== prefill.base) {
      // The user moved on to another coin after the prefill's base had been
      // applied — abandon it instead of leaving it armed to fire later.
      if (prefillBaseSeen.current === prefill.nonce) setPrefillDone(prefill.nonce);
      return;
    }
    prefillBaseSeen.current = prefill.nonce;
    // keepPreviousData serves the PREVIOUS base's rows while this base loads —
    // resolving venues against those would arm the wrong coin's symbols.
    if (!venues.data || venues.isPlaceholderData) return;
    const rules = venues.data.filter((r) => r.base === prefill.base);
    const symFor = (venue: string | null) =>
      venue ? (rules.find((r) => r.exchange === venue)?.symbol ?? null) : null;
    setLongSym(symFor(prefill.longVenue));
    setShortSym(symFor(prefill.shortVenue));
    setPrefillDone(prefill.nonce);
  }, [prefill, prefillDone, base, venues.data, venues.isPlaceholderData]);

  // Regenerated whenever the legs change or a pair was executed, so two
  // executed pairs never share a group.
  const pairGroupId = useMemo(
    () => uuid(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [longSym, shortSym, nonce],
  );

  /**
   * The size field name this ticket sends. `qty` is a BASE quantity and
   * `notional` a USD one — sending the wrong key would size the order by a
   * factor of the coin price, so the two are never interchangeable.
   */
  const sizeField = sizeUnit === 'base' ? 'qty' : 'notional';
  const sizeArg = { [sizeField]: notionalStr } as { qty?: string; notional?: string };
  const notionalNum = Number(notionalStr);
  const notionalErr = amountError(notionalStr);
  const notionalOk = Number.isFinite(notionalNum) && notionalNum > 0;
  // Leverage is PER LEG at each venue's own max. The caps differ (e.g. HL 5x vs
  // Bybit 20x), margin is shared cross-collateral, and a delta-neutral pair's
  // uPnL nets — so min(maxA, maxB) would only reserve extra IM on the higher-cap
  // venue without reducing any risk.
  const levLong = longDetail.data?.leverageMax || undefined;
  const levShort = shortDetail.data?.leverageMax || undefined;

  const [autoPick, setAutoPick] = useState<PreviewResponse['makerLeg']>(null);
  const pick: 'a' | 'b' = makerLeg !== 'auto' ? makerLeg : (autoPick?.auto ?? 'a');
  const makerIsLong = pick === 'a';
  const twapOn = allowTwap && mode === 'maker' && twap.on;
  const pinned = pricePinned && !twapOn;
  const takerSec = taker.sec;

  const actions = useMemo<ActionInput[] | null>(() => {
    if (!longSym || !shortSym || !notionalOk) return null;
    const levL = levLong !== undefined ? { leverage: levLong } : {};
    const levS = levShort !== undefined ? { leverage: levShort } : {};
    if (mode === 'market') {
      return [
        { kind: 'open-market', symbol: longSym, side: 'BUY', ...sizeArg, pairGroupId, ...levL },
        { kind: 'open-market', symbol: shortSym, side: 'SELL', ...sizeArg, pairGroupId, ...levS },
      ];
    }
    // Limit + hedge: the maker leg rests POC at makerPriceStr (auto-tracked to the
    // touch until pinned); the other leg is the engine-fired market hedge.
    // NOTE: pegToTouch is NOT set here (it would leak into the preview payload);
    // it is injected at CONFIRM in `decorate` below when the price is tracking.
    const makerAction: ActionInput = {
      kind: 'open-limit',
      symbol: makerIsLong ? longSym : shortSym,
      side: makerIsLong ? 'BUY' : 'SELL',
      ...sizeArg,
      price: makerPriceStr,
      tif: 'POC',
      pairRole: 'maker',
      ...(takerSec !== null ? { makerTimeoutSec: takerSec } : {}),
      pairGroupId,
      ...(makerIsLong ? levL : levS),
    };
    const hedgeLeg: ActionInput = {
      kind: 'open-market',
      symbol: makerIsLong ? shortSym : longSym,
      side: makerIsLong ? 'SELL' : 'BUY',
      ...sizeArg,
      pairRole: 'hedge',
      pairGroupId,
      ...(makerIsLong ? levS : levL),
    };
    return makerIsLong ? [makerAction, hedgeLeg] : [hedgeLeg, makerAction];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [longSym, shortSym, notionalOk, notionalStr, sizeUnit, levLong, levShort, pairGroupId, mode, makerIsLong, makerPriceStr, takerSec]);

  const twapJson = twapOn ? JSON.stringify(twap.input) : '';
  const twapSettled = useDebounced(twapJson, 400) === twapJson;
  // The same tolerance ExecuteControl runs under, so the estimate card never
  // says "previewing…" beside an armed Execute while the maker price tracks.
  const preview = usePreviewDebounced('ticket-pair', actions, {
    debounceMs: 400,
    refetchInterval: 3_000,
    tolerate:
      mode === 'maker' && !pinned
        ? (shown, current) => withinTrackedDrift(shown, current, TRACKED_PRICE_TOLERANCE)
        : undefined,
    twap: twapOn ? twap.input : undefined,
  });
  const legLong = preview.previews?.[0];
  const legShort = preview.previews?.[1];
  const previewData = preview.previews ? preview.data : undefined;
  const landedTwap = useRef<string | null>(null);
  if (preview.data && !preview.isPlaceholderData && twapSettled) landedTwap.current = twapJson;
  const twapFresh = twapOn && twapSettled && landedTwap.current === twapJson;
  const twapPreview = twapOn ? (previewData?.twap ?? null) : null;
  const twapPlan = twapFresh ? (twapPreview?.plan ?? null) : null;
  const nextAutoPick = previewData?.makerLeg ?? null;
  useEffect(() => {
    setAutoPick(nextAutoPick);
  }, [nextAutoPick?.auto, nextAutoPick?.why]);

  const takerBlocked = useTwapTakerAfter(taker, twapOn, twapPreview?.plan?.takerAfterSec ?? null);
  const makerPreviewLeg = makerIsLong ? legLong : legShort;
  const hedgePreviewLeg = makerIsLong ? legShort : legLong;
  const rest = makerPreviewLeg?.restEstimate;
  const touchPx = rest
    ? repegBp !== null
      ? makerIsLong
        ? rest.bestBid
        : rest.bestAsk
      : restOffsetPrice(rest, makerIsLong)
    : (makerPreviewLeg?.fillEstimate?.midPrice ?? hedgePreviewLeg?.fillEstimate?.midPrice);
  useEffect(() => {
    if (mode !== 'maker' || pinned) return;
    if (Number.isFinite(touchPx) && (touchPx as number) > 0) setMakerPriceStr(String(touchPx));
  }, [mode, pinned, touchPx]);
  const makerSym = makerIsLong ? longSym : shortSym;
  const makerTick = (makerIsLong ? longDetail : shortDetail).data?.tickSize ?? makerPreviewLeg?.rule?.tickSize ?? null;

  const estimating = preview.estimating;

  const trackingMaker = mode === 'maker' && !pinned;
  const dealOpts: DealOpts | undefined =
    mode === 'maker' ? { makerLeg, repegBehindBp: repegBp, timeoutSec: takerSec } : undefined;
  const twapControl = twapControlOf(twapOn, twapPlan, twapOn && twap.blockedBy(twapPreview));
  const makerSaving = (() => {
    const fl = legLong?.fees;
    const fs = legShort?.fees;
    if (twapOn || mode !== 'maker' || !fl || !fs || !notionalOk) return null;
    const chosen = makerIsLong ? fl.makerRate + fs.takerRate : fs.makerRate + fl.takerRate;
    const usd = sizeUnit === 'usd' ? notionalNum : (legLong?.estNotional ?? legShort?.estNotional ?? null);
    if (usd === null || !Number.isFinite(usd)) return null;
    return (fl.takerRate + fs.takerRate - chosen) * usd;
  })();
  const legs =
    longSym && shortSym
      ? [
          { name: prettyVenue(parseSymbol(longSym).exchange), side: 'LONG' as const },
          { name: prettyVenue(parseSymbol(shortSym).exchange), side: 'SHORT' as const },
        ]
      : null;
  const decorate = (acts: ActionInput[]): ActionInput[] =>
    trackingMaker
      ? acts.map((a) => (a.kind === 'open-limit' && a.pairRole === 'maker' ? { ...a, pegToTouch: true } : a))
      : acts;

  const stageDone = () => {
    setNonce((n) => n + 1); // next pair gets a fresh group id
    onExecuted?.();
  };

  // Total initial margin the pair posts — Σ notional/leverage over the open legs, from
  // the same estimator (and the same live positions/mode) the execute gate uses, or an
  // unwind reads as $197 of IM on a ticket that opens nothing.
  const marginRequired = preview.previews
    ? estimateMargin(preview.previews, positions.data?.positions, account.data?.positionMode).required
    : null;

  // The coin's live price beside the "Coin" caption: the preview's reference
  // once a size is typed, else the long (or short) venue's own mid.
  const priceSym = longSym ?? shortSym;
  const priceBook = useVenueBook(priceSym, Boolean(priceSym) && !legLong && !legShort);
  const coinPx = legLong?.refPrice?.value ?? legShort?.refPrice?.value ?? priceBook.data?.mid ?? null;

  const swapVenues = () => {
    setLongSym(shortSym);
    setShortSym(longSym);
    // The maker price belonged to the leg that just changed sides — resume
    // tracking the book, as a mode switch does.
    setPricePinned(false);
    setMakerLeg('auto');
  };

  const leverageText =
    levLong !== undefined && levShort !== undefined
      ? t('pairTicket.pair.leverage', { long: levLong, short: levShort })
      : longSym && shortSym
        ? t('common.loading')
        : null;

  return (
    <div className="flex flex-col gap-4">
      <CoinCombobox
        value={base}
        aside={
          base && coinPx !== null ? (
            <span className="num text-[11px] text-ink-400">
              {base} {fmtUsd(coinPx)}
            </span>
          ) : undefined
        }
        onSelect={(b) => {
          setBase(b);
          setLongSym(null);
          setShortSym(null);
          // ⚠ Release the prefill's pin — AND clear the number with it.
          //
          // The pin stops the coin relabelling a figure the CALLER put in the
          // box; picking a coin by hand ends that, and the new coin's own unit
          // must win. But releasing alone would relabel whatever is already
          // typed: "2000" meant as dollars for HYPE becomes 2000 ETH the
          // moment ETH is picked, and `sizeField` flips the wire key from
          // `notional` to `qty` — the exact factor-of-the-coin-price mis-size
          // that key pair exists to prevent. The size belonged to the old
          // coin; it does not survive the switch.
          setUnitPinned(false);
          setNotionalStr('');
          setMakerLeg('auto');
        }}
        onClear={() => {
          setBase(null);
          setLongSym(null);
          setShortSym(null);
          setUnitPinned(false);
          setNotionalStr('');
          setMakerLeg('auto');
        }}
      />

      {base && (
        <PairVenues
          longSym={longSym}
          shortSym={shortSym}
          venues={venues.data}
          loading={venues.isPending}
          onLong={(s) => setLongSym(s || null)}
          onShort={(s) => setShortSym(s || null)}
          onSwap={swapVenues}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="pair-notional">{t('pairTicket.pair.sizePerLeg')}</FieldLabel>
        {/* The unit follows the coin (see sizeUnitForBase): ETH/BTC are
            coin-margined on Boros, so the perp is sized in the coin and the
            hedge is exact; every other coin is USDT-collateral there, so the
            dollar figure is the one both legs share. The toggle sits INSIDE
            the box, and stays because some users think in notional
            regardless — and once used, it pins. */}
        {/* No coin picked yet ⇒ nothing sensible to call the base unit, so
            the choice is withheld and the box states its unit in the affix. */}
        <AffixedInput
          affix={
            base ? (
              <SegmentedToggle<'base' | 'usd'>
                ariaLabel={t('pairTicket.pair.sizeUnit')}
                className="seg-xs"
                value={sizeUnit}
                onChange={(u) => {
                  // An explicit choice wins over the coin's default from here on.
                  setUnitPinned(true);
                  setSizeUnit(u);
                }}
                options={[
                  // Always the actual coin (ETH / BTC) — "Base" is jargon that
                  // names a role rather than the unit the number is in.
                  { value: 'base', label: base },
                  { value: 'usd', label: 'USDT' },
                ]}
              />
            ) : (
              <span>USDT</span>
            )
          }
        >
          <input
            id="pair-notional"
            // The accessible name carries the unit — the visible caption does
            // not, because the unit switch inside the box already shows it.
            aria-label={t('pairTicket.pair.sizePerLegAria', { unit: sizeUnit === 'base' && base ? base : 'USDT' })}
            className={`input num ${base ? 'pr-[124px]' : 'pr-14'} ${notionalErr ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            placeholder={sizeUnit === 'base' && base ? t('pairTicket.pair.sizeIn', { unit: base }) : t('pairTicket.pair.sizePerLegPlaceholder')}
            aria-invalid={notionalErr ? true : undefined}
            aria-describedby={notionalErr ? 'pair-notional-error' : undefined}
            value={notionalStr}
            onChange={(e) => setNotionalStr(e.target.value)}
          />
        </AffixedInput>
        {notionalErr && (
          <p id="pair-notional-error" role="alert" className="text-[11px] text-rose-300">
            {notionalErr}
          </p>
        )}
      </div>

      <ExecModeToggle
        ariaLabel={t('pairTicket.orderType.aria')}
        fill
        value={mode}
        onChange={(m) => {
          setMode(m);
          if (m === 'market') twap.setOn(false);
          setPricePinned(false);
        }}
        order={['maker', 'market']}
        labels={{ maker: t('pairTicket.orderType.limitHedge'), market: t('pairTicket.orderType.market') }}
      />

      {mode === 'maker' && (
        <>
          {allowTwap && <TwapArea
            on={twap.on}
            onToggle={(on) => {
              twap.setOn(on);
              setPricePinned(false);
            }}
            input={twap.input}
            onInput={twap.setInput}
            preview={twapPreview}
            impact={previewData?.priceImpact ?? null}
            coin={base ?? ''}
            lot={longDetail.data?.lotSize ?? shortDetail.data?.lotSize}
          />}
          {!twapOn && (
            <>
            <LimitPriceBox
              bookPrice={makerTick !== null && touchPx !== undefined ? String(touchPx) : null}
              value={pinned ? makerPriceStr : null}
              onChange={(price) => {
                if (price === null) {
                  setPricePinned(false);
                  return;
                }
                setMakerPriceStr(price);
                setPricePinned(true);
              }}
              tick={makerTick ?? ''}
              unit={(makerSym && parseSymbol(makerSym).quote) || 'USDT'}
            />
            {!pinned && touchPx !== undefined && !rest && (
              <span className="text-[11px] text-amber-400/90" title={t('pairTicket.bits.bookUnavailableHint')}>
                {t('pairTicket.bits.bookUnavailable')}
              </span>
            )}
            </>
          )}
          <MakerSettings
            legs={legs}
            makerLeg={makerLeg}
            autoPick={autoPick ?? null}
            saving={makerSaving}
            onMakerLeg={setMakerLeg}
            takerAfter={taker.takerAfter}
            onTakerAfter={taker.pick}
            intervalSec={twapOn ? (twapPreview?.plan?.intervalSec ?? twap.input.intervalSec ?? null) : null}
            repegBehindBp={repegBp}
            repegLocked={pinned}
            onRepeg={(v) => setRepegBp(v === 2 || v === 5 || v === 10 ? v : null)}
          />
        </>
      )}

      {actions && (
        <PairEstimate
          previews={preview.previews}
          isError={preview.isError}
          error={preview.error}
          estimating={estimating}
          dataUpdatedAt={preview.dataUpdatedAt}
          legLong={legLong}
          legShort={legShort}
          mode={mode}
          leverage={leverageText}
          marginRequired={marginRequired}
          twapOn={twapOn}
          book={
            <PairBookImpact
              longSym={longSym}
              shortSym={shortSym}
              notional={notionalStr}
              legLong={legLong}
              legShort={legShort}
              estimating={estimating}
              mode={mode}
              makerLeg={makerIsLong ? 'long' : 'short'}
              makerPriceStr={makerPriceStr}
              embedded
            />
          }
        />
      )}

      <ExecuteControl
        scope="ticket-pair"
        actions={actions}
        // A maker price that tracks the book moves every preview; within 5 bps
        // it is the same order (it goes out pegged to the live touch), so
        // Execute stays armed. A typed price re-previews as before.
        trackedPriceTolerance={trackingMaker ? TRACKED_PRICE_TOLERANCE : undefined}
        tone="cyan"
        label={
            <>
              {twapOn ? t('trade.twap.area.start') : t('pairTicket.pair.execute')}
              <ChevronRight size={14} aria-hidden />
            </>
          }
        buttonClassName="w-full"
        // The ticket's own estimate card reviews the legs — no hover card.
        hoverCard={false}
        decorate={decorate}
        // The maker price auto-tracks the touch every preview cycle; exclude it
        // (when unpinned) from the intent identity so an auto-tick never resets
        // the basketId — otherwise a same-intent lost-response retry could
        // double-execute. A pinned price IS part of the intent.
        // pairGroupId is deliberately EXCLUDED: it is a fresh uuid on every
        // mount, so including it made the key unique per mount and the
        // persisted pending id could never be recovered after the Single/Pair
        // toggle (a full remount) or a reload — a lost-response retry then
        // minted a new id the server couldn't dedupe and opened a SECOND full
        // pair. The group id still rides in the actions (it only labels the
        // executed legs as one group); POST /deals dedupes on the deal id alone,
        // so a recovered resend with a different group id is still a no-op.
        // ⚠ `sizeUnit` is part of the intent, not presentation. It decides
        // whether the SAME digits go on the wire as `qty` (base coin) or
        // `notional` (USD) — a factor-of-the-coin-price difference — and the
        // toggle deliberately keeps the figure. Without it here, a
        // lost-response confirm followed by a unit flip produced a
        // byte-identical key, so the recovered basketId was resent and the
        // server deduped it: the user was shown "2000 ETH" while the ORIGINAL
        // $2000 order stood.
        intentKey={[
          longSym,
          shortSym,
          notionalStr,
          sizeUnit,
          mode,
          makerLeg,
          pick,
          takerSec ?? 'never',
          repegBp ?? 'off',
          pinned ? makerPriceStr : 'track',
          twapControl ? `${twapControl.plan.durationSec}/${twapControl.plan.slices}` : 'single',
        ].join('|')}
        // Block until BOTH venues' leverage caps are known (executing before they
        // load would open at the account's current leverage, not the venue max),
        // and, in maker mode, until the maker price has been tracked.
        extraDisabled={
          (mode === 'maker' && (!makerPriceStr || takerBlocked)) ||
                    levLong === undefined ||
          levShort === undefined
        }
        dealOpts={dealOpts}
        twap={twapControl}
        onExecuted={stageDone}
        detail={
          <div className="flex flex-col gap-0.5">
            {levLong !== undefined && levShort !== undefined && (
              <span>
                {t('pairTicket.pair.leverageDetail', { long: levLong, short: levShort })}
              </span>
            )}
            {trackingMaker && repegBp !== null && <span>{t('pairTicket.pair.pegNote')}</span>}
          </div>
        }
      />
    </div>
  );
}
