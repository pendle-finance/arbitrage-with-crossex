/**
 * The DEGRADED view of an incomplete 4-leg position: a delta-neutral perp pair
 * (or a stray single leg) whose base has no rollup in the strategy feed.
 *
 * ⚠ This is not the normal home for a Boros-less pair. The solver emits a
 * `BASE#perps` rollup for pairless perps (returns.ts), so with a healthy feed
 * such a pair renders as a full StrategyCard — with its projection, its cost
 * controls and its in-app "Open the Boros legs →". This box is what remains
 * when we cannot say that much: no address tracked, the feed pending or
 * failed, or a partition that did not reconcile. A trading terminal must not
 * hide live positions behind a dead Boros backend.
 *
 * It therefore mirrors StrategyCard's HEADER grammar (asset badge · venue pair
 * · status, actions right) so the same position is recognisably the same
 * object across both, while carrying only claims this path can support:
 *   - no tracked address        → inline AddressForm ("lock this rate on Boros")
 *   - address + settled feed    → the two feeds disagree; say so, claim nothing
 *   - strategy feed pending/err → neutral note, never a false "no Boros" claim
 */
import { useMemo, useState } from 'react';
import type { ActionInput, CrossexPosition, ExposureGroup, ExposureLeg } from '../api/types';
import { Chip } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { ExposureBadge } from '../components/ExposureBadge';
import { SignedNumber } from '../components/SignedNumber';
import { SideChip, VenueChip } from '../components/VenueChip';
import { fieldValue, fmtUsd, num, prettyVenue, sig } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import { ExecuteControl } from '../trade/ExecuteControl';
import { ClosePreviewPanel } from '../trade/previewBits';
import { usePreviewDebounced } from '../trade/usePreview';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { AddressForm, short } from './HomeControls';
import { PerpLegExpanded } from './PerpLegExpanded';

/** Which completion cue the box shows (decided by PositionsHome). */
export type PerpOnlyCue = 'add-address' | 'execute-boros' | 'boros-pending' | null;

/** [Close both] — two close-position actions sharing a pairGroupId, executed
 * inline (hold-to-confirm). Renders nothing without the trade context (unit
 * tests) or when it isn't exactly two legs. Exported: the strategy feed now
 * renders Boros-less pairs as cards, and they keep this control there. */
export function CloseBoth({ base, legs }: { base: string; legs: Array<{ symbol: string; qty: number }> }) {
  const flow = useTradeFlowOptional();
  const pairGroupId = useMemo(() => uuid(), []);
  if (!flow || legs.length !== 2) return null;
  const actions: ActionInput[] = legs.map((l) => ({
    kind: 'close-position' as const,
    symbol: l.symbol,
    pairGroupId,
  }));
  return (
    <ExecuteControl
      scope={`close-both-${base}`}
      actions={actions}
      tone="red"
      label="Close both"
      lazyPreview
      // The actions embed a per-mount pairGroupId uuid, so ExecuteControl's
      // default intent identity (the serialized actions) changes every mount
      // and a persisted pending deal id could never be recovered after a
      // remount/reload — a lost-response retry would then mint a new id and
      // double-close. What actually identifies this intent is "close BOTH of
      // these legs in full": the contracts and the sizes being closed. The
      // group id stays in the actions (it only labels the closes as one
      // group); the server dedupes on the deal id alone.
      intentKey={['closeBoth', ...legs.map((l) => `${l.symbol}:${l.qty}`)].join('|')}
      buttonClassName="!py-1 !px-2.5"
    />
  );
}

export function PerpOnlyBox({
  group,
  stray = false,
  livePositions,
  cue,
  address,
  onTrack,
}: {
  group: ExposureGroup;
  /** Single unpaired leg (no delta-neutral pair yet). */
  stray?: boolean;
  /** symbol → live CrossexPosition (4s poll) for rows and actions. */
  livePositions?: Map<string, CrossexPosition>;
  cue: PerpOnlyCue;
  /** The tracked address (for the "no Boros position found" copy). */
  address?: string | null;
  /** Store a newly entered address (the add-address cue). */
  onTrack?: (address: string) => void;
}) {
  const [addressOpen, setAddressOpen] = useState(false);

  const columns: Column<ExposureLeg>[] = [
    {
      key: 'leg',
      header: 'Leg',
      render: (l) => (
        <span className="inline-flex items-center gap-2">
          <VenueChip exchange={l.exchange} crossex />
          <span className="text-[10px] uppercase tracking-wider text-ink-500">perp</span>
        </span>
      ),
    },
    { key: 'side', header: 'Side', render: (l) => <SideChip side={l.side} /> },
    { key: 'qty', header: 'Qty', align: 'right', render: (l) => <span className="num">{sig(l.qty)}</span> },
    {
      key: 'notional',
      header: 'Notional',
      align: 'right',
      render: (l) => <span className="num">{num(l.value)}</span>,
    },
    {
      key: 'upnl',
      header: 'uPnL',
      align: 'right',
      render: (l) => {
        const live = livePositions?.get(l.symbol);
        return live ? (
          <SignedNumber value={live.upnl} format={(n) => num(n)} />
        ) : (
          <span className="text-ink-600">—</span>
        );
      },
    },
  ];

  // Venue pair for the header, in StrategyCard's order: long side first. A
  // stray has one side only, and `⇄` is then omitted rather than pointing at
  // nothing.
  const longVenue = group.legs.find((l) => l.side === 'LONG')?.exchange ?? null;
  const shortVenue = group.legs.find((l) => l.side === 'SHORT')?.exchange ?? null;

  return (
    <div className="card p-4">
      {/* Identity in StrategyCard's grammar — WHAT · WHERE — so the same coin
          is the same object whether or not its Boros legs were matched. This
          box used to lead with a bare mono base and a row of green/red value
          chips (the ArbExposurePanel row it grew out of): a second visual
          language for a position that differs from a card only by what the
          feed could tell us about it. There is no maturity here, and that
          absence IS the position's defining fact — no rate is locked — so the
          slot the card gives maturity is given to the status chip instead. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="num flex h-6 w-6 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[9px] font-semibold leading-none text-ink-300"
            title={`${group.base} perp legs`}
          >
            {group.base}
          </span>
          {(longVenue || shortVenue) && (
            <>
              <span className="text-ink-600">·</span>
              <span className="text-sm font-medium text-ink-200">
                {prettyVenue(longVenue ?? shortVenue ?? '')}
                {longVenue && shortVenue && (
                  <>
                    <span className="mx-1 font-normal text-ink-500">⇄</span>
                    {prettyVenue(shortVenue)}
                  </>
                )}
              </span>
            </>
          )}
          <span className="text-ink-600">·</span>
          <span className="text-xs text-ink-300">no rate locked</span>
          {stray ? (
            <Chip sm tone="red">unpaired leg</Chip>
          ) : (
            <ExposureBadge group={group} />
          )}
        </div>
        {/* Right rail = ACTIONS, matching StrategyCard. `Close both` lived
            alone at the bottom of the box, the one action on the page that
            was not where every other card keeps its actions. */}
        {!stray && (
          <div className="flex items-center gap-2">
            <CloseBoth base={group.base} legs={group.legs} />
          </div>
        )}
      </div>
      <div className="num mt-1 text-xs text-ink-500">
        net <SignedNumber value={group.netValue} format={(n) => fmtUsd(n, 0)} /> · gross{' '}
        {fmtUsd(group.grossValue, 0)}
      </div>

      {/* Completion cue. */}
      {cue === 'add-address' && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
            <span aria-hidden className="text-ink-300">◈</span>
            {stray
              ? 'Pair this leg and lock its rate on Boros — track the address holding your Boros legs.'
              : "Lock this hedge's rate on Boros — track the address holding your Boros legs."}
            {!addressOpen && (
              <button type="button" className="btn-ghost-xs" onClick={() => setAddressOpen(true)}>
                Add Boros address
              </button>
            )}
          </div>
          {addressOpen && onTrack && (
            <AddressForm
              submitLabel="Track"
              onTrack={onTrack}
              onCancel={() => setAddressOpen(false)}
            />
          )}
        </div>
      )}
      {cue === 'execute-boros' && (
        /**
         * A settled feed that returned NOTHING for a coin holding live perps —
         * including no `BASE#perps` position, which the solver emits for
         * exactly this shape. So the two feeds disagree, and the honest thing
         * is to say so rather than to act certain.
         *
         * This used to be a link-out to boros.finance ("Execute the fixed legs
         * on Boros ↗"), from the era before the terminal could open Boros legs
         * itself. Two reasons it is gone rather than rewired to the wizard: it
         * sent the user out of the app to size a hedge by hand that the app now
         * sizes for them, and this box is the DEGRADED path — when the feed is
         * healthy the position renders as a StrategyCard, which already offers
         * "Open the Boros legs →". Putting a second, competing entry point here
         * would arm a trade off a book we just said we cannot read.
         */
        <div className="mt-2 text-xs text-ink-400">
          No Boros position found for {group.base}
          {address ? ` on ${short(address)}` : ''} — this pair's funding rate is NOT locked. If you
          hold Boros legs for it, the strategy feed and the positions feed disagree; reload, and
          check the address is the one holding them.
        </div>
      )}
      {cue === 'boros-pending' && (
        <div className="mt-2 animate-pulse text-xs text-ink-500">matching Boros legs…</div>
      )}

      <div className="mt-3">
        <DataTable
          columns={columns}
          rows={group.legs}
          rowKey={(l) => l.symbol}
          renderExpanded={(l) => (
            <PerpLegExpanded position={livePositions?.get(l.symbol) ?? null} />
          )}
        />
      </div>
    </div>
  );
}

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
}: {
  base: string;
  /** `partial`: close exactly `qty` rather than the whole venue position —
   * a pair's attributed share of a leg two pairs sit on. */
  legs: Array<{ symbol: string; qty: number; venue: string; partial?: boolean }>;
  /** symbol → live position, for the uPnL each close realises. */
  livePositions?: Map<string, CrossexPosition>;
}) {
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
          ...(l.partial || Math.min(qtyNum, l.qty) < l.qty - Math.max(1e-9, l.qty * 1e-7)
            ? { qty: String(Math.min(qtyNum, l.qty)) }
            : {}),
        }))
      : null;
  // Not lazy: the dialog exists to show this, so it loads with the form.
  const preview = usePreviewDebounced(`close-pair-${base}`, actions, {
    refetchInterval: 5000,
  });
  if (!flow || legs.length !== 2) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* One size, both legs, capped at this pair's allocation — see
          maxCloseQty. Defaults to the whole allocation, so leaving it alone
          closes the pair exactly as before. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-xs text-ink-400">
          <label htmlFor={`close-pair-qty-${base}`}>Close size</label>
          {/* The ceiling — this pair's own allocation — stated where the
              number is typed, and clickable. */}
          <span className="num">
            max{' '}
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-ink-200"
              title="Close this pair's whole allocation on both legs"
              onClick={() => setQtyEdited(fieldValue(maxCloseQty))}
            >
              {sig(maxCloseQty)} {base}
            </button>
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <input
            id={`close-pair-qty-${base}`}
            className={`input num h-7 flex-1 px-2 py-0.5 ${qtyInvalid ? '!border-rose-500/60' : ''}`}
            inputMode="decimal"
            value={qtyStr}
            onChange={(e) => setQtyEdited(e.target.value)}
            aria-label="Close size, applied to both legs"
          />
          <span className="text-ink-500">{base}</span>
        </div>
      </div>
      {qtyInvalid && (
        <span className="text-[11px] text-rose-300">
          size must be above 0 and at most {sig(maxCloseQty)} {base}
        </span>
      )}
      <ClosePreviewPanel
        previews={preview.previews}
        estimating={preview.estimating}
        isError={preview.isError}
        error={preview.error}
        labelFor={(_p, i) => prettyVenue(legs[i]?.venue ?? '')}
        realizedFor={(p, i) => {
          const live = livePositions?.get(legs[i]?.symbol ?? '');
          if (!live) return null;
          // A partial close realises only its slice of the position's uPnL:
          // scale by the close qty the resolver actually stamped over what
          // the venue holds. A whole close is the ratio 1.
          const held = Math.abs(Number(live.positionQty));
          const closing = Number(p.qty);
          const frac = held > 0 && Number.isFinite(closing) ? Math.min(1, closing / held) : 1;
          return Number(live.upnl) * frac;
        }}
        /**
         * ⚠ Accurate for a PAIR, which is not what the single-leg note says.
         *
         * Only the first leg carries the mid ± slippage band; the hedge leg
         * is sent as a plain MARKET IOC on purpose, because a book-mid limit
         * band cannot reliably stay inside the venue's OWN price-limit band
         * and gets rejected — which would leave the first leg closed and the
         * second still open (see decide.ts). Claiming the band covers both
         * would promise protection the hedge leg does not have.
         */
        note="The first leg is a reduce-only IOC limit at mid ± slippage; the hedge leg is sent at market, inside the venue's own price band. Neither can increase a position or rest on the book."
        hedgeAtMarket
      />
      {/* A plain input, deliberately NOT the Est./Max disclosure the Boros and
          single-leg closes use: the preview above already prints each leg's
          own slippage on its own row, so an "Est." summary here would restate
          a number the user is already looking at. */}
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor={`close-pair-slip-${base}`} className="w-24 text-ink-400">
          Slippage %
        </label>
        <input
          id={`close-pair-slip-${base}`}
          className={`input num h-8 flex-1 px-2 py-1 ${slipInvalid ? 'border-rose-500' : ''}`}
          inputMode="decimal"
          value={slipStr}
          onChange={(e) => setSlipStr(e.target.value)}
        />
      </div>
      {slipInvalid && (
        <span className="text-xs text-rose-400">slippage must be in (0, 10]</span>
      )}
      <ExecuteControl
        scope={`close-both-${base}`}
        actions={actions}
        tone="red"
        label="Close both ▸"
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
        intentKey={['closeBoth', String(slip), qtyStr, ...legs.map((l) => `${l.symbol}:${l.qty}`)].join('|')}
        buttonClassName="w-full"
        // The panel above already reviews this close; the hover card would
        // repeat it on top of the dialog. Errors still surface.
        hoverCard={false}
      />
    </div>
  );
}
