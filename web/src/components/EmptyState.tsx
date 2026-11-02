import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

interface Props {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}

/** Designed empty state: quiet, centered, with an optional hint/action. */
export function EmptyState({ icon = <Inbox size={22} />, title, hint, action }: Props) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 border-dashed px-6 py-14 text-center">
      <div className="text-2xl text-ink-500" aria-hidden>
        {icon}
      </div>
      <div className="text-sm font-medium text-ink-200">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-relaxed text-ink-400">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
