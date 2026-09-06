/**
 * Single-leg order ticket: symbol search, BUY/SELL, MARKET/LIMIT, USDT↔base
 * sizing, tick-snapped limit price, and a live debounced preview (400ms,
 * refreshed every 3s while valid). Leverage is always the venue max (shown, not
 * editable). "Execute now" is a hold-to-confirm inline execute (no review modal).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSymbolDetail, useSymbolsByBase } from '../api/queries';
import { useTradeFlowOptional } from './TradeFlow';
import type { ActionInput, Side } from '../api/types';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { fieldValue, fmtUsd, parseSymbol, sig } from '../lib/fmt';
import { amountError } from '../lib/amount';
import { sizeUnitForBase } from '../lib/boros';
import { formatRestPrice } from '../lib/ticks';
import { ExecuteControl } from './ExecuteControl';
import { feeText, PreviewFallback, SlippageBadge, ViolationList } from './previewBits';
import { SymbolCombobox } from './SymbolCombobox';
import { usePreviewDebounced } from './usePreview';

type SizeMode = 'usdt' | 'base';

function SideToggle({ value, onChange }: { value: Side; onChange: (s: Side) => void }) {
  const btn = (side: Side, activeCls: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === side}
      onClick={() => onChange(side)}
      className={`rounded-lg border py-1.5 text-sm font-semibold transition-colors ${
        value === side ? activeCls : 'border-ink-700 bg-ink-950 text-ink-400 hover:text-ink-200'
      }`}
    >
      {side}
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Side">
      {btn('BUY', 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300')}
      {btn('SELL', 'border-rose-500/60 bg-rose-500/15 text-rose-300')}
    </div>
  );
}

export function SingleTicket() {
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
    // A venue with no CrossEx symbol for this coin leaves the picker empty
    // rather than arming a different venue's leg.
    if (rule) setSymbol(rule.symbol);
    setPrefillDone(prefillNonce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce, prefillBase, prefillVenues.data, prefillVenues.isPlaceholderData]);

  const detail = useSymbolDetail(symbol);

  const base = symbol ? parseSymbol(symbol).base : '';
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
  const ref = p?.refPrice?.value;

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

  return (
    <div className="flex flex-col gap-3">
      <SymbolCombobox
        value={symbol}
        // Picking a symbol by hand ends the prefill's claim on the unit: the
        // new coin's own default must win, or the ticket stays stuck on the
        // last prefill's unit for the life of the (never-remounted) drawer.
        onSelect={(sym) => {
          setSymbol(sym);
          // See PairTicket: releasing the pin without clearing the figure
          // would relabel a USD number as coins (and flip `notional`→`qty`).
          setUnitPinned(false);
          setSizeStr('');
        }}
        onClear={() => {
          setSymbol(null);
          setUnitPinned(false);
          setSizeStr('');
        }}
      />
      <SideToggle value={side} onChange={changeSide} />
      <SegmentedToggle<'MARKET' | 'LIMIT'>
        ariaLabel="Order type"
        value={type}
        onChange={setType}
        options={[
          { value: 'MARKET', label: 'MARKET' },
          { value: 'LIMIT', label: 'LIMIT' },
        ]}
      />

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="ticket-size" className="text-[11px] text-ink-400">
            Size
          </label>
          <SegmentedToggle<SizeMode>
            ariaLabel="Size mode"
            value={sizeMode}
            onChange={(m) => {
              // An explicit choice wins over the coin's default from here on.
              setUnitPinned(true);
              setSizeMode(m);
            }}
            options={[
              { value: 'usdt', label: <span className="text-xs">USDT</span> },
              { value: 'base', label: <span className="text-xs">{base || 'qty'}</span> },
            ]}
          />
        </div>
        <input
          id="ticket-size"
          className={`input num ${sizeErr ? '!border-rose-500/60' : ''}`}
          inputMode="decimal"
          placeholder={sizeMode === 'usdt' ? 'notional (USDT)' : `qty${base ? ` (${base})` : ''}`}
          aria-invalid={sizeErr ? true : undefined}
          aria-describedby={sizeErr ? 'ticket-size-error' : undefined}
          value={sizeStr}
          onChange={(e) => setSizeStr(e.target.value)}
        />
        {sizeErr && (
          <p id="ticket-size-error" role="alert" className="text-[11px] text-rose-300">
            {sizeErr}
          </p>
        )}
        {p && ref !== undefined && sizeOk && (
          <div className="text-[11px] text-ink-400">
            {sizeMode === 'usdt' ? (
              <>
                ≈ <span className="num">{sig(sizeNum / ref)}</span> {base}
              </>
            ) : (
              <>
                ≈ <span className="num">{fmtUsd(sizeNum * ref)}</span>
              </>
            )}
          </div>
        )}
        {p && p.qty && (
          <div className="text-[11px] text-ink-400">
            resolved qty <span className="num text-ink-200">{sig(p.qty)}</span>
            {sizeMode === 'usdt' && p.estNotional > 0 && p.estNotional < sizeNum - 1e-9 && (
              <span className="text-amber-400"> · real notional {fmtUsd(p.estNotional)} ≤ target</span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-400">
        <span>Leverage</span>
        <span className="num text-ink-200">
          {levMax > 0 ? `${levMax}x (venue max)` : symbol ? 'loading…' : '— (venue max)'}
        </span>
      </div>

      {type === 'LIMIT' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ticket-price" className="text-[11px] text-ink-400">
            Limit price
          </label>
          <input
            id="ticket-price"
            className={`input num transition-colors ${priceFlash ? 'border-cyan-400 ring-1 ring-cyan-400/40' : ''}`}
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
          {priceFlash && (
            <span className="text-[10px] text-cyan-300" title="adjusted to venue tick/precision rules">
              adjusted to venue tick/precision rules
            </span>
          )}
          <div className="flex gap-1">
            <button type="button" className="btn-ghost-xs" disabled={!ref} onClick={() => setQuickPrice(1)}>
              mark
            </button>
            <button type="button" className="btn-ghost-xs" disabled={!ref} onClick={() => setQuickPrice(0.999)}>
              mark−0.1%
            </button>
            <button type="button" className="btn-ghost-xs" disabled={!ref} onClick={() => setQuickPrice(1.001)}>
              mark+0.1%
            </button>
          </div>
          <span className="text-[10px] text-ink-500">
            limits rest post-only (maker fee only) — a crossing price is rejected and re-quoted;
            to take now, use MARKET
          </span>
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
            reduce-only
          </label>
        </div>
      )}

      {action && (
        <div className="flex flex-col gap-1 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2 text-[11px]">
          {p ? (
            <>
              {estimating && <span className="text-amber-400">estimating…</span>}
              {p.refPrice && (
                <span className="text-ink-500">
                  ref <span className="num">{sig(p.refPrice.value)}</span> · {p.refPrice.source}
                </span>
              )}
              {type === 'MARKET' && p.fillEstimate && (
                <span className="text-ink-300">
                  Tentative avg fill{' '}
                  <span className="num text-ink-100" title={`${p.fillEstimate.source} · ${p.fillEstimate.confidence}`}>
                    {sig(p.fillEstimate.avgPrice)}
                  </span>{' '}
                  <SlippageBadge est={p.fillEstimate} />
                </span>
              )}
              {type === 'MARKET' && p.fillEstimate?.partialDepth && (
                <span className="text-amber-400">partial depth — estimate extrapolated</span>
              )}
              <span className="text-ink-300">est fee {feeText(p.fees)}</span>
              <ViolationList violations={p.violations} warnings={p.warnings} />
            </>
          ) : (
            <PreviewFallback isError={preview.isError} error={preview.error} />
          )}
        </div>
      )}

      <ExecuteControl
        scope="ticket-single"
        actions={action ? [action] : null}
        // No Review card: the ticket already shows the ref price, fill
        // estimate, fees and violations right above this button, so hovering
        // popped a floating copy of what was already on screen. (Execute
        // errors still open it — same as the pair ticket and close popover.)
        hoverCard={false}
        tone={side === 'BUY' ? 'green' : 'red'}
        label="Execute now ▸"
        buttonClassName="w-full"
        // Block until the venue's leverage cap is known — executing before it
        // loads would silently open at the account's current leverage, not the
        // "venue max" the UI promises.
        extraDisabled={Boolean(symbol) && levMax === 0}
        onExecuted={clearTicket}
        detail={levMax > 0 ? <>Leverage {levMax}x (venue max)</> : undefined}
      />
    </div>
  );
}
