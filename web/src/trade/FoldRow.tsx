import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function FoldRow({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: ReactNode;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-ink-700">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-ink-700/20"
      >
        <span className="shrink-0 text-[12px] text-ink-200">{label}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-400">
          {!open && <span className="num truncate">{summary}</span>}
          <ChevronDown size={14} aria-hidden className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && <div className="flex flex-col gap-3 border-t border-ink-700 px-3 py-2.5">{children}</div>}
    </div>
  );
}
