import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useDealCommand, useDealView, useRebalanceCommand, useRebalanceFix } from '../api/queries';
import type { RebalanceJob, RunOrderView, TwapChildView } from '../api/types';
import { Chip } from '../components/Chip';
import { DataTable } from '../components/DataTable';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { HoverCard } from '../components/HoverCard';
import { Skeleton } from '../components/Skeleton';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtUsd, num, padTwo, parseSymbol, prettyVenue, qtyGrouped } from '../lib/fmt';
import { decimalsOf, formatRestPrice } from '../lib/ticks';
import { LimitPriceBox } from './LimitPriceBox';
import { DealBookImpact } from './PriceImpactGraph';

const STATE_KEY = {
  PENDING: 'trade.deal.statePending',
  OPEN: 'trade.deal.stateOpen',
  CLOSED: 'trade.deal.stateClosed',
  DEAD: 'trade.deal.stateDead',
} as const satisfies Record<RunOrderView['state'], string>;

export function OrdersTable({ orders }: { orders: RunOrderView[] }) {
  const { t: tr } = useTranslation();
  const makerLegs = new Set(orders.filter((o) => o.kind === 'maker').map((o) => o.leg));
  const orderText = (o: RunOrderView): string => {
    if (o.kind === 'maker') {
      const price = o.price === null ? '' : qtyText(o.price);
      return o.slice === null ? `${tr('trade.impact.limit')} ${price}` : tr('trade.twap.run.orderLimit', { price, n: o.slice });
    }
    const market = makerLegs.has(o.leg);
    if (o.slice === null) return tr(market ? 'trade.deal.noteMarket' : 'trade.deal.noteHedge');
    return tr(market ? 'trade.twap.run.orderMarket' : 'trade.twap.run.orderHedge', { n: o.slice });
  };
  return (
    <DataTable
      maxHeightClass="max-h-44"
      rowKey={(o) => `${o.createdAt}-${o.leg}-${o.kind}-${o.slice ?? ''}`}
      rows={orders}
      columns={[
        { key: 'venue', header: tr('trade.twap.run.colVenue'), render: (o) => o.venue },
        { key: 'order', header: tr('trade.twap.run.colOrder'), render: (o) => <span className="num">{orderText(o)}</span> },
        { key: 'size', header: tr('trade.twap.run.colSize'), align: 'right', render: (o) => <span className="num">{qtyText(o.qty)}</span> },
        { key: 'filled', header: tr('trade.deal.colFilled'), align: 'right', render: (o) => <span className="num">{qtyText(o.filledQty)}</span> },
        { key: 'state', header: tr('trade.deal.colState'), render: (o) => tr(STATE_KEY[o.state]) },
      ]}
    />
  );
}

export { padTwo };

export const qtyText = (v: number | string): string => padTwo(qtyGrouped(v));
export const usdText = (v: number): string => fmtUsd(v, 0);

export function feeText(fees: { readUsd: number; estUsd: number; est: boolean; totalUsd?: number }): string {
  const total = fees.totalUsd ?? fees.readUsd + fees.estUsd;
  if (!fees.est) return usdText(total);
  if (fees.readUsd <= 0) return t('trade.twap.run.feeEstOnly', { total: usdText(total) });
  return t('trade.twap.run.feeTotal', { total: usdText(total), read: usdText(fees.readUsd), est: usdText(fees.estUsd) });
}

export function clockSpan(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

export function leftText(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export const sideWord = (side: 'LONG' | 'SHORT'): string => t(side === 'LONG' ? 'trade.deal.long' : 'trade.deal.short');

export function SideText({ side }: { side: 'LONG' | 'SHORT' }) {
  return (
    <Chip sm tone={side === 'LONG' ? 'green' : 'red'}>
      {sideWord(side)}
    </Chip>
  );
}

export function SlipLabel({ label }: { label: string }) {
  return (
    <HoverCard label={label} widthPx={260}>
      {t('trade.deal.slippageHint')}
    </HoverCard>
  );
}

export const HOLD_IN_ROW = 'h-9 !py-0 !text-[12px] !font-medium';

export type RunShape = 'pairOpen' | 'pairClose' | 'singleOpen' | 'singleClose';

export function runShapeOf(job: RebalanceJob) {
  const legs = job.legs ?? [];
  const makerIdx = job.twap?.makerLeg === 'b' ? 1 : 0;
  const maker = legs[makerIdx];
  const hedge = legs.length > 1 ? legs[1 - makerIdx] : undefined;
  const coin = legs[0]?.symbol ? parseSymbol(legs[0].symbol).base : '';
  const close = maker?.reduceOnly ?? false;
  const shape: RunShape = hedge ? (close ? 'pairClose' : 'pairOpen') : close ? 'singleClose' : 'singleOpen';
  const side = maker ? sideWord(maker.side).toLowerCase() : '';
  return { legs, makerIdx, maker, hedge, coin, close, shape, side };
}

function DealReadFailed({ onRetry }: { onRetry: () => void }) {
  const { t: tr } = useTranslation();
  return (
    <div role="alert" className="flex items-center justify-between gap-2 text-[12px] text-rose-300">
      <span>{tr('trade.twap.run.dealReadFailed')}</span>
      <button type="button" className="btn" onClick={onRetry}>
        {tr('common.retry')}
      </button>
    </div>
  );
}

export function SliceGraph({ childId, oneLeg }: { childId: string; oneLeg: boolean }) {
  const view = useDealView(childId);
  const pair = view.data?.pair;
  const proj = view.data?.projection;
  if ((!pair || !proj) && view.isError) return <DealReadFailed onRetry={() => void view.refetch()} />;
  if (!pair || !proj) return <Skeleton className="h-40 w-full" />;
  const open = proj.makerOrder?.state === 'OPEN' ? proj.makerOrder : null;
  const owed = Number(pair.targetQty) - Number(proj.bReserved);
  return (
    <DealBookImpact
      makerContract={pair.a.contract}
      makerSide={pair.a.side}
      hedgeContract={oneLeg ? null : (pair.b?.contract ?? null)}
      limitPrice={open?.price ?? pair.limitPrice}
      limitQty={open?.qty ?? proj.residualA}
      hedgeQty={pair.b && owed > 0 ? String(owed) : null}
    />
  );
}

export function SlicePriceBox({ child }: { child: TwapChildView }) {
  const { t: tr } = useTranslation();
  const view = useDealView(child.id);
  const repeg = useDealCommand('repeg');
  const [typed, setTyped] = useState<string | null>(null);
  const pair = view.data?.pair;
  if (!pair && view.isError) return <DealReadFailed onRetry={() => void view.refetch()} />;
  if (!pair) return <Skeleton className="h-14 w-full" />;
  const decimals = decimalsOf(pair.a.tick);
  const venue = prettyVenue(parseSymbol(pair.a.contract).exchange);
  const best =
    child.bestPrice !== null && child.behindPct !== null
      ? tr(child.side === 'BUY' ? 'trade.twap.run.bestBid' : 'trade.twap.run.bestAsk', {
          price: num(Number(child.bestPrice), decimals),
          n: num(child.behindPct * 100, 2),
        })
      : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(typed);
    if (typed === null || !Number.isFinite(n) || n <= 0) return;
    const price = formatRestPrice(n, child.side, pair.a.contract, pair.a.tick);
    if (Number(price) > 0) repeg.mutate({ id: child.id, body: { price } }, { onSuccess: () => setTyped(null) });
  };
  const toAuto = () => {
    setTyped(null);
    repeg.mutate({ id: child.id });
  };
  const error = repeg.error as { message: string } | null;
  return (
    <form onSubmit={submit} aria-label={tr('trade.twap.run.priceAria')} className="flex flex-col gap-1">
      <LimitPriceBox
        bookPrice={child.restPrice}
        value={typed}
        onChange={(price) => (price === null ? toAuto() : setTyped(price))}
        toBest={toAuto}
        tick={pair.a.tick}
        label={
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{tr('trade.twap.run.priceBoxSlice', { i: child.slice, venue })}</span>
            {best && <span className="num text-[11px] text-ink-400">{best}</span>}
          </span>
        }
      />
      {error && <span className="text-[11px] text-rose-400">{localizeServerText(error.message)}</span>}
    </form>
  );
}

export function TwapActs({
  jobId,
  state,
  holds,
  borosHold,
}: {
  jobId: string;
  state: 'running' | 'halted';
  holds: { open: string; close: string } | null;
  borosHold: string | null;
}) {
  const { t: tr } = useTranslation();
  const pause = useRebalanceCommand('pause');
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const fix = useRebalanceFix();
  const pending = pause.isPending || resume.isPending || abandon.isPending || fix.isPending;
  const error = (pause.error ?? resume.error ?? abandon.error ?? fix.error) as { message: string } | null;
  return (
    <div className="flex flex-col gap-2">
      {holds && (
        <>
          <HoldToConfirmButton tone="cyan" disabled={pending} onConfirm={() => fix.mutate({ id: jobId, action: 'market' })}>
            {holds.open}
          </HoldToConfirmButton>
          <HoldToConfirmButton tone="outline" disabled={pending} onConfirm={() => fix.mutate({ id: jobId, action: 'unwind' })}>
            {holds.close}
          </HoldToConfirmButton>
        </>
      )}
      {borosHold && (
        <HoldToConfirmButton tone="cyan" disabled={pending} onConfirm={() => fix.mutate({ id: jobId, action: 'boros-retry' })}>
          <span className="num">{borosHold}</span>
        </HoldToConfirmButton>
      )}
      <div className="flex flex-col gap-2">
        {state === 'running' ? (
          <button type="button" className="btn" disabled={pending} onClick={() => pause.mutate(jobId)}>
            {tr('trade.twap.run.pause')}
          </button>
        ) : holds === null && borosHold === null ? (
          <button type="button" className="btn-primary" disabled={pending} onClick={() => resume.mutate(jobId)}>
            {tr('trade.twap.run.resume')}
          </button>
        ) : null}
        <HoldToConfirmButton tone="outline" className={HOLD_IN_ROW} disabled={pending} onConfirm={() => abandon.mutate(jobId)}>
          {tr('trade.twap.run.holdStop')}
        </HoldToConfirmButton>
      </div>
      {error && <span className="text-[11px] text-rose-400">{localizeServerText(error.message)}</span>}
    </div>
  );
}
