/** The public shared-position page (`crossexboros.com/position?d=…`).
 *
 * Fully static from the URL payload: the codec's strict schema is the only
 * input validation needed, decoded strings render exclusively as React text
 * (no dangerouslySetInnerHTML anywhere in this module graph), and the page
 * builds NO links from payload data — every href is hardcoded. Reached only
 * through main-position.tsx, so the credentials/trading UI is never in this
 * bundle. Educational by design: the collapsibles teach how a 4-leg position
 * works, using this position's own numbers. */
import { useState } from 'react';
import { BrandMark } from './components/BrandMark';
import { REPO_URL } from './lib/landing';
import { decodeSharePayload } from './lib/shareCodec';
import { applyExitMode, derivePositionView, type ExitMode } from './position/derive';
import { EduSections } from './position/EduSections';
import { InvalidLink } from './position/InvalidLink';
import { LegDiagram } from './position/LegDiagram';
import { PositionBreakdowns } from './position/PositionBreakdowns';
import { PositionHero } from './position/PositionHero';
import { PositionTimeline } from './position/PositionTimeline';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 px-3 py-3 sm:px-5">
          <BrandMark />
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/"
              className="btn btn-primary px-4 font-semibold shadow-[0_0_14px_rgba(34,211,238,0.25)] transition-shadow hover:shadow-[0_0_22px_rgba(34,211,238,0.45)]"
            >
              Check out the tool →
            </a>
          </div>
        </div>
      </header>
      {/* The page gutter collapses on phones — every horizontal pixel goes to
          the 2×2 leg grid. */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-2 py-6 sm:px-5">
        {children}
      </main>
    </div>
  );
}

function CtaFooter() {
  return (
    <section className="card p-3 text-center sm:p-5">
      <p className="text-sm leading-relaxed text-ink-300">
        This position was executed with Pendle&apos;s free, open-source{' '}
        <span className="font-semibold text-ink-100">CrossEx-Boros Terminal</span> — it runs on
        your own machine, and your keys never leave it.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <a href="/" className="btn btn-primary px-4 font-semibold">
          Explore live opportunities →
        </a>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn">
          View on GitHub
        </a>
      </div>
    </section>
  );
}

export function PositionApp({ search }: { search?: string }) {
  const raw = new URLSearchParams(search ?? window.location.search).get('d');
  const dec = decodeSharePayload(raw ?? '');
  // The viewer's "At maturity" choice; null = the sharer's own assumption.
  // Declared before the early return (rules of hooks).
  const [exitOverride, setExitOverride] = useState<ExitMode | null>(null);

  if (!dec.ok) {
    return (
      <Shell>
        <InvalidLink reason={raw === null || raw === '' ? 'missing' : dec.reason} />
        <CtaFooter />
      </Shell>
    );
  }

  // Every section below renders the SAME adjusted payload, so flipping the
  // toggle moves the hero, captions, breakdowns, and explainers together.
  const sharedMode: ExitMode = dec.payload.cx === 1 ? 'close' : 'roll';
  const exitMode = exitOverride ?? sharedMode;
  const p = applyExitMode(dec.payload, exitMode);
  const view = derivePositionView(p, Math.floor(Date.now() / 1000));

  return (
    <Shell>
      {/* The lead-in rides above the first card, in the brand highlight. */}
      <div className="-mb-1 px-1 text-lg font-semibold text-cyan-300">
        Someone shared their position:
      </div>
      <PositionHero
        p={p}
        view={view}
        exitMode={exitMode}
        sharedMode={sharedMode}
        onExitModeChange={setExitOverride}
      />
      <PositionTimeline p={p} view={view} />
      <LegDiagram view={view} />
      <PositionBreakdowns
        p={p}
        exitMode={exitMode}
        sharedMode={sharedMode}
        onExitModeChange={setExitOverride}
      />
      <EduSections p={p} view={view} />
      <CtaFooter />
    </Shell>
  );
}
