import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface Place {
  left: number;
  width?: number;
  top?: number;
  bottom?: number;
  placed: boolean;
}

const GAP = 6;
const EDGE = 8;

export function usePopoverPlacement({
  button,
  panel,
  anchor,
  open,
  onClose,
}: {
  button: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  anchor: 'left' | 'right';
  open: boolean;
  onClose: () => void;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const start = (): boolean => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return false;
    setPlace(
      anchor === 'left'
        ? { left: r.left, width: r.width, top: r.bottom + GAP, placed: false }
        : { left: r.right, top: r.bottom + GAP, placed: false },
    );
    return true;
  };

  const stop = () => setPlace(null);

  useLayoutEffect(() => {
    if (!place || place.placed || !panel.current || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const height = panel.current.offsetHeight;
    const left =
      anchor === 'left'
        ? Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - r.width))
        : Math.max(EDGE, Math.min(r.right, window.innerWidth - EDGE) - panel.current.offsetWidth);
    const width = anchor === 'left' ? r.width : undefined;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = height > below && above > below;
    setPlace(
      up
        ? { left, width, bottom: window.innerHeight - r.top + GAP, placed: true }
        : { left, width, top: r.bottom + GAP, placed: true },
    );
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (button.current?.contains(target) || panel.current?.contains(target)) return;
      close.current();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return;
      close.current();
    };
    const onResize = () => close.current();
    document.addEventListener('mousedown', onOutside);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return { place, start, stop };
}
