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
  anchorLeft: number;
  anchorRight: number;
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
  openOn = 'hover',
  children,
}: {
  /** The figure itself — it keeps its own styling. */
  label: ReactNode;
  widthPx?: number;
  icon?: boolean;
  underline?: boolean;
  wrapsControl?: boolean;
  /** 'click' for a card that holds a form (a date input): it opens on click and
   * stays open until a click outside, Escape, or a second click. Hover would
   * shut it the moment the pointer drifts. Only with `wrapsControl`. */
  openOn?: 'hover' | 'click';
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
    setBox({
      left,
      top: r.bottom + GAP,
      anchorTop: r.top,
      anchorBottom: r.bottom,
      anchorLeft: r.left,
      anchorRight: r.right,
      placed: false,
    });
  };

  useLayoutEffect(() => {
    if (!box || box.placed || !card.current) return;
    const height = card.current.scrollHeight;
    // The card's REAL width, now that it has rendered. Clamping by the widest
    // allowed card pushed a narrow card far left of a trigger near the right
    // edge. Start under the trigger; if that overflows, end at its right edge.
    const width = card.current.offsetWidth;
    const left =
      box.anchorLeft + width <= window.innerWidth - EDGE
        ? box.anchorLeft
        : Math.max(EDGE, Math.min(box.anchorRight, window.innerWidth - EDGE) - width);
    const below = window.innerHeight - box.anchorBottom - GAP - EDGE;
    const above = box.anchorTop - GAP - EDGE;
    const up = height > below && (height <= above || above > below);
    setBox(
      up
        ? { ...box, left, top: undefined, bottom: window.innerHeight - box.anchorTop + GAP, maxHeight: Math.max(0, above), placed: true }
        : { ...box, left, maxHeight: Math.max(0, below), placed: true },
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
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (anchor.current?.contains(target) || card.current?.contains(target)) return;
      setBox(null);
    };
    if (openOn === 'click') document.addEventListener('mousedown', onOutside);
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
      document.removeEventListener('mousedown', onOutside);
    };
  }, [box, openOn]);

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
        onMouseLeave={openOn === 'click' ? undefined : () => close(false)}
        className="pp-tooltip fixed z-50 overflow-y-auto overscroll-contain"
      >
        {children}
      </div>,
      document.body,
    );

  if (wrapsControl && openOn === 'click') {
    return (
      <span
        ref={anchor}
        onClick={(e) => {
          if (e.target instanceof Node && card.current?.contains(e.target)) return;
          if (box) setBox(null);
          else open();
        }}
        className="inline-flex"
      >
        {label}
        {portal}
      </span>
    );
  }

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
      // The mock marks a label that carries a tooltip with a dotted rule at a
      // 4px offset — an underline on the TEXT, not a border on the box, so a
      // wrapped label stays marked on every line.
      className={`inline-flex cursor-help items-center gap-1 text-ink-400 transition-colors hover:text-ink-200 ${
        underline ? 'underline decoration-dotted underline-offset-4' : ''
      }`}
    >
      {label}
      {icon && <InfoMark />}
      {portal}
    </span>
  );
}
