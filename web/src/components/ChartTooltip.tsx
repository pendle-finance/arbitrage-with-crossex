import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const POINTER_GAP_PX = 12;
const EDGE_PX = 8;

interface Point {
  x: number;
  y: number;
}

const place = (at: number, size: number, room: number): number =>
  room > 0 ? Math.max(EDGE_PX, Math.min(at + POINTER_GAP_PX, room - size - EDGE_PX)) : at + POINTER_GAP_PX;

export function ChartTooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const tooltipId = useId();
  const tip = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const el = tip.current;
    if (!point || !el) return;
    el.style.left = `${place(point.x, el.offsetWidth, window.innerWidth)}px`;
    el.style.top = `${place(point.y, el.offsetHeight, window.innerHeight)}px`;
  });

  const follow = (e: { clientX: number; clientY: number }) => setPoint({ x: e.clientX, y: e.clientY });
  const hide = () => setPoint(null);

  return (
    <>
      <div
        data-bar-hit=""
        tabIndex={0}
        aria-describedby={point ? tooltipId : undefined}
        onMouseEnter={follow}
        onMouseMove={follow}
        onMouseLeave={hide}
        onFocus={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPoint((current) => current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !point) return;
          e.stopPropagation();
          hide();
        }}
        className="cursor-pointer"
      >
        {children}
      </div>
      {point &&
        createPortal(
          <div
            ref={tip}
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none fixed z-[60] rounded border border-ink-600 bg-ink-950 px-3 py-2.5 text-ink-100"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
