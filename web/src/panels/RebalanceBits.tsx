import { ArrowRight, Check, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RouteName } from '../api/types';
import { TokenIcon } from '../components/AssetIcon';
import { Spinner } from '../components/Spinner';
import { num, parseSymbol } from '../lib/fmt';

/** Severity of a rebalance verdict — see `VerdictTone` in RebalanceHovers. */
const VERDICT_STYLE = {
  info: { box: 'alert-blue', text: 'text-pastel-blue', icon: <Info size={14} aria-hidden className="block" />, sr: null },
  recommend: { box: 'alert-blue', text: 'text-pastel-blue', icon: <Check size={14} aria-hidden className="block" />, sr: null },
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
  action,
}: {
  tone: 'info' | 'warn' | 'act' | 'good' | 'recommend';
  text: ReactNode;
  sub?: string | null;
  action?: { label: string; onClick: () => void };
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
      {action && (
        <button type="button" className="btn-link ml-auto inline-flex shrink-0 items-center gap-1 text-xs leading-5" onClick={action.onClick}>
          {action.label}
          <ArrowRight size={12} aria-hidden />
        </button>
      )}
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
  coin: string;
  text: ReactNode;
  sub: ReactNode;
  right: string;
  state: StepState;
  progress: number | null;
}

const STEP_MARK: Record<StepState, string> = {
  pending: 'text-ink-400',
  running: 'text-info',
  done: 'text-grass',
  stopped: 'text-guava',
};

export function StepDot({ n, state }: { n: number; state: StepState }) {
  return (
    <span aria-hidden data-step-dot={state} className={`num flex shrink-0 items-center ${STEP_MARK[state]}`}>
      {state === 'running' ? <Spinner className="h-3 w-3" /> : state === 'done' ? <Check size={12} strokeWidth={2.5} /> : num(n, 0)}
    </span>
  );
}

const STEP_EDGE: Record<StepState, string> = {
  pending: 'border-ink-800',
  running: 'border-info/45',
  done: 'border-ink-800',
  stopped: 'border-guava/45',
};

const STEP_RIGHT: Record<StepState, string> = {
  pending: 'text-ink-400',
  running: 'text-pastel-blue',
  done: 'text-grass',
  stopped: 'text-guava',
};

const STEP_BAR: Record<StepState, string> = {
  pending: PROGRESS_FILL.running,
  running: PROGRESS_FILL.running,
  done: PROGRESS_FILL.done,
  stopped: PROGRESS_FILL.stopped,
};

const live = (row: StepRow): boolean => row.state === 'running' || row.state === 'stopped';

export function shownSteps(rows: StepRow[], limit: number | null): { row: StepRow; n: number }[] {
  return rows.map((row, index) => ({ row, n: index + 1 })).filter(({ row, n }) => limit === null || n <= limit || live(row));
}

export function StepList({ rows, limit = null }: { rows: StepRow[]; limit?: number | null }) {
  return (
    <ol className="flex flex-col gap-1">
      {shownSteps(rows, limit).map(({ row, n }) => (
        <li
          key={row.key}
          aria-current={row.state === 'running' ? 'step' : undefined}
          className={`relative flex items-center gap-3 overflow-hidden rounded border px-3 py-1.5 text-xs text-ink-100 ${STEP_EDGE[row.state]}`}
        >
          <StepDot n={n} state={row.state} />
          <TokenIcon symbol={row.coin} size={16} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="num">{row.text}</span>
            {row.state === 'running' && row.sub && <span className="text-ink-400">{row.sub}</span>}
          </span>
          <span className={`num shrink-0 ${STEP_RIGHT[row.state]}`}>{row.right}</span>
          {row.progress !== null && live(row) && (
            <span
              aria-hidden
              data-step-bar=""
              className={`absolute bottom-0 left-0 h-0.5 ${STEP_BAR[row.state]}`}
              style={{ width: `${Number.isFinite(row.progress) ? Math.min(100, Math.max(0, row.progress * 100)) : 0}%` }}
            />
          )}
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
