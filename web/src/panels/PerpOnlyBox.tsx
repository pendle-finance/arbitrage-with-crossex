/**
 * An incomplete 4-leg position box: a delta-neutral perp pair (or a stray
 * single leg) with NO Boros legs for its base. Absorbs the old ArbExposurePanel
 * row (LegChips, ExposureBadge, Close both) into the box form, and adds the
 * cue that completes the position:
 *   - no tracked address        → inline AddressForm ("lock this rate on Boros")
 *   - address + settled feed    → "execute the fixed legs on Boros ↗" link-out
 *   - strategy feed pending/err → neutral note, never a false "no Boros" claim
 */
import { useMemo, useState } from 'react';
import type { ActionInput, CrossexPosition, ExposureGroup, ExposureLeg } from '../api/types';
import { Chip } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { ExposureBadge } from '../components/ExposureBadge';
import { SignedNumber } from '../components/SignedNumber';
import { SideChip, VenueChip } from '../components/VenueChip';
import { fmtUsd, num, prettyVenue, sig } from '../lib/fmt';
import { uuid } from '../lib/uuid';
import { ExecuteControl } from '../trade/ExecuteControl';
import { ClosePreviewPanel } from '../trade/previewBits';
import { usePreviewDebounced } from '../trade/usePreview';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { AddressForm, short } from './HomeControls';
import { PerpLegExpanded } from './PerpLegExpanded';

/** Which completion cue the box shows (decided by PositionsHome). */
export type PerpOnlyCue = 'add-address' | 'execute-boros' | 'boros-pending' | null;

/** One leg = "+BINANCE $9,387" (green) / "−HYPERLIQUID $9,389" (red), with a
 * small quote sub-label when the venue doesn't quote USDT. */
function LegChip({ leg }: { leg: ExposureLeg }) {
  const long = leg.side === 'LONG';
  return (
    <Chip sm tone={long ? 'green' : 'red'} className="num" title={leg.symbol}>
      {long ? '+' : '−'}
      {leg.exchange} {fmtUsd(leg.value, 0)}
      {leg.quote !== 'USDT' && <span className="text-[9px] opacity-70">{leg.quote}</span>}
    </Chip>
  );
}

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

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-ink-100">{group.base}</span>
          <span className="inline-flex flex-wrap gap-1.5">
            {group.legs.map((l) => (
              <LegChip key={l.symbol} leg={l} />
            ))}
          </span>
          <span className="num text-xs text-ink-500">
            net <SignedNumber value={group.netValue} format={(n) => fmtUsd(n, 0)} /> · gross{' '}
            {fmtUsd(group.grossValue, 0)}
          </span>
        </div>
        <span className="inline-flex items-center gap-2">
          {stray && <Chip sm tone="red">unpaired leg</Chip>}
          <ExposureBadge group={group} />
        </span>
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
        <div className="mt-2 text-xs text-ink-400">
          No Boros position found for {group.base}
          {address ? ` on ${short(address)}` : ''} — this pair's funding rate is NOT locked.{' '}
          <a
            href="https://boros.finance"
            target="_blank"
            rel="noreferrer"
            className="text-cyan-400 hover:text-cyan-300"
          >
            Execute the fixed legs on Boros ↗
          </a>
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

      {!stray && (
        <div className="mt-2 flex justify-end">
          <CloseBoth base={group.base} legs={group.legs} />
        </div>
      )}
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
  legs: Array<{ symbol: string; qty: number; venue: string }>;
  /** symbol → live position, for the uPnL each close realises. */
  livePositions?: Map<string, CrossexPosition>;
}) {
  const flow = useTradeFlowOptional();
  const pairGroupId = useMemo(() => uuid(), []);
  const actions: ActionInput[] =
    legs.length === 2
      ? legs.map((l) => ({ kind: 'close-position' as const, symbol: l.symbol, pairGroupId }))
      : [];
  // Not lazy: the dialog exists to show this, so it loads with the form.
  const preview = usePreviewDebounced(`close-pair-${base}`, actions.length ? actions : null, {
    refetchInterval: 5000,
  });
  if (!flow || legs.length !== 2) return null;

  return (
    <div className="flex flex-col gap-3">
      <ClosePreviewPanel
        previews={preview.previews}
        estimating={preview.estimating}
        isError={preview.isError}
        error={preview.error}
        labelFor={(_p, i) => prettyVenue(legs[i]?.venue ?? '')}
        realizedFor={(_p, i) => {
          const live = livePositions?.get(legs[i]?.symbol ?? '');
          return live ? Number(live.upnl) : null;
        }}
        note="The close is sent as a reduce-only IOC limit at mark ± slippage — it can never increase the position and never rests on the book."
      />
      <ExecuteControl
        scope={`close-both-${base}`}
        actions={actions}
        tone="red"
        label="Close both ▸"
        // See CloseBoth: the per-mount pairGroupId would otherwise change the
        // intent identity on every remount and break idempotent recovery.
        intentKey={['closeBoth', ...legs.map((l) => `${l.symbol}:${l.qty}`)].join('|')}
        buttonClassName="w-full"
        // The panel above already reviews this close; the hover card would
        // repeat it on top of the dialog. Errors still surface.
        hoverCard={false}
      />
    </div>
  );
}
