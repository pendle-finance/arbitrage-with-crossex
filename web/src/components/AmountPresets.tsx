import type { ReactNode } from 'react';
import { SegmentedToggle } from './SegmentedToggle';

export function AmountPresets<T extends string>({
  value,
  onChange,
  inputLabel,
  prefix,
  suffix,
  placeholder,
  title,
  bad,
  boxClassName = 'w-[7.5rem]',
  inputMode = 'decimal',
  onFocus,
  onBlur,
  presets,
  preset,
  presetsLabel,
  onPreset,
}: {
  value: string;
  onChange: (text: string) => void;
  inputLabel: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  placeholder?: string;
  title?: string;
  bad?: boolean;
  boxClassName?: string;
  inputMode?: 'decimal' | 'numeric';
  onFocus?: () => void;
  onBlur?: () => void;
  presets: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  preset: T | null;
  presetsLabel: string;
  onPreset: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`flex h-[35px] ${boxClassName} items-center gap-1 rounded border px-2.5 focus-within:border-info/70 ${
          bad ? 'border-guava/60' : 'border-ink-700'
        } ${preset === null ? 'bg-wash/[0.05]' : 'bg-wash/[0.15]'}`}
      >
        {prefix !== undefined && <span className="text-[11.5px] text-ink-400">{prefix}</span>}
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
          className={`num w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-ink-500 ${
            preset === null ? 'font-semibold text-ink-50' : 'font-medium text-ink-200'
          }`}
        />
        {suffix !== undefined && <span className="shrink-0 text-[11.5px] text-ink-400">{suffix}</span>}
      </span>
      <SegmentedToggle<T | ''>
        className="seg-info seg-lg max-sm:[&_.seg-btn]:px-3"
        ariaLabel={presetsLabel}
        value={preset ?? ''}
        onChange={(next) => {
          if (next !== '') onPreset(next);
        }}
        options={presets}
      />
    </div>
  );
}
