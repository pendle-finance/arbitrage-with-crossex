import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useCustomPlan, useStartRebalance, useTransfer, type CustomMove } from '../api/queries';
import type { EvenPlan, GateAccount, GoalKind, Pool, RebalanceView, RouteName, TransferCoin } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { borrowingBuckets, MIN_BORROW } from '../lib/borrow';
import { apiErrorText } from '../lib/apiErrorText';
import { num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { useDebounced } from '../lib/useDebounced';
import { RebalanceBeforeAfter, walletChanges } from './RebalanceBeforeAfter';
import { VerdictAlert } from './RebalanceBits';
import { bucketOf, flowOf, unique } from './moveCashPlan';
import { MoveCashWallets } from './MoveCashWallets';
import { realizeText, StepsFold, stepsHoverOf, TotalCost, walletOf, type CostRow } from './RebalancePlanBits';
import { planRows } from './rebalanceStepRows';
import { RebalanceModalFooter } from './RebalanceModalFooter';
import { HOLD_LABEL, HOVER, modalFeeLabel, nothingToMove, PAYS_BACK, poolCoin, poolKey, waitsForDeal, waitsForTransfer } from './rebalanceCopy';
import { crossexImFull } from './rebalanceImStop';
import { daysText, defaultGoal, DUST, fmtCoinOrUsd, isCashLimitedEven, keyOf, movesOf, paybackDays, pickedRoute } from './RebalanceHovers';
import { costPartsUsd, planSteps, receivingBorrow, receivingHeld, ROUTE_NAME_CELL, RouteRow, sharedCoin, SpotLines } from './RebalanceHovers';
import { Term, worthLine } from './RebalanceHovers';
import { acceptedOf, cashLimitedText, CUSTOM_DEBOUNCE_MS, initialGoal, isStale, parsedAmount, PLAN_CHANGED_LABEL, plainOf, presetOffText, shownOrder } from './rebalanceModalPlan';
import type { Accepted } from './rebalanceModalPlan';
import type { RebalanceTab } from './rebalanceOpener';

const POOLS: readonly Pool[] = ['CROSSEX', 'HYPERLIQUID', 'LIGHTER'];

export function MoveCashTab({
  view,
  holdMs,
  lock,
  onTab,
  onStarted,
  onTransfer,
}: {
  view: RebalanceView;
  holdMs?: number;
  lock: string | null;
  onTab: (tab: RebalanceTab) => void;
  onStarted: () => void;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
}) {
  const { t } = useTranslation();
  const transfer = useTransfer().data;
  const start = useStartRebalance();
  const toast = useToast();
  const { job, buckets } = view;
  const [goal, setGoal] = useState<GoalKind>(() => initialGoal(view));
  const [customText, setCustomText] = useState('');
  const [customFrom, setCustomFrom] = useState<Pool>('HYPERLIQUID');
  const [customTo, setCustomTo] = useState<Pool>('CROSSEX');
  const [acceptNext, setAcceptNext] = useState(false);
  const [pick, setPick] = useState<RouteName | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);

  const moveOf = (text: string): CustomMove | null => {
    const amount = parsedAmount(text);
    return goal === 'custom' && amount !== null && amount > 0 && customFrom !== customTo ? { from: customFrom, to: customTo, amount } : null;
  };
  const customMove = moveOf(useDebounced(customText, CUSTOM_DEBOUNCE_MS));
  const typedMove = moveOf(customText);
  const customQuery = useCustomPlan(customMove);
  const customPlan = customMove === null ? null : (customQuery.data?.plans.custom ?? null);
  const quotes = (candidate: EvenPlan | null, move: CustomMove | null): boolean =>
    candidate !== null && move !== null && candidate.goal.kind === 'custom' &&
    candidate.goal.from === move.from && candidate.goal.to === move.to && candidate.goal.amount === move.amount;
  const active: EvenPlan | null = goal === 'custom' ? customPlan : view.plans[goal];
  const plan = plainOf(active ?? view.plans[defaultGoal(view)]);
  const customPending = goal === 'custom' && active === null;
  const [accepted, setAccepted] = useState<Accepted | null>(() => acceptedOf(plan, pickedRoute(plan, null).name));

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
  const enterCustom = () => {
    const first = movesOf(planSteps(plan))[0];
    setCustomFrom(first?.from ?? 'HYPERLIQUID');
    setCustomTo(first?.to ?? 'CROSSEX');
    const cash = floorCents(bucketOf(buckets, first?.from ?? 'HYPERLIQUID')?.cash ?? 0);
    const prefill = floorCents(Math.min(plan.moves, cash));
    setCustomText(prefill > 0 ? String(prefill) : '');
    pickGoal('custom');
  };
  const editCustom = (apply: () => void) => {
    apply();
    setAcceptNext(true);
  };
  const onStartError = (error: Error) => {
    if (error instanceof ApiError && error.label === PLAN_CHANGED_LABEL) return setAccepted(null);
    toast.push('error', apiErrorText(error));
  };

  const { name: chosen, route } = pickedRoute(plan, pick ?? accepted?.name ?? null);
  const choose = (name: RouteName | null) => {
    setPick(name);
    setAccepted(acceptedOf(plan, pickedRoute(plan, name).name));
  };
  const moves = movesOf(planSteps(plan));
  const fromPools = goal === 'custom' ? [customFrom] : unique(moves.map((move) => move.from));
  const toPools = goal === 'custom' ? [customTo] : unique(moves.map((move) => move.to));
  const flow = flowOf(buckets, route, fromPools, toPools);
  const aboveMost = goal === 'custom' && plan.goal.kind === 'custom' && plan.customMaxUsd != null && plan.goal.amount > plan.customMaxUsd;
  const pricing = goal === 'custom' && !customPending && (acceptNext || !quotes(plan, typedMove));
  const stale = !pricing && isStale(accepted, plan, chosen);
  let transferLock: string | null = null;
  if (transfer?.lock === 'deal') transferLock = waitsForDeal();
  if (transfer?.transfer?.status === 'moving') transferLock = waitsForTransfer();
  const waits = lock ?? transferLock;
  const clearsBorrow = goal !== 'custom' || receivingBorrow(buckets, planSteps(plan)) !== null;
  const worth = chosen === null || !clearsBorrow ? null : worthLine(plan, route, buckets);
  const days = chosen === null ? null : paybackDays(plan, route, buckets);
  const paysBack = days !== null && days > 0 ? t('accounts.moveCash.paysBack', { days: num(Math.max(1, Math.ceil(days)), 0) }) : null;
  const imStop = fromPools.includes('CROSSEX') ? crossexImFull(view.imUsed) : null;
  const cashShort = goal === 'repay' && !plan.balanced && flow.left >= DUST && flow.borrowCoin !== null;
  const walletPools = POOLS.filter((pool) => buckets.some((bucket) => keyOf(bucket) === poolKey(pool)));
  const fromCash = floorCents(bucketOf(buckets, customFrom)?.cash ?? 0);
  const borrowing = borrowingBuckets(buckets);
  const borrowTotal = borrowing.reduce((total, b) => total + b.borrow, 0);

  const goalOptions = [
    {
      value: 'repay' as const,
      label: t('accounts.moveCash.clearDebt'),
      sub: borrowTotal >= MIN_BORROW ? fmtCoinOrUsd(borrowTotal, sharedCoin(borrowing)) : undefined,
      disabled: view.plans.repay.balanced,
      title: presetOffText('repay', view.plans.repay),
    },
    { value: 'even' as const, label: t('accounts.moveCash.balancePositions'), disabled: view.plans.even.balanced, title: presetOffText('even', view.plans.even) },
    { value: 'custom' as const, label: t('accounts.moveCash.custom') },
  ];

  const priced = !customPending && !pricing;

  let body: ReactNode;
  if (customPending) {
    const hint = customMove === null ? t('accounts.rebalanceModal.typeAmount') : customQuery.isError ? customQuery.error.message : t('accounts.rebalanceModal.pricing');
    body = <p className="text-xs text-ink-400">{hint}</p>;
  } else if (goal === 'custom' && plan.balanced && !aboveMost) {
    body = <p className="text-xs text-ink-400">{isCashLimitedEven(plan) ? cashLimitedText(plan) : nothingToMove()}</p>;
  } else if (aboveMost) {
    body = (
      <>
        <VerdictAlert tone="warn" text={realizeText('customMax', { max: num(plan.customMaxUsd ?? 0, 0), coin: poolCoin(customFrom) })} />
        {waits !== null ? (
          <p className="text-xs text-ink-400">{waits}</p>
        ) : (
          <HoldToConfirmButton className="w-full" holdMs={holdMs} disabled onConfirm={() => undefined}>{HOLD_LABEL.custom}</HoldToConfirmButton>
        )}
      </>
    );
  } else {
    const parts = costPartsUsd(plan, route);
    const costRows: CostRow[] =
      chosen === null
        ? []
        : [
            { label: chosen === 'convert' ? t('accounts.moveCash.convertFee') : modalFeeLabel(), usd: parts.feeUsd },
            { label: t('accounts.moveCash.priceImpact'), usd: parts.impactUsd, hover: HOVER.priceImpact },
            { label: t('accounts.moveCash.totalCost'), usd: parts.totalUsd, strong: true },
          ];
    body = (
      <>
        <div className="flex flex-col gap-2">
          <div className={`relative flex items-center gap-3 px-3 ${microLabelClass}`}>
            <span className="absolute left-0">
              <Term label={t('accounts.rebalanceModal.route')} text={HOVER.route} />
            </span>
            <span className="w-3.5 shrink-0" />
            <span className={ROUTE_NAME_CELL} />
            <span className="flex-1">{t('accounts.rebalanceModal.time')}</span>
            <span className="text-right">{t('accounts.moveCash.feeHead')}</span>
          </div>
          <div role="radiogroup" aria-label={t('accounts.rebalanceModal.route')} className="flex flex-col gap-1.5">
            {shownOrder(plan, accepted).map((name) => (
              <RouteRow key={name} route={name} plan={plan} checked={chosen === name} onPick={() => choose(name)} />
            ))}
          </div>
          {route.steps.length > 0 && (
            <StepsFold
              open={stepsOpen}
              onToggle={() => setStepsOpen(!stepsOpen)}
              hover={stepsHoverOf(route.rounds, receivingHeld(buckets, planSteps(plan)))}
              rows={planRows(route)}
            />
          )}
        </div>
        {costRows.length > 0 && <TotalCost rows={costRows} />}
        <RebalanceBeforeAfter
          rows={walletChanges(view, plan, route)}
          mode="after"
          footer={days !== null && days > 0 ? { label: t('accounts.moveCash.paysBackLabel'), value: daysText(days), hover: PAYS_BACK(daysText(days)) } : null}
        />
        {cashShort && (
          <VerdictAlert
            tone="info"
            text={<span className="num">{t('accounts.moveCash.cashShort', { left: num(flow.left), coin: flow.borrowCoin, wallet: fromPools.map(walletOf).join(' + ') })}</span>}
            action={{ label: t('accounts.moveCash.cashShortLink'), onClick: () => onTab('realize') }}
          />
        )}
        <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
        {imStop ? (
          <VerdictAlert
            tone="warn"
            text={<span className="num">{t('accounts.borrowCard.imUsed', { pct: num(imStop.pct * 100, 1) })}</span>}
            action={{ label: t('accounts.moveCash.deleverLink'), onClick: () => onTab('delever') }}
          />
        ) : (
          <RebalanceModalFooter
            rows={[]}
            holdLabel={HOLD_LABEL.custom}
            verdict={worth?.tone === 'warn' ? <VerdictAlert tone="warn" text={worth.text} sub={paysBack} /> : undefined}
            optional={worth !== null && worth.tone !== 'act'}
            stale={stale}
            lock={waits}
            pricing={pricing}
            holdMs={holdMs}
            disabled={waits !== null || chosen === null || start.isPending || pricing}
            onRefresh={() => setAccepted(acceptedOf(plan, chosen))}
            onConfirm={() => {
              if (!chosen) return;
              start.mutate(
                { kind: 'move', goal, route: chosen, costUsd: parts.totalUsd, ...(goal === 'custom' && customMove ? customMove : {}) },
                { onSuccess: onStarted, onError: onStartError },
              );
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className={microLabelClass}>
          <Term label={t('accounts.moveCash.goal')} text={HOVER.presets} />
        </div>
        <SegmentedToggle<GoalKind>
          ariaLabel={t('accounts.rebalanceModal.preset')}
          fill
          value={goal}
          options={goalOptions}
          onChange={(next) => (next === 'custom' ? enterCustom() : pickGoal(next))}
        />
      </div>
      <MoveCashWallets
        custom={goal === 'custom'}
        flow={flow}
        pools={walletPools}
        priced={priced}
        from={customFrom}
        to={customTo}
        text={customText}
        fromCash={fromCash}
        onFrom={(pool) => editCustom(() => setCustomFrom(pool))}
        onTo={(pool) => editCustom(() => setCustomTo(pool))}
        onText={(text) => editCustom(() => setCustomText(text))}
      />
      {body}
    </div>
  );
}
