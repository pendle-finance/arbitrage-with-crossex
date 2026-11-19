import { useState, type ReactNode } from 'react';
import { usePositions } from '../api/queries';
import type { RealizeJobLeg, RebalanceJob } from '../api/types';
import { Chip } from '../components/Chip';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtAge, fmtUsd, num, prettyVenue } from '../lib/fmt';
import { EstimateRow } from '../trade/PairTicketBits';
import { BalanceBars, scaleOf } from './RebalanceBars';
import { RebalanceBeforeAfter, receiptChanges } from './RebalanceBeforeAfter';
import { markPriceOf, ProgressBar, StepList, type StepRow, type StepState } from './RebalanceBits';
import { CONVERT_TO, modalFeeLabel, PLATFORM, poolCoin, sideText, sizeText } from './rebalanceCopy';
import { barRowsOf, roundCountOf, roundOf, ROUTE_LABEL, shownKeys, SpotLines, targetsOf } from './RebalanceHovers';
import { abandonNote, Actions, CloseButton, gapBoxLines, haltLine, StopBox, stopTitle, type JobViewProps } from './RebalanceJobBits';
import { convertsOf, dustRestsOf, gapsOf, hasRest, isCloseSent, isShortDone, jobActionLegs, jobCostParts, lastRealizeIndex, legStep, legSteps } from './rebalanceJobSteps';
import { otherLegText, perpsOf, routeMoveOf, stateOf, type Gap } from './rebalanceJobSteps';
import { MoveJobView } from './RebalanceMoveJobView';
import { ImpactLabel, MovePath, moveTitle, realizePools, realizeText, routePools, STEPS_HEAD, walletOf } from './RebalancePlanBits';
import { RealizeActions, RealizeRow } from './RebalanceRealizeBits';
import { jobSeconds } from './rebalanceStepRows';
import { NoSpotReadLine } from './TransferBits';

const rk = realizeText;

export function RebalanceJobView(props: JobViewProps) {
  return props.job.realize?.legs.length ? <RealizeJobView {...props} /> : <MoveJobView {...props} />;
}

function RealizeJobView(props: JobViewProps) {
  const { job, view, now, pressed, transfer, onTransfer, onClose } = props;
  const [actionsOpen, setActionsOpen] = useState(false);
  const positionsRead = usePositions().data;
  const positions = positionsRead?.positions ?? [];
  const livePerps = positionsRead ? perpsOf(positions) : null;
  const pressedRealize = pressed?.plan.realize ?? null;
  const legs = job.realize?.legs ?? [];
  const split = lastRealizeIndex(job) + 1;
  const routeSteps = job.steps.slice(split);
  const routeState = stateOf(job, routeSteps);
  const gaps = gapsOf(job);
  const running = job.status === 'running';
  const done = job.status === 'done';
  const rests = done ? dustRestsOf(job) : [];
  const preClose = (pressed?.plan ?? view.plans[job.goal] ?? null)?.realize?.legs ?? [];
  const realizedOf = (leg: RealizeJobLeg): number =>
    leg.filledQty > 0 ? leg.realizedUsd : (preClose.find((p) => p.symbol === leg.symbol)?.realizedUsd ?? 0);
  const usdOf = (gap: Gap): string | null => {
    const mark = markPriceOf(positions, gap.leg.symbol);
    return mark === null ? null : fmtUsd(gap.qty * mark, 0);
  };
  const otherLeg = (leg: RealizeJobLeg): string => otherLegText(leg, [...(livePerps ?? []), ...(job.before?.perps ?? [])]);
  const gapWords = (gap: Gap) => ({ venue: prettyVenue(gap.leg.exchange), side: sideText(gap.leg.side), size: sizeText(gap.qty), base: gap.leg.base });

  const realizeRows = realizePools(legs).map(({ pool, legs: poolLegs }, index): StepRow => {
    const state = stateOf(job, poolLegs.flatMap((leg) => legSteps(job, leg)));
    const total = poolLegs.reduce((sum, leg) => sum + realizedOf(leg), 0);
    const amount = { amount: num(total, 0), coin: poolCoin(pool) };
    const closed = poolLegs.filter((leg) => leg.filledQty > 0);
    const gap = gaps.find((g) => poolLegs.includes(g.leg));
    const unconfirmed = poolLegs.find((leg) => isCloseSent(job, leg));
    const actionLegs = jobActionLegs(job, poolLegs, pressedRealize);
    const reason = job.haltReason ? <p key="why" className="text-xs text-ink-400">{localizeServerText(job.haltReason)}</p> : null;
    let text = rk(state === 'done' ? 'realizedTitle' : state === 'running' ? 'realizingTitle' : 'realizeTitle', amount);
    const body: ReactNode[] = [];
    if (state === 'stopped' && gap) {
      text = rk('stoppedTitle', { size: sizeText(gap.qty), base: gap.leg.base });
      const converts = convertsOf(job, gap.leg).filter((step) => step.status === 'done');
      if (converts.length > 0) {
        const landed = converts.reduce((sum, step) => sum + (step.qty ?? 0), 0);
        const sent = converts.reduce((sum, step) => sum + (step.planned ?? step.qty ?? 0), 0);
        const profit = realizedOf(gap.leg);
        body.push(
          <p key="cash" className="num text-xs text-ink-300">
            {rk('receiptCash', {
              profit: num(profit, 0), coin: poolCoin(pool), first: num(landed, 0), firstWallet: walletOf(CONVERT_TO[pool]),
              second: num(Math.max(0, profit - sent), 0), secondWallet: walletOf(pool),
            })}
          </p>,
        );
      }
    } else if (state === 'stopped' && unconfirmed) {
      text = rk('closeUnconfirmedTitle');
      const words = { platform: PLATFORM, side: sideText(unconfirmed.side), size: sizeText(unconfirmed.qty), base: unconfirmed.base };
      body.push(<p key="unconfirmed" className="num text-xs text-ink-300">{rk('closeUnconfirmedBody', words)}</p>, reason);
    } else if (state === 'stopped' && closed.length > 0) {
      text = rk('stoppedAfter', { done: num(closed.reduce((sum, leg) => sum + leg.realizedUsd, 0), 0), total: num(total, 0) });
      body.push(<RealizeRow key="row" legs={actionLegs} />, reason);
    } else if (state === 'stopped') {
      text = rk('stoppedBeforeClose');
      const leg = poolLegs[0]!;
      body.push(
        <p key="same" className="num text-xs text-ink-300">
          {rk('stoppedBeforeCloseBody', { venue: prettyVenue(leg.exchange), side: sideText(leg.side), size: sizeText(leg.positionQty), base: leg.base })}
        </p>,
        reason,
      );
    } else {
      const open = gap ?? rests.find((rest) => poolLegs.includes(rest.leg));
      if (open) {
        const usd = usdOf(open);
        body.push(
          <p key="gap" className="num text-xs text-gold">
            {usd === null ? rk('gapLineNoUsd', gapWords(open)) : rk('gapLine', { ...gapWords(open), usd })}
          </p>,
        );
      }
      body.push(<RealizeRow key="row" legs={actionLegs} />);
    }
    const retry = poolLegs.map((leg) => legStep(job, leg, 'Reopen')).find((step) => step?.retry && step.status !== 'done');
    if (retry?.retry && running) {
      const seconds = retry.nextTryAt ? Math.max(0, Math.ceil((retry.nextTryAt - now) / 1000)) : 0;
      body.push(
        <p key="retry" className="num text-xs text-gold">
          {rk('retryLine', { platform: PLATFORM, amount: num(retry.retry.convertAmount, 0), coin: poolCoin(pool), try: retry.attempt + 1, seconds })}
        </p>,
      );
    }
    if (state !== 'stopped' && !gap) {
      body.push(
        <RealizeActions key="actions" legs={actionLegs} open={actionsOpen} onToggle={() => setActionsOpen(!actionsOpen)} tense={state === 'done' ? 'past' : 'plan'} />,
      );
    }
    return { key: `realize:${pool}:${index}`, label: '', text, sub: walletOf(pool), right: '', state, progress: null, body: <div className="mt-1.5 flex flex-col gap-1.5">{body}</div> };
  });

  const converts = legs.some((leg) => convertsOf(job, leg).length > 0);
  const coin = poolCoin(routeSteps[0]?.from ?? 'HYPERLIQUID');
  const routeRow: StepRow[] = routeSteps.length === 0 ? [] : [{
    key: 'route',
    label: '',
    text: moveTitle(converts, routeState === 'running' ? 'running' : routeState === 'done' ? 'done' : 'plan', routeMoveOf(routeSteps), coin),
    sub: <MovePath {...routePools(routeSteps)} />,
    right: '',
    state: routeState,
    progress: null,
    body: <RouteBody job={job} now={now} state={routeState} />,
  }];

  const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
  const parts = jobCostParts(job);
  const gap = job.status === 'halted' ? gaps[0] : undefined;
  const gapUsd = gap ? usdOf(gap) : null;
  const routeStopped = routeState === 'stopped';
  const plan = pressed?.plan ?? view.plans[job.goal] ?? view.plans.even;
  const rows = barRowsOf(view.buckets, shownKeys(view, routeSteps, plan), targetsOf(view, plan));

  return (
    <>
      {running && <p className="num text-xs text-ink-400">{t('accounts.rebalanceModal.started', { age: fmtAge(Math.max(0, now - job.createdAt)) })}</p>}
      {done && <RebalanceBeforeAfter rows={receiptChanges(job, pressed?.view.buckets ?? view.buckets, livePerps)} mode="now" />}
      {gap && (
        <StopBox
          title={rk('gapBox', { ...gapWords(gap), leg: otherLeg(gap.leg) })}
          lines={[...(gapUsd === null ? [] : [rk('notHedged', { usd: gapUsd })]), ...gapBoxLines(job.haltReason)]}
        />
      )}
      {routeStopped && <StopBox title={stopTitle(job)} lines={haltLine(job.haltReason)} />}
      <div className="flex flex-col gap-3">
        <div className={STEPS_HEAD}>{rk(done ? 'howItRan' : 'howItRuns')}</div>
        <StepList rows={[...realizeRows, ...routeRow]} />
      </div>
      {routeStopped && <BalanceBars caption={t('accounts.rebalanceModal.whereCaption')} rows={rows} scale={scaleOf(rows)} />}
      {job.costUsd !== null && (
        <div className="card flex flex-col gap-1.5 p-3 text-xs">
          <EstimateRow
            label={rk('totalCost')}
            sub={done ? `${t('accounts.rebalanceModal.took')} ${fmtAge(took)}` : null}
            value={fmtUsd(job.costUsd)}
            strong
          />
          {parts && <EstimateRow label={modalFeeLabel()} value={fmtUsd(parts.fee)} />}
          {parts && parts.impact > 0 && <EstimateRow label={<ImpactLabel />} value={fmtUsd(parts.impact)} />}
        </div>
      )}
      {running && <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.waitsLine')}</p>}
      {job.status === 'halted' && (
        <>
          {transfer?.spot === null && <NoSpotReadLine />}
          <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
          <Actions
            {...props}
            note={gap ? rk('abandonNote', { side: sideText(gap.leg.side), size: sizeText(gap.qty), base: gap.leg.base }) : abandonNote(job, transfer)}
          />
        </>
      )}
      {done && <CloseButton onClose={onClose} />}
    </>
  );
}

function RouteBody({ job, now, state }: { job: RebalanceJob; now: number; state: StepState }) {
  if (state !== 'running') return null;
  const round = roundOf(job);
  const rounds = roundCountOf(job);
  const total = jobSeconds(job);
  const started = job.steps.slice(lastRealizeIndex(job) + 1).find((step) => step.startedAt !== null)?.startedAt ?? now;
  const elapsed = Math.max(0, now - started) / 1000;
  const left = Math.max(0, total - elapsed);
  const line =
    job.route === 'loop' && round !== null
      ? rk('spotLoopRound', { round: num(round, 0), rounds: num(rounds, 0), minutes: num(Math.ceil(left / 60), 0) })
      : ROUTE_LABEL[job.route];
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-xs text-ink-300">
      <span className="num">{line}</span>
      {job.inTransit && <span className="num">{rk('spotLoopWay', { amount: num(job.inTransit.qty, 0), coin: job.inTransit.coin })}</span>}
      <ProgressBar ratio={total > 0 ? elapsed / total : 0} tone="running" />
    </div>
  );
}

export function JobChip({ job }: { job: RebalanceJob }) {
  if (job.status === 'running') return <Chip tone="info">{t('common.running')}</Chip>;
  if (job.status === 'halted') return <Chip tone="red">{t('common.stopped')}</Chip>;
  if (isShortDone(job) || job.goal !== 'even' || hasRest(job)) return <Chip>{t('common.done')}</Chip>;
  return <Chip tone="green">{t('accounts.rebalanceModal.balanced')}</Chip>;
}
