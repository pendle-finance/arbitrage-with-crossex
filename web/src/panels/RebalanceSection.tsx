import { ApiError } from '../api/client';
import { useRebalance, useRebalanceCommand, useStartRebalance } from '../api/queries';
import type { RebalanceJob, RebalanceStep } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Stat } from '../components/Stat';
import { fmtAge, fmtUsd, num } from '../lib/fmt';
import { useNow } from '../lib/useNow';

const SHORTFALL_TEXT = {
  cash: 'unrealised profit cannot move until the position closes',
  margin: 'available margin is too low',
} as const;

const STEP_TONE: Record<RebalanceStep['status'], string> = {
  pending: 'text-ink-500',
  running: 'text-cyan-300',
  done: 'text-emerald-300',
};

function waitText(waitSeconds: number): string {
  if (waitSeconds === 0) return 'instant';
  return `about ${Math.round(waitSeconds / 6) / 10} min`;
}

function elapsedText(step: RebalanceStep, job: RebalanceJob, now: number): string {
  if (step.status === 'pending' || step.startedAt === null) return '—';
  const end =
    step.status === 'done' && step.doneAt !== null ? step.doneAt : job.status === 'halted' ? job.updatedAt : now;
  return fmtAge(end - step.startedAt);
}

function errorLine(error: Error | null) {
  if (!error) return null;
  const hint = error instanceof ApiError ? error.hint : undefined;
  return (
    <p role="alert" className="text-[12px] text-rose-300">
      {error.message}
      {hint ? <span className="text-ink-400"> {hint}</span> : null}
    </p>
  );
}

function stepRows(job: RebalanceJob, now: number) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {job.steps.map((s) => (
        <li key={s.name} className="flex items-baseline gap-3">
          <span className="text-ink-100">{s.name}</span>
          <span className={`text-[11px] uppercase tracking-wider ${STEP_TONE[s.status]}`}>{s.status}</span>
          <span className="num ml-auto text-ink-300">{elapsedText(s, job, now)}</span>
        </li>
      ))}
    </ul>
  );
}

export function RebalanceSection({ holdMs }: { holdMs?: number }) {
  const { data } = useRebalance();
  const start = useStartRebalance();
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const now = useNow(1_000);

  if (!data) return null;

  const bucket = data.buckets.find((b) => b.coin === 'USDC' && b.venue === 'HYPERLIQUID');
  const borrow = bucket?.borrow ?? 0;
  const job = data.job;
  const jobActive = job !== null && (job.status === 'running' || job.status === 'halted');
  if (borrow === 0 && !jobActive) return null;

  const plan = data.plan;

  let body;
  if (job && job.status === 'running') {
    body = stepRows(job, now);
  } else if (job && job.status === 'halted') {
    const cmdPending = resume.isPending || abandon.isPending;
    body = (
      <>
        {stepRows(job, now)}
        <p className="text-[12px] text-rose-300">{job.haltReason}</p>
        <p className="text-[12px] text-ink-300">Funds are in {job.fundsAt}</p>
        <div className="flex gap-1.5">
          <button type="button" className="btn-ghost-xs" disabled={cmdPending} onClick={() => resume.mutate(job.id)}>
            Resume
          </button>
          <button type="button" className="btn-ghost-xs" disabled={cmdPending} onClick={() => abandon.mutate(job.id)}>
            Abandon
          </button>
        </div>
        {errorLine(resume.error ?? abandon.error)}
      </>
    );
  } else if (plan.route) {
    const routeName = plan.route;
    const route = plan.routes[routeName];
    body = (
      <>
        <p className="text-[12px] text-ink-300">
          costs {fmtUsd(route.costUsd)} · saves {fmtUsd(plan.savesPerDayUsd)}/day · frees{' '}
          {fmtUsd(plan.marginFreedUsd)} margin · {waitText(route.waitSeconds)}
        </p>
        {plan.shortfall && (
          <p className="text-[12px] text-amber-300">
            Only {num(plan.amount, 2)} USDC can move. {num(plan.shortfall.remaining, 2)} USDC stays borrowed:{' '}
            {SHORTFALL_TEXT[plan.shortfall.reason]}
          </p>
        )}
        <HoldToConfirmButton
          tone="cyan"
          holdMs={holdMs}
          disabled={start.isPending}
          onConfirm={() => start.mutate({ amount: plan.amount, route: routeName })}
          className="self-start"
        >
          {`Pay down ${num(plan.amount, 2)} USDC`}
        </HoldToConfirmButton>
        {errorLine(start.error)}
      </>
    );
  } else {
    body = (
      <>
        <p className="text-[12px] text-ink-300">Loop: {plan.routes.loop.reason ?? '—'}</p>
        <p className="text-[12px] text-ink-300">Convert: {plan.routes.convert.reason ?? '—'}</p>
      </>
    );
  }

  return (
    <section aria-label="Pay down" className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Pay down</h2>
      <div className="flex flex-wrap gap-8">
        <Stat label="Borrow (USDC)">
          <span className="num">{num(borrow, 2)}</span>
        </Stat>
        <Stat label="Interest / day">
          <span className="num">{fmtUsd(bucket?.interestPerDayUsd ?? 0)}</span>
        </Stat>
        <Stat label="Interest paid · 30 d">
          <span className="num">{fmtUsd(bucket?.interestPaid30dUsd ?? 0)}</span>
        </Stat>
      </div>
      {body}
    </section>
  );
}
