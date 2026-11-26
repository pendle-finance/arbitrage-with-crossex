import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useBorosAgent } from '../api/queries';
import { useActiveWallet } from '../panels/trackedAddress';
import type { RebalanceJob, RunLegView, RunOrderView } from '../api/types';
import { Chip } from '../components/Chip';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtAbout, fmtClock, fmtDateShort, fmtPct, sigGrouped } from '../lib/fmt';
import { ProgressBar, VerdictAlert } from '../panels/RebalanceBits';
import { spanText } from '../lib/span';
import { dealSlippage } from './dealSlippage';
import { FoldRow } from './FoldRow';
import { EstimateRow } from './PairTicketBits';
import {
  clockSpan,
  feeText,
  OrdersTable,
  padTwo,
  qtyText,
  runShapeOf,
  sideWord,
  SideText,
  SliceGraph,
  SlipLabel,
  SlicePriceBox,
  TwapActs,
  usdText,
} from './RunViewBits';

export interface RunRow {
  label: ReactNode;
  value: ReactNode;
  tone?: 'gain' | 'loss';
}

export interface RunViewProps {
  title: ReactNode;
  chip: ReactNode;
  progress?: { ratio: number; tone: 'running' | 'done' | 'stopped' } | null;
  firstLine: ReactNode;
  rows: RunRow[];
  graph: ReactNode | null;
  priceBox: ReactNode | null;
  orders: RunOrderView[];
  lines: ReactNode[];
  acts: ReactNode;
  footer: boolean;
  ownAccount?: boolean;
}

export function useOwnAccountNote(): boolean {
  const agent = useBorosAgent();
  const { viewOnly } = useActiveWallet();
  return viewOnly || agent.data?.configured === false;
}

const TITLE_KEY = {
  pairOpen: 'titlePairOpen',
  pairClose: 'titlePairClose',
  singleOpen: 'titleSingleOpen',
  singleClose: 'titleSingleClose',
} as const;

const TONE_CLASS = { gain: 'text-emerald-400', loss: 'text-rose-400' } as const;

const USDC_VENUES: readonly string[] = ['HYPERLIQUID', 'LIGHTER'];
const marginCoinOf = (leg: RunLegView | undefined): string => (leg && USDC_VENUES.includes(leg.exchange) ? 'USDC' : 'USDT');

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function RunView({ title, chip, progress, firstLine, rows, graph, priceBox, orders, lines, acts, footer, ownAccount }: RunViewProps) {
  const { t: tr } = useTranslation();
  const showOwnAccount = useOwnAccountNote();
  const [ordersOpen, setOrdersOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold text-ink-50">{title}</div>
        <div className="shrink-0">{chip}</div>
      </div>
      {ownAccount && showOwnAccount && <div className="text-[12px] text-ink-300">{tr('trade.twap.ownAccount')}</div>}
      {progress && <ProgressBar ratio={progress.ratio} tone={progress.tone} />}
      {firstLine}
      {rows.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded border border-ink-700 px-3 py-2.5">
          {rows.map((row, i) => (
            <EstimateRow
              key={i}
              label={row.label}
              value={row.tone ? <span className={TONE_CLASS[row.tone]}>{row.value}</span> : row.value}
            />
          ))}
        </div>
      )}
      {graph}
      {priceBox}
      {lines.map((line, i) => (
        <div key={i} className="text-[12px] text-ink-300">
          {line}
        </div>
      ))}
      {orders.length > 0 && (
        <FoldRow
          label={
            <span className="inline-flex items-center gap-1.5">
              {tr('trade.twap.run.orders')}
              <Chip sm className="num">
                {orders.length}
              </Chip>
            </span>
          }
          summary=""
          open={ordersOpen}
          onToggle={() => setOrdersOpen((v) => !v)}
        >
          <OrdersTable orders={orders} />
        </FoldRow>
      )}
      {footer && (
        <div className="text-[11px] text-ink-400">
          {tr(isMac() ? 'trade.twap.footer.awake' : 'trade.twap.run.awakeOther')}
        </div>
      )}
      {acts}
    </div>
  );
}

export function twapRunProps(job: RebalanceJob, now: number): RunViewProps {
  const twap = job.twap ?? null;
  const { legs, makerIdx, maker, hedge, coin, close, shape, side } = runShapeOf(job);
  const pair = hedge !== undefined;
  const child = job.child ?? null;
  const total = Number(legs[0]?.plannedQty ?? 0);
  const filled = legs.map((leg) => Number(leg.filledQty));
  const makerFilled = filled[makerIdx] ?? 0;
  const makerAvg = Number(maker?.avgPrice ?? NaN);
  const usdOf = (qty: number): string => (Number.isFinite(makerAvg) ? usdText(qty * makerAvg) : '');
  const gap = pair ? Math.abs((filled[0] ?? 0) - (filled[1] ?? 0)) : 0;
  const slice = twap?.slice ?? 0;
  const of = twap?.of ?? 0;
  const running = job.status === 'running';
  const halted = job.status === 'halted';
  const pausing = running && job.pauseRequested === true;
  const kind = halted ? (job.haltKind ?? null) : null;
  const redHalt = kind === 'refused' || kind === 'hedge-margin' || kind === 'error';
  const stuck = kind === 'refused' && job.sizeRefusal?.wholeRest === true;
  const never = twap?.takerAfterSec === null;
  const lastSlice = slice >= of;
  const fees = job.fees ?? { readUsd: 0, estUsd: 0, totalUsd: 0, est: false };

  const perpsSet = legs.length > 0 && legs.every((leg) => leg.beforeQty !== undefined && leg.nowQty !== undefined);
  const perpsRows = (): RunRow[] => {
    const value = (leg: RunLegView) => t('trade.twap.run.perpsValue', { before: qtyText(Number(leg.beforeQty)), now: qtyText(Number(leg.nowQty)), coin });
    const same = legs.every((leg) => leg.beforeQty === legs[0]?.beforeQty && leg.nowQty === legs[0]?.nowQty);
    if (same && legs[0]) return [{ label: t('trade.twap.run.perpsEach'), value: value(legs[0]) }];
    return legs.map((leg) => ({ label: t('trade.twap.run.perpsVenue', { venue: leg.name }), value: value(leg) }));
  };
  const filledRows = (): RunRow[] => {
    if (perpsSet) return perpsRows();
    const withUsd = (qty: number) => {
      const usd = usdOf(qty);
      return t(usd ? 'trade.twap.run.filledEachValue' : 'trade.twap.run.filledEachValueNoUsd', { done: qtyText(qty), total: qtyText(total), coin, usd });
    };
    if (pair && filled[0] === filled[1]) return [{ label: t(close ? 'trade.twap.run.closedEach' : 'trade.twap.run.filledEach'), value: withUsd(makerFilled) }];
    const venueKey = close ? 'trade.twap.run.closedVenue' : 'trade.twap.run.filledVenue';
    return legs.map((leg, i) => ({ label: t(venueKey, { venue: leg.name }), value: withUsd(filled[i] ?? 0) }));
  };
  const leftRow: RunRow = {
    label: pair ? t('trade.twap.run.leftEach') : t('trade.twap.run.leftVenue', { venue: maker?.name ?? '' }),
    value: t('trade.twap.run.qtyValue', { qty: qtyText(Math.max(0, total - makerFilled)), coin }),
  };
  const avgRows = (): RunRow[] =>
    legs
      .filter((leg) => leg.avgPrice !== null)
      .map((leg) => ({ label: t('trade.twap.run.avgVenue', { venue: leg.name }), value: padTwo(sigGrouped(leg.avgPrice ?? '')) }));
  const slippageRow = (label: string): RunRow[] => {
    if (!pair || !maker || !hedge) return [];
    const long = maker.side === 'LONG' ? maker : hedge;
    const short = maker.side === 'LONG' ? hedge : maker;
    const qty = Math.min(filled[0] ?? 0, filled[1] ?? 0);
    const slip = dealSlippage({ longAvg: Number(long.avgPrice), shortAvg: Number(short.avgPrice), qty, close });
    if (!slip) return [];
    const sign = slip.usd >= 0 ? '+' : '−';
    const amount = `${sign}${sigGrouped(Math.abs(slip.usd / qty))}`;
    const pct = `${sign}${fmtPct(Math.abs(slip.pct), 3)}`;
    const word = t(slip.word === 'Favorable' ? 'trade.deal.favorable' : 'trade.deal.adverse');
    return [{ label: <SlipLabel label={label} />, value: `${t('trade.twap.run.slippageValue', { amount, pct })} ${word}`, tone: slip.usd >= 0 ? 'gain' : 'loss' }];
  };
  const notHedgedRow = (): RunRow[] =>
    pair
      ? [{ label: t('trade.twap.run.notHedged'), value: gap > 0 ? `${qtyText(gap)} ${coin}${usdOf(gap) ? ` (${usdOf(gap)})` : ''}` : `0 ${coin}` }]
      : [];
  const feeRow: RunRow = {
    label: t('trade.twap.run.feeSoFar'),
    value: feeText(fees),
  };
  const boros = job.boros ?? null;
  const borosRow = (): RunRow[] =>
    boros ? [{ label: t('trade.twap.run.boros'), value: t('trade.twap.run.borosValue', { before: qtyText(boros.beforeYu), now: qtyText(boros.nowYu) }) }] : [];
  const resumeRow: RunRow = {
    label: t('trade.twap.run.onResume'),
    value: t('trade.twap.run.onResumeValue', { count: Math.max(0, of - slice), interval: spanText(twap?.intervalSec ?? 0) }),
  };

  const titleKey = TITLE_KEY[shape];
  const venueOn = (side: RunLegView['side']) => legs.find((leg) => leg.side === side)?.name ?? '';
  const titleText =
    job.kind === 'delever'
      ? t('accounts.sliceRun.deleverHeader', { coin, long: venueOn('LONG'), short: venueOn('SHORT') })
      : t(`trade.twap.run.${titleKey}`, { coin, side, venue: maker?.name ?? '' });
  const title = (
    <div className="flex flex-col gap-0.5">
      <span>{titleText}</span>
      <span className="num text-[11px] font-normal text-ink-400">
        {pair && maker && hedge && (
          <>
            {legs[0]?.name} <SideText side={legs[0]!.side} /> / {legs[1]?.name} <SideText side={legs[1]!.side} />
            {' · '}
          </>
        )}
        {t('trade.twap.run.plan', { n: of, duration: spanText(twap?.durationSec ?? 0) })}
      </span>
    </div>
  );

  const chip = running ? (
    <Chip tone="info">{t('common.running')}</Chip>
  ) : job.status === 'done' ? (
    <Chip>{t('common.done')}</Chip>
  ) : job.status === 'abandoned' ? (
    <Chip>{t('common.stopped')}</Chip>
  ) : (
    <Chip tone={redHalt ? 'red' : 'amber'}>{t('common.paused')}</Chip>
  );

  const progress =
    total > 0
      ? { ratio: makerFilled / total, tone: job.status === 'done' ? 'done' : job.status === 'abandoned' || redHalt ? 'stopped' : 'running' } as const
      : null;
  const resting = running && !pausing && child !== null && child.mode === 'OPENING';
  const graph = resting && child ? <SliceGraph key={`${child.id}-graph`} childId={child.id} oneLeg={!pair} /> : null;
  const priceBox = resting && child ? <SlicePriceBox key={`${child.id}-price`} child={child} /> : null;
  const lines: ReactNode[] = [];
  const refusedNow = resting && child !== null && child.repegRefused !== null && child.restPrice !== null;
  if (refusedNow) {
    lines.push(
      <span className="num text-amber-300">
        {t('trade.twap.run.repegRefused', { venue: maker?.name ?? '' })}
      </span>,
    );
  }
  if (!pair && (running || halted)) lines.push(t('trade.single.notHedged'));

  const base = { title, chip, progress, graph, priceBox, orders: job.orders ?? [], lines, footer: running || halted, ownAccount: true };
  const sliceLabel = t('trade.twap.run.slice', { i: slice, n: of });

  if (job.status === 'done' || job.status === 'abandoned') {
    const doneKey = close ? 'closedEach' : 'openedEach';
    const leftKey = close ? 'notClosedEach' : 'notOpenedEach';
    const rows: RunRow[] =
      job.status === 'done'
        ? [
            { label: t(`trade.twap.run.${doneKey}`), value: t(usdOf(makerFilled) ? 'trade.twap.run.openedValue' : 'trade.twap.run.openedValueNoUsd', { qty: qtyText(makerFilled), coin, usd: usdOf(makerFilled) }) },
            ...avgRows(),
            ...slippageRow(t('trade.deal.slippage')),
            { label: t('trade.twap.run.fees'), value: usdText(fees.readUsd + fees.estUsd) },
            { label: t('trade.twap.run.took'), value: clockSpan((job.updatedAt - (twap?.startedAt ?? job.createdAt)) / 1000) },
          ]
        : [
            { label: t('trade.twap.run.stopped', { i: slice, n: of }), value: fmtClock(job.updatedAt) },
            { label: t(`trade.twap.run.${doneKey}`), value: t('trade.twap.run.qtyValue', { qty: `${qtyText(makerFilled)} / ${qtyText(total)}`, coin }) },
            { label: t(`trade.twap.run.${leftKey}`), value: t('trade.twap.run.qtyValue', { qty: qtyText(Math.max(0, total - makerFilled)), coin }) },
            ...avgRows(),
            ...slippageRow(t('trade.deal.slippage')),
            { label: t('trade.twap.run.fees'), value: usdText(fees.readUsd + fees.estUsd) },
          ];
    return { ...base, firstLine: null, rows, acts: null };
  }

  if (pausing) {
    const firstLine = (
      <div className="flex items-center gap-2 text-[12px] text-amber-300">
        <Loader2 size={12} aria-hidden className="animate-spin" />
        {t('trade.twap.run.pausing', { i: slice })}
      </div>
    );
    return { ...base, firstLine, rows: [{ label: sliceLabel, value: '' }, ...filledRows(), ...borosRow(), ...notHedgedRow()], acts: null };
  }

  if (halted) {
    const venueOf = (leg: RunLegView | undefined) => leg?.name ?? '';
    let firstLine: ReactNode = null;
    let rows: RunRow[] = [...filledRows(), leftRow, ...borosRow(), resumeRow, ...notHedgedRow()];
    if (kind === null) rows = [{ label: t('trade.twap.run.paused', { i: slice, n: of }), value: t('trade.twap.run.since', { time: fmtClock(job.updatedAt) }) }, ...rows];
    if (kind === 'restart') firstLine = <VerdictAlert tone="warn" text={t('trade.twap.run.restarted', { time: fmtClock(job.updatedAt), i: slice })} />;
    if (kind === 'sleep') {
      const from = job.sleptFrom ?? job.updatedAt;
      const to = job.sleptTo ?? job.updatedAt;
      const oneDay = new Date(from).toDateString() === new Date(to).toDateString();
      const stamp = (ms: number) => (oneDay ? fmtClock(ms) : `${fmtDateShort(ms / 1000)} ${fmtClock(ms)}`);
      firstLine = <VerdictAlert tone="warn" text={t('trade.twap.run.slept', { from: stamp(from), to: stamp(to), i: slice })} />;
    }
    if (kind === 'capped-rest') {
      const rest = t(close ? 'trade.twap.run.restNotClosed' : 'trade.twap.run.restNotOpened', { qty: qtyText(Number(twap?.behindQty ?? 0)), coin });
      rows = [...filledRows(), { label: t('trade.twap.run.rest'), value: rest }, ...borosRow(), ...notHedgedRow()];
    }
    if (kind === 'refused') {
      const margin = /refused slice \d+: not enough margin/.test(job.haltReason ?? '');
      const text = (
        <>
          <span className="block">{localizeServerText(job.haltReason ?? '')}</span>
          {!stuck && (
            <span className="block text-ink-300">
              {margin ? t('trade.twap.server.refusedFix', { venue: venueOf(maker), coin: marginCoinOf(maker) }) : t('trade.twap.run.refusedSize')}
            </span>
          )}
        </>
      );
      firstLine = <VerdictAlert tone="act" text={text} />;
      rows = [...filledRows(), ...notHedgedRow()];
    }
    if (kind === 'hedge-margin') {
      const text = (
        <>
          <span className="block">{localizeServerText(job.haltReason ?? '')}</span>
          <span className="num block text-ink-300">{t('trade.twap.server.hedgeGap', { qty: qtyText(gap), coin, usd: usdOf(gap) })}</span>
          <span className="block text-ink-300">{t('trade.twap.server.hedgeFix', { venue: venueOf(hedge), coin: marginCoinOf(hedge) })}</span>
        </>
      );
      firstLine = <VerdictAlert tone="act" text={text} />;
      rows = filledRows();
    }
    const borosHold = kind === 'boros' && boros?.refused ? t('accounts.sliceRun.holdRetryBoros', { amount: qtyText(boros.leftYu) }) : null;
    if (borosHold && boros) {
      const text = (
        <>
          <span className="num block">{t('trade.twap.run.borosNotHedged', { amount: qtyText(boros.leftYu) })}</span>
          <span className="block text-ink-300">{t('trade.twap.run.borosRefused', { i: boros.slice })}</span>
        </>
      );
      firstLine = <VerdictAlert tone="warn" text={text} />;
      rows = [{ label: t('trade.twap.run.paused', { i: slice, n: of }), value: '' }, ...filledRows(), ...borosRow()];
    } else if (kind !== null && kind !== 'restart' && kind !== 'sleep' && kind !== 'refused' && kind !== 'hedge-margin' && kind !== 'capped-rest') {
      firstLine = <VerdictAlert tone={redHalt ? 'act' : 'warn'} text={localizeServerText(job.haltReason ?? '')} />;
    }
    const holdOn = (key: 'holdOpenHedge' | 'holdCloseFilled', leg: RunLegView) =>
      t(`trade.twap.run.${key}`, { venue: leg.name, side: sideWord(leg.side), qty: qtyText(gap), coin });
    const holds =
      kind === 'hedge-margin' && maker && hedge
        ? close
          ? { open: holdOn('holdCloseFilled', hedge), close: holdOn('holdOpenHedge', maker) }
          : { open: holdOn('holdOpenHedge', hedge), close: holdOn('holdCloseFilled', maker) }
        : null;
    const acts = <TwapActs jobId={job.id} state="halted" holds={holds} borosHold={borosHold} noResume={stuck} />;
    return { ...base, firstLine, rows, acts };
  }

  const firstRow: RunRow =
    lastSlice && child !== null
      ? { label: sliceLabel, value: refusedNow ? (never ? t('trade.twap.run.noMarketOrder') : '') : t(never ? 'trade.twap.run.noMarket' : 'trade.twap.run.limitResting') }
      : {
          label: sliceLabel,
          value:
            twap?.nextAt != null
              ? t('trade.twap.run.left', { time: fmtAbout(Math.max(60, (twap.nextAt - now) / 1000 + Math.max(0, of - slice - 1) * twap.intervalSec + (twap.takerAfterSec ?? 0))) })
              : '',
        };
  const rows: RunRow[] = [firstRow];
  const waiting = !lastSlice && child !== null && child.mode !== 'DONE' && (twap?.nextAt == null || twap.nextAt <= now);
  if (waiting) rows.push({ label: t('trade.twap.run.nextSliceWait'), value: t('trade.twap.run.afterSliceEnds', { i: slice }) });
  else if (twap?.nextAt != null && !lastSlice) rows.push({ label: t('trade.twap.run.nextSlice'), value: clockSpan((twap.nextAt - now) / 1000) });
  rows.push(...filledRows());
  const behind = Number(twap?.behindQty ?? 0);
  if (never && !lastSlice && behind > 0) rows.push({ label: t('trade.twap.run.behind'), value: t('trade.twap.run.qtyValue', { qty: qtyText(behind), coin }) });
  if (never && lastSlice && child !== null) {
    const restQty = qtyText(Math.max(0, total - makerFilled));
    rows.push({ label: t('trade.twap.run.rest'), value: t(refusedNow ? 'trade.twap.run.qtyValue' : 'trade.twap.run.restResting', { qty: restQty, coin }) });
  }
  rows.push(...avgRows(), ...slippageRow(t('trade.twap.run.slippageSoFar')), ...borosRow(), ...notHedgedRow(), feeRow);
  return { ...base, firstLine: null, rows, acts: <TwapActs jobId={job.id} state="running" holds={null} borosHold={null} /> };
}

