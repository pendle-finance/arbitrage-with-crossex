import { Check, CircleX, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type ResultTone = 'done' | 'stop' | 'part';
export interface ResultRow {
  label: ReactNode;
  value: ReactNode;
}

const RESULT: Record<ResultTone, { box: string; text: string; Icon: LucideIcon }> = {
  done: { box: 'alert-green', text: 'text-grass', Icon: Check },
  stop: { box: 'alert-red', text: 'text-guava', Icon: CircleX },
  part: { box: 'alert-amber', text: 'text-gold', Icon: TriangleAlert },
};

export function ResultBox({ tone, title, lines = [], rows = [] }: { tone: ResultTone; title: ReactNode; lines?: ReactNode[]; rows?: ResultRow[] }) {
  const { box, text, Icon } = RESULT[tone];
  return (
    <div role={tone === 'done' ? 'status' : 'alert'} className={box}>
      <p className={`num flex items-center gap-1.5 text-xs font-semibold ${text}`}>
        <Icon size={14} aria-hidden className="shrink-0" />
        <span className="min-w-0">{title}</span>
      </p>
      {lines.map((line, i) => (
        <p key={i} className="num pl-5 text-xs text-ink-300">
          {line}
        </p>
      ))}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1 pl-5 pt-0.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
              <dt className="text-ink-300">{row.label}</dt>
              <dd className="num text-right text-ink-50">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
