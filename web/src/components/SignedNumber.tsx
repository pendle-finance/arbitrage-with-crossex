import { num, signedClass } from '../lib/fmt';

interface Props {
  value: number | string;
  /** Formats the (signed) numeric value; defaults to num(n, 2). The '+' prefix
   * for positives is added here — formatters keep their own '-' for negatives. */
  format?: (n: number) => string;
  className?: string;
}

/**
 * Mono tabular signed value: green > 0, red < 0, dim at 0 (positives get a '+').
 *
 * ⚠ "Zero" means zero AS DISPLAYED, not `n === 0`. A value of -0.004 is
 * genuinely negative, but at 2dp it renders "-$0.00" — a minus sign and a red
 * cell announcing a loss that rounds to nothing. On a page full of live
 * positions that reads as alarming rather than as noise, so a number whose
 * formatted form carries no non-zero digit is shown dim and unsigned, matching
 * what an exact zero would look like.
 */
export function SignedNumber({ value, format = (n) => num(n), className }: Props) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return <span className={`num text-ink-400 ${className ?? ''}`}>—</span>;
  const body = format(n);
  // The formatter decides the precision, so it also decides what counts as
  // zero — this asks the rendered text rather than second-guessing with an
  // epsilon that would have to track every call site's dp.
  const showsZero = !/[1-9]/.test(body);
  const shown = showsZero ? format(Math.abs(n)) : body;
  return (
    <span className={`num ${signedClass(showsZero ? 0 : n)} ${className ?? ''}`}>
      {!showsZero && n > 0 ? '+' : ''}
      {shown}
    </span>
  );
}
