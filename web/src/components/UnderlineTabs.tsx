/**
 * A row of pill tabs — the mock's order-ticket tab style.
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
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
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
            // The mock's ticket tabs: outlined pills, the chosen one filled
            // with the info tint — the same marker as every other selection.
            className={`rounded-full border px-[13px] py-[6px] text-[11.5px] font-medium transition-colors ${
              active
                ? 'border-info/50 bg-info/[0.14] text-pastel-blue'
                : 'border-ink-600 text-ink-300 hover:border-ink-500 hover:text-ink-100'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
