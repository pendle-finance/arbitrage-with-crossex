import { useEffect, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  /** While locked (execution in flight) the ✕ is hidden and Escape/backdrop
   * are ignored — closing unmounts the children, and an executing ticket's
   * result would die with them. Mirrors Modal's prop of the same name. */
  locked?: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Right-side overlay drawer (Settings). Escape or backdrop click closes. */
export function Drawer({ open, title, locked = false, onClose, children }: Props) {
  useEffect(() => {
    if (!open || locked) return;
    const onKey = (e: KeyboardEvent) => {
      // e.repeat: a HELD Escape auto-repeats, and surfaces with an arm-then-
      // confirm close guard would see the repeat as the confirming second call.
      if (e.key === 'Escape' && !e.repeat) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, locked, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={locked ? undefined : onClose} />
      <div className="absolute inset-y-0 right-0 flex w-[380px] max-w-[92vw] flex-col border-l border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
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
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
