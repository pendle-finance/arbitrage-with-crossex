import { useState, type ReactNode } from 'react';
import { useAccount, usePositions, useRebalance, useTransfer } from '../api/queries';
import type { GateAccount, RebalanceJob, RebalanceView, RoutePlan, TransferCoin } from '../api/types';
import { Chip } from '../components/Chip';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { borrowingBuckets } from '../lib/borrow';
import { fmtAbout, fmtUsd, num } from '../lib/fmt';
import { nearestLiquidation } from '../lib/liquidation';
import { floorCents } from '../lib/ticks';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { BalanceBars, jobSeconds, scaleOf, ShareColumn } from './RebalanceBits';
import { BAR_CAPTION, GATE_SPOT, HOVER, NO_LEGS, SHARE_CAPTION, VERDICT_BALANCED, VERDICT_FREE, VERDICT_NO_BORROW } from './rebalanceCopy';
import { VERDICT_REPAYS, VERDICT_REPAYS_NOTHING, VERDICT_STOPS, VERDICT_STOPS_UNDER_A_CENT, WAITS_FOR_DEAL, WAITS_FOR_TRANSFER } from './rebalanceCopy';
import { barRowsOf, borrowFacts, DUST, Facts, fmtCoinOrUsd, isCashLimitedEven, pickedRoute, planSteps, positionShares } from './RebalanceHovers';
import { RebalanceInfo, repayOf, roundCountOf, sharedCoin, shownKeys, targetsOf, Term } from './RebalanceHovers';
import { RebalanceModal } from './RebalanceModal';
import { NoSpotReadLine } from './TransferBits';

const SUBTITLE = 'Split your CrossEx equity by position size';
const EQUITY_HEAD = 'Equity';
const LOAD_FAILED = 'Could not load Rebalance.';
const RETRY = 'Retry';
const READ_AGAIN = 'Read again';
const REBALANCE = 'Rebalance';
const WOULD_MOVE = 'would move.';
const NOT_MARGIN = '· not margin';
const STOPPED_OPEN = 'Stopped · open';
const OPEN_TO_SEE = 'Open it to see where your money is.';
const OPEN_TO_FOLLOW = 'Open it to follow each step.';
const AS_EVEN_AS_CASH = 'As even as cash allows.';
const IS_POSITION_MARGIN = 'is margin for open positions.';

function borrowVerdict(view: RebalanceView, route: RoutePlan): string {
  const repay = repayOf(view.buckets, route);
  if (repay.wallets.length === 0) return VERDICT_REPAYS_NOTHING;
  const lead = VERDICT_REPAYS(fmtCoinOrUsd(repay.amount, sharedCoin(repay.wallets)));
  const stops = repay.stopsPerDayUsd;
  if (stops === null) return lead;
  if (stops === 0) return `${lead} ${VERDICT_FREE}`;
  if (floorCents(stops) === 0) return `${lead} ${VERDICT_STOPS_UNDER_A_CENT}`;
  return `${lead} ${VERDICT_STOPS(fmtUsd(stops))}`;
}

const roundOf = (job: RebalanceJob): number | null => job.steps[job.stepIndex]?.round ?? null;

const minutesLeft = (seconds: number): string => fmtAbout(seconds).replace(/ 1 min$/, ' 1 minute').replace(/ min$/, ' minutes');

function jobVerdict(job: RebalanceJob, now: number): string {
  const round = roundOf(job);
  if (job.status === 'halted') {
    return `A rebalance stopped ${round === null ? 'at Convert' : `in round ${num(round, 0)}`}. ${OPEN_TO_SEE}`;
  }
  const total = jobSeconds(job);
  const left = Math.max(0, total - Math.max(0, now - job.createdAt) / 1000);
  const progress = round === null ? 'Convert' : `Round ${num(round, 0)} of ${num(roundCountOf(job), 0)}`;
  return `A rebalance is running. ${progress}${total > 0 ? `, ${minutesLeft(left)} left` : ''}. ${OPEN_TO_FOLLOW}`;
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
  if (!job && moving) chip = <Chip tone="info">{WAITS_FOR_TRANSFER}</Chip>;
  if (!job && !moving && dealWorking) chip = <Chip tone="info">{WAITS_FOR_DEAL}</Chip>;

  const wouldMove = <span className="text-ink-500">{`${fmtUsd(plan.moves)} ${WOULD_MOVE}`}</span>;
  let verdict: ReactNode;
  if (job) verdict = jobVerdict(job, now);
  else if (plan.noLegs) verdict = NO_LEGS;
  else if (isCashLimitedEven(plan)) verdict = `${AS_EVEN_AS_CASH} ${fmtUsd(plan.shortOfEven)} ${IS_POSITION_MARGIN}`;
  else if (plan.balanced) verdict = VERDICT_BALANCED;
  else if (!hasBorrow) verdict = <>{VERDICT_NO_BORROW} {wouldMove}</>;
  else verdict = borrowVerdict(view, route);

  let label: ReactNode = REBALANCE;
  if (job) label = jobButton(job);
  else if (!plan.balanced && !plan.noLegs) label = <>{REBALANCE} <span className="opacity-80">{`· ${fmtUsd(route.costUsd)}`}</span></>;
  const disabled = !job && (plan.balanced || plan.noLegs || moving || dealWorking);

  const spot = transfer?.spot;
  const held = (spot ?? []).filter((s) => s.available >= DUST);
  const spotShown = held.length > 0 ? held : (spot ?? []).filter((s) => s.coin === 'USDT');

  return (
    <section aria-label="Rebalance" className="card flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        {title}
        <p className="text-xs text-ink-500">{SUBTITLE}</p>
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
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <BalanceBars
            caption={
              <span className="flex gap-3">
                <span className="w-40 shrink-0">{HOVER.rebalanceTitle.walletHead.wallet}</span>
                <span className="flex-1">{BAR_CAPTION}</span>
                <span className="w-20 shrink-0 text-right">
                  <Term label={EQUITY_HEAD} text={HOVER.now} />
                </span>
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
      <div className="border-t border-ink-800 pt-3">
        <Facts items={borrowFacts(buckets, nearestLiquidation(account, positions))} />
      </div>
      <div className="flex flex-col gap-3 border-t border-ink-800 pt-3">
        <p className="num text-xs text-ink-300">{verdict}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={job || !hasBorrow ? 'btn num' : 'btn btn-primary num'}
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            {label}
          </button>
          {spot === null && <NoSpotReadLine />}
          {spotShown.length > 0 && (
            <div className="text-xs text-ink-400">
              <span className="num text-gold">{spotShown.map((s) => `${num(s.available)} ${s.coin}`).join(' · ')}</span>
              {' in '}
              <Term label={GATE_SPOT} text={HOVER.gateSpot} />{' '}
              <span className="text-ink-500">{NOT_MARGIN}</span>
            </div>
          )}
        </div>
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
