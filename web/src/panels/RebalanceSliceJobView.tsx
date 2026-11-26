import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePositions, useRebalanceCommand, useRebalanceFix } from '../api/queries';
import type { ImUsedRow, RebalanceFixAction, RebalanceJob } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { ResultBox } from '../components/ResultBox';
import { Spinner } from '../components/Spinner';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtAbout, fmtUsd, num, prettyVenue, WALLET_SHORT } from '../lib/fmt';
import { RunView } from '../trade/RunView';
import { SliceGraph, SlicePriceBox } from '../trade/RunViewBits';
import { spanText } from '../lib/span';
import { markPriceOf, ProgressBar } from './RebalanceBits';
import { poolCoin, poolKey, sideText, sizeText } from './rebalanceCopy';
import { Actions, haltLine, StopBox, type JobViewProps } from './RebalanceJobBits';
import type { RebalanceTab } from './rebalanceOpener';
import { NotHedgedLine } from './RebalancePlanBits';

type RunProps = Parameters<typeof RunView>[0];
const SLICE_SECONDS = { maker: 300, market: 2 } as const;
const MAX_SLIPPAGE_RATIO = 0.0025;
const FOLLOW_MISSES_RED = 3;

const sk = (key: string, values?: Record<string, string | number>): string => t(`accounts.sliceRun.${key}` as 'accounts.sliceRun.done', values);
const dk = (key: string, values?: Record<string, string | number>): string => t(`accounts.deleverTab.${key}` as 'accounts.deleverTab.pair', values);
function sliceStateLabel(job: RebalanceJob): string {
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
  const { job, view, holdMs, busy, onAbandon, onTab } = props;
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
  const cashCoin = poolCoin(legs[0]?.pool ?? 'HYPERLIQUID');
  const realized = legs.reduce((sum, l) => sum + l.realizedUsd, 0) - (realCost ?? job.feeSoFarUsd ?? 0);
  const addedLegs = job.steps.find((step) => step.addBack)?.addBack?.legs ?? [];
  const perpSizes = (delever?.legs ?? []).map((l) => ({
    venue: prettyVenue(l.exchange),
    qty: perpNow + (addedLegs.find((row) => row.symbol === l.symbol)?.filled ?? 0),
  }));
  const [perpA, perpB] = perpSizes;
  const perpsRow = {
    label: sk('perpsRow'),
    value:
      perpA && perpB && perpA.qty !== perpB.qty
        ? sk('perpsSplit', { venueA: perpA.venue, a: sizeText(perpA.qty), venueB: perpB.venue, b: sizeText(perpB.qty), coin })
        : sk('perpsEach', { qty: sizeText(perpA?.qty ?? perpNow), coin }),
  };
  const borosRow = (value: string) => ({ label: sk('borosLabel'), value });
  const longLeg = delever?.legs.find((l) => l.side === 'LONG');
  const shortLeg = delever?.legs.find((l) => l.side === 'SHORT');
  const twap = job.twap ?? null;
  const headline = delever
    ? sk('deleverHeader', { coin, long: prettyVenue(longLeg?.exchange ?? ''), short: prettyVenue(shortLeg?.exchange ?? '') })
    : t('accounts.rebalanceTabs.realize');
  const title = twap ? (
    <div className="flex flex-col gap-0.5">
      <span>{headline}</span>
      <span className="num text-xs font-normal text-ink-400">{t('trade.twap.run.plan', { n: twap.of, duration: spanText(twap.durationSec) })}</span>
    </div>
  ) : (
    headline
  );
  const child = job.child ?? null;
  const resting = twap !== null && running && !job.pauseRequested && child !== null && child.mode === 'OPENING';
  const twapParts: Partial<RunProps> = twap
    ? {
        graph: resting && child ? <SliceGraph key={`${child.id}-graph`} childId={child.id} oneLeg={false} /> : null,
        priceBox: resting && child ? <SlicePriceBox key={`${child.id}-price`} child={child} /> : null,
        orders: job.orders ?? [],
        footer: running || halted,
      }
    : {};
  const show = (props: Partial<RunProps>) => (
    <RunView title={title} chip={null} firstLine={null} rows={[]} graph={null} priceBox={null} orders={[]} lines={[]} acts={null} footer={false} {...twapParts} {...props} />
  );
  const totalCostRows: RunProps['rows'] =
    realCost === null ? [] : [{ label: sk('totalCostLabel'), value: sk('totalCost', { real: fmtUsd(realCost), est: fmtUsd(estCost) }) }];

  const unwind = job.unwindTarget ?? null;
  const fixHolds = (undo: boolean) => {
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
        {undo && delever && leg && (
          <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={() => press('unwind')}>
            <span className="num">{sk('holdUndoClose', { venue: prettyVenue(leg.exchange), side: t(leg.side === 'LONG' ? 'common.long' : 'common.short'), qty: sizeText(open), coin })}</span>
          </HoldToConfirmButton>
        )}
        {undo && !delever && unwind && (
          <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={pending} onConfirm={() => press('unwind')}>
            <span className="num">{sk('holdCloseMarket', { venue: prettyVenue(unwind.exchange), side: t(unwind.side === 'SELL' ? 'common.long' : 'common.short'), qty: sizeText(unwind.qty), coin })}</span>
          </HoldToConfirmButton>
        )}
        {fixError}
      </div>
    );
  };

  const nextMove = (borrowLeft: boolean) =>
    borrowLeft ? (
      <button type="button" className="btn-primary w-full gap-1.5" onClick={() => onTab?.('move')}>
        {sk('next')}
        <ArrowRight size={14} aria-hidden />
      </button>
    ) : null;

  if (job.status === 'done') {
    const borrowLeft = view.buckets.some((bucket) => bucket.borrow > 0);
    if (delever) {
      const account = job.imUsedStart?.[0]?.account;
      const start = imOf(job.imUsedStart, account);
      const end = imOf(job.imUsedEnd, account);
      return show({
        firstLine: (
          <ResultBox
            tone="done"
            title={sk('deleverDoneHeader', { pct: pctText(delever.pct) })}
            rows={[
              { label: sk('perpsRow'), value: sk('perpsLine', { old: sizeText(perpBefore), now: sizeText(perpNow), coin }) },
              ...(borosBefore > 0 ? [{ label: sk('borosLabel'), value: sk('borosChange', { a: sizeText(borosBefore), b: sizeText(borosNow) }) }] : []),
              ...(start !== null && end !== null
                ? [{ label: sk('imLabel', { account: accountText(account) }), value: sk('imDone', { a: pctText(start), b: pctText(end) }) }]
                : []),
              ...totalCostRows,
            ]}
          />
        ),
        acts: nextMove(borrowLeft),
      });
    }
    return show({
      title: null,
      firstLine: (
        <ResultBox
          tone="done"
          title={sk('realized', { amount: num(realized, 0), coin: cashCoin })}
          lines={(job.profitStops ?? []).map((stop) => sk('profitStop', { closed: sizeText(stop.closedQty), planned: sizeText(stop.plannedQty), coin: stop.base }))}
          rows={totalCostRows}
        />
      ),
      acts: nextMove(true),
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
        { label: t('trade.twap.run.slice', { i: num(index, 0), n: num(count, 0) }), value: sk('left', { time: fmtAbout((count - index + 1) * (twap ? twap.intervalSec : (job.exec ?? 'maker') === 'maker' && job.maker?.takerAfterSec ? job.maker.takerAfterSec : SLICE_SECONDS[job.exec ?? 'maker'])) }) },
        { label: sk('realizedLabel'), value: sk('realizedOf', { x: num(realized, 0), y: num(job.amount, 0), coin: cashCoin }) },
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
        fixHolds(false)
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
          lines={haltLine(job.haltReason)}
        />
      ),
      rows: [
        perpsRow,
        borosRow(sk('borosYuFilled', { amount: sizeText(borosNow), filled: sizeText(Math.max(0, borosTarget - left)), target: sizeText(borosTarget) })),
      ],
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

  if (open > 0 && halted && !paused) {
    return show({
      firstLine: <StopBox title={sk('notHedged', { qty: sizeText(open), coin })} lines={haltLine(job.haltReason)} />,
      rows: borosGap ? [perpsRow, borosRow(sk('borosYu', { amount: sizeText(borosNow) }))] : [],
      acts: (
        <>
          {fixHolds(true)}
          {borosGap && (
            <>
              <StopBox title={dk('borosNoPerp', { amount: sizeText(gapYu) })} lines={[]} />
              {closeBorosHold}
            </>
          )}
          {margin ? (
            <div className="border-t border-ink-800 pt-3">
              <Actions {...props} note={abandonNote} quietResume />
            </div>
          ) : (
            abandonBlock
          )}
        </>
      ),
    });
  }

  const pausedLine = paused ? sliceStateLabel(job) : null;
  const status = borosGap ? (
    <StopBox title={dk('borosNoPerp', { amount: sizeText(gapYu) })} lines={pausedLine ? [pausedLine] : haltLine(job.haltReason)} />
  ) : margin ? (
    <StopBox title={localizeServerText(job.haltReason ?? '')} lines={[]} />
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
        {!abandoned && (
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
