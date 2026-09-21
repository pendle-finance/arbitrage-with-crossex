export function Switch({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex w-fit cursor-pointer items-center gap-2 text-left text-xs text-ink-200 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors ${
          on ? 'border-emerald-500/60 bg-emerald-500/30' : 'border-ink-600 bg-ink-800'
        }`}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full transition-transform ${
            on ? 'translate-x-3.5 bg-emerald-300' : 'translate-x-0.5 bg-ink-400'
          }`}
        />
      </span>
      {label}
    </button>
  );
}
