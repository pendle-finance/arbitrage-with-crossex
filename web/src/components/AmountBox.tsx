import type { ReactNode } from 'react';

export function AmountBox({
  value,
  onChange,
  inputLabel,
  prefix,
  suffix,
  placeholder,
  title,
  bad,
  lit = false,
  className = 'w-[7.5rem]',
  inputMode = 'decimal',
  onFocus,
  onBlur,
}: {
  value: string;
  onChange: (text: string) => void;
  inputLabel: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  placeholder?: string;
  title?: string;
  bad?: boolean;
  lit?: boolean;
  className?: string;
  inputMode?: 'decimal' | 'numeric';
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <span
      className={`flex h-[35px] ${className} items-center gap-1 rounded border px-2.5 focus-within:border-info/70 ${
        bad ? 'border-guava/60' : 'border-ink-700'
      } ${lit ? 'bg-wash/[0.15]' : 'bg-wash/[0.05]'}`}
    >
      {prefix !== undefined && <span className="text-xs text-ink-400">{prefix}</span>}
      <input
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        aria-label={inputLabel}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        title={title}
        className={`num w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-ink-500 ${
          lit ? 'font-medium text-ink-200' : 'font-semibold text-ink-50'
        }`}
      />
      {suffix !== undefined && <span className="shrink-0 text-xs text-ink-400">{suffix}</span>}
    </span>
  );
}
