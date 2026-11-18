import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useCustomPlan, useRebalanceCommand, useStartRebalance, useTransfer, type CustomMove } from '../api/queries';
import type { EvenPlan, GateAccount, GoalKind, Pool } from '../api/types';
import type { RebalanceView, RouteName, TransferCoin } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Modal } from '../components/Modal';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { num } from '../lib/fmt';
import { useDebounced } from '../lib/useDebounced';
import { useNow } from '../lib/useNow';
import { RebalanceBeforeAfter, walletChanges } from './RebalanceBeforeAfter';
import { planRows, VerdictAlert } from './RebalanceBits';
import { HowItRuns, JobChip, realizeText, RebalanceJobView, refusalOf, StepsFold, stepsHoverOf } from './RebalanceJobView';
import type { Pressed } from './RebalanceJobView';
import { RebalanceCustomRow } from './RebalanceCustomRow';
import { RebalanceModalFooter } from './RebalanceModalFooter';
import { AFTER_LABEL, GOAL_LABEL, HOLD_LABEL, HOVER, poolCoin } from './rebalanceCopy';
import { nothingToMove, poolKey, usePresetText } from './rebalanceCopy';
import { waitsForDeal, waitsForTransfer } from './rebalanceCopy';
import { defaultGoal, isCashLimitedEven, keyOf, movesOf, pickedRoute, planSteps } from './RebalanceHovers';
import { receivingBorrow, receivingHeld, RouteRow, SpotLines, Term, totalCostUsd, worthChip, worthLine } from './RebalanceHovers';
import { acceptedOf, cashLimitedText, initialGoal, isStale, parsedAmount, PLAN_CHANGED_LABEL, plainOf, presetOffText, shownOrder } from './rebalanceModalPlan';
import type { Accepted, PresetPick } from './rebalanceModalPlan';

const POOLS: readonly Pool[] = ['CROSSEX', 'HYPERLIQUID', 'LIGHTER'];
const CUSTOM_DEBOUNCE_MS = 300;

export function RebalanceModal({
  view,
  onClose,
  holdMs,
  onTransfer,
}: {
  view: RebalanceView;
  onClose: () => void;
  holdMs?: number;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
}) {
  const { t } = useTranslation();
  const transfer = useTransfer().data;
  const start = useStartRebalance();
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const toast = useToast();
  const now = useNow();
  const { job, buckets } = view;
  const [goal, setGoal] = useState<GoalKind>(() => initialGoal(view));
  const [customText, setCustomText] = useState('');
  const [customFrom, setCustomFrom] = useState<Pool>('HYPERLIQUID');
  const [customTo, setCustomTo] = useState<Pool>('CROSSEX');
  const [acceptNext, setAcceptNext] = useState(false);
  const [pick, setPick] = useState<RouteName | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [ranId, setRanId] = useState<string | null>(null);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const running = job?.status === 'running';
  const halted = job?.status === 'halted';

  const debouncedText = useDebounced(customText, CUSTOM_DEBOUNCE_MS);
  const customAmount = parsedAmount(debouncedText);
  const customMove: CustomMove | null =
    goal === 'custom' && customAmount !== null && customAmount > 0 && customFrom !== customTo
      ? { from: customFrom, to: customTo, amount: customAmount }
      : null;
  const customQuery = useCustomPlan(customMove);
  const customPlan = customMove === null ? null : (customQuery.data?.plans.custom ?? null);
  const typedAmount = parsedAmount(customText);
  const typedMove: CustomMove | null =
    goal === 'custom' && typedAmount !== null && typedAmount > 0 && customFrom !== customTo
      ? { from: customFrom, to: customTo, amount: typedAmount }
      : null;
  const quotes = (candidate: EvenPlan | null, move: CustomMove | null): boolean =>
    candidate !== null &&
    move !== null &&
    candidate.goal.kind === 'custom' &&
    candidate.goal.from === move.from &&
    candidate.goal.to === move.to &&
    candidate.goal.amount === move.amount;
  const active: EvenPlan | null = goal === 'custom' ? customPlan : view.plans[goal];
  const offered: EvenPlan = active ?? view.plans[defaultGoal(view)];
  const refusal = refusalOf(offered);
  const plan = plainOf(offered);
  const customPending = goal === 'custom' && active === null;
  const [accepted, setAccepted] = useState<Accepted | null>(() => acceptedOf(plan, pickedRoute(plan, null).name));

  useEffect(() => {
    if (job && (job.status === 'running' || job.status === 'halted')) setRanId(job.id);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!acceptNext || active === null || !quotes(active, typedMove)) return;
    setAccepted(acceptedOf(active, pickedRoute(active, pick).name));
    setAcceptNext(false);
  }, [acceptNext, active, pick, typedMove?.from, typedMove?.to, typedMove?.amount]);

  const pickGoal = (next: GoalKind) => {
    setGoal(next);
    setPick(null);
    setAcceptNext(next === 'custom');
    if (next !== 'custom') setAccepted(acceptedOf(view.plans[next], pickedRoute(view.plans[next], null).name));
  };
  const pickPreset = (next: PresetPick) => {
    if (next !== 'none') pickGoal(next);
  };
  const enterCustom = () => {
    const first = movesOf(planSteps(plan))[0];
    setCustomFrom(first?.from ?? 'HYPERLIQUID');
    setCustomTo(first?.to ?? 'CROSSEX');
    setCustomText(plan.moves > 0 ? plan.moves.toFixed(2) : '');
    pickGoal('custom');
  };
  const leaveCustom = () => {
    const back = initialGoal(view);
    pickGoal(back === 'custom' ? defaultGoal(view) : back);
  };
  const editCustom = (apply: () => void) => {
    apply();
    setAcceptNext(true);
  };

  const onError = (error: Error) => {
    const hint = error instanceof ApiError ? error.hint : undefined;
    const period = error.message.endsWith('.') ? '' : '.';
    toast.push('error', hint ? `${error.message}${period} ${hint}` : error.message);
  };

  const onStartError = (error: Error) => {
    if (error instanceof ApiError && error.label === PLAN_CHANGED_LABEL) setAccepted(null);
    else onError(error);
  };

  const { name: chosen, route } = pickedRoute(plan, pick ?? accepted?.name ?? null);
  const choose = (name: RouteName | null) => {
    setPick(name);
    setAccepted(acceptedOf(plan, pickedRoute(plan, name).name));
  };
  const finished = job?.status === 'done' && (job.id === ranId || start.isSuccess);
  const aboveMost = goal === 'custom' && plan.goal.kind === 'custom' && plan.customMaxUsd != null && plan.goal.amount > plan.customMaxUsd;
  const borrow = receivingBorrow(buckets, planSteps(plan));
  const held = receivingHeld(buckets, planSteps(plan));
  const pricing = goal === 'custom' && !customPending && (acceptNext || !quotes(plan, typedMove));
  const stale = !pricing && isStale(accepted, plan, chosen);
  let lock: string | null = null;
  if (transfer?.lock === 'deal') lock = waitsForDeal();
  if (transfer?.transfer?.status === 'moving') lock = waitsForTransfer();
  const clearsBorrow = goal !== 'custom' || receivingBorrow(buckets, planSteps(plan)) !== null;
  const worth = chosen === null || !clearsBorrow ? null : worthLine(plan, route, buckets);
  const optional = worth !== null && worth.tone !== 'act';
  const worthAlert = worth !== null && worthChip(plan, route, buckets) === null;
  const walletPools = POOLS.filter((pool) => buckets.some((bucket) => keyOf(bucket) === poolKey(pool)));
  const presetOptions = (['even', 'repay'] as const).map((preset) => ({
    value: preset,
    label: GOAL_LABEL[preset],
    disabled: view.plans[preset].balanced,
    title: presetOffText(preset, view.plans[preset]),
  }));

  let body: ReactNode = null;

  if (job && (running || halted || finished)) {
    body = (
      <RebalanceJobView
        job={job} view={view} now={now} holdMs={holdMs} pressed={pressed} transfer={transfer} onClose={onClose} onTransfer={onTransfer}
        busy={resume.isPending || abandon.isPending}
        resuming={resume.isPending}
        onResume={() => resume.mutate(job.id, { onError })}
        onAbandon={() => abandon.mutate(job.id, { onError })}
      />
    );
  } else {
    const header = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Term
            wrapsControl
            label={
              <SegmentedToggle<PresetPick>
                ariaLabel={t('accounts.rebalanceModal.preset')}
                value={goal === 'custom' ? 'none' : goal}
                options={presetOptions}
                onChange={pickPreset}
              />
            }
            text={HOVER.presets}
          />
          <button type="button" className="btn-link" onClick={goal === 'custom' ? leaveCustom : enterCustom}>
            {goal === 'custom' ? usePresetText() : GOAL_LABEL.custom}
          </button>
        </div>
        {goal === 'custom' && (
          <RebalanceCustomRow
            text={customText} from={customFrom} to={customTo} pools={walletPools}
            onText={(next) => editCustom(() => setCustomText(next))}
            onFrom={(next) => editCustom(() => setCustomFrom(next))}
            onTo={(next) => editCustom(() => setCustomTo(next))}
          />
        )}
      </div>
    );
    if (customPending) {
      const hint =
        customMove === null
          ? t('accounts.rebalanceModal.typeAmount')
          : customQuery.isError
            ? customQuery.error.message
            : t('accounts.rebalanceModal.pricing');
      body = (
        <>
          {header}
          <p className="text-xs text-ink-400">{hint}</p>
        </>
      );
    } else if (goal === 'custom' && plan.balanced && !aboveMost) {
      body = (
        <>
          {header}
          <p className="text-xs text-ink-400">{isCashLimitedEven(plan) ? cashLimitedText(plan) : nothingToMove()}</p>
        </>
      );
    } else if (aboveMost) {
      body = (
        <>
          {header}
          <VerdictAlert tone="warn" text={realizeText('customMax', { max: num(plan.customMaxUsd ?? 0, 0), coin: poolCoin(customFrom) })} />
          <HoldToConfirmButton holdMs={holdMs} disabled onConfirm={() => undefined}>{HOLD_LABEL[goal]}</HoldToConfirmButton>
        </>
      );
    } else {
      const changes = walletChanges(view, plan, route);
      body = (
        <>
          {header}
          {changes.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className={microLabelClass}>{AFTER_LABEL[goal]}</div>
              <RebalanceBeforeAfter rows={changes} mode="after" />
            </div>
          )}
          <HowItRuns plan={plan} route={route} lead={refusal && <VerdictAlert tone="warn" text={refusal.title} sub={refusal.body} />}>
            <div className={microLabelClass}>
              <Term label={t('accounts.rebalanceModal.route')} text={HOVER.route} />
            </div>
            <div role="radiogroup" aria-label={t('accounts.rebalanceModal.route')} className="flex flex-col gap-1.5">
              {shownOrder(plan, accepted).map((name) => (
                <RouteRow key={name} route={name} plan={plan} checked={chosen === name} onPick={() => choose(name)} />
              ))}
            </div>
            {route.steps.length > 0 && (
              <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHoverOf(route.rounds, held)} rows={planRows(route, borrow)} />
            )}
          </HowItRuns>
          <RebalanceModalFooter
            plan={plan} route={route} buckets={buckets} goal={goal} chosen={chosen} worth={worth} worthAlert={worthAlert} optional={optional}
            stale={stale} lock={lock} pricing={pricing} holdMs={holdMs}
            disabled={lock !== null || chosen === null || start.isPending || pricing}
            onRefresh={() => setAccepted(acceptedOf(plan, chosen))}
            onConfirm={() => {
              if (!chosen) return;
              const legs = plan.realize?.legs ?? [];
              setPressed({ view, plan, route });
              start.mutate(
                {
                  goal,
                  route: chosen,
                  costUsd: totalCostUsd(plan, route),
                  ...(goal === 'custom' && customMove ? customMove : {}),
                  ...(legs.length > 0 ? { realizeQty: legs.map((leg) => ({ symbol: leg.symbol, qty: leg.qty })) } : {}),
                },
                { onError: onStartError },
              );
            }}
          />
          <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
        </>
      );
    }
  }

  return (
    <Modal
      widthClass="w-[680px]"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {t('accounts.rebalanceModal.title')}
          {job && (running || halted || finished) && <JobChip job={job} />}
        </span>
      }
    >
      <div className="flex flex-col gap-4">{body}</div>
    </Modal>
  );
}
