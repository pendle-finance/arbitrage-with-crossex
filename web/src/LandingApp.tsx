import { BrandMark } from './components/BrandMark';
import { Faq } from './landing/Faq';
import { LandingHero } from './landing/LandingHero';
import { MechanismDiagram } from './landing/MechanismDiagram';
import { ThreeThings } from './landing/ThreeThings';
import { REPO_URL } from './lib/landing';

/**
 * Top to bottom: a split hero — title and short description of strategy on the
 * left, a shop-window list of live spreads that pay on the right with best
 * highlighted → that same pair broken open as a 4-leg diagram → "3 things 
 * you need", the only setup surface on the page → an FAQ holding every caveat.
 *
 * The public landing view with every credential surface removed — no settings
 * drawer, no account pollers, no key input anywhere. Reached only through
 * main-landing.tsx, so the terminal bundle never includes it and this bundle
 * never includes the credentials form. TradeFlowProvider is gone too: its only
 * job here was the Execute→guide nudge, and neither end of that flow still
 * exists on this page.
 */
export function LandingApp() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <BrandMark />
          <div className="ml-auto flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-ink-300 bg-ink-900 px-2.5 py-1 text-sm text-ink-300 transition-colors hover:border-ink-100 hover:text-ink-100"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </header>

      {/* Section rhythm is deliberately tighter than the usual landing-page
          80px: these sections are short (the hero is ~330px), and a gap that
          approaches a section's own height reads as the page having stalled
          rather than as breathing room. */}
      {/* One width on the MAIN column, not per section: the hero used to run
          the full 1500px while the blocks below sat at 768-1024, so nothing
          lined up vertically. Setting it here means every block shares an edge
          and none of them can drift apart again. 1200 over Tailwind's 5xl
          (1024), which left the three setup cards visibly cramped. */}
      <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-10 px-5 py-8 sm:gap-16 sm:py-10">
        {/* Hero = pitch + the live number AND the spreads behind it, one card.
              The mechanism diagram follows as the answer to "how", explaining
              the same pair the panel just headlined. */}
        <LandingHero />
        <MechanismDiagram />
        <ThreeThings />
        <Faq />
      </main>

      <footer className="border-t border-ink-800 px-5 py-6 text-center text-[11px] text-ink-500">
        Free, open source, experimental software. It places real orders with
        real funds and can lose money. Nothing here is financial, investment, legal or tax advice.
      </footer>
    </div>
  );
}
