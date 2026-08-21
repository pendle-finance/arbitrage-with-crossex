/**
 * The opportunities list's facet toolbar — one quiet wrapping line between the
 * assumptions strip and the first card, not a boxed form. Every chip carries
 * the number of cards it would leave standing given the OTHER active filters,
 * so a dead end is visible before it is clicked — and a chip that would add
 * nothing is disabled rather than silently inert. Selected chips wear a ✓ as
 * well as the cyan, so selection never rides on colour alone.
 *
 * A dimension with fewer than two options isn't a choice, so it stays hidden: a
 * lone "ETH" chip can only narrow the list to what it already shows.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { microLabelClass } from '../components/Th';
import { fmtDateUtc } from '../lib/fmt';
import { useDebounced } from '../lib/useDebounced';
import {
  facets,
  hasActiveFilter,
  minApr,
  NO_FILTERS,
  toggleValue,
  type FacetOption,
  type OpportunityFilters,
  type OpportunityRow,
} from './opportunityFilters';

function FilterChip<T extends string | number>({
  option,
  title,
  onToggle,
}: {
  option: FacetOption<T>;
  title?: string;
  onToggle: (value: T) => void;
}) {
  const { label, count, selected, value } = option;
  const dead = count === 0 && !selected;
  return (
    <button
      type="button"
      aria-pressed={selected}
      // Unselected and worth nothing: picking it would add no card. Selected
      // chips stay live at any count — they must always be releasable.
      // `aria-disabled` rather than `disabled`: a native disabled button leaves
      // the tab order and stops dispatching pointer events, so the `title`
      // explaining WHY it is a dead end becomes unreachable by exactly the
      // people who need it. Inert is enforced in the handler instead.
      aria-disabled={dead}
      title={title}
      onClick={() => !dead && onToggle(value)}
      className={`num rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        dead ? 'cursor-not-allowed opacity-40' : ''
      } ${
        selected
          ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
          : `border-ink-700 bg-ink-900 text-ink-300 ${dead ? '' : 'hover:border-ink-500 hover:text-ink-100'}`
      }`}
    >
      {/* Shape marks the selection alongside the cyan; hidden from the
          accessible name — aria-pressed already says it. */}
      {selected && (
        <span aria-hidden="true" className="mr-1 text-[9px] text-cyan-400">
          ✓
        </span>
      )}
      {label}{' '}
      <span className={selected ? 'text-cyan-400/70' : 'text-ink-500'}>{count}</span>
    </button>
  );
}

/** One facet: its micro-label and chips, flowing inline with its siblings. */
function FacetGroup<T extends string | number>({
  label,
  options,
  poolSize,
  titleOf,
  onToggle,
}: {
  label: string;
  options: FacetOption<T>[];
  /** Rows the counts are measured against — see `OpportunityFacets.poolSize`. */
  poolSize: number;
  titleOf?: (value: T) => string;
  onToggle: (value: T) => void;
}) {
  // A dimension earns its row when some option would actually exclude
  // something. Option COUNT can't answer that: every row carries two venue
  // keys, so a one-card list has two venue chips that between them exclude
  // nothing. A dimension holding a live selection always shows, whatever the
  // data now says — otherwise the filter stays armed with no chip to release.
  const narrows = options.some((o) => o.count < poolSize);
  const hasSelection = options.some((o) => o.selected);
  if (!narrows && !hasSelection) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={`${microLabelClass} mr-0.5`}>{label}</span>
      {options.map((o) => (
        <FilterChip
          key={String(o.value)}
          option={o}
          title={titleOf?.(o.value)}
          onToggle={onToggle}
        />
      ))}
    </span>
  );
}

export function OpportunityFilterBar({
  rows,
  filters,
  onChange,
  shown,
}: {
  /** Every viable row, unfiltered — the facets count against this. */
  rows: OpportunityRow[];
  filters: OpportunityFilters;
  onChange: (next: OpportunityFilters) => void;
  /** How many cards survive `filters` — the "showing N of M" numerator. */
  shown: number;
}) {
  const minAprId = useId();
  // The field types LOCALLY and lands debounced: every keystroke straight into
  // `filters` re-renders the whole card list synchronously, which at 100 cards
  // costs ~14ms a character (and mounts rows the next character removes).
  const [minAprText, setMinAprText] = useState(filters.minAprPct);
  const debouncedMinApr = useDebounced(minAprText, 250);
  // What we last pushed up, so an echo of our own value is not mistaken for the
  // parent resetting the field (Clear filters).
  const pushed = useRef(filters.minAprPct);

  useEffect(() => {
    if (debouncedMinApr === pushed.current) return;
    pushed.current = debouncedMinApr;
    onChange({ ...filters, minAprPct: debouncedMinApr });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedMinApr]);

  // Clear filters (or any other outside write) wins over the local text.
  useEffect(() => {
    if (filters.minAprPct === pushed.current) return;
    pushed.current = filters.minAprPct;
    setMinAprText(filters.minAprPct);
  }, [filters.minAprPct]);

  const f = facets(rows, filters);
  const active = hasActiveFilter(filters);
  // Judged on what the reader has TYPED, not on the debounced value the list is
  // filtered by — the red border must answer the keystroke, not trail it.
  const minAprBad = minAprText.trim() !== '' && minApr({ ...filters, minAprPct: minAprText }) === null;

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 px-0.5"
      role="group"
      aria-label="Filter opportunities"
    >
      <FacetGroup
        label="Asset"
        options={f.assets}
        poolSize={f.poolSize.assets}
        onToggle={(v) => onChange({ ...filters, assets: toggleValue(filters.assets, v) })}
      />
      <FacetGroup
        label="Venue"
        options={f.venues}
        poolSize={f.poolSize.venues}
        titleOf={(v) => `Opportunities with either leg on ${v}`}
        onToggle={(v) => onChange({ ...filters, venues: toggleValue(filters.venues, v) })}
      />
      <FacetGroup
        label="Matures"
        options={f.maturities}
        poolSize={f.poolSize.maturities}
        titleOf={(v) => `Matures ${fmtDateUtc(v)} UTC`}
        onToggle={(v) => onChange({ ...filters, maturities: toggleValue(filters.maturities, v) })}
      />

      <span className="flex items-center gap-1.5">
        <label htmlFor={minAprId} className={`${microLabelClass} mr-0.5`}>
          Min APR
        </label>
        <input
          id={minAprId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="any"
          value={minAprText}
          onChange={(e) => setMinAprText(e.target.value)}
          title="Hide anything under this net APR on capital — a plain decimal, e.g. 7.5"
          aria-invalid={minAprBad}
          aria-describedby={minAprBad ? `${minAprId}-err` : undefined}
          className={`input num h-[26px] w-16 !px-2 !py-0 text-[11px] ${
            minAprBad ? 'border-rose-500/60' : ''
          }`}
        />
        <span className="text-[11px] text-ink-400">%</span>
        {minAprBad && (
          <span id={`${minAprId}-err`} role="alert" className="text-[11px] text-rose-300">
            needs a plain number
          </span>
        )}
      </span>

      <span className="ml-auto flex items-center gap-2">
        <span className="num text-[11px] text-ink-400" aria-live="polite">
          showing {shown} of {rows.length}
        </span>
        {active && (
          <button type="button" className="btn-ghost-xs" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </button>
        )}
      </span>
    </div>
  );
}
