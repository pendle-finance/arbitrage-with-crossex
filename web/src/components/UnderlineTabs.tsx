/**
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
      className={`flex flex-wrap items-stretch border-b border-ink-800 ${className ?? ''}`}
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
            className={`-mb-px border-b-2 px-2.5 pb-2.5 pt-3 text-pp-md font-semibold transition-colors ${
              active ? 'border-info text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-100'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
