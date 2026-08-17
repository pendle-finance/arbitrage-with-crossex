import { LandingOnboardingGuide } from '../panels/LandingOnboardingGuide';
import { OpportunitiesPanel } from '../panels/OpportunitiesPanel';

/**
 * The deep view behind the hero's "Show me more".
 *
 * Every live pair rather than the hero's top three, with the terminal's own
 * "with these assumptions" strip on top so a visitor can re-price the whole
 * list at their own size and fee tier. That strip is the reason this view
 * exists: the hero's number is one fixed assumption set, and the honest answer
 * to "is that real for me?" is to let them change it.
 *
 * `unconfigured` is the no-keys mode `App.tsx` already uses for a fresh
 * install. On the landing build the panel also drops its Execute buttons
 * entirely (see IS_LANDING in OpportunitiesPanel) — executing needs the
 * terminal running locally, so the control could only ever be dead here. The
 * setup rail on the right is the real next step. Nothing on this page can place
 * an order, and no credential surface is reachable — the same guarantee the
 * rest of the landing bundle makes.
 */
export function RatesExplorer({ onBack }: { onBack: () => void }) {
  return (
    <section className="flex w-full flex-col gap-5 px-1">
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex w-fit items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:border-ink-500 hover:text-ink-100"
        >
          <span aria-hidden="true">←</span> Back
        </button>

        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink-100 sm:text-3xl">
            Every live spread
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-ink-400">
            Priced at your size and fee tier. Open{' '}
            <span className="font-semibold text-ink-200">with these assumptions</span> to change
            them — every card re-prices.
          </p>
        </div>
      </div>

      {/* Rates left, setup rail right — the original public-site layout.
          Stacked below lg: the rail is a fixed 360px that cannot shrink, so in
          a row it left the content column max(0, VW-420) — 0px on a phone, with
          the sticky rail painting over the Execute buttons underneath. Rates
          lead; guide follows. */}
      <div className="flex w-full flex-col gap-5 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <OpportunitiesPanel unconfigured />
        </div>
        <LandingOnboardingGuide />
      </div>
    </section>
  );
}
