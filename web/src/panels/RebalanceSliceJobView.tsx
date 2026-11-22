import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePositions, useRebalanceCommand, useRebalanceFix } from '../api/queries';
import type { ImUsedRow, RebalanceFixAction, RebalanceJob } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Spinner } from '../components/Spinner';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtAbout, fmtUsd, num, prettyVenue, WALLET_SHORT } from '../lib/fmt';
import { markPriceOf, ProgressBar } from './RebalanceBits';
import { poolKey, sideText, sizeText } from './rebalanceCopy';
import { Actions, CloseButton, haltLine, StopBox, type JobViewProps } from './RebalanceJobBits';
import type { RebalanceTab } from './rebalanceOpener';
import { NotHedgedLine } from './RebalancePlanBits';
import { MAX_SLIPPAGE_RATIO } from './SliceTable';

const SLICE_SECONDS = { maker: 300, market: 2 } as const;
const FOLLOW_MISSES_RED = 3;

const sk = (key: string, values?: Record<string, string | number>): string => t(`accounts.sliceRun.${key}` as 'accounts.sliceRun.done', values);
const dk = (key: string, values?: Record<string, string | number>): string => t(`accounts.deleverTab.${key}` as 'accounts.deleverTab.pair', values);
export function sliceStateLabel(job: RebalanceJob): string {
  const slice = { i: num(job.slice?.index ?? 1, 0), n: num(Math.max(1, job.slice?.count ?? 1), 0) };
  if (job.status === 'halted' && job.paused === true) return sk('paused', slice);
  return job.pauseRequested ? sk('pausing', slice) : sk('slice', slice);
}
const pctText = (ratio: number): string => num(ratio * 100, 1);

function Line({ children, tone = 'text-ink-200' }: { children: ReactNode; tone?: string }) {
  return <p className={`num text-xs ${tone}`}>{children}</p>;
}

function imOf(rows: ImUsedRow[] | null | undefined, account: string | undefined): number | null {
  const row = rows?.find((r) => r.account === account) ?? rows?.[0];
  return row ? row.pct : null;
}

const accountText = (account: ImUsedRow['account'] | undefined): string => (account ? (WALLET_SHORT[poolKey(account)] ?? account) : '');

export function SliceJobView(props: JobViewProps & { onTab?: (tab: RebalanceTab) => void }) {
  const { job, view, holdMs, busy, onAbandon, onClose, onTab } = props;
  const pause = useRebalanceCommand('pause');
  const fix = useRebalanceFix();
  const positions = usePositions().data?.positions ?? [];
  const delever = job.kind === 'delever' ? (job.delever ?? null) : null;
  const legs = job.realize?.legs ?? [];
  const sliceSteps = job.steps.filter((step) => step.name === 'Slices');
  const current = sliceSteps.find((step) => step.status !== 'done') ?? sliceSteps.at(-1);
  const leg = legs.find((l) => l.symbol === current?.perp?.symbol) ?? legs[0];
  const coin = leg?.base ?? delever?.legs[0]?.base ?? '';
  const followLeg = delever
    ? (delever.legs.find((l) => l.exchange === job.follow?.exchange && l.symbol === job.follow?.symbol) ?? delever.legs.find((l) => l.exchange !== leg?.exchange))
    : leg;
  const followKey = delever
    ? { missed: 'missedClose', market: 'holdCloseMarket', limit: 'holdCloseLimit' }
    : { missed: 'missed', market: 'holdReopenMarket', limit: 'holdReopenLimit' };
  const index = job.slice?.index ?? 1;
  const count = Math.max(1, job.slice?.count ?? 1);
  const mark = followLeg ? markPriceOf(positions, job.follow?.symbol ?? followLeg.symbol) : null;
  const usdOf = (qty: number): string => (mark === null ? '—' : fmtUsd(qty * mark, 0));
  const open = job.notHedgedQty ?? 0;
  const followQty = job.follow?.qty ?? open;
  const slicesDone = sliceSteps.length > 0 && sliceSteps.every((step) => step.status === 'done');
  const pending = busy || fix.isPending || pause.isPending;
  const fixError = fix.error instanceof Error ? <Line tone="text-guava">{localizeServerText(fix.error.message)}</Line> : null;
  const press = (action: RebalanceFixAction) => fix.mutate({ id: job.id, action });

  const halted = job.status === 'halted';
  const abandoned = job.status === 'abandoned';
  const paused = halted && job.paused === true;
  const running = job.status === 'running';
  const missed = running && (job.followMisses ?? 0) >= FOLLOW_MISSES_RED && followQty > 0;
  const borosPart = delever !== null && halted && !paused && slicesDone && (job.borosLeftYu ?? 0) > 0;
  const borosGap = delever !== null && (halted || abandoned) && !borosPart && open === 0 && (job.borosGapYu ?? 0) > 0;
  const margin = halted && !paused && job.haltKind === 'margin';

  const closedQty = leg?.filledQty ?? 0;
  const perpBefore = delever?.legs.find((l) => l.symbol === leg?.symbol)?.before ?? delever?.legs[0]?.before ?? 0;
  const perpNow = Math.max(0, perpBefore - closedQty);
  const borosNow = (delever?.boros ?? []).reduce((sum, row) => sum + row.before - row.closed, 0);
  const borosBefore = (delever?.boros ?? []).reduce((sum, row) => sum + row.before, 0);
  const borosTarget = (delever?.boros ?? []).reduce((sum, row) => sum + row.before - row.after, 0);
  const borosEnd = (delever?.boros ?? []).reduce((sum, row) => sum + row.after, 0);
  const realCost = job.totalCostUsd ?? null;
  const estCost = job.estimate?.totalUsd ?? job.costUsd ?? 0;
  const realized = legs.reduce((sum, l) => sum + l.realizedUsd, 0) - (realCost ?? job.feeSoFarUsd ?? 0);
  const perpsBoros = sk('perpsBorosNow', { perps: sizeText(perpNow), coin, boros: sizeText(borosNow) });
  const longLeg = delever?.legs.find((l) => l.side === 'LONG');
  const shortLeg = delever?.legs.find((l) => l.side === 'SHORT');
  const header = (text: string) => <p className="num text-sm font-semibold text-ink-100">{text}</p>;
  const deleverHeader = delever
    ? header(sk('deleverHeader', { coin, long: prettyVenue(longLeg?.exchange ?? ''), short: prettyVenue(shortLeg?.exchange ?? '') }))
    : null;
  const totalCostLine = (tone?: string) =>
    realCost === null ? null : <Line tone={tone}>{sk('totalCost', { real: fmtUsd(realCost), est: fmtUsd(estCost) })}</Line>;

  const fixHolds = () => {
    const fallback = delever ? (followLeg?.side === 'LONG' ? 'SELL' : 'BUY') : leg?.side === 'SHORT' ? 'SELL' : 'BUY';
    const side = job.follow?.side ?? fallback;
    const limit = mark === null ? null : mark * (side === 'BUY' ? 1 + MAX_SLIPPAGE_RATIO : 1 - MAX_SLIPPAGE_RATIO);
    const venue = prettyVenue(job.follow?.exchange ?? followLeg?.exchange ?? '');
    return (
      <div className="flex flex-col gap-2">
        <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={pending} onConfirm={() => press('market')}>
          <span className="num">{sk(followKey.market, { venue, side: followLeg ? t(followLeg.side === 'LONG' ? 'common.long' : 'common.short') : '', qty: sizeText(followQty), coin })}</span>
        </HoldToConfirmButton>
        {limit !== null && (
          <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={() => press('limit')}>
            <span className="num">{sk(followKey.limit, { price: fmtUsd(limit) })}</span>
          </HoldToConfirmButton>
        )}
        {fixError}
      </div>
    );
  };

  const nextOrClose = (borrowLeft: boolean) =>
    borrowLeft ? (
      <div className="border-t border-ink-800 pt-3">
        <button type="button" className="btn-primary gap-1.5" onClick={() => onTab?.('move')}>
          {sk('next')}
          <ArrowRight size={14} aria-hidden />
        </button>
      </div>
    ) : (
      <CloseButton onClose={onClose} />
    );

  if (job.status === 'done') {
    const borrowLeft = view.buckets.some((bucket) => bucket.borrow > 0);
    if (delever) {
      const account = job.imUsedStart?.[0]?.account;
      const start = imOf(job.imUsedStart, account);
      const end = imOf(job.imUsedEnd, account);
      return (
        <>
          {header(sk('deleverDoneHeader', { pct: pctText(delever.pct) }))}
          <div className="card flex flex-col gap-1.5 p-3">
            <Line>
              {dk('afterPerps', {
                longVenue: prettyVenue(longLeg?.exchange ?? ''), shortVenue: prettyVenue(shortLeg?.exchange ?? ''), a: sizeText(perpBefore), b: sizeText(perpNow), coin,
              })}
            </Line>
            {borosBefore > 0 && <Line>{dk('afterBoros', { a: sizeText(borosBefore), b: sizeText(borosNow) })}</Line>}
            {start !== null && end !== null && <Line>{sk('imDone', { account: accountText(account), a: pctText(start), b: pctText(end) })}</Line>}
            {totalCostLine('font-semibold text-ink-100')}
          </div>
          {nextOrClose(borrowLeft)}
        </>
      );
    }
    return (
      <>
        <div className="card flex flex-col gap-1.5 p-3">
          <Line tone="font-semibold text-ink-100">{sk('realized', { amount: num(realized, 0) })}</Line>
          {totalCostLine()}
          <div className="flex justify-between gap-4 text-xs">
            <span className="text-ink-400">{sk('pairPnl')}</span>
            <span className="text-ink-200">{sk('pairPnlValue')}</span>
          </div>
        </div>
        {nextOrClose(true)}
      </>
    );
  }

  const facts = delever ? (
    <>
      <Line>{sk('perpsLine', { i: num(index, 0), n: num(count, 0), old: sizeText(perpBefore), now: sizeText(perpNow), coin })}</Line>
      {borosNow > 0 && <Line>{sk('borosLine', { amount: sizeText(borosNow), end: sizeText(borosEnd) })}</Line>}
      {(() => {
        const leadClose = leg?.qty ?? 0;
        const size = job.slice?.sizeUsd ?? 0;
        const qty = job.slice?.qty ?? (mark !== null && size > 0 ? Math.min(size / mark, leadClose) : leadClose / count);
        const usd = mark !== null ? fmtUsd(qty * mark, 0) : fmtUsd(size, 0);
        return <NotHedgedLine text={sk('notHedgedMax', { qty: sizeText(qty), coin, usd })} />;
      })()}
      {(() => {
        const account = (job.imUsedNow ?? job.imUsedStart)?.[0]?.account;
        const now = imOf(job.imUsedNow ?? job.imUsedStart, account);
        const end = imOf(job.imUsedEnd, account);
        return now !== null && end !== null ? <Line>{sk('imNowEnd', { account: accountText(account), a: pctText(now), b: pctText(end) })}</Line> : null;
      })()}
      <Line>{sk('feeEst', { fee: fmtUsd(job.feeSoFarUsd ?? 0), est: fmtUsd(job.estimate?.feeUsd ?? 0) })}</Line>
    </>
  ) : (
    <>
      <div className="flex justify-between gap-4">
        <Line tone="font-semibold text-ink-100">{sk('slice', { i: num(index, 0), n: num(count, 0) })}</Line>
        <Line tone="text-ink-300">{sk('left', { time: fmtAbout((count - index + 1) * SLICE_SECONDS[job.exec ?? 'maker']) })}</Line>
      </div>
      <Line>{sk('realizedOf', { x: num(realized, 0), y: num(job.amount, 0) })}</Line>
      <Line>{sk('notHedgedNow', { qty: sizeText(open), coin, usd: usdOf(open) })}</Line>
      <Line>{sk('feeSoFar', { fee: fmtUsd(job.feeSoFarUsd ?? 0), est: fmtUsd(estCost) })}</Line>
    </>
  );
  const progress = <ProgressBar ratio={(index - (running ? 1 : 0)) / count} tone={halted || missed ? 'stopped' : 'running'} />;
  const abandonNote = leg ? sk('abandonNote', { side: sideText(leg.side), qty: sizeText(open), coin }) : '';

  if (running) {
    return (
      <>
        {deleverHeader}
        {progress}
        {missed && (
          <>
            <StopBox title={sk(followKey.missed, { qty: sizeText(followQty), coin })} lines={haltLine(job.haltReason)} />
            {fixHolds()}
          </>
        )}
        <div className="card flex flex-col gap-1.5 p-3">{facts}</div>
        {job.pauseRequested ? (
          <p className="num flex items-center gap-2 text-xs text-ink-300">
            <Spinner className="h-3 w-3" />
            {sk('pausing', { i: num(index, 0), n: num(count, 0) })}
          </p>
        ) : (
          !missed && (
            <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={() => pause.mutate(job.id)}>
              {sk('holdPause')}
            </HoldToConfirmButton>
          )
        )}
      </>
    );
  }

  if (borosPart) {
    const left = job.borosLeftYu ?? 0;
    const addBack = borosTarget > 0 ? (closedQty * left) / borosTarget : 0;
    return (
      <>
        {deleverHeader}
        <StopBox
          title={sk('borosNotHedged', { amount: sizeText(left) })}
          lines={[perpsBoros, sk('borosFilled', { filled: sizeText(Math.max(0, borosTarget - left)), target: sizeText(borosTarget) }), ...haltLine(job.haltReason)]}
        />
        <div className="flex flex-col gap-2">
          <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={pending} onConfirm={() => press('boros-retry')}>
            <span className="num">{sk('holdRetryBoros', { amount: sizeText(left) })}</span>
          </HoldToConfirmButton>
          <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={() => press('add-back')}>
            <span className="num">{sk('holdAddBack', { qty: sizeText(addBack), coin })}</span>
          </HoldToConfirmButton>
          {fixError}
        </div>
      </>
    );
  }

  if (open > 0 && !paused && !margin) {
    return (
      <>
        {deleverHeader}
        <StopBox title={sk('notHedged', { qty: sizeText(open), coin })} lines={haltLine(job.haltReason)} />
        {fixHolds()}
        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <span className="num text-xs text-ink-400">{abandonNote}</span>
          <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={onAbandon}>
            {sk('holdAbandon')}
          </HoldToConfirmButton>
        </div>
      </>
    );
  }

  const pausedLine = paused ? sliceStateLabel(job) : null;
  const gapYu = job.borosGapYu ?? 0;
  return (
    <>
      {deleverHeader}
      {progress}
      {borosGap ? (
        <>
          <StopBox title={dk('borosNoPerp', { amount: sizeText(gapYu) })} lines={[...(pausedLine ? [pausedLine] : haltLine(job.haltReason)), perpsBoros]} />
          <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={pending} onConfirm={() => press('boros-retry')}>
            <span className="num">{dk('holdCloseBoros', { amount: sizeText(gapYu) })}</span>
          </HoldToConfirmButton>
          {fixError}
        </>
      ) : margin ? (
        <StopBox title={open > 0 ? sk('notHedged', { qty: sizeText(open), coin }) : localizeServerText(job.haltReason ?? '')} lines={open > 0 ? haltLine(job.haltReason) : []} />
      ) : pausedLine ? (
        <Line tone="font-semibold text-ink-100">{pausedLine}</Line>
      ) : (
        <StopBox title={job.haltReason ? localizeServerText(job.haltReason) : t('common.stopped')} lines={[]} />
      )}
      <div className="card flex flex-col gap-1.5 p-3">{facts}</div>
      {abandoned ? (
        <CloseButton onClose={onClose} />
      ) : (
        <Actions
          {...props}
          note={open > 0 ? abandonNote : ''}
          resumeLabel={paused ? sk('resume') : undefined}
          abandonLabel={paused ? sk('abandon') : undefined}
          quietResume={borosGap}
        />
      )}
    </>
  );
}

export const isSliceJob = (job: RebalanceJob): boolean =>
  job.kind === 'delever' || job.steps.some((step) => step.name === 'Slices' || step.name === 'Close Boros');
