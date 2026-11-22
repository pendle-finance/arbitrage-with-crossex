import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePositions, useRebalance, useTransfer } from '../api/queries';
import type { FullPlan, RebalanceJob, RebalanceView } from '../api/types';
import { Chip } from '../components/Chip';
import { FreshnessButton } from '../components/FreshnessIndicator';
import { t } from '../i18n';
import { borrowingBuckets } from '../lib/borrow';
import { fmtAbout, fmtUsd, num } from '../lib/fmt';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { VerdictAlert } from './RebalanceBits';
import { jobSeconds } from './rebalanceStepRows';
import { abandonedGapText, gapVerdict, hasLeftGap, openGapOf } from './rebalanceCardGap';
import { CARD_LABEL, realizeBlockedReason, verdictRateUnknown, waitsForDeal, waitsForTransfer } from './rebalanceCopy';
import { borrowFacts, Facts, hasUnknownRate, HYPERLIQUID_INTEREST_FREE_USDC, isFreeBorrow, WORTH_IT_DAYS, type VerdictTone } from './RebalanceHovers';
import { RebalanceInfo, roundCountOf, roundOf } from './RebalanceHovers';
import { isCloseSent, lastRealizeIndex } from './rebalanceJobSteps';
import { crossexImFull } from './rebalanceImStop';
import { useRebalanceOpener } from './rebalanceOpener';

const timeLeft = (seconds: number): string =>
  fmtAbout(seconds)
    .replace(/(\d+) h\b/, (_all, n: string) => t('accounts.rebalanceSection.hours', { count: Number(n), n }))
    .replace(/(\d+(?:\.\d+)?) (?:min|m)\b/, (_all, n: string) => t('accounts.rebalanceSection.minutes', { count: Number(n), n }));

function jobVerdict(job: RebalanceJob, now: number): string {
  const round = roundOf(job);
  const what = CARD_LABEL[job.goal];
  if (job.status === 'halted') {
    if (job.realize?.legs.length && job.steps[job.stepIndex]?.name === 'Close') {
      const sent = job.realize.legs.some((leg) => isCloseSent(job, leg));
      return t(sent ? 'accounts.rebalanceRealize.closeUnconfirmedTitle' : 'accounts.rebalanceRealize.stoppedBeforeClose');
    }
    return round === null
      ? t('accounts.rebalanceSection.haltedAtConvert', { what })
      : t('accounts.rebalanceSection.haltedInRound', { what, round: num(round, 0) });
  }
  const total = jobSeconds(job);
  const left = Math.max(0, total - Math.max(0, now - job.createdAt) / 1000);
  if (total <= 0) return t('accounts.rebalanceSection.running', { what });
  return left > 0 ? t('accounts.rebalanceSection.runningLeft', { what, left: timeLeft(left) }) : t('accounts.rebalanceSection.runningLong', { what });
}

function jobButton(job: RebalanceJob): string {
  if (job.status === 'halted') return job.realize && openGapOf(job) ? t('accounts.borrowCard.reduce') : t('accounts.rebalanceSection.stoppedOpen');
  if (job.realize?.legs.length) {
    const last = lastRealizeIndex(job);
    if (last === job.steps.length - 1) return t('common.running');
    return t('accounts.rebalanceRealize.cardStep', { step: job.stepIndex <= last ? 1 : 2, steps: 2 });
  }
  const round = roundOf(job);
  return round === null
    ? t('accounts.rebalanceSection.runningConvert')
    : t('accounts.rebalanceSection.runningRound', { round: num(round, 0), rounds: num(roundCountOf(job), 0) });
}

type CardVerdict = { tone: VerdictTone | 'recommend'; text: ReactNode; sub: string | null; primary: boolean };

function planLine(plan: FullPlan): string {
  const values = { cost: fmtUsd(plan.costUsd), interest: fmtUsd(plan.interestPerMonthUsd) };
  return plan.needsRealize ? t('accounts.borrowCard.lineRealizeThenMove', values) : t('accounts.borrowCard.lineMove', values);
}

function borrowVerdict(view: RebalanceView, onDelever: () => void): CardVerdict | null {
  const plan = view.fullPlan ?? null;
  if (hasUnknownRate(view.buckets)) return { tone: 'warn', text: verdictRateUnknown(), sub: null, primary: false };
  if (plan?.refused) {
    const imFull = plan.refused.reason === 'no-margin' ? (crossexImFull(view.imUsed)?.pct ?? null) : null;
    const reason = imFull === null ? realizeBlockedReason(plan.refused) : t('accounts.borrowCard.imUsed', { pct: num(imFull * 100, 1) });
    const blocked = t('accounts.borrowCard.blocked', { reason });
    if (imFull === null) return { tone: 'warn', text: blocked, sub: null, primary: false };
    const text = (
      <>
        <span>{blocked}</span>{' '}
        <button type="button" className="btn-link" onClick={onDelever}>
          {t('accounts.borrowCard.deleverLink')}
        </button>
      </>
    );
    return { tone: 'warn', text, sub: null, primary: false };
  }
  if (!plan?.clearsBorrow || plan.days === null) return null;
  const days = num(plan.days, 0);
  if (plan.days <= WORTH_IT_DAYS) {
    return { tone: 'recommend', text: t('accounts.borrowCard.recommended', { days }), sub: planLine(plan), primary: true };
  }
  return {
    tone: 'warn',
    text: t('accounts.borrowCard.notRecommended', { days, limit: num(WORTH_IT_DAYS, 0) }),
    sub: t('accounts.borrowCard.needs', { line: planLine(plan) }),
    primary: false,
  };
}

export function RebalanceSection({
  actions,
}: {
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const query = useRebalance();
  const transfer = useTransfer().data;
  const now = useNow();
  const openRebalance = useRebalanceOpener();
  const [openedWith] = useState(query.dataUpdatedAt);
  const loadError = useSettledError(query.status, query.error);
  const view = query.data;
  const openJob = view?.job && view.job.status !== 'done' ? view.job : null;
  const positions = usePositions((openJob !== null && openGapOf(openJob) !== null) || (view?.job ? hasLeftGap(view.job) : false)).data?.positions;
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

  if (!view) {
    if (loadError) {
      header = title;
      line = (
        <p role="alert" className="text-xs text-rose-300">
          {t('accounts.rebalanceSection.loadFailed', { message: loadError.message })}
        </p>
      );
      main = (
        <button type="button" className="btn-ghost-xs leading-4" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </button>
      );
    }
  } else {
    const { buckets } = view;
    const job = view.job && (view.job.status === 'running' || view.job.status === 'halted') ? view.job : null;
    const showAge = loadError !== null || (openedWith > 0 && query.dataUpdatedAt === openedWith);
    const hasBorrow = borrowingBuckets(buckets).length > 0;
    const moving = transfer?.transfer?.status === 'moving';
    const dealWorking = transfer?.lock === 'deal';

    let chip: ReactNode = null;
    if (job?.status === 'running') chip = <Chip tone="info">{t('common.running')}</Chip>;
    if (job?.status === 'halted') chip = <Chip tone="red">{t('common.stopped')}</Chip>;

    const gap = job ? gapVerdict(job, positions) : null;
    let verdict: CardVerdict | null = null;
    let muted: string | null = null;
    if (gap) verdict = { tone: gap.tone, text: gap.text, sub: gap.sub, primary: false };
    else if (job) verdict = { tone: 'info', text: jobVerdict(job, now), sub: null, primary: false };
    else if (!hasBorrow) muted = t('accounts.borrowCard.none');
    else if (isFreeBorrow(buckets)) muted = t('accounts.borrowCard.free', { amount: num(HYPERLIQUID_INTEREST_FREE_USDC, 0) });
    else verdict = borrowVerdict(view, () => openRebalance({ tab: 'delever' }));
    const leftOpen = view.job ? abandonedGapText(view.job, positions) : null;

    let label: ReactNode = t('accounts.borrowCard.reduce');
    if (job) label = jobButton(job);
    else if (moving) label = waitsForTransfer();
    else if (dealWorking) label = waitsForDeal();
    const disabled = !job && (moving || dealWorking);
    const primary = !job && verdict?.primary === true;

    header = (
      <div className="flex items-center gap-3">
        {title}
        <div className="ml-auto flex items-center gap-2">
          {showAge && (
            <FreshnessButton
              dense
              dataUpdatedAt={query.dataUpdatedAt}
              staleError={loadError !== null}
              title={t('accounts.rebalanceSection.readAgain')}
              onRefetch={() => void query.refetch()}
            />
          )}
          {chip}
        </div>
      </div>
    );
    facts = <Facts items={borrowFacts(buckets)} />;
    if (verdict !== null) line = <VerdictAlert tone={verdict.tone} text={verdict.text} sub={verdict.sub} />;
    if (muted !== null) line = <p className="text-xs text-ink-400">{muted}</p>;
    if (leftOpen !== null) {
      line = (
        <>
          {line}
          <p className="num text-xs text-guava">{leftOpen}</p>
        </>
      );
    }
    main = (
      <button type="button" className={primary ? 'btn btn-primary num' : 'btn num'} disabled={disabled} onClick={() => openRebalance()}>
        {label}
      </button>
    );
  }

  return (
    <section aria-label={t('accounts.borrowCard.title')} className="flex flex-col gap-3 border-t border-ink-800 pt-4">
      {header}
      {facts}
      {line}
      <div className="flex flex-wrap items-center gap-3">
        {main}
        {actions}
      </div>
    </section>
  );
}
