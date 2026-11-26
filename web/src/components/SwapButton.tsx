import { ArrowLeftRight } from 'lucide-react';

export function SwapButton({
  label,
  title,
  disabled,
  onClick,
  className = 'mb-[7px]',
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink-600 bg-ink-900 text-ink-300 transition-colors hover:border-ink-400 hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      <ArrowLeftRight size={12} aria-hidden />
    </button>
  );
}
