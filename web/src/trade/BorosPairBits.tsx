/**
 * Presentational pieces of the Boros two-leg market ticket. The container
 * (BorosPairTicket) owns all state; nothing here fetches or decides.
 *
 * Two rules this file exists to enforce:
 *  - No gross spread. Every spread rendered here comes from the simulation's
 *    NET fields; there is no pre-cost number to render even by accident.
 *  - The ESTIMATE leads — it is what the book says this size actually gets,
 *    so it is the number the decision is made on. Worst case sits directly
 *    under it and still colours the box rose when it is negative.
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
import { amountError } from '../lib/amount';
import { fmtPct, fmtTokenQty, fmtUsd } from '../lib/fmt';

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

/** Mirrors MIN_TOP_UP_USD / MAX_TOP_UP_USD in src/server/routes/borosPair.ts.
 * The server enforces the same pair — this is the message, not the guard.
 * Below the minimum the venue's $1 ops-fee sweep eats the top-up; above the
 * maximum is money the user cannot get back, because the pot has no exit. */
const MIN_TOP_UP_USD = 2;
const MAX_TOP_UP_USD = 100;

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

/**
 * LONG / SHORT, matching how the position cards name the same legs.
 *
 * "Pay fixed" / "Receive fixed" is the correct rates vocabulary but it is a
 * second name for a thing the rest of the app already calls long and short —
 * and a user reading a card, then this ticket, had to translate between them.
 * The rates reading is kept in the tooltip on the control.
 */
const DIRECTION_LABEL: Record<BorosLegDirection, string> = {
  short: 'Short',
  long: 'Long',
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
    // Full width: the two options are the whole choice, so they take the whole
    // row rather than huddling left with dead space beside them.
    <div className="seg flex w-full" role="radiogroup" aria-label={`${idPrefix} direction`}>
      {(['long', 'short'] as const).map((d) => {
        const active = value === d;
        const long = d === 'long';
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={active}
            data-active={active}
            // Green long / rose short, the same pairing SideChip gives the
            // cards — the direction must read the same on both surfaces. Only
            // the ACTIVE side carries colour; an inactive one stays neutral so
            // the chosen side is unambiguous at a glance.
            className={`seg-btn flex-1 text-center ${
              active
                ? long
                  ? '!bg-emerald-500/15 !text-emerald-300'
                  : '!bg-rose-500/15 !text-rose-300'
                : ''
            }`}
            title={
              long
                ? 'Long the rate — pay fixed, receive floating'
                : 'Short the rate — receive fixed, pay floating'
            }
            onClick={() => onChange(d)}
          >
            {DIRECTION_LABEL[d]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Market picker.
 *
 * Ineligible markets are HIDDEN once the other leg is chosen, and the list says
 * how many it dropped and why. §2 originally required they stay visible-but-
 * disabled, on the reasoning that a vanished market reads as "not listed" and
 * sends the user hunting. That holds when nothing explains the absence — but
 * with a pair already picked, most of the venue's markets are ineligible, and a
 * dropdown of mostly-dead options is its own kind of hunting. The caption keeps
 * the explanation §2 was protecting.
 *
 * With NO other leg selected nothing is ineligible, so the full list shows.
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
  /** Why this market cannot pair with the OTHER leg, or null if it can. */
  reasonFor: (m: BorosPairMarketRow) => string | null;
  onPick: (marketId: number | null) => void;
  disabled?: boolean;
}) {
  const eligible = markets.filter((m) => reasonFor(m) === null);
  const hidden = markets.length - eligible.length;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-ink-400">
        {label}
      </label>
      <select
        id={id}
        className="input"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onPick(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">select a market…</option>
        {eligible.map((m) => (
          <option key={m.marketId} value={m.marketId}>
            {m.name}
          </option>
        ))}
      </select>
      {hidden > 0 && (
        <span className="text-[10px] text-ink-500">
          {hidden} markets hidden — a pair must share its collateral and maturity with the other
          leg.
        </span>
      )}
    </div>
  );
}

/** One label/value line in the costs list. `title` carries the explanation
 * that used to sit under it as prose. */
function Row({ label, value, title }: { label: ReactNode; value: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]" title={title}>
      <span className="shrink-0 text-ink-400">{label}</span>
      <span className="num truncate text-right text-ink-100">{value}</span>
    </div>
  );
}

/**
 * §3's headline: the spread this pair locks.
 *
 * Estimated leads — it is what the book says this size actually gets, and so
 * the number the decision is made on. Worst case stays directly beneath it,
 * and the box turns rose when THAT one is negative, so a trade that can lose
 * money says so however the two are ordered.
 */
export function SpreadReadout({
  sim,
  singleLeg,
}: {
  sim: BorosPairSimulation;
  /** Only leg A is real; leg B is a borrowed partner sized to zero. */
  singleLeg?: boolean;
}) {
  const worst = sim.worstSpreadApr;
  const est = sim.estSpreadApr;
  const negative = worst !== null && worst < 0;
  const legs: Array<[string, BorosSimulatedLeg]> = singleLeg
    ? [[sim.legA.marketName, sim.legA]]
    : [
        [`Leg A · ${sim.legA.venue}`, sim.legA],
        [`Leg B · ${sim.legB.venue}`, sim.legB],
      ];
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        negative ? 'border-rose-500/25 bg-rose-500/5' : 'border-cyan-500/25 bg-cyan-500/5'
      }`}
    >
      {/* One leg has no spread to report: the headline becomes the rate that
          leg locks, which is the same question ("what do I get?") answered for
          a trade that has only one side. */}
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wider text-ink-300">
          {singleLeg ? 'Estimated rate' : 'Estimated spread'}
        </span>
        <span className={`num text-lg font-semibold ${negative ? 'text-rose-300' : 'text-cyan-300'}`}>
          {singleLeg ? pct(sim.legA.execApr) : pct(est)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between">
        <span
          className="text-[11px] text-ink-400"
          title={
            singleLeg
              ? 'Assumes the leg uses its full slippage tolerance.'
              : 'Assumes BOTH legs use their full tolerance at once — they cross in opposite directions, so the two give-ups add.'
          }
        >
          Worst case
        </span>
        <span className={`num text-[12.5px] ${negative ? 'text-rose-300' : 'text-ink-200'}`}>
          {singleLeg ? pct(sim.legA.worstApr) : pct(worst)}
        </span>
      </div>
      {/* The two rates the spread is the difference OF, in the same box as
          the difference itself — they were a separate table, which made the
          reader hold one block in their head while reading another. */}
      {!singleLeg && (
        <div className="mt-2 flex flex-col gap-0.5 border-t border-ink-700/60 pt-1.5">
          {legs.map(([label, leg]) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[11px] text-ink-400">{label}</span>
              <span className="num shrink-0 text-[12px] text-ink-100">{pct(leg.execApr)}</span>
            </div>
          ))}
        </div>
      )}
      {/* One line, and only the facts the numbers cannot state themselves: that
          they are net of fees, and that slippage bounds the RATE rather than
          guaranteeing a fill. */}
      <p
        className="mt-1.5 text-[10.5px] leading-relaxed text-ink-400"
        title={`Net of Boros taker and settlement fees (${pct(sim.feeDragApr)} APR combined). Slippage bounds the rate, not the fill: a leg that cannot fill inside its tolerance simply stops filling.`}
      >
        Net of fees ({pct(sim.feeDragApr)} APR) · bounds the rate, not the fill
      </p>
    </div>
  );
}

/**
 * §4's arithmetic: where each market's position ENDS UP.
 *
 * Presented as `current → resulting`, the way the Boros app itself shows it.
 * The old three-column Current/Trade/Resulting grid made the reader do the
 * addition to answer the only question actually being asked — "what will I be
 * holding?" — and spent a heading plus a footer sentence explaining that these
 * are netted account positions rather than this ticket's slice. An arrow says
 * that on its own: a number you already hold, becoming a number you will hold.
 */
export function PositionArithmetic({
  sim,
  singleLeg,
}: {
  sim: BorosPairSimulation;
  singleLeg?: boolean;
}) {
  const legs: Array<[string, BorosSimulatedLeg]> = singleLeg
    ? [[sim.legA.marketName, sim.legA]]
    : [
        [`Leg A · ${sim.legA.venue}`, sim.legA],
        [`Leg B · ${sim.legB.venue}`, sim.legB],
      ];
  /**
   * The sign IS the direction here, so a long has to be written `+0.01` and
   * not `0.01`: side by side with a short, an unsigned positive reads as a
   * magnitude and the two legs look like the same trade. fmtTokenQty carries
   * the minus but never the plus, so the plus is added explicitly.
   */
  const signed = (n: number) =>
    `${n > 0 ? '+' : ''}${fmtTokenQty(n, sim.collateral)}`;
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      {legs.map(([label, leg]) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <span className="truncate text-ink-400">{label}</span>
          <span
            className="num shrink-0 text-ink-500"
            title="Boros nets to one position per market, so this is your WHOLE exposure there — not just the part this ticket opens."
          >
            {signed(leg.sizing.currentSize)}
            <span className="mx-1 text-ink-600">→</span>
            <span className="font-semibold text-ink-100">
              {signed(leg.sizing.resultingSize)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function PairCosts({
  sim,
  singleLeg,
}: {
  sim: BorosPairSimulation;
  /** Only leg A is real; leg B is a borrowed partner sized to zero. */
  singleLeg?: boolean;
}) {
  const usd = (n: number | null) =>
    n === null || sim.collateralPriceUsd === null ? null : n * sim.collateralPriceUsd;
  const marginUsd = usd(sim.marginRequiredTotal);
  return (
    <div className="flex flex-col gap-0.5">
      <Row
        // "Cost to cross" named the ACTION (crossing the spread) rather than
        // the charge, which reads as jargon to anyone who has not met it.
        label="Taker fee"
        title={
          singleLeg
            ? 'Boros taker fee at this size, charged over the time to maturity'
            : 'Boros taker fee on both legs at this size, charged over the time to maturity'
        }
        value={`${size(sim.costToCrossSize)} ${sim.collateral}`}
      />
      <Row
        label={singleLeg ? 'Margin required' : 'Margin required (both legs)'}
        title={
          singleLeg
            ? 'Initial margin this leg consumes'
            : "Sum of the per-leg initial margins above — the legs' own numbers are what each bucket must carry"
        }
        value={
          sim.marginRequiredTotal === null
            ? '—'
            : `${size(sim.marginRequiredTotal)} ${sim.collateral}${
                marginUsd !== null ? ` (≈ ${usdAt(marginUsd)})` : ''
              }`
        }
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
  gasBalanceUsd,
  gasAmount,
  onGasAmountChange,
  onTopUpGas,
  topUpBusy,
}: {
  blockers: BorosPairBlocker[];
  collateral: string;
  onCancelAndClose?: (marketId: number) => void;
  /** marketId currently being remediated, so its button can show progress. */
  busyMarketId?: number | null;
  /**
   * null is UNKNOWN, never zero — the read failed. The blocker still shows,
   * because an unreadable pot can still be empty, but no top-up is offered for
   * it: the amount needed is unknown, and the read may be the broken thing.
   */
  gasBalanceUsd?: number | null;
  gasAmount?: string;
  onGasAmountChange?: (raw: string) => void;
  onTopUpGas?: () => void;
  topUpBusy?: boolean;
}) {
  if (blockers.length === 0) return null;
  const gasErr = amountError(gasAmount ?? '', { min: MIN_TOP_UP_USD, max: MAX_TOP_UP_USD });
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
          {b.code === 'no-gas' &&
            onTopUpGas &&
            gasBalanceUsd !== null &&
            gasBalanceUsd !== undefined && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <label htmlFor="boros-gas-topup" className="text-ink-400">
                  Top up (USD)
                </label>
                <input
                  id="boros-gas-topup"
                  className={`input num w-20 py-0.5 text-[11px] ${gasErr ? '!border-rose-500/60' : ''}`}
                  inputMode="decimal"
                  aria-invalid={gasErr ? true : undefined}
                  aria-describedby={gasErr ? 'boros-gas-topup-error' : undefined}
                  value={gasAmount ?? ''}
                  onChange={(e) => onGasAmountChange?.(e.target.value)}
                />
                <button
                  type="button"
                  className="rounded border border-rose-400/50 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-500/15 disabled:opacity-50"
                  disabled={topUpBusy || gasErr !== null || !gasAmount?.trim()}
                  onClick={onTopUpGas}
                >
                  {topUpBusy ? 'Topping up…' : 'Top up gas'}
                </button>
                {gasErr && (
                  <p id="boros-gas-topup-error" role="alert" className="w-full text-rose-300">
                    {gasErr}
                  </p>
                )}
              </div>
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
  /**
   * Omit where the report IS the surface rather than an overlay on a form —
   * the wizard's completed step 1, which has no armed ticket to return to.
   * Rendering a dead "Dismiss" there would offer to hide the step's own
   * content.
   */
  onDismiss?: () => void;
  busy?: boolean;
}) {
  const tone = result.partial ? 'amber' : 'green';
  /**
   * Was this a deliberate ONE-LEG order?
   *
   * Read off the RESULT, never the ticket's live toggle: the report describes
   * what was submitted, and the toggle can be flipped after the fact — a
   * receipt that changed its mind about what happened would be worse than a
   * clumsy one.
   *
   * A single-leg open sends one order and borrows a zero-size partner to keep
   * the pair shape valid (see the `onlyLeg` note in the route), so the second
   * leg comes back with nothing traded. Reporting that as "0 ETH hedged" with
   * a "Leg B · long 0 ETH" row describes a hedge the user never asked for and
   * reads as a failure — it was a complete success at exactly the size they
   * requested.
   */
  const onlyIsA = Math.abs(result.legB?.filledSize ?? 0) === 0;
  const oneLeg = !result.bothLegsSubmitted;
  const only = oneLeg ? (onlyIsA ? result.legA : result.legB) : null;
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
        {oneLeg && only ? (
          // Direction and size, which is the whole of what was asked for.
          <span className="text-[12px] text-ink-200">
            {DIRECTION_LABEL[only.direction]} <span className="num">{size(only.filledSize)}</span>{' '}
            {collateral}
            {only.execApr !== null && (
              <span className="num text-ink-100"> at {pct(only.execApr)}</span>
            )}
          </span>
        ) : (
          <>
            <span className="text-[12px] text-ink-200">
              {size(result.hedgedSize)} {collateral} hedged
            </span>
            {result.realisedSpreadApr !== null && (
              <span className="num text-[12px] text-ink-100">at {pct(result.realisedSpreadApr)}</span>
            )}
          </>
        )}
      </div>

      {/* Per-leg rows only when there are two legs to compare. On a one-leg
          order the header already states the direction, size and rate, and a
          "Leg B · long 0 ETH" row underneath describes the borrowed zero-size
          partner rather than anything the user did. */}
      {!oneLeg && (
        <div className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-ink-300">
          <LegFillLine label="Leg A" fill={result.legA} collateral={collateral} />
          <LegFillLine label="Leg B" fill={result.legB} collateral={collateral} />
        </div>
      )}
      {oneLeg && only?.failure && (
        <div className="mt-1.5 text-[11px] text-amber-400">{FAILURE_LABEL[only.failure.code]}</div>
      )}

      {/* On a ONE-LEG order every unit is unhedged by construction — that was
          the instruction, not a shortfall, and the ticket said so before the
          confirm. Repeating it here as an amber alarm cries wolf on the one
          warning that has to keep its force when a PAIR really does come back
          lopsided. */}
      {!oneLeg && result.unhedgedSize > 0 && (
        // The one thing a delta-neutral terminal must never bury.
        <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
          {size(result.unhedgedSize)} {collateral} on leg {result.unhedgedLeg} is unhedged — that
          size is directional until you complete or close it.
        </p>
      )}

      {result.partial && oneLeg ? (
        // A one-leg order that filled short is short of the SIZE asked for, not
        // short of a hedge — so "Complete now at market" (which arms the OTHER
        // leg) would open the very position the user chose not to open. Retry
        // and dismiss are the only honest options.
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-400 disabled:opacity-50"
          >
            Retry the rest
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-400"
          >
            Dismiss
          </button>
        </div>
      ) : result.partial ? (
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
      ) : onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-400"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/** Failure copy per code — each points at a genuinely different fix (§7). */
const FAILURE_LABEL: Record<NonNullable<BorosLegFill['failure']>['code'], string> = {
  'insufficient-depth': 'not enough depth',
  'rate-deviation': 'rate-deviation guard',
  'insufficient-margin': 'not enough margin',
  'no-gas': 'no prepaid gas',
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
  'no-gas':
    'Boros bills each action to a prepaid gas pot, which is separate from your trading collateral. Top up the gas balance, then re-issue.',
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
