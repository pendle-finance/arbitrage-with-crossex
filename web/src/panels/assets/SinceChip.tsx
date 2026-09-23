import { HoverCard } from '../../components/HoverCard';
import { microLabelClass } from '../../components/Th';
import { fmtDateLocal, fmtDateShort, parseDateLocal } from '../../lib/fmt';
import { Calendar, ChevronDown } from 'lucide-react';

export function SinceChip({
  base,
  storedSec,
  defaultSec,
  onChange,
}: {
  base: string;
  storedSec: number | undefined;
  defaultSec: number | null;
  onChange: (sec: number | undefined) => void;
}) {
  const differsFromDefault = storedSec !== undefined && storedSec !== defaultSec;
  const effectiveSec = storedSec ?? defaultSec;
  const sinceLabel = effectiveSec !== null ? `Since ${fmtDateShort(effectiveSec, { year: 'numeric' })}` : 'All time';
  const defaultLabel = defaultSec !== null ? fmtDateShort(defaultSec, { year: 'numeric' }) : null;
  const today = fmtDateLocal(Math.floor(Date.now() / 1000));

  return (
    <HoverCard
      wrapsControl
      openOn="click"
      label={
        <button
          type="button"
          aria-haspopup="dialog"
          className={`btn !h-[30px] shrink-0 !px-2.5 ${differsFromDefault ? '!border-info/60 !text-info' : ''}`}
        >
          <Calendar size={14} aria-hidden />
          {sinceLabel}
          <ChevronDown size={14} aria-hidden className="text-ink-400" />
        </button>
      }
    >
      <div className="flex w-56 flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className={microLabelClass}>{`Count ${base} PnL from`}</span>
          <input
            type="date"
            className="input w-full px-2 py-1 text-xs"
            value={effectiveSec !== null ? fmtDateLocal(effectiveSec) : ''}
            max={today}
            onChange={(e) => {
              const v = e.target.value;
              if (v > today) return;
              const sec = parseDateLocal(v);
              if (!Number.isFinite(sec) || sec <= 0) return;
              if (defaultSec !== null && v === fmtDateLocal(defaultSec)) {
                onChange(undefined);
                return;
              }
              onChange(sec);
            }}
          />
        </label>
        {differsFromDefault && defaultLabel !== null && (
          <button type="button" className="btn-ghost-xs self-start" onClick={() => onChange(undefined)}>
            {`Use default (first position, ${defaultLabel})`}
          </button>
        )}
      </div>
    </HoverCard>
  );
}
