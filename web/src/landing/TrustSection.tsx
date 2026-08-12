import { CopyBlock } from '../components/CopyBlock';
import { AUDIT_PROMPT, REPO_URL } from '../lib/landing';

/** One concern → one straight answer. Titles are the objection in the
 * visitor's own words, not euphemisms — the brief is explicit that honesty
 * IS the pitch here, so this section is the one place on the page allowed to
 * sound like a disclaimer rather than marketing copy. */
const CONCERNS: { q: string; a: string }[] = [
  {
    q: 'Is this a Pendle product?',
    a: 'No. Built by mrenoon, an independent developer. Not created, owned, operated, endorsed or supported by Pendle or Univerum Innovations Inc.',
  },
  {
    q: 'Who holds my funds and keys?',
    a: 'You do. Runs on your machine, against your own Gate account and API keys. No one else holds them.',
  },
  {
    q: 'Can it lose money?',
    a: 'Yes. Real orders, real funds. Not financial, investment, legal or tax advice.',
  },
  {
    q: 'What if it breaks?',
    a: 'Free, open source, "as is". Experimental. Read the source yourself, or hand it to an assistant you trust before you paste in a key.',
  },
];

export function TrustSection() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-1">
      <div className="text-center">
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-100 sm:text-3xl">
          Before you trust it with a key
        </h2>
        <p className="mx-auto mt-1.5 max-w-xl text-sm text-ink-400">Read this first.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONCERNS.map((c) => (
          <div key={c.q} className="card p-4">
            <h3 className="text-[13px] font-semibold text-ink-100">{c.q}</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-300">{c.a}</p>
          </div>
        ))}
      </div>

      {/* The audit prompt as a real trust device: not a "trust us" badge but a
          concrete action a skeptic can take right now, before any key exists. */}
      <div className="card flex flex-col gap-3 border-cyan-500/20 bg-cyan-500/[0.03] p-5">
        <div>
          <h3 className="text-sm font-bold text-ink-100">Don't take our word for it</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-300">
            Source: <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200">github.com/mrenoon/crossex-boros-terminal</a>.
            Paste this prompt into an assistant you trust before you run anything:
          </p>
        </div>
        <CopyBlock text={AUDIT_PROMPT} label="Copy audit prompt" maxHeightClass="max-h-32" />
      </div>
    </section>
  );
}
