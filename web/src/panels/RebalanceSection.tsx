import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useAccount, usePositions, useRebalance, useRebalanceCommand, useStartRebalance } from '../api/queries';
import type { RebalanceBucket, RebalanceDirection, RebalanceJob, RebalancePlan, RebalanceStep } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { HoverCard } from '../components/HoverCard';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import { borrowedBucket } from '../lib/borrow';
import { fmtAge, fmtUsd, num } from '../lib/fmt';
import { fmtLinePrice, fmtMove, lineFor, liquidationLines, nearestLiquidation, type LiquidationLine } from '../lib/liquidation';
import { floorCents, roundToStep } from '../lib/ticks';
import { useNow } from '../lib/useNow';

const FROM_HYPERLIQUID_SECONDS = 390;
/** Under this the hold is hidden: a few-cent convert or a move to USDT that the $1 fee eats is never worth a hold. */
const MIN_AMOUNT = 1;
/** Gate charges interest on the borrow only past this. Server: INTEREST_THRESHOLD in core/rebalance/plan.ts. */
const INTEREST_FREE_UNTIL = 10_000;

const EXPECTED_SECONDS: Record<string, number> = {
  'Buy USDC': 2,
  'To spot': 5,
  'To Hyperliquid': 127,
  Convert: 2,
  'From Hyperliquid': FROM_HYPERLIQUID_SECONDS,
  'To Gate': 6,
  'Sell USDC': 2,
};

/** One line under the direction toggle. The long form is in the info card.
 * The move to USDT reads as a repayment when the USDT wallet is the borrowed one. */
function explanation(direction: RebalanceDirection, usdtBorrowed: boolean): string {
  if (direction === 'toUsdc') return 'Pays the USDC borrow back. Each USDC frees 0.20 initial and 0.10 maintenance margin.';
  if (usdtBorrowed) return 'Pays the USDT borrow back. Each USDT frees 0.20 initial and 0.10 maintenance margin.';
  return 'Brings spare USDC home. Capped at what you own there, so it never borrows.';
}

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
      Your CrossEx account has two wallets. USDT margins every venue but Hyperliquid. The Hyperliquid legs of your
      pairs settle in their own USDC wallet. When a wallet's legs lose money or pay funding past what it holds, Gate
      lends the coin: USDC for the Hyperliquid legs, USDT for the rest. The amber pill shows that borrow.
    </p>
    <p>
      <span className="font-semibold text-ink-100">Why it matters. </span>
      Gate holds extra margin against a borrow: 20% as initial margin and 10% as maintenance margin. Once a wallet is
      more than {num(INTEREST_FREE_UNTIL, 0)} short, Gate also charges interest on it every hour.
    </p>
    <p>
      <span className="font-semibold text-ink-100">The two moves. </span>
      Each direction moves cash into the other wallet. USDT → Hyperliquid USDC pays a USDC borrow back. Hyperliquid
      USDC → USDT pays a USDT borrow back, or brings spare USDC home when the Hyperliquid legs made money. Paying a
      borrow back frees the margin and stops the interest.
    </p>
  </div>
);

const DIRECTION_OPTIONS: { value: RebalanceDirection; label: string }[] = [
  { value: 'toUsdc', label: 'USDT → Hyperliquid USDC' },
  { value: 'toUsdt', label: 'Hyperliquid USDC → USDT' },
];

const SHORTFALL_TEXT = {
  cash: 'unrealised profit cannot move until the position closes',
  margin: 'available margin is too low',
  spare: 'there is no more spare USDC on Hyperliquid',
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

/** The quote as facts: route, what moves, what it costs, what it changes.
 * `repays`: the wallet the cash lands in has a borrow, so the move has a
 * borrow after, margin it frees, and interest it saves. */
function quoteFacts(
  plan: RebalancePlan,
  routeName: 'loop' | 'convert',
  toUsdt: boolean,
  repays: boolean,
  liquidation: string | null,
): Fact[] {
  const route = plan.routes[routeName];
  const price = plan.price === null ? '—' : num(plan.price, 4);
  const convert = routeName === 'convert';
  const facts: Fact[] = [
    { label: 'Route', value: convert ? 'Convert · instant' : `Spot loop · about ${num(route.waitSeconds / 60, 1)} min` },
    {
      label: 'Sends',
      value: toUsdt
        ? `${num(plan.amount, 2)} USDC → ${num(plan.receives, 2)} USDT @ ${price}`
        : `${num(plan.amount, 2)} USDT → ${num(plan.receives, 2)} USDC @ ${price}`,
    },
    { label: 'Cost', value: convert ? `${fmtUsd(route.costUsd)} spread` : fmtUsd(route.costUsd) },
  ];
  if (repays) {
    facts.push(
      { label: 'Borrow after', value: fmtUsd(plan.borrowAfterUsd) },
      { label: 'Frees', value: `${fmtUsd(plan.marginFreedUsd)} margin` },
      { label: 'Saves', value: `${fmtUsd(plan.savesPerDayUsd)} / day` },
    );
  }
  if (liquidation) facts.push({ label: 'Liquidation', value: liquidation });
  return facts;
}

/** `ETH ~$3,150 (+37%) → ~$3,290 (+43%)`: the nearest coin's liquidation
 * price before and after the move. A rebalance moves cash between the USDT
 * and USDC wallets; the liability, and so the maintenance margin, follows.
 * The after figure is the same coin's, not whichever coin is nearest after.
 * Null when the account has no line. */
function liquidationShift(
  acc: ReturnType<typeof useAccount>['data'],
  positions: ReturnType<typeof usePositions>['data'],
  plan: RebalancePlan,
  toUsdt: boolean,
): string | null {
  const before = nearestLiquidation(acc, positions);
  if (!before || !acc || !positions) return null;
  const view = liquidationLines(
    acc,
    positions,
    toUsdt
      ? { 'USDC/HYPERLIQUID': -plan.amount, 'USDT/CROSSEX': plan.receives }
      : { 'USDC/HYPERLIQUID': plan.receives, 'USDT/CROSSEX': -plan.amount },
  );
  const after = view ? lineFor(view, before.base) : null;
  const at = (l: LiquidationLine) => `${fmtLinePrice(l.price)} (${fmtMove(l.move)})`;
  return `${before.base} ${at(before)} → ${after && after !== 'far' ? at(after) : 'past 10x'}`;
}

/** The situation as facts: what Gate lent, the margin it holds, the
 * interest, the spare USDC, the interest paid so far. The same six with and
 * without a borrow, zeros shown: a row that changes shape reads as a bug. */
function situationFacts(
  usdc: RebalanceBucket | undefined,
  usdt: RebalanceBucket | undefined,
  borrowed: RebalanceBucket | null,
  spareUsdc: number,
): Fact[] {
  const borrow = borrowed ? floorCents(borrowed.borrow) : 0;
  const interest = !borrowed
    ? `${fmtUsd(0)} / day`
    : borrowed.interestPerDayUsd > 0
      ? `${fmtUsd(borrowed.interestPerDayUsd)} / day`
      : `none under ${num(INTEREST_FREE_UNTIL, 0)} ${borrowed.coin}`;
  return [
    { label: 'Lent by Gate', value: borrowed ? `${num(borrow, 2)} ${borrowed.coin}` : '0.00' },
    { label: 'Initial margin held', value: fmtUsd(borrowed?.imHeldUsd ?? 0) },
    { label: 'Maintenance margin held', value: fmtUsd(borrowed?.mmHeldUsd ?? 0) },
    { label: 'Interest', value: interest },
    { label: 'Spare USDC on Hyperliquid', value: `${num(spareUsdc, 2)} USDC` },
    { label: 'Interest paid · all time', value: fmtUsd((usdc?.interestPaidUsd ?? 0) + (usdt?.interestPaidUsd ?? 0)) },
  ];
}

function noRouteLine(plan: RebalancePlan, toUsdt: boolean, borrow: number, free: number): { text: string; warn: boolean } {
  const reason = plan.routes.loop.reason;
  if (reason && reason !== 'nothing to move') return { text: reason, warn: true };
  if (toUsdt) {
    return { text: free > 0 ? 'Nothing to move.' : 'Nothing to move. There is no spare USDC on Hyperliquid.', warn: false };
  }
  if (borrow === 0) return { text: 'Nothing to move. There is no USDC borrow on Hyperliquid.', warn: false };
  if (free === 0) return { text: 'Nothing to move. There is no free USDT.', warn: false };
  return { text: 'Nothing to move.', warn: false };
}

function tooSmallLine(toUsdt: boolean, borrow: number): string {
  if (toUsdt) return `Nothing to move. Spare USDC is under ${MIN_AMOUNT} USDC.`;
  if (borrow < MIN_AMOUNT) return `Nothing to move. The USDC borrow is under ${MIN_AMOUNT} USDC.`;
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
  const direction = chosen ?? 'toUsdc';
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
  /* Either wallet can be the borrowed one. The direction toward it repays. */
  const borrowed = borrowedBucket(data?.buckets);
  const borrow = floorCents(usdc?.borrow ?? 0);
  const usdtBorrowed = borrowed?.venue === 'CROSSEX';
  const spareUsdc = Math.max(0, floorCents(Math.min(usdc?.cash ?? 0, usdc?.equity ?? 0)));
  const job = data?.job && (data.job.status === 'running' || data.job.status === 'halted') ? data.job : null;

  /* Default to the direction that repays the borrow; with none, to bringing
     spare USDC home when there is any. */
  useEffect(() => {
    if (chosen !== null || !data) return;
    setChosen(borrow >= MIN_AMOUNT ? 'toUsdc' : usdtBorrowed || spareUsdc > 0 ? 'toUsdt' : 'toUsdc');
  }, [chosen, data, borrow, usdtBorrowed, spareUsdc]);

  /* A finished job leaves the bucket on the other side: a move to USDC leaves
     spare USDC, a move to USDT leaves nothing. Go back to the default direction and
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

  /* A first fetch that failed must not hide the section: the user would not
     know the borrow exists. Say so and offer a retry. */
  if (!data) {
    if (!query.error) return null;
    return (
      <section aria-label="Rebalance" className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Rebalance</h2>
        <p role="alert" className="text-[12px] text-rose-300">
          Could not load the rebalance view. {query.error.message}
        </p>
        <button type="button" className="btn-ghost-xs self-start" onClick={() => void query.refetch()}>
          Retry
        </button>
      </section>
    );
  }

  /* Presence must not depend on cents. Both directions end with the bucket's
     equity near zero, where unrealised PnL flips the borrow and the spareUsdc
     amount between 0.00 and a few cents on every poll. Show the section for
     any Hyperliquid USDC activity at all; the floor lines say what is
     possible. */
  const active =
    Boolean(usdc && (usdc.cash !== 0 || usdc.equity !== 0 || usdc.upnl !== 0)) || usdtBorrowed || data.job !== null;
  if (!active) return null;

  const plan = data.plan;
  const toUsdt = direction === 'toUsdt';
  const repays = toUsdt ? usdtBorrowed : borrow >= MIN_AMOUNT;
  const situation = situationFacts(usdc, usdt, borrowed, spareUsdc);

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
    const free = toUsdt ? spareUsdc : floorCents(usdt?.cash ?? 0);
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
              {`Amount (${toUsdt ? 'USDC' : 'USDT'}) · free ${num(free, 2)}`}
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
              {toUsdt
                ? `Hold to move ${num(plan.amount, 2)} USDC → USDT`
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
            {`Enter at least ${MIN_AMOUNT} ${toUsdt ? 'USDC' : 'USDT'}`}
          </p>
        )}
        {capped && !floorHit && <p className="text-[11px] text-amber-300">Capped at {num(plan.amount, 2)}</p>}
        {capTooSmall && <p className="text-[12px] text-ink-300">{tooSmallLine(toUsdt, borrow)}</p>}
        {floorHit ? null : routeName ? (
          <>
            <Facts items={quoteFacts(plan, routeName, toUsdt, repays, liquidationShift(account, positions, plan, toUsdt))} />
            {routeName === 'convert' && (
              <p className="text-[11px] text-ink-500">Sends on a fresh quote within 30 bps of this one.</p>
            )}
            {plan.shortfall && (
              <p className="text-[12px] text-amber-300">
                {`Only ${num(plan.amount, 2)} USDC can move. ${num(plan.shortfall.remaining, 2)} ${toUsdt ? 'USDT' : 'USDC'} stays borrowed: ${SHORTFALL_TEXT[plan.shortfall.reason]}`}
              </p>
            )}
            {errorLine(start.error)}
          </>
        ) : (
          (() => {
            const line = noRouteLine(plan, toUsdt, borrow, free);
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
        {borrowed && (
          <span className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
            {`Borrowing ${num(floorCents(borrowed.borrow), 2)} ${borrowed.coin}`}
          </span>
        )}
      </div>
      {usdc && <Facts items={situation} />}
      <p className="text-[12px] text-ink-400">{explanation(job ? job.direction : direction, usdtBorrowed)}</p>
      {body}
    </section>
  );
}
