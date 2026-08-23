import type { ReactNode } from 'react';

interface Props<T extends string> {
  value: T;
  /** `subTitle` is hover text for `sub` — for a badge whose claim needs a
   * qualification that does not deserve a permanent paragraph. */
  options: { value: T; label: ReactNode; sub?: ReactNode; subTitle?: string }[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  /** Extra classes on the track — e.g. `seg-cyan` for the cyan-active variant. */
  className?: string;
  /**
   * Stretch the options across the full width of the row.
   *
   * Opt-in: most of these sit inline beside a label, where shrink-to-fit is
   * right. On its own row a shrink-to-fit control leaves dead space to its
   * right, which reads as something missing rather than as a deliberate gap.
   */
  fill?: boolean;
}

/** House segmented control (copied from boros-tools _shared-frontend). */
export function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  fill,
}: Props<T>) {
  return (
    <div
      className={`seg${fill ? ' flex w-full' : ''}${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          data-active={value === opt.value}
          className={`seg-btn${fill ? ' flex-1 justify-center' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          <span>{opt.label}</span>
          {opt.sub && (
            <span className="ml-1 text-[10px] text-ink-400" title={opt.subTitle}>
              {opt.sub}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
