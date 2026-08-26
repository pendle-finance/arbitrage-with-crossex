/**
 * The ONE execute affordance — replaces the review modal for every path.
 *
 * Hold-to-confirm button (the modal's 800ms gate, now inline) + a hover review
 * card (the modal's per-leg rows/totals, fed by a live preview) + the execute
 * mutation. The maker/qty pricing is resolved at CONFIRM from the freshest
 * preview, never frozen at click.
 *
 * Two shapes, inferred from the actions:
 *  - EAGER (a leg carries `notional`, e.g. the tickets): a resolved preview is
 *    REQUIRED — confirm stamps `finalizeActions(previews)` and is gated on the
 *    preview being present, fresh (<10s), and violation-free. The caller already
 *    runs this preview for its own summary box; sharing the `scope` dedupes it.
 *  - LAZY (no `notional` — closes, server-built remediation): the raw actions are
 *    already execute-ready, so confirm works immediately and the preview is a
 *    hover-gated decoration (it still blocks on any violation it surfaces).
 *
 * Idempotency: one basketId per staged intent, generated on first confirm and
 * REUSED across error-retries (the server dedupes on it, so a lost-response
 * resend is a no-op), cleared only on a 202.
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, postJson } from '../api/client';
import { useAccount, usePositions } from '../api/queries';
import type { ActionInput, DealResponse, PreviewResult } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Spinner } from '../components/Spinner';
import { SymbolCell } from '../components/VenueChip';
import { fmtUsd, parseSymbol, sig } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import { useNow } from '../lib/useNow';
import { dealFromActions } from './deal';
import { finalizeActions } from './finalize';
import { clearPendingBasket, readPendingBasket, writePendingBasket } from './pendingBasket';
import { ActionKindChip, estFeeOf, estimateMargin, feeText, SlippageBadge, ViolationList } from './previewBits';
import { useTradeFlow } from './TradeFlow';
import { usePreviewDebounced } from './usePreview';

const STALE_MS = 10_000;

interface Props {
  /** react-query preview scope — match the caller's own ticket preview to dedupe. */
  scope: string;
  /** Preview-shaped actions (NEVER with execute-only fields like pegToTouch). */
  actions: ActionInput[] | null;
  tone?: 'green' | 'red' | 'cyan';
  label: ReactNode;
  /** Only fetch the preview while hovered (for closes / server-built actions). */
  lazyPreview?: boolean;
  /** Inject execute-only fields into the finalized payload (e.g. maker pegToTouch). */
  decorate?: (actions: ActionInput[]) => ActionInput[];
  /** Extra display line in the hover card (e.g. leverage / peg note). */
  detail?: ReactNode;
  /** Fired after a successful 202 (e.g. bump the ticket's pairGroup nonce). */
  onExecuted?: () => void;
  /** Stable identity of the USER'S intent — a change to it mints a fresh
   * basketId (so an edited order after a lost response isn't deduped against the
   * original). Defaults to the serialized actions. Callers whose `actions`
   * mutate on their own WITHOUT a real edit (e.g. the maker price auto-tracking
   * the touch every preview cycle) MUST pass a key that excludes that churn, or
   * a genuine same-intent retry would mint a new id and risk a double-execute. */
  intentKey?: string;
  /** Caller-specific gate on top of the preview gating (e.g. maker price not yet
   * tracked) — blocks confirm without blocking the preview that fills it. */
  extraDisabled?: boolean;
  previewOpts?: { debounceMs?: number; refetchInterval?: number };
  className?: string;
  buttonClassName?: string;
  /** Test hook only — the product gate stays at 800ms. */
  holdMs?: number;
  /** Set false when the caller's own summary already reviews the legs (the pair
   * ticket) — the hover review card is then redundant. Execution errors still
   * open the card: they must never be silent. */
  hoverCard?: boolean;
}

export function ExecuteControl({
  scope,
  actions,
  tone = 'cyan',
  label,
  lazyPreview = false,
  decorate,
  detail,
  onExecuted,
  intentKey,
  extraDisabled = false,
  previewOpts,
  className,
  buttonClassName,
  holdMs,
  hoverCard = true,
}: Props) {
  const flow = useTradeFlow();
  const account = useAccount();
  const positions = usePositions();
  const now = useNow(1_000);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const basketIdRef = useRef<string | null>(null);
  // The intent (resetKey) whose POST is currently in flight — captured at
  // confirm, NOT read from the render scope in onSuccess: the user can edit the
  // ticket while the request is pending, and clearing the EDITED key would
  // leave the original intent's now-executed id in the pending store, where a
  // later identical ticket would recover it and be deduped into the OLD deal.
  const inflightIntentRef = useRef('');
  // A SINGLE resting limit order is a plain order, not a process to supervise:
  // no hedge leg, no deadline, nothing to babysit. It should not drag the user
  // into the deal view — it belongs in Open Orders like any other limit order.
  const restingOnlyRef = useRef(false);
  const placedSummaryRef = useRef<string | null>(null);
  const [placedResting, setPlacedResting] = useState<string | null>(null);

  // Lazy previews only run while the card is shown; eager previews run always so
  // the button is armed the moment the ticket is complete.
  const previewActions = lazyPreview && !hovering ? null : actions;
  const preview = usePreviewDebounced(scope, previewActions, {
    debounceMs: previewOpts?.debounceMs ?? 400,
    refetchInterval: previewOpts?.refetchInterval ?? 3_000,
  });
  const previews = preview.previews;

  const execute = useMutation({
    mutationFn: (body: Parameters<typeof postJson>[1] & { id: string }) =>
      postJson<DealResponse>('/deals', body),
    onSuccess: (r) => {
      basketIdRef.current = null; // intent completed — next confirm is a new deal
      // Clear ONLY the intent this success belongs to — other ExecuteControl
      // instances may have their own unresolved ids pending in the same store,
      // and wiping those would re-open their double-execute window.
      clearPendingBasket(inflightIntentRef.current);
      onExecuted?.();
      if (restingOnlyRef.current) setPlacedResting(placedSummaryRef.current);
      else flow.openDeal(r.id);
    },
    // onError deliberately KEEPS basketIdRef so a retry of the SAME order reuses
    // the id (the server dedupes on it; a network-lost POST must never double-execute).
  });

  // A CHANGED intent must mint a fresh basketId: an id retained after a lost-
  // response error would otherwise be reused with EDITED actions, which the
  // server dedupes against the original — silently dropping the edit and
  // surfacing the wrong basket. But the key must track the USER'S intent, not
  // incidental churn: the maker price auto-tracks the touch every preview cycle,
  // and if that reset the id, a genuine same-intent retry would mint a new id
  // and DOUBLE-EXECUTE (the server can't dedupe two different ids). So callers
  // with self-mutating actions pass an intentKey that excludes that churn.
  const resetKey = intentKey ?? (actions ? JSON.stringify(actions) : '');
  useEffect(() => {
    // Recover an id whose POST never resolved, so a remount (the Single/Pair
    // toggle unmounts this component outright) or a page reload still resends
    // the SAME id and the server dedupes it. Scoped to this exact intent, so an
    // edited ticket still mints a fresh one; null whenever there is nothing
    // pending, which is the previous behaviour.
    basketIdRef.current = readPendingBasket(resetKey);
    // Deliberately NOT clearing the "placed" receipt here: the ticket clears
    // ITSELF on success (onExecuted), which changes resetKey in the very cycle
    // the receipt is set — so clearing on resetKey wiped it instantly. The
    // receipt is cleared when the next order is confirmed, so it stays on
    // screen until the user actually does something else.
  }, [resetKey]);

  // Every deal shape needs the CURRENT preview at confirm (closes get side/qty
  // from the resolver), so the preview gate applies to all actions now.
  const needsPreview = (actions ?? []).length > 0;
  const ageMs = preview.dataUpdatedAt > 0 ? Math.max(0, now - preview.dataUpdatedAt) : Infinity;
  const stale = needsPreview && ageMs > STALE_MS;
  const previewMissing = needsPreview && (!previews || preview.estimating || preview.isError || stale);
  const hasViolations = previews?.some((p) => p.violations.length > 0) ?? false;

  // Money-safety: block confirm when the basket's estimated margin exceeds available
  // (the same shortfall the server preflight rejects — this just spares the round-trip
  // and explains why). Only when the estimate is CONFIDENT (every open leg has a known
  // leverage), so a fallback-to-1x guess can't false-block.
  //
  // `required > 0` is load-bearing: an all-close basket requires 0, and 0 still "exceeds"
  // a NEGATIVE availableMargin (which CrossEx reports when a sub-account borrows against
  // the others) — that blocked every close on the account that most needs to close.
  const available = Number(account.data?.availableMargin ?? NaN);
  const margin = previews
    ? estimateMargin(previews, positions.data?.positions, account.data?.positionMode)
    : { required: 0, confident: false };
  const marginBlocked =
    Boolean(previews) && margin.confident && Number.isFinite(available) && margin.required > 0 && margin.required > available;
  // The confirmed intent must map onto a deal shape the engine models (probe
  // with a placeholder id) — an unmappable shape must disable, not no-op.
  const mappable =
    !actions ||
    !previews ||
    preview.estimating ||
    dealFromActions('probe-0', decorate ? decorate(finalizeActions(previews)) : finalizeActions(previews), previews) !== null;
  const disabled =
    !actions || extraDisabled || execute.isPending || previewMissing || hasViolations || marginBlocked || !mappable;

  const onConfirm = () => {
    if (!actions || !previews || preview.estimating) return; // deal mapping needs the CURRENT preview
    if (!basketIdRef.current) basketIdRef.current = uuid();
    // Persist BEFORE the request leaves: the response is exactly what can go
    // missing, so the id has to survive independently of it.
    inflightIntentRef.current = resetKey;
    writePendingBasket(resetKey, basketIdRef.current);
    // Stamp resolver qty/price from the preview, apply confirm-time decorations
    // (pegToTouch), then map the confirmed intent onto the deal contract.
    const base = finalizeActions(previews);
    const deal = dealFromActions(basketIdRef.current, decorate ? decorate(base) : base, previews);
    if (!deal) return; // unmappable shape — the button was disabled anyway
    // `b` is OMITTED for a single leg, not set to null — hence ?? null.
    restingOnlyRef.current = (deal.b ?? null) === null && deal.execution === 'maker';
    placedSummaryRef.current = restingOnlyRef.current
      ? `${deal.a.side} ${deal.qty} ${parseSymbol(deal.a.symbol).base} @ ${deal.price}`
      : null;
    setPlacedResting(null);
    execute.mutate(deal);
  };

  const errMsg =
    execute.error instanceof ApiError
      ? execute.error.message
      : (execute.error as Error | null)?.message ?? null;
  const cardOpen = (hoverCard && hovering) || execute.isError;

  return (
    <div
      ref={wrapRef}
      className={`relative ${className ?? ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocusCapture={() => setHovering(true)}
      onBlurCapture={() => setHovering(false)}
    >
      <HoldToConfirmButton tone={tone} disabled={disabled} holdMs={holdMs} onConfirm={onConfirm} className={buttonClassName}>
        {execute.isPending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-3.5 w-3.5" /> executing…
          </span>
        ) : (
          label
        )}
      </HoldToConfirmButton>
      {placedResting && (
        <div
          role="status"
          className="mt-1 flex items-start justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-[11px] text-emerald-300"
        >
          <span>
            <span className="font-medium">Limit order placed.</span>{' '}
            <span className="num">{placedResting}</span> is resting on the venue until it fills —
            see Open Orders.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            className="px-1 leading-none text-emerald-400/70 transition-colors hover:text-emerald-200"
            onClick={() => setPlacedResting(null)}
          >
            ×
          </button>
        </div>
      )}
      {marginBlocked && (
        <div role="alert" className="mt-1 text-[11px] text-rose-400">
          margin ≈ {fmtUsd(margin.required)} exceeds available {Number.isFinite(available) ? fmtUsd(available) : '—'}
        </div>
      )}
      {!mappable && (
        <div role="alert" className="mt-1 text-[11px] text-amber-400">
          can't run as one deal (e.g. unequal leg sizes) — execute the legs individually
        </div>
      )}
      {cardOpen && (
        <HoverCard
          anchorRef={wrapRef}
          previews={previews}
          estimating={preview.estimating}
          isError={preview.isError}
          ageMs={ageMs}
          available={available}
          marginRequired={margin.required}
          marginExceeds={marginBlocked}
          detail={detail}
          execError={errMsg}
        />
      )}
    </div>
  );
}

/** The read-only review popover — fixed + portaled so no overflow ancestor
 * (the deal modal body, a table cell, the close popover) can clip it.
 * Opens upward, right-aligned to the button. */
function HoverCard({
  anchorRef,
  previews,
  estimating,
  isError,
  ageMs,
  available,
  marginRequired,
  marginExceeds,
  detail,
  execError,
}: {
  anchorRef: React.RefObject<HTMLElement>;
  previews: PreviewResult[] | undefined;
  estimating: boolean;
  isError: boolean;
  ageMs: number;
  available: number;
  marginRequired: number;
  marginExceeds: boolean;
  detail: ReactNode;
  execError: string | null;
}) {
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const reposition = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, r.right - 320), bottom: window.innerHeight - r.top + 8 });
    };
    reposition();
    // Fixed positioning is viewport-relative, so a scroll/resize while the card
    // is held open (e.g. by an execute error) must re-anchor it to the button.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [anchorRef]);
  if (!pos) return null;

  const fees = previews ? previews.reduce((s, p) => s + estFeeOf(p), 0) : 0;

  return createPortal(
    <div
      role="tooltip"
      className="fixed z-[55] w-[320px] rounded-xl border border-ink-700 bg-ink-900 p-3 text-xs shadow-2xl"
      style={{ left: pos.left, bottom: pos.bottom }}
    >
      {execError && (
        <div role="alert" className="mb-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-rose-300">
          {execError}
        </div>
      )}
      <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-500">
        <span>Review</span>
        <span className="num">
          {isError ? 'preview failed' : estimating ? 'previewing…' : Number.isFinite(ageMs) ? `${Math.floor(ageMs / 1000)}s ago` : '—'}
        </span>
      </div>
      {previews ? (
        <div className="flex flex-col gap-1.5">
          {previews.map((p) => (
            <div key={p.index} className="flex flex-col gap-0.5 border-t border-ink-800 pt-1.5 first:border-0 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <ActionKindChip input={p.input} />
                  <SymbolCell symbol={p.symbol} />
                </span>
                <span className="num text-ink-100">{p.qty ? sig(p.qty) : '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-ink-400">
                <span className="num">
                  {p.type === 'MARKET'
                    ? 'MKT'
                    : p.input.kind === 'close-position'
                      ? `IOC@${p.price ?? '—'}`
                      : `LMT@${p.price ?? '—'}${p.tif && p.tif !== 'GTC' ? ` ${p.tif}` : ''}`}
                  {p.fillEstimate && (
                    <>
                      {' · '}
                      {sig(p.fillEstimate.avgPrice)} <SlippageBadge est={p.fillEstimate} />
                    </>
                  )}
                </span>
                <span className="num">{feeText(p.fees)}</span>
              </div>
              {(p.violations.length > 0 || p.warnings.length > 0) && (
                <ViolationList violations={p.violations} warnings={p.warnings} />
              )}
            </div>
          ))}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-t border-ink-800 pt-1.5 text-[11px] text-ink-400">
            <span>
              Σ fees <span className="num text-ink-100">≈ {fmtUsd(fees, 4)}</span>
            </span>
            <span>
              margin{' '}
              <span className={`num ${marginExceeds ? 'font-semibold text-rose-400' : 'text-ink-100'}`}>{fmtUsd(marginRequired)}</span>
              <span className="text-ink-500"> / {Number.isFinite(available) ? fmtUsd(available) : '—'}</span>
            </span>
          </div>
        </div>
      ) : (
        <div className="py-2 text-center text-ink-500">
          <Spinner className="inline h-3 w-3" /> <span className="ml-1 align-middle">pricing…</span>
        </div>
      )}
      {detail && <div className="mt-1.5 border-t border-ink-800 pt-1.5 text-[11px] text-ink-400">{detail}</div>}
      <div className="mt-1.5 text-center text-[10px] text-ink-500">press &amp; hold to confirm</div>
    </div>,
    document.body,
  );
}
