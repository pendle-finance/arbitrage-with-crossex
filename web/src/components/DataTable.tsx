import { Fragment, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Numeric columns should be right-aligned. */
  align?: 'left' | 'right';
  className?: string;
  render: (row: T) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** When provided, rows get a chevron toggle and can expand to this content. */
  renderExpanded?: (row: T) => ReactNode;
  /** Extra classes per row — e.g. dimming a row whose cancel is in flight. */
  rowClassName?: (row: T) => string;
  /** Rendered instead of the table when rows is empty. */
  emptyState?: ReactNode;
  maxHeightClass?: string;
}

/** Dense dark table: sticky header, mono numerals via callers' `.num`,
 * optional expandable rows, hover-revealed row actions (use `group-hover:`). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  renderExpanded,
  rowClassName,
  emptyState,
  maxHeightClass = 'max-h-[65vh]',
}: Props<T>) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!rows.length && emptyState) return <>{emptyState}</>;

  const expandable = Boolean(renderExpanded);
  const colSpan = columns.length + (expandable ? 1 : 0);
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="card overflow-hidden">
      <div className={`overflow-x-auto overflow-y-auto ${maxHeightClass}`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {expandable && <th className="th w-8" aria-hidden />}
              {columns.map((c) => (
                <th key={c.key} className={`th ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const k = rowKey(row);
              const isOpen = open.has(k);
              // A row with nothing to expand into gets no chevron. The caller
              // says so by returning null from renderExpanded — a placeholder
              // row for a leg that is not open has no live position, no
              // settlements and no membership, and a control that opens an
              // empty drawer is a control that lies.
              const expansion = renderExpanded?.(row) ?? null;
              const rowExpandable = expandable && expansion !== null;
              return (
                <Fragment key={k}>
                  <tr
                    className={`group border-t border-ink-800 first:border-t-0 transition-opacity hover:bg-ink-800/50 ${
                      rowClassName?.(row) ?? ''
                    }`}
                  >
                    {expandable && (
                      <td className="py-1.5 pl-2">
                        {rowExpandable && (
                          <button
                            type="button"
                            aria-label="toggle details"
                            aria-expanded={isOpen}
                            onClick={() => toggle(k)}
                            className="rounded px-1 text-ink-400 transition-colors hover:text-ink-100"
                          >
                            {isOpen ? '▾' : '▸'}
                          </button>
                        )}
                      </td>
                    )}
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        // px-2: these tables now carry up to six columns inside
                        // a fixed-width card, and px-3 pushed the last one past
                        // the edge — the horizontal scroll saved the data but
                        // put a row action out of reach, which is the opposite
                        // of what a row action is for.
                        className={`whitespace-nowrap px-2 py-1.5 align-middle ${
                          c.align === 'right' ? 'text-right' : 'text-left'
                        } ${c.className ?? ''}`}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                  {isOpen && rowExpandable && (
                    <tr className="border-t border-ink-800 bg-ink-950/70">
                      <td colSpan={colSpan} className="px-4 py-3">
                        {expansion}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
