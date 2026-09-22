/**
 * ONE tooltip for the whole app, in the house style (the mock's
 * UiTooltipContent), driven by the `title` attributes the app already has.
 *
 * The browser's own tooltip cannot be styled, arrives late, and renders a long
 * explanation as one grey run-on line. Rather than rewrite ~300 call sites to a
 * component, this layer listens at the document: on hover/focus it lifts the
 * element's `title` into `data-tip` (which also stops the native one from
 * appearing) and shows the text in a single portaled node. React only rewrites
 * an attribute whose prop changed, so the lift survives re-renders, and a
 * changed `title` simply wins again on the next hover.
 *
 * The text is plain, with three conventions so a BREAKDOWN can read as one:
 *   "Label\tvalue"  → a row: label left, value right-aligned in tabular figures
 *   "---"           → a hairline between groups (e.g. above a total)
 *   "* note"        → a muted footnote
 * Several plain lines → the first is the heading. One plain line → just text.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;
const EDGE = 8;

/**
 * The element under the pointer that carries a tip, and its text.
 *
 * The `title` attribute is LEFT IN PLACE: React owns it, so it stays correct
 * as data changes, and removing it was the bug — a render that drops the prop
 * (`title={cond ? x : undefined}`) cannot clear an attribute React no longer
 * manages, and the stale text would show forever. The native tooltip is
 * suppressed in CSS-free fashion instead, by the layer's pointer handling
 * below (see `suppressNative`).
 */
function tipTarget(from: EventTarget | null): { el: HTMLElement; text: string } | null {
  if (!(from instanceof Element)) return null;
  const el = from.closest<HTMLElement>('[title], [data-tip]');
  if (!el) return null;
  const text = el.dataset.tip ?? el.getAttribute('title') ?? '';
  // A deliberate `title=""` (HoverCard's trigger) blocks an ancestor's tip.
  if (!text.trim()) return null;
  if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-description')) {
    el.setAttribute('aria-description', text);
  }
  return { el, text };
}

/**
 * Stop the browser drawing its own tooltip over ours, without destroying the
 * attribute: the text is parked in a property for as long as the pointer is
 * on the element, and put back the moment it leaves. React writing `title`
 * in between simply wins — the restore only runs if nothing else has.
 */
function suppressNative(el: HTMLElement): () => void {
  const parked = el.getAttribute('title');
  if (parked === null) return () => {};
  el.removeAttribute('title');
  return () => {
    if (!el.hasAttribute('title')) el.setAttribute('title', parked);
  };
}

function Body({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const hasRows = lines.some((l) => l.includes('\t'));
  if (lines.length === 1 && !hasRows) return <>{lines[0]}</>;
  return (
    <div className={`flex flex-col gap-1.5 ${hasRows ? 'min-w-[220px] py-1' : ''}`}>
      {lines.map((line, i) => {
        if (line.trim() === '---') return <div key={i} className="my-0.5 border-t border-ink-600" />;
        if (line.startsWith('*')) {
          return (
            <div key={i} className="max-w-[300px] pt-0.5 text-[11px] leading-[1.45] text-ink-500">
              {line}
            </div>
          );
        }
        if (line.includes('\t')) {
          const [label, ...rest] = line.split('\t');
          return (
            <div key={i} className="flex items-baseline justify-between gap-6">
              <span className="text-ink-300">{label}</span>
              <span className="num whitespace-nowrap font-medium text-ink-50">{rest.join(' ')}</span>
            </div>
          );
        }
        return (
          <div key={i} className={i === 0 ? 'font-semibold text-ink-50' : 'text-ink-100'}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const node = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);
  const restore = useRef<() => void>(() => {});

  useEffect(() => {
    const show = (e: Event) => {
      const found = tipTarget(e.target);
      if ((found?.el ?? null) === current.current) return;
      restore.current();
      restore.current = () => {};
      current.current = found?.el ?? null;
      setPos(null);
      if (!found) {
        setTip(null);
        return;
      }
      restore.current = suppressNative(found.el);
      setTip({ text: found.text, rect: found.el.getBoundingClientRect() });
    };
    const hide = () => {
      restore.current();
      restore.current = () => {};
      current.current = null;
      setTip(null);
    };
    document.addEventListener('mouseover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('focusout', hide);
    document.addEventListener('click', hide, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', hide, true);
    return () => {
      document.removeEventListener('mouseover', show);
      document.removeEventListener('focusin', show);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('click', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', hide, true);
      restore.current();
    };
  }, []);

  // Placed once it has a size: centred over the target, above when it fits.
  useLayoutEffect(() => {
    if (!tip || !node.current) return;
    const t = node.current.getBoundingClientRect();
    const r = tip.rect;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - EDGE);
    const above = r.top - t.height - GAP;
    setPos({ left, top: above >= EDGE ? above : r.bottom + GAP });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={node}
      role="tooltip"
      className="pp-tooltip pointer-events-none fixed z-[1090] max-w-[340px]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <Body text={tip.text} />
    </div>,
    document.body,
  );
}
