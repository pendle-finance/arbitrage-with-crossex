import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import type { EvenPlan, Pool, RebalanceBucket, RoutePlan } from '../api/types';
import { Chip } from '../components/Chip';
import { t } from '../i18n';
import { fmtUsd, num } from '../lib/fmt';
import { StepList, type StepRow } from './RebalanceBits';
import { planActionLeg, RealizeActions, RealizeRow } from './RebalanceRealizeBits';
import { HOVER, modalFeeLabel, modalImpactLabel, modalSteps, poolCoin, poolKey, WALLET_LABEL } from './rebalanceCopy';
import { daysText, paybackDays, planSteps, totalCostUsd, WORTH_IT_DAYS, worthChip } from './RebalanceHovers';
import { realizeFeeUsd, realizeImpactUsd, routeFeeUsd, routeImpactUsd, Term } from './RebalanceHovers';

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

export function ImpactLabel() {
  return <Term label={modalImpactLabel()} text={HOVER.priceImpact} />;
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
  const impact = realizeImpactUsd(plan) + routeImpactUsd(route);
  const rows: CostRow[] = [
    { label: modalFeeLabel(), usd: realizeFeeUsd(plan) + routeFeeUsd(route) },
    ...(impact > 0 ? [{ label: modalImpactLabel(), usd: impact, hover: HOVER.priceImpact }] : []),
    { label: rk('totalCost'), usd: totalCostUsd(plan, route), strong: true },
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

export const STEPS_HEAD = 'text-xs font-semibold text-ink-50';

export function HowItRuns({ plan, route, lead, children }: { plan: EvenPlan; route: RoutePlan; lead?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const realizeLegs = plan.realize?.refused ? [] : (plan.realize?.legs ?? []);
  const realizeRows = realizePools(realizeLegs).map(({ pool, legs }): StepRow => {
    const actionLegs = legs.map(planActionLeg);
    const amount = { amount: num(legs.reduce((total, leg) => total + leg.realizedUsd, 0), 0), coin: poolCoin(pool) };
    const body = (
      <div className="mt-1.5 flex flex-col gap-1.5">
        <RealizeRow legs={actionLegs} />
        <RealizeActions legs={actionLegs} open={open} onToggle={() => setOpen(!open)} tense="plan" />
      </div>
    );
    return { key: `realize:${pool}`, label: '', text: rk('realizeTitle', amount), sub: walletOf(pool), right: '', state: 'pending', progress: null, body };
  });
  const moves = planSteps(plan);
  const moved = route.steps.reduce((total, step) => total + step.move, 0);
  const converts = realizeLegs.some((leg) => leg.convert !== null);
  const moveRows: StepRow[] = moves.length === 0 ? [] : [{
    key: 'move',
    label: '',
    text: moveTitle(converts, 'plan', moved > 0 ? moved : plan.moves, poolCoin(moves[0]!.from)),
    sub: <MovePath {...routePools(moves)} />,
    right: '',
    state: 'pending',
    progress: null,
    body: <div className="mt-2 flex flex-col gap-2">{children}</div>,
  }];
  return (
    <div className="flex flex-col gap-3">
      <div className={STEPS_HEAD}>{rk('howItRuns')}</div>
      {lead}
      <StepList rows={[...realizeRows, ...moveRows]} />
    </div>
  );
}

export const walletOf = (pool: Pool): string => WALLET_LABEL[poolKey(pool)] ?? pool;

export function realizePools<T extends { pool: Pool }>(legs: readonly T[]): { pool: Pool; legs: T[] }[] {
  const pools = [...new Set(legs.map((leg) => leg.pool))];
  return pools.map((pool) => ({ pool, legs: legs.filter((leg) => leg.pool === pool) }));
}

const MOVE_TITLE = {
  plan: { other: 'moveOther', all: 'moveAmount' },
  running: { other: 'movingOther', all: 'movingAmount' },
  done: { other: 'movedOther', all: 'movedAmount' },
} as const;

export function moveTitle(converts: boolean, tense: keyof typeof MOVE_TITLE, amount: number, coin: string): string {
  return rk(MOVE_TITLE[tense][converts ? 'other' : 'all'], { amount: num(amount, 0), coin });
}

export function MovePath({ from, to }: { from: Pool[]; to: Pool[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {from.map(walletOf).join(' + ')}
      <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-500" />
      {to.map(walletOf).join(' + ')}
    </span>
  );
}

export const routePools = (steps: readonly { from: Pool; to: Pool }[]) => ({
  from: [...new Set(steps.map((step) => step.from))],
  to: [...new Set(steps.map((step) => step.to))],
});

export function stepsHoverOf(rounds: number, held: number | null): string | null {
  if (rounds === 0) return null;
  return [HOVER.round, held === null ? HOVER.whyMoreThanOne : HOVER.whyMoreThanOneBorrow(fmtUsd(held))].join(' ');
}

export function StepsFold({ open, onToggle, hover, rows }: { open: boolean; onToggle: () => void; hover: string | null; rows: StepRow[] }) {
  const { t } = useTranslation();
  const toggle = (
    <button type="button" className="btn-link inline-flex items-center gap-1" aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      {open ? t('accounts.rebalanceModal.hideSteps') : modalSteps()}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <span className="self-start">{hover === null ? toggle : <Term wrapsControl label={toggle} text={hover} />}</span>
      {open && <StepList rows={rows} />}
    </div>
  );
}
