import type { ReactNode } from 'react';

type Tone = 'danger' | 'warn';

const BOX: Record<Tone, string> = {
  danger: 'border-rose-500/40 bg-rose-500/5 text-rose-200',
  warn: 'border-amber-500/40 bg-amber-500/5 text-amber-200',
};

/**
 * An inline question: one action and one way back. Every "are you sure?" in a
 * row or a form uses this, so the two buttons always share one size and the
 * box, the text sizes and the button order stay the same everywhere.
 */
export function InlineConfirm({
  tone,
  label,
  question,
  children,
  confirmLabel,
  busyLabel,
  busy = false,
  confirmKind = tone === 'danger' ? 'danger' : 'primary',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: {
  tone: Tone;
  /** The accessible name, usually the question itself. */
  label: string;
  question: ReactNode;
  /** Details under the question, such as a list of what happens. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  busyLabel?: ReactNode;
  busy?: boolean;
  /** 'neutral' for an action that is not the page's main one, such as Skip. */
  confirmKind?: 'primary' | 'danger' | 'neutral';
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmClass = confirmKind === 'danger' ? 'btn-danger' : confirmKind === 'neutral' ? 'btn' : 'btn-primary';
  return (
    <div role="alertdialog" aria-label={label} className={`flex flex-col gap-2 rounded-lg border px-3 py-2 ${BOX[tone]}`}>
      <div className="text-[12px]">{question}</div>
      {children && <div className="text-[11px] leading-relaxed opacity-90">{children}</div>}
      <div className="flex items-center gap-2">
        <button type="button" className={`${confirmClass} num`} disabled={busy} onClick={onConfirm}>
          {busy && busyLabel ? busyLabel : confirmLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
