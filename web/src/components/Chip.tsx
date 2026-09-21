import type { ReactNode } from 'react';

export type ChipTone =
  | 'green'
  | 'red'
  | 'amber'
  | 'cyan'
  | 'blue'
  | 'info'
  | 'link'
  | 'crossex'
  | 'neutral';

/** Tone → utility overrides. Utilities land after the `.chip` component layer,
 * so they win over the neutral defaults. The mock's PpTag recipe: the tone at
 * full strength on the hairline and the text, at 20% for the fill. */
const TONES: Record<ChipTone, string> = {
  green: 'border-grass bg-grass/20 text-grass',
  red: 'border-guava bg-guava/20 text-guava',
  amber: 'border-warning bg-warning/20 text-warning',
  cyan: 'border-info bg-info/20 text-info',
  blue: 'border-info bg-info/20 text-info',
  /* Count badges — the mock's borderless `info @18%` fill. */
  info: 'border-transparent bg-info/[0.18] text-pastel-blue',
  link: 'border-link/50 bg-link/[0.15] text-link',
  /* "via CrossEx" — dapp-nitro's crossex cyan, so it cannot be confused with
     the info-blue that cyan resolves to. */
  crossex: 'border-crossex/60 bg-crossex/[0.15] text-crossex',
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
