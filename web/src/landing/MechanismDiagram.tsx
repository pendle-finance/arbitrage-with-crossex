import { fmtDateUtc, fmtNotionalShort, prettyVenue } from '../lib/fmt';
import { LANDING_NOTIONAL_USD, rankOpportunities, useLandingOpportunities } from './landingOpportunities';

/**
 * The 4-leg structure AND the hero's receipts, in one block. Two perp legs
 * (opposite sides, two venues) cancel price risk. Two Boros legs (one per
 * venue, opposite side to that venue's perp) cancel each perp's floating
 * funding. What's left: the gap between the two FIXED rates.
 *
 * Driven by the SAME best pair the hero prints, so the diagram is the
 * explanation of that exact number rather than a generic illustration — the
 * venues, rates, leverage, maturity and capital that used to sit as a prose
 * paragraph under the hero are now the diagram's own labels. Falls back to a
 * static worked example (labelled as such) only when nothing is pricing.
 *
 * The arithmetic is shown honestly in two steps: the raw spread, then what
 * survives costs and leverage. Spread × leverage does NOT equal the headline —
 * costs come out in between — so the two are never collapsed into one equation.
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
    <section className="mx-auto w-full max-w-3xl px-1">
      <div className="card border-ink-700 bg-ink-900/60 p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-xs font-bold uppercase tracking-wider text-ink-200">
            {live ? (
              <>
                How that <span className="num text-cyan-300">{d.base}</span> number is built
              </>
            ) : (
              'How the spread is built'
            )}
          </span>
          <span className="text-[10.5px] text-ink-500">
            {live ? `matures ${fmtDateUtc(d.maturity)}` : 'example, not live'}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <VenueBox
            venue={d.recvVenue}
            tone="emerald"
            perp="Short perp"
            fixed={`Receive fixed ${pct(d.recvApr)}`}
          />
          <span aria-hidden="true" className="justify-self-center text-lg font-bold text-ink-500">
            −
          </span>
          <VenueBox
            venue={d.payVenue}
            tone="rose"
            perp="Long perp"
            fixed={`Pay fixed ${pct(d.payApr)}`}
          />
        </div>

        {/* The two-step arithmetic: raw spread, then after costs and leverage.
            Reads as a small ledger rather than a sentence. */}
        <div className="mt-3 flex flex-col gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2.5">
          <Row
            left="Price risk 0 · funding risk 0 · spread left"
            right={`${pct(d.recvApr)} − ${pct(d.payApr)} = ${pct(d.spreadApr)}`}
          />
          {d.netApr !== null && (
            <Row left="After execution costs" right={pct(d.netApr)} muted />
          )}
          <Row
            left={d.leverage !== null ? `× ${d.leverage.toFixed(1)}x leverage` : '× leverage'}
            right={
              <span className={d.onCapital < 0 ? 'text-rose-400' : 'text-cyan-300'}>
                {d.onCapital < 0 ? '' : '+'}
                {pct(d.onCapital)} on capital
              </span>
            }
            strong
          />
        </div>

        <p className="mt-2 text-center text-[10.5px] text-ink-500">
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

function VenueBox({
  venue,
  tone,
  perp,
  fixed,
}: {
  venue: string;
  tone: 'emerald' | 'rose';
  perp: string;
  fixed: string;
}) {
  const box =
    tone === 'emerald'
      ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
      : 'border-rose-500/20 bg-rose-500/[0.04]';
  const head = tone === 'emerald' ? 'text-emerald-400' : 'text-rose-400';
  const dot = tone === 'emerald' ? 'bg-emerald-400' : 'bg-rose-400';
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border p-3 ${box}`}>
      <span className={`text-[10px] font-semibold uppercase tracking-wider ${head}`}>{venue}</span>
      <Leg label={perp} note="cancels price risk" />
      <Leg label={fixed} note="cancels floating funding" dot={dot} />
    </div>
  );
}

function Leg({ label, note, dot = 'bg-ink-500' }: { label: string; note: string; dot?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="text-[12.5px] text-ink-100">{label}</span>
      <span className="text-[10.5px] text-ink-500">{note}</span>
    </div>
  );
}

function Row({
  left,
  right,
  strong = false,
  muted = false,
}: {
  left: string;
  right: React.ReactNode;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className={`text-[12px] ${muted ? 'text-ink-400' : 'text-ink-300'}`}>{left}</span>
      <span
        className={`num ${strong ? 'text-base font-bold' : 'text-[13px] font-semibold'} ${
          muted ? 'text-ink-400' : 'text-ink-100'
        }`}
      >
        {right}
      </span>
    </div>
  );
}
