import { ArrowRight, Check, ChevronDown, ChevronRight, Info, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type {
  PlannedStep,
  Pool,
  RealizeJobLeg,
  RealizeLeg,
  RealizePlan,
  RebalanceJob,
  RebalanceStep,
  RouteName,
  RoutePlan,
} from '../api/types';
import { ChartTooltip } from '../components/ChartTooltip';
import { SignedNumber } from '../components/SignedNumber';
import { Spinner } from '../components/Spinner';
import { microLabelClass } from '../components/Th';
import { fmtAbout, fmtAge, fmtUsd, num, parseSymbol } from '../lib/fmt';
import { t } from '../i18n';
import {
  CONVERT_MAX,
  CONVERT_TO,
  hoverCash,
  hoverTarget,
  hoverUpnl,
  LEG_TEXT,
  legFeeUsd,
  legImpactUsd,
  MODAL_FEE,
  MODAL_IMPACT,
  MOVE_TEXT,
  PLATFORM,
  poolCoin,
  poolKey,
  sideText,
  sizeText,
  WALLET_LABEL,
} from './rebalanceCopy';

const HOVER_WIDTH_PX = 268;

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

/** A route's fee with its time priced in, $1 × (e^(hours) − 1): what the
 * server's recommendation ranks by. FAITHFUL PORT of routeScore in
 * src/core/rebalance/plan.ts, so the rows below Recommended rank the same way. */
export const routeScore = (route: { costUsd: number; seconds: number }): number =>
  route.costUsd + Math.expm1(Math.max(0, route.seconds) / 3600);

const barEnds = (row: BarRow): number[] => [row.cash, row.cash + row.upnl, row.target ?? 0];

const widestEnd = (rows: BarRow[]): number => Math.max(0, ...rows.flatMap(barEnds).map((end) => Math.abs(end)));

export const scaleOf = (...sets: BarRow[][]) => widestEnd(sets.flat());

const cashFill = (row: BarRow): string => {
  if (row.tone === 'spot') return 'bg-gold';
  return row.cash >= 0 ? 'bg-grass' : 'bg-guava';
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
        <span aria-hidden data-swatch="cash" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${cashFill(row)}`} />
        <span className="text-ink-400">{hoverCash()}</span>
        <span className={`num ml-auto ${row.cash < 0 ? 'text-guava' : 'text-ink-100'}`}>{num(row.cash)}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span aria-hidden data-swatch="pnl" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${pnlFill(row.upnl)}`} />
        <span className="text-ink-400">{hoverUpnl()}</span>
        <SignedNumber value={row.upnl} className="ml-auto" />
      </div>
      {row.target !== null && (
        <div className="flex items-center gap-2.5">
          <span aria-hidden data-swatch="target" className="mx-1 h-2.5 w-0.5 shrink-0 bg-gold" />
          <span className="text-ink-400">{hoverTarget()}</span>
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
        <div className="relative h-3 w-full">
          <div className="absolute inset-0 overflow-hidden rounded-sm bg-ink-950">
            <div
              aria-hidden
              data-bar-cash=""
              className={`absolute inset-y-0 ${cashFill(row)}`}
              style={{ left: cssPct(parts.cashLeft), width: cssPct(parts.cashWidth) }}
            />
            <div
              aria-hidden
              data-bar-pnl=""
              className={`absolute inset-y-0 z-0 ${pnlFill(row.upnl)}`}
              style={{ left: cssPct(parts.pnlLeft), width: cssPct(parts.pnlWidth) }}
            />
          </div>
          <div
            aria-hidden
            data-zero-line=""
            className="pointer-events-none absolute -inset-y-[5px] z-10 w-px -translate-x-1/2 bg-ink-200"
            style={{ left: cssPct(parts.zero) }}
          />
          {parts.target !== null && (
            <div
              aria-hidden
              data-bar-target=""
              className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-px bg-gold"
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
        <li key={row.key} aria-current={row.state === 'running' ? 'step' : undefined} className="flex gap-3">
          <StepDot n={index + 1} state={row.state} />
          {row.label && <span className={`w-20 shrink-0 pt-0.5 ${microLabelClass}`}>{row.label}</span>}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-end justify-between gap-4 text-xs">
              <div className="flex min-w-0 flex-col">
                <span className={STEP_TEXT[row.state]}>{row.text}</span>
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

const closeRowText = (leg: Pick<RealizeLeg, 'positionQty' | 'base' | 'side'>, part: number): string =>
  t('accounts.rebalanceRealize.closeRow', { part: sizeText(part), total: sizeText(leg.positionQty), base: leg.base, side: sideText(leg.side) });

export function FeeCell({ feeUsd, impactUsd }: { feeUsd: number; impactUsd: number }) {
  return (
    <span className="num text-right text-ink-100">
      {MODAL_FEE(fmtUsd(feeUsd))}
      {impactUsd > 0 && <span className="block text-[11px] text-ink-400">{MODAL_IMPACT(fmtUsd(impactUsd))}</span>}
    </span>
  );
}

export function RealizeRow({ realize }: { realize: RealizePlan }) {
  return (
    <div className="flex flex-col gap-1.5">
      {realize.legs.map((leg) => (
        <div key={leg.symbol} data-realize-row={leg.symbol} className="flex items-start justify-between gap-4 pr-3 text-xs">
          <span className="num min-w-0 text-ink-100">{closeRowText(leg, leg.qty)}</span>
          <FeeCell feeUsd={legFeeUsd(leg)} impactUsd={legImpactUsd(leg)} />
        </div>
      ))}
    </div>
  );
}

type Tense = 'plan' | 'past';

interface ActionLine {
  key: string;
  text: ReactNode;
  note: string | null;
  cost: string;
}

const costText = (feeUsd: number, impactUsd: number): string =>
  impactUsd > 0 ? `${fmtUsd(feeUsd)} + ${fmtUsd(impactUsd)}` : fmtUsd(feeUsd);

const PERP_ACTION = {
  close: { plan: 'accounts.rebalanceRealize.closeAction', past: 'accounts.rebalanceRealize.closedDone' },
  reopen: { plan: 'accounts.rebalanceRealize.reopenAction', past: 'accounts.rebalanceRealize.reopenedDone' },
} as const;

function perpAction(leg: RealizeLeg, verb: keyof typeof PERP_ACTION, tense: Tense): string {
  const words = { size: sizeText(leg.qty), base: leg.base, side: sideText(leg.side) };
  return t(PERP_ACTION[verb][tense], words);
}

function convertNote(convert: NonNullable<RealizeLeg['convert']>): string {
  const note = t('accounts.rebalanceRealize.convertNote', { platform: PLATFORM });
  if (convert.count <= 1) return note;
  const split = t('accounts.rebalanceRealize.convertSplit', {
    count: convert.count,
    amount: num(convert.amount / convert.count, 0),
    max: num(CONVERT_MAX, 0),
  });
  return `${note} ${split}`;
}

function convertAction(leg: RealizeLeg, convert: NonNullable<RealizeLeg['convert']>, tense: Tense): ActionLine {
  const words = { amount: num(convert.amount, 0), coin: poolCoin(leg.pool) };
  const lead = t(tense === 'plan' ? 'accounts.rebalanceRealize.convertAction' : 'accounts.rebalanceRealize.convertedDone', words);
  return {
    key: `${leg.symbol}:convert`,
    text: (
      <>
        {lead}
        <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-500" />
        {WALLET_LABEL[poolKey(CONVERT_TO[leg.pool])]}
      </>
    ),
    note: tense === 'plan' ? convertNote(convert) : null,
    cost: costText(convert.feeUsd, 0),
  };
}

function legActions(leg: RealizeLeg, tense: Tense): ActionLine[] {
  const close = { key: `${leg.symbol}:close`, text: perpAction(leg, 'close', tense), note: null, cost: costText(leg.closeFeeUsd, leg.closeImpactUsd) };
  const reopen = { key: `${leg.symbol}:reopen`, text: perpAction(leg, 'reopen', tense), note: null, cost: costText(leg.reopenFeeUsd, leg.reopenImpactUsd) };
  return leg.convert ? [close, convertAction(leg, leg.convert, tense), reopen] : [close, reopen];
}

export function RealizeActions({
  realize,
  open,
  onToggle,
  tense,
}: {
  realize: RealizePlan;
  open: boolean;
  onToggle: () => void;
  tense: Tense;
}) {
  const listId = useId();
  if (!realize.legs.some((leg) => leg.convert !== null)) return null;
  const actions = realize.legs.flatMap((leg) => legActions(leg, tense));
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="btn-link inline-flex items-center gap-1 self-start"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t('accounts.rebalanceRealize.actionsToggle', { count: actions.length })}
      </button>
      {open && (
        <ol id={listId} className="mt-1.5 flex flex-col gap-1 border-l border-ink-700 pl-2.5 text-[11px] leading-4 text-ink-300">
          {actions.map((action, index) => (
            <li key={action.key} data-action={action.key} className="flex gap-2.5">
              <span className="num w-2 shrink-0">{num(index + 1, 0)}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span data-action-text="" className="num inline-flex flex-wrap items-center gap-1">
                  {action.text}
                </span>
                {action.note && (
                  <span data-action-note="" className="num text-ink-400">
                    {action.note}
                  </span>
                )}
              </span>
              <span className="num shrink-0 text-right">{action.cost}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type StepTextInput = Pick<PlannedStep, 'kind' | 'buy' | 'move' | 'arrives' | 'from' | 'to'> & { borrowLeft: number | null };

function stepText(step: StepTextInput): { text: string; sub: string } {
  const move = num(step.move);
  const arrives = num(step.arrives);
  const borrowLeft = step.borrowLeft === null ? null : num(step.borrowLeft);
  const sub =
    borrowLeft === null
      ? t('accounts.rebalanceBits.arrives', { arrives })
      : borrowLeft === num(0)
        ? t('accounts.rebalanceBits.arrivesBorrowPaid', { arrives })
        : t('accounts.rebalanceBits.arrivesBorrowLeft', { arrives, left: borrowLeft });
  if (step.kind === 'convert') return { text: MOVE_TEXT.convert(step.from, step.to, move), sub };
  if (step.from !== 'CROSSEX') return { text: MOVE_TEXT.step(step.from, step.to, move, arrives), sub };
  const wallet = MOVE_TEXT.into(step.to);
  const buy = num(step.buy);
  if (buy === num(0)) return { text: t('accounts.rebalanceBits.moveTo', { move, wallet }), sub };
  if (buy === move) return { text: t('accounts.rebalanceBits.buyMoveIt', { buy, wallet }), sub };
  return { text: t('accounts.rebalanceBits.buyMove', { buy, move, wallet }), sub };
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
  const gives = steps.filter((step) => step.name === 'Convert' || step.name === 'Convert to USDT');
  const lands = steps.filter((step) => step.name === 'Convert' || step.name === 'Convert to USDC');
  const landed = lands.length > 0 && lands.every((step) => step.qty !== null);
  const input =
    round === null
      ? {
          kind: 'convert' as const,
          buy: 0,
          move: gives.reduce((total, step) => total + (step.planned ?? 0), 0),
          arrives: landed ? lands.reduce((total, step) => total + (step.qty ?? 0), 0) : null,
        }
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

interface StepGroup {
  round: number | null;
  steps: RebalanceStep[];
  realize: boolean;
}

function groupSteps(steps: RebalanceStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let open: StepGroup | null = null;
  for (const step of steps) {
    if (step.name === 'Close') {
      open = { round: null, steps: [step], realize: true };
      groups.push(open);
      continue;
    }
    if (open) {
      open.steps.push(step);
      if (step.name === 'Reopen') open = null;
      continue;
    }
    const last = groups.at(-1);
    const head = last?.steps[0];
    if (last && head && !last.realize && last.round === step.round && head.from === step.from && head.to === step.to) last.steps.push(step);
    else groups.push({ round: step.round, steps: [step], realize: false });
  }
  return groups;
}

function realizeText(job: RebalanceJob, close: RebalanceStep): string {
  const leg: RealizeJobLeg | undefined = job.realize?.legs.find((l) => l.symbol === close.perp?.symbol);
  if (!leg) return close.perp?.symbol ?? close.name;
  return closeRowText(leg, leg.filledQty > 0 ? leg.filledQty : leg.qty);
}

function groupBase(job: RebalanceJob, { round, steps, realize }: StepGroup, index: number) {
  if (realize) return { key: `realize:${index}`, label: '', text: realizeText(job, steps[0]), sub: '' };
  const label = round === null ? t('accounts.rebalance.hover.title.convert') : t('accounts.rebalanceBits.round', { n: num(round, 0) });
  return { key: `${round ?? 'convert'}:${index}`, label, ...jobStepText(steps, round) };
}

export function jobRows(job: RebalanceJob, now: number, borrow: number | null): StepRow[] {
  const hasBorrow = borrow !== null || job.steps.some((step) => (step.borrowLeft ?? 0) > 0);
  const jobSteps = hasBorrow ? job.steps : job.steps.map((step) => ({ ...step, borrowLeft: null }));
  const current = jobSteps[job.stepIndex];
  return groupSteps(jobSteps).map((group, index): StepRow => {
    const { round, steps, realize } = group;
    const { from, to } = steps[0];
    const expected = round === null ? 0 : roundSeconds(from, to);
    const started = steps.find((step) => step.startedAt !== null)?.startedAt ?? null;
    const base = groupBase(job, group, index);
    const doneAt = steps.at(-1)?.doneAt ?? null;
    if (steps.every((step) => step.status === 'done')) {
      const took = started === null || doneAt === null ? '' : fmtAge(doneAt - started);
      return { ...base, state: 'done', progress: 1, right: took };
    }
    if (!current || !steps.includes(current)) {
      return { ...base, state: 'pending', progress: 0, right: expected > 0 ? fmtAbout(expected) : t('accounts.rebalance.hover.title.time.instant') };
    }
    const elapsed = started === null ? 0 : Math.max(0, (job.status === 'running' ? now : job.updatedAt) - started);
    const doneShare = steps.filter((step) => step.status === 'done').length / steps.length;
    const progress = expected > 0 ? elapsed / 1000 / expected : realize ? doneShare : 0;
    if (job.status !== 'running') return { ...base, state: 'stopped', progress, right: t('accounts.rebalanceBits.stopped') };
    const right =
      expected > 0 ? t('accounts.rebalanceBits.elapsedOf', { elapsed: fmtAge(elapsed), expected: fmtAbout(expected) }) : fmtAge(elapsed);
    return { ...base, sub: realize ? base.sub : (LEG_TEXT[current.name] ?? base.sub), state: 'running', progress, right };
  });
}

export function planRows(route: RoutePlan, borrow: number | null): StepRow[] {
  return route.steps.map((step, index): StepRow => {
    const label = step.kind === 'convert' ? t('accounts.rebalance.hover.title.convert') : t('accounts.rebalanceBits.round', { n: num(step.round ?? index + 1, 0) });
    const right = step.kind === 'convert' ? t('accounts.rebalance.hover.title.time.instant') : fmtAbout(step.seconds);
    const text = stepText({ ...step, borrowLeft: borrow === null ? null : step.borrowLeft });
    return { key: String(index), label, ...text, right, state: 'pending', progress: 0 };
  });
}

export function markPriceOf(positions: readonly { symbol: string; markPrice?: string }[], symbol: string): number | null {
  const base = parseSymbol(symbol).base;
  const own = positions.find((p) => p.symbol === symbol) ?? positions.find((p) => parseSymbol(p.symbol).base === base);
  const mark = Number(own?.markPrice);
  return Number.isFinite(mark) && mark > 0 ? mark : null;
}
