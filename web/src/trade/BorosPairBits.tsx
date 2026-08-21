/**
 * Presentational pieces of the Boros two-leg market ticket. The container
 * (BorosPairTicket) owns all state; nothing here fetches or decides.
 *
 * Two rules this file exists to enforce:
 *  - No gross spread. Every spread rendered here comes from the simulation's
 *    NET fields; there is no pre-cost number to render even by accident.
 *  - The worst case leads. It is the number the slippage control exists to
 *    produce, so it gets the emphasis and the estimate sits under it.
 */
import type { ReactNode } from 'react';
import type {
  BorosLegDirection,
  BorosLegFill,
  BorosPairBlocker,
  BorosPairMarketRow,
  BorosPairResult,
  BorosPairSimulation,
  BorosSimulatedLeg,
} from '../api/types';
import { Chip } from '../components/Chip';
import { fmtDateUtc, fmtPct, fmtUsd, prettyVenue } from '../lib/fmt';

/**
 * Tolerances are quoted in BASIS POINTS OF APR — an absolute distance in rate
 * space, so 25bp means the same give-up on a 3% book as on a 30% one.
 *
 * Deliberately NOT called "ticks". Boros has its own tick concept and it is a
 * different quantity: a protocol tick index is EXPONENTIAL in rate
 * (`rate = 1.00005 ^ (tickIndex × tickStep) − 1`), whereas the order book is
 * served to us pre-bucketed linearly at `?tickSize=0.0001`. Labelling this
 * control "ticks" would invite a reader to equate the two. The rate leaves here
 * as an APR fraction and the SDK does any tick conversion at the boundary.
 */
export const APR_BP = 0.0001;

/** Mirrors MIN_GAS_BALANCE_USD in src/core/boros/pair.ts. */
const MIN_GAS_USD = 10;

/** USD at a precision that suits the amount. A whole-dollar format reads a
 * real $0.45 of margin as "$0", which is the same "it will do nothing"
 * impression the collateral columns used to give. */
const usdAt = (n: number): string => fmtUsd(n, Math.abs(n) < 100 ? 2 : 0);

export const bpToApr = (bp: number): number => bp * APR_BP;
export const aprToBp = (apr: number): number => Math.round(apr / APR_BP);

/** APR fraction → "4.50%". Rates here are always fractions, never percent. */
const pct = (v: number | null | undefined, dp = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : fmtPct(v, dp);

/**
 * A collateral quantity, scaled to its own magnitude.
 *
 * NEVER a fixed number of decimals: an eligible pair's collateral can be USDT
 * (positions in the thousands) or ETH/BTC (positions in hundredths), and a `0`
 * or `2` dp that reads fine for the first turns every ETH-collateralised number
 * on this panel into "0" — a ticket that looks like it will do nothing.
 *
 * Also NOT `fmtTokenQty`, despite the overlap: that abbreviates (150,500 →
 * "151k"), and these columns exist so the user can check that two legs end up
 * MATCHED. Rounding away the digits that differ defeats the readout. Full
 * digits at every scale, precision scaled to magnitude, floored at
 * "<0.000001". The symbol is dropped — the column header carries it.
 */
const size = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs > 0 && abs < 1e-6) return '<0.000001';
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 2 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
};

const DIRECTION_LABEL: Record<BorosLegDirection, string> = {
  short: 'Receive fixed',
  long: 'Pay fixed',
};

export function DirectionToggle({
  value,
  onChange,
  idPrefix,
}: {
  value: BorosLegDirection;
  onChange: (d: BorosLegDirection) => void;
  idPrefix: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={`${idPrefix} direction`}>
      {(['short', 'long'] as const).map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          data-active={value === d}
          className="seg-btn"
          onClick={() => onChange(d)}
        >
          {DIRECTION_LABEL[d]}
        </button>
      ))}
    </div>
  );
}

/**
 * Market picker. Ineligible markets stay in the list, disabled, WITH the reason
 * — §2 is explicit that they are never hidden: a market that has quietly
 * vanished reads as "not listed", which sends the user hunting instead of
 * telling them their two legs share neither collateral nor maturity.
 */
export function MarketSelect({
  id,
  label,
  value,
  markets,
  reasonFor,
  onPick,
  disabled,
}: {
  id: string;
  label: string;
  value: number | null;
  markets: BorosPairMarketRow[];
  /** null = selectable; a string = why this market cannot pair with the other leg. */
  reasonFor: (m: BorosPairMarketRow) => string | null;
  onPick: (marketId: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-ink-400">
        {label}
      </label>
      <select
        id={id}
        className="input"
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">select a market…</option>
        {markets.map((m) => {
          const reason = reasonFor(m);
          return (
            <option key={m.marketId} value={m.marketId} disabled={reason !== null}>
              {m.name}
              {reason ? ` — ${reason}` : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function Row({ label, value, title }: { label: ReactNode; value: ReactNode; title?: string }) {
  return (
    <div className="flex items-center justify-between text-[11px] text-ink-400">
      <span title={title}>{label}</span>
      <span className="num text-ink-200">{value}</span>
    </div>
  );
}

const BOOK_NOTE: Record<BorosSimulatedLeg['bookStatus'], string | null> = {
  ok: null,
  'insufficient-depth': 'book too thin at this size',
  unavailable: 'book unavailable',
  'not-fetched': null,
};

/** §3's per-leg table: executed rate, fill size, margin. */
export function LegSimTable({ sim }: { sim: BorosPairSimulation }) {
  const legs: Array<[string, BorosSimulatedLeg]> = [
    ['Leg A', sim.legA],
    ['Leg B', sim.legB],
  ];
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950 p-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2.5 gap-y-1 text-[11px]">
        <span className="text-ink-500" />
        <span className="text-right text-ink-500">Est. APR</span>
        <span className="text-right text-ink-500">Est. fill</span>
        <span className="text-right text-ink-500">Margin</span>
        {legs.map(([label, leg]) => (
          <LegSimRow key={label} label={label} leg={leg} collateral={sim.collateral} />
        ))}
      </div>
    </div>
  );
}

function LegSimRow({
  label,
  leg,
  collateral,
}: {
  label: string;
  leg: BorosSimulatedLeg;
  collateral: string;
}) {
  const note = BOOK_NOTE[leg.bookStatus];
  return (
    <>
      <span className="min-w-0 truncate text-ink-300" title={leg.marketName}>
        {label} · {prettyVenue(leg.venue)}
        {note && <span className="ml-1 text-amber-400">({note})</span>}
      </span>
      <span className="num text-right text-ink-200">{pct(leg.execApr)}</span>
      <span className="num text-right text-ink-200">
        {size(leg.estFillSize)}
        {leg.shortfallSize > 0 && (
          <span className="ml-1 text-amber-400" title={`${size(leg.shortfallSize)} ${collateral} short`}>
            ▾
          </span>
        )}
      </span>
      {/* Per leg, never as one figure: the per-market margin floors differ, so
          a single total hides which leg is actually expensive. */}
      <span className="num text-right text-ink-200">{size(leg.marginRequired)}</span>
    </>
  );
}

/**
 * The two spread numbers. Worst case leads — it is what the slippage control
 * produces, and it moves live as the tolerance changes.
 */
export function SpreadReadout({ sim }: { sim: BorosPairSimulation }) {
  const worst = sim.worstSpreadApr;
  const est = sim.estSpreadApr;
  const negative = worst !== null && worst < 0;
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        negative ? 'border-rose-500/25 bg-rose-500/5' : 'border-cyan-500/25 bg-cyan-500/5'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wider text-ink-300">Worst-case spread</span>
        <span className={`num text-lg font-semibold ${negative ? 'text-rose-300' : 'text-cyan-300'}`}>
          {pct(worst)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between">
        <span className="text-[11px] text-ink-400">Estimated spread</span>
        <span className="num text-[12.5px] text-ink-200">{pct(est)}</span>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-400">
        Both net of Boros taker and settlement fees ({pct(sim.feeDragApr)} APR combined). Worst case
        assumes <em>both</em> legs use their full tolerance at once — they cross in opposite
        directions, so the two give-ups add.
      </p>
      {/* §3's second warning box: the bound is on price, not on size. */}
      <p className="mt-1 text-[10.5px] leading-relaxed text-amber-400/90">
        Slippage bounds the rate, not the fill. This is what you get <em>if</em> both legs fill — a
        leg that cannot fill inside its tolerance simply stops filling.
      </p>
    </div>
  );
}

/** §4's arithmetic, per leg. We show it; we do not do it for the user. */
export function PositionArithmetic({ sim }: { sim: BorosPairSimulation }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950 p-2.5">
      <div className="mb-1 text-[10.5px] uppercase tracking-wider text-ink-500">
        Position ({sim.collateral})
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2.5 gap-y-1 text-[11px]">
        <span className="text-ink-500" />
        <span className="text-right text-ink-500">Current</span>
        <span className="text-right text-ink-500">Trade</span>
        <span className="text-right text-ink-500">Resulting</span>
        {([['Leg A', sim.legA], ['Leg B', sim.legB]] as const).map(([label, leg]) => (
          <PositionRow key={label} label={label} leg={leg} />
        ))}
      </div>
      {/* Boros nets to ONE position per (account, market): these rows describe
          the account's whole exposure in that market, not this ticket's slice. */}
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-500">
        Your whole netted position in each market — not just the part this ticket opens.
      </p>
    </div>
  );
}

/** fmtTokenQty already carries a minus; only the plus needs adding. */
const signedSize = (n: number): string => `${n > 0 ? '+' : ''}${size(n)}`;

function PositionRow({ label, leg }: { label: string; leg: BorosSimulatedLeg }) {
  const s = leg.sizing;
  return (
    <>
      <span className="min-w-0 truncate text-ink-300" title={leg.marketName}>
        {label} · {prettyVenue(leg.venue)}
      </span>
      <span className="num text-right text-ink-300">{signedSize(s.currentSize)}</span>
      <span className="num text-right text-ink-200">{signedSize(s.deltaSize)}</span>
      <span
        className={`num text-right font-medium ${s.opposing ? 'text-amber-300' : 'text-ink-100'}`}
      >
        {signedSize(s.resultingSize)}
      </span>
    </>
  );
}

/** Pair-level costs. Kept apart from the per-leg margins on purpose (§3). */
export function PairCosts({
  sim,
  gasBalanceUsd,
}: {
  sim: BorosPairSimulation;
  /** Prepaid relayer gas, USD. Shown because it is a SEPARATE pot from
   * collateral: a "top up to trade" refusal is otherwise indistinguishable
   * from a margin problem, and the user cannot tell whether a top-up landed. */
  gasBalanceUsd?: number | null;
}) {
  const usd = (n: number | null) =>
    n === null || sim.collateralPriceUsd === null ? null : n * sim.collateralPriceUsd;
  const marginUsd = usd(sim.marginRequiredTotal);
  return (
    <div className="flex flex-col gap-0.5">
      <Row
        label="Cost to cross"
        title="Boros taker fee on both legs at this size, over the time to maturity"
        value={`${size(sim.costToCrossSize)} ${sim.collateral}`}
      />
      <Row
        label="Margin required (both legs)"
        title="Sum of the per-leg initial margins above — the legs' own numbers are what each bucket must carry"
        value={
          sim.marginRequiredTotal === null
            ? '—'
            : `${size(sim.marginRequiredTotal)} ${sim.collateral}${
                marginUsd !== null ? ` (≈ ${usdAt(marginUsd)})` : ''
              }`
        }
      />
      {gasBalanceUsd !== null && gasBalanceUsd !== undefined && (
        <Row
          label="Prepaid gas"
          title="Relayer gas held by Boros, separate from your trading collateral — topped up with payTreasury, not by depositing margin"
          value={
            <span className={gasBalanceUsd < MIN_GAS_USD ? 'text-amber-400' : undefined}>
              {fmtUsd(gasBalanceUsd, 2)}
            </span>
          }
        />
      )}
      <Row
        label="Maturity"
        value={fmtDateUtc(Math.floor(Date.now() / 1000) + sim.secondsToMaturity)}
      />
    </div>
  );
}

/** Confirm blockers, each with its own remediation where one exists (§6). */
export function BlockerList({
  blockers,
  collateral,
  onCancelAndClose,
  busyMarketId,
}: {
  blockers: BorosPairBlocker[];
  collateral: string;
  onCancelAndClose?: (marketId: number) => void;
  /** marketId currently being remediated, so its button can show progress. */
  busyMarketId?: number | null;
}) {
  if (blockers.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {blockers.map((b, i) => (
        <li
          key={`${b.code}-${b.leg ?? ''}-${i}`}
          className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200"
        >
          {b.message}
          {b.shortfall !== undefined && (
            <span className="mt-0.5 block text-ink-400">
              Short {size(b.shortfall)} {collateral} — that is the top-up, not the total
              requirement.
            </span>
          )}
          {b.code === 'isolated-must-switch' && onCancelAndClose && b.marketId !== undefined && (
            <button
              type="button"
              className="mt-1.5 rounded border border-rose-400/50 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-500/15 disabled:opacity-50"
              disabled={busyMarketId === b.marketId}
              onClick={() => onCancelAndClose(b.marketId as number)}
            >
              {busyMarketId === b.marketId ? 'Working…' : 'Cancel orders & close position'}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** §5's report: what filled, the realised spread, and the residual. */
export function PairResultReport({
  result,
  collateral,
  onComplete,
  onRetry,
  onDismiss,
  busy,
}: {
  result: BorosPairResult;
  collateral: string;
  onComplete: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const tone = result.partial ? 'amber' : 'green';
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        result.partial ? 'border-amber-500/30 bg-amber-500/[0.04]' : 'border-emerald-500/25 bg-emerald-500/5'
      }`}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip sm tone={tone}>
          {result.partial ? 'partially filled' : 'filled'}
        </Chip>
        <span className="text-[12px] text-ink-200">
          {size(result.hedgedSize)} {collateral} hedged
        </span>
        {result.realisedSpreadApr !== null && (
          <span className="num text-[12px] text-ink-100">at {pct(result.realisedSpreadApr)}</span>
        )}
      </div>

      <div className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-ink-300">
        <LegFillLine label="Leg A" fill={result.legA} collateral={collateral} />
        <LegFillLine label="Leg B" fill={result.legB} collateral={collateral} />
      </div>

      {result.unhedgedSize > 0 && (
        // The one thing a delta-neutral terminal must never bury.
        <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
          {size(result.unhedgedSize)} {collateral} on leg {result.unhedgedLeg} is unhedged — that
          size is directional until you complete or close it.
        </p>
      )}

      {result.partial ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {/* Never automatic: this is the user re-issuing at a tolerance they
              pick, which is why it routes back through the ticket. */}
          <button
            type="button"
            disabled={busy}
            onClick={onComplete}
            className="rounded border border-cyan-500/50 px-2 py-0.5 text-[11px] text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-50"
          >
            Complete now at market
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-400 disabled:opacity-50"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-400"
          >
            Leave it
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-400"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Failure copy per code — each points at a genuinely different fix (§7). */
const FAILURE_LABEL: Record<NonNullable<BorosLegFill['failure']>['code'], string> = {
  'insufficient-depth': 'not enough depth',
  'rate-deviation': 'rate-deviation guard',
  'insufficient-margin': 'not enough margin',
  rejected: 'rejected',
  unknown: 'no confirmation',
};

function LegFillLine({
  label,
  fill,
  collateral,
}: {
  label: string;
  fill: BorosLegFill;
  collateral: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-400">
          {label} · {DIRECTION_LABEL[fill.direction].toLowerCase()}
        </span>
        <span className="num text-ink-200">
          {size(fill.filledSize)} {collateral}
          {fill.execApr !== null && ` @ ${pct(fill.execApr)}`}
          {fill.failure && (
            <span className="ml-1.5 text-amber-400">{FAILURE_LABEL[fill.failure.code]}</span>
          )}
        </span>
      </div>
      <FailureDetail fill={fill} />
    </div>
  );
}

/** What to DO about each failure. Mirrors `legFailureHint` in
 * src/core/boros/orders.ts — each code points at a different fix. */
const FAILURE_HINT: Record<NonNullable<BorosLegFill['failure']>['code'], string> = {
  'insufficient-depth':
    'The book ran out inside your rate bound. Trade a smaller size, or widen the tolerance and re-issue.',
  'rate-deviation':
    'The chain refused the rate as too far from mark. Widening your tolerance will not help — wait for the mark to move.',
  'insufficient-margin': 'That account could not fund the leg. Top it up, then re-issue.',
  rejected: 'The venue rejected the order outright — its own message is below.',
  // Deliberately terse: an 'unknown' failure always carries a specific message
  // below it, and two paragraphs saying the same thing read as two problems.
  unknown: 'This leg needs checking on Boros:',
};

/** The venue's own words. 'rejected' is the catch-all — its message is the ONLY
 * thing that says what actually happened, so dropping it leaves the user with a
 * one-word label and nothing to act on. */
function FailureDetail({ fill }: { fill: BorosLegFill }) {
  if (!fill.failure) return null;
  return (
    <p className="pl-2 text-[10.5px] leading-relaxed text-ink-500">
      {FAILURE_HINT[fill.failure.code]}
      {fill.failure.message && (
        <span className="mt-0.5 block break-words font-mono text-[10px] text-ink-600">
          {fill.failure.message}
        </span>
      )}
    </p>
  );
}
