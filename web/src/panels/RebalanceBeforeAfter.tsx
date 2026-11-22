import { ArrowRight } from 'lucide-react';
import type { EvenPlan, PerpSize, RebalanceBucket, RebalanceJob, RebalanceView, RoutePlan, WalletAfter } from '../api/types';
import { microLabelClass } from '../components/Th';
import { t } from '../i18n';
import { borrowingBuckets } from '../lib/borrow';
import { fmtPct, fmtUsd, parseSymbol, prettyVenue, sigGrouped } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { borrowLeftOf, interestAfterOf, isRateUnknown, keyOf, MONTH_DAYS, Term, WalletTerm } from './RebalanceHovers';
import { HOVER, hoverCash, modalFrees, sideText, sizeText, WALLET_LABEL } from './rebalanceCopy';
import { lots, walletsNow } from './rebalanceJobSteps';

export interface ChangeRow {
  label: string;
  before: number | null;
  after: number;
  unit: 'usd' | 'coin' | 'pct' | 'text';
  coin?: string;
  hover?: string;
  suffix?: string;
  text?: { before: string; after: string };
}

export interface WalletChange {
  key: string;
  label: string;
  rows: ChangeRow[];
}

const moved = (a: number, b: number): boolean => floorCents(Math.abs(a - b)) > 0;

const freedWeight = (bucket: RebalanceBucket, left: number): number =>
  bucket.borrow > 0 ? ((bucket.borrow - left) * bucket.imHeldUsd) / bucket.borrow : 0;

function borrowRows(bucket: RebalanceBucket, left: number, freesUsd: number | null): ChangeRow[] {
  const interest: ChangeRow[] = isRateUnknown(bucket)
    ? []
    : [{
        label: t('accounts.rebalanceRealize.interestMonth'),
        before: bucket.interestPerDayUsd * MONTH_DAYS,
        after: interestAfterOf(bucket, left) * MONTH_DAYS,
        unit: 'usd',
        hover: HOVER.interestMonth,
      }];
  const frees: ChangeRow[] =
    freesUsd === null ? [] : [{ label: modalFrees(), before: null, after: freesUsd, unit: 'usd', hover: HOVER.frees }];
  return [{ label: t('accounts.rebalanceRealize.borrow'), before: bucket.borrow, after: left, unit: 'coin' }, ...interest, ...frees];
}

function changesOf(buckets: RebalanceBucket[], after: WalletAfter[], freedUsd: number | null): WalletChange[] {
  const borrowing = borrowingBuckets(buckets).map(keyOf);
  const changed = after.flatMap((wallet) => {
    const bucket = buckets.find((b) => keyOf(b) === keyOf(wallet));
    if (!bucket || !(moved(bucket.equity, wallet.equity) || moved(bucket.cash, wallet.cash))) return [];
    return [{ bucket, wallet, left: borrowing.includes(keyOf(bucket)) ? borrowLeftOf(bucket, wallet) : null }];
  });
  const rank = (key: string): number => (borrowing.includes(key) ? borrowing.indexOf(key) : borrowing.length);
  const weights = changed.reduce((total, c) => total + (c.left === null ? 0 : freedWeight(c.bucket, c.left)), 0);
  return changed
    .sort((a, b) => rank(keyOf(a.bucket)) - rank(keyOf(b.bucket)))
    .map(({ bucket, wallet, left }) => {
      const key = keyOf(bucket);
      const frees = freedUsd === null || left === null ? null : weights > 0 ? (freedUsd * freedWeight(bucket, left)) / weights : 0;
      const equity: ChangeRow = {
        label: t('accounts.balances.equity'),
        before: bucket.equity,
        after: wallet.equity,
        unit: 'coin',
        hover: HOVER.rebalanceTitle.equity,
      };
      const pays = left === null && wallet.cash < bucket.cash && moved(bucket.cash, wallet.cash);
      const cash: ChangeRow[] = pays ? [{ label: hoverCash(), before: bucket.cash, after: wallet.cash, unit: 'coin' }] : [];
      return {
        key,
        label: WALLET_LABEL[key] ?? key,
        rows: [equity, ...(left === null ? cash : borrowRows(bucket, left, frees))],
      };
    });
}

export function walletChanges(view: RebalanceView, _plan: EvenPlan, route: RoutePlan): WalletChange[] {
  return changesOf(view.buckets, route.after, route.marginFreedUsd);
}

export function receiptChanges(job: RebalanceJob, buckets: RebalanceBucket[], live: PerpSize[] | null): WalletChange[] {
  const before = job.before?.buckets ?? buckets;
  const wallets = job.target ? changesOf(before, walletsNow(job, before), null) : [];
  const legs = job.realize?.legs ?? [];
  if (legs.length === 0) return wallets;
  const perps: WalletChange = { key: 'perps', label: t('accounts.rebalanceRealize.perps'), rows: perpRows(job, live ?? []) };
  return [...wallets, perps];
}

const perpLabel = (perp: Pick<PerpSize, 'exchange' | 'side'>): string => `${prettyVenue(perp.exchange)} ${sideText(perp.side)}`;

function perpRows(job: RebalanceJob, live: PerpSize[]): ChangeRow[] {
  const legs = job.realize?.legs ?? [];
  const before = job.before?.perps ?? [];
  const of = (list: PerpSize[], symbol: string) => list.find((perp) => perp.symbol === symbol);
  const paying = legs.map((leg): ChangeRow => {
    const reopened = job.steps.find((step) => step.name === 'Reopen' && step.perp?.symbol === leg.symbol)?.qty ?? 0;
    return {
      label: perpLabel(leg),
      before: of(before, leg.symbol)?.qty ?? leg.positionQty,
      after: of(live, leg.symbol)?.qty ?? lots(leg.positionQty - leg.filledQty + reopened),
      unit: 'coin',
      coin: leg.base,
    };
  });
  const bases = legs.map((leg) => leg.base);
  const hedges = [...before, ...live]
    .filter((perp, index, all) => all.findIndex((p) => p.symbol === perp.symbol) === index)
    .filter((perp) => bases.includes(parseSymbol(perp.symbol).base) && !legs.some((leg) => leg.symbol === perp.symbol))
    .map((perp): ChangeRow => ({
      label: perpLabel(perp),
      before: of(before, perp.symbol)?.qty ?? null,
      after: of(live, perp.symbol)?.qty ?? perp.qty,
      unit: 'coin',
      coin: parseSymbol(perp.symbol).base,
    }));
  return [...paying, ...hedges];
}

const COLUMN = 'w-28 shrink-0 text-right';

function valueText(row: ChangeRow, value: number): string {
  if (row.coin) return `${sizeText(value)} ${row.coin}`;
  if (row.unit === 'pct') return fmtPct(value, 1);
  return row.unit === 'usd' ? fmtUsd(value) : sigGrouped(value);
}

function textsOf(row: ChangeRow): { before: string; after: string; changed: boolean } {
  if (row.unit === 'text') {
    const before = row.text?.before ?? '';
    const after = row.text?.after ?? '';
    return { before, after, changed: before !== after };
  }
  const before = row.before === null ? '' : valueText(row, row.before);
  return { before, after: valueText(row, row.after), changed: row.before === null || moved(row.before, row.after) };
}

function Line({ row }: { row: ChangeRow }) {
  const { before, after, changed } = textsOf(row);
  const numeric = row.unit !== 'text';
  const beforeTone = numeric && row.before !== null && row.before < 0 ? 'text-rose-400' : 'text-ink-400';
  const afterTone = numeric && row.after < 0 ? 'text-rose-400' : changed ? 'text-ink-50' : 'text-ink-100';
  return (
    <div role="row" className="flex items-center gap-2">
      <span role="rowheader" className="min-w-0 flex-1 pl-2.5 text-ink-300">
        {row.hover ? <Term label={row.label} text={row.hover} /> : row.label}
      </span>
      <span role="cell" data-column="before" className={`num ${COLUMN} ${beforeTone}`}>
        {before}
      </span>
      <span className="flex w-4 shrink-0 justify-center text-ink-500">
        {before !== '' && <ArrowRight size={12} aria-hidden />}
      </span>
      <span role="cell" data-column="after" className={`num ${numeric ? COLUMN : 'shrink-0 whitespace-nowrap text-right'} ${afterTone} ${changed ? 'font-semibold' : ''}`}>
        {row.suffix ? `${after} ${row.suffix}` : after}
      </span>
    </div>
  );
}

export function RebalanceBeforeAfter({ rows, mode }: { rows: WalletChange[]; mode: 'after' | 'now' }) {
  if (rows.length === 0) return null;
  const afterHead = mode === 'after' ? t('accounts.rebalanceRealize.after') : t('accounts.rebalanceRealize.now');
  return (
    <div role="table" className="card flex flex-col gap-2 p-3 text-xs">
      {mode === 'after' && (
        <div role="caption" className="text-[14px] font-semibold text-ink-50">
          {t('accounts.moveCash.after')}
        </div>
      )}
      {rows.map((group, index) => (
        <div key={group.key} role="rowgroup" aria-label={group.label} className={`flex flex-col gap-2 ${index > 0 ? 'mt-2' : ''}`}>
          <div role="row" className="flex items-center gap-2">
            <span role="rowheader" className="min-w-0 flex-1 font-semibold text-ink-400">
              {WALLET_LABEL[group.key] ? <WalletTerm wallet={group.key} /> : group.label}
            </span>
            {index === 0 && (
              <>
                <span role="columnheader" className={`${COLUMN} ${microLabelClass}`}>{t('accounts.rebalanceRealize.before')}</span>
                <span className="w-4 shrink-0" />
                <span role="columnheader" className={`${COLUMN} ${microLabelClass}`}>{afterHead}</span>
              </>
            )}
          </div>
          {group.rows.map((row, i) => (
            <Line key={`${i}:${row.label}`} row={row} />
          ))}
        </div>
      ))}
    </div>
  );
}
