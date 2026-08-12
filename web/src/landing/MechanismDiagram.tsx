/**
 * The 4-leg structure, as a diagram instead of a paragraph. Two perp legs
 * (opposite sides, two venues) cancel price risk. Two Boros legs (one per
 * venue, opposite side to that venue's perp) cancel each perp's floating
 * funding. What's left: the gap between the two FIXED rates.
 *
 * Static and illustrative — not tied to live data (the hero and the list
 * below carry the real numbers). Uses the same Hyperliquid/OKX example as the
 * knowledge base's worked example, so the venue names echo the hero's real
 * Hyperliquid/Binance pair instead of reading as an abstract "Venue A/B".
 * Labelled "example, not live" so the 8%/3% numbers never read as a quote.
 * Raised contrast (brighter border/heading, no longer a low-contrast
 * afterthought) since this box is what makes the hero number believable.
 */
export function MechanismDiagram() {
  return (
    <section className="mx-auto w-full max-w-3xl px-1">
      <div className="card border-ink-700 bg-ink-900/60 p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-ink-200">
            How the spread is built
          </span>
          <span className="text-[10.5px] text-ink-500">example, not live</span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          {/* Venue A: receive fixed */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
              Hyperliquid
            </span>
            <Leg label="Short perp" note="cancels price risk" />
            <Leg label="Short fixed on Boros, 8%" note="cancels floating funding" tone="emerald" />
          </div>

          <span
            aria-hidden="true"
            className="justify-self-center text-lg font-bold text-ink-500 sm:rotate-0"
          >
            −
          </span>

          {/* Venue B: pay fixed */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-400">
              OKX
            </span>
            <Leg label="Long perp" note="cancels price risk" />
            <Leg label="Long fixed on Boros, 3%" note="cancels floating funding" tone="rose" />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2.5 text-center">
          <span className="text-[13px] text-ink-300">Price risk: 0. Funding risk: 0. Left:</span>
          <span className="num text-base font-bold text-cyan-300">8% − 3% = 5% APR</span>
          <span className="text-[13px] text-ink-300">on notional, before leverage.</span>
        </div>
      </div>
    </section>
  );
}

function Leg({
  label,
  note,
  tone = 'neutral',
}: {
  label: string;
  note: string;
  tone?: 'emerald' | 'rose' | 'neutral';
}) {
  const dot =
    tone === 'emerald' ? 'bg-emerald-400' : tone === 'rose' ? 'bg-rose-400' : 'bg-ink-500';
  return (
    <div className="flex items-baseline gap-2">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="text-[12.5px] text-ink-100">{label}</span>
      <span className="text-[10.5px] text-ink-500">{note}</span>
    </div>
  );
}
