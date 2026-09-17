import { useState, type ReactNode } from 'react';
import { useRebalance, useTransfer } from '../api/queries';
import type { RebalanceJob } from '../api/types';
import { Chip } from '../components/Chip';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { borrowingBuckets } from '../lib/borrow';
import { fmtAbout, fmtUsd, num } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { jobSeconds } from './RebalanceBits';
import { MODAL_FEE, NO_LEGS, VERDICT_BALANCED, VERDICT_MOVES, VERDICT_NO_BORROW } from './rebalanceCopy';
import { WAITS_FOR_DEAL, WAITS_FOR_TRANSFER } from './rebalanceCopy';
import { borrowFacts, Facts, isCashLimitedEven, pickedRoute, worthLine } from './RebalanceHovers';
import { RebalanceInfo, roundCountOf, roundOf } from './RebalanceHovers';
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
    <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
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
    const { plan, buckets } = view;
    const job = view.job && (view.job.status === 'running' || view.job.status === 'halted') ? view.job : null;
    const showAge = loadError !== null || (openedWith > 0 && query.dataUpdatedAt === openedWith);
    const picked = pickedRoute(plan, null);
    const hasBorrow = borrowingBuckets(buckets).length > 0;
    // With every route blocked, the window cannot run, so the card gives no verdict.
    const worth = hasBorrow && picked.name !== null ? worthLine(picked.route, buckets) : null;
    const moving = transfer?.transfer?.status === 'moving';
    const dealWorking = transfer?.lock === 'deal';

    let chip: ReactNode = null;
    if (job?.status === 'running') chip = <Chip tone="info">Running</Chip>;
    if (job?.status === 'halted') chip = <Chip tone="red">Stopped</Chip>;
    if (!job && plan.balanced && !plan.noLegs) chip = <Chip tone="green">Balanced</Chip>;

    let verdict: ReactNode = null;
    let warn = false;
    if (job) verdict = jobVerdict(job, now);
    else if (plan.noLegs) verdict = NO_LEGS;
    else if (isCashLimitedEven(plan)) verdict = `${fmtUsd(plan.shortOfEven)} ${IS_POSITION_MARGIN}`;
    else if (plan.balanced) verdict = VERDICT_BALANCED;
    else if (!hasBorrow) verdict = <>{VERDICT_NO_BORROW} <span className="text-ink-500">{VERDICT_MOVES(fmtUsd(plan.moves))}</span></>;
    else if (worth) {
      verdict = worth.text;
      warn = worth.warn;
    }

    let label: ReactNode = REBALANCE;
    if (job) label = jobButton(job);
    else if (moving) label = WAITS_FOR_TRANSFER;
    else if (dealWorking) label = WAITS_FOR_DEAL;
    else if (!plan.balanced && !plan.noLegs) label = <>{REBALANCE} <span className="opacity-80">{`· ${MODAL_FEE(fmtUsd(picked.route.costUsd))}`}</span></>;
    const disabled = !job && (plan.balanced || plan.noLegs || moving || dealWorking);
    const primary = !job && hasBorrow && picked.name !== null && !worth?.warn;

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
    if (verdict !== null) line = <p className={`num text-xs ${warn ? 'text-amber-300' : 'text-ink-300'}`}>{verdict}</p>;
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
