import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';
import { Skeleton } from '../components/Skeleton';
import { fmtDateUtc, fmtNotionalShort, prettyVenue } from '../lib/fmt';
import {
  LANDING_NOTIONAL_USD,
  positiveOnly,
  rankOpportunities,
  useLandingOpportunities,
} from './landingOpportunities';

/**
 * A shop-window list of the best live spreads — deliberately NOT
 * OpportunitiesPanel. That panel is a trading tool: notional/entry/exit
 * knobs, expandable leg breakdowns, an Execute button that prefills a ticket.
 * None of that belongs on a page nobody is logged into. Five rows, one number
 * each, fixed at one notional, no controls.
 *
 * Positive spreads only (see positiveOnly) — a shop window lists what's
 * actually executable. The hero above still shows the true best number even
 * when that's negative, so nothing is hidden, just not shelved as an offer.
 */
export function TopOpportunities() {
  const query = useLandingOpportunities();
  const ranked = positiveOnly(rankOpportunities(query.data?.groups)).slice(0, 5);

  return (
    <section className="mx-auto w-full max-w-3xl px-1">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-ink-100">Live spreads</h2>
        <span className="text-xs text-ink-400">
          at {fmtNotionalShort(LANDING_NOTIONAL_USD)} notional per leg
        </span>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card flex items-center justify-between gap-4 px-4 py-3.5">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-4 w-64" />
            </div>
          ))}
        </div>
      ) : query.isError && !query.data ? (
        <QueryError
          title="Couldn't load live spreads"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : ranked.length === 0 ? (
        <EmptyState
          icon="◎"
          title="Nothing pays after costs right now"
          hint="Spreads exist, but execution costs eat them at this size. This list is live."
        />
      ) : (
        <ol className="flex flex-col gap-2">
          {ranked.map(({ group, pair, aprOnCapital }, i) => (
            <li
              key={`${group.tokenId}:${group.maturity}:${group.underlying}`}
              className="card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5"
            >
              <div className="flex items-center gap-3">
                {/* Always positive here — positiveOnly() filtered the rest. */}
                <span className="num text-2xl font-bold leading-none tracking-tight text-emerald-400 sm:text-[28px]">
                  +{(aprOnCapital * 100).toFixed(1)}%
                </span>
                <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[10px] font-semibold text-ink-300">
                  {pair.base}
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-300 sm:justify-end">
                <span className="text-emerald-400/90">
                  receive {prettyVenue(pair.shortLeg.venue)}
                </span>
                <span className="text-ink-500">/</span>
                <span className="text-rose-400/90">pay {prettyVenue(pair.longLeg.venue)}</span>
                <span className="text-ink-500">·</span>
                <span title={`Matures ${fmtDateUtc(group.maturity)} UTC`}>
                  {Math.max(1, Math.round(group.secondsToMaturity / 86_400))}d
                </span>
                <span className="text-ink-500">·</span>
                <span className="num text-ink-400">
                  {pair.capitalUsd !== null ? `~${fmtNotionalShort(pair.capitalUsd)} cap` : '— cap'}
                </span>
              </div>
              {/* Rank shown only 4th+ — the top card's size already says "#1". */}
              {i >= 3 && <span className="num shrink-0 text-[10px] text-ink-500">#{i + 1}</span>}
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 text-center text-[11px] leading-relaxed text-ink-500">
        Net fixed spread on capital, leverage included. Not a quote. Rates move.
      </p>
    </section>
  );
}
