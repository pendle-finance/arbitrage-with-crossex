import { useRef, type ReactNode } from 'react';

export function RadioRow({
  name,
  labelledBy,
  checked,
  disabled = false,
  onPick,
  children,
}: {
  name: string;
  labelledBy: string;
  checked: boolean;
  disabled?: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const look = checked ? 'border-info bg-info/10' : 'border-ink-700';
  const state = disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer';
  return (
    <label
      onClickCapture={() => {
        if (!input.current?.matches(':disabled')) onPick();
      }}
      className={`flex min-h-9 items-center gap-3 rounded border px-3 py-1.5 text-xs ${look} ${state}`}
    >
      <input
        ref={input}
        type="radio"
        name={name}
        aria-labelledby={labelledBy}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-full border border-ink-500 checked:border-info checked:bg-info checked:ring-2 checked:ring-inset checked:ring-ink-900 disabled:cursor-not-allowed disabled:border-dashed"
      />
      {children}
    </label>
  );
}
