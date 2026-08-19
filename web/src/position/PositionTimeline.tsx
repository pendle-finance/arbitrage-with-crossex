/** Start → shared → maturity bar (a simplified port of StrategyCard's
 * timeline — house style: hand-rolled divs). Falls back to a shared→maturity
 * two-point bar when the payload carries no clock start. */
import { fmtDateUtc } from '../lib/fmt';
import type { SharePayloadV1 } from '../lib/shareCodec';
import type { PositionView } from './derive';

export function PositionTimeline({ p, view }: { p: SharePayloadV1; view: PositionView }) {
  const start = p.cs !== null && p.cs < p.t ? p.cs : p.t;
  const span = Math.max(1, p.m - start);
  const sharedPct = Math.min(100, Math.max(0, ((p.t - start) / span) * 100));

  return (
    <section className="card p-3 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-ink-500">
        {/* nowrap: a date broken at its hyphen reads as two dates. */}
        <span className="whitespace-nowrap">
          {p.cs !== null ? `opened ${fmtDateUtc(start)}` : `shared ${fmtDateUtc(p.t)}`}
        </span>
        <span>
          {view.matured
            ? `matured ${view.maturityLabel}`
            : `matures ${view.maturityLabel} · ${view.daysLeftAtShare}d left at share time`}
        </span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-ink-800">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-cyan-500/50"
          style={{ width: `${sharedPct}%` }}
          data-progress="maturity"
        />
        <div
          className="absolute top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded bg-cyan-300"
          style={{ left: `${sharedPct}%` }}
          title="When this position was shared"
        />
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-cyan-300/90">
        <span className="absolute -translate-x-1/2" style={{ left: `${sharedPct}%` }}>
          shared
        </span>
      </div>
    </section>
  );
}
