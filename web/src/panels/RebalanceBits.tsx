import { useId, type ReactNode } from 'react';
import type { PlannedStep, RebalanceDirection, RebalanceJob, RebalanceStep, RoutePlan } from '../api/types';
import { microLabelClass } from '../components/Th';
import { fmtAbout, fmtAge, num } from '../lib/fmt';
import { LEG_TEXT } from './rebalanceCopy';

type BarTone = 'usdt' | 'usdc' | 'gate' | 'spot';

export interface BarRow {
  key: string;
  label: ReactNode;
  cash: number;
  gain: number;
  tone: BarTone;
}

const BAR_FILL: Record<BarTone, string> = {
  usdt: 'bg-info',
  usdc: 'bg-crossex',
  gate: 'bg-ink-600',
  spot: 'bg-gold',
};

const GAIN_FILL: Record<BarTone, string> = {
  usdt: 'bg-info/20 bg-[repeating-linear-gradient(135deg,theme(colors.info.DEFAULT)_0_2px,transparent_2px_6px)]',
  usdc: 'bg-crossex/20 bg-[repeating-linear-gradient(135deg,theme(colors.crossex)_0_2px,transparent_2px_6px)]',
  gate: 'bg-ink-600/20 bg-[repeating-linear-gradient(135deg,theme(colors.ink.600)_0_2px,transparent_2px_6px)]',
  spot: 'bg-gold/20 bg-[repeating-linear-gradient(135deg,theme(colors.gold)_0_2px,transparent_2px_6px)]',
};

function barParts(row: BarRow): { value: number; solid: number; gain: number } {
  const value = row.cash + row.gain;
  if (value <= 0) return { value, solid: 0, gain: 0 };
  const solid = Math.min(value, Math.max(0, row.cash));
  return { value, solid, gain: value - solid };
}

function widthOf(part: number, scale: number): string {
  const pct = scale > 0 ? Math.min(100, (Math.abs(part) / scale) * 100) : 0;
  return `${pct}%`;
}

export function BalanceBars({ caption, rows, scale }: { caption: ReactNode; rows: BarRow[]; scale: number }) {
  const captionId = useId();
  const bars = rows.map((row) => ({ row, ...barParts(row) }));
  return (
    <div role="group" aria-labelledby={captionId} className="flex flex-col gap-2">
      <div id={captionId} className={microLabelClass}>
        {caption}
      </div>
      <div className="flex flex-col gap-1.5">
        {bars.map(({ row, value, solid, gain }) => (
          <div key={row.key} className="flex items-center gap-3 text-xs">
            <div className="w-40 shrink-0 whitespace-nowrap text-ink-100">{row.label}</div>
            <div className="relative h-3 min-w-0 flex-1">
              <div aria-hidden className="flex h-3 w-full overflow-hidden rounded-sm bg-ink-950">
                <div className="flex flex-1 justify-end">
                  {value < 0 && <div className="h-full bg-guava" style={{ width: widthOf(value, scale) }} />}
                </div>
                <div className="flex flex-1">
                  {solid > 0 && <div className={`h-full ${BAR_FILL[row.tone]}`} style={{ width: widthOf(solid, scale) }} />}
                  {gain > 0 && <div className={`h-full ${GAIN_FILL[row.tone]}`} style={{ width: widthOf(gain, scale) }} />}
                </div>
              </div>
              <div aria-hidden data-zero-line="" className="absolute left-1/2 -top-0.5 -bottom-0.5 w-px bg-ink-100" />
            </div>
            <span className="num w-20 shrink-0 text-right text-ink-100">{num(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BarLegend({ rows }: { rows: BarRow[] }) {
  const tone = rows.find((row) => barParts(row).gain > 0)?.tone;
  if (!tone) return null;
  return (
    <div className="flex items-center gap-4 text-xs text-ink-400">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`h-2 w-3 rounded-sm ${BAR_FILL[tone]}`} />
        cash
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`h-2 w-3 rounded-sm ${GAIN_FILL[tone]}`} />
        unrealized gain
      </span>
    </div>
  );
}

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

export interface StepRow {
  key: string;
  label: string;
  text: string;
  sub: string;
  right: string;
  state: 'pending' | 'running' | 'done' | 'stopped';
  progress: number;
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
    <ol className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.key} aria-current={row.state === 'running' ? 'step' : undefined} className="flex gap-3">
          <span className={`w-20 shrink-0 pt-0.5 ${microLabelClass}`}>{row.label}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-start justify-between gap-4 text-xs">
              <div className="flex min-w-0 flex-col">
                <span className={STEP_TEXT[row.state]}>{row.text}</span>
                <span className="text-ink-400">{row.sub}</span>
              </div>
              <span className={`num shrink-0 ${STEP_RIGHT[row.state]}`}>{row.right}</span>
            </div>
            <ProgressBar ratio={row.progress} tone={STEP_BAR[row.state]} />
          </div>
        </li>
      ))}
    </ol>
  );
}

const HYPERLIQUID_WALLET = 'the CrossEx Hyperliquid wallet';

type StepTextInput = Pick<PlannedStep, 'kind' | 'buy' | 'move' | 'arrives'> & { borrowLeft: number | null };

export function stepText(step: StepTextInput, direction: RebalanceDirection): { text: string; sub: string } {
  const move = num(step.move);
  const arrives = num(step.arrives);
  const borrowLeft = step.borrowLeft === null ? null : num(step.borrowLeft);
  const sub =
    borrowLeft === null
      ? `${arrives} arrives`
      : `${arrives} arrives · ${borrowLeft === num(0) ? 'borrow paid' : `borrow left ${borrowLeft}`}`;
  if (step.kind === 'convert') {
    const pair = direction === 'toUsdc' ? 'USDT to USDC' : 'USDC to USDT';
    return { text: `Convert ${move} ${pair}`, sub };
  }
  if (direction === 'toUsdt') {
    return { text: `Move ${move} USDC out of ${HYPERLIQUID_WALLET}, sell ${arrives} for USDT`, sub };
  }
  const buy = num(step.buy);
  if (buy === num(0)) return { text: `Move ${move} USDC to ${HYPERLIQUID_WALLET}`, sub };
  if (buy === move) return { text: `Buy ${buy} USDC, move it to ${HYPERLIQUID_WALLET}`, sub };
  return { text: `Buy ${buy} USDC, move ${move} USDC to ${HYPERLIQUID_WALLET}`, sub };
}

export const ROUND_SECONDS: Record<RebalanceDirection, number> = { toUsdc: 130, toUsdt: 400 };

function jobStepText(steps: RebalanceStep[], round: number | null, direction: RebalanceDirection) {
  const named = (name: string) => steps.find((step) => step.name === name);
  const toUsdc = direction === 'toUsdc';
  const last = toUsdc ? named('To Hyperliquid') : named('Sell USDC');
  const input =
    round === null
      ? { kind: 'convert' as const, buy: 0, move: named('Convert')?.planned ?? 0, arrives: named('Convert')?.qty ?? null }
      : {
          kind: 'round' as const,
          buy: toUsdc ? (named('Buy USDC')?.qty ?? named('Buy USDC')?.planned ?? 0) : 0,
          move: (toUsdc ? named('To spot') : named('From Hyperliquid'))?.planned ?? 0,
          arrives: (toUsdc ? last?.arrives : last?.planned) ?? null,
        };
  const borrowLeft = round === null ? null : (last?.borrowLeft ?? null);
  const { text, sub } = stepText({ ...input, arrives: input.arrives ?? 0, borrowLeft }, direction);
  return { text, sub: input.arrives === null ? '' : sub };
}

export function jobRows(job: RebalanceJob, now: number, borrow: number | null): StepRow[] {
  const hasBorrow = borrow !== null || job.steps.some((step) => (step.borrowLeft ?? 0) > 0);
  const jobSteps = hasBorrow ? job.steps : job.steps.map((step) => ({ ...step, borrowLeft: null }));
  const groups: { round: number | null; steps: RebalanceStep[] }[] = [];
  for (const step of jobSteps) {
    const last = groups.at(-1);
    if (last && last.round === step.round) last.steps.push(step);
    else groups.push({ round: step.round, steps: [step] });
  }
  const current = jobSteps[job.stepIndex];
  return groups.map(({ round, steps }): StepRow => {
    const expected = round === null ? 0 : ROUND_SECONDS[job.direction];
    const started = steps.find((step) => step.startedAt !== null)?.startedAt ?? null;
    const label = round === null ? 'Convert' : `Round ${num(round, 0)}`;
    const base = { key: label, label, ...jobStepText(steps, round, job.direction) };
    const doneAt = steps.at(-1)?.doneAt ?? null;
    if (steps.every((step) => step.status === 'done')) {
      const took = started === null || doneAt === null ? '' : fmtAge(doneAt - started);
      return { ...base, state: 'done', progress: 1, right: took };
    }
    if (!current || !steps.includes(current)) {
      return { ...base, state: 'pending', progress: 0, right: expected > 0 ? fmtAbout(expected) : 'instant' };
    }
    const elapsed = started === null ? 0 : Math.max(0, (job.status === 'running' ? now : job.updatedAt) - started);
    const progress = expected > 0 ? elapsed / 1000 / expected : 0;
    if (job.status !== 'running') return { ...base, state: 'stopped', progress, right: 'stopped' };
    const right = expected > 0 ? `${fmtAge(elapsed)} of ${fmtAbout(expected)}` : fmtAge(elapsed);
    return { ...base, sub: LEG_TEXT[current.name] ?? base.sub, state: 'running', progress, right };
  });
}

export function planRows(route: RoutePlan, direction: RebalanceDirection, borrow: number | null): StepRow[] {
  return route.steps.map((step, index): StepRow => {
    const label = step.kind === 'convert' ? 'Convert' : `Round ${num(step.round ?? index + 1, 0)}`;
    const right = step.kind === 'convert' ? 'instant' : fmtAbout(step.seconds);
    const text = stepText({ ...step, borrowLeft: borrow === null ? null : step.borrowLeft }, direction);
    return { key: String(index), label, ...text, right, state: 'pending', progress: 0 };
  });
}
