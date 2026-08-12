import { BrandMark } from './components/BrandMark';
import { LandingHero } from './landing/LandingHero';
import { MechanismDiagram } from './landing/MechanismDiagram';
import { ThreeThings } from './landing/ThreeThings';
import { TopOpportunities } from './landing/TopOpportunities';
import { TrustSection } from './landing/TrustSection';
import { REPO_URL } from './lib/landing';
import { LandingOnboardingGuide } from './panels/LandingOnboardingGuide';
import { TradeFlowProvider } from './trade/TradeFlow';

/**
 * Variant A — "the number leads": a conversion-oriented scroll narrative
 * rather than the terminal's own layout wearing a public hat.
 *
 * The trade is 4 legs across 2 venues: a perp pair (short one venue, long the
 * other — cancels price risk) and a Boros fixed-rate pair (one per venue,
 * hedging each perp's floating funding). What's left is the gap between the
 * two fixed rates, leveraged by the perp legs. `netFixedAprOnCapital` already
 * encodes all of it — see MechanismDiagram for the picture.
 *
 * Top to bottom: hero (the single best live spread, positive or negative — see
 * LandingHero for the negative case) → a static diagram of the 4-leg
 * structure → a skimmable shop-window list of live spreads → "3 things you
 * need" as parallel CTA cards → concerns/trust → the full step-by-step guide
 * for anyone who's decided and wants the mechanics.
 *
 * The public landing view with every credential surface removed — no settings
 * drawer, no account pollers, no key input anywhere. Reached only through
 * main-landing.tsx, so the terminal bundle never includes it and this bundle
 * never includes the credentials form. TradeFlowProvider mounts no queries; it
 * only carries the Execute→guide nudge (LandingOnboardingGuide still uses it).
 */
export function LandingApp() {
  return (
    <TradeFlowProvider>
      <div className="flex min-h-full flex-col">
        <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
            <BrandMark />
            <div className="ml-auto flex items-center gap-2">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1 text-sm text-ink-400 transition-colors hover:border-ink-500 hover:text-ink-100"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-16 px-5 py-8 sm:gap-20 sm:py-12">
          {/* Hero + mechanism box are one argument (the number, then why it's
              true), so they sit close together with their own tight gap instead
              of the page's normal section rhythm — and both need to clear the
              1440x1000 fold together. */}
          <div className="flex flex-col gap-4 sm:gap-5">
            <LandingHero />
            <MechanismDiagram />
          </div>
          <TopOpportunities />
          <ThreeThings />
          <TrustSection />

          {/* The closer: same step rail as before, now reached by a visitor who
              has already decided and scrolled this far for the mechanics —
              not competing with the pitch above it for attention. */}
          <section className="mx-auto w-full max-w-3xl">
            <h2 className="mb-1.5 text-center text-2xl font-extrabold tracking-tight text-ink-100 sm:text-3xl">
              Ready? Here's every step
            </h2>
            <p className="mb-3 text-center text-sm text-ink-400">
              The three things above, in full: every click, in order.
            </p>
            <LandingOnboardingGuide />
          </section>
        </main>

        <footer className="border-t border-ink-800 px-5 py-6 text-center text-[11px] text-ink-500">
          Free, open source, experimental software — not a Pendle product. It places real orders
          with real funds and can lose money. Nothing here is financial, investment, legal or tax
          advice.
        </footer>
      </div>
    </TradeFlowProvider>
  );
}
