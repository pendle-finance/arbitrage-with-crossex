import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useCustomPlan, useRebalanceCommand, useStartRebalance, useTransfer, type CustomMove } from '../api/queries';
import type { EvenPlan, GateAccount, Goal, GoalKind, Pool } from '../api/types';
import type { RebalanceView, RouteName, TransferCoin } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Modal } from '../components/Modal';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { amountError } from '../lib/amount';
import { fmtUsd, num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { useDebounced } from '../lib/useDebounced';
import { useNow } from '../lib/useNow';
import { RebalanceBeforeAfter, walletChanges } from './RebalanceBeforeAfter';
import { planRows, ROUTE_ORDER, routeScore, VerdictAlert } from './RebalanceBits';
import { HowItRuns, JobChip, realizeText, RebalanceJobView, refusalOf, StepsFold, stepsHoverOf, TotalCost } from './RebalanceJobView';
import type { Pressed } from './RebalanceJobView';
import { AFTER_LABEL, GOAL_LABEL, HOLD_LABEL, HOVER, modalRefreshRoute } from './rebalanceCopy';
import { moveFromText, moveText, moveToText, nothingToMove, poolKey, PRESET_OFF, shortOfCash, usePresetText } from './rebalanceCopy';
import { verdictBalanced, verdictNoCashToMove, waitsForDeal, waitsForTransfer, WALLET_LABEL } from './rebalanceCopy';
import { defaultGoal, isCashLimitedEven, keyOf, movesKey, movesOf, pickedRoute, planSteps } from './RebalanceHovers';
import { receivingBorrow, receivingHeld, RouteRow, SpotLines, Term, totalCostUsd, worthLine } from './RebalanceHovers';

const POOLS: readonly Pool[] = ['CROSSEX', 'HYPERLIQUID', 'LIGHTER'];
const CUSTOM_DEBOUNCE_MS = 300;

type Preset = 'even' | 'repay';
type PresetPick = Preset | 'none';

const goalKey = (goal: Goal): string => (goal.kind === 'custom' ? `custom:${goal.from}>${goal.to}@${goal.amount}` : goal.kind);

function initialGoal(view: RebalanceView): GoalKind {
  const lead = defaultGoal(view);
  const other: Preset = lead === 'even' ? 'repay' : 'even';
  if (!view.plans[lead].balanced) return lead;
  if (!view.plans[other].balanced) return other;
  return 'custom';
}

const cashLimitedText = (plan: EvenPlan): string =>
  plan.noLegs ? `${fmtUsd(plan.shortOfEven)} ${shortOfCash()}` : verdictNoCashToMove();

function presetOffText(preset: Preset, plan: EvenPlan): string | undefined {
  if (!plan.balanced) return undefined;
  if (preset === 'even' && plan.noLegs) return PRESET_OFF.even;
  if (isCashLimitedEven(plan)) return cashLimitedText(plan);
  return preset === 'even' ? verdictBalanced() : PRESET_OFF.repay;
}

const parsedAmount = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === '' || amountError(trimmed) !== null) return null;
  return floorCents(Number(trimmed));
};
const PLAN_CHANGED_LABEL = 'PLAN_CHANGED';

function stampOf(plan: EvenPlan, name: RouteName | null): string {
  const route = name === null ? null : plan.routes[name];
  return [goalKey(plan.goal), name, movesKey(route?.steps ?? [])].join(':');
}

interface Accepted {
  stamp: string;
  costUsd: number;
  name: RouteName | null;
  order: RouteName[];
}

const acceptedOf = (plan: EvenPlan, name: RouteName | null): Accepted => ({
  stamp: stampOf(plan, name),
  costUsd: name === null || !plan.routes[name] ? 0 : totalCostUsd(plan, plan.routes[name]),
  name,
  order: routeOrder(plan),
});

function shownOrder(plan: EvenPlan, accepted: Accepted | null): RouteName[] {
  const fresh = routeOrder(plan);
  if (accepted === null) return fresh;
  const kept = accepted.order.filter((name) => fresh.includes(name));
  return [...kept, ...fresh.filter((name) => !kept.includes(name))];
}

const cents = (usd: number): number => Math.round(usd * 100);

const costRoseTooMuch = (fresh: number, shown: number): boolean => cents(fresh) - cents(shown) > Math.max(100, cents(shown) / 20);

function isStale(accepted: Accepted | null, plan: EvenPlan, name: RouteName | null): boolean {
  if (accepted === null || accepted.stamp !== stampOf(plan, name)) return true;
  const route = name === null ? null : plan.routes[name];
  return route !== null && route !== undefined && costRoseTooMuch(totalCostUsd(plan, route), accepted.costUsd);
}

function routeOrder(plan: EvenPlan): RouteName[] {
  const { recommended, routes } = plan;
  const rest = ROUTE_ORDER.filter((name) => name !== recommended && routes[name] !== null);
  rest.sort((a, b) => routeScore(routes[a] ?? { costUsd: 0, seconds: 0 }) - routeScore(routes[b] ?? { costUsd: 0, seconds: 0 }));
  return recommended !== null && routes[recommended] ? [recommended, ...rest] : rest;
}

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
  const plan: EvenPlan = active ?? view.plans[defaultGoal(view)];
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
    const poolOptions = walletPools.map((pool) => (
      <option key={pool} value={pool}>
        {WALLET_LABEL[poolKey(pool)]}
      </option>
    ));
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
          <div className="num flex flex-wrap items-center gap-2 text-sm text-ink-300">
            <span className="text-ink-400">{moveText()}</span>
            <input
              aria-label={t('accounts.rebalanceModal.amount')}
              className="input num h-[30px] w-28 !py-0 text-xs"
              inputMode="decimal"
              value={customText}
              onChange={(e) => editCustom(() => setCustomText(e.target.value))}
            />
            <span className="text-ink-400">{moveFromText()}</span>
            <select aria-label={t('accounts.rebalanceModal.from')} className="input num h-[30px] !w-44 !py-0 text-xs" value={customFrom} onChange={(e) => editCustom(() => setCustomFrom(e.target.value as Pool))}>
              {poolOptions}
            </select>
            <span className="text-ink-400">{moveToText()}</span>
            <select aria-label={t('accounts.rebalanceModal.to')} className="input num h-[30px] !w-44 !py-0 text-xs" value={customTo} onChange={(e) => editCustom(() => setCustomTo(e.target.value as Pool))}>
              {poolOptions}
            </select>
          </div>
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
          <VerdictAlert tone="warn" text={realizeText('customMax', { max: num(plan.customMaxUsd ?? 0, 0) })} />
          <HoldToConfirmButton holdMs={holdMs} disabled onConfirm={() => undefined}>{HOLD_LABEL[goal]}</HoldToConfirmButton>
        </>
      );
    } else {
      const refusal = refusalOf(plan);
      const changes = walletChanges(view, plan, route);
      body = (
        <>
          {header}
          {refusal === null && changes.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className={microLabelClass}>{AFTER_LABEL[goal]}</div>
              <RebalanceBeforeAfter rows={changes} mode="after" />
            </div>
          )}
          <HowItRuns plan={plan} route={route}>
            <div role="radiogroup" aria-label={t('accounts.rebalanceModal.route')} className="flex flex-col gap-1.5">
              {shownOrder(plan, accepted).map((name) => (
                <RouteRow key={name} route={name} plan={plan} checked={chosen === name} onPick={() => choose(name)} />
              ))}
            </div>
            {route.steps.length > 0 && (
              <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHoverOf(route.rounds, held)} rows={planRows(route, borrow)} />
            )}
          </HowItRuns>
          {refusal ? (
            <VerdictAlert tone="warn" text={refusal.title} sub={refusal.body} />
          ) : (
            chosen !== null && <TotalCost plan={plan} route={route} buckets={buckets} />
          )}
          <div className="flex flex-wrap items-center gap-3">
            {stale && refusal === null ? (
              <button type="button" className="btn btn-primary num" onClick={() => setAccepted(acceptedOf(plan, chosen))}>
                {modalRefreshRoute()}
              </button>
            ) : (
              <HoldToConfirmButton
                tone={optional ? 'outline' : 'cyan'}
                holdMs={holdMs}
                disabled={refusal !== null || lock !== null || chosen === null || start.isPending || pricing}
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
              >
                {HOLD_LABEL[goal]}
              </HoldToConfirmButton>
            )}
            {lock !== null && <span className="text-xs text-ink-500">{lock}</span>}
            {lock === null && pricing && <span className="text-xs text-ink-500">{t('accounts.rebalanceModal.pricing')}</span>}
          </div>
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
