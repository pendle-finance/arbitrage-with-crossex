import type { PlannedStep, Pool, RebalanceJob, RebalanceStep, RoutePlan } from '../api/types';
import { t } from '../i18n';
import { fmtAbout, fmtAge, num } from '../lib/fmt';
import type { StepRow } from './RebalanceBits';
import { LEG_TEXT, MOVE_TEXT } from './rebalanceCopy';

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

function groupBase({ round, steps }: StepGroup, index: number) {
  const label = round === null ? t('accounts.rebalance.hover.title.convert') : t('accounts.rebalanceBits.round', { n: num(round, 0) });
  return { key: `${round ?? 'convert'}:${index}`, label, ...jobStepText(steps, round) };
}

export function jobRows(job: RebalanceJob, now: number, borrow: number | null): StepRow[] {
  const hasBorrow = borrow !== null || job.steps.some((step) => (step.borrowLeft ?? 0) > 0);
  const jobSteps = hasBorrow ? job.steps : job.steps.map((step) => ({ ...step, borrowLeft: null }));
  const current = jobSteps[job.stepIndex];
  return groupSteps(jobSteps).map((group, index): StepRow => {
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
    return { ...base, sub: LEG_TEXT[current.name] ?? base.sub, state: 'running', progress, right };
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
