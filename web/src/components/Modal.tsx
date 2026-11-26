import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { claimEscape, useFocusTrap } from '../lib/focusTrap';

interface Props {
  title: ReactNode;
  /** While locked (execution in flight) the ✕ is hidden and Escape/backdrop are ignored. */
  locked?: boolean;
  onClose: () => void;
  widthClass?: string;
  tabbed?: boolean;
  children: ReactNode;
}

/** Centered overlay modal (review + execution views). Portaled to <body>: an
 * ancestor with backdrop-filter/transform (the sticky blurred header, where
 * the update pill lives) would otherwise become the containing block for the
 * fixed overlay and trap it — half-hidden behind the page content. */
export function Modal({ title, locked = false, onClose, widthClass = 'w-[700px]', tabbed = false, children }: Props) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useFocusTrap(panel, true);
  useEffect(() => {
    heading.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, []);
  // Lock the page behind the modal (see Drawer): saved and restored, so a
  // modal stacked over another hands back the state it found.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      // e.repeat: a HELD Escape auto-repeats, and surfaces with an arm-then-
      // confirm close guard (the wizard's leave warning) would see the repeat
      // as the confirming second call.
      if (e.key === 'Escape' && !e.repeat && claimEscape(e, panel.current)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/80"
        onClick={locked ? undefined : onClose}
      />
      <div ref={panel} className={`relative mt-12 max-w-[95vw] rounded-xl border border-ink-700 bg-ink-950 ${widthClass}`}>
        <div className={`flex items-center justify-between gap-3 ${tabbed ? 'border-b border-ink-800' : `border-b px-5 pb-4 pt-5 ${scrolled ? 'border-ink-800' : 'border-transparent'}`}`}>
          <h2 ref={heading} className={`text-[20px] font-bold leading-[24.2px] text-ink-50 ${tabbed ? 'min-w-0 flex-1 self-stretch' : ''}`}>{title}</h2>
          {!locked && !tabbed && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('app.closeAria')}
              className="rounded-full p-1 text-ink-300 transition-colors hover:bg-ink-500/25 hover:text-ink-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink-400"
            >
              <X size={20} aria-hidden />
            </button>
          )}
        </div>
        <div
          className={`max-h-[78vh] overflow-y-auto ${tabbed ? 'px-5 pb-5 pt-4' : 'px-5 pb-5 pt-1'}`}
          onScroll={tabbed ? undefined : (e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
