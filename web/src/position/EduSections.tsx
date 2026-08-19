/** The educational collapsibles — the page's teaching half. Voice and claims
 * follow docs/USER_GUIDE.md §1 (mechanism) and §4 (risks); this position's own
 * numbers are interpolated (always as React text — never HTML) so the lesson
 * is about THE position on screen, not a hypothetical. */
import { CollapsibleSection, SectionsProvider } from '../components/CollapsibleSection';
import { fmtPct, fmtUsd } from '../lib/fmt';
import { prettyVenue } from '../lib/fmt';
import type { SharePayloadV1 } from '../lib/shareCodec';
import type { PositionView } from './derive';

const BOROS_ACADEMY_URL =
  'https://docs.pendle.finance/boros-academy/advanced-strategies/fixed-return-funding-arbitrage';

export function EduSections({ p, view }: { p: SharePayloadV1; view: PositionView }) {
  const shortVenue = view.columns[0] ? prettyVenue(view.columns[0].venue) : 'the first venue';
  const longVenue = view.columns[1] ? prettyVenue(view.columns[1].venue) : 'the second venue';
  const P = ({ children }: { children: React.ReactNode }) => (
    <p className="text-xs leading-relaxed text-ink-300 [&+&]:mt-2">{children}</p>
  );

  return (
    <section aria-label="How this works">
      <h2 className="mb-3 text-lg font-bold tracking-tight text-ink-100">How this works</h2>
      <SectionsProvider>
        <div className="flex flex-col gap-2.5">
          <CollapsibleSection id="pos-edu-funding" title="What is a funding rate?" defaultOpen>
            <P>
              Perpetual futures never expire, so exchanges keep their price glued to spot with a
              continuous side-payment between longs and shorts — the funding rate. Anyone holding a
              perp earns or pays it around the clock, and it changes constantly: an unpredictable
              income stream for some, an unpredictable cost for others.
            </P>
            <P>This whole strategy exists to swap that floating stream for a fixed one.</P>
          </CollapsibleSection>

          <CollapsibleSection id="pos-edu-boros" title="What is Boros?" defaultOpen={false}>
            <P>
              On Boros (by Pendle), a funding rate is itself tradable at an implied fixed rate —
              like an interest-rate swap for perp funding. And the same coin's funding often
              carries different implied fixed rates on different venues: here, {p.b} funding priced
              on {shortVenue} vs {longVenue}. That gap is what this position locks in.
            </P>
            <P>
              <a
                className="text-cyan-400 hover:text-cyan-300"
                href={BOROS_ACADEMY_URL}
                target="_blank"
                rel="noreferrer"
              >
                Boros Academy: Fixed-Return Funding Arbitrage →
              </a>
            </P>
          </CollapsibleSection>

          <CollapsibleSection
            id="pos-edu-spread"
            title="How do the two Boros legs lock a fixed spread?"
            defaultOpen={false}
          >
            <P>
              Short the funding of the expensive market and you receive its fixed rate
              {view.receiveApr !== null ? ` (${fmtPct(view.receiveApr)} on ${shortVenue})` : ''};
              long the funding of the cheap one and you pay its fixed rate
              {view.payApr !== null ? ` (${fmtPct(view.payApr)} on ${longVenue})` : ''}. The
              difference — about {fmtPct(p.sp)} here — is locked until the market's maturity.
            </P>
            <P>
              But each Boros leg also leaves you exposed to that venue's floating funding. That's
              exactly what the two perp legs are for.
            </P>
          </CollapsibleSection>

          <CollapsibleSection
            id="pos-edu-perps"
            title="Why the two perp legs? (delta-neutral)"
            defaultOpen={false}
          >
            <P>
              Both perps are opened through Gate CrossEx under one unified-margin account: a short
              perp on {shortVenue}, a long on {longVenue} — each on the same side as its Boros leg.
              Each perp's funding cancels the floating funding its Boros leg owes, and the two
              perps cancel each other's price exposure.
            </P>
            <P>
              Once everything nets out there is no price exposure and no floating-rate exposure
              left — just the fixed spread, earned on the notional until maturity. With the shared
              margin, one leg's gain collateralises the other's loss.
            </P>
          </CollapsibleSection>

          <CollapsibleSection
            id="pos-edu-headline"
            title="Where does the headline number come from?"
            defaultOpen={false}
          >
            <P>
              The locked spread ({fmtPct(p.sp)}) earned on the notional for the time left to
              maturity, minus every cost the terminal can model — Boros fees and price impact, perp
              fees and slippage, entry and exit — expressed as a net fixed APR on the{' '}
              {fmtUsd(p.c, 0)} of capital the four legs actually consume as margin. That's the{' '}
              {fmtPct(p.a)} at the top.
            </P>
          </CollapsibleSection>

          <CollapsibleSection id="pos-edu-fees" title="Fees explained" defaultOpen={false}>
            <P>
              Two buckets, the solid and dashed steps of the waterfall above. Already paid: perp
              trading fees, the entry slippage of crossing two books, Boros trade fees, and Boros
              settlement fees accrued so far. Still ahead: closing the perp pair at maturity costs
              another round of fees and slippage — unless the position rolls into the next
              maturity, in which case the perp legs never pay exit or re-entry fees at all.
            </P>
            <P>{view.costAssumptionLabel}</P>
          </CollapsibleSection>

          <CollapsibleSection
            id="pos-edu-maturity"
            title="What happens at maturity?"
            defaultOpen={false}
          >
            <P>
              The Boros legs settle and the fixed-for-floating exchange stops. The trader then
              either closes the two perp legs to realize the locked return, or keeps them open and
              locks a fresh Boros spread for the next maturity — rolling the position and saving
              the exit-plus-re-entry costs.
            </P>
          </CollapsibleSection>

          <CollapsibleSection id="pos-edu-risks" title="What are the risks?" defaultOpen={false}>
            <P>Fixed does not mean risk-free:</P>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-ink-300">
              <li>
                <span className="text-ink-100">Gate exchange risk</span> — the money sits within
                Gate; anything happening to Gate affects it.
              </li>
              <li>
                <span className="text-ink-100">CrossEx platform risk</span> — the cross-margin
                platform itself could malfunction, and the position might not hold.
              </li>
              <li>
                <span className="text-ink-100">Perp-pair liquidation</span> — the two perp prices
                could in theory diverge so far that even a delta-neutral pair gets liquidated
                (extremely unlikely, but possible).
              </li>
              <li>
                <span className="text-ink-100">Boros-leg liquidation</span> — if market rates move
                far from the locked spread, a Boros leg can be liquidated; traders maintain a
                margin buffer for this.
              </li>
              <li>
                <span className="text-ink-100">Execution risk</span> — a pair that ends up
                non-hedged exposes the trader to price moves; the terminal's hedge checks exist
                for this.
              </li>
            </ul>
            <P>Do your own research — this page explains a strategy, it doesn't recommend one.</P>
          </CollapsibleSection>
        </div>
      </SectionsProvider>
    </section>
  );
}
