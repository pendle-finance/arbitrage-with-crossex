/** Where the locked spread comes from: one row per Boros leg.
 *
 * The card states a single percentage. That number is the weighted result of
 * two or four legs, each locked at its own rate, on its own size, over its own
 * window — so "why this number?" is answered by showing the legs, not by
 * describing them. Sides are coloured the way they are everywhere else in the
 * app, and the amount carries its own sign: a trader reads the shape of the
 * trade before reading a word of it. */
import { SignedNumber } from '../components/SignedNumber';
import { microLabelClass } from '../components/Th';
import { SideVenue } from '../components/VenueChip';
import { fmtDateUtc, fmtPct, fmtUsd, fmtUsdCompact, prettyVenue } from '../lib/fmt';

export interface SpreadLeg {
  venue: string;
  side: 'LONG' | 'SHORT';
  /** The fixed rate this leg locked at entry. */
  apr: number;
  notionalUsd: number;
  startSec: number;
  endSec: number;
  days: number;
  /** What this leg alone is worth by its maturity — negative when it pays. */
  usd: number;
  /** This leg's own open date is unknown, so it accrues from the position
   * start instead. Marked, never applied silently. */
  datedFromPosition: boolean;
}

export function SpreadBreakdown({
  legs,
  totalUsd,
  clockNote,
}: {
  legs: readonly SpreadLeg[];
  totalUsd: number;
  clockNote: string;
}) {
  const anyUndated = legs.some((l) => l.datedFromPosition);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className={microLabelClass}>Each leg&rsquo;s locked rate</span>
        <span className={microLabelClass}>By maturity</span>
      </div>
      {legs.map((l, i) => (
        <div
          key={`${l.venue}-${l.side}-${i}`}
          className="flex items-center gap-2 border-t border-ink-800 py-1 text-[11px] first:border-t-0"
        >
          {/* Never shrinks: "SHORT · Hyperliquid" wrapped to two lines and
              took the row's numbers out of line with the row above it. */}
          <span className="shrink-0 whitespace-nowrap">
            <SideVenue side={l.side} venue={prettyVenue(l.venue)} />
          </span>
          <span className="flex-1" />
          <span className="num w-[86px] shrink-0 text-right">
            <span className="text-ink-500">{l.side === 'SHORT' ? 'gets' : 'pays'} </span>
            <span className="text-ink-100">{fmtPct(l.apr)}</span>
          </span>
          <span className="num w-[52px] shrink-0 text-right text-ink-400">
            {fmtUsdCompact(l.notionalUsd)}
          </span>
          {/* The window a leg accrues over, as the figure that varies between
              legs. The dates themselves sit in the title: two ISO dates per row
              is most of the card's width spent on the part that rarely differs. */}
          <span
            className={`num w-[42px] shrink-0 text-right ${
              l.datedFromPosition ? 'text-amber-300/80' : 'text-ink-500'
            }`}
            title={`${fmtDateUtc(l.startSec)} → ${fmtDateUtc(l.endSec)}${
              l.datedFromPosition ? ' · open date unknown, so it accrues from the position start' : ''
            }`}
          >
            {l.days}d
          </span>
          <SignedNumber
            value={l.usd}
            format={(n) => fmtUsd(n, 0)}
            className="num w-[66px] shrink-0 text-right font-medium"
          />
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-ink-700 pt-1.5 text-[11px]">
        <span className="text-ink-300">Spread return</span>
        <SignedNumber
          value={totalUsd}
          format={(n) => fmtUsd(n, 0)}
          className="num font-semibold"
        />
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-ink-500">
        {clockNote}
        {anyUndated && <span className="text-amber-300/80"> Amber: open date unknown.</span>}
      </p>
    </div>
  );
}
