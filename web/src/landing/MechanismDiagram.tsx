import type { ReactNode } from 'react';
import { fmtDateUtc, fmtNotionalShort, prettyVenue } from '../lib/fmt';
import { LANDING_NOTIONAL_USD, rankOpportunities, useLandingOpportunities } from './landingOpportunities';

/**
 * The four legs as a flow, then the arithmetic as a chain.
 *
 * Two venue boxes across the top, delta neutral against each other. A rule
 * drops from each into the Boros box below, which is where that venue's
 * floating funding is swapped for a fixed rate. All the connectors are
 * vertical or horizontal, so they are borders on ordinary elements — no SVG
 * overlay, and nothing to re-anchor when the columns collapse.
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

      <div className="flex flex-col gap-4">
        {/* --- Perps: boxed like Boros below, so the two halves of the trade
            read as parallel units. The container header states the ONE thing
            the pair achieves (equal size, opposite sides ⇒ no price exposure);
            each box then only has to name its side and its floating leg. --- */}
        <div className="rounded-xl border border-ink-700 bg-ink-900/40 p-3.5 sm:p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="num text-[11px] font-bold uppercase tracking-wider text-ink-300">
              CrossEx · same size, opposite sides
            </span>
            <span className="text-[11px] text-ink-500">
              price exposure nets to <span className="font-semibold text-ink-300">zero</span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2">
            {/* Tone follows the PERP side, matching SideVenue in the panel above
                and the terminal itself: SHORT is rose, LONG is emerald. These
                boxes state FLOATING only — a perp has no fixed rate. */}
            <VenueBox
              tone="rose"
              side={`Short ${d.base}`}
              venue={d.recvVenue}
              flow="Receives floating rate"
            />
            <VenueBox
              tone="emerald"
              side={`Long ${d.base}`}
              venue={d.payVenue}
              flow="Pays floating rate"
            />
          </div>
        </div>

        {/* --- Connectors: a vertical rule from each perp down to its Boros
            leg. Same 2-col template and gap as BOTH boxes' inner grids, plus
            the same px padding, so each rule lands under its own column's
            centre. A different template or gap here silently shifts them. --- */}
        <div className="hidden grid-cols-2 gap-3 px-3.5 lg:grid sm:px-4">
          <Connector tone="rose" />
          <Connector tone="emerald" />
        </div>

        {/* --- Boros: what swaps floating for fixed on both legs ----------- */}
        <div className="rounded-xl border border-cyan-500/40 bg-cyan-500/[0.04] p-3.5 sm:p-4">
          {/* Same header shape as the perp box: what it is, then the one thing
              it achieves. The two halves read as a matched pair. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="num text-[11px] font-bold uppercase tracking-wider text-cyan-300">
              Boros · same size as perps leg
            </span>
            <span className="text-[11px] text-ink-500">
              floating funding nets to <span className="font-semibold text-ink-300">zero</span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* The fixed rates live HERE, not on the perp boxes: Boros is the
                only leg with a fixed side. Receiving fixed IS the short-YU
                side — the mock had these two the wrong way round, so they are
                labelled from the data (shortLeg = Boros short fixed + perp
                short). Each pays the floating leg its perp receives, so the
                two cancel and only the fixed rate is left. */}
            <YuLeg
              tone="rose"
              title={`Short ${d.recvVenue} ${d.base} YU`}
              fixedLabel="Receives fixed"
              fixedRate={pct(d.recvApr)}
              note="pays floating"
            />
            <YuLeg
              tone="emerald"
              title={`Long ${d.payVenue} ${d.base} YU`}
              fixedLabel="Pays fixed"
              fixedRate={pct(d.payApr)}
              note="receives floating"
            />
          </div>
        </div>
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

/** One perp leg. FLOATING only — the fixed side lives in the Boros box.
 *
 * One title row, not two: an uppercase venue header above "Short <venue>"
 * printed the venue name twice. The side keeps the neutral ink colour — the
 * card's own border and background already carry the long/short tone. */
function VenueBox({
  tone,
  side,
  venue,
  flow,
}: {
  tone: 'emerald' | 'rose';
  /** The position: "Short ETH". Names the ASSET, so a reader can see the two
   * boxes are the same thing in opposite directions. */
  side: string;
  venue: string;
  flow: string;
}) {
  const box =
    tone === 'emerald'
      ? 'border-emerald-500/40 bg-emerald-500/[0.03]'
      : 'border-rose-500/40 bg-rose-500/[0.03]';
  const head = tone === 'emerald' ? 'text-emerald-400' : 'text-rose-400';
  return (
    <div className={`flex flex-col gap-1 rounded-lg border p-3 ${box}`}>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-[15px] font-semibold ${head}`}>{side}</span>
        <span className="num text-[11px] uppercase tracking-wider text-ink-400">on {venue}</span>
      </span>
      <span className="text-[12.5px] text-ink-400">{flow}</span>
    </div>
  );
}

/** The vertical rule from a venue down into Boros, with its label beside it.
 * Desktop only: stacked, the boxes already sit directly above one another. */
function Connector({ tone, label }: { tone: 'emerald' | 'rose'; label?: string }) {
  const line = tone === 'emerald' ? 'bg-emerald-500/40' : 'bg-rose-500/40';
  const arrow = tone === 'emerald' ? 'border-t-emerald-500/60' : 'border-t-rose-500/60';
  return (
    // items-center on the COLUMN, so the rule lands under the middle of the
    // venue box above it. It used to be `pl-6`, a hardcoded offset that put the
    // arrow ~220px left of the box centre.
    <div className="flex flex-col items-center">
      <span className={`h-8 w-px ${line}`} />
      {/* CSS triangle: cheaper than an svg for one arrowhead. */}
      <span
        aria-hidden="true"
        className={`h-0 w-0 border-x-4 border-t-[6px] border-x-transparent ${arrow}`}
      />
      {label && <span className="mt-1 text-[11.5px] leading-tight text-ink-400">{label}</span>}
    </div>
  );
}

/** One Boros YU leg: the fixed rate it locks, and the floating leg it pays or
 * receives to cancel the perp above it. */
function YuLeg({
  tone,
  title,
  fixedLabel,
  fixedRate,
  note,
}: {
  tone: 'emerald' | 'rose';
  title: string;
  fixedLabel: string;
  fixedRate: string;
  note: string;
}) {
  const box =
    tone === 'emerald'
      ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
      : 'border-rose-500/30 bg-rose-500/[0.04]';
  const rate = tone === 'emerald' ? 'text-emerald-400' : 'text-rose-400';
  return (
    <div className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 ${box}`}>
      <span className="text-[13px] text-ink-100">{title}</span>
      <span className="text-[13px] font-semibold text-ink-200">
        {fixedLabel} <span className={`num ${rate}`}>{fixedRate}</span>
        <span className="ml-1.5 text-[11.5px] font-normal text-ink-500">· {note}</span>
      </span>
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
