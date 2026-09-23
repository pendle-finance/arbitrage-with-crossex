import { HoverCard } from '../../components/HoverCard';
import { microLabelClass } from '../../components/Th';
import { fmtDateLocal, fmtDateShort, parseDateLocal } from '../../lib/fmt';

function CalendarMark() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3.5 w-3.5 shrink-0">
      <rect x="1.5" y="2.5" width="9" height="8" rx="1.2" fill="none" stroke="currentColor" />
      <line x1="1.5" y1="5" x2="10.5" y2="5" stroke="currentColor" />
      <line x1="4" y1="1.2" x2="4" y2="3.6" stroke="currentColor" />
      <line x1="8" y1="1.2" x2="8" y2="3.6" stroke="currentColor" />
    </svg>
  );
}

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
          <CalendarMark />
          {sinceLabel}
          <span aria-hidden className="text-[10px] text-ink-400">
            ▾
          </span>
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
        <div className="flex items-center gap-2 text-xs text-ink-400">
          {defaultLabel !== null && (
            <HoverCard label={`Default ${defaultLabel}`} icon={false}>
              Your first CrossEx position
            </HoverCard>
          )}
          {differsFromDefault && (
            <button type="button" className="btn-ghost-xs ml-auto" onClick={() => onChange(undefined)}>
              Use default
            </button>
          )}
        </div>
      </div>
    </HoverCard>
  );
}
