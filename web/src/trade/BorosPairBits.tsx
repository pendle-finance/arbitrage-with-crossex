/**
 * Presentational pieces of the Boros two-leg market ticket. The container
 * (BorosPairTicket) owns all state; nothing here fetches or decides.
 *
 * Two rules this file exists to enforce:
 *  - No gross spread. Every spread rendered here comes from the simulation's
 *    NET fields; there is no pre-cost number to render even by accident.
 *  - The ESTIMATE leads — it is what the book says this size actually gets,
 *    so it is the number the decision is made on, and it turns rose when it
 *    is negative.
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
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { amountError } from '../lib/amount';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd } from '../lib/fmt';

/** Was this leg actually sent to the venue? A not-submitted sentinel is
 * all-zero with no failure (orders.ts `notSubmitted`); a REJECTED leg has
 * filledSize 0 but a shortfall and a failure, and must still count. */
export const legSubmitted = (leg: BorosLegFill): boolean =>
  leg.filledSize !== 0 || leg.shortfallSize > 0 || leg.failure !== null;


const MIN_TOP_UP_USD = 2;
const MAX_TOP_UP_USD = 100;
/** Mirrors MIN_GAS_BALANCE_USD server-side, the same way MIN_TOP_UP_USD mirrors
 * the route's own bound. Only decides whether to OFFER the manual top-up — the
 * order tops itself up regardless, so a drift here costs nothing. */
const LOW_GAS_USD = 0.3;

/** USD at a precision that suits the amount. A whole-dollar format reads a
 * real $0.45 of margin as "$0", which is the same "it will do nothing"
 * impression the collateral columns used to give. */
const usdAt = (n: number): string => fmtUsd(n, Math.abs(n) < 100 ? 2 : 0);


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
export const size = (n: number | null | undefined): string => {
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
  compact,
}: {
  value: BorosLegDirection;
  onChange: (d: BorosLegDirection) => void;
  idPrefix: string;
  /** Shrink-to-fit, for the single ticket's market header where it sits
   * beside the caption rather than on a row of its own. */
  compact?: boolean;
}) {
  return (
    // Full width by default: the two options are the whole choice, so they
    // take the whole row rather than huddling left with dead space beside them.
    <div
      className={compact ? 'seg seg-xs inline-flex' : 'seg flex w-full'}
      role="radiogroup"
      aria-label={`${idPrefix} direction`}
    >
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
            className={`seg-btn ${compact ? '' : 'flex-1'} text-center ${
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
/**
 * One leg's market as a CARD — venue, then the three facts that decide
 * whether two markets can pair and what they cost: maturity, collateral,
 * and the mark rate. The Boros spread ticket shows the pair this way, and
 * it puts the eligibility rules (same collateral, same maturity) in front
 * of the user instead of leaving them to be discovered as greyed options.
 *
 * The picker itself stays: `children` is the select, revealed by "Change",
 * so the eligibility filtering and its "N hidden" note are untouched.
 */
export function MarketCard({
  label,
  row,
  children,
  side,
  locked,
}: {
  label: string;
  row: BorosPairMarketRow | null;
  children: React.ReactNode;
  /** This leg's side, as a label — which side each leg takes follows from
   * the pair being a spread, so it is stated, not chosen. */
  side?: BorosLegDirection;
  /** The wizard fixes both markets: the card states them read-only, and the
   * way to change them is to go back and pick another strategy. */
  locked?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* The side sits WITH its label, not across the card: "LONG · Market
          A" is one fact, and pushing the two apart made them read as
          unrelated. Stated, never chosen — which side each leg takes
          follows from the pair being a spread. */}
      <div className="flex items-center gap-2">
        {side && (
          <Chip sm tone={side === 'long' ? 'green' : 'red'} className="font-semibold">
            {side === 'long' ? 'LONG' : 'SHORT'}
          </Chip>
        )}
        <span className="text-[10px] uppercase tracking-wider text-ink-400">{label}</span>
      </div>
      {/* The picker is ALWAYS the control — no change/done state to enter or
          leave. It was a disclosure so the card could show a tidy summary,
          but that traded one click for a state the user had to manage, and
          the select already names the market it holds. Locked (wizard) keeps
          the plain summary: there is nothing to pick. */}
      {locked && (
        <span className="truncate text-[13px] font-medium text-ink-50" title={row?.name}>
          {row?.name ?? '—'}
        </span>
      )}
      {/* Locked hides the picker but keeps it MOUNTED: it carries the
          control's accessible name, so which market a leg holds stays
          readable rather than existing only as styled text. */}
      <div hidden={locked}>{children}</div>
      {/* Maturity and collateral are in the market's own name and on the
          size box; the mark rate is not repeated here — the estimate quotes
          the rate this size actually gets. */}
      {locked && row && (
        <span className="num text-[11px] text-ink-400">
          {fmtDateLocal(row.maturity)} · {row.collateral || `token${row.tokenId}`}
        </span>
      )}
    </div>
  );
}

export function MarketSelect({
  id,
  label,
  value,
  markets,
  reasonFor,
  onPick,
  disabled,
  ariaLabel,
}: {
  id: string;
  label: string;
  value: number | null;
  markets: BorosPairMarketRow[];
  /** Why this market cannot pair with the OTHER leg, or null if it can. */
  reasonFor: (m: BorosPairMarketRow) => string | null;
  onPick: (marketId: number | null) => void;
  disabled?: boolean;
  /** The accessible name when `label` is empty — inside a MarketCard the
   * card already carries the visible heading, but the control still needs
   * a name of its own. */
  ariaLabel?: string;
}) {
  const eligible = markets.filter((m) => reasonFor(m) === null);
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={id} className="text-[11.5px] text-ink-200">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={id}
          className="select"
          aria-label={label ? undefined : ariaLabel}
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
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-400">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 4.5 6 8l3.5-3.5" />
          </svg>
        </span>
      </div>
    </div>
  );
}

/** One label/value line in the costs list. `title` carries the explanation
 * that used to sit under it as prose. */
function Row({
  label,
  value,
  title,
  dim,
}: {
  label: ReactNode;
  value: ReactNode;
  title?: string;
  /** A breakdown line under the figure it explains — quieter than the total. */
  dim?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <span className={`shrink-0 ${dim ? 'pl-3 text-[11.5px] text-ink-400' : 'text-[12px] text-ink-200'}`}>{label}</span>
      <span className={`num truncate text-right ${dim ? 'text-[12px] text-ink-300' : 'text-[12.5px] text-ink-50'}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * "0.026175 ETH ($64.78)" — the dollar figure bracketed beside the
 * collateral, which is the unit the order is actually in. `bare` drops the
 * dollars entirely, for a breakdown line under a total that already carries
 * them (his call 2026-09-18).
 */
function CollateralAmount({ n, sim, bare }: { n: number | null; sim: BorosPairSimulation; bare?: boolean }) {
  if (n === null) return <>—</>;
  const usd = sim.collateralPriceUsd === null ? null : n * sim.collateralPriceUsd;
  return (
    <>
      {size(n)} {sim.collateral}
      {!bare && usd !== null && <span className="text-[11px] text-ink-400"> ({usdAt(usd)})</span>}
    </>
  );
}

/**
 * §3's headline: the spread this pair locks.
 *
 * Estimated leads — it is what the book says this size actually gets, and so
 * the number the decision is made on. It turns rose when negative, so a trade
 * that loses money says so. The rate bound (worst case) is not printed: the
 * slippage line states the tolerance the order carries.
 */
/** Which leg trades alone: Single mode (A, against a borrowed partner) or a
 * one-leg completion of a half-filled pair (A or B). null = both trade. */
export type SoloLeg = 'A' | 'B' | null;
const soloOf = (sim: BorosPairSimulation, solo: SoloLeg | undefined): BorosSimulatedLeg | null =>
  solo ? (solo === 'B' ? sim.legB : sim.legA) : null;

export function SpreadReadout({
  sim,
  singleLeg,
  between,
  compact = false,
}: {
  sim: BorosPairSimulation;
  /** The one leg that trades, when only one does — the readout is then that
   * leg's rate, whichever slot it sits in. */
  singleLeg?: SoloLeg;
  /** Rendered directly under the headline, before the per-leg rates — the
   * ticket puts its slippage line here. */
  between?: ReactNode;
  /** Headline and `between` only: the per-venue liquidation rows are left
   * to the caller (a roll's review keeps them behind "Details"). */
  compact?: boolean;
}) {
  const solo = soloOf(sim, singleLeg);
  const headline = solo ? solo.execApr : sim.estSpreadApr;
  const negative = headline !== null && headline < 0;
  const legs: Array<[string, BorosSimulatedLeg]> = solo
    ? []
    // The venue alone names a leg: both share the coin and maturity, and
    // the side chip beside it says which way it faces.
    : [
        [sim.legA.venue, sim.legA],
        [sim.legB.venue, sim.legB],
      ];
  const liqTitle = LIQ_TITLE;
  return (
    <div className="flex flex-col gap-1.5">
      {/* One leg has no spread to report: the headline becomes the rate that
          leg locks, which is the same question ("what do I get?") answered for
          a trade that has only one side. Net of fees either way; a negative
          figure turns rose so a trade that loses money says so. */}
      <div className="flex items-baseline justify-between gap-3">
        {/* The two execution rates the spread is the difference of ride on
            HOVER: the spread is the figure, its parts are detail (his call
            2026-09-18). */}
        <span
          className={legs.length > 0 ? 'cursor-help text-[12.5px] text-ink-50' : 'text-[12.5px] text-ink-50'}
          title={
            legs.length > 0
              ? `Net of settlement fees. Execution rates at this size:\n${legs
                  .map(([label, leg]) => `${label} ${pct(leg.execApr)}`)
                  .join('\n')}`
              : undefined
          }
        >
          {singleLeg ? 'Estimated rate' : 'Estimated spread'}
          {legs.length > 0 && <span className="ml-1 text-ink-400">ⓘ</span>}
        </span>
        <span className={`num text-lg font-semibold ${negative ? 'text-rose-300' : 'text-cyan-300'}`}>
          {pct(headline)}
        </span>
      </div>
      {solo && (
        <Row
          label="Liquidation APR"
          title={liqTitle}
          value={<span className={solo.liquidationApr === null ? 'text-ink-500' : undefined}>{pct(solo.liquidationApr)}</span>}
        />
      )}
      {between}
      {/* The two rates the spread is the difference OF, in the same box as
          the difference itself — they were a separate table, which made the
          reader hold one block in their head while reading another. Each
          carries the rate at which it would be liquidated on its own. */}
      {legs.length > 0 && !compact && <LiquidationRows sim={sim} />}
    </div>
  );
}

const LIQ_TITLE =
  'The mark rate at which this leg is liquidated if only its required margin backs it — extra collateral in the bucket moves it further out.';

/** One row per venue: two liquidation rates crammed onto a single line read
 * as one fact about the pair, when they are two independent points — Boros
 * liquidates per market (his call 2026-09-18). */
export function LiquidationRows({ sim }: { sim: BorosPairSimulation }) {
  const legs: Array<[string, BorosSimulatedLeg]> = [
    [sim.legA.venue, sim.legA],
    [sim.legB.venue, sim.legB],
  ];
  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-ink-800/80 pt-2">
      {legs.map(([label, leg]) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[12px] text-ink-200" title={LIQ_TITLE}>
            {label} liquidation APR
          </span>
          <span className={`num shrink-0 text-[12.5px] ${leg.liquidationApr === null ? 'text-ink-500' : 'text-ink-50'}`}>
            {pct(leg.liquidationApr)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Where each market's position ENDS UP.
 *
 * Presented as `current → resulting`, the way the Boros app itself shows it.
 * The old three-column Current/Trade/Resulting grid made the reader do the
 * addition to answer the only question actually being asked — "what will I be
 * holding?". An arrow says that on its own: a number you already hold,
 * becoming a number you will hold. Boros nets to one position per market, so
 * each row is the WHOLE exposure there, not just this ticket's slice.
 */
export function PositionArithmetic({
  sim,
  singleLeg,
}: {
  sim: BorosPairSimulation;
  singleLeg?: SoloLeg;
}) {
  // Named by venue, not by slot: "Binance · short" is the row a trader scans
  // for, where "Leg A" makes them remember which leg Binance was. A one-leg
  // trade lists that one leg — this block is the only position readout.
  const solo = soloOf(sim, singleLeg);
  const legs: BorosSimulatedLeg[] = solo ? [solo] : [sim.legA, sim.legB];
  /**
   * Magnitude only — the COLOUR carries the direction (green long, red
   * short), so a sign beside it says the same thing twice. The two legs of
   * a spread still read as opposite because they are coloured opposite.
   */
  const mag = (n: number) => fmtTokenQty(Math.abs(n), sim.collateral);
  const sideOf = (leg: BorosSimulatedLeg): BorosLegDirection =>
    leg.sizing.resultingSize > 0 ? 'long' : leg.sizing.resultingSize < 0 ? 'short' : leg.direction;
  return (
    <div className="flex flex-col gap-1 border-t border-ink-800/80 pt-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">Position after</span>
      {legs.map((leg) => {
        const side = sideOf(leg);
        const flat = leg.sizing.resultingSize === 0;
        return (
          <div key={leg.marketId} className="flex items-baseline justify-between gap-3">
            {/* Venue only: the colour of the figure carries the side. */}
            <span className="truncate text-[12px] text-ink-200">{leg.venue}</span>
            <span
              className="num shrink-0 text-[12px] text-ink-400"
              title="Boros nets to one position per market, so this is your WHOLE exposure there — not just the part this ticket opens."
            >
              {mag(leg.sizing.currentSize)}
              <span className="mx-1 text-ink-600">→</span>
              <span
                className={`font-semibold ${
                  flat ? 'text-ink-100' : side === 'long' ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {mag(leg.sizing.resultingSize)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function PairCosts({
  sim,
  singleLeg,
  /**
   * A CLOSING batch: the margin is being RELEASED, not posted, and which
   * bucket it comes back to is not a decision — so one line, no breakdown
   * (his call 2026-09-18).
   */
  freeing = false,
  compact = false,
}: {
  sim: BorosPairSimulation;
  /** Only leg A is real; leg B is a borrowed partner sized to zero. */
  singleLeg?: SoloLeg;
  freeing?: boolean;
  /** Total and fee only — no per-bucket breakdown. */
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-ink-800/80 pt-2">
      {/* The total LEADS and the legs hang off it as a breakdown: what the
          trade ties up is the figure being read, and which bucket carries
          which share is the detail behind it. Summed, never netted — a long
          and a short on different markets do not offset each other's
          margin. */}
      <Row
        label={freeing ? 'Margin freed' : singleLeg ? 'Margin required' : 'Total margin'}
        title={
          freeing
            ? 'Initial margin these legs stop posting once they are closed — it returns to the bucket each one sits in.'
            : singleLeg
              ? 'Initial margin this leg consumes'
              : 'The two legs summed, not netted: each bucket must carry its own margin.'
        }
        value={<CollateralAmount n={sim.marginRequiredTotal} sim={sim} />}
      />
      {!singleLeg && !freeing && !compact && (
        <>
          <Row
            label={sim.legA.venue}
            title="Initial margin this leg's bucket must carry"
            value={<CollateralAmount n={sim.legA.marginRequired} sim={sim} bare />}
            dim
          />
          <Row
            label={sim.legB.venue}
            title="Initial margin this leg's bucket must carry"
            value={<CollateralAmount n={sim.legB.marginRequired} sim={sim} bare />}
            dim
          />
        </>
      )}
      <Row
        // "Cost to cross" named the ACTION (crossing the spread) rather than
        // the charge, which reads as jargon to anyone who has not met it.
        label={singleLeg ? 'Trade fee' : 'Trade fee · 2 legs'}
        title={
          singleLeg
            ? 'Boros taker fee at this size, charged over the time to maturity'
            : 'Boros taker fee on both legs at this size, charged over the time to maturity'
        }
        value={`${size(sim.costToCrossSize)} ${sim.collateral}`}
      />
    </div>
  );
}
/**
 * The manual gas top-up.
 *
 * An order tops its own gas up as it sends (AUTO_TOP_UP_BELOW_USD in borosApi),
 * so this is no longer the way to get an order out — it used to hang off a
 * blocker, which made a low balance a dead end. It stays for the two cases the
 * automatic one does not cover: prepaying more than an order would, and an
 * install where the automatic top-up cannot run (no USD market, or the balance
 * could not be read) and the venue refuses the order for gas.
 */
export function GasTopUp({
  gasBalanceUsd,
  amount,
  onAmountChange,
  onTopUp,
  busy,
}: {
  gasBalanceUsd?: number | null;
  amount?: string;
  onAmountChange?: (raw: string) => void;
  onTopUp?: () => void;
  busy?: boolean;
}) {
  if (!onTopUp || gasBalanceUsd === null || gasBalanceUsd === undefined) return null;
  if (gasBalanceUsd >= LOW_GAS_USD) return null;
  const err = amountError(amount ?? '', { min: MIN_TOP_UP_USD, max: MAX_TOP_UP_USD });
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900/40 px-2.5 py-2 text-[11px] text-ink-300">
      <label htmlFor="boros-gas-topup" className="text-ink-400">
        Top up gas by hand (USD)
      </label>
      <input
        id="boros-gas-topup"
        className={`input num w-20 py-0.5 text-[11px] ${err ? '!border-rose-500/60' : ''}`}
        inputMode="decimal"
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? 'boros-gas-topup-error' : undefined}
        value={amount ?? ''}
        onChange={(e) => onAmountChange?.(e.target.value)}
      />
      {/* Moves margin into the gas budget — a hold, like every other
          real-money control here, not a click. */}
      <HoldToConfirmButton
        onConfirm={onTopUp}
        disabled={busy || err !== null || !amount?.trim()}
        className="!rounded !px-2 !py-0.5 !text-[11px] !font-medium"
        title="Press and hold to move this amount from margin into the gas budget"
      >
        {busy ? 'Topping up…' : 'Top up gas'}
      </HoldToConfirmButton>
      {err && (
        <p id="boros-gas-topup-error" role="alert" className="w-full text-rose-300">
          {err}
        </p>
      )}
    </div>
  );
}

/** Confirm blockers, each with its own remediation where one exists (§6). */
export function BlockerList({
  blockers,
  onCancelAndClose,
  busyMarketId,
}: {
  blockers: BorosPairBlocker[];
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
          {b.code === 'isolated-must-switch' && onCancelAndClose && b.marketId !== undefined && (
            // Cancels every resting order on the market and closes its WHOLE
            // position at market, unsized and unpreviewed — the one control
            // here that acts on a position the user never typed a size for,
            // so it holds like every other real-money control.
            <HoldToConfirmButton
              tone="red"
              onConfirm={() => onCancelAndClose(b.marketId as number)}
              disabled={busyMarketId === b.marketId}
              className="mt-1.5 !rounded !px-2 !py-0.5 !text-[11px] !font-medium"
              title="Press and hold: cancels every resting order on this market and closes its entire position at market"
            >
              {busyMarketId === b.marketId ? 'Working…' : 'Cancel orders & close position'}
            </HoldToConfirmButton>
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
  const oneLeg = !result.bothLegsSubmitted;
  // The SENT leg, never "whichever filled": a leg-B order rejected outright
  // fills 0 too, and reading that as "A" showed the not-submitted sentinel —
  // a hardcoded direction and no failure — on the very screen that has to
  // say why the venue refused.
  const only = oneLeg ? (legSubmitted(result.legB) ? result.legB : result.legA) : null;
  /**
   * Three outcomes, not two. A total refusal satisfies `partial` as much as a
   * half-done pair does, so it used to print "partially filled · 0 ETH hedged"
   * over two rejected legs. Red, not amber: there is no residual to complete.
   */
  const nothing = result.filledNothing;
  const shortfall = !nothing && result.partial;
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        nothing
          ? 'border-rose-500/30 bg-rose-500/[0.04]'
          : shortfall
            ? 'border-amber-500/30 bg-amber-500/[0.04]'
            : 'border-emerald-500/25 bg-emerald-500/5'
      }`}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip sm tone={nothing ? 'red' : tone}>
          {nothing ? 'nothing filled' : shortfall ? 'partially filled' : 'filled'}
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
          {/* Only when there IS a deficient leg. A pair that came back with
              no imbalance — both legs failed, or both fell short by the same
              amount — has nothing to complete; arming one leg anyway sent it
              alone at the full target size, naked. Retry re-issues both. */}
          {result.unhedgedLeg !== null && result.unhedgedSize > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={onComplete}
              className="rounded border border-cyan-500/50 px-2 py-0.5 text-[11px] text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-50"
            >
              Complete now at market
            </button>
          )}
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
  'min-cash': 'below the venue minimum',
  rejected: 'rejected',
  unknown: 'no confirmation',
};

export function LegFillLine({
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
  // Says "collateral, not gas" outright: the venue's own "top up" reads as gas,
  // and paying gas here spends margin on nothing and cannot be undone.
  'min-cash':
    'This is the first trade on this collateral on Boros, and the venue needs a minimum balance in that account before it will accept one. ' +
    'This is collateral, not gas: topping up the gas balance will not clear it. Deposit into your Boros balance for this collateral, then re-issue.',
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
        <span className="mt-0.5 block break-words text-[10px] text-ink-600">
          {fill.failure.message}
        </span>
      )}
    </p>
  );
}
