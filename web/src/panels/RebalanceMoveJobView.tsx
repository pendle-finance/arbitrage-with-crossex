import { useState } from 'react';
import { t } from '../i18n';
import { fmtAbout, fmtAge, fmtUsd, num } from '../lib/fmt';
import { ProgressBar } from './RebalanceBits';
import { BalanceBars, scaleOf, type BarRow } from './RebalanceBars';
import { CARD_LABEL, gateSpot, HOVER } from './rebalanceCopy';
import { barRowsOf, Facts, receivingBorrow, receivingHeld, roundCountOf, roundOf, ROUTE_LABEL, shownKeys, SpotLines, targetsOf, Term } from './RebalanceHovers';
import { abandonNote, Actions, CloseButton, haltLine, StopBox, stopTitle, type JobViewProps } from './RebalanceJobBits';
import { landedOf } from './rebalanceJobSteps';
import { StepsFold, stepsHoverOf } from './RebalancePlanBits';
import { jobRows, jobSeconds } from './rebalanceStepRows';
import { NoSpotReadLine } from './TransferBits';

export function MoveJobView(props: JobViewProps) {
  const { job, view, now, transfer, onTransfer, onClose } = props;
  const [stepsOpen, setStepsOpen] = useState(false);
  const plan = view.plans[job.goal] ?? view.plans.even;
  const keys = shownKeys(view, job.steps, plan);
  const nowRows = barRowsOf(view.buckets, keys, targetsOf(view, plan));
  const borrow = receivingBorrow(view.buckets, job.steps);
  const held = receivingHeld(view.buckets, job.steps);
  const rounds = roundCountOf(job);
  const fold = (
    <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHoverOf(rounds, held)} rows={jobRows(job, now, borrow)} />
  );
  const spotRow = (label: string, text: string, qty: number): BarRow => ({
    key: 'spot', label: <Term label={label} text={text} />, name: label, cash: qty, upnl: 0, target: null, tone: 'spot',
  });
  if (job.status === 'done') {
    const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
    return (
      <>
        <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.finishedLead')}</p>
        <Facts
          items={[
            { key: 'goal', label: t('accounts.rebalanceModal.for'), value: CARD_LABEL[job.goal] },
            { key: 'route', label: t('accounts.rebalanceModal.route'), value: ROUTE_LABEL[job.route] },
            { key: 'moved', label: t('accounts.rebalanceModal.moved'), value: fmtUsd(landedOf(job)) },
            { key: 'took', label: t('accounts.rebalanceModal.took'), value: fmtAge(took) },
            ...(job.costUsd === null ? [] : [{ key: 'cost', label: t('accounts.rebalanceModal.cost'), value: fmtUsd(job.costUsd) }]),
          ]}
        />
        <BalanceBars caption={<Term label={t('accounts.rebalanceModal.now')} text={HOVER.now} />} rows={nowRows} scale={scaleOf(nowRows)} />
        {fold}
        <CloseButton onClose={onClose} />
      </>
    );
  }
  const running = job.status === 'running';
  const moving = running || job.inTransit?.at === 'MOVING';
  const rows = job.inTransit
    ? [...nowRows, spotRow(moving ? t('accounts.rebalanceModal.onTheWay') : gateSpot(), moving ? HOVER.onTheWay : HOVER.gateSpot, job.inTransit.qty)]
    : nowRows;
  const round = roundOf(job);
  const total = jobSeconds(job);
  const elapsed = Math.max(0, (running ? now : job.updatedAt) - job.createdAt);
  if (running) {
    const left = Math.max(0, total - elapsed / 1000);
    return (
      <>
        <p className="num text-xs text-ink-400">{t('accounts.rebalanceModal.started', { age: fmtAge(elapsed) })}</p>
        <Facts
          items={[
            { key: 'goal', label: t('accounts.rebalanceModal.for'), value: CARD_LABEL[job.goal] },
            { key: 'route', label: t('accounts.rebalanceModal.route'), value: ROUTE_LABEL[job.route] },
            ...(round === null
              ? []
              : [{ key: 'round', label: t('accounts.rebalanceModal.round'), value: t('accounts.rebalanceModal.roundOf', { round: num(round, 0), rounds: num(rounds, 0) }) }]),
            {
              key: 'time',
              label: total > 0 ? t('accounts.rebalanceModal.timeLeft') : t('accounts.rebalanceModal.time'),
              value: total <= 0 ? fmtAge(elapsed) : left > 0 ? fmtAbout(left) : t('accounts.rebalanceModal.longerThanUsual'),
              sub: total > 0 ? [t('accounts.rebalanceModal.passed', { age: fmtAge(elapsed) })] : [],
            },
          ]}
        />
        <ProgressBar ratio={total > 0 ? elapsed / 1000 / total : 0} tone="running" />
        <BalanceBars caption={<Term label={t('accounts.rebalanceModal.now')} text={HOVER.now} />} rows={rows} scale={scaleOf(rows)} />
        <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.waitsLine')}</p>
        {fold}
      </>
    );
  }
  return (
    <>
      <StopBox title={stopTitle(job)} lines={haltLine(job.haltReason)} />
      <BalanceBars caption={t('accounts.rebalanceModal.whereCaption')} rows={rows} scale={scaleOf(rows)} />
      {transfer?.spot === null && <NoSpotReadLine />}
      <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
      <Actions {...props} note={abandonNote(job, transfer)} />
    </>
  );
}
