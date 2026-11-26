import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { TokenIcon } from './AssetIcon';
import { prettyVenue } from '../lib/fmt';
import { PairTitle } from './PairTitle';
import { usePopoverPlacement } from './usePopoverPlacement';

export interface PairPickerRow {
  key: string;
  longVenue: string;
  shortVenue: string;
  base: string;
  maturityText: string;
  sizeText: string;
  imText: string;
}

function matches(row: PairPickerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [row.base, row.longVenue, row.shortVenue, prettyVenue(row.longVenue), prettyVenue(row.shortVenue)].some((s) =>
    s.toLowerCase().includes(q),
  );
}

function PairCell({ row }: { row: PairPickerRow }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-pp-base font-semibold text-ink-50">
        <TokenIcon symbol={row.base} size={16} />
        <span>{row.base}</span>
        <span className="text-ink-500">·</span>
        <PairTitle longVenue={row.longVenue} shortVenue={row.shortVenue} />
      </span>
      <span className="text-pp-sm2 font-normal text-ink-400">{row.maturityText}</span>
    </span>
  );
}

export function PairPicker({
  rows,
  value,
  onChange,
  label,
  searchLabel,
  columns,
  emptyText,
  disabled = false,
}: {
  rows: PairPickerRow[];
  value: string | null;
  onChange: (key: string) => void;
  label: string;
  searchLabel: string;
  columns: { pair: string; size: string; im: string };
  emptyText: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fired = useRef(false);
  const listId = useId();
  const picked = rows.find((row) => row.key === value) ?? null;
  const shown = rows.filter((row) => matches(row, query));
  const { place, start, stop } = usePopoverPlacement({ button, panel, anchor: 'left', open, onClose: () => hide(false) });

  const show = () => {
    if (!start()) return;
    fired.current = false;
    setQuery('');
    setActive(Math.max(0, rows.findIndex((row) => row.key === value)));
    setOpen(true);
  };

  const hide = (refocus: boolean) => {
    if (refocus) button.current?.focus();
    setOpen(false);
    stop();
  };

  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [open]);

  const select = (row: PairPickerRow) => {
    if (fired.current) return;
    fired.current = true;
    hide(true);
    onChange(row.key);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) hide(true);
      else show();
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      hide(true);
      return;
    }
    if (shown.length === 0) return;
    const at = Math.min(active, shown.length - 1);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) select(shown[at]);
      return;
    }
    const next = e.key === 'ArrowDown' ? (at + 1) % shown.length : e.key === 'ArrowUp' ? (at <= 0 ? shown.length : at) - 1 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
  };

  const optionId = (row: PairPickerRow) => `${listId}-${row.key}`;
  const activeRow = shown[Math.min(active, shown.length - 1)] ?? null;
  const grid = 'flex items-center gap-2.5';

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled || rows.length === 0}
        className={`flex w-full cursor-pointer items-center gap-3 rounded border bg-ink-900/40 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? 'border-info' : 'border-ink-700 hover:border-ink-500'
        }`}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={onTriggerKey}
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
      >
        {picked ? <PairCell row={picked} /> : <span className="flex-1 text-pp-base text-ink-400">{label}</span>}
        {picked && (
          <span className="num flex shrink-0 flex-col items-end gap-1 text-pp-base text-ink-50">
            {picked.sizeText}
            <span className="text-pp-sm2 text-ink-400">{t('accounts.deleverTab.im', { usd: picked.imText })}</span>
          </span>
        )}
        <ChevronDown size={14} aria-hidden className={`shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom }}
            className="pp-tooltip fixed z-50 flex flex-col gap-2 p-2"
          >
            <input
              ref={search}
              role="combobox"
              aria-label={searchLabel}
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
              placeholder={searchLabel}
              className="input h-8 w-full"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
            />
            <div className="flex flex-col overflow-hidden rounded border border-ink-800">
              <div className={`${grid} bg-ink-900/40 px-3 py-1.5 text-pp-sm2 text-ink-400`}>
                <span className="w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{columns.pair}</span>
                <span className="w-28 shrink-0 whitespace-nowrap text-right">{columns.size}</span>
                <span className="w-24 shrink-0 text-right">{columns.im}</span>
              </div>
              <div id={listId} role="listbox" aria-label={label} className="flex max-h-64 flex-col overflow-y-auto">
                {shown.map((row) => (
                  <button
                    key={row.key}
                    id={optionId(row)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={row.key === value}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(shown.indexOf(row))}
                    onClick={() => select(row)}
                    className={`${grid} cursor-pointer border-t border-ink-800 px-3 py-2 text-left first:border-t-0 ${
                      row === activeRow ? 'bg-info/10' : ''
                    }`}
                  >
                    <span className="flex w-3.5 shrink-0 text-info">{row.key === value && <Check size={14} aria-hidden />}</span>
                    <PairCell row={row} />
                    <span className="num w-28 shrink-0 whitespace-nowrap text-right text-pp-base text-ink-50">{row.sizeText}</span>
                    <span className="num w-24 shrink-0 text-right text-pp-base text-ink-50">{row.imText}</span>
                  </button>
                ))}
                {shown.length === 0 && <span className="px-3 py-2 text-pp-base text-ink-400">{emptyText}</span>}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
