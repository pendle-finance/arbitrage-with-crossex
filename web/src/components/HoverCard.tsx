import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FOCUSABLE } from '../lib/focusTrap';

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
  maxHeight?: number;
  /** The trigger's edges, kept so the card can pick a side once it has a height. */
  anchorTop: number;
  anchorBottom: number;
  placed: boolean;
}

const GAP = 6;
const EDGE = 8;

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
  widthPx,
  icon = true,
  underline = true,
  wrapsControl = false,
  children,
}: {
  /** The figure itself — it keeps its own styling. */
  label: ReactNode;
  widthPx?: number;
  icon?: boolean;
  underline?: boolean;
  wrapsControl?: boolean;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const openedByKeyboard = useRef(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const maxWidthPx = widthPx ?? 460;

  const stopClosing = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };

  /**
   * Measured once, on open. The card shuts on scroll and resize, so the one
   * measurement can never go stale. It first renders below the trigger, then
   * picks its side before paint, once it has a height: below when it fits,
   * above when only that fits, else the roomier side with its own scroll. A
   * tall card near the bottom of the page otherwise ran off the screen.
   */
  const open = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    stopClosing();
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - maxWidthPx - EDGE));
    setBox({ left, top: r.bottom + GAP, anchorTop: r.top, anchorBottom: r.bottom, placed: false });
  };

  useLayoutEffect(() => {
    if (!box || box.placed || !card.current) return;
    const height = card.current.scrollHeight;
    const below = window.innerHeight - box.anchorBottom - GAP - EDGE;
    const above = box.anchorTop - GAP - EDGE;
    const up = height > below && (height <= above || above > below);
    setBox(
      up
        ? { ...box, top: undefined, bottom: window.innerHeight - box.anchorTop + GAP, maxHeight: Math.max(0, above), placed: true }
        : { ...box, maxHeight: Math.max(0, below), placed: true },
    );
  }, [box]);

  /** Leaving the trigger waits, so the pointer can cross the gap into the
   * card; leaving the card itself does not. */
  const close = (delayed: boolean) => {
    stopClosing();
    if (delayed) closing.current = setTimeout(() => setBox(null), 120);
    else setBox(null);
  };

  useEffect(() => {
    if (!box) return;
    // Scrolling inside the card reads it; only a scroll elsewhere moves the trigger.
    const shut = (e: Event) => {
      if (e.target instanceof Node && card.current?.contains(e.target)) return;
      setBox(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (card.current?.contains(document.activeElement)) anchor.current?.focus();
      setBox(null);
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (anchor.current?.contains(target)) return;
      if (card.current?.contains(target)) return;
      setBox(null);
    };
    window.addEventListener('scroll', shut, true);
    const onResize = () => setBox(null);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [box]);

  useEffect(() => {
    if (!box || !openedByKeyboard.current) return;
    openedByKeyboard.current = false;
    card.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [box]);

  useEffect(() => stopClosing, []);

  const portal =
    box &&
    createPortal(
      <div
        ref={card}
        role="tooltip"
        style={{ left: box.left, top: box.top, bottom: box.bottom, width: widthPx, maxWidth: maxWidthPx, maxHeight: box.maxHeight }}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const items = e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE);
          const edge = e.shiftKey ? items[0] : items[items.length - 1];
          if (!edge || document.activeElement !== edge) return;
          e.preventDefault();
          anchor.current?.focus();
          setBox(null);
        }}
        onMouseEnter={stopClosing}
        onMouseLeave={() => close(false)}
        className="fixed z-50 overflow-y-auto overscroll-contain rounded border border-ink-600 bg-ink-950 px-3 py-2.5 text-ink-100"
      >
        {children}
      </div>,
      document.body,
    );

  if (wrapsControl) {
    return (
      <span
        ref={anchor}
        onMouseEnter={open}
        onMouseLeave={() => close(true)}
        onFocus={open}
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && card.current?.contains(next)) return;
          close(false);
        }}
        className="inline-flex"
      >
        {label}
        {portal}
      </span>
    );
  }

  return (
    <span
      ref={anchor}
      /* Reachable by keyboard: a button role, a tab stop, and Enter/Space
         toggling it — the pointer-only trigger left the card unopenable
         without a mouse, and its own Escape handler unreachable. */
      role="button"
      tabIndex={0}
      aria-expanded={box !== null}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          if (box) {
            setBox(null);
            return;
          }
          openedByKeyboard.current = true;
          open();
        }
      }}
      onMouseEnter={open}
      onMouseLeave={() => close(true)}
      /* These triggers sit inside larger buttons (the card hero toggles its
         own charts). Reading the breakdown must not also fire that. */
      onClick={(e) => {
        const fromCard = e.target instanceof Node && card.current?.contains(e.target);
        if (!fromCard) e.preventDefault();
        e.stopPropagation();
        if (box) setBox(null);
        else open();
      }}
      /* An empty title stops an ANCESTOR's title being inherited here. The
         card hero is a button titled "Show the waterfall breakdown", and that
         native tooltip otherwise opens on top of this card's first row. */
      title=""
      className={`inline-flex cursor-help items-center gap-1 text-ink-400 transition-colors hover:text-cyan-200 ${
        underline ? 'border-b border-dotted border-ink-600 hover:border-cyan-400/70' : ''
      }`}
    >
      {label}
      {icon && <InfoMark />}
      {portal}
    </span>
  );
}
