import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePositions, useRebalanceCommand, useRebalanceFix } from '../api/queries';
import type { ImUsedRow, RebalanceFixAction, RebalanceJob } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Spinner } from '../components/Spinner';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtAbout, fmtUsd, num, prettyVenue, WALLET_SHORT } from '../lib/fmt';
import { RunView } from '../trade/RunView';
import { markPriceOf, ProgressBar } from './RebalanceBits';
import { poolKey, sideText, sizeText } from './rebalanceCopy';
import { Actions, CloseButton, haltLine, StopBox, type JobViewProps } from './RebalanceJobBits';
import type { RebalanceTab } from './rebalanceOpener';
import { NotHedgedLine } from './RebalancePlanBits';
import { MAX_SLIPPAGE_RATIO } from './SliceTable';

type RunProps = Parameters<typeof RunView>[0];
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
  const gapYu = job.borosGapYu ?? 0;
  const borosGap = delever !== null && (halted || abandoned) && !borosPart && gapYu > 0;
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
  const addedLegs = job.steps.find((step) => step.addBack)?.addBack?.legs ?? [];
  const perpSizes = (delever?.legs ?? []).map((l) => ({
    venue: prettyVenue(l.exchange),
    qty: perpNow + (addedLegs.find((row) => row.symbol === l.symbol)?.filled ?? 0),
  }));
  const [perpA, perpB] = perpSizes;
  const perpsBoros =
    perpA && perpB && perpA.qty !== perpB.qty
      ? sk('perpsSplitBorosNow', { venueA: perpA.venue, a: sizeText(perpA.qty), venueB: perpB.venue, b: sizeText(perpB.qty), coin, boros: sizeText(borosNow) })
      : sk('perpsBorosNow', { perps: sizeText(perpA?.qty ?? perpNow), coin, boros: sizeText(borosNow) });
  const longLeg = delever?.legs.find((l) => l.side === 'LONG');
  const shortLeg = delever?.legs.find((l) => l.side === 'SHORT');
  const title = delever
    ? sk('deleverHeader', { coin, long: prettyVenue(longLeg?.exchange ?? ''), short: prettyVenue(shortLeg?.exchange ?? '') })
    : t('accounts.rebalanceTabs.realize');
  const show = (props: Partial<RunProps>) => (
    <RunView title={title} chip={null} firstLine={null} rows={[]} graph={null} priceBox={null} orders={[]} lines={[]} acts={null} footer={false} {...props} />
  );
  const totalCostRows: RunProps['rows'] =
    realCost === null ? [] : [{ label: sk('totalCostLabel'), value: sk('totalCost', { real: fmtUsd(realCost), est: fmtUsd(estCost) }) }];

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
      return show({
        title: sk('deleverDoneHeader', { pct: pctText(delever.pct) }),
        lines: [
          <Line key="perps">
            {dk('afterPerps', {
              longVenue: prettyVenue(longLeg?.exchange ?? ''), shortVenue: prettyVenue(shortLeg?.exchange ?? ''), a: sizeText(perpBefore), b: sizeText(perpNow), coin,
            })}
          </Line>,
          borosBefore > 0 && <Line key="boros">{dk('afterBoros', { a: sizeText(borosBefore), b: sizeText(borosNow) })}</Line>,
        ].filter(Boolean),
        rows: [
          ...(start !== null && end !== null
            ? [{ label: sk('imLabel', { account: accountText(account) }), value: sk('imDone', { a: pctText(start), b: pctText(end) }) }]
            : []),
          ...totalCostRows,
        ],
        acts: nextOrClose(borrowLeft),
      });
    }
    return show({
      lines: [<Line key="realized" tone="font-semibold text-ink-100">{sk('realized', { amount: num(realized, 0) })}</Line>],
      rows: totalCostRows,
      acts: nextOrClose(true),
    });
  }

  const feeRow = {
    label: t('trade.twap.run.feeSoFar'),
    value: t('trade.twap.run.feeValue', { fee: fmtUsd(job.feeSoFarUsd ?? 0), est: fmtUsd(delever ? (job.estimate?.feeUsd ?? 0) : estCost) }),
  };
  const imAccount = (job.imUsedNow ?? job.imUsedStart)?.[0]?.account;
  const imNow = imOf(job.imUsedNow ?? job.imUsedStart, imAccount);
  const imEnd = imOf(job.imUsedEnd, imAccount);
  const factRows: RunProps['rows'] = delever
    ? [
        { label: sk('perpsLabel', { i: num(index, 0), n: num(count, 0) }), value: sk('perpsLine', { old: sizeText(perpBefore), now: sizeText(perpNow), coin }) },
        ...(borosNow > 0 ? [{ label: sk('borosLabel'), value: sk('borosLine', { amount: sizeText(borosNow), end: sizeText(borosEnd) }) }] : []),
        ...(imNow !== null && imEnd !== null
          ? [{ label: sk('imLabel', { account: accountText(imAccount) }), value: sk('imNowEnd', { a: pctText(imNow), b: pctText(imEnd) }) }]
          : []),
        feeRow,
      ]
    : [
        { label: t('trade.twap.run.slice', { i: num(index, 0), n: num(count, 0) }), value: sk('left', { time: fmtAbout((count - index + 1) * ((job.exec ?? 'maker') === 'maker' && job.maker?.takerAfterSec ? job.maker.takerAfterSec : SLICE_SECONDS[job.exec ?? 'maker'])) }) },
        { label: sk('realizedLabel'), value: sk('realizedOf', { x: num(realized, 0), y: num(job.amount, 0) }) },
        { label: t('trade.twap.run.notHedged'), value: `${sizeText(open)} ${coin} (${usdOf(open)})` },
        feeRow,
      ];
  const factLines = delever ? (
    (() => {
      const leadClose = leg?.qty ?? 0;
      const size = job.slice?.sizeUsd ?? 0;
      const qty = job.slice?.qty ?? (mark !== null && size > 0 ? Math.min(size / mark, leadClose) : leadClose / count);
      const usd = mark !== null ? fmtUsd(qty * mark, 0) : size > 0 && count > 1 ? fmtUsd(size, 0) : '—';
      return <NotHedgedLine text={sk('notHedgedMax', { qty: sizeText(qty), coin, usd })} />;
    })()
  ) : null;
  const progress = <ProgressBar ratio={(index - (running ? 1 : 0)) / count} tone={halted || missed ? 'stopped' : 'running'} />;
  const abandonNote = leg ? sk('abandonNote', { side: sideText(leg.side), qty: sizeText(open), coin }) : '';

  if (running) {
    return show({
      firstLine: (
        <>
          {progress}
          {missed && <StopBox title={sk(followKey.missed, { qty: sizeText(followQty), coin })} lines={haltLine(job.haltReason)} />}
        </>
      ),
      rows: factRows,
      lines: factLines ? [factLines] : [],
      acts: missed ? (
        fixHolds()
      ) : job.pauseRequested ? (
        <p className="num flex items-center gap-2 text-xs text-ink-300">
          <Spinner className="h-3 w-3" />
          {sk('pausing', { i: num(index, 0), n: num(count, 0) })}
        </p>
      ) : (
        <>
          <button type="button" className="btn px-4 py-2 text-sm" disabled={pending} onClick={() => pause.mutate(job.id)}>
            {sk('holdPause')}
          </button>
          {pause.error instanceof Error && <Line tone="text-guava">{localizeServerText(pause.error.message)}</Line>}
        </>
      ),
    });
  }

  const closeBorosHold = (
    <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={pending} onConfirm={() => press('boros-retry')}>
      <span className="num">{dk('holdCloseBoros', { amount: sizeText(gapYu) })}</span>
    </HoldToConfirmButton>
  );

  const abandonBlock = (
    <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
      {open > 0 && <span className="num text-xs text-ink-400">{abandonNote}</span>}
      <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={onAbandon}>
        {sk('holdAbandon')}
      </HoldToConfirmButton>
    </div>
  );

  if (borosPart) {
    const left = job.borosLeftYu ?? 0;
    const added = job.steps.find((step) => step.addBack)?.addBack ?? null;
    const addBackRest = added ? Math.max(0, ...added.legs.map((l) => added.qty - l.filled)) : 0;
    const addBackOpen = added !== null && addBackRest > 0;
    const addBack = addBackOpen ? addBackRest : borosTarget > 0 ? (closedQty * left) / borosTarget : 0;
    const legRests = added
      ? (delever?.legs ?? []).map((l) => ({
          venue: prettyVenue(l.exchange),
          rest: Math.max(0, added.qty - (added.legs.find((row) => row.symbol === l.symbol)?.filled ?? 0)),
        }))
      : [];
    const unevenRest = addBackOpen && legRests.some((l) => l.rest !== addBackRest);
    const addBackLabel = unevenRest
      ? sk('holdAddBackOn', { rest: legRests.filter((l) => l.rest > 0).map((l) => `${l.venue} ${sizeText(l.rest)} ${coin}`).join(', ') })
      : sk('holdAddBack', { qty: sizeText(addBack), coin });
    return show({
      firstLine: (
        <StopBox
          title={sk('borosNotHedged', { amount: sizeText(left) })}
          lines={[perpsBoros, sk('borosFilled', { filled: sizeText(Math.max(0, borosTarget - left)), target: sizeText(borosTarget) }), ...haltLine(job.haltReason)]}
        />
      ),
      acts: (
        <>
        <div className="flex flex-col gap-2">
          {added === null && (
            <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={pending} onConfirm={() => press('boros-retry')}>
              <span className="num">{sk('holdRetryBoros', { amount: sizeText(left) })}</span>
            </HoldToConfirmButton>
          )}
          <HoldToConfirmButton tone={addBackOpen ? 'cyan' : 'outline'} holdMs={holdMs} disabled={pending} onConfirm={() => press('add-back')}>
            <span className="num">{addBackLabel}</span>
          </HoldToConfirmButton>
          {fixError}
        </div>
        {abandonBlock}
        </>
      ),
    });
  }

  if (open > 0 && halted && !paused && !margin) {
    return show({
      firstLine: <StopBox title={sk('notHedged', { qty: sizeText(open), coin })} lines={haltLine(job.haltReason)} />,
      acts: (
        <>
          {fixHolds()}
          {borosGap && (
            <>
              <StopBox title={dk('borosNoPerp', { amount: sizeText(gapYu) })} lines={[perpsBoros]} />
              {closeBorosHold}
            </>
          )}
          {abandonBlock}
        </>
      ),
    });
  }

  const pausedLine = paused ? sliceStateLabel(job) : null;
  const status = borosGap ? (
    <>
      {margin && open > 0 && <StopBox title={sk('notHedged', { qty: sizeText(open), coin })} lines={haltLine(job.haltReason)} />}
      <StopBox
        title={dk('borosNoPerp', { amount: sizeText(gapYu) })}
        lines={[...(pausedLine ? [pausedLine] : margin && open > 0 ? [] : haltLine(job.haltReason)), perpsBoros]}
      />
    </>
  ) : margin ? (
    <StopBox title={open > 0 ? sk('notHedged', { qty: sizeText(open), coin }) : localizeServerText(job.haltReason ?? '')} lines={open > 0 ? haltLine(job.haltReason) : []} />
  ) : pausedLine ? (
    <Line tone="font-semibold text-ink-100">{pausedLine}</Line>
  ) : (
    <StopBox title={job.haltReason ? localizeServerText(job.haltReason) : t('common.stopped')} lines={[]} />
  );
  return show({
    firstLine: (
      <>
        {progress}
        {status}
      </>
    ),
    rows: factRows,
    lines: factLines ? [factLines] : [],
    acts: (
      <>
        {borosGap && (
          <>
            {closeBorosHold}
            {fixError}
          </>
        )}
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
    ),
  });
}

export const isSliceJob = (job: RebalanceJob): boolean =>
  job.kind === 'delever' || job.steps.some((step) => step.name === 'Slices' || step.name === 'Close Boros');
