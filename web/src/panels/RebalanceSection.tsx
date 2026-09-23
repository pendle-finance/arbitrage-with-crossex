import { useState, type ReactNode } from 'react';
import { useRebalance, useTransfer } from '../api/queries';
import type { RebalanceJob } from '../api/types';
import { Chip } from '../components/Chip';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { borrowingBuckets } from '../lib/borrow';
import { fmtAbout, fmtUsd, num } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { jobSeconds, VerdictAlert } from './RebalanceBits';
import { CARD_LABEL, NO_LEGS, SHORT_OF_CASH, VERDICT_BALANCED, VERDICT_NO_BORROW, VERDICT_NO_CASH_TO_MOVE } from './rebalanceCopy';
import { WAITS_FOR_DEAL, WAITS_FOR_TRANSFER } from './rebalanceCopy';
import { borrowFacts, defaultGoal, Facts, isCashLimitedEven, pickedRoute, worthLine, type VerdictTone } from './RebalanceHovers';
import { RebalanceInfo, roundCountOf, roundOf } from './RebalanceHovers';
import { RebalanceModal } from './RebalanceModal';
import type { GateAccount, TransferCoin } from '../api/types';

const LOAD_FAILED = 'Could not load Rebalance.';
const RETRY = 'Retry';
const READ_AGAIN = 'Read again';
const STOPPED_OPEN = 'Stopped · open';

const plural = (n: string, word: string): string => `${n} ${word}${n === '1' ? '' : 's'}`;

const timeLeft = (seconds: number): string =>
  fmtAbout(seconds)
    .replace(/(\d+) h\b/, (_all, n: string) => plural(n, 'hour'))
    .replace(/(\d+(?:\.\d+)?) (?:min|m)\b/, (_all, n: string) => plural(n, 'minute'));

function jobVerdict(job: RebalanceJob, now: number): string {
  const round = roundOf(job);
  const what = CARD_LABEL[job.goal];
  if (job.status === 'halted') return `${what} stopped ${round === null ? 'at Convert' : `in round ${num(round, 0)}`}.`;
  const total = jobSeconds(job);
  const left = Math.max(0, total - Math.max(0, now - job.createdAt) / 1000);
  return total > 0 ? `${what} running, ${timeLeft(left)} left.` : `${what} running.`;
}

function jobButton(job: RebalanceJob): string {
  if (job.status === 'halted') return STOPPED_OPEN;
  const round = roundOf(job);
  return round === null ? 'Running · Convert' : `Running · round ${num(round, 0)} of ${num(roundCountOf(job), 0)}`;
}

/** The Rebalance part of the Assets card: borrow facts, then the Rebalance
 * button with the card's other actions beside it. */
export function RebalanceSection({
  holdMs,
  onTransfer,
  actions,
}: {
  holdMs?: number;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
  actions?: ReactNode;
}) {
  const query = useRebalance();
  const transfer = useTransfer().data;
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [openedWith] = useState(query.dataUpdatedAt);
  const loadError = useSettledError(query.status, query.error);
  const view = query.data;
  const title = (
    <h2 className="text-[14px] font-semibold text-ink-50">
      <RebalanceInfo />
    </h2>
  );

  if (!view && !loadError && !actions) return null;

  // One tree in every state: `actions` always sits last in the button row, so
  // Manual Transfer keeps its open window and its transfer id while Rebalance
  // loads, fails or refreshes.
  let header: ReactNode = null;
  let facts: ReactNode = null;
  let line: ReactNode = null;
  let main: ReactNode = null;
  let modal: ReactNode = null;

  if (!view) {
    if (loadError) {
      header = title;
      line = (
        <p role="alert" className="text-xs text-rose-300">
          {`${LOAD_FAILED} ${loadError.message}`}
        </p>
      );
      main = (
        <button type="button" className="btn-ghost-xs leading-4" onClick={() => void query.refetch()}>
          {RETRY}
        </button>
      );
    }
  } else {
    const { buckets } = view;
    // The card leads with one preset. The dialog holds the other, and the
    // custom move, so the button opens it even when this preset has nothing
    // to do.
    const goal = defaultGoal(view);
    const plan = view.plans[goal];
    const cta = CARD_LABEL[goal];
    const job = view.job && (view.job.status === 'running' || view.job.status === 'halted') ? view.job : null;
    const showAge = loadError !== null || (openedWith > 0 && query.dataUpdatedAt === openedWith);
    const picked = pickedRoute(plan, null);
    const hasBorrow = borrowingBuckets(buckets).length > 0;
    // With every route blocked, the window cannot run, so the card gives no verdict.
    const worth = hasBorrow && picked.name !== null ? worthLine(picked.route, buckets, goal, plan.noLegs) : null;
    const moving = transfer?.transfer?.status === 'moving';
    const dealWorking = transfer?.lock === 'deal';

    let chip: ReactNode = null;
    if (job?.status === 'running') chip = <Chip tone="info">Running</Chip>;
    if (job?.status === 'halted') chip = <Chip tone="red">Stopped</Chip>;
    // "Balanced" only when the wallets really match their position share. The
    // planner also reports a plan with nothing to move when what it WOULD move
    // is stuck as position margin (`shortOfEven`); that case gets no chip —
    // the verdict line names the stuck amount (his call 2026-09-23: a green
    // "Balanced" over a $354k gap lied, an amber one read as a to-do).
    if (!job && goal === 'even' && plan.balanced && !plan.noLegs && !isCashLimitedEven(plan)) {
      chip = <Chip tone="green">Balanced</Chip>;
    }

    let verdict: ReactNode = null;
    let verdictSub: string | null = null;
    let tone: VerdictTone = 'info';
    if (job) verdict = jobVerdict(job, now);
    // What caps a move is cash when there are no positions, and position
    // margin when there are — the goal on screen does not decide it.
    else if (isCashLimitedEven(plan) && plan.noLegs) verdict = `${fmtUsd(plan.shortOfEven)} ${SHORT_OF_CASH}`;
    else if (isCashLimitedEven(plan)) {
      verdict = VERDICT_NO_CASH_TO_MOVE;
      tone = 'warn';
    }
    else if (goal === 'repay' && plan.balanced) verdict = VERDICT_NO_BORROW;
    else if (plan.noLegs && goal === 'even') verdict = NO_LEGS;
    else if (plan.balanced) verdict = VERDICT_BALANCED;
    // No trailing "It moves $X." here: the line now says no rebalancing is
    // necessary, and naming the amount in the same breath argued the opposite.
    // The figure is still on the button and inside the modal.
    else if (!hasBorrow) verdict = VERDICT_NO_BORROW;
    else if (worth) {
      verdict = worth.text;
      verdictSub = worth.sub ?? null;
      tone = worth.tone;
    }

    let label: ReactNode = cta;
    if (job) label = jobButton(job);
    else if (moving) label = WAITS_FOR_TRANSFER;
    else if (dealWorking) label = WAITS_FOR_DEAL;
    // No fee on the card (his ruling 2026-09-19): it is the fee of ONE preset,
    // and the dialog prices every route beside it anyway.
    const disabled = !job && (moving || dealWorking);
    // The one solid-filled control is spent on the verdict that actually asks
    // for the move, not on "you are borrowing" generally: a free borrow and a
    // fee that outruns its interest both leave it an outline.
    const primary = !job && worth?.tone === 'act';

    header = (
      <div className="flex items-center gap-3">
        {title}
        <div className="ml-auto flex items-center gap-2">
          {showAge && (
            <FreshnessButton
              dense
              dataUpdatedAt={query.dataUpdatedAt}
              staleError={loadError !== null}
              title={READ_AGAIN}
              onRefetch={() => void query.refetch()}
            />
          )}
          {chip}
        </div>
      </div>
    );
    facts = <Facts items={borrowFacts(buckets)} />;
    if (verdict !== null) line = <VerdictAlert tone={tone} text={verdict} sub={verdictSub} />;
    main = (
      <button type="button" className={primary ? 'btn btn-primary num' : 'btn num'} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
    if (open) {
      modal = (
        <RebalanceModal
          view={view}
          onClose={() => setOpen(false)}
          holdMs={holdMs}
          onTransfer={(coin, wallet) => {
            setOpen(false);
            onTransfer?.(coin, wallet);
          }}
        />
      );
    }
  }

  return (
    <section aria-label="Rebalance" className="flex flex-col gap-3 border-t border-ink-800 pt-4">
      {header}
      {facts}
      {line}
      <div className="flex flex-wrap items-center gap-3">
        {main}
        {actions}
      </div>
      {modal}
    </section>
  );
}
