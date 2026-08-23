/**
 * A row of tabs marked by an underline rather than a filled pill.
 *
 * The segmented control this sits beside (`SegmentedToggle`) reads as a
 * setting — a boxed switch inside a form. These read as NAVIGATION: which of
 * several tickets am I looking at. Same job as the venue/mode switches at the
 * top of the order rail, which are choosing a surface rather than configuring
 * one, so they get the lighter treatment and the form below keeps the boxes.
 *
 * Radio semantics, not tablist: the panel is a sibling rather than a labelled
 * tabpanel, and `radiogroup` is what the existing tests and screen readers
 * already expect from the control this replaces.
 */
export function UnderlineTabs<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
  className,
}: {
  ariaLabel: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex items-center gap-5 border-b border-ink-800 ${className ?? ''}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            // -mb-px pulls each tab onto the container's border so the active
            // underline replaces that hairline rather than stacking under it.
            className={`-mb-px border-b-2 px-0.5 pb-2 text-[13px] font-medium transition-colors ${
              active
                ? 'border-cyan-400 text-ink-100'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
