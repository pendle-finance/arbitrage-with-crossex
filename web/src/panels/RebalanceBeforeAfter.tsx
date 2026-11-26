import { ArrowRight } from 'lucide-react';
import type { EvenPlan, RebalanceBucket, RebalanceView, RoutePlan, WalletAfter } from '../api/types';
import { microLabelClass } from '../components/Th';
import { t } from '../i18n';
import { borrowingBuckets } from '../lib/borrow';
import { fmtPct, fmtUsd, sigGrouped } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { borrowLeftOf, interestAfterOf, isRateUnknown, keyOf, MONTH_DAYS, Term, WalletTerm } from './RebalanceHovers';
import { HOVER, hoverCash, modalFrees, sizeText, WALLET_LABEL } from './rebalanceCopy';

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

export function borrowRows(bucket: RebalanceBucket, left: number, freesUsd: number | null): ChangeRow[] {
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

const ROW = 'col-span-full grid grid-cols-subgrid items-center';

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
    <div role="row" className={ROW}>
      <span role="rowheader" className="min-w-0 pl-2.5 text-ink-300">
        {row.hover ? <Term label={row.label} text={row.hover} /> : row.label}
      </span>
      <span role="cell" data-column="before" className={`num text-right ${beforeTone}`}>
        {before}
      </span>
      <span className="flex justify-center text-ink-500">
        {before !== '' && <ArrowRight size={16} aria-hidden />}
      </span>
      <span role="cell" data-column="after" className={`num whitespace-nowrap text-right ${afterTone} ${changed ? 'font-semibold' : ''}`}>
        {row.suffix ? `${after} ${row.suffix}` : after}
      </span>
    </div>
  );
}

export function RebalanceBeforeAfter({ rows, mode, footer }: { rows: WalletChange[]; mode: 'after' | 'now'; footer?: string | null }) {
  if (rows.length === 0) return null;
  const afterHead = mode === 'after' ? t('accounts.rebalanceRealize.after') : t('accounts.rebalanceRealize.now');
  return (
    <div role="table" className="card grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2 gap-y-2 p-3 text-xs">
      {mode === 'after' && (
        <div role="caption" className="col-span-full text-[14px] font-semibold text-ink-50">
          {t('accounts.moveCash.after')}
        </div>
      )}
      {rows.map((group, index) => (
        <div key={group.key} role="rowgroup" aria-label={group.label} className={`col-span-full grid grid-cols-subgrid gap-y-2 ${index > 0 ? 'mt-2' : ''}`}>
          <div role="row" className={ROW}>
            <span role="rowheader" className="min-w-0 font-semibold text-ink-400">
              {WALLET_LABEL[group.key] ? <WalletTerm wallet={group.key} /> : group.label}
            </span>
            {index === 0 && (
              <>
                <span role="columnheader" className={`text-right ${microLabelClass}`}>{t('accounts.rebalanceRealize.before')}</span>
                <span />
                <span role="columnheader" className={`text-right ${microLabelClass}`}>{afterHead}</span>
              </>
            )}
          </div>
          {group.rows.map((row, i) => (
            <Line key={`${i}:${row.label}`} row={row} />
          ))}
        </div>
      ))}
      {footer && <div className="num col-span-full text-ink-400">{footer}</div>}
    </div>
  );
}
