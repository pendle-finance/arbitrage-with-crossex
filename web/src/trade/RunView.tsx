import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { RebalanceJob, RunLegView, RunOrderView } from '../api/types';
import { Chip } from '../components/Chip';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtClock, fmtPct, sigGrouped, parseSymbol } from '../lib/fmt';
import { VerdictAlert } from '../panels/RebalanceBits';
import { spanText } from '../lib/span';
import { dealSlippage } from './dealSlippage';
import { FoldRow } from './FoldRow';
import { EstimateRow } from './PairTicketBits';
import {
  clockSpan,
  leftText,
  OrdersTable,
  padTwo,
  qtyText,
  sideWord,
  SideText,
  SliceGraph,
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
  firstLine: ReactNode;
  rows: RunRow[];
  graph: ReactNode | null;
  priceBox: ReactNode | null;
  orders: RunOrderView[];
  lines: ReactNode[];
  acts: ReactNode;
  footer: boolean;
}

const TONE_CLASS = { gain: 'text-emerald-400', loss: 'text-rose-400' } as const;

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function RunView({ title, chip, firstLine, rows, graph, priceBox, orders, lines, acts, footer }: RunViewProps) {
  const { t: tr } = useTranslation();
  const [ordersOpen, setOrdersOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold text-ink-50">{title}</div>
        <div className="shrink-0">{chip}</div>
      </div>
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
          label={tr('trade.twap.run.orders', { n: orders.length })}
          summary=""
          open={ordersOpen}
          onToggle={() => setOrdersOpen((v) => !v)}
        >
          <OrdersTable orders={orders} />
        </FoldRow>
      )}
      {acts}
      {footer && (
        <div className="flex flex-col gap-0.5 text-[11px] text-ink-500">
          <span>{tr('trade.twap.footer.runsInApp')}</span>
          {isMac() && <span>{tr('trade.twap.footer.awake')}</span>}
        </div>
      )}
    </div>
  );
}

export function twapRunProps(job: RebalanceJob, now: number): RunViewProps {
  const twap = job.twap ?? null;
  const legs = job.legs ?? [];
  const makerIdx = twap?.makerLeg === 'b' ? 1 : 0;
  const maker = legs[makerIdx];
  const hedge = legs.length > 1 ? legs[1 - makerIdx] : undefined;
  const pair = hedge !== undefined;
  const child = job.child ?? null;
  const coin = legs[0]?.symbol ? parseSymbol(legs[0].symbol).base : '';
  const close =
    maker?.reduceOnly ?? false;
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
  const never = twap?.takerAfterSec === null;
  const lastSlice = slice >= of;
  const fees = job.fees ?? { readUsd: 0, estUsd: 0, est: false };

  const perpsSet = legs.length > 0 && legs.every((leg) => leg.beforeQty !== undefined && leg.nowQty !== undefined);
  const perpsRows = (): RunRow[] => {
    const value = (leg: RunLegView) => t('trade.twap.run.perpsValue', { before: qtyText(Number(leg.beforeQty)), now: qtyText(Number(leg.nowQty)), coin });
    const same = legs.every((leg) => leg.beforeQty === legs[0]?.beforeQty && leg.nowQty === legs[0]?.nowQty);
    if (same && legs[0]) return [{ label: t('trade.twap.run.perpsEach'), value: value(legs[0]) }];
    return legs.map((leg) => ({ label: t('trade.twap.run.perpsVenue', { venue: leg.name }), value: value(leg) }));
  };
  const filledRows = (): RunRow[] => {
    if (perpsSet) return perpsRows();
    const withUsd = (qty: number) =>
      t('trade.twap.run.filledEachValue', { done: qtyText(qty), total: qtyText(total), coin, usd: usdOf(qty) });
    if (pair && filled[0] === filled[1]) return [{ label: t('trade.twap.run.filledEach'), value: withUsd(makerFilled) }];
    return legs.map((leg, i) => ({ label: t('trade.twap.run.filledVenue', { venue: leg.name }), value: withUsd(filled[i] ?? 0) }));
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
    return [{ label, value: `${t('trade.twap.run.slippageValue', { amount, pct })} ${word}`, tone: slip.usd >= 0 ? 'gain' : 'loss' }];
  };
  const notHedgedRow = (): RunRow[] =>
    pair
      ? [{ label: t('trade.twap.run.notHedged'), value: gap > 0 ? `${qtyText(gap)} ${coin} (${usdOf(gap)})` : `0 ${coin}` }]
      : [];
  const feeRow: RunRow = {
    label: t('trade.twap.run.feeSoFar'),
    value: fees.est ? t('trade.twap.run.feeValue', { fee: usdText(fees.readUsd), est: usdText(fees.estUsd) }) : usdText(fees.readUsd),
  };
  const boros = job.boros ?? null;
  const borosRow = (): RunRow[] =>
    boros ? [{ label: t('trade.twap.run.boros'), value: t('trade.twap.run.borosValue', { before: qtyText(boros.beforeYu), now: qtyText(boros.nowYu) }) }] : [];
  const resumeRow: RunRow = {
    label: t('trade.twap.run.onResume'),
    value: t('trade.twap.run.onResumeValue', { n: Math.max(0, of - slice), interval: spanText(twap?.intervalSec ?? 0) }),
  };

  const titleKey = pair ? (close ? 'titlePairClose' : 'titlePairOpen') : close ? 'titleSingleClose' : 'titleSingleOpen';
  const title = (
    <div className="flex flex-col gap-0.5">
      <span>{t(`trade.twap.run.${titleKey}`, { coin, side: maker ? sideWord(maker.side).toLowerCase() : '', venue: maker?.name ?? '' })}</span>
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
    <Chip tone={kind === 'refused' || kind === 'hedge-margin' || kind === 'error' ? 'red' : 'amber'}>{t('common.paused')}</Chip>
  );

  const resting = running && !pausing && child !== null && child.mode === 'OPENING';
  const graph = resting && child ? <SliceGraph key={`${child.id}-graph`} childId={child.id} oneLeg={!pair} /> : null;
  const priceBox = resting && child ? <SlicePriceBox key={`${child.id}-price`} child={child} /> : null;
  const lines: ReactNode[] = [];
  if (resting && child?.repegRefused && child.restPrice !== null) {
    lines.push(
      <span className="num text-amber-300">
        {t('trade.twap.run.repegRefused', { venue: maker?.name ?? '', price: padTwo(sigGrouped(child.restPrice)) })}
      </span>,
    );
  }
  if (!pair && (running || halted)) lines.push(t('trade.single.notHedged'));

  const base = { title, chip, graph, priceBox, orders: job.orders ?? [], lines, footer: running || halted };
  const sliceLabel = t('trade.twap.run.slice', { i: slice, n: of });

  if (job.status === 'done' || job.status === 'abandoned') {
    const doneKey = close ? 'closedEach' : 'openedEach';
    const leftKey = close ? 'notClosedEach' : 'notOpenedEach';
    const rows: RunRow[] =
      job.status === 'done'
        ? [
            { label: t(`trade.twap.run.${doneKey}`), value: t('trade.twap.run.openedValue', { qty: qtyText(makerFilled), coin, usd: usdOf(makerFilled) }) },
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
    let rows: RunRow[] = [...filledRows(), ...borosRow(), resumeRow, ...notHedgedRow()];
    if (kind === null) rows = [{ label: t('trade.twap.run.paused', { i: slice, n: of }), value: '' }, ...rows];
    if (kind === 'restart') firstLine = <VerdictAlert tone="warn" text={t('trade.twap.run.restarted', { time: fmtClock(job.updatedAt), i: slice })} />;
    if (kind === 'sleep') {
      const text = t('trade.twap.run.slept', { from: fmtClock(job.sleptFrom ?? job.updatedAt), to: fmtClock(job.sleptTo ?? job.updatedAt), i: slice });
      firstLine = <VerdictAlert tone="warn" text={text} />;
    }
    if (kind === 'refused') {
      const text = (
        <>
          <span className="block">{localizeServerText(job.haltReason ?? '')}</span>
          <span className="block text-ink-300">{t('trade.twap.server.refusedFix', { venue: venueOf(maker) })}</span>
        </>
      );
      firstLine = <VerdictAlert tone="warn" text={text} />;
      rows = [...filledRows(), ...notHedgedRow()];
    }
    if (kind === 'hedge-margin') {
      const text = (
        <>
          <span className="block">{localizeServerText(job.haltReason ?? '')}</span>
          <span className="num block text-ink-300">{t('trade.twap.server.hedgeGap', { qty: qtyText(gap), coin, usd: usdOf(gap) })}</span>
          <span className="block text-ink-300">{t('trade.twap.server.hedgeFix', { venue: venueOf(hedge) })}</span>
        </>
      );
      firstLine = <VerdictAlert tone="warn" text={text} />;
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
    } else if (kind !== null && kind !== 'restart' && kind !== 'sleep' && kind !== 'refused' && kind !== 'hedge-margin') {
      firstLine = <VerdictAlert tone="warn" text={localizeServerText(job.haltReason ?? '')} />;
    }
    const ahead = filled[0] !== undefined && filled[1] !== undefined && filled[0] > filled[1] ? 0 : 1;
    const holds =
      kind === 'hedge-margin' && maker && hedge
        ? {
            open: t('trade.twap.run.holdOpenHedge', { venue: legs[1 - ahead]!.name, side: sideWord(legs[1 - ahead]!.side), qty: qtyText(gap), coin }),
            close: t('trade.twap.run.holdCloseFilled', { venue: legs[ahead]!.name, side: sideWord(legs[ahead]!.side), qty: qtyText(gap), coin }),
          }
        : null;
    return { ...base, firstLine, rows, acts: <TwapActs jobId={job.id} state="halted" holds={holds} borosHold={borosHold} /> };
  }

  const firstRow: RunRow =
    lastSlice && child !== null
      ? { label: sliceLabel, value: t(never ? 'trade.twap.run.noMarket' : 'trade.twap.run.limitResting') }
      : {
          label: sliceLabel,
          value:
            twap?.nextAt != null
              ? t('trade.twap.run.left', { time: leftText((twap.nextAt - now) / 1000 + Math.max(0, of - slice) * twap.intervalSec) })
              : '',
        };
  const rows: RunRow[] = [firstRow];
  if (twap?.nextAt != null && !lastSlice) rows.push({ label: t('trade.twap.run.nextSlice'), value: clockSpan((twap.nextAt - now) / 1000) });
  rows.push(...filledRows());
  const behind = Number(twap?.behindQty ?? 0);
  if (never && !lastSlice && behind > 0) rows.push({ label: t('trade.twap.run.behind'), value: t('trade.twap.run.qtyValue', { qty: qtyText(behind), coin }) });
  if (never && lastSlice && child !== null) {
    rows.push({ label: t('trade.twap.run.rest'), value: t('trade.twap.run.restResting', { qty: qtyText(Math.max(0, total - makerFilled)), coin }) });
  }
  rows.push(...avgRows(), ...slippageRow(t('trade.twap.run.slippageSoFar')), ...borosRow(), ...notHedgedRow(), feeRow);
  return { ...base, firstLine: null, rows, acts: <TwapActs jobId={job.id} state="running" holds={null} borosHold={null} /> };
}

