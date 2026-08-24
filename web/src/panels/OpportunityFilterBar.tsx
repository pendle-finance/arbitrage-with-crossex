/**
 * The opportunities list's facet toolbar — one quiet line between the
 * assumptions strip and the first card, not a boxed form. ASSET rides that line
 * (it is what a reader scans by); venue, maturity and the APR floor fold behind
 * a filter icon on the right that carries a count whenever one of them is
 * armed, and open in a popover anchored to it — which is also where the blanket
 * Clear lives, since a chip on the bar is released by clicking it. Every chip carries
 * the number of cards it would leave standing given the OTHER active filters,
 * so a dead end is visible before it is clicked — and a chip that would add
 * nothing is disabled rather than silently inert. Selected chips wear a ✓ as
 * well as the cyan, so selection never rides on colour alone.
 *
 * A dimension with fewer than two options isn't a choice, so it stays hidden: a
 * lone "ETH" chip can only narrow the list to what it already shows.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { microLabelClass } from '../components/Th';
import { useDebounced } from '../lib/useDebounced';
import {
  facets,
  hasActiveFilter,
  minDays,
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

const POPOVER_WIDTH = 320;
const MARGIN = 8;

/**
 * The refinements, anchored under the filter icon on the right of the bar. Same shape as
 * `trade/ClosePopover`: a click-catching scrim, a viewport-CLAMPED fixed
 * dialog, Escape to dismiss — and it re-anchors on scroll/resize because the
 * coordinates are viewport-relative and the body scrolls under it.
 */
function FilterPopover({
  id,
  anchorRef,
  onDismiss,
  children,
}: {
  /** Target of the trigger's `aria-controls`. */
  id: string;
  /** A live ref, not a rect — the trigger moves as the page scrolls. */
  anchorRef: RefObject<HTMLElement> | null;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // Below-LEFT of the trigger (it sits on the left of the bar), clamped so a
  // narrow viewport can't push it off-screen where a fixed element is
  // unreachable. It also GROWS as chips wrap, hence the ResizeObserver.
  useLayoutEffect(() => {
    if (!anchorRef) return; // no anchor (tests) → keep the static fallback
    const reposition = () => {
      const btn = anchorRef.current;
      const dlg = dialogRef.current;
      if (!btn || !dlg) return;
      const r = btn.getBoundingClientRect();
      const top = Math.max(
        MARGIN,
        Math.min(r.bottom + 6, window.innerHeight - dlg.offsetHeight - MARGIN),
      );
      // Right-EDGE aligned: the trigger sits on the right of the bar, so
      // hanging the popover off its left edge would push it off-screen.
      const left = Math.max(
        MARGIN,
        Math.min(r.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - MARGIN),
      );
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
    if (ro && dialogRef.current) ro.observe(dialogRef.current);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      ro?.disconnect();
    };
  }, [anchorRef]);

  return (
    <div className="fixed inset-0 z-50" role="presentation" onClick={onDismiss}>
      <div
        id={id}
        ref={dialogRef}
        role="dialog"
        aria-label="Filter opportunities by venue, maturity and APR"
        className="fixed max-h-[calc(100vh-16px)] w-[320px] overflow-y-auto rounded-xl border border-ink-600 bg-ink-900 p-3 shadow-2xl"
        style={pos ?? { top: 96, left: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink-100">Filters</span>
          <button type="button" aria-label="dismiss" className="btn-ghost-xs px-1.5" onClick={onDismiss}>
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3">{children}</div>
      </div>
    </div>
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
  const minDaysId = useId();
  const moreId = useId();
  // Asset is the dimension a reader SCANS by; venue, maturity and the APR floor
  // are refinements they reach for. Only the first stays on the line.
  // Deliberately not persisted — it is a disclosure, not a preference.
  const [moreOpen, setMoreOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Dismissing returns the caret to the icon that opened it, so a keyboard user
  // is not dropped back at the top of the document.
  const dismiss = () => {
    setMoreOpen(false);
    triggerRef.current?.focus();
  };
  // The field types LOCALLY and lands debounced: every keystroke straight into
  // `filters` re-renders the whole card list synchronously, which at 100 cards
  // costs ~14ms a character (and mounts rows the next character removes).
  const [minDaysText, setMinDaysText] = useState(filters.minDaysText);
  const debouncedMinDays = useDebounced(minDaysText, 250);
  // What we last pushed up, so an echo of our own value is not mistaken for the
  // parent resetting the field (Clear filters).
  const pushed = useRef(filters.minDaysText);

  useEffect(() => {
    if (debouncedMinDays === pushed.current) return;
    pushed.current = debouncedMinDays;
    onChange({ ...filters, minDaysText: debouncedMinDays });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedMinDays]);

  // Clear filters (or any other outside write) wins over the local text.
  useEffect(() => {
    if (filters.minDaysText === pushed.current) return;
    pushed.current = filters.minDaysText;
    setMinDaysText(filters.minDaysText);
  }, [filters.minDaysText]);

  const f = facets(rows, filters);
  const active = hasActiveFilter(filters);
  // A refinement that is ACTIVE while folded away has to announce itself, or
  // the list is narrowed for no reason the reader can see — the same trap a
  // vanishing chip sets. The badge is what stands in for the hidden chips.
  const hiddenActive = filters.venues.length + (minDays(filters) === null ? 0 : 1);
  // Judged on what the reader has TYPED, not on the debounced value the list is
  // filtered by — the red border must answer the keystroke, not trail it.
  const minDaysBad =
    minDaysText.trim() !== '' && minDays({ ...filters, minDaysText }) === null;

  return (
    <div
      className="mb-3 flex flex-col gap-2 px-0.5"
      role="group"
      aria-label="Filter opportunities"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <FacetGroup
          label="Asset"
          options={f.assets}
          poolSize={f.poolSize.assets}
          onToggle={(v) => onChange({ ...filters, assets: toggleValue(filters.assets, v) })}
        />

        <span className="ml-auto flex items-center gap-2">
          <span className="num text-[11px] text-ink-400" aria-live="polite">
            showing {shown} of {rows.length}
          </span>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? moreId : undefined}
            aria-label={hiddenActive > 0 ? `Filters, ${hiddenActive} active` : 'Filters'}
            title="Venue and how far out it matures"
            onClick={() => setMoreOpen((v) => !v)}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
              hiddenActive > 0
                ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                : 'border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100'
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
              <path d="M2 3h12L9.5 8.6V14L6.5 12.4V8.6z" />
            </svg>
            Filters
            {hiddenActive > 0 && (
              <span className="num rounded bg-cyan-500/20 px-1 text-[10px] leading-4 text-cyan-200">
                {hiddenActive}
              </span>
            )}
          </button>
        </span>
      </div>

      {moreOpen && (
        <FilterPopover id={moreId} anchorRef={triggerRef} onDismiss={dismiss}>
          <FacetGroup
            label="Venue"
            options={f.venues}
            poolSize={f.poolSize.venues}
            titleOf={(v) => `Opportunities with either leg on ${v}`}
            onToggle={(v) => onChange({ ...filters, venues: toggleValue(filters.venues, v) })}
          />
          <span className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={minDaysId} className={`${microLabelClass} mr-0.5`}>
              Matures in more than
            </label>
            <input
              id={minDaysId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="any"
              value={minDaysText}
              onChange={(e) => setMinDaysText(e.target.value)}
              title="Shortest tenor to keep, in days — a plain number, e.g. 30. A card printing exactly that many days is not more than it, so it is cut too."
              aria-invalid={minDaysBad}
              aria-describedby={minDaysBad ? `${minDaysId}-err` : undefined}
              className={`input num h-[26px] w-16 !px-2 !py-0 text-[11px] ${
                minDaysBad ? 'border-rose-500/60' : ''
              }`}
            />
            <span className="text-[11px] text-ink-400">days</span>
            {minDaysBad && (
              <span id={`${minDaysId}-err`} role="alert" className="text-[11px] text-rose-300">
                needs a plain number
              </span>
            )}
          </span>

          {active && (
            <div className="flex justify-end border-t border-ink-800 pt-2.5">
              <button type="button" className="btn-ghost-xs" onClick={() => onChange(NO_FILTERS)}>
                Clear filters
              </button>
            </div>
          )}
        </FilterPopover>
      )}
    </div>
  );
}
