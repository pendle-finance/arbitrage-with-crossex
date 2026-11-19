import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { useTranslation } from 'react-i18next';
import type { EvenPlan, GoalKind, RebalanceBucket, RoutePlan } from '../api/types';
import { VerdictAlert } from './RebalanceBits';
import { TotalCost } from './RebalancePlanBits';
import { HOLD_LABEL, modalRefreshRoute } from './rebalanceCopy';
import type { worthLine } from './RebalanceHovers';

export function RebalanceModalFooter({
  plan, route, buckets, goal, chosen, worth, worthAlert, optional, stale, lock, pricing, disabled, holdMs, onRefresh, onConfirm,
}: {
  plan: EvenPlan;
  route: RoutePlan;
  buckets: RebalanceBucket[];
  goal: GoalKind;
  chosen: string | null;
  worth: ReturnType<typeof worthLine>;
  worthAlert: boolean;
  optional: boolean;
  stale: boolean;
  lock: string | null;
  pricing: boolean;
  disabled: boolean;
  holdMs?: number;
  onRefresh: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="sticky -bottom-5 z-10 -mb-5 flex flex-col gap-3 border-t border-ink-800 bg-ink-950 pb-5 pt-3">
      {worth !== null && worthAlert && <VerdictAlert tone={worth.tone} text={worth.text} sub={worth.sub} />}
      {chosen !== null && <TotalCost plan={plan} route={route} buckets={buckets} />}
      <div className="flex flex-wrap items-center gap-3">
        {stale ? (
          <button type="button" className="btn btn-primary num" onClick={onRefresh}>
            {modalRefreshRoute()}
          </button>
        ) : (
          <HoldToConfirmButton tone={optional ? 'outline' : 'cyan'} holdMs={holdMs} disabled={disabled} onConfirm={onConfirm}>
            {HOLD_LABEL[goal]}
          </HoldToConfirmButton>
        )}
        {lock !== null && <span className="text-xs text-ink-500">{lock}</span>}
        {lock === null && pricing && <span className="text-xs text-ink-500">{t('accounts.rebalanceModal.pricing')}</span>}
      </div>
    </div>
  );
}
