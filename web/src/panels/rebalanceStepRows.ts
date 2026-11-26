import type { PlannedStep, Pool, RebalanceJob, RebalanceStep, RoutePlan } from '../api/types';
import { t } from '../i18n';
import { fmtAbout, fmtAge, num } from '../lib/fmt';
import type { StepRow } from './RebalanceBits';
import { LEG_TEXT, MOVE_TEXT } from './rebalanceCopy';

type StepTextInput = Pick<PlannedStep, 'kind' | 'buy' | 'move' | 'arrives' | 'from' | 'to'>;

function stepText(step: StepTextInput): string {
  const move = num(step.move);
  if (step.kind === 'convert') return MOVE_TEXT.convert(step.from, step.to, move);
  if (step.from !== 'CROSSEX') return MOVE_TEXT.step(step.from, step.to, move, num(step.arrives));
  const wallet = MOVE_TEXT.into(step.to);
  const buy = num(step.buy);
  if (buy === num(0)) return t('accounts.rebalanceBits.moveTo', { move, wallet });
  if (buy === move) return t('accounts.rebalanceBits.buyMoveIt', { buy, wallet });
  return t('accounts.rebalanceBits.buyMove', { buy, move, wallet });
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

function jobStepText(steps: RebalanceStep[], round: number | null): string {
  const named = (...names: string[]) => steps.find((step) => names.includes(step.name));
  const { from, to } = steps[0];
  const into = from === 'CROSSEX';
  const out = to === 'CROSSEX';
  const last = out ? named('Sell USDC') : named('To Hyperliquid', 'To Lighter');
  const gives = steps.filter((step) => step.name === 'Convert' || step.name === 'Convert to USDT');
  const input =
    round === null
      ? { kind: 'convert' as const, buy: 0, move: gives.reduce((total, step) => total + (step.planned ?? 0), 0), arrives: 0 }
      : {
          kind: 'round' as const,
          buy: into ? (named('Buy USDC')?.qty ?? named('Buy USDC')?.planned ?? 0) : 0,
          move: (into ? named('To spot') : named('From Hyperliquid', 'From Lighter'))?.planned ?? 0,
          arrives: (out ? last?.planned : last?.arrives) ?? 0,
        };
  return stepText({ ...input, from, to });
}

interface StepGroup {
  round: number | null;
  steps: RebalanceStep[];
}

function groupSteps(steps: RebalanceStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    const head = last?.steps[0];
    if (last && head && last.round === step.round && head.from === step.from && head.to === step.to) last.steps.push(step);
    else groups.push({ round: step.round, steps: [step] });
  }
  return groups;
}

const stepCoin = (convert: boolean, from: Pool): string => (convert && from === 'CROSSEX' ? 'USDT' : 'USDC');

function groupBase({ round, steps }: StepGroup, index: number) {
  return { key: `${round ?? 'convert'}:${index}`, coin: stepCoin(round === null, steps[0].from), text: jobStepText(steps, round), sub: '' };
}

export function jobRows(job: RebalanceJob, now: number): StepRow[] {
  const current = job.steps[job.stepIndex];
  return groupSteps(job.steps).map((group, index): StepRow => {
    const { round, steps } = group;
    const { from, to } = steps[0];
    const expected = round === null ? 0 : roundSeconds(from, to);
    const started = steps.find((step) => step.startedAt !== null)?.startedAt ?? null;
    const base = groupBase(group, index);
    const doneAt = steps.at(-1)?.doneAt ?? null;
    if (steps.every((step) => step.status === 'done')) {
      const took = started === null || doneAt === null ? '' : fmtAge(doneAt - started);
      return { ...base, state: 'done', progress: 1, right: took };
    }
    if (!current || !steps.includes(current)) {
      return { ...base, state: 'pending', progress: 0, right: expected > 0 ? fmtAbout(expected) : t('accounts.rebalance.hover.title.time.instant') };
    }
    const elapsed = started === null ? 0 : Math.max(0, (job.status === 'running' ? now : job.updatedAt) - started);
    const progress = expected > 0 ? elapsed / 1000 / expected : 0;
    if (job.status !== 'running') return { ...base, state: 'stopped', progress, right: t('accounts.rebalanceBits.stopped') };
    const right =
      expected > 0 ? t('accounts.rebalanceBits.elapsedOf', { elapsed: fmtAge(elapsed), expected: fmtAbout(expected) }) : fmtAge(elapsed);
    return { ...base, sub: LEG_TEXT[current.name] ?? '', state: 'running', progress, right };
  });
}

export function planRows(route: RoutePlan): StepRow[] {
  return route.steps.map((step, index): StepRow => {
    const right = step.kind === 'convert' ? t('accounts.rebalance.hover.title.time.instant') : fmtAbout(step.seconds);
    return { key: String(index), coin: stepCoin(step.kind === 'convert', step.from), text: stepText(step), sub: '', right, state: 'pending', progress: 0 };
  });
}
