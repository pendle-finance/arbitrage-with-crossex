import type { ReactNode } from 'react';

/** Small-label style shared by table headers and stat labels.
 *
 * The mock's small label is plain 12px sentence case in the header grey. It
 * replaced an upper-cased, letter-spaced micro-label: dapp-nitro never
 * upper-cases a label, and at 10px the tracking cost more legibility than its
 * "this is a header" signal was worth. */
export const microLabelClass = 'text-[12px] font-normal leading-[14.52px] text-ink-300';

/** Table header cell in the shared micro-label style. */
export function Th({ className = '', children }: { className?: string; children?: ReactNode }) {
  return <th className={`px-2 py-1.5 ${microLabelClass} ${className}`}>{children}</th>;
}

/**
 * A label that carries a tooltip, marked the way the mock marks one: a dotted
 * rule under the TEXT at a 4px offset, and the help cursor.
 *
 * Without the rule the ~300 `title=` attributes in this app are invisible —
 * nothing on the page says the explanation is there, so a reader who never
 * happens to rest the pointer on the word never learns it exists. (That is the
 * same argument HoverCard's own comment makes; this is the lightweight version
 * for a plain native tooltip, where a full HoverCard would be too much.)
 */
export function TipLabel({
  title,
  className = '',
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`tip-label ${className}`} title={title}>
      {children}
    </span>
  );
}
