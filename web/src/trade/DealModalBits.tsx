import { useState, type FormEvent, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useDealCommand, useVenueBook } from '../api/queries';
import type { DealPair, DealReport, DealView, RunOrderView } from '../api/types';
import { Chip } from '../components/Chip';
import { ResultBox } from '../components/ResultBox';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Spinner } from '../components/Spinner';
import { fmtPct, num, parseSymbol, prettyVenue, sigGrouped } from '../lib/fmt';
import { decimalsOf, formatRestPrice } from '../lib/ticks';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { dealSlippage } from './dealSlippage';
import { LimitPriceBox } from './LimitPriceBox';
import { DealBookImpact } from './PriceImpactGraph';
import { toResultRows, type RunRow, type RunViewProps } from './RunView';
import { clockSpan, feeText, padTwo, qtyText, sideWord, SideText, SlipLabel, usdText } from './RunViewBits';

function venueReasonText(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { label?: unknown; message?: unknown };
    const label = typeof j.label === 'string' ? j.label : '';
    const message = typeof j.message === 'string' ? j.message : '';
    const text = [label, message].filter(Boolean).join(' — ');
    return text || raw;
  } catch {
    return raw;
  }
}

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function remainderQty(target: string, done: string): string | null {
  const t = Number(target);
  const d = Number(done);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return null;
  const r = t - d;
  return r > 0 ? String(+r.toFixed(10)) : null;
}


const venueOf = (contract: string): string => prettyVenue(parseSymbol(contract).exchange);

function DealPriceBox({ pair, restPrice }: { pair: DealPair; restPrice: string | null }) {
  const { t } = useTranslation();
  const book = useVenueBook(pair.a.contract, true);
  const repeg = useDealCommand('repeg');
  const [typed, setTyped] = useState<string | null>(null);
  const decimals = decimalsOf(pair.a.tick);
  const buy = pair.a.side === 'BUY';
  const best = book.data ? (buy ? book.data.bestBid : book.data.bestAsk) : null;
  const rest = Number(restPrice);
  const behind =
    best !== null && best > 0 && Number.isFinite(rest) && rest > 0 ? (Math.max(0, buy ? best - rest : rest - best) / best) * 100 : null;
  const toAuto = () => {
    setTyped(null);
    repeg.mutate({ id: pair.id });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(typed);
    if (typed === null || !Number.isFinite(n) || n <= 0) return;
    const price = formatRestPrice(n, pair.a.side, pair.a.contract, pair.a.tick);
    if (Number(price) > 0) repeg.mutate({ id: pair.id, body: { price } }, { onSuccess: () => setTyped(null) });
  };
  const error = repeg.error as { message: string } | null;
  return (
    <form onSubmit={submit} aria-label={t('trade.deal.customAria')} className="flex flex-col gap-1">
      <LimitPriceBox
        bookPrice={restPrice}
        value={typed}
        onChange={(price) => (price === null ? toAuto() : setTyped(price))}
        toBest={toAuto}
        tick={pair.a.tick}
        label={
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{t('trade.twap.run.priceBoxDeal', { venue: venueOf(pair.a.contract) })}</span>
            {best !== null && behind !== null && (
              <span className="num text-[11px] text-ink-400">
                {t(buy ? 'trade.twap.run.bestBid' : 'trade.twap.run.bestAsk', { price: num(best, decimals), n: num(behind, 2) })}
              </span>
            )}
          </span>
        }
      />
      {error && <span className="text-[11px] text-rose-400">{localizeServerText(error.message)}</span>}
    </form>
  );
}

function DealActs({ dealId, mode, nothingRests }: { dealId: string; mode: DealPair['mode']; nothingRests: boolean }) {
  const { t } = useTranslation();
  const convert = useDealCommand('convert');
  const stop = useDealCommand('stop');
  const resume = useDealCommand('resume');
  const pending = convert.isPending || stop.isPending || resume.isPending;
  const error = (convert.error ?? stop.error ?? resume.error) as { message: string; hint?: string } | null;
  const holdStop = (
    <HoldToConfirmButton tone="outline" compact disabled={pending} onConfirm={() => stop.mutate({ id: dealId })}>
      {t('trade.twap.run.holdStop')}
    </HoldToConfirmButton>
  );
  return (
    <div className="flex flex-col gap-2">
      {mode === 'HALTED' ? (
        <button type="button" className="btn-primary" disabled={pending} title={t('trade.deal.resumeTitle')} onClick={() => resume.mutate({ id: dealId })}>
          {t('trade.deal.resume')}
        </button>
      ) : mode === 'OPENING' ? (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn" disabled={pending} title={t(nothingRests ? 'trade.deal.convertTitleNoRest' : 'trade.deal.convertTitle')} onClick={() => convert.mutate({ id: dealId })}>
            {t('trade.deal.convertNow')}
          </button>
          {holdStop}
        </div>
      ) : (
        holdStop
      )}
      {error && (
        <p role="alert" className="text-[12px] text-rose-300">
          {error.message}
          {error.hint ? <span className="text-ink-400"> {error.hint}</span> : null}
        </p>
      )}
    </div>
  );
}

const positionSide = (leg: { side: 'BUY' | 'SELL'; reduceOnly?: boolean }): 'LONG' | 'SHORT' =>
  (leg.side === 'BUY') !== (leg.reduceOnly === true) ? 'LONG' : 'SHORT';

export function dealTitle(pair: DealPair): string {
  const coin = parseSymbol(pair.a.contract).base;
  const close = pair.a.reduceOnly === true;
  const key = pair.b ? (close ? 'titlePairClose' : 'titlePairOpen') : close ? 'titleSingleClose' : 'titleSingleOpen';
  const market = pair.limitPrice === null ? 'Market' : '';
  return t(`trade.deal.${key}${market}`, { coin, side: sideWord(positionSide(pair.a)).toLowerCase() });
}

export function dealRunProps(
  view: DealView,
  report: DealReport | null,
  now: number,
  extraLines: ReactNode[],
): RunViewProps {
  const { pair, projection: proj, orders } = view;
  const { b } = pair;
  const coin = parseSymbol(pair.a.contract).base;
  const close = pair.a.reduceOnly === true;
  const total = Number(pair.targetQty);
  const aFilled = Number(proj.aFilled);
  const bFilled = Number(proj.bFilled);
  const unhedged = Number(proj.unhedged);
  const avgOf = (leg: 'A' | 'B'): number => {
    const reported = leg === 'A' ? report?.aAvgFill : report?.bAvgFill;
    const live = leg === 'A' ? view.avgPrice.a : view.avgPrice.b;
    const value = reported ?? live;
    return value != null ? Number(value) : NaN;
  };
  const avgA = avgOf('A');
  const avgB = avgOf('B');
  const refPrice = Number.isFinite(avgA) ? avgA : Number(pair.limitPrice);
  const usdOf = (qty: number): string => (Number.isFinite(refPrice) ? usdText(qty * refPrice) : '');
  const { fees } = view;
  const legs = [
    { name: venueOf(pair.a.contract), side: positionSide(pair.a), avg: avgA, filled: aFilled },
    ...(b ? [{ name: venueOf(b.contract), side: positionSide(b), avg: avgB, filled: bFilled }] : []),
  ];
  const withUsd = (qty: number) => {
    const usd = usdOf(qty);
    return t(usd ? 'trade.twap.run.filledEachValue' : 'trade.twap.run.filledEachValueNoUsd', { done: qtyText(qty), total: qtyText(total), coin, usd });
  };
  const filledRows = (): RunRow[] =>
    b && aFilled !== bFilled
      ? legs.map((leg) => ({ label: t('trade.twap.run.filledVenue', { venue: leg.name }), value: withUsd(leg.filled) }))
      : [{ label: t('trade.twap.run.filledEach'), value: withUsd(aFilled) }];
  const avgRows = (): RunRow[] =>
    legs
      .filter((leg) => Number.isFinite(leg.avg))
      .map((leg) => ({ label: t('trade.twap.run.avgVenue', { venue: leg.name }), value: padTwo(sigGrouped(leg.avg)) }));
  const slippageRow = (label: string): RunRow[] => {
    const qty = Math.min(aFilled, bFilled);
    const buyIsA = pair.a.side === 'BUY';
    const slip = b ? dealSlippage({ longAvg: buyIsA ? avgA : avgB, shortAvg: buyIsA ? avgB : avgA, qty, close }) : null;
    if (!slip) return [];
    const sign = slip.usd >= 0 ? '+' : '−';
    const amount = `${sign}${sigGrouped(Math.abs(slip.usd / qty))}`;
    const pct = `${sign}${fmtPct(Math.abs(slip.pct), 3)}`;
    const word = t(slip.word === 'Favorable' ? 'trade.deal.favorable' : 'trade.deal.adverse');
    return [{ label: <SlipLabel label={label} />, value: `${t('trade.twap.run.slippageValue', { amount, pct })} ${word}`, tone: slip.usd >= 0 ? 'gain' : 'loss' }];
  };
  const gapRow = (qty: number): RunRow[] =>
    b ? [{ label: t('trade.twap.run.notHedged'), value: qty > 0 ? `${qtyText(qty)} ${coin}${usdOf(qty) ? ` (${usdOf(qty)})` : ''}` : `0 ${coin}` }] : [];

  const done = pair.mode === 'DONE';
  const opening = pair.mode === 'OPENING';
  const tone = pair.mode === 'HALTED' ? 'red' : pair.mode === 'OPENING' ? 'info' : 'amber';
  const chip = done ? (
    <Chip>{t('common.done')}</Chip>
  ) : opening ? (
    <Chip tone="info">{t('common.running')}</Chip>
  ) : (
    <Chip tone={tone}>{t(pair.mode === 'HALTED' ? 'trade.deal.modeHalted' : pair.mode === 'CONVERTING' ? 'trade.deal.modeConverting' : 'trade.deal.modeStopping')}</Chip>
  );
  const title = (
    <span className="num text-[11px] font-normal text-ink-400">
      {legs.map((leg, i) => (
        <span key={leg.name}>
          {i > 0 && ' / '}
          {leg.name} <SideText side={leg.side} />
        </span>
      ))}
    </span>
  );

  const lines: ReactNode[] = [];
  if (proj.anyPending || proj.anyQuarantined) {
    lines.push(
      <span className="text-amber-300">
        <Spinner className="inline h-3 w-3" /> {t('trade.deal.resolving')}
      </span>,
    );
  }
  const latestReason = [...orders].sort((x, y) => y.createdAt - x.createdAt).find((o) => o.venueReason);
  if (latestReason) lines.push(<span className="text-ink-400">{venueReasonText(latestReason.venueReason)}</span>);
  const refused = view.repegRefused ?? null;
  if (refused) lines.push(<span className="text-amber-300">{t('trade.twap.run.repegRefused', { venue: prettyVenue(refused) })}</span>);
  if (report && /crossing the market/i.test(report.reason)) {
    lines.push(
      <span role="alert" className="block rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 leading-relaxed text-amber-200">
        <Trans i18nKey="trade.deal.crossed" components={{ b: <span className="font-semibold" /> }} />
      </span>,
    );
  }
  if (done && report && !/^(done|filled|target reached)$/i.test(report.reason)) lines.push(upperFirst(localizeServerText(report.reason)));
  lines.push(...extraLines);

  const runOrders: RunOrderView[] = [...orders]
    .sort((x, y) => y.createdAt - x.createdAt)
    .map((o) => ({
      venue: venueOf(o.leg === 'A' ? pair.a.contract : (b?.contract ?? pair.a.contract)),
      leg: o.leg,
      kind: o.kind,
      slice: null,
      price: o.price,
      qty: o.qty,
      filledQty: o.cumQty,
      state: o.state,
      createdAt: o.createdAt,
    }));
  const progress =
    total > 0 ? ({ ratio: aFilled / total, tone: done ? 'done' : pair.mode === 'HALTED' ? 'stopped' : 'running' } as const) : null;
  const base = { title, chip, progress, orders: runOrders, lines };

  if (done) {
    const usd = usdOf(aFilled);
    const doneTitle = t(`trade.twap.run.${close ? 'doneClosed' : 'doneOpened'}${b ? '' : 'One'}${usd ? '' : 'NoUsd'}`, { qty: qtyText(aFilled), coin, usd });
    const rows: RunRow[] = [
      ...avgRows(),
      ...slippageRow(t('trade.deal.slippage')),
      ...(unhedged > 0 ? gapRow(unhedged) : []),
      { label: t('trade.twap.run.fees'), value: usdText(fees.readUsd + fees.estUsd) },
      { label: t('trade.twap.run.took'), value: clockSpan(Math.max(0, (view.endedAt ?? pair.createdAt) - pair.createdAt) / 1000) },
    ];
    const firstLine = <ResultBox tone={unhedged > 0 ? 'part' : 'done'} title={doneTitle} rows={toResultRows(rows)} />;
    return { ...base, chip: null, progress: null, firstLine, rows: [], graph: null, priceBox: null, acts: null, footer: false };
  }

  const rows: RunRow[] = [];
  if (opening && pair.deadlineAt !== null) {
    const left = pair.deadlineAt - now;
    const until = t('trade.deal.untilConvert', { time: left <= 0 ? t('trade.deal.now') : clockSpan(left / 1000) });
    rows.push(refused ? { label: until, value: '' } : { label: t('trade.twap.run.limitResting'), value: until });
  } else if (opening) {
    rows.push({ label: t(refused ? 'trade.twap.run.noMarketOrder' : 'trade.twap.run.noMarket'), value: '' });
  }
  rows.push(...filledRows(), ...avgRows(), ...slippageRow(t('trade.twap.run.slippageSoFar')), ...gapRow(unhedged), {
    label: t('trade.twap.run.feeSoFar'),
    value: feeText(fees),
  });
  const open = proj.makerOrder?.state === 'OPEN' ? proj.makerOrder : null;
  const restPrice = open?.price ?? pair.limitPrice;
  const graph = opening ? (
    <DealBookImpact
      makerContract={pair.a.contract}
      makerSide={pair.a.side}
      hedgeContract={b?.contract ?? null}
      limitPrice={restPrice}
      limitQty={refused ? null : (open?.qty ?? proj.residualA)}
      hedgeQty={remainderQty(pair.targetQty, proj.bReserved)}
    />
  ) : null;
  const priceBox = opening ? <DealPriceBox pair={pair} restPrice={restPrice} /> : null;
  const firstLine = pair.mode === 'HALTED' && pair.haltReason ? <span className="text-[12px] text-amber-300">{localizeServerText(pair.haltReason)}</span> : null;
  return { ...base, firstLine, rows, graph, priceBox, acts: <DealActs dealId={pair.id} mode={pair.mode} nothingRests={refused !== null} />, footer: true };
}
