/**
 * Single-leg order ticket: venue × coin market picker, Buy/Sell, Market/Limit,
 * USDT↔base sizing (with a "max" the account can carry), tick-snapped limit
 * price, and a live debounced preview (400ms, refreshed every 3s while valid).
 * Leverage is always the venue max (shown in the estimate, not editable).
 * "Execute now" is a hold-to-confirm inline execute (no review modal).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, usePositions, useSymbolDetail, useSymbolsByBase, useVenueBook } from '../api/queries';
import { useTradeFlowOptional } from './TradeFlow';
import type { ActionInput, Side } from '../api/types';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { fieldValue, fmtUsd, sig } from '../lib/fmt';
import { amountError } from '../lib/amount';
import { sizeUnitForBase } from '../lib/boros';
import { formatRestPrice } from '../lib/ticks';
import { ExecuteControl } from './ExecuteControl';
import { AffixedInput, EstimateCard, EstimateRow, LeverageValue } from './PairTicketBits';
import {
  estimateMargin,
  feeAmount,
  feeKind,
  PREFLIGHT_MARGIN_BUFFER,
  PreviewFallback,
  SlippageBadge,
  TAKER_FEE_RESERVE,
  ViolationList,
} from './previewBits';
import { baseOfSymbol, FieldLabel, MarketPicker } from './SymbolCombobox';
import { usePreviewDebounced } from './usePreview';

type SizeMode = 'usdt' | 'base';

export function SingleTicket() {
  /** The coin — picked by hand (venue still to choose) or implied by the symbol. */
  const [base, setBase] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [side, setSide] = useState<Side>('BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [sizeMode, setSizeMode] = useState<SizeMode>('usdt');
  /** True once the unit is chosen explicitly — by the toggle or a prefill. */
  const [unitPinned, setUnitPinned] = useState(false);
  const [sizeStr, setSizeStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [priceFlash, setPriceFlash] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last price the user actually asked for (typed, or a mark button's raw
  // ref×mult), BEFORE any snap. The resting snap is directional and therefore
  // LOSSY (a BUY floors, a SELL ceils), and re-snapping an already-snapped tick
  // multiple is a no-op in either direction — so when the side flips after a
  // snap we must re-snap from this raw value, not from the displayed one.
  const rawPrice = useRef<number | null>(null);

  /**
   * A missing-perp row asked to open exactly this leg.
   *
   * Two phases, like the pair ticket's: the size and side land immediately,
   * then the venue is resolved to a symbol once that base's rules arrive —
   * `useSymbolsByBase` serves the PREVIOUS base while the new one loads, and
   * resolving against those would arm the wrong coin's symbol.
   */
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
    // ⚠ Unit and figure move together: the box holds ONE number, so arming it
    // with a USD notional while the mode says base would read $12,000 as
    // 12,000 ETH. Base needs a base quantity; without one, USD is the only
    // honest reading.
    if (perpPrefill.sizeUnit === 'base' && perpPrefill.sizeBase !== undefined) {
      setSizeMode('base');
      setSizeStr(fieldValue(perpPrefill.sizeBase));
    } else {
      setSizeMode('usdt');
      setSizeStr(String(Math.max(1, Math.round(perpPrefill.notionalUsd))));
    }
    // The caller put ONE number in the box and named its unit; the coin must
    // not relabel it afterwards. (Released when the user picks a coin/symbol
    // by hand — see the effect below.)
    setUnitPinned(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  const prefillVenues = useSymbolsByBase(prefillBase);
  useEffect(() => {
    if (!perpPrefill || prefillNonce <= prefillDone || !prefillBase) return;
    if (!prefillVenues.data || prefillVenues.isPlaceholderData) return;
    const rule = prefillVenues.data.find(
      (r) => r.base === perpPrefill.base && r.exchange === perpPrefill.venue,
    );
    // A venue with no CrossEx symbol for this coin leaves the picker on the
    // coin (its venue chips showing) rather than arming a different venue's leg.
    if (rule) setSymbol(rule.symbol);
    setPrefillDone(prefillNonce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce, prefillBase, prefillVenues.data, prefillVenues.isPlaceholderData]);

  const detail = useSymbolDetail(symbol);
  const account = useAccount();
  const positions = usePositions();

  /**
   * Follow the coin, exactly as the pair ticket does: ETH/BTC are coin-margined
   * on Boros so the perp is sized in the coin and the hedge is exact; every
   * other coin is USDT-collateral there, so dollars is the unit both legs
   * share. Only until the unit is chosen explicitly.
   */
  useEffect(() => {
    if (unitPinned || !base) return;
    setSizeMode(sizeUnitForBase(base) === 'base' ? 'base' : 'usdt');
  }, [base, unitPinned]);
  const sizeNum = Number(sizeStr);
  const sizeErr = amountError(sizeStr);
  const sizeOk = Number.isFinite(sizeNum) && sizeNum > 0;
  const levMax = detail.data?.leverageMax ?? 0;
  const priceNum = Number(priceStr);
  const priceOk = type === 'MARKET' || (Number.isFinite(priceNum) && priceNum > 0);

  const action = useMemo<ActionInput | null>(() => {
    if (!symbol || !sizeOk || !priceOk) return null;
    const sizing = sizeMode === 'usdt' ? { notional: sizeStr } : { qty: sizeStr };
    // Leverage is always the venue max (no input); carried once known.
    const lev = levMax > 0 ? { leverage: levMax } : {};
    if (type === 'MARKET') return { kind: 'open-market', symbol, side, ...sizing, ...lev };
    // The engine places every limit POST-ONLY (a crossing limit should be a
    // market order) — declared in the tif so the fee preview shows maker-only.
    return {
      kind: 'open-limit',
      symbol,
      side,
      ...sizing,
      ...lev,
      price: priceStr,
      tif: 'POC' as const,
      ...(reduceOnly ? { reduceOnly: true } : {}),
    };
  }, [symbol, side, type, sizeMode, sizeStr, levMax, priceStr, priceOk, sizeOk, reduceOnly]);

  const preview = usePreviewDebounced('ticket-single', action ? [action] : null, {
    debounceMs: 400,
    refetchInterval: 3_000,
  });
  const p = preview.previews?.[0];
  const estimating = preview.estimating;
  // The reference price: the preview's once a size is typed, else the venue's
  // own mid — the "max" link and the mark buttons need one before any size.
  const book = useVenueBook(symbol, Boolean(symbol) && !p);
  const ref = p?.refPrice?.value ?? book.data?.mid;

  // This ticket's limits always rest post-only (tif POC above), so the snap must
  // be formatRestPrice — directional, away from crossing — NOT the nearest-mode
  // formatLimitPrice. A nearest snap produces a valid tick multiple (≤5 sig figs
  // on HL), which makes the server's own formatRestPrice a no-op: it could round
  // a 61717.6 resting BUY UP onto a 61718 ask and the venue insta-rejects, with
  // no "price adjusted" warning anywhere (price === input.price server-side).
  const snapPriceFor = (forSide: Side) => {
    const tick = detail.data?.tickSize;
    // Snap from the raw user-intended price when we have one (see rawPrice) so a
    // BUY-floored value can still ceil correctly after a flip to SELL.
    const source = rawPrice.current ?? priceNum;
    if (!symbol || !tick || !Number.isFinite(source) || source <= 0) return;
    const snapped = formatRestPrice(source, forSide, symbol, tick);
    if (snapped !== priceStr) {
      setPriceStr(snapped);
      setPriceFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setPriceFlash(false), 1_800);
    }
  };
  const snapPrice = () => snapPriceFor(side);

  // Side can flip AFTER the price was snapped (blur fires before the toggle's
  // click), leaving a price rounded the wrong way for the new side — re-snap
  // from the raw value with the new side instead of waiting for the next blur.
  const changeSide = (s: Side) => {
    setSide(s);
    snapPriceFor(s);
  };

  const setQuickPrice = (mult: number) => {
    if (!ref || !symbol) return;
    rawPrice.current = ref * mult;
    setPriceStr(formatRestPrice(ref * mult, side, symbol, detail.data?.tickSize ?? '0.0001'));
    setPriceFlash(false);
  };

  const clearTicket = () => {
    setSizeStr('');
    setPriceStr('');
    rawPrice.current = null;
  };

  /**
   * The biggest order the account can carry at the venue max: the notional
   * whose initial margin (with the preflight's buffer and fee reserve — the
   * gate ExecuteControl enforces) equals the available margin. Stated in the
   * box's unit, so clicking it fills the box with a number that will pass.
   */
  const available = Number(account.data?.availableMargin ?? NaN);
  const maxNotional =
    Number.isFinite(available) && available > 0 && levMax > 0
      ? available / (PREFLIGHT_MARGIN_BUFFER / levMax + TAKER_FEE_RESERVE)
      : null;
  const maxSize =
    maxNotional === null ? null : sizeMode === 'usdt' ? maxNotional : ref && ref > 0 ? maxNotional / ref : null;
  const maxLabel =
    maxSize === null
      ? null
      : sizeMode === 'usdt'
        ? `max ${fmtUsd(maxSize, 0)}`
        : `max ${sig(maxSize, 4)} ${base ?? ''}`;

  // Initial margin this leg posts — from the same estimator (and the same live
  // positions/mode) the execute gate uses, so the figure and the gate agree.
  const marginRequired = preview.previews
    ? estimateMargin(preview.previews, positions.data?.positions, account.data?.positionMode).required
    : null;

  const pickCoin = (coin: string) => {
    setBase(coin);
    setSymbol(null);
    // Picking a coin by hand ends the prefill's claim on the unit: the new
    // coin's own default must win, or the ticket stays stuck on the last
    // prefill's unit for the life of the (never-remounted) drawer. See
    // PairTicket: releasing the pin without clearing the figure would relabel
    // a USD number as coins (and flip `notional`→`qty`).
    setUnitPinned(false);
    setSizeStr('');
  };

  return (
    <div className="flex flex-col gap-4">
      <MarketPicker
        base={base}
        symbol={symbol}
        onBase={pickCoin}
        onSymbol={(sym) => {
          const b = baseOfSymbol(sym);
          // A new coin releases the unit pin and the figure with it (see
          // pickCoin); another venue for the SAME coin keeps both — the size
          // still means what it meant.
          if (b !== base) {
            setUnitPinned(false);
            setSizeStr('');
          }
          setBase(b);
          setSymbol(sym);
        }}
        onClear={() => {
          setBase(null);
          setSymbol(null);
          setUnitPinned(false);
          setSizeStr('');
        }}
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel>Side</FieldLabel>
        {/* The side's colour rides on the switch: grass while Buy is live,
            rose while Sell is — the same two tones every position row uses. */}
        <SegmentedToggle<Side>
          ariaLabel="Side"
          fill
          className={side === 'BUY' ? 'seg-grass' : 'seg-rose'}
          value={side}
          onChange={changeSide}
          options={[
            { value: 'BUY', label: 'Buy' },
            { value: 'SELL', label: 'Sell' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel>Order</FieldLabel>
        <SegmentedToggle<'MARKET' | 'LIMIT'>
          ariaLabel="Order type"
          fill
          value={type}
          onChange={setType}
          options={[
            { value: 'MARKET', label: 'Market' },
            { value: 'LIMIT', label: 'Limit' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor="ticket-size">Size</FieldLabel>
          {maxLabel && (
            <button
              type="button"
              title="The largest order the available margin carries at the venue max leverage (after the preflight's buffer and fee reserve)"
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
              ariaLabel="Size mode"
              className="seg-xs"
              value={sizeMode}
              onChange={(m) => {
                // An explicit choice wins over the coin's default from here on.
                setUnitPinned(true);
                setSizeMode(m);
              }}
              options={[
                { value: 'base', label: base || 'qty' },
                { value: 'usdt', label: 'USDT' },
              ]}
            />
          }
        >
          <input
            id="ticket-size"
            className={`input num pr-[124px] ${sizeErr ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            placeholder={sizeMode === 'usdt' ? 'notional (USDT)' : `qty${base ? ` (${base})` : ''}`}
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

      {type === 'LIMIT' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor="ticket-price">Limit price</FieldLabel>
            <span className="flex gap-1">
              <button type="button" className="btn-ghost-xs" disabled={!ref} onClick={() => setQuickPrice(1)}>
                mark
              </button>
              <button type="button" className="btn-ghost-xs" disabled={!ref} onClick={() => setQuickPrice(0.999)}>
                mark−0.1%
              </button>
              <button type="button" className="btn-ghost-xs" disabled={!ref} onClick={() => setQuickPrice(1.001)}>
                mark+0.1%
              </button>
            </span>
          </div>
          <AffixedInput affix={<span>{p?.fees?.quote ?? 'USDT'}</span>}>
            <input
              id="ticket-price"
              className={`input num pr-14 transition-colors ${priceFlash ? 'border-cyan-400 ring-1 ring-cyan-400/40' : ''}`}
              inputMode="decimal"
              placeholder="price"
              title={priceFlash ? 'adjusted to venue tick/precision rules' : undefined}
              value={priceStr}
              onChange={(e) => {
                setPriceStr(e.target.value);
                // Remember what the user typed pre-snap (NaN → null): the
                // directional blur snap below is lossy, and a later side flip
                // must re-snap from this, not from the already-rounded display.
                const n = Number(e.target.value);
                rawPrice.current = Number.isFinite(n) && n > 0 ? n : null;
              }}
              onBlur={snapPrice}
            />
          </AffixedInput>
          {priceFlash && (
            <span className="text-[10px] text-cyan-300" title="adjusted to venue tick/precision rules">
              adjusted to venue tick/precision rules
            </span>
          )}
          <span className="text-[10.5px] text-ink-400">
            limits rest post-only (maker fee only) — a crossing price is rejected and re-quoted;
            to take now, use Market
          </span>
          <label className="flex items-center gap-2 text-[11.5px] text-ink-200">
            <input type="checkbox" className="chk" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
            reduce-only
          </label>
        </div>
      )}

      {action && (
        <EstimateCard dataUpdatedAt={preview.dataUpdatedAt} estimating={estimating} isError={preview.isError}>
          {p ? (
            <>
              {type === 'MARKET' && p.fillEstimate && (
                <div className="flex items-end justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-[12.5px] text-ink-50">Tentative avg fill</span>
                    <span className="text-[11px] text-ink-400">
                      {p.fillEstimate.source.replace('-', ' ')} · {p.fillEstimate.confidence} confidence
                    </span>
                  </div>
                  <span className="num flex items-baseline gap-1.5 text-lg font-semibold text-ink-50">
                    {sig(p.fillEstimate.avgPrice)}
                    <span className="text-[12px] font-medium">
                      <SlippageBadge est={p.fillEstimate} />
                    </span>
                  </span>
                </div>
              )}
              {type === 'LIMIT' && p.price && (
                <div className="flex items-end justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-[12.5px] text-ink-50">Rests at</span>
                    <span className="text-[11px] text-ink-400">post-only · fills only as a maker</span>
                  </div>
                  <span className="num text-lg font-semibold text-ink-50">{sig(p.price)}</span>
                </div>
              )}
              {type === 'MARKET' && p.fillEstimate?.partialDepth && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded border border-dashed border-amber-500/50 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-200"
                >
                  <span aria-hidden className="text-amber-400">
                    ⚠
                  </span>
                  <span>
                    <span className="font-medium">Partial depth</span> — the estimate is extrapolated past what the book
                    shows.
                  </span>
                </div>
              )}
              <div className="flex flex-col gap-1.5 border-t border-ink-800/80 pt-2">
                {p.qty && (
                  <EstimateRow
                    label="Qty"
                    sub={
                      sizeMode === 'usdt' && p.estNotional > 0 && p.estNotional < sizeNum - 1e-9 ? (
                        <span className="text-amber-400">real notional {fmtUsd(p.estNotional)} ≤ target</span>
                      ) : undefined
                    }
                    value={`${sig(p.qty)}${base ? ` ${base}` : ''}`}
                  />
                )}
                <EstimateRow label="Est fee" sub={feeKind(p.fees)} value={feeAmount(p.fees)} />
                <EstimateRow
                  label="Leverage"
                  value={<LeverageValue text={levMax > 0 ? `${levMax}x` : symbol ? 'loading…' : null} />}
                />
                <EstimateRow
                  label="Margin required"
                  title="Initial margin this leg posts — its notional over the venue max leverage"
                  value={marginRequired !== null ? `≈ ${fmtUsd(marginRequired)}` : '—'}
                  strong
                />
              </div>
              <ViolationList violations={p.violations} warnings={p.warnings} />
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
          actions={action ? [action] : null}
          // No Review card: the ticket already shows the fill estimate, fees,
          // margin and violations right above this button, so hovering popped
          // a floating copy of what was already on screen. (Execute errors
          // still open it — same as the pair ticket and close popover.)
          hoverCard={false}
          tone={side === 'BUY' ? 'buy' : 'sell'}
          label="Execute now ▸"
          buttonClassName="w-full"
          // Block until the venue's leverage cap is known — executing before it
          // loads would silently open at the account's current leverage, not the
          // "venue max" the UI promises.
          extraDisabled={Boolean(symbol) && levMax === 0}
          onExecuted={clearTicket}
          detail={levMax > 0 ? <>Leverage {levMax}x (venue max)</> : undefined}
        />
        {/* Said under the button, where the pair ticket would show the other
            leg: this one has no hedge, and nothing else on the ticket says so. */}
        <span className="text-[11px] text-ink-400">This leg is not hedged.</span>
      </div>
    </div>
  );
}
