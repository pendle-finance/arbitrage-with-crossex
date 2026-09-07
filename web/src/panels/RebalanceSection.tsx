import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useAccount, usePositions, useRebalance, useRebalanceCommand, useStartRebalance } from '../api/queries';
import type { RebalanceBucket, RebalanceDirection, RebalanceJob, RebalancePlan, RebalanceStep } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { HoverCard } from '../components/HoverCard';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import { fmtAge, fmtUsd, num } from '../lib/fmt';
import { fmtMove, nearestLiquidation } from '../lib/liquidation';
import { floorCents, roundToStep } from '../lib/ticks';
import { useNow } from '../lib/useNow';

const PULL_STEP_SECONDS = 390;
/** Under this the hold is hidden: a few-cent convert or a pull that the $1 fee eats is never worth a hold. */
const MIN_AMOUNT = 1;
/** Gate charges interest on the borrow only past this. Server: INTEREST_THRESHOLD in core/rebalance/plan.ts. */
const INTEREST_FREE_UNTIL = 10_000;

const EXPECTED_SECONDS: Record<string, number> = {
  'Buy USDC': 2,
  'To spot': 5,
  'To Hyperliquid': 127,
  Convert: 2,
  'Pull from Hyperliquid': PULL_STEP_SECONDS,
  'To Gate': 6,
  'Sell USDC': 2,
};

/** One line under the direction toggle. The long form is in the info card. */
const EXPLANATION: Record<RebalanceDirection, string> = {
  payDown: 'Pays the borrow back. Each USDC frees 0.20 initial and 0.10 maintenance margin.',
  pull: 'Brings spare USDC home. Capped at what you own there, so it never borrows.',
};

interface Fact {
  label: string;
  value: string;
}

/** Labelled facts in a row, so a reader scans a label and one number
 * instead of a sentence. */
function Facts({ items }: { items: Fact[] }) {
  return (
    <dl className="flex flex-wrap gap-x-7 gap-y-2">
      {items.map((f) => (
        <div key={f.label} className="flex flex-col gap-0.5">
          <dt className={microLabelClass}>{f.label}</dt>
          <dd className="num text-[12px] text-ink-200">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

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
      more than {num(INTEREST_FREE_UNTIL, 0)} USDC short, Gate also charges interest every hour.
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

function parseAmount(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** The quote as facts: route, what moves, what it costs, what it changes. */
function quoteFacts(plan: RebalancePlan, routeName: 'loop' | 'convert', pull: boolean, liquidation: string | null): Fact[] {
  const route = plan.routes[routeName];
  const price = plan.price === null ? '—' : num(plan.price, 4);
  const convert = routeName === 'convert';
  const facts: Fact[] = [
    { label: 'Route', value: convert ? 'Convert · instant' : `Spot loop · about ${num(route.waitSeconds / 60, 1)} min` },
    {
      label: 'Sends',
      value: pull
        ? `${num(plan.amount, 2)} USDC → ${num(plan.receives, 2)} USDT @ ${price}`
        : `${num(plan.amount, 2)} USDT → ${num(plan.receives, 2)} USDC @ ${price}`,
    },
    { label: 'Cost', value: convert ? `${fmtUsd(route.costUsd)} spread` : fmtUsd(route.costUsd) },
  ];
  if (!pull) {
    facts.push(
      { label: 'Borrow after', value: fmtUsd(plan.borrowAfterUsd) },
      { label: 'Frees', value: `${fmtUsd(plan.marginFreedUsd)} margin` },
      { label: 'Saves', value: `${fmtUsd(plan.savesPerDayUsd)} / day` },
    );
  }
  if (liquidation) facts.push({ label: 'Liquidation', value: liquidation });
  return facts;
}

/** `ETH +37% → +43%`: how much room the move buys. A rebalance moves cash
 * between the USDT and USDC wallets; the liability, and so the maintenance
 * margin, follows. Null when the account has no line. */
function liquidationShift(
  acc: ReturnType<typeof useAccount>['data'],
  positions: ReturnType<typeof usePositions>['data'],
  plan: RebalancePlan,
  pull: boolean,
): string | null {
  const before = nearestLiquidation(acc, positions);
  if (!before) return null;
  const after = nearestLiquidation(
    acc,
    positions,
    pull
      ? { 'USDC/HYPERLIQUID': -plan.amount, 'USDT/CROSSEX': plan.receives }
      : { 'USDC/HYPERLIQUID': plan.receives, 'USDT/CROSSEX': -plan.amount },
  );
  return `${before.base} ${fmtMove(before.move)} → ${after ? fmtMove(after.move) : 'past 10x'}`;
}

/** The situation as facts: what Gate lent, the margin it holds, the interest. */
function situationFacts(usdc: RebalanceBucket | undefined, borrow: number, pullable: number): Fact[] {
  if (!usdc) return [];
  const facts: Fact[] = [];
  const paid = usdc.interestPaid30dUsd > 0 ? { label: 'Interest paid · 30 d', value: fmtUsd(usdc.interestPaid30dUsd) } : null;
  if (borrow >= MIN_AMOUNT) {
    facts.push(
      { label: 'Lent by Gate', value: `${num(borrow, 2)} USDC` },
      { label: 'Initial margin held', value: fmtUsd(usdc.imHeldUsd) },
      { label: 'Maintenance margin held', value: fmtUsd(usdc.mmHeldUsd) },
      {
        label: 'Interest',
        value: usdc.interestPerDayUsd > 0 ? `${fmtUsd(usdc.interestPerDayUsd)} / day` : `none under ${num(INTEREST_FREE_UNTIL, 0)} USDC`,
      },
    );
  } else if (pullable >= MIN_AMOUNT) {
    facts.push({ label: 'Spare USDC on Hyperliquid', value: `${num(pullable, 2)} USDC` });
  }
  if (paid) facts.push(paid);
  return facts;
}

function noRouteLine(plan: RebalancePlan, pull: boolean, borrow: number, free: number): { text: string; warn: boolean } {
  const reason = plan.routes.loop.reason;
  if (reason && reason !== 'nothing to move') return { text: reason, warn: true };
  if (pull) {
    return { text: free > 0 ? 'Nothing to pull.' : 'Nothing to pull. There is no spare USDC on Hyperliquid.', warn: false };
  }
  if (borrow === 0) return { text: 'Nothing to pay back. There is no USDC borrow on Hyperliquid.', warn: false };
  if (free === 0) return { text: 'Nothing to move. There is no free USDT.', warn: false };
  return { text: 'Nothing to move.', warn: false };
}

function tooSmallLine(pull: boolean, borrow: number): string {
  if (pull) return `Nothing to pull. Spare USDC is under ${MIN_AMOUNT} USDC.`;
  if (borrow < MIN_AMOUNT) return `Nothing to pay back. The borrow is under ${MIN_AMOUNT} USDC.`;
  return `Under ${MIN_AMOUNT} USDT can move. Free USDT or margin is too low.`;
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
  const account = useAccount().data;
  const positions = usePositions().data;

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
  const job = data?.job && (data.job.status === 'running' || data.job.status === 'halted') ? data.job : null;

  useEffect(() => {
    if (chosen !== null || !data) return;
    setChosen(borrow < MIN_AMOUNT && pullable > 0 ? 'pull' : 'payDown');
  }, [chosen, data, borrow, pullable]);

  /* A finished job leaves the bucket on the other side: a pay-down leaves
     spare USDC, a pull leaves nothing. Go back to the default direction and
     a fresh input, so the section reads for what is now possible. */
  const activeJobId = job?.id ?? null;
  const lastActive = useRef<string | null>(null);
  useEffect(() => {
    if (lastActive.current !== null && activeJobId === null) {
      setChosen(null);
      setTyped(null);
      setAmountParam(null);
      setBlurred(false);
    }
    lastActive.current = activeJobId;
  }, [activeJobId]);

  if (!data) return null;

  /* Presence must not depend on cents. Both directions end with the bucket's
     equity near zero, where unrealised PnL flips the borrow and the pullable
     amount between 0.00 and a few cents on every poll. Show the section for
     any Hyperliquid USDC activity at all; the floor lines say what is
     possible. */
  const active = Boolean(usdc && (usdc.cash !== 0 || usdc.equity !== 0 || usdc.upnl !== 0)) || data.job !== null;
  if (!active) return null;

  const plan = data.plan;
  const pull = direction === 'pull';
  const situation = situationFacts(usdc, borrow, pullable);

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
    const floorHit = settled && routeName !== null && plan.amount < MIN_AMOUNT;
    const capTooSmall = floorHit && (typedAmount === null || floorCents(typedAmount) > plan.amount);
    const typedTooSmall = floorHit && !capTooSmall;
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
          {routeName && !floorHit && (
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
        {typedTooSmall && (
          <p role="alert" className="text-[11px] text-rose-300">
            {`Enter at least ${MIN_AMOUNT} ${pull ? 'USDC' : 'USDT'}`}
          </p>
        )}
        {capped && !floorHit && <p className="text-[11px] text-amber-300">Capped at {num(plan.amount, 2)}</p>}
        {capTooSmall && <p className="text-[12px] text-ink-300">{tooSmallLine(pull, borrow)}</p>}
        {floorHit ? null : routeName ? (
          <>
            <Facts items={quoteFacts(plan, routeName, pull, liquidationShift(account, positions, plan, pull))} />
            {routeName === 'convert' && (
              <p className="text-[11px] text-ink-500">Sends on a fresh quote within 30 bps of this one.</p>
            )}
            {!pull && plan.shortfall && (
              <p className="text-[12px] text-amber-300">
                {`Only ${num(plan.amount, 2)} USDC can move. ${num(plan.shortfall.remaining, 2)} USDC stays borrowed: ${SHORTFALL_TEXT[plan.shortfall.reason]}`}
              </p>
            )}
            {errorLine(start.error)}
          </>
        ) : (
          (() => {
            const line = noRouteLine(plan, pull, borrow, free);
            return <p className={`text-[12px] ${line.warn ? 'text-amber-300' : 'text-ink-300'}`}>{line.text}</p>;
          })()
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
        {borrow >= MIN_AMOUNT && (
          <span className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
            {`Borrowing ${num(borrow, 2)} USDC`}
          </span>
        )}
      </div>
      {situation.length > 0 && <Facts items={situation} />}
      <p className="text-[12px] text-ink-400">{EXPLANATION[job ? job.direction : direction]}</p>
      {body}
    </section>
  );
}
