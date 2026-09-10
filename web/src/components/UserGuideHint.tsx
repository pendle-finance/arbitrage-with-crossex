/**
 * A one-off nudge toward the user guide, for the first couple of days.
 *
 * The guide is the difference between reading the Opportunities scan properly
 * and placing real orders on assumptions you never chose — but a header button
 * is easy to miss. This points at it for a short window after first use, and
 * then stops: it disappears for good once the guide is opened or the hint is
 * dismissed, and never appears at all for someone who has been using the
 * terminal for longer than the window.
 */
import { useEffect, useState } from 'react';
import { readJson, writeJson } from '../lib/storage';

const FIRST_SEEN_KEY = 'crossex.firstSeenAt';
const DISMISSED_KEY = 'crossex.guideHintDone';
/** How long after first use the hint keeps offering itself. */
export const HINT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** Let the terminal paint (and any first-run modal settle) before nudging. */
const APPEAR_DELAY_MS = 1_200;

/** First-use timestamp, recorded the first time this runs. An existing user
 * with no stamp is treated as new — they have not seen the guide either. */
function firstSeenAt(): number {
  const stored = readJson<number | null>(FIRST_SEEN_KEY, null, (v) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null,
  );
  if (stored !== null) return stored;
  const now = Date.now();
  writeJson(FIRST_SEEN_KEY, now);
  return now;
}

const isDone = (): boolean => readJson<boolean>(DISMISSED_KEY, false, (v) => v === true);

/** Stop offering the hint — for good. Exported so opening the guide by any
 * route (header button included) counts as "message received". */
export function markGuideHintDone(): void {
  writeJson(DISMISSED_KEY, true);
}

export function UserGuideHint({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (isDone() || Date.now() - firstSeenAt() > HINT_WINDOW_MS) return;
    const t = setTimeout(() => setShow(true), APPEAR_DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled]);

  if (!show) return null;

  const close = () => {
    markGuideHintDone();
    setShow(false);
  };

  return (
    <div
      role="dialog"
      aria-label="New here?"
      className="fixed right-5 top-24 z-50 w-[300px] rounded border border-info/60 bg-ink-900 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-cyan-300">New here?</h2>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={close}
          className="-mt-1 px-1 text-lg leading-none text-ink-500 transition-colors hover:text-ink-200"
        >
          ×
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-300">
        The <span className="font-medium text-ink-100">📖 User guide</span> up there explains what
        the Opportunities assumptions mean and how to open a pair well. Worth five minutes before
        your first real order.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            markGuideHintDone();
            setShow(false);
            onOpen();
          }}
          className="rounded-md border border-cyan-400/70 bg-cyan-500/10 px-2.5 py-1 text-xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-500/20"
        >
          Open the guide
        </button>
        <button
          type="button"
          onClick={close}
          className="px-1 text-xs text-ink-400 transition-colors hover:text-ink-200"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
