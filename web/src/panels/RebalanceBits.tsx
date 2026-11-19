import { Check, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RouteName } from '../api/types';
import { Spinner } from '../components/Spinner';
import { microLabelClass } from '../components/Th';
import { num, parseSymbol } from '../lib/fmt';

/** Severity of a rebalance verdict — see `VerdictTone` in RebalanceHovers. */
const VERDICT_STYLE = {
  info: { box: 'alert-blue', text: 'text-pastel-blue', icon: <Info size={14} aria-hidden className="block" />, sr: null },
  // The glyph is decorative (aria-hidden), so the level reaches a screen
  // reader as a word instead. `info` needs none: a neutral note reads fine
  // without a prefix, and "Note:" on every quiet line is just noise.
  warn: { box: 'alert-amber', text: 'text-gold', icon: <TriangleAlert size={14} aria-hidden className="block" />, sr: 'Warning:' },
  good: { box: 'flex rounded border border-grass/45 bg-grass/10 px-3 py-2.5', text: 'text-grass', icon: <Check size={14} aria-hidden className="block" />, sr: null },
  act: { box: 'alert-red', text: 'text-guava', icon: <TriangleAlert size={14} aria-hidden className="block" />, sr: 'Action needed:' },
} as const;

/**
 * The verdict, boxed. One component for BOTH the Balances card and the modal,
 * so the sentence a trader reads before opening the dialog is the same one
 * they read inside it — they used to be able to disagree.
 *
 * Colour never carries the level alone: each tone brings its own glyph.
 */
export function VerdictAlert({
  tone,
  text,
  sub,
}: {
  tone: 'info' | 'warn' | 'act' | 'good';
  text: ReactNode;
  sub?: string | null;
}) {
  const style = VERDICT_STYLE[tone];
  return (
    // No `role="alert"`, at any tone. This is AMBIENT STATUS — it is on screen
    // from first paint and re-renders on every poll — not an interruption, and
    // an assertive live region would announce a standing fact each time the
    // card refreshed. The level rides on the icon and the text, which a screen
    // reader gets from the normal reading order. (A verdict that appeared in
    // RESPONSE to an action would earn an alert; this one does not.)
    <div className={`${style.box} !flex-row items-start gap-2.5`}>
      {/* One text line tall, the glyph centred in it: an inline svg sat on the
          baseline and read off-centre beside the 12px text. Top-aligned with
          the first line, so a wrapped verdict keeps its icon at the top. */}
      <span aria-hidden className={`flex h-5 shrink-0 items-center ${style.text}`}>
        {style.icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`text-xs leading-5 ${style.text}`}>
          {style.sr && <span className="sr-only">{style.sr} </span>}
          {text}
        </span>
        {sub && <span className="num text-[11px] leading-4 text-ink-400">{sub}</span>}
      </span>
    </div>
  );
}

export const ROUTE_ORDER: RouteName[] = ['mix', 'loop', 'convert'];

/** A route's fee with its time priced in, $1 × (e^(hours) − 1): what the
 * server's recommendation ranks by. FAITHFUL PORT of routeScore in
 * src/core/rebalance/plan.ts, so the rows below Recommended rank the same way. */
export const routeScore = (route: { costUsd: number; seconds: number }): number =>
  route.costUsd + Math.expm1(Math.max(0, route.seconds) / 3600);

type ProgressTone = 'running' | 'done' | 'stopped';

const PROGRESS_FILL: Record<ProgressTone, string> = {
  running: 'bg-info',
  done: 'bg-grass',
  stopped: 'bg-guava',
};

export function ProgressBar({ ratio, tone }: { ratio: number; tone: ProgressTone }) {
  const pct = Number.isFinite(ratio) ? Math.min(100, Math.max(0, ratio * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-1.5 overflow-hidden rounded-full bg-ink-800"
    >
      <div className={`h-full ${PROGRESS_FILL[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export type StepState = 'pending' | 'running' | 'done' | 'stopped';

export interface StepRow {
  key: string;
  label: string;
  text: ReactNode;
  sub: ReactNode;
  right: string;
  state: StepState;
  progress: number | null;
  body?: ReactNode;
}

const STEP_DOT: Record<StepState, string> = {
  pending: 'border-ink-600 text-ink-300',
  running: 'border-info text-info',
  done: 'border-grass text-grass',
  stopped: 'border-guava text-guava',
};

export function StepDot({ n, state }: { n: number; state: StepState }) {
  return (
    <div
      aria-hidden
      data-step-dot={state}
      className={`num flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${STEP_DOT[state]}`}
    >
      {state === 'running' ? <Spinner className="h-2.5 w-2.5" /> : state === 'done' ? <Check size={12} strokeWidth={2.5} /> : num(n, 0)}
    </div>
  );
}

const STEP_TEXT: Record<StepRow['state'], string> = {
  pending: 'text-ink-200',
  running: 'text-ink-100',
  done: 'text-ink-100',
  stopped: 'text-ink-100',
};

const STEP_RIGHT: Record<StepRow['state'], string> = {
  pending: 'text-ink-400',
  running: 'text-pastel-blue',
  done: 'text-grass',
  stopped: 'text-guava',
};

const STEP_BAR: Record<StepRow['state'], ProgressTone> = {
  pending: 'running',
  running: 'running',
  done: 'done',
  stopped: 'stopped',
};

export function StepList({ rows }: { rows: StepRow[] }) {
  return (
    <ol className="flex flex-col gap-5">
      {rows.map((row, index) => (
        <li key={row.key} aria-current={row.state === 'running' ? 'step' : undefined} className="relative flex gap-3">
          {index < rows.length - 1 && <span aria-hidden data-step-line="" className="absolute -bottom-5 left-2.5 top-6 w-px bg-ink-700" />}
          <StepDot n={index + 1} state={row.state} />
          {row.label && <span className={`w-20 shrink-0 pt-0.5 ${microLabelClass}`}>{row.label}</span>}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-end justify-between gap-4 text-xs">
              <div className={row.label ? 'flex min-w-0 flex-col' : 'flex min-w-0 flex-wrap items-baseline gap-x-2'}>
                <span className={`num ${row.label ? '' : 'font-semibold'} ${STEP_TEXT[row.state]}`}>{row.text}</span>
                <span className="text-ink-400">{row.sub}</span>
              </div>
              <span className={`num shrink-0 ${STEP_RIGHT[row.state]}`}>{row.right}</span>
            </div>
            {row.progress !== null && <ProgressBar ratio={row.progress} tone={STEP_BAR[row.state]} />}
            {row.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function markPriceOf(positions: readonly { symbol: string; markPrice?: string }[], symbol: string): number | null {
  const base = parseSymbol(symbol).base;
  const own = positions.find((p) => p.symbol === symbol) ?? positions.find((p) => parseSymbol(p.symbol).base === base);
  const mark = Number(own?.markPrice);
  return Number.isFinite(mark) && mark > 0 ? mark : null;
}
