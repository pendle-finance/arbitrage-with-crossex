import { fmtDateUtc, fmtNotionalShort, prettyVenue } from '../lib/fmt';
import { LANDING_NOTIONAL_USD, rankOpportunities, useLandingOpportunities } from './landingOpportunities';

/**
 * The number-leads hero: the single best live spread, blown up to the size a
 * marketing page gives its one claim, with the receipts (coin, venues,
 * maturity, capital) underneath so it's checkable, not just asserted.
 *
 * Spreads flip negative when the fixed rate paid exceeds the one received —
 * live right now, some groups price positive and some negative (see
 * landingOpportunities.ts). The hero always shows the actual best number,
 * whichever sign it has: red and labelled plainly when it's negative, never
 * hidden or swapped for a stale positive figure.
 */
export function LandingHero() {
  const query = useLandingOpportunities();
  const best = rankOpportunities(query.data?.groups)[0] ?? null;
  const negative = best !== null && best.aprOnCapital < 0;

  return (
    <section className="flex flex-col items-center gap-5 pb-0 pt-4 text-center sm:pt-6">
      <span className="chip chip-sm border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
        Live on Boros × Gate CrossEx
      </span>

      <h1 className="max-w-xl text-balance text-[15px] font-medium leading-snug text-ink-300 sm:text-lg">
        Receive a fixed funding rate on one venue. Pay a lower one on another. Keep the spread,
        leveraged.
      </h1>

      {/* The hero number itself. Loading and error states keep the exact same
          layout slot so the page never jumps once real data lands. */}
      {query.isPending ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="h-24 w-72 max-w-full animate-pulse rounded-2xl bg-ink-800/60 sm:h-32 sm:w-96" />
          <div className="h-4 w-56 animate-pulse rounded bg-ink-800/60" />
        </div>
      ) : best ? (
        <>
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
              {negative ? 'Best live spread. Pay side wins right now.' : 'Fixed APR on capital, right now'}
            </span>
          </div>

          {negative && (
            <p className="max-w-md text-xs leading-relaxed text-amber-400/90">
              No venue pair prices positive this second. This list is live.
            </p>
          )}

          {/* Receipts: coin, receive venue, pay venue, leverage, maturity, capital —
              what a skeptic checks before believing the number above. Leverage is
              stated explicitly here because the hero number cannot be reconstructed
              from the spread alone without it (see MechanismDiagram's "before
              leverage" line just below). */}
          <p className="max-w-xl text-sm leading-relaxed text-ink-300 sm:text-[15px]">
            <span className="num font-semibold text-ink-100">{best.pair.base}</span>: receive fixed
            on <span className="font-medium text-ink-100">{prettyVenue(best.pair.shortLeg.venue)}</span>,
            pay fixed on <span className="font-medium text-ink-100">{prettyVenue(best.pair.longLeg.venue)}</span>,
            at{' '}
            {best.pair.effectiveLeverage !== null ? (
              <>
                <span className="num font-semibold text-ink-100">
                  {best.pair.effectiveLeverage.toFixed(1)}x
                </span>{' '}
                leverage
              </>
            ) : (
              'live leverage'
            )}
            . Matures <span className="text-ink-100">{fmtDateUtc(best.group.maturity)}</span>.{' '}
            <span className="num text-ink-100">
              {best.pair.capitalUsd !== null ? `~${fmtNotionalShort(best.pair.capitalUsd)}` : '—'}
            </span>{' '}
            capital, {fmtNotionalShort(LANDING_NOTIONAL_USD)} notional per leg.
          </p>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 py-6">
          <span className="num text-5xl font-bold text-ink-500">—% APR</span>
          <p className="max-w-md text-sm text-ink-400">
            {query.isError
              ? "Couldn't reach the live feed. The list below will retry automatically."
              : 'No spread is pricing right now. This list refreshes live.'}
          </p>
        </div>
      )}

      <a href="#three-things" className="btn btn-primary px-6 py-2.5 text-sm font-semibold">
        Show me how to get it ↓
      </a>
    </section>
  );
}
