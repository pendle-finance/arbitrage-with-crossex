/**
 * Header controls for the 4-leg home view (moved from the old StrategyPanel):
 * the tracked-address chip / AddressForm, the APR-clock control (now showing
 * the basis DATE), freshness, and the totals
 * strip. PositionsHome owns all state; everything here is presentational.
 * (The exit toggles moved into each StrategyCard — per-position, not global.)
 */
import { useId, useState, type FormEvent } from 'react';
import type { CapitalBasis, StrategyReturns } from '../api/types';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { SignedNumber } from '../components/SignedNumber';
import { fmtUsd } from '../lib/fmt';
import { readJson } from '../lib/storage';
import { applyCostFlags, type CostFlags } from './strategyMath';

export const STRATEGY_STORAGE_KEY = 'crossex.strategy.v1';
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface Stored {
  address: string | null;
  /**
   * Custom APR-clock start (unix seconds), PER WALLET — absent = default
   * (Boros open).
   *
   * ⚠ Not a single value. The clock anchors on when the Boros legs locked the
   * spread, which is a fact about one wallet's book; as a scalar it survived a
   * switch and measured the new book's realized return from the old book's
   * start date. Keyed by the wallet rather than the whole book id, so rotating
   * a Gate API key does not throw the override away.
   */
  sinceByAddress: Record<string, number>;
  /** How much capital a Boros position is said to tie up. Persisted (not
   * per-card session state) because it describes the ACCOUNT — whether that
   * collateral is dedicated to these positions — not a way of viewing one. */
  capitalBasis: CapitalBasis;
}

/** Read the persisted shape (legacy exit-flag keys are ignored — the exit
 * toggles are per-position now, owned by each StrategyCard). */
export function loadStored(): Stored {
  return readJson<Stored>(
    STRATEGY_STORAGE_KEY,
    { address: null, sinceByAddress: {}, capitalBasis: 'im' },
    (parsed) => {
      const p = parsed as {
        address?: unknown;
        since?: unknown;
        sinceByAddress?: unknown;
        capitalBasis?: unknown;
      } | null;
      const address =
        typeof p?.address === 'string' && EVM_ADDRESS_RE.test(p.address) ? p.address : null;
      const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

      const sinceByAddress: Record<string, number> = {};
      const raw = p?.sinceByAddress;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (ok(v)) sinceByAddress[k.toLowerCase()] = v;
        }
      }
      // A scalar `since` was written before the override was per-wallet. It
      // belonged to whichever address was tracked at the time, which is the
      // one stored beside it — so it migrates there rather than being applied
      // to every book the user opens next.
      if (ok(p?.since) && address) sinceByAddress[address.toLowerCase()] ??= p.since;

      // Anything but the explicit opt-in reads as the default, so a payload
      // written by an older build keeps the numbers it was showing.
      // Defaults to 'im' (margin used): the posted balance over-states capital
      // whenever the collateral account is shared with other trading, which
      // makes every APR on the page read lower than the trade actually earns.
      const capitalBasis: CapitalBasis = p?.capitalBasis === 'balance' ? 'balance' : 'im';
      return { address, sinceByAddress, capitalBasis };
    },
  );
}

export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** Unix seconds → the local-time value a <input type="datetime-local"> wants. */
function toLocalInput(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AddressForm({
  initial,
  submitLabel,
  onTrack,
  onCancel,
  full = false,
}: {
  initial?: string;
  submitLabel: string;
  onTrack: (address: string) => void;
  onCancel?: () => void;
  /** Fill the container instead of centring at a fixed width — for the narrow
   * settings drawer, where the fixed w-96 input would overflow. */
  full?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(initial ?? '');
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const valid = EVM_ADDRESS_RE.test(trimmed);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) onTrack(trimmed);
  };

  return (
    <form onSubmit={submit} className={`flex flex-col gap-2 ${full ? 'items-stretch' : 'items-center'}`}>
      <div className={`flex items-center gap-2 ${full ? 'w-full' : ''}`}>
        <label htmlFor={id} className="sr-only">
          EVM address
        </label>
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`input num font-mono ${full ? 'min-w-0 flex-1' : 'w-96 max-w-full'} ${
            touched && !valid ? 'border-rose-500/60' : ''
          }`}
        />
        <button type="submit" className="btn-primary" disabled={touched && !valid}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn-ghost-xs" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {touched && !valid && (
        <div className="text-xs text-rose-400">
          That doesn't look like an EVM address (expected 0x followed by 40 hex characters).
        </div>
      )}
    </form>
  );
}

/** "⟳ 8s ago" ticking freshness for the strategy query (amber on stale error). */
export function StrategyFreshness({
  dataUpdatedAt,
  staleError,
  onRefetch,
}: {
  dataUpdatedAt: number;
  staleError: boolean;
  onRefetch: () => void;
}) {
  return (
    <FreshnessButton
      dense
      dataUpdatedAt={dataUpdatedAt}
      staleError={staleError}
      title="Refetch strategy data"
      onRefetch={onRefetch}
    />
  );
}

/** Compact totals strip shown when the address runs more than one strategy.
 * Covers the Boros-tracked strategies only — perp-only boxes are not in the
 * server totals. Exit parts re-derived per the checked flags. */
const FLAGS_ON: CostFlags = { inclExitFees: true, inclExitSlippage: true, inclEntryCost: true };

export function TotalsStrip({ data }: { data: StrategyReturns }) {
  const flags = FLAGS_ON; // totals always include known future exit costs
  const { totals } = data;
  // The same population the server summed the totals over: the arb book.
  // Unhedged cards render beside it but are not Boros-tracked returns.
  const strategies = data.strategies.filter((s) => s.attribution.source !== 'unhedged');
  const weightedElapsed =
    totals.capitalUsd > 0
      ? strategies.reduce((s, x) => s + x.capitalUsd * (x.elapsedSeconds ?? 0), 0) / totals.capitalUsd
      : null;
  const { expectedUsd } = applyCostFlags({
    flags,
    perpExitFeesUsd: totals.perpExitFeesTotalUsd,
    perpExitSlippageUsd: totals.perpExitSlippageTotalUsd,
    // The totals payload carries no PAID perp entry breakdown, and it never
    // needs one: the entry cost is always included here, so the add-back is 0.
    perpEntryFeesUsd: 0,
    perpEntrySlippageUsd: null,
    realizedPnlUsd: totals.realizedPnlUsd,
    realizedApr: totals.realizedApr,
    expectedPnlToMaturityUsd: totals.expectedPnlToMaturityUsd,
    capitalUsd: totals.capitalUsd,
    elapsedSeconds: weightedElapsed,
  });
  // Honesty guards: the server sums per-strategy projections with null→0, and
  // null exit totals fold in as 0 — mark both cases instead of implying exact.
  const anyProjection = strategies.some((s) => s.expectedPnlToMaturityUsd !== null);
  const exitUnknown =
    (flags.inclExitFees && totals.perpExitFeesTotalUsd === null) ||
    (flags.inclExitSlippage && totals.perpExitSlippageTotalUsd === null);
  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 text-sm">
      <span className="text-[10px] uppercase tracking-wider text-ink-500">
        Boros-tracked totals
      </span>
      <span className="text-ink-400">
        Current PnL{' '}
        <SignedNumber value={totals.realizedPnlUsd} format={(n) => fmtUsd(n)} className="font-medium" />
      </span>
      {/* No "Realized APR" here, deliberately.
       *
       * It was aggregate realized PnL over capital, extrapolated to a year:
       * × (SECONDS_IN_YEAR / weightedElapsed), with no floor on how short that
       * window could be. At 13 hours that multiplies by ~674 and at 2 hours by
       * ~4380, so a few cents of funding noise on a small base rendered as a
       * three-digit APR that moved on every poll. Two independent UX testers
       * named it the fastest way to distrust every other number on the page.
       *
       * Removed rather than floored: a run of hours cannot be annualized into
       * anything a trader can act on, so there is no window at which the figure
       * becomes meaningful enough to keep. `Current PnL` is the honest version
       * of the same question, and the per-card FIXED APY — suppressed until
       * every leg is in place — is the honest version of the rate one.
       */}
      <span className="text-ink-400">
        Capital <span className="num font-medium text-ink-100">{fmtUsd(totals.capitalUsd, 0)}</span>
      </span>
      <span className="text-ink-400">
        Est. by maturity{' '}
        {expectedUsd === null || !anyProjection ? (
          <span className="num" title="No strategy has a known start — nothing to project">
            —
          </span>
        ) : (
          <SignedNumber value={expectedUsd} format={(n) => fmtUsd(n, 0)} className="font-medium" />
        )}
        {exitUnknown && (
          <span
            className="text-amber-400"
            title="Some strategies' perp exit costs are unknown (fee schedule unavailable) — they are NOT included here even though the checkbox is on; the per-box numbers that can include them do."
          >
            *
          </span>
        )}
      </span>
    </div>
  );
}

/** The "Boros position open ✎" label under the timeline's start date. The ✎
 * opens an inline editor for a custom strategy-start override; Default
 * restores the Boros-open anchor. The override anchors the spread-lock
 * assumption AND the realized-APR window. */
export function TimelineClockEdit({
  since,
  basis,
  onChange,
}: {
  since: number | null;
  basis: 'boros-open' | 'perp-open' | 'custom' | null;
  onChange?: (since: number | null) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);

  const label =
    since || basis === 'custom'
      ? 'custom start'
      : basis === 'perp-open'
        ? 'perp position open'
        : 'Boros position open';

  const apply = () => {
    const sec = Math.floor(new Date(draft).getTime() / 1000);
    if (!Number.isFinite(sec) || sec <= 0 || sec >= Math.floor(Date.now() / 1000)) {
      setBad(true);
      return;
    }
    onChange?.(sec);
    setOpen(false);
  };

  return (
    <span className="flex flex-wrap items-center gap-1 text-ink-600">
      <span title="Start of the strategy clock: the spread-lock assumption and the realized-APR window both run from here. Default: when the Boros legs opened.">
        {label}
      </span>
      {onChange && (
        <button
          type="button"
          aria-label="Edit the strategy start"
          title="Edit the strategy start"
          className="rounded px-0.5 leading-none text-ink-500 transition-colors hover:text-ink-200"
          onClick={() => {
            setDraft(since ? toLocalInput(since) : '');
            setBad(false);
            setOpen((v) => !v);
          }}
        >
          ✎
        </button>
      )}
      {open && (
        <span className="flex items-center gap-1">
          <label htmlFor={id} className="sr-only">
            APR clock start
          </label>
          <input
            id={id}
            type="datetime-local"
            className={`input px-1 py-0.5 text-xs ${bad ? 'border-rose-500/60' : ''}`}
            value={draft}
            max={toLocalInput(Math.floor(Date.now() / 1000))}
            onChange={(e) => {
              setDraft(e.target.value);
              setBad(false);
            }}
          />
          <button type="button" className="btn-ghost-xs" onClick={apply}>
            Apply
          </button>
          <button
            type="button"
            className="btn-ghost-xs"
            title="Reset to the default (earliest Boros leg open)"
            onClick={() => {
              onChange?.(null);
              setOpen(false);
            }}
          >
            Default
          </button>
        </span>
      )}
    </span>
  );
}
