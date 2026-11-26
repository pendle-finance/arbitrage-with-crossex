import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export function BoxSelect<T extends string>({
  ariaLabel,
  value,
  onChange,
  children,
}: {
  ariaLabel: string;
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <span className="relative block w-full">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="num h-[35px] w-full cursor-pointer appearance-none rounded border border-ink-700 bg-wash/[0.05] pl-2.5 pr-8 text-sm font-medium text-ink-50 transition-colors hover:bg-wash/[0.08] focus:border-info/70 focus:outline-none [&>option]:bg-ink-900"
      >
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-ink-400">
        <ChevronDown size={14} />
      </span>
    </span>
  );
}
