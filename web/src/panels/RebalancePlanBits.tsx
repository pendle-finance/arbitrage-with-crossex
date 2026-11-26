import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import type { EvenPlan, Pool, RebalanceBucket, RoutePlan } from '../api/types';
import { Chip } from '../components/Chip';
import { microLabelClass } from '../components/Th';
import { t } from '../i18n';
import { fmtUsd, num } from '../lib/fmt';
import { shownSteps, StepList, type StepRow } from './RebalanceBits';
import { HOVER, modalFeeLabel, modalImpactLabel, poolKey, WALLET_LABEL } from './rebalanceCopy';
import { costPartsUsd, daysText, paybackDays, Term, WORTH_IT_DAYS, worthChip } from './RebalanceHovers';

export const realizeText = (key: string, values?: Record<string, string | number>): string =>
  t(`accounts.rebalanceRealize.${key}` as 'accounts.rebalanceRealize.howItRuns', values);

const rk = realizeText;

export function refusalOf(plan: EvenPlan): { title: string; body: string } | null {
  const refused = plan.realize?.refused;
  if (!refused) return null;
  const wallet = WALLET_LABEL['USDT/CROSSEX'];
  if (refused.reason === 'no-fee-rate') return { title: rk('feeRateTitle'), body: rk('feeRateBody') };
  if (refused.reason === 'no-margin') return { title: rk('marginTitle'), body: rk('marginBody', { wallet }) };
  if (refused.reason === 'past-book') return { title: rk('bookTitle'), body: rk('bookBody') };
  return { title: rk('capTitle', { cap: fmtUsd(refused.capUsd ?? 0, 0) }), body: rk('capBody') };
}

export interface CostRow {
  label: string;
  usd: number;
  strong?: boolean;
  hover?: string;
}

export function legacyCostOf(plan: EvenPlan, route: RoutePlan, buckets: RebalanceBucket[]): { rows: CostRow[]; chip: ReactNode; daysLine: string | null } {
  const kind = worthChip(plan, route, buckets);
  const days = paybackDays(plan, route, buckets);
  const { feeUsd, impactUsd, totalUsd } = costPartsUsd(plan, route);
  const rows: CostRow[] = [
    { label: modalFeeLabel(), usd: feeUsd },
    ...(impactUsd > 0 ? [{ label: modalImpactLabel(), usd: impactUsd, hover: HOVER.priceImpact }] : []),
    { label: rk('totalCost'), usd: totalUsd, strong: true },
  ];
  const chip = kind === null ? null : <Chip tone={kind === 'worth' ? 'info' : 'amber'} sm>{rk(kind === 'worth' ? 'worthIt' : 'notWorthItYet')}</Chip>;
  const daysLine = kind !== null && days !== null ? rk('daysLine', { days: daysText(days), max: num(WORTH_IT_DAYS, 0) }) : null;
  return { rows, chip, daysLine };
}

export function TotalCost({ rows, chip }: { rows: CostRow[]; chip?: ReactNode }) {
  return (
    <div className="card flex flex-col gap-1.5 p-3 text-xs">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-50">
        {t('accounts.moveCash.cost')}
        {chip}
      </div>
      {rows.map((row) => (
        <div
          key={row.label}
          className={`flex items-center justify-between gap-3 ${row.strong ? 'mt-0.5 border-t border-ink-800 pt-1.5 font-semibold text-ink-50' : 'text-ink-300'}`}
        >
          <span>{row.hover ? <Term label={row.label} text={row.hover} /> : row.label}</span>
          <span className={`num ${row.strong ? 'font-semibold text-ink-50' : 'text-ink-100'}`}>{fmtUsd(row.usd)}</span>
        </div>
      ))}
    </div>
  );
}

export function NotHedgedLine({ text }: { text: string }) {
  return (
    <p className="num flex items-center gap-2 text-xs text-gold">
      <TriangleAlert size={14} aria-hidden className="shrink-0" />
      {text}
    </p>
  );
}

export const walletOf = (pool: Pool): string => WALLET_LABEL[poolKey(pool)] ?? pool;

export function stepsHoverOf(rounds: number, held: number | null): string | null {
  if (rounds === 0) return null;
  return [HOVER.round, held === null ? HOVER.whyMoreThanOne : HOVER.whyMoreThanOneBorrow(fmtUsd(held))].join(' ');
}

const STEPS_OPEN_UP_TO = 3;
const STEPS_FOLDED = 2;

export function StepsFold({ open, onToggle, hover, rows }: { open: boolean; onToggle: () => void; hover: string | null; rows: StepRow[] }) {
  const { t } = useTranslation();
  const folds = rows.length > STEPS_OPEN_UP_TO;
  const limit = folds && !open ? STEPS_FOLDED : null;
  const hidden = rows.length - shownSteps(rows, limit).length;
  const label = t('accounts.rebalanceModal.steps');
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`flex items-center justify-between gap-3 pr-3 ${microLabelClass}`}>
        {hover === null ? <span>{label}</span> : <Term label={label} text={hover} />}
        <span>{t('accounts.rebalanceModal.time')}</span>
      </div>
      <StepList rows={rows} limit={limit} />
      {folds && (
        <button type="button" className="btn-link self-start text-xs" aria-expanded={open} onClick={onToggle}>
          {open ? t('accounts.rebalanceModal.fewerSteps') : t('accounts.rebalanceModal.moreSteps', { count: hidden, n: num(hidden, 0) })}
        </button>
      )}
    </div>
  );
}
