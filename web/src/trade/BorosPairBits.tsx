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
import { Trans, useTranslation } from 'react-i18next';
import { t } from '../i18n';
import type {
  BorosLegDirection,
  BorosLegFill,
  BorosPairBlocker,
  BorosPairMarketRow,
  BorosPairResult,
  BorosPairFunding,
  BorosPairSimulation,
  BorosSimulatedLeg,
} from '../api/types';
import { Chip } from '../components/Chip';
import { SpreadIcon, VenueIcon } from '../components/AssetIcon';
import { fmtDateShort, fmtDateUtc, fmtPct, fmtUsd, sigGrouped } from '../lib/fmt';
import { spreadName, type SpreadVenues } from '../lib/spread';
import { SpreadName } from '../components/SpreadName';
import { ChevronDown } from 'lucide-react';
import { localizeServerText } from '../i18n/serverMessages';

/** Was this leg actually sent to the venue? A not-submitted sentinel is
 * all-zero with no failure (orders.ts `notSubmitted`); a REJECTED leg has
 * filledSize 0 but a shortfall and a failure, and must still count. */
export const legSubmitted = (leg: BorosLegFill): boolean =>
  leg.filledSize !== 0 || leg.shortfallSize > 0 || leg.failure !== null;

export const legLetter = (index: number): string => String.fromCharCode(65 + index);



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
const directionLabel = (d: BorosLegDirection): string => t(d === 'long' ? 'common.long' : 'common.short');

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
  const { t } = useTranslation();
  return (
    // Full width by default: the two options are the whole choice, so they
    // take the whole row rather than huddling left with dead space beside them.
    <div
      className={compact ? 'seg seg-xs inline-flex' : 'seg flex w-full'}
      role="radiogroup"
      aria-label={t('pairTicket.borosBits.directionAria', { prefix: idPrefix })}
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
                ? t('pairTicket.borosBits.longRateHint')
                : t('pairTicket.borosBits.shortRateHint')
            }
            onClick={() => onChange(d)}
          >
            {t(long ? 'common.longAction' : 'common.shortAction')}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One leg's market as a CARD — venue, then the three facts that decide
 * whether two markets can pair and what they cost: maturity, collateral,
 * and the mark rate. The Boros spread ticket shows the pair this way, and
 * it puts the eligibility rules (same collateral, same maturity) in front
 * of the user instead of leaving them to be discovered as greyed options.
 *
 * The picker itself stays: `children` is the select, so the eligibility
 * filtering (§2) is untouched.
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
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* The side sits WITH its label, not across the card: "LONG · Market
          A" is one fact, and pushing the two apart made them read as
          unrelated. Stated, never chosen — which side each leg takes
          follows from the pair being a spread. */}
      <div className="flex items-center gap-2">
        {side && (
          <Chip
            sm
            tone={side === 'long' ? 'green' : 'red'}
            className="font-semibold"
            title={t(side === 'long' ? 'pairTicket.borosBits.longRateHint' : 'pairTicket.borosBits.shortRateHint')}
          >
            {t(side === 'long' ? 'common.longUpper' : 'common.shortUpper')}
          </Chip>
        )}
        <span className="text-[12px] font-normal text-ink-300">{label}</span>
      </div>
      {/* The picker is ALWAYS the control — no change/done state to enter or
          leave. It was a disclosure so the card could show a tidy summary,
          but that traded one click for a state the user had to manage, and
          the select already names the market it holds. Locked (wizard) keeps
          the plain summary: there is nothing to pick. */}
      {locked && (
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink-50" title={row?.name}>
          {row?.spreadVenues && <SpreadIcon venues={row.spreadVenues} />}
          <span className="truncate">{row ? marketName(row) : '—'}</span>
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
          {fmtDateUtc(row.maturity)} · {row.collateral || `token${row.tokenId}`}
        </span>
      )}
    </div>
  );
}

/**
 * A market as the picker lists it: venue and symbol, then the collateral. The
 * coin and maturity are left out (the chips above chose them), and the
 * collateral is spelled out because two markets can share every other word —
 * Hyperliquid lists BTC once against BTC and once against USDT.
 */
export const marketName = (row: BorosPairMarketRow): string =>
  row.spreadVenues
    ? `${spreadName(row.base, row.spreadVenues)} ${fmtDateShort(row.maturity, { year: 'numeric', timeZone: 'UTC' })}`
    : row.name;

export const marketLabel = (m: BorosPairMarketRow): string =>
  `${m.name.replace(/\s+\d{1,2} [A-Za-z]{3,4} \d{4}$/, '')} · ${m.collateral || `token${m.tokenId}`}`;

/**
 * Market picker. It lists only the markets that can take this leg: the chosen
 * coin's at the chosen maturity, and — once the other leg is picked — the ones sharing its
 * collateral. With nothing chosen yet the full list shows.
 */
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
  const { t } = useTranslation();
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
          <option value="">{t('pairTicket.borosBits.selectMarket')}</option>
          {eligible.map((m) => (
            <option key={m.marketId} value={m.marketId}>
              {marketLabel(m)}
            </option>
          ))}
        </select>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-400">
          <ChevronDown size={14} aria-hidden />
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
  weight = 'normal',
}: {
  label: ReactNode;
  value: ReactNode;
  title?: string;
  /** A breakdown line under the figure it explains — quieter than the total. */
  dim?: boolean;
  /** How loud the value reads: `strong` for the figures a trader decides on
   * (margin), `quiet` for the costs beside them (fee), as the Boros app
   * weighs them. */
  weight?: 'strong' | 'normal' | 'quiet';
}) {
  const tone = dim
    ? 'text-[12px] text-ink-300'
    : weight === 'strong'
      ? 'text-[12.5px] font-semibold text-ink-50'
      : weight === 'quiet'
        ? 'text-[12px] text-ink-300'
        : 'text-[12.5px] text-ink-50';
  return (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <span className={`shrink-0 ${dim ? 'pl-3 text-[11.5px] text-ink-400' : 'text-[12px] text-ink-200'}`}>{label}</span>
      <span className={`num truncate text-right ${tone}`}>{value}</span>
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
export type SoloLeg = number | null;
const soloOf = (sim: BorosPairSimulation, solo: SoloLeg | undefined): BorosSimulatedLeg | null =>
  solo === null || solo === undefined ? null : (sim.legs[solo] ?? null);
const loneOf = (sim: BorosPairSimulation, solo: SoloLeg | undefined): BorosSimulatedLeg | null =>
  soloOf(sim, solo) ?? (sim.legs.length === 1 ? sim.legs[0] : null);

export function SpreadReadout({
  sim,
  singleLeg,
  boxed = false,
}: {
  sim: BorosPairSimulation;
  /** The one leg that trades, when only one does — the readout is then that
   * leg's rate, whichever slot it sits in. */
  singleLeg?: SoloLeg;
  /** The headline in its own tinted box, label over figure, as the Boros
   * app sets its summary apart from the figures under it. Off where a hero
   * above already states the rate (a roll's "You lock"). */
  boxed?: boolean;
}) {
  const { t } = useTranslation();
  const solo = soloOf(sim, singleLeg);
  const headline = solo ? solo.execApr : sim.estSpreadApr;
  const negative = headline !== null && headline < 0;
  const legs: Array<[string, BorosSimulatedLeg]> = solo
    ? []
    // The venue alone names a leg: both share the coin and maturity, and
    // the side chip beside it says which way it faces.
    : sim.legs.map((leg) => [leg.venue, leg]);
  return (
    <div className="flex flex-col gap-1.5">
      {/* One leg has no spread to report: the headline becomes the rate that
          leg locks, which is the same question ("what do I get?") answered for
          a trade that has only one side. Net of fees either way; a negative
          figure turns rose so a trade that loses money says so. */}
      <div
        className={
          boxed
            ? 'flex flex-col gap-1 rounded-lg border border-ink-700/80 bg-ink-800/50 px-3 py-2.5'
            : 'flex items-baseline justify-between gap-3'
        }
      >
        {/* The two execution rates the spread is the difference of ride on
            HOVER: the spread is the figure, its parts are detail (his call
            2026-09-18). */}
        <span
          className={`${legs.length > 0 ? 'cursor-help ' : ''}${boxed ? 'self-start text-[12px] text-ink-300' : 'text-[12.5px] text-ink-50'}`}
          title={
            legs.length > 0
              ? t('pairTicket.borosBits.spreadHint', {
                  rates: legs.map(([label, leg]) => `${label} ${pct(leg.execApr)}`).join('\n'),
                })
              : undefined
          }
        >
          {solo ? t('pairTicket.borosBits.estimatedRate') : t('pairTicket.borosBits.estimatedSpread')}
          {legs.length > 0 && <span className="ml-1 text-ink-400">ⓘ</span>}
        </span>
        <span
          className={`num font-semibold ${boxed ? 'text-[22px] leading-none tracking-[-0.02em]' : 'text-lg'} ${negative ? 'text-rose-300' : 'text-emerald-400'}`}
        >
          {pct(headline)}
        </span>
      </div>
    </div>
  );
}

/** A leg's liquidation rate. "N/A", as the Boros app shows it, when the leg
 * still holds a position but no rate is in range; "—" when it ends flat or
 * has no rate. */
function LiqValue({
  leg,
  className = '',
  tone = '',
  warn = true,
}: {
  leg: BorosSimulatedLeg;
  className?: string;
  tone?: string;
  /** False when the account's free margin already carries the leg to the
   * suggested rate: the figure here assumes only the required margin. */
  warn?: boolean;
}) {
  const { t } = useTranslation();
  if (leg.liquidationApr == null && leg.execApr !== null && leg.sizing.resultingSize !== 0) {
    return <span className={`${className} text-ink-500`} title={t('pairTicket.borosBits.liqNaHint')}>{t('pairTicket.borosBits.na')}</span>;
  }
  // Amber, with the suggested rate in the hover, only when the position
  // would liquidate closer to the mark than it (above it for a long, below
  // it for a short) and the account's free margin does not cover the gap.
  const long = leg.sizing.resultingSize > 0;
  const suggested = leg.liquidationApr == null ? null : leg.suggestedLiquidationApr;
  const short =
    suggested != null && leg.liquidationApr != null && (long ? leg.liquidationApr > suggested : leg.liquidationApr < suggested);
  if (suggested == null || !short || !warn) {
    return (
      <span className={`${className} ${leg.liquidationApr == null ? 'text-ink-500' : tone}`}>
        {pct(leg.liquidationApr)}
      </span>
    );
  }
  const bound = `${long ? '≤' : '≥'} ${pct(suggested)}`;
  return (
    <span className={`${className} cursor-help text-amber-300`} title={t('pairTicket.borosBits.suggestedLiqTitle', { suggested: bound })}>
      {pct(leg.liquidationApr)}
    </span>
  );
}

/** Where the trade's legs liquidate: one "Liquidation APR" line for a
 * one-leg trade, else one line per venue — two rates on a single line read as
 * one fact about the pair, when Boros liquidates per market.
 * `warn` says which legs still need a top-up to reach the
 * suggested rate. */
export function LiquidationLines({
  sim,
  singleLeg,
  warn = () => true,
}: {
  sim: BorosPairSimulation;
  singleLeg?: SoloLeg;
  warn?: (leg: BorosSimulatedLeg) => boolean;
}) {
  const { t } = useTranslation();
  const lone = loneOf(sim, singleLeg);
  const legs: Array<[string, BorosSimulatedLeg]> = lone
    ? [[t('pairTicket.borosBits.liquidationApr'), lone]]
    : sim.legs.map((leg) => [t('pairTicket.borosBits.venueLiquidationApr', { venue: leg.venue }), leg]);
  return (
    <>
      {legs.map(([label, leg], i) => (
        <div key={`${leg.marketId}-${i}`} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[12px] text-ink-200" title={t('pairTicket.borosBits.liqTitle')}>
            {label}
          </span>
          <LiqValue leg={leg} className="num shrink-0 text-[12.5px] font-semibold" tone="text-ink-50" warn={warn(leg)} />
        </div>
      ))}
    </>
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
  spreadVenues,
  base,
  inline = false,
}: {
  sim: BorosPairSimulation;
  /** One "Position  0 → 1,036 ETH" line per market, no heading or venue
   * icons, for under the size field — as the Boros app states it beside
   * its own size. */
  inline?: boolean;
  /** The coin a spread leg is named for; the collateral when not given. */
  base?: string;
  singleLeg?: SoloLeg;
  spreadVenues?: SpreadVenues | null;
}) {
  // Named by venue, not by slot: "Binance · short" is the row a trader scans
  // for, where "Leg A" makes them remember which leg Binance was. A one-leg
  // trade lists that one leg — this block is the only position readout.
  const { t } = useTranslation();
  const solo = soloOf(sim, singleLeg);
  const legs: BorosSimulatedLeg[] = solo ? [solo] : sim.legs;
  const spread = spreadVenues && legs.length === 1 ? spreadVenues : null;
  /**
   * Magnitude only — the COLOUR carries the direction (green long, red
   * short), so a sign beside it says the same thing twice. The two legs of
   * a spread still read as opposite because they are coloured opposite.
   */
  const mag = (n: number) => `${sigGrouped(Math.abs(n))} ${sim.collateral}`;
  const sideOf = (leg: BorosSimulatedLeg): BorosLegDirection =>
    leg.sizing.resultingSize > 0 ? 'long' : leg.sizing.resultingSize < 0 ? 'short' : leg.direction;
  const figure = (leg: BorosSimulatedLeg) => {
    const side = sideOf(leg);
    const flat = leg.sizing.resultingSize === 0;
    return (
      <span className="num shrink-0 text-[12px] text-ink-400" title={t('pairTicket.borosBits.positionAfterHint')}>
        {mag(leg.sizing.currentSize)}
        <span className="mx-1 text-ink-600">→</span>
        <span className={`font-semibold ${flat ? 'text-ink-100' : side === 'long' ? 'text-emerald-300' : 'text-rose-300'}`}>
          {mag(leg.sizing.resultingSize)}
        </span>
      </span>
    );
  };
  if (inline) {
    return (
      <div className="flex flex-col gap-1">
        {legs.map((leg) => (
          <div key={leg.marketId} className="flex items-baseline justify-between gap-3">
            <span className="text-[11.5px] text-ink-200">
              {legs.length > 1 ? t('pairTicket.borosBits.positionOf', { venue: leg.venue }) : t('pairTicket.borosBits.position')}
            </span>
            {figure(leg)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 border-t border-ink-800/80 pt-2">
      <span className="text-[12px] font-normal leading-[14.52px] text-ink-300">{t('pairTicket.borosBits.positionAfter')}</span>
      {legs.map((leg) => (
        <div key={leg.marketId} className="flex items-baseline justify-between gap-3">
          {/* Venue only: the colour of the figure carries the side. */}
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-200">
            {spread ? <SpreadIcon venues={spread} /> : <VenueIcon venue={leg.venue} size={16} />}
            {spread ? <SpreadName base={base ?? sim.collateral} venues={spread} /> : <span className="truncate">{leg.venue}</span>}
          </span>
          {figure(leg)}
        </div>
      ))}
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
  afterMargin,
}: {
  sim: BorosPairSimulation;
  /** Only leg A is real; leg B is a borrowed partner sized to zero. */
  singleLeg?: SoloLeg;
  freeing?: boolean;
  /** Rendered between the margin and the fee: the suggested top-up reads as
   * part of the margin. */
  afterMargin?: ReactNode;
}) {
  const oneLeg = loneOf(sim, singleLeg) !== null;
  const { t } = useTranslation();
  const fee = `${size(sim.costToCrossSize)} ${sim.collateral}`;
  if (freeing) {
    return (
      <div className="flex flex-col gap-1.5">
        <Row
          label={t('pairTicket.borosBits.marginFreed')}
          title={t('pairTicket.borosBits.marginFreedHint')}
          value={<CollateralAmount n={sim.marginReleasedTotal ?? null} sim={sim} />}
        />
        <Row
          label={oneLeg ? t('pairTicket.borosBits.tradeFee') : t('pairTicket.borosBits.tradeFeeLegs', { n: sim.legs.length })}
          title={oneLeg ? t('pairTicket.borosBits.tradeFeeHint') : t('pairTicket.borosBits.tradeFeeLegsHint')}
          value={fee}
        />
      </div>
    );
  }
  // Margin leads, the fee sits under it quieter, as in the
  // Boros app; which leg posts what is the margin's hover.
  const required = sim.marginRequiredTotal;
  return (
    <div className="flex flex-col gap-1.5">
      <Row
        label={t('pairTicket.borosBits.marginUsage')}
        title={
          oneLeg
            ? t('pairTicket.borosBits.marginLegHint')
            : [
                t('pairTicket.borosBits.totalMarginHint'),
                ...sim.legs.map(
                  (leg) => `${leg.venue} ${leg.marginRequired === null ? '—' : `${size(leg.marginRequired)} ${sim.collateral}`}`,
                ),
              ].join('\n')
        }
        value={<CollateralAmount n={required} sim={sim} />}
        weight="strong"
      />
      {afterMargin}
      <Row
        label={oneLeg ? t('pairTicket.borosBits.tradeFee') : t('pairTicket.borosBits.tradeFeeLegs', { n: sim.legs.length })}
        title={oneLeg ? t('pairTicket.borosBits.tradeFeeHint') : t('pairTicket.borosBits.tradeFeeLegsHint')}
        value={fee}
        weight="quiet"
      />
    </div>
  );
}

/**
 * Free margin in each account the trade draws on, before → after it — the
 * line the Boros app sets above its size as "Available to Trade". `name`
 * labels an account when the trade draws on more than one. Before a quote,
 * `fallback` is the free margin alone.
 */
export function AvailableMarginLines({
  sim,
  funding,
  nameOf,
  fallback,
  unit,
}: {
  sim: BorosPairSimulation | null;
  funding: BorosPairFunding[] | undefined;
  nameOf: (marketId: number | null) => string;
  fallback: number | null;
  unit: string;
}) {
  const { t } = useTranslation();
  const lines: Array<{ key: string; label: string; before: number; after: number | null }> =
    sim && funding && funding.length > 0
      ? funding.map((f) => ({
          key: String(f.marketId ?? 'cross'),
          label:
            funding.length > 1
              ? t('pairTicket.borosBits.availableMarginOf', { account: nameOf(f.marketId) })
              : t('pairTicket.borosBits.availableMargin'),
          before: f.availableBefore,
          after: f.availableAfter,
        }))
      : fallback !== null
        ? [{ key: 'cross', label: t('pairTicket.borosBits.availableMargin'), before: fallback, after: null }]
        : [];
  return (
    <>
      {lines.map((l) => (
        <div key={l.key} className="flex items-baseline justify-between gap-3" title={t('pairTicket.borosBits.availableMarginHint')}>
          <span className="text-[11.5px] text-ink-200">{l.label}</span>
          <span className="num text-[12px] text-ink-400">
            {size(l.before)}
            {l.after !== null && (
              <>
                <span className="mx-1 text-ink-600">→</span>
                <span className={`font-semibold ${l.after < 0 ? 'text-rose-300' : 'text-ink-50'}`}>{size(l.after)}</span>
              </>
            )}{' '}
            {unit}
          </span>
        </div>
      ))}
    </>
  );
}

/** The deposit each account still needs for the suggested liquidation rate,
 * once the free margin left after the trade is counted; nothing when that
 * margin covers it. */
export function SuggestedTopUpLines({
  sim,
  funding,
  nameOf,
}: {
  sim: BorosPairSimulation;
  funding: BorosPairFunding[];
  nameOf: (marketId: number | null) => string;
}) {
  const { t } = useTranslation();
  const many = funding.length > 1;
  return (
    <>
      {funding
        .filter((f) => f.suggestedTopUp !== null && f.suggestedTopUp > 0)
        .map((f) => (
          <div
            key={f.marketId ?? 'cross'}
            className="flex items-baseline justify-between gap-3"
            title={t('pairTicket.borosBits.suggestedTopUpHint')}
          >
            <span className="shrink-0 cursor-help text-[12px] text-amber-300">
              {many ? `${t('pairTicket.borosBits.suggestedTopUp')} · ${nameOf(f.marketId)}` : t('pairTicket.borosBits.suggestedTopUp')}
            </span>
            <span className="num truncate text-right text-[12.5px] font-semibold text-amber-300">
              +<CollateralAmount n={f.suggestedTopUp} sim={sim} />
            </span>
          </div>
        ))}
    </>
  );
}

/** Confirm blockers, each with its own remediation where one exists (§6). */
/** Rounded DOWN to four significant figures: a size offered as "fills
 * whole" must never round up past what does. */
const floorSig = (n: number): number => {
  if (!(n > 0)) return 0;
  const step = 10 ** (Math.floor(Math.log10(n)) - 3);
  return Math.floor(n / step + 1e-9) * step;
};

/**
 * The short reason a blocked ticket's button says instead of Confirm, as the
 * Boros app does ("Insufficient liquidity"); null when no blocker has one,
 * so the button stays as it was. Most specific first.
 */
const BUTTON_REASONS: Array<[string[], () => string]> = [
  [['insufficient-depth', 'no-depth'], () => t('pairTicket.borosBits.reason.liquidity')],
  [['rate-bound-out-of-range'], () => t('pairTicket.borosBits.reason.rateOutOfRange')],
  [['slippage-exceeds-max'], () => t('pairTicket.borosBits.reason.slippage')],
  [['cross-short-margin', 'isolated-short-margin'], () => t('pairTicket.borosBits.reason.margin')],
  [['below-min-order-value'], () => t('pairTicket.borosBits.reason.tooSmall')],
];

/**
 * Which legs' liquidation turns amber: only a leg whose OWN account (an
 * isolated-only leg's, else cross) still needs a top-up — free margin left
 * after the trade may already cover it, and cash in another account never
 * does. Older servers send no funding, so every short leg warns.
 */
export const liqWarnOf =
  (funding: BorosPairFunding[] | undefined) =>
  (leg: BorosSimulatedLeg): boolean => {
    const f = funding?.find((x) => x.marketId === leg.marketId) ?? funding?.find((x) => x.marketId === null);
    return f === undefined || f.suggestedTopUp === null || f.suggestedTopUp > 0;
  };

const isMarginBlocker = (b: BorosPairBlocker): boolean =>
  b.code === 'cross-short-margin' || b.code === 'isolated-short-margin';

export function blockerButtonReason(blockers: BorosPairBlocker[]): string | null {
  // When the margin funds less than the book fills, the margin is the limit
  // the trader meets first, so the button names it.
  const sized = blockers.filter((b) => b.maxSize !== undefined);
  const tightest = sized.reduce<BorosPairBlocker | null>(
    (min, b) => (min === null || (b.maxSize ?? 0) < (min.maxSize ?? 0) ? b : min),
    null,
  );
  if (tightest !== null && isMarginBlocker(tightest)) return t('pairTicket.borosBits.reason.margin');
  for (const [codes, label] of BUTTON_REASONS) {
    if (blockers.some((b) => codes.includes(b.code))) return label();
  }
  return null;
}

export function BlockerList({
  blockers,
  onUseSize,
  unit = '',
}: {
  blockers: BorosPairBlocker[];
  /** Sizes the ticket to a blocker's `maxSize`. Orders are fill-or-kill, so a
   * size that cannot fill whole is refused. With it, every such blocker folds
   * into ONE line naming the largest size that fills — the button already
   * says why. A margin blocker keeps its own line, which says how much is
   * short and in which account, and gains the size its margin funds. */
  onUseSize?: (size: number) => void;
  unit?: string;
}) {
  const { t } = useTranslation();
  const fold = (b: BorosPairBlocker) => onUseSize !== undefined && b.maxSize !== undefined && !isMarginBlocker(b);
  const fillable = blockers.filter(fold);
  const rest = blockers.filter((b) => !fold(b));
  if (blockers.length === 0) return null;
  // The pair is one size, so every leg's blocker carries the same figure.
  const max = fillable.length > 0 ? floorSig(Math.min(...fillable.map((b) => b.maxSize ?? 0))) : null;
  // Only the smallest size goes through every limit, so only it is a button;
  // a larger one is shown as text.
  const sizes = onUseSize ? blockers.filter((b) => b.maxSize !== undefined).map((b) => floorSig(b.maxSize ?? 0)) : [];
  const smallest = sizes.length > 0 ? Math.min(...sizes) : null;
  const sizeButton = (size: number, title: string) =>
    onUseSize && size === smallest ? (
      <button
        type="button"
        className="num font-medium text-rose-100 underline underline-offset-2 hover:text-ink-50"
        title={title}
        onClick={() => onUseSize(size)}
      >
        {sigGrouped(size)} {unit}
      </button>
    ) : (
      <span className="num">
        {sigGrouped(size)} {unit}
      </span>
    );
  // Which limit stopped the size, so the line says what would help: a book
  // that runs out needs nothing more; past the user's max slippage, widening
  // it helps; past Boros's band, only a smaller size does.
  const band = fillable.find((b) => b.code === 'rate-bound-out-of-range');
  const why = fillable.some((b) => b.code === 'insufficient-depth')
    ? null
    : band
      ? t('pairTicket.borosBits.bandLimit', { apr: fmtPct(band.limitApr ?? 0) })
      : fillable.some((b) => b.code === 'slippage-exceeds-max')
        ? t('pairTicket.borosBits.slippageLimit')
        : null;
  return (
    <ul className="flex flex-col gap-1.5">
      {max !== null && onUseSize && (
        <li className="rounded border border-guava/30 bg-guava/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200">
          {why !== null && <>{why} </>}
          {max > 0 ? (
            <>
              {t('pairTicket.borosBits.maxFillable')} {sizeButton(max, t('pairTicket.borosBits.useMaxSizeTitle'))}
            </>
          ) : (
            t(band ? 'pairTicket.borosBits.nothingFillsBand' : 'pairTicket.borosBits.nothingFills')
          )}
        </li>
      )}
      {rest.map((b, i) => (
        <li
          key={`${b.code}-${b.leg ?? ''}-${i}`}
          // pre-line: a roll's refusal carries one line per rejected leg.
          className="whitespace-pre-line rounded border border-guava/30 bg-guava/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200"
        >
          {localizeServerText(b.message)}
          {onUseSize && isMarginBlocker(b) && floorSig(b.maxSize ?? 0) > 0 && (
            <>
              {' '}
              {t('pairTicket.borosBits.maxFunded')}{' '}
              {sizeButton(floorSig(b.maxSize ?? 0), t('pairTicket.borosBits.useMaxFundedTitle'))}
            </>
          )}
          {b.code === 'isolated-must-switch' && b.marketId !== undefined && (
            // A link, not a button: this app cannot close an isolated
            // position (the close route refuses one), so the button that
            // used to sit here could only ever fail.
            <>
              {' '}
              <Trans
                i18nKey="pairTicket.borosBits.isolatedSwitch"
                components={{
                  a: (
                    <a
                      href={`https://boros.pendle.finance/markets/${b.marketId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-rose-100"
                    />
                  ),
                }}
              />
            </>
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
  legName,
  fee,
}: {
  result: BorosPairResult;
  collateral: string;
  legName?: (marketId: number) => string | null;
  fee?: number | null;
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
  const { t } = useTranslation();
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
  const oneLeg = !result.allLegsSubmitted || result.legs.length === 1;
  // The SENT leg, never "whichever filled": a leg-B order rejected outright
  // fills 0 too, and reading that as "A" showed the not-submitted sentinel —
  // a hardcoded direction and no failure — on the very screen that has to
  // say why the venue refused.
  const only = oneLeg ? (result.legs.find(legSubmitted) ?? result.legs[0] ?? null) : null;
  /**
   * Three outcomes, not two. A total refusal satisfies `partial` as much as a
   * half-done pair does, so it used to print "partially filled · 0 ETH hedged"
   * over two rejected legs. Red, not amber: there is no residual to complete.
   */
  const onlyName = only ? (legName?.(only.marketId) ?? null) : null;
  const nothing = result.filledNothing;
  const shortfall = !nothing && result.partial;
  return (
    <div
      className={`rounded border px-3 py-2.5 ${
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
          {nothing ? t('pairTicket.borosBits.nothingFilled') : shortfall ? t('pairTicket.borosBits.partiallyFilled') : t('pairTicket.borosBits.filled')}
        </Chip>
        {oneLeg && only ? (
          // Direction and size, which is the whole of what was asked for.
          <span className="text-[12px] text-ink-200">
            {onlyName ? `${onlyName} · ${directionLabel(only.direction).toLowerCase()}` : directionLabel(only.direction)}{' '}
            <span className="num">{size(only.filledSize)}</span>{' '}
            {collateral}
            {only.execApr !== null && (
              <span className="num text-ink-100"> {t('pairTicket.borosBits.atRate', { rate: pct(only.execApr) })}</span>
            )}
          </span>
        ) : (
          <>
            <span className="text-[12px] text-ink-200">
              {t('pairTicket.borosBits.hedged', { size: size(result.hedgedSize), unit: collateral })}
            </span>
            {result.realisedSpreadApr !== null && (
              <span className="num text-[12px] text-ink-100">{t('pairTicket.borosBits.atRate', { rate: pct(result.realisedSpreadApr) })}</span>
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
          {result.legs.map((fill, i) => (
            <LegFillLine key={i} label={legName?.(fill.marketId) ?? t('pairTicket.borosBits.legLetter', { letter: legLetter(i) })} fill={fill} collateral={collateral} />
          ))}
        </div>
      )}
      {fee !== undefined && fee !== null && !result.partial && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span className="text-ink-400">{t('common.fee')}</span>
          <span className="num text-ink-200">
            {size(fee)} {collateral}
          </span>
        </div>
      )}
      {oneLeg && only?.failure && (
        <div className="mt-1.5 text-[11px] text-amber-400">{t(FAILURE_LABEL[only.failure.code])}</div>
      )}

      {/* On a ONE-LEG order every unit is unhedged by construction — that was
          the instruction, not a shortfall, and the ticket said so before the
          confirm. Repeating it here as an amber alarm cries wolf on the one
          warning that has to keep its force when a PAIR really does come back
          lopsided. */}
      {!oneLeg && result.unhedgedSize > 0 && (
        // The one thing a delta-neutral terminal must never bury.
        <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
          {t('pairTicket.borosBits.unhedged', { size: size(result.unhedgedSize), unit: collateral, letter: result.unhedgedLeg === null ? '' : legLetter(result.unhedgedLeg) })}
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
            className="btn-ghost-xs"
          >
            {t('pairTicket.borosBits.retryRest')}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="btn-ghost-xs"
          >
            {t('common.dismiss')}
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
              className="btn-ghost-xs !border-info/50 !text-pastel-blue hover:!bg-info/15"
            >
              {t('pairTicket.borosBits.completeAtMarket')}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            className="btn-ghost-xs"
          >
            {t('common.retry')}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="btn-ghost-xs"
          >
            {t('pairTicket.borosBits.leaveIt')}
          </button>
        </div>
      ) : onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="btn-ghost-xs mt-2"
        >
          {t('common.dismiss')}
        </button>
      ) : null}
    </div>
  );
}

/** Failure copy per code — each points at a genuinely different fix (§7). */
const FAILURE_LABEL = {
  'insufficient-depth': 'pairTicket.failure.label.insufficientDepth',
  'rate-deviation': 'pairTicket.failure.label.rateDeviation',
  'insufficient-margin': 'pairTicket.failure.label.insufficientMargin',
  'no-gas': 'pairTicket.failure.label.noGas',
  'min-cash': 'pairTicket.failure.label.minCash',
  'market-limit': 'pairTicket.failure.label.marketLimit',
  rejected: 'pairTicket.failure.label.rejected',
  unknown: 'pairTicket.failure.label.unknown',
} as const satisfies Record<NonNullable<BorosLegFill['failure']>['code'], string>;

export function LegFillLine({
  label,
  fill,
  collateral,
}: {
  label: string;
  fill: BorosLegFill;
  collateral: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-400">
          {label} · {directionLabel(fill.direction).toLowerCase()}
        </span>
        <span className="num text-ink-200">
          {size(fill.filledSize)} {collateral}
          {fill.execApr !== null && ` @ ${pct(fill.execApr)}`}
          {fill.failure && (
            <span className="ml-1.5 text-amber-400">{t(FAILURE_LABEL[fill.failure.code])}</span>
          )}
        </span>
      </div>
      <FailureDetail fill={fill} />
    </div>
  );
}

/** What to DO about each failure. Mirrors `legFailureHint` in
 * src/core/boros/orders.ts — each code points at a different fix. */
const FAILURE_HINT = {
  'insufficient-depth': 'pairTicket.failure.hint.insufficientDepth',
  'rate-deviation': 'pairTicket.failure.hint.rateDeviation',
  'insufficient-margin': 'pairTicket.failure.hint.insufficientMargin',
  'no-gas': 'pairTicket.failure.hint.noGas',
  // Says "collateral, not gas" outright: the venue's own "top up" reads as gas,
  // and paying gas here spends margin on nothing and cannot be undone.
  'min-cash': 'pairTicket.failure.hint.minCash',
  'market-limit': 'pairTicket.failure.hint.marketLimit',
  rejected: 'pairTicket.failure.hint.rejected',
  // Deliberately terse: an 'unknown' failure always carries a specific message
  // below it, and two paragraphs saying the same thing read as two problems.
  unknown: 'pairTicket.failure.hint.unknown',
} as const satisfies Record<NonNullable<BorosLegFill['failure']>['code'], string>;

/** The venue's own words. 'rejected' is the catch-all — its message is the ONLY
 * thing that says what actually happened, so dropping it leaves the user with a
 * one-word label and nothing to act on. */
function FailureDetail({ fill }: { fill: BorosLegFill }) {
  const { t } = useTranslation();
  if (!fill.failure) return null;
  return (
    <p className="pl-2 text-[10.5px] leading-relaxed text-ink-500">
      {t(FAILURE_HINT[fill.failure.code])}
      {fill.failure.message && (
        <span className="mt-0.5 block break-words text-[10px] text-ink-600">
          {localizeServerText(fill.failure.message)}
        </span>
      )}
    </p>
  );
}

/**
 * §4: the tick a trade needs before it reduces, closes or flips a position
 * the account already holds. Boros nets to one position per market, so an
 * open on a market another pair holds the other side of changes THAT
 * position too. The ticket and both roll reviews show the same box.
 */
export function OpposingAcknowledgement({
  sim,
  checked,
  onChange,
  nameOf,
}: {
  sim: BorosPairSimulation;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The market's display name, when the caller has a better one. */
  nameOf?: (marketId: number) => string | null;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-2.5 py-2 text-[11px] leading-relaxed text-amber-100">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {sim.legs
          .filter((leg) => leg.sizing.opposing)
          .map((leg) => acknowledgementText({ ...leg, marketName: nameOf?.(leg.marketId) ?? leg.marketName }, sim.collateral))
          .join(' ')}
      </span>
    </label>
  );
}

export function acknowledgementText(
  leg: { marketName: string; sizing: { currentSize: number; resultingSize: number; flips: boolean } },
  collateral: string,
): string {
  const { sizing } = leg;
  // The same magnitude-scaled formatter as every other size on the ticket:
  // fixed 2dp printed a 0.0123 BTC position as "0.01 BTC" in the one line
  // that binds the user to what happens to it.
  const held = size(Math.abs(sizing.currentSize));
  const side = t(sizing.currentSize > 0 ? 'common.long' : 'common.short');
  if (sizing.flips) {
    const opened = size(Math.abs(sizing.resultingSize));
    return t('pairTicket.borosBits.ackFlip', { market: leg.marketName, side, held, unit: collateral, opened });
  }
  if (sizing.resultingSize === 0) {
    return t('pairTicket.borosBits.ackClose', { market: leg.marketName, side, held, unit: collateral });
  }
  const to = size(Math.abs(sizing.resultingSize));
  return t('pairTicket.borosBits.ackReduce', { market: leg.marketName, side, held, unit: collateral, to });
}
