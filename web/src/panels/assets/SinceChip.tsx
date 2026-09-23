import { useRef } from 'react';
import { HoverCard } from '../../components/HoverCard';
import { fmtDateLocal, fmtDateShort, parseDateLocal } from '../../lib/fmt';
import { Calendar, ChevronDown } from 'lucide-react';

/** Stored as the coin's date: count every payment the ledger holds. */
export const ALL_TIME_SEC = 0;

/**
 * A split button. The date half opens the browser's date picker in one click,
 * as 1.7.0's bare date box did. The arrow half holds the two resets, "All time"
 * and "Use default", so they never cost the date an extra step.
 */
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
  const input = useRef<HTMLInputElement>(null);
  const differsFromDefault = storedSec !== undefined && storedSec !== defaultSec;
  const effectiveSec = storedSec ?? defaultSec;
  const shownSec = effectiveSec === null || effectiveSec === ALL_TIME_SEC ? null : effectiveSec;
  const isAllTime = shownSec === null;
  const sinceLabel = shownSec === null ? 'All time' : `Since ${fmtDateShort(shownSec, { year: 'numeric' })}`;
  const defaultLabel = defaultSec !== null ? fmtDateShort(defaultSec, { year: 'numeric' }) : null;
  const today = fmtDateLocal(Math.floor(Date.now() / 1000));
  const offersAllTime = !isAllTime;
  const offersDefault = differsFromDefault && defaultLabel !== null;
  const tone = differsFromDefault ? '!border-info/60 !text-info' : '';

  const openPicker = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      // No showPicker (older Safari) or no user gesture: let the field take it.
      el.focus();
    }
  };

  return (
    <span className="inline-flex shrink-0">
      <span className="relative">
        <button
          type="button"
          onClick={openPicker}
          className={`btn !h-[30px] !px-2.5 ${offersAllTime || offersDefault ? '!rounded-r-none' : ''} ${tone}`}
        >
          <Calendar size={14} aria-hidden />
          {sinceLabel}
        </button>
        {/* The picker anchors to this field, so it sits under the button. */}
        <input
          ref={input}
          type="date"
          aria-label={`Count ${base} PnL from`}
          tabIndex={-1}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
          value={shownSec === null ? '' : fmtDateLocal(shownSec)}
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
      </span>
      {(offersAllTime || offersDefault) && (
        <HoverCard
          wrapsControl
          openOn="click"
          label={
            <button
              type="button"
              aria-label="Date options"
              aria-haspopup="dialog"
              className={`btn !h-[30px] !rounded-l-none !border-l-0 !px-1.5 ${tone}`}
            >
              <ChevronDown size={14} aria-hidden className="text-ink-400" />
            </button>
          }
        >
          <div className="flex flex-col items-start gap-2 text-xs">
            {offersAllTime && (
              <button type="button" data-close-card className="btn-link whitespace-nowrap" onClick={() => onChange(ALL_TIME_SEC)}>
                All time
              </button>
            )}
            {offersDefault && (
              <button type="button" data-close-card className="btn-link whitespace-nowrap" onClick={() => onChange(undefined)}>
                {`Use default (first position, ${defaultLabel})`}
              </button>
            )}
          </div>
        </HoverCard>
      )}
    </span>
  );
}
