import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: ReactNode;
  /** While locked (execution in flight) the ✕ is hidden and Escape/backdrop are ignored. */
  locked?: boolean;
  onClose: () => void;
  widthClass?: string;
  children: ReactNode;
}

/** Centered overlay modal (review + execution views). Portaled to <body>: an
 * ancestor with backdrop-filter/transform (the sticky blurred header, where
 * the update pill lives) would otherwise become the containing block for the
 * fixed overlay and trap it — half-hidden behind the page content. */
export function Modal({ title, locked = false, onClose, widthClass = 'w-[700px]', children }: Props) {
  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      // e.repeat: a HELD Escape auto-repeats, and surfaces with an arm-then-
      // confirm close guard (the wizard's leave warning) would see the repeat
      // as the confirming second call.
      if (e.key === 'Escape' && !e.repeat) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={locked ? undefined : onClose}
      />
      <div className={`relative mt-12 max-w-[95vw] rounded-xl border border-ink-700 bg-ink-900 shadow-2xl ${widthClass}`}>
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          {!locked && (
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="rounded-md px-2 py-0.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
            >
              ✕
            </button>
          )}
        </div>
        <div className="max-h-[78vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
