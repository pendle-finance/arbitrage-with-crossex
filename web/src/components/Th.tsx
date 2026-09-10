import type { ReactNode } from 'react';

/** Micro-label style shared by table headers and stat labels. */
export const microLabelClass =
  'text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400';

/** Table header cell in the shared micro-label style. */
export function Th({ className = '', children }: { className?: string; children?: ReactNode }) {
  return <th className={`px-2 py-1.5 ${microLabelClass} ${className}`}>{children}</th>;
}
