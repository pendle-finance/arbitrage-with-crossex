import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  onConfirm: () => void;
  disabled?: boolean;
  /** Hold duration. The product gate is 800ms; tests may shorten. */
  holdMs?: number;
  /** Side coloring: green (buy), red (sell), cyan (mixed/neutral). */
  tone?: 'green' | 'red' | 'cyan';
  /** Extra classes appended to the base button (e.g. width/margin). */
  className?: string;
  children: ReactNode;
}

const TONES: Record<NonNullable<Props['tone']>, string> = {
  green: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25',
  red: 'border-rose-500/60 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25',
  // The mock's execute button: the one solid info fill in the ticket.
  cyan: 'border-transparent bg-info text-ink-50 hover:bg-info/75',
};

const R = 7;
const CIRC = 2 * Math.PI * R;

/**
 * Press-and-hold confirm gate for real-money actions: pointer down for `holdMs`
 * fills the ring and fires onConfirm exactly once; releasing (or leaving) early
 * cancels. Deliberately NO keyboard activation — Enter/Space are swallowed so a
 * stray keypress can never send an order.
 */
export function HoldToConfirmButton({ onConfirm, disabled, holdMs = 800, tone = 'cyan', className, children }: Props) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fired = useRef(false);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    setProgress(0);
  }, []);

  useEffect(() => cancel, [cancel]); // clear the interval on unmount

  // If the gate closes mid-hold (e.g. a background re-preview flips `disabled`
  // true during the 800ms hold), abort the in-progress hold IMMEDIATELY so the
  // timer can never still fire onConfirm — the real-money gate must hold.
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  const start = () => {
    if (disabled || timer.current !== null) return;
    fired.current = false;
    const startedAt = Date.now();
    setProgress(0.02);
    timer.current = setInterval(() => {
      const p = (Date.now() - startedAt) / holdMs;
      if (p >= 1) {
        cancel();
        if (!fired.current) {
          fired.current = true;
          confirmRef.current();
        }
      } else {
        setProgress(p);
      }
    }, 40);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={typeof children === 'string' ? children : undefined}
      title="press and hold to confirm"
      onPointerDown={(e) => {
        // Only the primary button holds; jsdom events omit `button`, so treat
        // a missing value as primary.
        if (typeof e.button === 'number' && e.button !== 0) return;
        start();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        // No keyboard equivalent — hold-to-confirm is pointer-only by design.
        if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
      }}
      onClick={(e) => e.preventDefault()}
      className={`inline-flex select-none items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${className ?? ''}`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-ml-1 shrink-0">
        <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={(1 - progress) * CIRC}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {children}
    </button>
  );
}
