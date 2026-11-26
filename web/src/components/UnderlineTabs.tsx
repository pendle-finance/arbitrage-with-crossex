import { useRef, type KeyboardEvent } from 'react';

/**
 * Radio semantics, not tablist: the panel is a sibling rather than a labelled
 * tabpanel, and `radiogroup` is what the existing tests and screen readers
 * already expect from the control this replaces.
 */
const LOOK = {
  pill: {
    group: 'items-center gap-1.5',
    tab: 'rounded-full border px-[13px] py-[6px] text-[11.5px] font-medium',
    active: 'border-info/50 bg-info/[0.14] text-pastel-blue',
    idle: 'border-ink-600 text-ink-300 hover:border-ink-500 hover:text-ink-100',
  },
  underline: {
    group: 'items-stretch border-b border-ink-800',
    tab: '-mb-px border-b-2 px-2.5 pb-2.5 pt-3 text-pp-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-info/60',
    active: 'border-info text-ink-50',
    idle: 'border-transparent text-ink-400 hover:text-ink-100',
  },
} as const;

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function UnderlineTabs<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
  className,
  look = 'pill',
}: {
  ariaLabel: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  className?: string;
  look?: keyof typeof LOOK;
}) {
  const group = useRef<HTMLDivElement>(null);
  const style = LOOK[look];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[e.key];
    if (step === undefined || options.length === 0) return;
    e.preventDefault();
    const at = Math.max(0, options.findIndex((o) => o.value === value));
    const next = (at + step + options.length) % options.length;
    onChange(options[next].value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={`flex flex-wrap ${style.group} ${className ?? ''}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`${style.tab} transition-colors ${active ? style.active : style.idle}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
