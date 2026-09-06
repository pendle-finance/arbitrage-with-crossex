/**
 * Delta-neutral pair ticket: one coin, a LONG venue and a SHORT venue, one
 * notional-per-leg. Two execution modes:
 *  - "2 market orders": both legs MARKET opens (taker × 2), submitted concurrently.
 *  - "Limit + hedge": one leg rests post-only one bid–ask gap BEHIND the touch
 *    (maker fee) and the engine auto-fires market hedges on the other leg as it
 *    fills; the maker venue is auto-chosen to minimize total fees (no manual
 *    override).
 * Both legs run at their own venue's max leverage. Execute is inline hold-to-
 * confirm — no review modal — so the maker price stays live until t=submit.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, usePositions, useSymbolDetail, useSymbolsByBase } from '../api/queries';
import type { ActionInput, PreviewResult, RestEstimate } from '../api/types';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { amountError } from '../lib/amount';
import { sizeUnitForBase } from '../lib/boros';
import { fieldValue, fmtUsd } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import { ExecuteControl } from './ExecuteControl';
import { estimateMargin } from './previewBits';
import {
  MakerHedgeControls,
  PairPreview,
  VenueRow,
  type ExecMode,
  type TimeoutChoice,
} from './PairTicketBits';
import { PairBookImpact } from './PriceImpactGraph';
import { CoinCombobox } from './SymbolCombobox';
import { useTradeFlowOptional } from './TradeFlow';
import { usePreviewDebounced } from './usePreview';

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
export function PairTicket({ onExecuted }: { onExecuted?: () => void } = {}) {
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
  const [mode, setMode] = useState<ExecMode>('maker');
  const [makerPriceStr, setMakerPriceStr] = useState('');
  /** True once the user typed a price — stop auto-tracking the touch. */
  const [pricePinned, setPricePinned] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState<TimeoutChoice>('300');

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

  // Preview results are needed BELOW for the maker auto-choice; note the [long,
  // short] positional order is preserved in BOTH modes so previews[0] is always
  // the LONG leg. The chooser reads only per-venue fee RATES, which don't depend
  // on the current mode/roles — so the choice can't oscillate with the preview.
  const [previewLegs, setPreviewLegs] = useState<{ legLong?: PreviewResult; legShort?: PreviewResult }>({});

  const makerLegPick = useMemo<'long' | 'short'>(() => {
    const fl = previewLegs.legLong?.fees;
    const fs = previewLegs.legShort?.fees;
    if (!fl || !fs) return 'long';
    // Total fee = maker on one venue + taker on the other; pick the cheaper combo.
    const costMakerLong = fl.makerRate + fs.takerRate;
    const costMakerShort = fs.makerRate + fl.takerRate;
    return costMakerShort < costMakerLong - 1e-12 ? 'short' : 'long';
  }, [previewLegs.legLong?.fees, previewLegs.legShort?.fees]);

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
    const makerIsLong = makerLegPick === 'long';
    const makerLeg: ActionInput = {
      kind: 'open-limit',
      symbol: makerIsLong ? longSym : shortSym,
      side: makerIsLong ? 'BUY' : 'SELL',
      ...sizeArg,
      price: makerPriceStr,
      tif: 'POC',
      pairRole: 'maker',
      makerTimeoutSec: Number(timeoutSec),
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
    return makerIsLong ? [makerLeg, hedgeLeg] : [hedgeLeg, makerLeg];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [longSym, shortSym, notionalOk, notionalStr, sizeUnit, levLong, levShort, pairGroupId, mode, makerLegPick, makerPriceStr, timeoutSec]);

  const preview = usePreviewDebounced('ticket-pair', actions, { debounceMs: 400, refetchInterval: 3_000 });
  const legLong = preview.previews?.[0];
  const legShort = preview.previews?.[1];
  useEffect(() => {
    setPreviewLegs({ legLong, legShort });
  }, [legLong, legShort]);

  // Auto-track the maker price to ONE bid–ask gap BEHIND the venue's touch —
  // a BUY rests at bid − (ask − bid), a SELL at ask + (ask − bid) — until the
  // user pins a price (the engine's t=submit peg applies the same formula
  // server-side). Fallback chain when the maker venue's book is unavailable:
  // the maker leg's own mid (market-mode estimate) → the HEDGE leg's mid
  // (cross-venue, within bps — a usable starting price beats an empty input
  // that blocks the whole ticket).
  const makerPreviewLeg = makerLegPick === 'long' ? legLong : legShort;
  const hedgePreviewLeg = makerLegPick === 'long' ? legShort : legLong;
  const makerSideIsBuy = makerLegPick === 'long';
  const touchPx = makerPreviewLeg?.restEstimate
    ? restOffsetPrice(makerPreviewLeg.restEstimate, makerSideIsBuy)
    : (makerPreviewLeg?.fillEstimate?.midPrice ?? hedgePreviewLeg?.fillEstimate?.midPrice);
  const touchIsFallback = Boolean(touchPx !== undefined && !makerPreviewLeg?.restEstimate);
  useEffect(() => {
    if (mode !== 'maker' || pricePinned) return;
    if (Number.isFinite(touchPx) && (touchPx as number) > 0) setMakerPriceStr(String(touchPx));
  }, [mode, pricePinned, touchPx]);

  const estimating = preview.estimating;

  // Maker-mode saving vs the all-taker open, from per-venue rates × notional.
  const makerSaving = useMemo(() => {
    const fl = legLong?.fees;
    const fs = legShort?.fees;
    if (!fl || !fs || !notionalOk) return null;
    const allTaker = fl.takerRate + fs.takerRate;
    const chosen = makerLegPick === 'long' ? fl.makerRate + fs.takerRate : fs.makerRate + fl.takerRate;
    /**
     * This is a DOLLAR saving, so it needs a dollar notional. When the box is
     * in base units the preview's own resolved estNotional is the honest
     * source — reusing the typed number would have reported "you save $0.4" on
     * a 0.4 ETH order, wrong by the whole ETH price.
     */
    const usdNotional =
      sizeUnit === 'usd' ? notionalNum : (legLong?.estNotional ?? legShort?.estNotional ?? null);
    if (usdNotional === null || !Number.isFinite(usdNotional)) return null;
    return (allTaker - chosen) * usdNotional;
  }, [legLong?.fees, legShort?.fees, legLong?.estNotional, legShort?.estNotional, makerLegPick, notionalOk, notionalNum, sizeUnit]);

  // Inject the engine-side peg ONLY at confirm and ONLY while auto-tracking: the
  // maker rests at the fresh book-offset price computed at t=submit (same
  // one-gap-behind-the-touch formula), not the client price.
  const trackingMaker = mode === 'maker' && !pricePinned;
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

  return (
    <div className="flex flex-col gap-3">
      <CoinCombobox
        value={base}
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
        }}
        onClear={() => {
          setBase(null);
          setLongSym(null);
          setShortSym(null);
          setUnitPinned(false);
          setNotionalStr('');
        }}
      />

      {base && (
        <>
          <VenueRow
            label="LONG venue"
            tone="long"
            value={longSym}
            otherValue={shortSym}
            onPick={(s) => setLongSym(s || null)}
            venues={venues.data}
            loading={venues.isPending}
          />
          <VenueRow
            label="SHORT venue"
            tone="short"
            value={shortSym}
            otherValue={longSym}
            onPick={(s) => setShortSym(s || null)}
            venues={venues.data}
            loading={venues.isPending}
          />
        </>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="pair-notional" className="text-[11px] text-ink-400">
            Size per leg{base || sizeUnit === 'usd' ? ` (${sizeUnit === 'base' ? base : 'USDT'})` : ''}
          </label>
          {/* The unit follows the coin (see sizeUnitForBase): ETH/BTC are
              coin-margined on Boros, so the perp is sized in the coin and the
              hedge is exact; every other coin is USDT-collateral there, so the
              dollar figure is the one both legs share. The toggle stays because
              some users think in notional regardless — and once used, it pins. */}
          {/* No coin picked yet ⇒ nothing sensible to call the base unit, so
              the choice is withheld rather than shown as "Base". */}
          {base && (
          <SegmentedToggle<'base' | 'usd'>
            ariaLabel="Size unit"
            value={sizeUnit}
            onChange={(u) => {
              // An explicit choice wins over the coin's default from here on.
              setUnitPinned(true);
              setSizeUnit(u);
            }}
            options={[
              // Always the actual coin (ETH / BTC) — "Base" is jargon that
              // names a role rather than the unit the number is in. Before a
              // coin is picked the toggle is not shown at all.
              { value: 'base', label: base ?? '' },
              { value: 'usd', label: 'USDT' },
            ]}
          />
          )}
        </div>
        <input
          id="pair-notional"
          className={`input num ${notionalErr ? '!border-rose-500/60' : ''}`}
          inputMode="decimal"
          placeholder={sizeUnit === 'base' && base ? `size in ${base}` : 'size per leg'}
          aria-invalid={notionalErr ? true : undefined}
          aria-describedby={notionalErr ? 'pair-notional-error' : undefined}
          value={notionalStr}
          onChange={(e) => setNotionalStr(e.target.value)}
        />
        {notionalErr && (
          <p id="pair-notional-error" role="alert" className="text-[11px] text-rose-300">
            {notionalErr}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-400">
        <span>Leverage</span>
        <span className="num text-ink-200">
          {levLong !== undefined && levShort !== undefined
            ? `${levLong}x long / ${levShort}x short (venue max)`
            : longSym && shortSym
              ? 'loading…'
              : '— (venue max)'}
        </span>
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-400">
        <span title="Initial margin the two legs post together — each leg's notional over its leverage">
          Margin required
        </span>
        <span className="num text-ink-200">
          {marginRequired !== null ? `≈ ${fmtUsd(marginRequired, 0)}` : '—'}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-ink-400">Execution</span>
        <SegmentedToggle<ExecMode>
          ariaLabel="Pair execution mode"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setPricePinned(false);
          }}
          options={[
            { value: 'market', label: '2 market orders' },
            { value: 'maker', label: 'Limit + hedge', sub: 'saves fees' },
          ]}
        />
      </div>

      {mode === 'maker' && (
        <MakerHedgeControls
          makerLegPick={makerLegPick}
          longSym={longSym}
          shortSym={shortSym}
          makerSaving={makerSaving}
          priceStr={makerPriceStr}
          pricePinned={pricePinned}
          touchIsFallback={touchIsFallback}
          onPriceInput={(v) => {
            setMakerPriceStr(v);
            setPricePinned(true);
          }}
          onTrackTouch={() => setPricePinned(false)}
          timeoutSec={timeoutSec}
          onTimeout={setTimeoutSec}
        />
      )}

      <PairBookImpact
        longSym={longSym}
        shortSym={shortSym}
        notional={notionalStr}
        legLong={legLong}
        legShort={legShort}
        estimating={estimating}
        mode={mode}
        makerLegPick={makerLegPick}
        makerPriceStr={makerPriceStr}
      />

      {actions && (
        <PairPreview
          previews={preview.previews}
          isError={preview.isError}
          error={preview.error}
          estimating={estimating}
          legLong={legLong}
          legShort={legShort}
          mode={mode}
        />
      )}

      <ExecuteControl
        scope="ticket-pair"
        actions={actions}
        tone="cyan"
        label="Execute pair ▸"
        buttonClassName="w-full"
        // The ticket's own preview box reviews the legs — no hover card.
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
          makerLegPick,
          timeoutSec,
          pricePinned ? makerPriceStr : 'track',
        ].join('|')}
        // Block until BOTH venues' leverage caps are known (executing before they
        // load would open at the account's current leverage, not the venue max),
        // and, in maker mode, until the maker price has been tracked.
        extraDisabled={(mode === 'maker' && !makerPriceStr) || levLong === undefined || levShort === undefined}
        onExecuted={stageDone}
        detail={
          <div className="flex flex-col gap-0.5">
            {levLong !== undefined && levShort !== undefined && (
              <span>
                Leverage {levLong}x long / {levShort}x short (venue max)
              </span>
            )}
            {trackingMaker && <span>maker price pegs to the touch at submit</span>}
          </div>
        }
      />
    </div>
  );
}
