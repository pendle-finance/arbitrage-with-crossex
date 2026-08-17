import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';
import { Skeleton } from '../components/Skeleton';
// Imported, not modified: the terminal's own pair-identity chip, so the landing
// presents a long/short pair in exactly the shape the app does.
import { SideVenue } from '../components/VenueChip';
import { fmtDateUtc, prettyVenue } from '../lib/fmt';
import { positiveOnly, rankOpportunities, useLandingOpportunities } from './landingOpportunities';

/**
 * The hero's right-hand panel: the headline number and the spreads behind it,
 * in one card.
 *
 * They were two sections before, which meant the number and the list it came
 * from were separated by a screen of whitespace and repeated the same top row
 * twice. Together, the first row IS the headline — the reader sees the claim
 * and its evidence without scrolling.
 *
 * The list is positives-only (see positiveOnly): a shop window shelves what's
 * executable. The big number above it is unfiltered, so on a day when the best
 * pair's costs beat its spread the headline goes red and says so — nothing is
 * hidden, it just isn't listed as an offer.
 */
export function LiveRatesPanel({ onExplore }: { onExplore: () => void }) {
  const query = useLandingOpportunities();
  // One ranking, reused. Calling rankOpportunities twice built two sets of
  // objects, so an identity filter against `best` silently matched nothing and
  // the headline pair was listed again below itself.
  const ranked = rankOpportunities(query.data?.groups);
  const best = ranked[0] ?? null;
  const negative = best !== null && best.aprOnCapital < 0;
  // Skip the row the headline already IS. On a negative day `best` is filtered
  // out of `positiveOnly` anyway, so nothing is dropped that isn't shown above.
  const rows = positiveOnly(ranked)
    .filter((r) => r !== best)
    .slice(0, 3);

  return (
    <div className="card flex flex-col gap-4 px-5 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-col items-center gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-400">
          {negative ? 'Best live spread, costs win today' : 'Fixed APR, right now'}
        </span>

        {query.isPending ? (
          <Skeleton className="my-1 h-14 w-56 sm:h-16 sm:w-64" />
        ) : best ? (
          // Base sits beside the number, matching the "Also live" rows below,
          // so every rate on this panel is labelled the same way.
          <span className="flex items-baseline gap-2.5">
            <span
              className={`num text-[52px] font-extrabold leading-none tracking-tight sm:text-[64px] ${
                negative ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {negative ? '' : '+'}
              {(best.aprOnCapital * 100).toFixed(1)}%
            </span>
            <span
              className="num flex h-6 w-6 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[9px] font-semibold leading-none text-ink-300"
              title={`${best.pair.base} funding rate`}
            >
              {best.pair.base}
            </span>
            {/* Days to maturity, same unit as the rows below: an APR with no
                term attached is only half a quote. */}
            <span
              className="num text-xs text-ink-500"
              title={`Matures ${fmtDateUtc(best.group.maturity)} UTC`}
            >
              {Math.max(1, Math.round(best.group.secondsToMaturity / 86_400))}d
            </span>
          </span>
        ) : (
          <span className="num text-[52px] font-extrabold leading-none tracking-tight text-ink-600 sm:text-[64px]">
            —%
          </span>
        )}

        {/* The pair identity in the terminal's own chips (SideVenue), but on ONE
            line — stacked, they turned a one-line summary into a block and
            pushed the divider down. Leverage is deliberately absent: the
            diagram below shows it as a step in the math. */}
        {best && (
          <span className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            <SideVenue side="SHORT" venue={prettyVenue(best.pair.shortLeg.venue)} />
            <SideVenue side="LONG" venue={prettyVenue(best.pair.longLeg.venue)} />
          </span>
        )}
      </div>

      <div className="border-t border-ink-800" />

      <div className="flex flex-col gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-400">
          Also live
        </span>

        {query.isPending ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between gap-4">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-4 w-40" />
              </div>
            ))}
          </div>
        ) : query.isError && !query.data ? (
          <QueryError
            title="Couldn't load live spreads"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="◎"
            title="Nothing pays after costs right now"
            hint="Spreads exist, but execution costs eat them at this size. This list is live."
          />
        ) : (
          <ol className="flex flex-col gap-2.5">
            {rows.map(({ group, pair, aprOnCapital }) => (
              <li
                key={`${group.tokenId}:${group.maturity}:${group.underlying}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
              >
                <span className="flex items-center gap-2">
                  {/* Always positive here — positiveOnly() filtered the rest. */}
                  <span className="num text-xl font-bold tracking-tight text-emerald-400">
                    +{(aprOnCapital * 100).toFixed(1)}%
                  </span>
                  <span
                    className="num flex h-5 w-5 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[8px] font-semibold leading-none text-ink-300"
                    title={`${pair.base} funding rate`}
                  >
                    {pair.base}
                  </span>
                  <span className="text-[11px] text-ink-500">
                    {Math.max(1, Math.round(group.secondsToMaturity / 86_400))}d
                  </span>
                </span>
                <span
                  className="flex items-center gap-1.5"
                  title={`Receive fixed on ${prettyVenue(pair.shortLeg.venue)}, pay fixed on ${prettyVenue(pair.longLeg.venue)}. Matures ${fmtDateUtc(group.maturity)} UTC.`}
                >
                  <SideVenue side="SHORT" venue={prettyVenue(pair.shortLeg.venue)} />
                  <SideVenue side="LONG" venue={prettyVenue(pair.longLeg.venue)} />
                </span>
              </li>
            ))}
          </ol>
        )}

        {/* A real button rather than a click handler on the whole card: the
            rows above carry their own title tooltips, and a card-wide click
            target would swallow them and leave the panel unreachable by
            keyboard. Shown even when the list is empty or errored — the deep
            view has the assumptions strip, which is exactly what a visitor
            wants when nothing prices at this size. */}
        <button
          type="button"
          onClick={onExplore}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs font-semibold text-ink-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-200"
        >
          Show me more
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
