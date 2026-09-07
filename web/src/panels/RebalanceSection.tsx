import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useRebalance, useRebalanceCommand, useStartRebalance } from '../api/queries';
import type { RebalanceDirection, RebalanceJob, RebalancePlan, RebalanceStep } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { HoverCard } from '../components/HoverCard';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { Stat } from '../components/Stat';
import { fmtAge, fmtUsd, num } from '../lib/fmt';
import { roundToStep } from '../lib/ticks';
import { useNow } from '../lib/useNow';

const PULL_STEP_SECONDS = 390;

const EXPECTED_SECONDS: Record<string, number> = {
  'Buy USDC': 2,
  'To spot': 5,
  'To Hyperliquid': 127,
  Convert: 2,
  'Pull from Hyperliquid': PULL_STEP_SECONDS,
  'To Gate': 6,
  'Sell USDC': 2,
};

const EXPLANATION: Record<RebalanceDirection, string> = {
  payDown:
    "Sends USDT to Hyperliquid as USDC and pays the borrow back. Each USDC paid back cuts the borrow by 1 USDC and frees 0.20 USDC of initial margin and 0.10 USDC of maintenance margin. Your account total changes only by the route's cost.",
  pull: 'Brings USDC from Hyperliquid back to USDT. You can pull at most the USDC you own there, so a pull never starts a new borrow.',
};

const ABOUT = (
  <div className="flex flex-col gap-2 text-[12px] leading-snug">
    <p>
      <span className="font-semibold text-ink-100">What this is. </span>
      Your CrossEx account holds USDT. The Hyperliquid legs of your pairs settle in USDC. When those legs lose money
      or pay funding, Gate lends you the USDC to cover it. The amber pill shows that borrow.
    </p>
    <p>
      <span className="font-semibold text-ink-100">Why it matters. </span>
      Gate holds extra margin against the borrow: 20% as initial margin and 10% as maintenance margin. Once you are
      more than 10,000 USDC short, Gate also charges interest every hour.
    </p>
    <p>
      <span className="font-semibold text-ink-100">The two moves. </span>
      USDT → Hyperliquid USDC pays the borrow back. That frees the margin and stops the interest. Hyperliquid USDC →
      USDT brings spare USDC home when those legs made money.
    </p>
  </div>
);

const DIRECTION_OPTIONS: { value: RebalanceDirection; label: string }[] = [
  { value: 'payDown', label: 'USDT → Hyperliquid USDC' },
  { value: 'pull', label: 'Hyperliquid USDC → USDT' },
];

const SHORTFALL_TEXT = {
  cash: 'unrealised profit cannot move until the position closes',
  margin: 'available margin is too low',
} as const;

type SegmentKind = 'done' | 'running' | 'pending' | 'halted';

const SEGMENT_FILL: Record<SegmentKind, string> = {
  done: 'bg-emerald-500',
  running: 'bg-cyan-500',
  pending: 'bg-transparent',
  halted: 'bg-rose-500',
};

const SEGMENT_TEXT: Record<SegmentKind, string> = {
  done: 'text-emerald-300',
  running: 'text-cyan-300',
  pending: 'text-ink-500',
  halted: 'text-rose-300',
};

function floorCents(value: number): number {
  return Number(roundToStep(Math.max(0, value), '0.01', 'down'));
}

function parseAmount(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

function quoteLine(plan: RebalancePlan, routeName: 'loop' | 'convert', pull: boolean): string {
  const route = plan.routes[routeName];
  const price = plan.price === null ? '—' : num(plan.price, 4);
  const wait = `about ${num(route.waitSeconds / 60, 1)} min`;
  if (pull) {
    return `via spot loop · ${num(plan.amount, 2)} USDC → ${num(plan.receives, 2)} USDT @ ${price} · costs ${fmtUsd(route.costUsd)} · ${wait}`;
  }
  const move = `${num(plan.amount, 2)} USDT → ${num(plan.receives, 2)} USDC @ ${price}`;
  const effect = `saves ${fmtUsd(plan.savesPerDayUsd)}/day · frees ${fmtUsd(plan.marginFreedUsd)} margin · borrow after ${fmtUsd(plan.borrowAfterUsd)}`;
  if (routeName === 'convert') {
    return `via convert · ${move} · spread ${fmtUsd(route.costUsd)} · ${effect} · instant · sends on a fresh quote within 30 bps of this one`;
  }
  return `via spot loop · ${move} · costs ${fmtUsd(route.costUsd)} · ${effect} · ${wait}`;
}

function segment(step: RebalanceStep, job: RebalanceJob, now: number): { kind: SegmentKind; pct: number; text: string } {
  const expected = EXPECTED_SECONDS[step.name] ?? 0;
  if (step.status === 'done' && step.startedAt !== null && step.doneAt !== null) {
    return { kind: 'done', pct: 100, text: fmtAge(step.doneAt - step.startedAt) };
  }
  if (step.status === 'running' && step.startedAt !== null) {
    const halted = job.status === 'halted';
    const elapsed = Math.max(0, (halted ? job.updatedAt : now) - step.startedAt);
    const ratio = expected > 0 ? elapsed / 1000 / expected : 1;
    const pct = Math.min(95, ratio * 100);
    if (halted) return { kind: 'halted', pct, text: `halted at ${fmtAge(elapsed)}` };
    return { kind: 'running', pct, text: `${fmtAge(elapsed)} / ~${fmtAge(expected * 1000)}` };
  }
  return { kind: 'pending', pct: 0, text: `~${fmtAge(expected * 1000)}` };
}

function progressBar(job: RebalanceJob, now: number) {
  return (
    <ol className="flex gap-2">
      {job.steps.map((s) => {
        const seg = segment(s, job, now);
        return (
          <li key={s.name} className="flex flex-1 flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-ink-100">{s.name}</span>
              <span className={`num ${SEGMENT_TEXT[seg.kind]}`}>{seg.text}</span>
            </div>
            <div
              role="progressbar"
              aria-label={s.name}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(seg.pct)}
              className="h-1.5 overflow-hidden rounded-full bg-ink-800"
            >
              <div className={`h-full ${SEGMENT_FILL[seg.kind]}`} style={{ width: `${seg.pct}%` }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
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

export function RebalanceSection({ holdMs }: { holdMs?: number }) {
  const [chosen, setChosen] = useState<RebalanceDirection | null>(null);
  const direction = chosen ?? 'payDown';
  const [typed, setTyped] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(false);
  const [amountParam, setAmountParam] = useState<number | null>(null);
  const query = useRebalance({ direction, amount: amountParam });
  const start = useStartRebalance();
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const now = useNow(1_000);

  useEffect(() => {
    if (typed === null) return;
    const t = setTimeout(() => setAmountParam(parseAmount(typed)), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const data = query.data;
  const usdc = data?.buckets.find((b) => b.coin === 'USDC' && b.venue === 'HYPERLIQUID');
  const usdt = data?.buckets.find((b) => b.coin === 'USDT' && b.venue === 'CROSSEX');
  const borrow = floorCents(usdc?.borrow ?? 0);
  const pullable = floorCents(Math.min(usdc?.cash ?? 0, usdc?.equity ?? 0));

  useEffect(() => {
    if (chosen !== null || !data) return;
    setChosen(borrow === 0 && pullable > 0 ? 'pull' : 'payDown');
  }, [chosen, data, borrow, pullable]);

  if (!data) return null;

  const job = data.job && (data.job.status === 'running' || data.job.status === 'halted') ? data.job : null;
  if (borrow === 0 && pullable === 0 && !job) return null;

  const plan = data.plan;
  const pull = direction === 'pull';

  const pickDirection = (next: RebalanceDirection) => {
    setChosen(next);
    setTyped(null);
    setAmountParam(null);
    setBlurred(false);
    start.reset();
  };

  let body;
  if (job?.status === 'running') {
    body = progressBar(job, now);
  } else if (job) {
    const cmdPending = resume.isPending || abandon.isPending;
    body = (
      <>
        {progressBar(job, now)}
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
  } else {
    const inputValue = typed ?? roundToStep(plan.amount, '0.01', 'down');
    const typedAmount = typed === null ? null : parseAmount(typed);
    const invalid = parseAmount(inputValue) === null;
    const showEnter = blurred && invalid;
    const settled = !query.isPlaceholderData && amountParam === typedAmount;
    const capped = settled && typedAmount !== null && floorCents(typedAmount) > plan.amount;
    const free = pull ? pullable : floorCents(usdt?.cash ?? 0);
    const routeName = plan.route;
    body = (
      <>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-ink-400">Direction</span>
            <SegmentedToggle<RebalanceDirection>
              ariaLabel="Direction"
              value={direction}
              onChange={pickDirection}
              options={DIRECTION_OPTIONS}
            />
          </div>
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <label htmlFor="rebalance-amount" className="text-[11px] text-ink-400">
              {`Amount (${pull ? 'USDC' : 'USDT'}) · free ${num(free, 2)}`}
            </label>
            <input
              id="rebalance-amount"
              className={`input num ${showEnter ? '!border-rose-500/60' : ''}`}
              inputMode="decimal"
              aria-invalid={showEnter ? true : undefined}
              aria-describedby={showEnter ? 'rebalance-amount-error' : undefined}
              value={inputValue}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={() => setBlurred(true)}
            />
          </div>
          {routeName && (
            <HoldToConfirmButton
              tone="cyan"
              holdMs={holdMs}
              disabled={start.isPending || invalid || !settled}
              onConfirm={() => start.mutate({ direction, amount: plan.amount, route: routeName })}
            >
              {pull
                ? `Hold to pull ${num(plan.amount, 2)} USDC → USDT`
                : `Hold to move ${num(plan.amount, 2)} USDT → USDC`}
            </HoldToConfirmButton>
          )}
        </div>
        {showEnter && (
          <p id="rebalance-amount-error" role="alert" className="text-[11px] text-rose-300">
            Enter an amount
          </p>
        )}
        {capped && <p className="text-[11px] text-amber-300">Capped at {num(plan.amount, 2)}</p>}
        {routeName ? (
          <>
            <p className="text-[12px] text-ink-300">{quoteLine(plan, routeName, pull)}</p>
            {!pull && plan.shortfall && (
              <p className="text-[12px] text-amber-300">
                {`Only ${num(plan.amount, 2)} USDC can move. ${num(plan.shortfall.remaining, 2)} USDC stays borrowed: ${SHORTFALL_TEXT[plan.shortfall.reason]}`}
              </p>
            )}
            {errorLine(start.error)}
          </>
        ) : (
          <>
            <p className="text-[12px] text-ink-300">Loop: {plan.routes.loop.reason ?? '—'}</p>
            <p className="text-[12px] text-ink-300">Convert: {plan.routes.convert.reason ?? '—'}</p>
          </>
        )}
      </>
    );
  }

  return (
    <section aria-label="Rebalance" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Rebalance</h2>
            <HoverCard widthPx={420} label={<span className="sr-only">About rebalance</span>}>
              {ABOUT}
            </HoverCard>
          </div>
          <p className="text-[12px] text-ink-500">move cash between USDT and Hyperliquid USDC</p>
        </div>
        {borrow > 0 && (
          <span className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
            {`Borrow ${fmtUsd(borrow)} · +${fmtUsd(usdc?.imHeldUsd ?? 0)} IM · +${fmtUsd(usdc?.mmHeldUsd ?? 0)} MM`}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-8">
        <Stat label="Interest / day">
          <span className="num">{fmtUsd(usdc?.interestPerDayUsd ?? 0)}</span>
        </Stat>
        <Stat label="Interest paid · 30 d">
          <span className="num">{fmtUsd(usdc?.interestPaid30dUsd ?? 0)}</span>
        </Stat>
      </div>
      <p className="text-[12px] text-ink-400">{EXPLANATION[job ? job.direction : direction]}</p>
      {body}
    </section>
  );
}
