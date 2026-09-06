import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A figure that shows its working when you point at it.
 *
 * `title` could not do this job. It is one unstyled paragraph, and nothing on
 * the page says it is there — a reader who never happens to rest the pointer
 * on the number never learns the breakdown exists. The trigger here carries a
 * dotted rule and a marker, so it looks like something to point at.
 *
 * Portaled and fixed, for the same reason Modal is: these cards sit inside
 * `overflow-hidden` boxes, and the header they can open near is blurred with
 * backdrop-filter, which would otherwise trap an absolutely-positioned panel.
 */

interface Box {
  left: number;
  top?: number;
  bottom?: number;
}

/** The marker. Nothing else on a card carries it, so it reads as "more here"
 * rather than decoration. */
function InfoMark() {
  return (
    <span
      aria-hidden
      className="inline-flex h-[11px] w-[11px] items-center justify-center rounded-full border border-current text-[8px] font-bold leading-none opacity-70"
    >
      i
    </span>
  );
}

export function HoverCard({
  label,
  widthPx = 460,
  children,
}: {
  /** The figure itself — it keeps its own styling. */
  label: ReactNode;
  widthPx?: number;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  const stopClosing = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };

  /**
   * Measured once, on open. The card shuts on scroll and resize, so the one
   * measurement can never go stale — and opening upward is anchored by
   * `bottom`, which needs no height from a panel that has not rendered yet.
   */
  const open = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    stopClosing();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - widthPx - 8));
    setBox(
      window.innerHeight - r.bottom < 260
        ? { left, bottom: window.innerHeight - r.top + 6 }
        : { left, top: r.bottom + 6 },
    );
  };

  /** Leaving the trigger waits, so the pointer can cross the gap into the
   * card; leaving the card itself does not. */
  const close = (delayed: boolean) => {
    stopClosing();
    if (delayed) closing.current = setTimeout(() => setBox(null), 120);
    else setBox(null);
  };

  useEffect(() => {
    if (!box) return;
    const shut = () => setBox(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBox(null);
    };
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', shut);
      window.removeEventListener('keydown', onKey);
    };
  }, [box]);

  useEffect(() => stopClosing, []);

  return (
    <span
      ref={anchor}
      onMouseEnter={open}
      onMouseLeave={() => close(true)}
      /* These triggers sit inside larger buttons (the card hero toggles its
         own charts). Reading the breakdown must not also fire that. */
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (box) setBox(null);
        else open();
      }}
      /* An empty title stops an ANCESTOR's title being inherited here. The
         card hero is a button titled "Show the waterfall breakdown", and that
         native tooltip otherwise opens on top of this card's first row. */
      title=""
      className="inline-flex cursor-help items-center gap-1 border-b border-dotted border-ink-600 text-ink-400 transition-colors hover:border-cyan-400/70 hover:text-cyan-200"
    >
      {label}
      <InfoMark />
      {box &&
        createPortal(
          <div
            role="tooltip"
            style={{ left: box.left, top: box.top, bottom: box.bottom, width: widthPx }}
            onMouseEnter={stopClosing}
            onMouseLeave={() => close(false)}
            className="fixed z-50 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-ink-200 shadow-xl shadow-black/60"
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
