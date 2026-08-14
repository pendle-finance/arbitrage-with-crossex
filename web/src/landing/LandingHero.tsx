import { LiveRatesPanel } from './LiveRatesPanel';

/**
 * Hero: the pitch on the left, every live figure on the right.
 *
 * The panel owns all of it — the number, the venues behind it, the leverage,
 * and the other spreads. The left column names the trade and gets out of the
 * way. Splitting a claim from its own terms across a 1200px row (the number
 * right, "receiving on X, paying on Y" left) read as two unrelated blocks.
 *
 * No data hook here at all: nothing on this side is live.
 */
export function LandingHero() {
  return (
    <section className="grid grid-cols-1 items-center gap-8 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] lg:gap-12">
      <div className="flex flex-col items-start gap-5">
        <span className="chip chip-sm border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          Live on Boros × Gate CrossEx
        </span>

        <h1 className="text-[38px] font-bold leading-[1.06] tracking-tight text-ink-100 sm:text-[46px]">
          Cross Exchange funding rate arbitrage.
          <span className="block text-emerald-400">Leveraged.</span>
        </h1>

        <p className="text-lg font-semibold leading-snug text-ink-200 sm:text-xl">
          Delta neutral, fixed to maturity, simply earn.
        </p>

        <a href="#three-things" className="btn btn-primary px-6 py-2.5 text-sm font-semibold">
          Show me how ↓
        </a>
      </div>

      <LiveRatesPanel />
    </section>
  );
}
