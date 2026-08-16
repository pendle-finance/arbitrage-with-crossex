import type { ReactNode } from 'react';
import { fmtDateUtc, fmtNotionalShort, prettyVenue } from '../lib/fmt';
import { LANDING_NOTIONAL_USD, rankOpportunities, useLandingOpportunities } from './landingOpportunities';

/**
 * The four legs grouped BY VENUE, then the arithmetic as a chain.
 *
 * One column per exchange, each holding that venue's perp leg and its Boros
 * leg. This grouping is load-bearing, not layout preference: the two things
 * that cancel do so on different axes, and only this shape can show both.
 *
 *   - FLOATING funding cancels VERTICALLY, inside one venue: the perp leg and
 *     the Boros leg take opposite sides of THAT VENUE'S OWN rate. What's left
 *     at the bottom of each column is a single fixed number.
 *   - PRICE cancels HORIZONTALLY, across the two venues — same size, opposite
 *     sides. That's the band above the columns.
 *
 * This replaced a platform-grouped version (a perp box over a Boros box). That
 * shape put the two Boros legs in one container under a "floating nets to
 * zero" header, which was misleading: those two legs face DIFFERENT venues'
 * funding rates and never cancel each other. Each cancels the perp beside it.
 * The mistake was structural, so no wording fixed it.
 *
 * Driven by the SAME best pair the hero panel prints, so this explains that
 * exact number rather than illustrating a generic one. Falls back to a static
 * worked example (labelled) only when nothing is pricing.
 *
 * The math row is deliberately four steps: spread → after costs → × leverage →
 * on capital. Spread × leverage does NOT equal the headline, since costs come
 * out in between, so they are never collapsed into one equation.
 */
export function MechanismDiagram() {
  const query = useLandingOpportunities();
  const best = rankOpportunities(query.data?.groups)[0] ?? null;

  const live = best
    ? {
        base: best.pair.base,
        recvVenue: prettyVenue(best.pair.shortLeg.venue),
        payVenue: prettyVenue(best.pair.longLeg.venue),
        recvApr: best.pair.shortLeg.execApr ?? best.pair.shortLeg.midApr,
        payApr: best.pair.longLeg.execApr ?? best.pair.longLeg.midApr,
        spreadApr: best.pair.execSpreadApr ?? best.pair.grossSpreadApr,
        netApr: best.pair.netFixedApr,
        leverage: best.pair.effectiveLeverage,
        onCapital: best.aprOnCapital,
        capitalUsd: best.pair.capitalUsd,
        maturity: best.group.maturity,
      }
    : null;

  const d = live ?? EXAMPLE;

  return (
    <section className="flex w-full flex-col gap-5 px-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight text-ink-100 sm:text-2xl">
          {live ? (
            <>
              How that <span className="num text-emerald-400">{d.base}</span> number is built
            </>
          ) : (
            'How the spread is built'
          )}
        </h2>
        <span className="num text-xs text-ink-500">
          {live ? `matures ${fmtDateUtc(d.maturity)}` : 'example, not live'}
        </span>
      </div>

      {/* The +/− legend. Only the SIGNED lines are being explained here: leg
          titles stay on the long/short scale the panel above uses, so the one
          thing a reader needs told is what the signs mean. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
        <span>
          <span className="num font-bold text-emerald-400">+</span> you receive
        </span>
        <span>
          <span className="num font-bold text-rose-400">−</span> you pay
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {/* --- Price band: the HORIZONTAL netting. It DEPICTS the crossing —
            the two perp legs either side of a tie line — rather than asserting
            it in prose, and names them as legs 1 and 2 so the band is visibly
            the perps rather than a separate claim about "ETH price". --- */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-ink-800 bg-ink-900/40 px-3.5 py-2.5 sm:px-4">
          <span className="num text-[10px] font-bold uppercase tracking-wider text-ink-500">
            Price exposure
          </span>
          <span className="flex flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 sm:flex-nowrap">
            <span className="num whitespace-nowrap text-[12px] text-ink-300">
              <LegNum n={1} /> short {fmtNotionalShort(LANDING_NOTIONAL_USD)}
            </span>
            <span className="h-px min-w-[24px] flex-1 bg-ink-700" />
            <span className="num whitespace-nowrap text-[12px] text-ink-300">
              <LegNum n={2} /> long {fmtNotionalShort(LANDING_NOTIONAL_USD)}
            </span>
          </span>
          <span className="num rounded-full border border-emerald-500/30 bg-emerald-500/[0.06] px-2.5 py-0.5 text-[11px] text-emerald-400">
            nets to 0 · no price risk
          </span>
        </div>

        {/* --- One column per venue. Each holds the two legs that face THAT
            venue's funding rate from opposite sides, so the cancellation
            happens inside the box and the residual falls out of the bottom.
            Stacked on mobile, each venue's two legs stay adjacent — the
            reading order survives the collapse.

            Column borders carry the DIRECTION tint (both legs in a column point
            the same way), which is the same thing their titles say — never the
            receive/pay tint, which changes line by line inside the column. --- */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <VenueColumn
            venue={d.recvVenue}
            venueNote="funding is rich here"
            side="short"
            perpNum={1}
            perpSide={`Short ${d.base} perp`}
            perpFlow="receives floating funding"
            perpFlowTone="recv"
            yuNum={3}
            yuSide={`Short ${d.base} YU`}
            yuFlow="pays floating funding"
            yuFlowTone="pay"
            fixedLabel="receives"
            fixedRate={pct(d.recvApr)}
            fixedTone="recv"
            residual={`+${pct(d.recvApr)} fixed`}
            residualTone="recv"
          />
          <VenueColumn
            venue={d.payVenue}
            venueNote="funding is cheap here"
            side="long"
            perpNum={2}
            perpSide={`Long ${d.base} perp`}
            perpFlow="pays floating funding"
            perpFlowTone="pay"
            yuNum={4}
            yuSide={`Long ${d.base} YU`}
            yuFlow="receives floating funding"
            yuFlowTone="recv"
            fixedLabel="pays"
            fixedRate={pct(d.payApr)}
            fixedTone="pay"
            residual={`−${pct(d.payApr)} fixed`}
            residualTone="pay"
          />
        </div>

        {/* YU is the one unfamiliar term on the page, and both columns lean on
            it. Defined once, below the columns that use it. Plain text, no
            `BorosTag`: the pill is a leg LABEL, and inside a sentence it reads
            as a UI chip rather than a word. */}
        <p className="text-[11px] leading-relaxed text-ink-500">
          Boros markets swap a venue's floating funding for a fixed rate. Short YU receives fixed,
          long YU pays fixed.
        </p>
      </div>

      {/* --- The math ------------------------------------------------------ */}
      <div className="flex flex-col gap-3 border-t border-ink-800 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-500">
          The math
        </span>
        {/* items-baseline: the arrow sits on the same text baseline as each
            value. Box-centring never looked right — the values are large digits
            with no descenders, so their optical centre is above their box
            centre and a centred arrow reads low. */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-3">
          <Step
            value={`${pct(d.recvApr)} − ${pct(d.payApr)} = ${pct(d.spreadApr)}`}
            label="spread"
          />
          <Arrow />
          <Step value={d.netApr !== null ? pct(d.netApr) : '—'} label="after costs" />
          <Arrow />
          <Step
            value={d.leverage !== null ? `×${d.leverage.toFixed(1)}x` : '× lev'}
            label="leverage"
          />
          {/* No arrow before the result: `ml-auto` pushes it to the far right,
              which left the arrow floating in the gap pointing at whitespace. */}
          <span
            className={`num ml-auto rounded-xl border px-4 py-2.5 text-lg font-bold leading-none tracking-tight sm:text-xl ${
              d.onCapital < 0
                ? 'border-rose-500/40 bg-rose-500/[0.06] text-rose-400'
                : 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-400'
            }`}
          >
            {d.onCapital < 0 ? '' : '+'}
            {pct(d.onCapital)} on capital
          </span>
        </div>
        <p className="text-[10.5px] text-ink-500">
          {fmtNotionalShort(LANDING_NOTIONAL_USD)} notional per leg
          {d.capitalUsd !== null ? ` · ~${fmtNotionalShort(d.capitalUsd)} capital` : ''}
        </p>
      </div>
    </section>
  );
}

/** Shown only when nothing prices at all — the same worked example as the
 * knowledge base, so the structure is still explained on an empty day. */
const EXAMPLE = {
  base: 'ETH',
  recvVenue: 'Hyperliquid',
  payVenue: 'OKX',
  recvApr: 0.08,
  payApr: 0.03,
  spreadApr: 0.05,
  netApr: null as number | null,
  leverage: 3,
  onCapital: 0.15,
  capitalUsd: null as number | null,
  maturity: 0,
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** What a flow line does to your balance. Colours the +/− flows ONLY. */
type Flow = 'recv' | 'pay';

const FLOW_TEXT: Record<Flow, string> = {
  recv: 'text-emerald-400',
  pay: 'text-rose-400',
};
const FLOW_SIGN: Record<Flow, string> = { recv: '+', pay: '−' };

/** Which way a leg points. Colours the leg TITLES only, on the same scale the
 * panel above and the terminal use (`SideVenue`): LONG emerald, SHORT rose.
 *
 * This shares its palette with `Flow` above but not its meaning, which is safe
 * only because the two never land on the same element — title vs flow line.
 * A short leg that receives shows a rose title over a green `+` row, and that
 * is correct: the direction and the cashflow genuinely differ. */
type Side = 'long' | 'short';

const SIDE_TEXT: Record<Side, string> = {
  long: 'text-emerald-400',
  short: 'text-rose-400',
};

/** The step number a leg carries, so the four legs can be referred to as 1–4
 * across the diagram (the price band names 1 and 2; each column names its own
 * perp and YU). Numbering identifies legs — it does NOT imply an execution
 * order, and nothing in the copy suggests one. */
function LegNum({ n }: { n: number }) {
  return (
    <span className="num mr-1.5 inline-grid h-[17px] w-[17px] place-items-center rounded border border-ink-700 bg-ink-800/70 align-[1px] text-[10px] font-bold text-ink-300">
      {n}
    </span>
  );
}

/** Boros gets a tinted tag wherever it is named — it is the product this page
 * is selling and the one platform a visitor won't recognise, so it should not
 * look like the same grey as "CrossEx". */
function BorosTag() {
  return (
    <span className="num rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-cyan-300">
      Boros
    </span>
  );
}

/** One venue, both its legs, and what's left after they cancel.
 *
 * The perp leg and the YU leg below it face the SAME venue's funding rate from
 * opposite sides. The divider between them names that rate explicitly, and the
 * footer prints the residual — the fixed rate that survives. Those two
 * residuals, one per column, are the entire trade and feed the math row. */
function VenueColumn({
  venue,
  venueNote,
  side,
  perpNum,
  perpSide,
  perpFlow,
  perpFlowTone,
  yuNum,
  yuSide,
  yuFlow,
  yuFlowTone,
  fixedLabel,
  fixedRate,
  fixedTone,
  residual,
  residualTone,
}: {
  venue: string;
  /** Both legs in a column point the SAME way — short perp sits with short YU,
   * long with long — so direction is a property of the column, not each leg. */
  side: Side;
  /** Why this venue is the one being shorted (or longed) — the reason the
   * trade exists at all, which the leg labels alone never say. */
  venueNote: string;
  perpNum: number;
  /** "Short ETH perp" — names the ASSET. "Short Hyperliquid" read as shorting
   * the exchange itself, which is why the venue sits in the header instead. */
  perpSide: string;
  perpFlow: string;
  perpFlowTone: Flow;
  yuNum: number;
  yuSide: string;
  yuFlow: string;
  yuFlowTone: Flow;
  fixedLabel: string;
  fixedRate: string;
  fixedTone: Flow;
  residual: string;
  residualTone: Flow;
}) {
  const box =
    side === 'long'
      ? 'border-emerald-500/40 bg-emerald-500/[0.03]'
      : 'border-rose-500/40 bg-rose-500/[0.03]';

  return (
    <div className={`flex flex-col overflow-hidden rounded-xl border ${box}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-ink-800 bg-ink-950/50 px-3.5 py-2">
        <span className="num text-[11px] font-bold uppercase tracking-wider text-ink-100">
          {venue}
        </span>
        <span className="text-[11px] text-ink-500">{venueNote}</span>
      </div>

      <div className="flex flex-1 flex-col px-3.5 py-3">
        <Leg
          n={perpNum}
          platform={<span className="num text-[10px] uppercase tracking-wider text-ink-500">CrossEx</span>}
          side={perpSide}
          sideTone={side}
          flow={perpFlow}
          flowTone={perpFlowTone}
        />

        {/* The whole argument of this layout, and the reason the columns are
            grouped by venue: legs 1 and 3 meet the SAME venue's floating rate
            from opposite sides, so it disappears. Named explicitly — "same
            rate, opposite sides" left a reader asking which rate. */}
        <div className="flex items-center gap-2.5 py-2.5">
          <span className="h-px flex-1 bg-ink-700" />
          <span className="whitespace-nowrap text-[11px] font-medium leading-none text-ink-300">
            {venue} floating funding cancels
          </span>
          <span className="h-px flex-1 bg-ink-700" />
        </div>

        <Leg
          n={yuNum}
          platform={<BorosTag />}
          side={yuSide}
          sideTone={side}
          flow={yuFlow}
          flowTone={yuFlowTone}
          fixed={
            <span className="num flex items-baseline gap-1.5 text-[13px] font-semibold">
              <span className={FLOW_TEXT[fixedTone]}>{FLOW_SIGN[fixedTone]}</span>
              <span className="font-sans font-normal text-ink-300">{fixedLabel}</span>
              <span className={FLOW_TEXT[fixedTone]}>{fixedRate} fixed</span>
            </span>
          }
        />
      </div>

      {/* mt-auto keeps the two columns' footers on one line when the legs wrap
          to different heights. */}
      <div className="mt-auto flex items-baseline justify-between gap-2 border-t border-ink-800 bg-ink-950/50 px-3.5 py-2">
        <span className="num text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          Left over
        </span>
        <span className={`num text-[15px] font-bold ${FLOW_TEXT[residualTone]}`}>{residual}</span>
      </div>
    </div>
  );
}

/** One leg inside a venue column: its number, where it trades, the position,
 * and the single flow it contributes.
 *
 * TWO colour systems, split by ROLE so they never collide on one element:
 * the leg TITLE is emerald/rose for LONG/SHORT (matching `SideVenue` and the
 * terminal), while the flow lines under it are emerald/rose for RECEIVE/PAY.
 * A leg is routinely short AND receiving, so the two would contradict each
 * other if either one owned the whole row. */
function Leg({
  n,
  platform,
  side,
  sideTone,
  flow,
  flowTone,
  fixed,
}: {
  n: number;
  platform: ReactNode;
  side: string;
  sideTone: Side;
  flow: string;
  flowTone: Flow;
  /** The fixed rate — Boros legs only. A perp has no fixed side. */
  fixed?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-[13.5px] font-semibold ${SIDE_TEXT[sideTone]}`}>
          <LegNum n={n} />
          {side}
        </span>
        {platform}
      </span>
      {/* Struck through and greyed: every floating line in this diagram is
          cancelled by its partner across the divider, so showing them at full
          strength made them compete with the fixed rate that actually survives.
          The sign stays visible (muted) rather than being struck with the text —
          it is what makes the two lines legible as + against −. */}
      <span className="num flex items-baseline gap-1.5 text-[12px] text-ink-600">
        <span className="font-bold">{FLOW_SIGN[flowTone]}</span>
        <span className="font-sans line-through decoration-ink-600">{flow}</span>
      </span>
      {fixed}
    </div>
  );
}

/** One step in the math chain. */
function Step({ value, label }: { value: string; label: string }) {
  return (
    // The wrapper's baseline IS the value's baseline (the label sits below it),
    // so an items-baseline row aligns the arrows to the digits.
    <span className="flex flex-col">
      <span className="num text-lg font-bold leading-none tracking-tight text-ink-100 sm:text-xl">
        {value}
      </span>
      <span className="mt-1 text-[10.5px] leading-none text-ink-400">{label}</span>
    </span>
  );
}

/** Sits on the same text BASELINE as the values it points between (the row is
 * items-baseline). The arrow glyph is centred on its own baseline, so it lands
 * mid-digit rather than under it. */
function Arrow(): ReactNode {
  return (
    <span aria-hidden="true" className="shrink-0 text-lg leading-none text-ink-600">
      →
    </span>
  );
}
