import type { ReactNode } from 'react';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { useTranslation } from 'react-i18next';
import type { EvenPlan, GoalKind, RebalanceBucket, RoutePlan } from '../api/types';
import { VerdictAlert } from './RebalanceBits';
import { legacyCostOf, TotalCost, type CostRow } from './RebalancePlanBits';
import { HOLD_LABEL, modalRefreshRoute } from './rebalanceCopy';
import type { worthLine } from './RebalanceHovers';

interface FooterBase {
  optional: boolean;
  stale: boolean;
  quoteStale?: boolean;
  lock: string | null;
  pricing: boolean;
  disabled: boolean;
  holdMs?: number;
  onRefresh: () => void;
  onConfirm: () => void;
}

interface PlanFooter {
  plan: EvenPlan;
  route: RoutePlan;
  buckets: RebalanceBucket[];
  goal: GoalKind;
  chosen: string | null;
  worth: ReturnType<typeof worthLine>;
  worthAlert: boolean;
}

interface RowsFooter {
  rows: CostRow[];
  holdLabel: ReactNode;
  verdict?: ReactNode;
}

type FooterProps = FooterBase & (PlanFooter | RowsFooter);

function contentOf(props: PlanFooter | RowsFooter) {
  if ('rows' in props) {
    return { verdict: props.verdict ?? null, rows: props.rows, chip: null, daysLine: null, holdLabel: props.holdLabel };
  }
  const { plan, route, buckets, goal, chosen, worth, worthAlert } = props;
  const cost = chosen === null ? { rows: [], chip: null, daysLine: null } : legacyCostOf(plan, route, buckets);
  const verdict =
    worth !== null && worthAlert ? (
      <VerdictAlert tone={worth.tone === 'act' ? 'recommend' : worth.tone} text={worth.text} sub={worth.sub} />
    ) : null;
  return { verdict, ...cost, holdLabel: HOLD_LABEL[goal] };
}

export function RebalanceModalFooter(props: FooterProps) {
  const { optional, stale, quoteStale = false, lock, pricing, disabled, holdMs, onRefresh, onConfirm } = props;
  const { t } = useTranslation();
  const { verdict, rows, chip, daysLine, holdLabel } = contentOf(props);
  return (
    <div className="sticky -bottom-5 z-10 -mb-5 flex flex-col gap-3 border-t border-ink-800 bg-ink-950 pb-5 pt-3">
      {verdict}
      {rows.length > 0 && <TotalCost rows={rows} chip={chip} />}
      {daysLine !== null && <span className="num text-xs text-ink-400">{daysLine}</span>}
      {lock !== null ? (
        <p className="text-xs text-ink-400">{lock}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {quoteStale ? (
            <button type="button" className="btn btn-primary w-full" onClick={onRefresh}>
              {t('accounts.rebalanceModal.refreshQuote')}
            </button>
          ) : stale ? (
            <button type="button" className="btn btn-primary num" onClick={onRefresh}>
              {modalRefreshRoute()}
            </button>
          ) : (
            <HoldToConfirmButton
              tone={optional ? 'outline' : 'cyan'}
              className="w-full"
              holdMs={holdMs}
              disabled={disabled}
              onConfirm={onConfirm}
            >
              {pricing ? t('common.refreshing') : holdLabel}
            </HoldToConfirmButton>
          )}
        </div>
      )}
    </div>
  );
}
