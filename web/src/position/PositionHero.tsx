/** Hero tier — mirrors the terminal StrategyCard's tier 1 (Fixed APR on
 * capital · Capital · PnL by maturity · Current PnL) with the self-reported
 * disclaimer ALWAYS visible beside the headline: a stateless page cannot
 * verify anything a link claims. */
import { Chip } from '../components/Chip';
import { SignedNumber } from '../components/SignedNumber';
import { Stat } from '../components/Stat';
import { SideVenue } from '../components/VenueChip';
import { fmtPct, fmtUsd, prettyVenue } from '../lib/fmt';
import type { SharePayloadV1 } from '../lib/shareCodec';
import type { ExitMode, PositionView } from './derive';
import { ExitModeToggle } from './ExitModeToggle';

export function PositionHero({
  p,
  view,
  exitMode,
  sharedMode,
  onExitModeChange,
}: {
  p: SharePayloadV1;
  view: PositionView;
  exitMode: ExitMode;
  sharedMode: ExitMode;
  onExitModeChange: (next: ExitMode) => void;
}) {
  return (
    <section className="card p-3 sm:p-5">
      {/* Title + the opportunity card's compact pair identity: the base badge
          with the short venue stacked over the long one. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-ink-100">
          {p.l.length}-legged Fixed-rate Funding Arbitrage
        </h1>
        <span className="flex items-center gap-2.5">
          <span
            className="num flex h-6 w-6 items-center justify-center rounded-md border border-ink-700 bg-ink-800 text-[9px] font-semibold leading-none text-ink-300"
            title={`${p.b} funding rate`}
          >
            {p.b}
          </span>
          {view.columns.length === 2 && (
            <span className="flex flex-col gap-0.5">
              {view.columns.map((c) => (
                <SideVenue
                  key={c.venue}
                  side={(c.boros?.s ?? c.perp?.s) === 'S' ? 'SHORT' : 'LONG'}
                  venue={prettyVenue(c.venue)}
                />
              ))}
            </span>
          )}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
        <Stat label="Fixed APR on capital" hero>
          <SignedNumber value={p.a} format={(n) => fmtPct(n)} className="text-cyan-300" />
        </Stat>
        <Stat label="Capital">
          <span className="num">{fmtUsd(p.c, 0)}</span>
        </Stat>
        <Stat label={view.matured ? 'PnL (was projected at maturity)' : 'PnL by maturity'}>
          <SignedNumber value={p.p} format={(n) => fmtUsd(n, 0)} />
        </Stat>
      </div>

      <div className="mt-3 text-xs text-ink-400">
        <span className="num text-ink-300">{fmtPct(p.sp)}</span> spread locked until maturity
      </div>

      {/* The same state as the PnL section's toggle — the numbers above follow
          it. The hedge verdict rides the row's right edge. */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <ExitModeToggle
          exitMode={exitMode}
          sharedMode={sharedMode}
          onChange={onExitModeChange}
          hideLabelOnPhone
        />
        <span className="flex items-center gap-2">
          {view.matured && (
            <Chip sm tone="amber" title="The Boros legs' maturity has passed since this was shared">
              Matured since sharing
            </Chip>
          )}
          <Chip sm tone={p.h === 'h' ? 'green' : 'amber'}>
            {view.hedgeLabel}
            {p.h === 'h' ? ' ✓' : ''}
          </Chip>
        </span>
      </div>

      <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300/90">
        Self-reported by the sharer's own terminal — numbers are a snapshot from{' '}
        {view.sharedOnLabel} and are not verified by this site. Nothing here is investment advice.
      </div>
    </section>
  );
}
