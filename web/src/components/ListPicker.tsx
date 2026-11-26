import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPlacement } from './usePopoverPlacement';

export interface ListPickerRow<K extends string> {
  key: K;
  icon?: ReactNode;
  name: ReactNode;
  value?: ReactNode;
  disabled?: boolean;
}

export function ListPicker<K extends string>({
  rows,
  value,
  onChange,
  label,
  placeholder,
  disabled = false,
  id,
}: {
  rows: ListPickerRow<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  placeholder?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const fired = useRef(false);
  const listId = useId();
  const picked = rows.find((row) => row.key === value) ?? null;
  const { place, start, stop } = usePopoverPlacement({ button, panel, anchor: 'left', open, onClose: () => hide(false) });

  const show = () => {
    if (!start()) return;
    fired.current = false;
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
    panel.current?.focus({ preventScroll: true });
  }, [open, place]);

  const select = (row: ListPickerRow<K>) => {
    if (fired.current || row.disabled) return;
    fired.current = true;
    hide(true);
    if (row.key !== value) onChange(row.key);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) hide(true);
      else show();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      hide(true);
      return;
    }
    if (rows.length === 0) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) select(rows[active]);
      return;
    }
    const next = e.key === 'ArrowDown' ? (active + 1) % rows.length : e.key === 'ArrowUp' ? (active <= 0 ? rows.length : active) - 1 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
  };

  const optionId = (row: ListPickerRow<K>) => `${listId}-${row.key}`;
  const line = 'flex min-w-0 items-center justify-between gap-3';

  return (
    <>
      <button
        ref={button}
        id={id}
        data-value={value}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={`flex h-[35px] w-full cursor-pointer items-center gap-2 rounded border bg-wash/[0.05] pl-2.5 pr-2.5 text-left text-sm font-medium transition-colors hover:bg-wash/[0.08] disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-info/70' : 'border-ink-700'
        }`}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={onTriggerKey}
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
      >
        {!picked && <span className="flex-1 truncate font-normal text-ink-400">{placeholder}</span>}
        {picked && (
          <span className={`${line} flex-1`}>
            <span className="flex min-w-0 items-center gap-2">
              {picked.icon}
              <span className="truncate text-ink-50">{picked.name}</span>
            </span>
            {picked.value && <span className="num shrink-0 text-xs font-normal text-ink-300">{picked.value}</span>}
          </span>
        )}
        <ChevronDown size={14} aria-hidden className={`shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-activedescendant={rows[active] ? optionId(rows[active]) : undefined}
            tabIndex={-1}
            onKeyDown={onListKey}
            onKeyUp={(e) => {
              if (e.key === ' ') e.preventDefault();
            }}
            style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom }}
            className="pp-tooltip fixed z-50 flex max-h-64 flex-col overflow-y-auto p-1 outline-none"
          >
            {rows.map((row, at) => (
              <button
                key={row.key}
                id={optionId(row)}
                data-value={row.key}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={row.key === value}
                aria-disabled={row.disabled || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(at)}
                onClick={() => select(row)}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${row.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${at === active ? 'bg-info/15' : ''}`}
              >
                <span className="flex w-3.5 shrink-0 text-info">{row.key === value && <Check size={14} aria-hidden />}</span>
                <span className={`${line} flex-1`}>
                  <span className="flex min-w-0 items-center gap-2">
                    {row.icon}
                    <span className="truncate text-ink-50">{row.name}</span>
                  </span>
                  {row.value && <span className="num shrink-0 text-ink-300">{row.value}</span>}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
