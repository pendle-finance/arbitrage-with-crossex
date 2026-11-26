import { useState, type ReactNode } from 'react';
import { amountError } from '../lib/amount';
import { AmountBox } from './AmountBox';
import { SegmentedToggle } from './SegmentedToggle';

const CUSTOM = '\u0000custom';

type CustomEntry = { label: string; unit: string; inputLabel: string; max?: number; onApply: (value: number) => void };

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
  custom,
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
  custom?: CustomEntry;
}) {
  const [editing, setEditing] = useState(false);
  const [customText, setCustomText] = useState('');
  const customError = custom && customText.trim() !== '' ? amountError(customText, { max: custom.max }) : null;
  const close = () => {
    setEditing(false);
    setCustomText('');
  };
  const apply = () => {
    if (custom && customText.trim() !== '' && customError === null) custom.onApply(Number(customText.trim()));
    close();
  };
  const options: { value: T | typeof CUSTOM; label: ReactNode; disabled?: boolean; title?: string }[] =
    custom && !editing ? [...presets, { value: CUSTOM, label: custom.label }] : presets;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <AmountBox
        value={value}
        onChange={onChange}
        inputLabel={inputLabel}
        prefix={prefix}
        suffix={suffix}
        placeholder={placeholder}
        title={title}
        bad={bad}
        lit={preset !== null}
        className={boxClassName}
        inputMode={inputMode}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      <div className="flex flex-auto">
        <SegmentedToggle<T | typeof CUSTOM | ''>
          className={`seg-info seg-lg max-sm:[&_.seg-btn]:px-3${editing ? ' [&_.seg-btn:last-child]:rounded-r-none' : ''}`}
          fill
          ariaLabel={presetsLabel}
          value={preset ?? ''}
          onChange={(next) => {
            if (next === CUSTOM) setEditing(true);
            else if (next !== '') onPreset(next);
          }}
          options={options}
        />
        {custom && editing && (
          <span
            className={`-ml-px flex h-[35px] w-24 shrink-0 items-center gap-1 rounded-r border bg-wash/[0.05] px-2.5 focus-within:border-info/70 ${
              customError ? 'border-guava/60' : 'border-ink-700'
            }`}
          >
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              aria-label={custom.inputLabel}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customError === null) apply();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  close();
                }
              }}
              onBlur={apply}
              title={customError ?? undefined}
              className="num w-full min-w-0 bg-transparent text-sm font-semibold text-ink-50 outline-none"
            />
            <span className="shrink-0 text-[11.5px] text-ink-400">{custom.unit}</span>
          </span>
        )}
      </div>
    </div>
  );
}
