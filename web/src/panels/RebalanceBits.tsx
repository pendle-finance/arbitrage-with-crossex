import { useId, type ReactNode } from 'react';
import type { PlannedStep, Pool, RebalanceJob, RebalanceStep, RouteName, RoutePlan } from '../api/types';
import { ChartTooltip } from '../components/ChartTooltip';
import { SignedNumber } from '../components/SignedNumber';
import { microLabelClass } from '../components/Th';
import { fmtAbout, fmtAge, num } from '../lib/fmt';
import { HOVER_CASH, HOVER_TARGET, HOVER_UPNL, LEG_TEXT, MOVE_TEXT } from './rebalanceCopy';

const HOVER_WIDTH_PX = 268;

type BarTone = 'usdt' | 'usdc' | 'lighter' | 'gate' | 'spot';

export interface BarRow {
  key: string;
  label: ReactNode;
  name?: string;
  cash: number;
  upnl: number;
  target: number | null;
  tone: BarTone;
}

export const WALLET_TONE: Record<string, BarTone> = {
  'USDT/CROSSEX': 'usdt',
  'USDC/HYPERLIQUID': 'usdc',
  'USDC/LIGHTER': 'lighter',
  'USDC/GATE': 'gate',
};

export const ALWAYS_SHOWN = ['USDT/CROSSEX', 'USDC/HYPERLIQUID'];

export const ROUTE_ORDER: RouteName[] = ['mix', 'loop', 'convert'];

const barEnds = (row: BarRow): number[] => [row.cash, row.cash + row.upnl, row.target ?? 0];

const widestEnd = (rows: BarRow[]): number => Math.max(0, ...rows.flatMap(barEnds).map((end) => Math.abs(end)));

export const scaleOf = (...sets: BarRow[][]) => widestEnd(sets.flat());

const BAR_FILL: Record<BarTone, string> = {
  usdt: 'bg-info',
  usdc: 'bg-crossex',
  lighter: 'bg-grass',
  gate: 'bg-ink-600',
  spot: 'bg-gold',
};

const pnlFill = (upnl: number): string => (upnl >= 0 ? 'bar-pnl-gain' : 'bar-pnl-loss');

interface BarParts {
  equity: number;
  zero: number;
  cashLeft: number;
  cashWidth: number;
  pnlLeft: number;
  pnlWidth: number;
  target: number | null;
}

function scalePoint(rows: BarRow[], scale: number): (value: number) => number {
  const half = Math.max(scale, widestEnd(rows));
  if (half <= 0) return () => 50;
  return (value) => Math.min(100, Math.max(0, 50 + (value * 50) / half));
}

function barParts(row: BarRow, at: (value: number) => number): BarParts {
  const equity = row.cash + row.upnl;
  const cashLeft = at(Math.min(0, row.cash));
  const pnlLeft = at(Math.min(row.cash, equity));
  return {
    equity,
    zero: at(0),
    cashLeft,
    cashWidth: at(Math.max(0, row.cash)) - cashLeft,
    pnlLeft,
    pnlWidth: at(Math.max(row.cash, equity)) - pnlLeft,
    target: row.target === null ? null : at(row.target),
  };
}

const cssPct = (value: number): string => `${value}%`;

function WalletHover({ row }: { row: BarRow }) {
  return (
    <div className="flex flex-col gap-2 text-xs" style={{ width: HOVER_WIDTH_PX }}>
      <span className="font-semibold text-ink-50">{row.name ?? row.label}</span>
      <div aria-hidden className="h-px bg-ink-700" />
      <div className="flex items-center gap-2.5">
        <span aria-hidden data-swatch="cash" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${BAR_FILL[row.tone]}`} />
        <span className="text-ink-400">{HOVER_CASH}</span>
        <span className={`num ml-auto ${row.cash < 0 ? 'text-guava' : 'text-ink-100'}`}>{num(row.cash)}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span aria-hidden data-swatch="pnl" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${pnlFill(row.upnl)}`} />
        <span className="text-ink-400">{HOVER_UPNL}</span>
        <SignedNumber value={row.upnl} className="ml-auto" />
      </div>
      {row.target !== null && (
        <div className="flex items-center gap-2.5">
          <span aria-hidden data-swatch="target" className="mx-1 h-2.5 w-0.5 shrink-0 bg-gold" />
          <span className="text-ink-400">{HOVER_TARGET}</span>
          <span className="num ml-auto text-gold">{num(row.target)}</span>
        </div>
      )}
    </div>
  );
}

function WalletBar({ row, parts }: { row: BarRow; parts: BarParts }) {
  return (
    <div className="grid min-w-0 flex-1">
      <ChartTooltip content={<WalletHover row={row} />}>
        <div className="relative h-3 w-full overflow-hidden rounded-sm bg-ink-950">
          <div aria-hidden data-zero-line="" className="absolute inset-y-0 z-10 w-px bg-ink-600" style={{ left: cssPct(parts.zero) }} />
          <div
            aria-hidden
            data-bar-cash=""
            className={`absolute inset-y-0 ${BAR_FILL[row.tone]}`}
            style={{ left: cssPct(parts.cashLeft), width: cssPct(parts.cashWidth) }}
          />
          <div
            aria-hidden
            data-bar-pnl=""
            className={`absolute inset-y-0 z-0 ${pnlFill(row.upnl)}`}
            style={{ left: cssPct(parts.pnlLeft), width: cssPct(parts.pnlWidth) }}
          />
          {parts.target !== null && (
            <div
              aria-hidden
              data-bar-target=""
              className="absolute inset-y-0 z-20 w-0.5 -translate-x-px bg-gold"
              style={{ left: cssPct(parts.target) }}
            />
          )}
        </div>
      </ChartTooltip>
    </div>
  );
}

export function BalanceBars({ caption, rows, scale }: { caption: ReactNode; rows: BarRow[]; scale: number }) {
  const captionId = useId();
  const at = scalePoint(rows, scale);
  return (
    <div role="group" aria-labelledby={captionId} className="flex flex-col gap-2">
      <div id={captionId} className={`h-4 ${microLabelClass}`}>
        {caption}
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const parts = barParts(row, at);
          return (
            <div key={row.key} data-bar-row={row.key} className="flex h-4 items-center gap-3 text-xs">
              <div className="w-40 shrink-0 whitespace-nowrap text-ink-100">{row.label}</div>
              <WalletBar row={row} parts={parts} />
              <span className={`num w-20 shrink-0 text-right ${parts.equity < 0 ? 'text-guava' : 'text-ink-100'}`}>
                {num(parts.equity)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ShareColumn({ caption, rows, shares }: { caption: ReactNode; rows: BarRow[]; shares: Map<string, string> }) {
  const captionId = useId();
  return (
    <div role="group" aria-labelledby={captionId} className="flex flex-col gap-2">
      <div id={captionId} className={`h-4 whitespace-nowrap text-right ${microLabelClass}`}>
        {caption}
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <span key={row.key} className="num h-4 whitespace-nowrap text-right text-xs leading-4 text-ink-100">
            {shares.get(row.key) ?? ''}
          </span>
        ))}
      </div>
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
    <ol className="flex flex-col gap-5">
      {rows.map((row) => (
        <li key={row.key} aria-current={row.state === 'running' ? 'step' : undefined} className="flex gap-3">
          <span className={`w-20 shrink-0 pt-0.5 ${microLabelClass}`}>{row.label}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-end justify-between gap-4 text-xs">
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

type StepTextInput = Pick<PlannedStep, 'kind' | 'buy' | 'move' | 'arrives' | 'from' | 'to'> & { borrowLeft: number | null };

function stepText(step: StepTextInput): { text: string; sub: string } {
  const move = num(step.move);
  const arrives = num(step.arrives);
  const borrowLeft = step.borrowLeft === null ? null : num(step.borrowLeft);
  const sub =
    borrowLeft === null
      ? `${arrives} arrives`
      : `${arrives} arrives · ${borrowLeft === num(0) ? 'borrow paid' : `borrow left ${borrowLeft}`}`;
  if (step.kind === 'convert') return { text: MOVE_TEXT.convert(step.from, step.to, move), sub };
  if (step.from !== 'CROSSEX') return { text: MOVE_TEXT.step(step.from, step.to, move, arrives), sub };
  const wallet = MOVE_TEXT.into(step.to);
  const buy = num(step.buy);
  if (buy === num(0)) return { text: `Move ${move} USDC to ${wallet}`, sub };
  if (buy === move) return { text: `Buy ${buy} USDC, move it to ${wallet}`, sub };
  return { text: `Buy ${buy} USDC, move ${move} USDC to ${wallet}`, sub };
}

const HOP_SECONDS: Record<Pool, { in: number; out: number }> = {
  CROSSEX: { in: 5, out: 5 },
  HYPERLIQUID: { in: 125, out: 395 },
  LIGHTER: { in: 230, out: 180 },
};

export const roundSeconds = (from: Pool, to: Pool): number => HOP_SECONDS[from].out + HOP_SECONDS[to].in;

export function jobSeconds(job: RebalanceJob): number {
  const rounds = new Map<number, number>();
  for (const step of job.steps) {
    if (step.round !== null && !rounds.has(step.round)) rounds.set(step.round, roundSeconds(step.from, step.to));
  }
  return [...rounds.values()].reduce((total, seconds) => total + seconds, 0);
}

function jobStepText(steps: RebalanceStep[], round: number | null) {
  const named = (...names: string[]) => steps.find((step) => names.includes(step.name));
  const { from, to } = steps[0];
  const into = from === 'CROSSEX';
  const out = to === 'CROSSEX';
  const last = out ? named('Sell USDC') : named('To Hyperliquid', 'To Lighter');
  const converts = steps.filter((step) => step.name.startsWith('Convert'));
  const input =
    round === null
      ? { kind: 'convert' as const, buy: 0, move: converts[0]?.planned ?? 0, arrives: converts.at(-1)?.qty ?? null }
      : {
          kind: 'round' as const,
          buy: into ? (named('Buy USDC')?.qty ?? named('Buy USDC')?.planned ?? 0) : 0,
          move: (into ? named('To spot') : named('From Hyperliquid', 'From Lighter'))?.planned ?? 0,
          arrives: (out ? last?.planned : last?.arrives) ?? null,
        };
  const borrowLeft = round === null ? null : (last?.borrowLeft ?? null);
  const { text, sub } = stepText({ ...input, from, to, arrives: input.arrives ?? 0, borrowLeft });
  return { text, sub: input.arrives === null ? '' : sub };
}

export function jobRows(job: RebalanceJob, now: number, borrow: number | null): StepRow[] {
  const hasBorrow = borrow !== null || job.steps.some((step) => (step.borrowLeft ?? 0) > 0);
  const jobSteps = hasBorrow ? job.steps : job.steps.map((step) => ({ ...step, borrowLeft: null }));
  const groups: { round: number | null; steps: RebalanceStep[] }[] = [];
  for (const step of jobSteps) {
    const last = groups.at(-1);
    const head = last?.steps[0];
    if (last && head && last.round === step.round && head.from === step.from && head.to === step.to) last.steps.push(step);
    else groups.push({ round: step.round, steps: [step] });
  }
  const current = jobSteps[job.stepIndex];
  return groups.map(({ round, steps }, index): StepRow => {
    const { from, to } = steps[0];
    const expected = round === null ? 0 : roundSeconds(from, to);
    const started = steps.find((step) => step.startedAt !== null)?.startedAt ?? null;
    const label = round === null ? 'Convert' : `Round ${num(round, 0)}`;
    const base = { key: `${label}:${index}`, label, ...jobStepText(steps, round) };
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

export function planRows(route: RoutePlan, borrow: number | null): StepRow[] {
  return route.steps.map((step, index): StepRow => {
    const label = step.kind === 'convert' ? 'Convert' : `Round ${num(step.round ?? index + 1, 0)}`;
    const right = step.kind === 'convert' ? 'instant' : fmtAbout(step.seconds);
    const text = stepText({ ...step, borrowLeft: borrow === null ? null : step.borrowLeft });
    return { key: String(index), label, ...text, right, state: 'pending', progress: 0 };
  });
}
