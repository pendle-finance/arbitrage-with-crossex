import { useState, type ReactNode } from 'react';
import { useAccount, usePositions, useRebalance, useTransfer } from '../api/queries';
import type { RebalanceJob } from '../api/types';
import { Chip } from '../components/Chip';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { borrowingBuckets } from '../lib/borrow';
import { fmtAbout, fmtUsd, num } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { BalanceBars, jobSeconds, scaleOf, ShareColumn } from './RebalanceBits';
import { BAR_CAPTION, HOVER, MODAL_FEE, NO_LEGS, SHARE_CAPTION, VERDICT_BALANCED, VERDICT_MOVES, VERDICT_NO_BORROW } from './rebalanceCopy';
import { WAITS_FOR_DEAL, WAITS_FOR_TRANSFER } from './rebalanceCopy';
import { barRowsOf, borrowFacts, Facts, isCashLimitedEven, pickedRoute, planSteps, positionShares } from './RebalanceHovers';
import { liquidationNow, RebalanceInfo, roundCountOf, roundOf, shownKeys, targetsOf, Term } from './RebalanceHovers';
import { RebalanceModal } from './RebalanceModal';
import type { GateAccount, TransferCoin } from '../api/types';

const LOAD_FAILED = 'Could not load Rebalance.';
const RETRY = 'Retry';
const READ_AGAIN = 'Read again';
const REBALANCE = 'Rebalance';
const STOPPED_OPEN = 'Stopped · open';
const IS_POSITION_MARGIN = 'cannot move. It is margin for open positions.';

const minutesLeft = (seconds: number): string => fmtAbout(seconds).replace(/ 1 min$/, ' 1 minute').replace(/ min$/, ' minutes');

function jobVerdict(job: RebalanceJob, now: number): string {
  const round = roundOf(job);
  if (job.status === 'halted') return `Rebalance stopped ${round === null ? 'at Convert' : `in round ${num(round, 0)}`}.`;
  const total = jobSeconds(job);
  const left = Math.max(0, total - Math.max(0, now - job.createdAt) / 1000);
  return total > 0 ? `Rebalance running, ${minutesLeft(left)} left.` : 'Rebalance running.';
}

function jobButton(job: RebalanceJob): string {
  if (job.status === 'halted') return STOPPED_OPEN;
  const round = roundOf(job);
  return round === null ? 'Running · Convert' : `Running · round ${num(round, 0)} of ${num(roundCountOf(job), 0)}`;
}

export function RebalanceSection({
  holdMs,
  onTransfer,
}: {
  holdMs?: number;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
}) {
  const query = useRebalance();
  const transfer = useTransfer().data;
  const account = useAccount().data;
  const positions = usePositions().data;
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [openedWith] = useState(query.dataUpdatedAt);
  const loadError = useSettledError(query.status, query.error);
  const view = query.data;
  const title = (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
      <RebalanceInfo />
    </h2>
  );

  if (!view) {
    if (!loadError) return null;
    return (
      <section aria-label="Rebalance" className="card flex flex-col gap-2 p-4">
        {title}
        <p role="alert" className="text-xs text-rose-300">
          {`${LOAD_FAILED} ${loadError.message}`}
        </p>
        <button type="button" className="btn-ghost-xs leading-4 self-start" onClick={() => void query.refetch()}>
          {RETRY}
        </button>
      </section>
    );
  }

  const { plan, buckets } = view;
  const job = view.job && (view.job.status === 'running' || view.job.status === 'halted') ? view.job : null;
  const showAge = loadError !== null || (openedWith > 0 && query.dataUpdatedAt === openedWith);
  const target = targetsOf(view);
  const rows = barRowsOf(buckets, shownKeys(view, job ? job.steps : planSteps(plan)), target);
  const shares = positionShares(plan);
  const route = pickedRoute(plan, null).route;
  const hasBorrow = borrowingBuckets(buckets).length > 0;
  const moving = transfer?.transfer?.status === 'moving';
  const dealWorking = transfer?.lock === 'deal';

  let chip: ReactNode = null;
  if (job?.status === 'running') chip = <Chip tone="info">Running</Chip>;
  if (job?.status === 'halted') chip = <Chip tone="red">Stopped</Chip>;
  if (!job && plan.balanced && !plan.noLegs) chip = <Chip tone="green">Balanced</Chip>;

  let verdict: ReactNode = null;
  if (job) verdict = jobVerdict(job, now);
  else if (plan.noLegs) verdict = NO_LEGS;
  else if (isCashLimitedEven(plan)) verdict = `${fmtUsd(plan.shortOfEven)} ${IS_POSITION_MARGIN}`;
  else if (plan.balanced) verdict = VERDICT_BALANCED;
  else if (!hasBorrow) verdict = <>{VERDICT_NO_BORROW} <span className="text-ink-500">{VERDICT_MOVES(fmtUsd(plan.moves))}</span></>;

  let label: ReactNode = REBALANCE;
  if (job) label = jobButton(job);
  else if (moving) label = WAITS_FOR_TRANSFER;
  else if (dealWorking) label = WAITS_FOR_DEAL;
  else if (!plan.balanced && !plan.noLegs) label = <>{REBALANCE} <span className="opacity-80">{`· ${MODAL_FEE(fmtUsd(route.costUsd))}`}</span></>;
  const disabled = !job && (plan.balanced || plan.noLegs || moving || dealWorking);

  return (
    <section aria-label="Rebalance" className="card flex flex-col gap-4 p-4">
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
      <Facts items={borrowFacts(buckets, liquidationNow(account, positions))} />
      <div className="flex gap-3 border-t border-ink-800 pt-3">
        <div className="min-w-0 flex-1">
          <BalanceBars
            caption={
              <span className="flex gap-3">
                <span className="w-40 shrink-0">{HOVER.rebalanceTitle.walletHead.wallet}</span>
                <span className="flex-1">{BAR_CAPTION}</span>
              </span>
            }
            rows={rows}
            scale={scaleOf(rows)}
          />
        </div>
        {shares.size > 0 && (
          <ShareColumn caption={<Term label={SHARE_CAPTION} text={HOVER.positionShare} />} rows={rows} shares={shares} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-ink-800 pt-3">
        <button
          type="button"
          className={job || !hasBorrow ? 'btn num' : 'btn btn-primary num'}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
        {verdict !== null && <p className="num text-xs text-ink-300">{verdict}</p>}
      </div>
      {open && (
        <RebalanceModal
          view={view}
          onClose={() => setOpen(false)}
          holdMs={holdMs}
          onTransfer={(coin, wallet) => {
            setOpen(false);
            onTransfer?.(coin, wallet);
          }}
        />
      )}
    </section>
  );
}
