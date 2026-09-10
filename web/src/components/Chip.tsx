import type { ReactNode } from 'react';

export type ChipTone =
  | 'green'
  | 'red'
  | 'amber'
  | 'cyan'
  | 'orange'
  | 'blue'
  | 'violet'
  | 'info'
  | 'link'
  | 'crossex'
  | 'neutral';

/** Tone → utility overrides. Utilities land after the `.chip` component layer,
 * so they win over the neutral defaults. */
const TONES: Record<ChipTone, string> = {
  green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  red: 'border-rose-500/40 bg-rose-500/10 text-rose-400',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  cyan: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400',
  orange: 'border-orange-500/40 bg-orange-500/10 text-orange-400',
  blue: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
  /* Count badges — the mock's borderless `info @18%` fill. */
  info: 'border-transparent bg-info/[0.18] text-pastel-blue',
  link: 'border-link/40 bg-link/10 text-link',
  /* "via CrossEx" — dapp-nitro's crossex cyan, so it cannot be confused with
     the info-blue that cyan/blue/violet all resolve to. */
  crossex: 'border-crossex/40 bg-crossex/10 text-crossex',
  neutral: '',
};

interface Props {
  tone?: ChipTone;
  /** Compact variant for dense table cells. */
  sm?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Chip({ tone = 'neutral', sm, title, className, children }: Props) {
  return (
    <span title={title} className={`chip ${sm ? 'chip-sm' : ''} ${TONES[tone]} ${className ?? ''}`}>
      {children}
    </span>
  );
}
