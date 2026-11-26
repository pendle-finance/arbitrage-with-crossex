import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  useAccount,
  usePositions,
  useSymbolDetail,
  useSymbolsByBase,
  useVenueBook,
} from '../api/queries';
import type { ActionInput, Side } from '../api/types';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { fieldValue, fmtUsd, parseSymbol, prettyVenue, qtyGrouped, sigGrouped } from '../lib/fmt';
import { amountError } from '../lib/amount';
import { sizeUnitForBase } from '../lib/boros';
import { formatRestPrice } from '../lib/ticks';
import { EstimateHeadline } from './EstimateHeadline';
import { ExecuteControl } from './ExecuteControl';
import { LimitPriceBox } from './LimitPriceBox';
import { MakerSettings, REPEG_DEFAULT_BP } from './MakerSettings';
import { AffixedInput, EstimateCard, EstimateRow, LeverageValue, VenueSelect } from './PairTicketBits';
import {
  estimateMargin,
  PREFLIGHT_MARGIN_BUFFER,
  PreviewFallback,
  SlippageBadge,
  TAKER_FEE_RESERVE,
  ViolationList,
} from './previewBits';
import { CoinCombobox, FieldLabel } from './SymbolCombobox';
import { BookToggle, fmtTradeCost, OneLegBook, PlanLine } from './TicketEstimateBits';
import { useTradeFlowOptional } from './TradeFlow';
import { TRACKED_PRICE_TOLERANCE } from './trackedPriceDrift';
import { TwapArea, twapControlOf, useTwapInput } from './TwapArea';
import { usePreviewDebounced } from './usePreview';
import { useTakerAfter, useTwapTakerAfter } from './useTwapTakerAfter';

type SizeMode = 'usdt' | 'base';
type Repeg = 2 | 5 | 10 | null;

export function SingleTicket() {
  const { t } = useTranslation();
  const [base, setBase] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [side, setSide] = useState<Side>('BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT'>('LIMIT');
  const [sizeMode, setSizeMode] = useState<SizeMode>('usdt');
  const [unitPinned, setUnitPinned] = useState(false);
  const [sizeStr, setSizeStr] = useState('');
  const [typedPrice, setTypedPrice] = useState<string | null>(null);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const taker = useTakerAfter();
  const [repeg, setRepeg] = useState<Repeg>(REPEG_DEFAULT_BP);
  const twap = useTwapInput();
  const twapOn = twap.on && type === 'LIMIT';
  const heldAuto = useRef<{ key: string; price: number } | null>(null);

  const perpPrefill = useTradeFlowOptional()?.singlePerpPrefill ?? null;
  const [prefillBase, setPrefillBase] = useState<string | null>(null);
  const [prefillDone, setPrefillDone] = useState(0);
  const prefillNonce = perpPrefill?.nonce ?? 0;
  useEffect(() => {
    if (!perpPrefill || prefillNonce <= prefillDone) return;
    setPrefillBase(perpPrefill.base);
    setBase(perpPrefill.base);
    setSymbol(null);
    setSide(perpPrefill.side);
    setType('MARKET');
    if (perpPrefill.sizeUnit === 'base' && perpPrefill.sizeBase !== undefined) {
      setSizeMode('base');
      setSizeStr(fieldValue(perpPrefill.sizeBase));
    } else {
      setSizeMode('usdt');
      setSizeStr(String(Math.max(1, Math.round(perpPrefill.notionalUsd))));
    }
    setUnitPinned(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  const venues = useSymbolsByBase(base);
  const prefillVenues = useSymbolsByBase(prefillBase);
  useEffect(() => {
    if (!perpPrefill || prefillNonce <= prefillDone || !prefillBase) return;
    if (!prefillVenues.data || prefillVenues.isPlaceholderData) return;
    const rule = prefillVenues.data.find((r) => r.base === perpPrefill.base && r.exchange === perpPrefill.venue);
    if (rule) setSymbol(rule.symbol);
    setPrefillDone(prefillNonce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce, prefillBase, prefillVenues.data, prefillVenues.isPlaceholderData]);

  const detail = useSymbolDetail(symbol);
  const account = useAccount();
  const positions = usePositions();

  useEffect(() => {
    if (unitPinned || !base) return;
    setSizeMode(sizeUnitForBase(base) === 'base' ? 'base' : 'usdt');
  }, [base, unitPinned]);

  const sizeNum = Number(sizeStr);
  const sizeErr = amountError(sizeStr);
  const sizeOk = Number.isFinite(sizeNum) && sizeNum > 0;
  const levMax = detail.data?.leverageMax ?? 0;
  const tick = detail.data?.tickSize ?? null;
  const book = useVenueBook(symbol, Boolean(symbol));
  const touch = side === 'BUY' ? book.data?.bestBid : book.data?.bestAsk;

  let autoPrice: string | null = null;
  if (symbol && tick && touch && touch > 0) {
    const key = `${symbol}:${side}`;
    const held = heldAuto.current;
    if (!held || held.key !== key || Math.abs(held.price - touch) / touch > TRACKED_PRICE_TOLERANCE) {
      heldAuto.current = { key, price: touch };
    }
    autoPrice = formatRestPrice(heldAuto.current?.price ?? touch, side, symbol, tick);
  }
  const limitPrice = useMemo(() => {
    if (typedPrice === null) return autoPrice;
    const n = Number(typedPrice);
    if (!symbol || !tick || !Number.isFinite(n) || n <= 0) return null;
    return formatRestPrice(n, side, symbol, tick);
  }, [typedPrice, autoPrice, symbol, tick, side]);

  const action = useMemo<ActionInput | null>(() => {
    if (!symbol || !sizeOk) return null;
    const sizing = sizeMode === 'usdt' ? { notional: sizeStr } : { qty: sizeStr };
    const lev = levMax > 0 ? { leverage: levMax } : {};
    if (type === 'MARKET') return { kind: 'open-market', symbol, side, ...sizing, ...lev };
    if (!limitPrice) return null;
    return {
      kind: 'open-limit',
      symbol,
      side,
      ...sizing,
      ...lev,
      price: limitPrice,
      tif: 'POC' as const,
      ...(reduceOnly ? { reduceOnly: true } : {}),
    };
  }, [symbol, side, type, sizeMode, sizeStr, levMax, limitPrice, sizeOk, reduceOnly]);

  const actions = action ? [action] : null;
  const preview = usePreviewDebounced('ticket-single', actions, {
    debounceMs: 400,
    refetchInterval: 3_000,
    twap: twapOn ? twap.input : undefined,
  });
  const p = preview.previews?.[0];
  const estimating = preview.estimating;
  const ref = p?.refPrice?.value ?? book.data?.mid;
  const twapPreview = twapOn ? (preview.data?.twap ?? null) : null;
  const impact = preview.data?.priceImpact ?? null;
  const twapBlocked = twapOn && twap.blockedBy(twapPreview);
  const plan = twapPreview?.plan ?? null;

  const zeroSize = (p?.violations ?? []).some((v) => /rounds down to zero/.test(v.message));
  const sliceMin =
    twapOn && !plan && zeroSize && p?.rule && ref
      ? t('trade.twap.server.sliceMin', {
          venue: prettyVenue(parseSymbol(p.symbol).exchange),
          min: p.rule.minSize,
          coin: base ?? '',
          usd: fmtUsd(Number(p.rule.minSize) * ref, 0),
        })
      : null;

  const takerBad = useTwapTakerAfter(taker, twapOn, plan?.takerAfterSec ?? null);
  const takerBlocked = twapOn && takerBad;

  const available = Number(account.data?.availableMargin ?? NaN);
  const positionMaxUsd = detail.data?.positionMaxUsd || Infinity;
  const maxNotional =
    Number.isFinite(available) && available > 0 && levMax > 0
      ? Math.min(positionMaxUsd, available / (PREFLIGHT_MARGIN_BUFFER / levMax + TAKER_FEE_RESERVE))
      : null;
  const maxSize =
    maxNotional === null ? null : sizeMode === 'usdt' ? maxNotional : ref && ref > 0 ? maxNotional / ref : null;
  const maxLabel =
    maxSize === null
      ? null
      : sizeMode === 'usdt'
        ? t('trade.single.maxUsd', { amount: fmtUsd(maxSize, 0) })
        : t('trade.single.maxBase', { amount: qtyGrouped(maxSize, 4), base: base ?? '' });

  const marginRequired = preview.previews
    ? estimateMargin(preview.previews, positions.data?.positions, account.data?.positionMode).required
    : null;

  const resetCoin = () => {
    setUnitPinned(false);
    setSizeStr('');
    setTypedPrice(null);
  };

  const isLong = side === 'BUY';
  const venueRules = (venues.data ?? []).filter((r) => r.base === base);
  const decorate = (acts: ActionInput[]): ActionInput[] =>
    twapOn ? acts.map((a) => (a.kind === 'open-limit' ? { ...a, pegToTouch: true } : a)) : acts;

  return (
    <div className="flex flex-col gap-4">
      <CoinCombobox
        value={base}
        aside={
          base && ref ? (
            <span className="num text-[11px] text-ink-400">
              {base} {fmtUsd(ref)}
            </span>
          ) : undefined
        }
        onSelect={(coin) => {
          if (coin === base) return;
          setBase(coin);
          setSymbol(null);
          resetCoin();
        }}
      />

      <div className="grid grid-cols-2 items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <FieldLabel>{t('trade.single.side')}</FieldLabel>
          <SegmentedToggle<Side>
            ariaLabel={t('trade.single.side')}
            fill
            className={isLong ? 'seg-grass' : 'seg-rose'}
            value={side}
            onChange={setSide}
            options={[
              { value: 'BUY', label: t('trade.single.long') },
              { value: 'SELL', label: t('trade.single.short') },
            ]}
          />
        </div>
        {base && (
          <VenueSelect
            tone={isLong ? 'long' : 'short'}
            value={symbol}
            otherValue={null}
            onPick={(next) => setSymbol(next || null)}
            venues={venueRules}
            loading={venues.isPending}
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor="ticket-size">{t('common.size')}</FieldLabel>
          {maxLabel && (
            <button
              type="button"
              title={t('trade.single.maxTitle')}
              onClick={() => setSizeStr(fieldValue(maxSize as number))}
              className="num text-[11px] text-link underline decoration-link/40 underline-offset-2 hover:text-ink-50"
            >
              {maxLabel}
            </button>
          )}
        </div>
        <AffixedInput
          affix={
            <SegmentedToggle<SizeMode>
              ariaLabel={t('trade.single.sizeMode')}
              className="seg-xs"
              value={sizeMode}
              onChange={(m) => {
                setUnitPinned(true);
                setSizeMode(m);
              }}
              options={[
                { value: 'base', label: base || t('trade.single.qty') },
                { value: 'usdt', label: 'USDT' },
              ]}
            />
          }
        >
          <input
            id="ticket-size"
            className={`input num pr-[124px] ${sizeErr ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            placeholder={
              sizeMode === 'usdt'
                ? t('trade.single.notionalPlaceholder')
                : base
                  ? t('trade.single.qtyBasePlaceholder', { base })
                  : t('trade.single.qty')
            }
            aria-invalid={sizeErr ? true : undefined}
            aria-describedby={sizeErr ? 'ticket-size-error' : undefined}
            value={sizeStr}
            onChange={(e) => setSizeStr(e.target.value)}
          />
        </AffixedInput>
        {sizeErr && (
          <p id="ticket-size-error" role="alert" className="text-[11px] text-rose-300">
            {sizeErr}
          </p>
        )}
      </div>

      {!twapOn && (
        <SegmentedToggle<'MARKET' | 'LIMIT'>
          ariaLabel={t('trade.single.orderType')}
          fill
          value={type}
          onChange={setType}
          options={[
            { value: 'LIMIT', label: t('trade.single.limit') },
            { value: 'MARKET', label: t('trade.single.market') },
          ]}
        />
      )}

      {twapOn && (
        <MakerSettings
          legs={null}
          makerLeg="auto"
          autoPick={null}
          onMakerLeg={() => undefined}
          takerAfter={taker.takerAfter}
          onTakerAfter={taker.pick}
          takerCapSec={plan?.takerAfterSec ?? null}
          repegBehindBp={repeg}
          repegLocked={false}
          onRepeg={(v) => setRepeg(v === 2 || v === 5 || v === 10 ? v : null)}
        />
      )}

      {type === 'LIMIT' && (
        <TwapArea
          on={twap.on}
          onToggle={twap.setOn}
          input={twap.input}
          onInput={twap.setInput}
          preview={twapPreview}
          impact={impact}
          coin={base ?? ''}
          lot={detail.data?.lotSize}
        />
      )}

      {sliceMin && <p className="text-[11px] text-rose-400">{sliceMin}</p>}

      {type === 'LIMIT' && !twapOn && symbol && (
        <div className="flex flex-col gap-1.5">
          <LimitPriceBox
            bookPrice={autoPrice}
            value={typedPrice}
            onChange={setTypedPrice}
            tick={tick ?? '0.01'}
            unit={p?.fees?.quote ?? 'USDT'}
          />
          <span className="text-[10.5px] text-ink-400">{t('trade.single.postOnlyNote')}</span>
        </div>
      )}

      {type === 'LIMIT' && (
        <label className="flex items-center gap-2 text-[11.5px] text-ink-200">
          <input type="checkbox" className="chk" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
          {t('trade.single.reduceOnly')}
        </label>
      )}

      {action && (
        <EstimateCard
          dataUpdatedAt={preview.dataUpdatedAt}
          estimating={estimating}
          isError={preview.isError}
          sub={twapOn ? t('trade.twap.area.wholeRun') : undefined}
          aside={<BookToggle on={showBook} onToggle={() => setShowBook((v) => !v)} />}
        >
          {p ? (
            <>
              {type === 'LIMIT' ? (
                <EstimateHeadline
                  label={t('pairTicket.bits.tradeCost')}
                  sub={t('pairTicket.bits.maker')}
                  value={fmtTradeCost(p.fees?.est.maker ?? p.fees?.est.taker ?? null, p.fees?.quote)}
                />
              ) : (
                <EstimateHeadline
                  label={t('pairTicket.bits.tradeCost')}
                  sub={t('trade.ticketEstimate.taker')}
                  value={fmtTradeCost(p.fees?.est.taker ?? p.fees?.est.maker ?? null, p.fees?.quote)}
                />
              )}
              <div className="flex flex-col gap-1.5">
                <PlanLine
                  side={isLong ? 'LONG' : 'SHORT'}
                  symbol={p.symbol}
                  role={type === 'LIMIT' ? 'rests' : 'market'}
                  qty={p.qty}
                />
                {sizeMode === 'usdt' && p.estNotional > 0 && p.estNotional < sizeNum - 1e-9 && (
                  <span className="text-[11px] text-amber-400">
                    {t('trade.single.realNotional', { amount: fmtUsd(p.estNotional) })}
                  </span>
                )}
                {type === 'MARKET' && p.fillEstimate && (
                  <EstimateRow
                    label={t('trade.single.tentativeFill')}
                    sub={t('trade.single.fillMeta', {
                      source: t(`trade.single.source.${p.fillEstimate.source}` as const),
                      confidence: t(`trade.single.confidence.${p.fillEstimate.confidence}` as const),
                    })}
                    value={
                      <span className="flex items-baseline gap-1.5">
                        {sigGrouped(p.fillEstimate.avgPrice)}
                        <SlippageBadge est={p.fillEstimate} />
                      </span>
                    }
                  />
                )}
              </div>
              {showBook && symbol && (
                <div className="pt-1">
                  <OneLegBook
                    symbol={symbol}
                    side={side}
                    limitPx={type === 'LIMIT' && p.price ? Number(p.price) : null}
                    fill={type === 'MARKET' ? p.fillEstimate : undefined}
                    estimating={estimating}
                  />
                </div>
              )}
              {type === 'MARKET' && p.fillEstimate?.partialDepth && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded border border-dashed border-amber-500/50 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-200"
                >
                  <span aria-hidden className="text-amber-400">
                    <TriangleAlert size={12} aria-hidden />
                  </span>
                  <span>
                    <Trans i18nKey="trade.single.partialDepth" components={{ b: <span className="font-medium" /> }} />
                  </span>
                </div>
              )}
              <div className="flex flex-col gap-1.5 border-t border-ink-800/80 pt-2">
                <EstimateRow
                  label={t('trade.single.leverage')}
                  value={<LeverageValue text={levMax > 0 ? `${levMax}x` : symbol ? t('common.loading') : null} />}
                />
                <EstimateRow
                  label={t('common.margin')}
                  title={t('trade.single.marginTitle')}
                  value={marginRequired !== null ? `≈ ${fmtUsd(marginRequired)}` : '—'}
                  strong
                />
              </div>
              <ViolationList violations={sliceMin ? p.violations.filter((v) => !/rounds down to zero/.test(v.message)) : p.violations} warnings={p.warnings} />
            </>
          ) : (
            <div className="text-[11px]">
              <PreviewFallback isError={preview.isError} error={preview.error} />
            </div>
          )}
        </EstimateCard>
      )}

      <div className="flex flex-col gap-1.5">
        <ExecuteControl
          scope="ticket-single"
          actions={actions}
          hoverCard={false}
          tone={isLong ? 'buy' : 'sell'}
          label={
            <>
              {twapOn ? t('trade.twap.area.start') : t('trade.single.executeNow')}
              <ChevronRight size={14} aria-hidden />
            </>
          }
          buttonClassName="w-full"
          extraDisabled={(Boolean(symbol) && levMax === 0) || twapBlocked || takerBlocked}
          decorate={decorate}
          dealOpts={
            twapOn ? { makerLeg: 'auto', repegBehindBp: repeg, timeoutSec: taker.sec } : undefined
          }
          twap={twapControlOf(twapOn, plan, twapBlocked || takerBlocked)}
          intentKey={JSON.stringify([
            symbol,
            side,
            type,
            sizeMode,
            sizeStr,
            typedPrice,
            reduceOnly,
            twapOn ? [twap.input, taker.takerAfter, repeg] : null,
          ])}
          onExecuted={() => {
            setSizeStr('');
            setTypedPrice(null);
          }}
          detail={levMax > 0 ? <>{t('trade.single.levDetail', { lev: levMax })}</> : undefined}
        />
        <span className="text-[11px] text-ink-400">{t('trade.single.notHedged')}</span>
      </div>
    </div>
  );
}
