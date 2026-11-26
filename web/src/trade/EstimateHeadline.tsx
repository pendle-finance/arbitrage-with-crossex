import type { ReactNode } from 'react';

export function EstimateHeadline({
  label,
  sub,
  value,
  tone = 'text-ink-50',
}: {
  label: ReactNode;
  sub?: ReactNode;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-[12.5px] text-ink-50">{label}</span>
        {sub && <span className="text-[11px] text-ink-400">{sub}</span>}
      </div>
      <span className={`num text-lg font-semibold ${tone}`}>{value}</span>
    </div>
  );
}
