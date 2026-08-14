/**
 * The user guide, rendered in-app from the canonical copy on GitHub rather than a
 * bundled snapshot, so an edited guide reaches users without a release. Fetched
 * once per session (staleTime Infinity also stops the app's global
 * refetch-on-focus from re-pulling a static document).
 *
 * Raw HTML in the markdown is NOT rendered — react-markdown escapes it without
 * rehype-raw, which is the property that makes displaying a remotely-fetched
 * document safe. Keep it that way.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Modal } from './Modal';
import { Skeleton } from './Skeleton';

const REPO = 'pendle-finance/crossex-boros-terminal';
const BRANCH = 'main';
const DOC = 'docs/USER_GUIDE.md';

export const USER_GUIDE_RAW_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${DOC}`;
export const USER_GUIDE_HTML_URL = `https://github.com/${REPO}/blob/${BRANCH}/${DOC}`;

/** Sibling docs are written relative ("./DISCLAIMER.md"). Off GitHub those would
 * resolve against the app's own origin, so send them back to the repo. */
const DOC_BASE = `https://github.com/${REPO}/blob/${BRANCH}/docs/`;
function absolute(href: string | undefined): string {
  if (!href) return USER_GUIDE_HTML_URL;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href;
  return new URL(href.replace(/^\.\//, ''), DOC_BASE).toString();
}

/** Screenshots are written relative too ("./Assumptions.png") and must load as
 * bytes, not as a GitHub page — so they resolve against raw, alongside the doc.
 * Anything that lands outside the repo's own raw tree is dropped rather than
 * fetched: the document is remote, and it does not get to point the app at
 * arbitrary hosts. */
const IMG_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/docs/`;
function imageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(src)
    ? src
    : new URL(src.replace(/^\.\//, ''), IMG_BASE).toString();
  return url.startsWith(IMG_BASE) ? url : undefined;
}

const Ext = ({ href, children }: { href?: string; children?: ReactNode }) => (
  <a
    href={absolute(href)}
    target="_blank"
    rel="noreferrer"
    className="text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
  >
    {children}
  </a>
);

/** Only `children` is taken from react-markdown's props — `node` and friends must
 * never reach the DOM. */
const components = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mb-3 text-lg font-bold tracking-tight text-ink-100">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-wider text-cyan-300">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-1.5 mt-4 text-[13px] font-semibold text-ink-100">{children}</h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-3 text-xs leading-relaxed text-ink-300">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 flex list-disc flex-col gap-2 pl-5 text-xs leading-relaxed text-ink-300 marker:text-ink-500">
      {children}
    </ul>
  ),
  // `start`/`value` must pass through: a markdown list interrupted by a
  // paragraph (or a loosely-indented sub-list) parses as SEVERAL <ol>s, and
  // dropping `start` renumbers every one of them from 1.
  ol: ({ children, start }: { children?: ReactNode; start?: number }) => (
    <ol
      start={start}
      className="mb-3 flex list-decimal flex-col gap-2 pl-5 text-xs leading-relaxed text-ink-300 marker:text-ink-500"
    >
      {children}
    </ol>
  ),
  li: ({ children, value }: { children?: ReactNode; value?: string | number | readonly string[] }) => (
    <li value={value} className="pl-0.5">
      {children}
    </li>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-ink-100">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em className="italic text-ink-200">{children}</em>
  ),
  hr: () => <hr className="my-5 border-ink-800" />,
  a: Ext,
  // Screenshots are wider than the modal — they scale down, never widen it.
  img: ({ src, alt }: { src?: string; alt?: string }) => {
    const resolved = imageSrc(src);
    if (!resolved) return null;
    return (
      <img
        src={resolved}
        alt={alt ?? ''}
        loading="lazy"
        className="mb-3 block h-auto max-w-full rounded-lg border border-ink-800"
      />
    );
  },
  code: ({ children }: { children?: ReactNode }) => (
    <code className="num rounded border border-ink-700 bg-ink-950 px-1 py-0.5 text-[11px] text-ink-200">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="num mb-3 overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-200">
      {children}
    </pre>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="mb-3 border-l-2 border-ink-700 pl-3 text-xs italic text-ink-400">
      {children}
    </blockquote>
  ),
  // GFM tables scroll rather than widen the modal.
  table: ({ children }: { children?: ReactNode }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs text-ink-300">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border border-ink-700 bg-ink-950 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border border-ink-800 px-2 py-1 align-top">{children}</td>
  ),
};

export function UserGuideModal({ onClose }: { onClose: () => void }) {
  const guide = useQuery({
    queryKey: ['user-guide', USER_GUIDE_RAW_URL] as const,
    queryFn: async () => {
      const r = await fetch(USER_GUIDE_RAW_URL);
      if (!r.ok) throw new Error(`GitHub returned HTTP ${r.status}`);
      return r.text();
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return (
    <Modal title="User guide" onClose={onClose} widthClass="w-[760px]">
      {guide.isPending ? (
        <div className="flex flex-col gap-3" aria-label="Loading the user guide">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ) : guide.isError ? (
        <div role="alert" className="flex flex-col gap-2 text-xs leading-relaxed text-ink-300">
          <span className="text-rose-400">
            Couldn’t load the guide — {(guide.error as Error).message}
          </span>
          <span>
            It lives on GitHub; open it there instead:{' '}
            <Ext href={USER_GUIDE_HTML_URL}>{DOC}</Ext>
          </span>
          <button type="button" className="btn-ghost-xs self-start" onClick={() => void guide.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {guide.data}
          </Markdown>
          <div className="mt-5 border-t border-ink-800 pt-3 text-[11px] text-ink-500">
            Rendered from <Ext href={USER_GUIDE_HTML_URL}>{DOC}</Ext> on GitHub.
          </div>
        </>
      )}
    </Modal>
  );
}
