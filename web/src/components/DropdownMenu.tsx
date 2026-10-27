import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownMenuItem {
  label: string;
  onSelect: () => void;
}

type FocusOnOpen = 'first' | 'last' | 'menu';

interface Place {
  left: number;
  top?: number;
  bottom?: number;
  placed: boolean;
}

const GAP = 6;
const EDGE = 8;

export function DropdownMenu({
  label,
  trigger,
  triggerClassName,
  items,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  items: DropdownMenuItem[];
}) {
  const [open, setOpen] = useState<FocusOnOpen | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const fired = useRef(false);
  const menuId = useId();

  const show = (focus: FocusOnOpen) => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    fired.current = false;
    setPlace({ left: r.right, top: r.bottom + GAP, placed: false });
    setOpen(focus);
  };

  const hide = (refocus: boolean) => {
    if (refocus) button.current?.focus();
    setOpen(null);
    setPlace(null);
  };

  const menuItems = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useLayoutEffect(() => {
    if (!place || place.placed || !panel.current || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = panel.current.offsetWidth;
    const height = panel.current.offsetHeight;
    const left = Math.max(EDGE, Math.min(r.right, window.innerWidth - EDGE) - width);
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = height > below && above > below;
    setPlace(up ? { left, bottom: window.innerHeight - r.top + GAP, placed: true } : { left, top: r.bottom + GAP, placed: true });
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const list = menuItems();
    const target = open === 'first' ? list[0] : open === 'last' ? list[list.length - 1] : panel.current;
    target?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (button.current?.contains(target) || panel.current?.contains(target)) return;
      hide(false);
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return;
      hide(false);
    };
    const onResize = () => hide(false);
    document.addEventListener('mousedown', onOutside);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const select = (item: DropdownMenuItem) => {
    if (fired.current) return;
    fired.current = true;
    hide(true);
    item.onSelect();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) hide(true);
      else show(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide(true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      hide(true);
      return;
    }
    const list = menuItems();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    if ((e.key === 'Enter' || e.key === ' ') && at >= 0) {
      e.preventDefault();
      if (!e.repeat) select(items[at]);
      return;
    }
    const next =
      e.key === 'ArrowDown'
        ? (at + 1) % list.length
        : e.key === 'ArrowUp'
          ? (at <= 0 ? list.length : at) - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? list.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    list[next].focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? menuId : undefined}
        className={triggerClassName}
        onClick={() => (open ? hide(false) : show('menu'))}
        onKeyDown={onTriggerKey}
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
      >
        {trigger}
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            id={menuId}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onMenuKey}
            onKeyUp={(e) => {
              if (e.key === ' ') e.preventDefault();
            }}
            style={{ left: place.left, top: place.top, bottom: place.bottom }}
            className="pp-tooltip fixed z-50 min-w-32 p-px outline-none"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
                onClick={() => select(item)}
                className="flex w-full cursor-pointer select-none items-center whitespace-nowrap rounded px-2 py-1 text-left text-[12px] text-ink-50 outline-none transition-colors hover:bg-info/25 focus:bg-info/25"
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
