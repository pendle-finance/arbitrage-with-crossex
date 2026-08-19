import type { ReactNode } from 'react';
import { CopyBlock } from '../components/CopyBlock';
import { AUDIT_PROMPT, LOCAL_APP_URL, REPO_URL } from '../lib/landing';
import { Ext } from '../panels/onboardingBits';
import { LANDING_NOTIONAL_USD } from './landingOpportunities';
import { fmtNotionalShort } from '../lib/fmt';

/**
 * One collapsed home for every caveat on the page.
 *
 * Replaces the old "Before you trust it with a key" section, which announced
 * doubt in a headline and then answered it — a heading that sells against the
 * page. The same answers are here, closed by default, next to the number
 * caveats that used to be scattered as small print under the hero and the
 * spreads list. A visitor who isn't worried scrolls past; one who is finds
 * everything in one place instead of hunting footnotes.
 *
 * Nothing was softened in the move: the honest answers ARE the pitch for a
 * tool that asks for exchange keys.
 */
const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: 'Who built this?',
    a: (
      <>
        The Pendle team. It's an open-source project, published at{' '}
        <Ext href={REPO_URL}>github.com/pendle-finance/crossex-boros-terminal</Ext>. It is
        still experimental software, provided "as is" — use it at your own risk.
      </>
    ),
  },
  {
    q: 'Who holds my funds and keys?',
    a: (
      <>
        You do. It runs on your machine, against your own Gate account and API keys — they go into
        your local copy at <Ext href={LOCAL_APP_URL}>localhost:6688</Ext> and never touch this
        website. Key scope is Cross-Exchange Read + Write; never enable Withdrawal.
      </>
    ),
  },
  {
    q: 'Can it lose money?',
    a: 'Yes. It places real orders with real funds. Free, open source, experimental software, provided "as is" — nothing here is financial, investment, legal or tax advice.',
  },
  {
    q: 'Are these numbers a quote?',
    a: (
      <>
        No. Every rate is live and moves; nothing here is executable at a guaranteed price. All of
        it is priced at {fmtNotionalShort(LANDING_NOTIONAL_USD)} notional per leg on the standard
        (VIP&nbsp;0) fee tier — a worse tier than a high-volume account gets, so the headline isn't
        flattered. Your own size and fees change the result.
      </>
    ),
  },
  {
    q: 'Why is a spread sometimes negative?',
    a: 'Because execution cost can exceed the spread itself. The direction is already chosen for you — the engine only ever offers the orientation that receives the higher fixed rate — so a negative simply means the gap is too thin to survive fees and price impact at this size. Those are left out of the list above.',
  },
  {
    q: 'What if it breaks?',
    a: (
      <>
        It's open source and experimental. Read it yourself:{' '}
        <Ext href={REPO_URL}>github.com/pendle-finance/crossex-boros-terminal</Ext>, or hand
        the prompt below to an assistant you trust before you paste in a key.
      </>
    ),
  },
];

/** One row. No card: a border-top hairline separates it from the row above,
 * which is enough structure for a list of questions and stops the section
 * reading as seven stacked boxes. The first row's divider is suppressed since
 * the heading already sits above it. */
function Row({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group border-t border-ink-800 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 py-3.5 text-sm font-semibold text-ink-100 transition-colors hover:text-cyan-200">
        <span
          aria-hidden="true"
          className="shrink-0 text-[10px] text-ink-500 transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        {q}
      </summary>
      <div className="pb-4 pl-[22px] pr-2 text-[13px] leading-relaxed text-ink-300">{children}</div>
    </details>
  );
}

export function Faq() {
  return (
    <section className="flex w-full flex-col gap-5 px-1">
      <h2 className="text-center text-xl font-bold tracking-tight text-ink-100">
        Questions &amp; caveats
      </h2>

      {/* Generous side padding rather than a card: the whitespace is what
          separates this block from the page, so it needs no border of its own. */}
      <div className="flex flex-col px-1 sm:px-6">
        {FAQS.map((f) => (
          <Row key={f.q} q={f.q}>
            {f.a}
          </Row>
        ))}

        {/* The audit prompt is the one row carrying a control, so it keeps its
            copy block — but no tinted card, which would reintroduce the box. */}
        <Row q="Don't take our word for it, audit it first">
          <div className="flex flex-col gap-2.5">
            <p>
              Paste this into whichever assistant you trust (ChatGPT, Claude, Gemini) and have it
              read the real source before you run anything:
            </p>
            <CopyBlock text={AUDIT_PROMPT} label="Copy audit prompt" maxHeightClass="max-h-32" />
          </div>
        </Row>
      </div>
    </section>
  );
}
