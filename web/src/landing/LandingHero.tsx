import { rankOpportunities, useLandingOpportunities } from './landingOpportunities';

/**
 * The number-leads hero, and almost nothing else: chip, number, one label,
 * one CTA. Everything that used to explain or qualify the number — venues,
 * rates, leverage, maturity, capital — now lives in MechanismDiagram directly
 * below, which renders the SAME best pair. Prose around a hero number competes
 * with it; the diagram doesn't.
 *
 * The sign is still shown honestly: on a day when the best pair's execution
 * costs exceed its spread, the number is red rather than hidden or swapped for
 * a stale positive one. (The list below drops negatives — a shop window only
 * shows what's executable — but the headline number tells the truth.)
 */
export function LandingHero() {
  const query = useLandingOpportunities();
  const best = rankOpportunities(query.data?.groups)[0] ?? null;
  const negative = best !== null && best.aprOnCapital < 0;

  return (
    <section className="flex flex-col items-center gap-4 pb-0 pt-4 text-center sm:pt-6">
      <span className="chip chip-sm border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
        Live on Boros × Gate CrossEx
      </span>

      {query.isPending ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="h-24 w-72 max-w-full animate-pulse rounded-2xl bg-ink-800/60 sm:h-32 sm:w-96" />
          <div className="h-4 w-56 animate-pulse rounded bg-ink-800/60" />
        </div>
      ) : best ? (
        <div className="flex flex-col items-center">
          <span
            className={`num text-[96px] font-extrabold leading-none tracking-tight sm:text-[136px] ${
              negative ? 'text-rose-400' : 'text-emerald-400'
            }`}
            title="Net fixed spread on capital, leverage included. Receive-fixed rate minus pay-fixed rate, annualized on the capital the trade posts."
          >
            {negative ? '' : '+'}
            {(best.aprOnCapital * 100).toFixed(1)}
            <span className="text-[0.5em] font-bold">%</span>
          </span>
          <span className="-mt-2 text-sm font-semibold uppercase tracking-[0.2em] text-ink-400 sm:text-base">
            {negative ? 'Best live spread — costs win today' : 'Fixed APR on capital, right now'}
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 py-6">
          <span className="num text-5xl font-bold text-ink-500">—% APR</span>
          <p className="max-w-md text-sm text-ink-400">
            {query.isError
              ? "Couldn't reach the live feed. It retries automatically."
              : 'No spread is pricing right now.'}
          </p>
        </div>
      )}

      <a href="#three-things" className="btn btn-primary px-6 py-2.5 text-sm font-semibold">
        Show me how to get it ↓
      </a>
    </section>
  );
}
