import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useCustomPlan, useRebalanceCommand, useStartRebalance, useTransfer, type CustomMove } from '../api/queries';
import type { EvenPlan, GateAccount, Goal, GoalKind, Pool, RebalanceBucket, RebalanceJob } from '../api/types';
import type { RebalanceView, RouteName, RoutePlan, TransferCoin, TransferView } from '../api/types';
import type { RebalanceStep } from '../api/types';
import { Chip } from '../components/Chip';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Modal } from '../components/Modal';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { amountError } from '../lib/amount';
import { fmtAbout, fmtAge, fmtUsd, num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { useDebounced } from '../lib/useDebounced';
import { useNow } from '../lib/useNow';
import { BalanceBars, jobRows, jobSeconds, planRows, ProgressBar, ROUTE_ORDER, scaleOf, StepList, VerdictAlert } from './RebalanceBits';
import type { BarRow, StepRow } from './RebalanceBits';
import { AFTER_LABEL, GATE_SPOT, GOAL_LABEL, HOLD_LABEL, HOVER, MODAL_ABANDON } from './rebalanceCopy';
import { MODAL_FEE_LABEL, MODAL_FREES, MODAL_INTEREST, MODAL_REFRESH_ROUTE, MODAL_RESUME, MODAL_STEPS, PER_MONTH } from './rebalanceCopy';
import { CARD_LABEL, MOVE, MOVE_FROM, MOVE_TO, NOTHING_TO_MOVE, poolKey, PRESET_OFF, SHORT_OF_CASH, USE_PRESET, VERDICT_BALANCED } from './rebalanceCopy';
import { RATE_UNKNOWN, WAITS_FOR_DEAL, WAITS_FOR_TRANSFER, WALLET_LABEL } from './rebalanceCopy';
import { barRowsOf, Facts, hasUnknownRate, isCashLimitedEven, keyOf, MONTH_DAYS, movesKey, movesOf, pickedRoute, stopsPerDayOf, worthLine } from './RebalanceHovers';
import { defaultGoal, planSteps, receivingBorrow, receivingHeld } from './RebalanceHovers';
import { ROUTE_LABEL, roundCountOf, roundOf, RouteRow, shownKeys, SpotLines, targetsOf, Term } from './RebalanceHovers';
import type { Fact } from './RebalanceHovers';
import { NoSpotReadLine } from './TransferBits';

const TITLE = 'Rebalance';
const FOR_LABEL = 'For';
const AMOUNT_LABEL = 'Amount';
const FROM_LABEL = 'From';
const TO_LABEL = 'To';
const PRESET_LABEL = 'Preset';
const TYPE_AN_AMOUNT = 'Type an amount to move.';
const PRICING = 'Pricing the move.';
const POOLS: readonly Pool[] = ['CROSSEX', 'HYPERLIQUID', 'LIGHTER'];
const CUSTOM_DEBOUNCE_MS = 300;

type Preset = 'even' | 'repay';
type PresetPick = Preset | 'none';

const goalKey = (goal: Goal): string => (goal.kind === 'custom' ? `custom:${goal.from}>${goal.to}@${goal.amount}` : goal.kind);

/** The preset the dialog opens on: the one the card recommends, unless it has
 * nothing to do and the other one has; with both idle it opens straight on
 * the custom move, the only thing left that can run. Every other option stays
 * one click away (his ruling 2026-09-19). */
function initialGoal(view: RebalanceView): GoalKind {
  const lead = defaultGoal(view);
  const other: Preset = lead === 'even' ? 'repay' : 'even';
  if (!view.plans[lead].balanced) return lead;
  if (!view.plans[other].balanced) return other;
  return 'custom';
}

/** Why a preset is off, for its hover. */
function presetOffText(preset: Preset, plan: EvenPlan): string | undefined {
  if (!plan.balanced) return undefined;
  if (preset === 'even' && plan.noLegs) return PRESET_OFF.even;
  if (isCashLimitedEven(plan)) return `${fmtUsd(plan.shortOfEven)} ${SHORT_OF_CASH}`;
  return preset === 'even' ? VERDICT_BALANCED : PRESET_OFF.repay;
}

const parsedAmount = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === '' || amountError(trimmed) !== null) return null;
  return floorCents(Number(trimmed));
};
const HIDE_STEPS = 'Hide steps';
const NOW_CAPTION = 'Now';
const WHERE_CAPTION = 'Where your money is';
const ON_THE_WAY = 'On the way';
const WAITS_LINE = 'New deals and transfers wait until it ends.';
const KEEPS_GOING = 'You can close this. The run keeps going.';
const PLAN_CHANGED_LABEL = 'PLAN_CHANGED';
const FINISHED_LEAD = 'Done. This is what each wallet holds now.';
const NOT_MARGIN_UNTIL_LANDS = 'It is not margin until it lands.';
const NO_SPOT_READ = 'This key cannot read Gate spot.';
const PASSED = 'passed';
/** Not "Done": that is the finished chip's word, and the button is the way out. */
const CLOSE = 'Close';

/** The shape of the quote the trader accepted: its goal, recommendation,
 * route and moves. The fee is held beside it, not in it. */
function stampOf(plan: EvenPlan, name: RouteName | null): string {
  const route = name === null ? null : plan.routes[name];
  return [goalKey(plan.goal), plan.recommended, name, movesKey(route?.steps ?? [])].join(':');
}

interface Accepted {
  stamp: string;
  costUsd: number;
}

const acceptedOf = (plan: EvenPlan, name: RouteName | null): Accepted => ({
  stamp: stampOf(plan, name),
  costUsd: (name === null ? null : plan.routes[name])?.costUsd ?? 0,
});

const cents = (usd: number): number => Math.round(usd * 100);

/** The server's own tolerance (src/server/routes/rebalance.ts): a fee that
 * rose by more than a dollar or 5% is a new plan. Below that the hold stays
 * live, so a repay whose amount rides the wallet's unrealised PnL is not
 * asked to refresh on every poll (his call 2026-09-19, loosening 09-18's
 * exact-cost stamp). */
const costRoseTooMuch = (fresh: number, shown: number): boolean => cents(fresh) - cents(shown) > Math.max(100, cents(shown) / 20);

function isStale(accepted: Accepted | null, plan: EvenPlan, name: RouteName | null): boolean {
  if (accepted === null || accepted.stamp !== stampOf(plan, name)) return true;
  const route = name === null ? null : plan.routes[name];
  return route !== null && route !== undefined && costRoseTooMuch(route.costUsd, accepted.costUsd);
}

function routeOrder(plan: EvenPlan): RouteName[] {
  const { recommended, routes } = plan;
  const rest = ROUTE_ORDER.filter((name) => name !== recommended && routes[name] !== null);
  rest.sort((a, b) => (routes[a]?.costUsd ?? 0) - (routes[b]?.costUsd ?? 0));
  return recommended !== null && routes[recommended] ? [recommended, ...rest] : rest;
}

function stepsHoverOf(rounds: number, held: number | null): string | null {
  if (rounds === 0) return null;
  return [HOVER.round, held === null ? HOVER.whyMoreThanOne : HOVER.whyMoreThanOneBorrow(fmtUsd(held))].join(' ');
}

const LANDING_STEPS: readonly string[] = ['To Hyperliquid', 'To Lighter', 'Convert', 'Convert to USDC'];
const SHORT_FLOOR_USD = 1;
const SHORT_SHARE = 0.005;

const qtyOf = (steps: RebalanceStep[]): number => floorCents(steps.reduce((total, step) => total + (step.qty ?? 0), 0));
const moveOf = (step: RebalanceStep): string => `${step.round}:${step.from}:${step.to}`;

function soldOf(done: RebalanceStep[]): number {
  const moves = new Set(done.filter((step) => step.name === 'Sell USDC' && step.round !== null).map(moveOf));
  return [...moves].reduce((total, move) => {
    const round = done.filter((step) => moveOf(step) === move);
    const sold = qtyOf(round.filter((step) => step.name === 'Sell USDC'));
    const toGate = round.find((step) => step.name === 'To Gate');
    if (!toGate) return total + sold;
    return total + Math.min(Math.max(0, sold - (toGate.cashBefore ?? 0)), floorCents(toGate.qty ?? 0));
  }, 0);
}

function landedOf(job: RebalanceJob): number {
  const done = job.steps.filter((step) => step.status === 'done');
  return qtyOf(done.filter((step) => LANDING_STEPS.includes(step.name))) + soldOf(done);
}

function abandonNote(job: RebalanceJob, transfer: TransferView | undefined): string {
  const transit = job.inTransit;
  if (!transit) return HOVER.abandon;
  if (transit.at !== 'SPOT') return `${MODAL_ABANDON} leaves ${num(transit.qty)} ${transit.coin} in transit. ${NOT_MARGIN_UNTIL_LANDS}`;
  const inSpot = `${MODAL_ABANDON} leaves the ${num(transit.qty)} ${transit.coin} in ${GATE_SPOT}.`;
  return transfer?.spot === null ? `${inSpot} ${NO_SPOT_READ}` : inSpot;
}

function interestValue(route: RoutePlan, buckets: RebalanceBucket[]): string {
  if (hasUnknownRate(buckets)) return RATE_UNKNOWN;
  const perDay = buckets.reduce((sum, b) => sum + b.interestPerDayUsd, 0);
  const after = Math.max(0, perDay - stopsPerDayOf(route, buckets));
  return PER_MONTH(fmtUsd(perDay * MONTH_DAYS), fmtUsd(after * MONTH_DAYS));
}

/**
 * The quote, as three figures. No sub-lines: "no interest to stop" and "no
 * borrow to repay" only ever restated the $0.00 directly above them. No
 * liquidation either — it is an ACCOUNT fact, not a property of this route,
 * and it read as a fourth cost of rebalancing (his call 2026-09-18). The
 * verdict below now carries the recommendation instead.
 */
function quoteFactsOf(route: RoutePlan, view: RebalanceView): Fact[] {
  return [
    {
      key: 'interest',
      label: <Term label={MODAL_INTEREST} text={HOVER.interestMonth} />,
      value: interestValue(route, view.buckets),
    },
    { key: 'fee', label: MODAL_FEE_LABEL, value: fmtUsd(route.costUsd) },
    {
      key: 'frees',
      label: <Term label={MODAL_FREES} text={HOVER.frees} />,
      value: fmtUsd(route.marginFreedUsd),
    },
  ];
}

function StepsFold({ open, onToggle, hover, rows }: { open: boolean; onToggle: () => void; hover: string | null; rows: StepRow[] }) {
  const toggle = (
    <button type="button" className="btn-link inline-flex items-center gap-1" aria-expanded={open} onClick={onToggle}>
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      {open ? HIDE_STEPS : MODAL_STEPS}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <span className="self-start">{hover === null ? toggle : <Term wrapsControl label={toggle} text={hover} />}</span>
      {open && <StepList rows={rows} />}
    </div>
  );
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
  // A custom edit accepts whatever quote it brings back; a quote that then
  // moves under the dialog while it polls still asks for a refresh.
  const [acceptNext, setAcceptNext] = useState(false);
  const [pick, setPick] = useState<RouteName | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [ranId, setRanId] = useState<string | null>(null);
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
  // The preset in view, or the priced custom move. While a custom move has
  // no quote yet the dialog shows the editor alone, so `plan` falls back to
  // the card's preset only to keep the derived rows typed; nothing below the
  // editor renders from it in that state.
  const active: EvenPlan | null = goal === 'custom' ? customPlan : view.plans[goal];
  const plan: EvenPlan = active ?? view.plans[defaultGoal(view)];
  const customPending = goal === 'custom' && active === null;
  const [accepted, setAccepted] = useState<Accepted | null>(() => acceptedOf(plan, pickedRoute(plan, null).name));

  useEffect(() => {
    if (job && (job.status === 'running' || job.status === 'halted')) setRanId(job.id);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!acceptNext || active === null) return;
    setAccepted(acceptedOf(active, pickedRoute(active, pick).name));
    setAcceptNext(false);
  }, [acceptNext, active, pick]);

  const pickGoal = (next: GoalKind) => {
    setGoal(next);
    setPick(null);
    // A preset's plan is already in hand, so its quote is accepted in the
    // same render; only a custom move has to wait for its price to land.
    if (next === 'custom') setAcceptNext(true);
    else setAccepted(acceptedOf(view.plans[next], pickedRoute(view.plans[next], null).name));
  };
  const pickPreset = (next: PresetPick) => {
    if (next !== 'none') pickGoal(next);
  };
  const enterCustom = () => {
    // Seeded from the preset in view, so the number that becomes editable is
    // the one the trader was just reading.
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

  const { name: chosen, route } = pickedRoute(plan, pick);
  const choose = (name: RouteName | null) => {
    setPick(name);
    setAccepted(acceptedOf(plan, pickedRoute(plan, name).name));
  };
  const finished = job?.status === 'done' && (job.id === ranId || start.isSuccess);
  const moveSteps = running || halted ? job.steps : planSteps(plan);
  const keys = shownKeys(view, moveSteps, plan);
  const target = targetsOf(view, plan);
  const borrow = receivingBorrow(buckets, moveSteps);
  const held = receivingHeld(buckets, moveSteps);
  const stale = isStale(accepted, plan, chosen);
  let lock: string | null = null;
  if (transfer?.lock === 'deal') lock = WAITS_FOR_DEAL;
  if (transfer?.transfer?.status === 'moving') lock = WAITS_FOR_TRANSFER;
  const nowRows = barRowsOf(buckets, keys, target);
  const afterRows = barRowsOf(route.after, keys, target);
  // A custom move gets the verdict too, when it is one that clears a borrow:
  // the reason to move is a property of the book, not of which control
  // picked the amount (his catch 2026-09-19).
  const clearsBorrow = goal !== 'custom' || receivingBorrow(buckets, planSteps(plan)) !== null;
  const worth = chosen === null || !clearsBorrow ? null : worthLine(route, buckets, goal, plan.noLegs);
  const scale = scaleOf(nowRows, afterRows);
  const walletPools = POOLS.filter((pool) => buckets.some((bucket) => keyOf(bucket) === poolKey(pool)));
  const presetOptions = (['even', 'repay'] as const).map((preset) => ({
    value: preset,
    label: GOAL_LABEL[preset],
    disabled: view.plans[preset].balanced,
    title: presetOffText(preset, view.plans[preset]),
  }));
  const spotRow = (label: string, text: string, qty: number): BarRow => ({
    key: 'spot',
    label: <Term label={label} text={text} />,
    name: label,
    cash: qty,
    upnl: 0,
    target: null,
    tone: 'spot',
  });

  let chip: ReactNode = null;
  let body: ReactNode = null;

  if (running || halted) {
    const moving = running || job.inTransit?.at === 'MOVING';
    const rows = job.inTransit
      ? [...nowRows, spotRow(moving ? ON_THE_WAY : GATE_SPOT, moving ? HOVER.onTheWay : HOVER.gateSpot, job.inTransit.qty)]
      : nowRows;
    const rounds = roundCountOf(job);
    const round = roundOf(job);
    const total = jobSeconds(job);
    const elapsed = Math.max(0, (running ? now : job.updatedAt) - job.createdAt);
    if (running) {
      chip = <Chip tone="info">Running</Chip>;
      const left = Math.max(0, total - elapsed / 1000);
      body = (
        <>
          <p className="text-xs text-ink-400">{`Started ${fmtAge(elapsed)} ago. ${KEEPS_GOING}`}</p>
          <Facts
            items={[
              { key: 'goal', label: FOR_LABEL, value: CARD_LABEL[job.goal] },
              { key: 'route', label: 'Route', value: ROUTE_LABEL[job.route] },
              ...(round === null ? [] : [{ key: 'round', label: 'Round', value: `${num(round, 0)} of ${num(rounds, 0)}` }]),
              {
                key: 'time',
                label: total > 0 ? 'Time left' : 'Time',
                value: total > 0 ? fmtAbout(left) : fmtAge(elapsed),
                sub: total > 0 ? [`${fmtAge(elapsed)} ${PASSED}`] : [],
              },
            ]}
          />
          <ProgressBar ratio={total > 0 ? elapsed / 1000 / total : 0} tone="running" />
          <BalanceBars caption={<Term label={NOW_CAPTION} text={HOVER.now} />} rows={rows} scale={scaleOf(rows)} />
          <p className="text-xs text-ink-400">{WAITS_LINE}</p>
          <StepsFold
            open={stepsOpen}
            onToggle={() => setStepsOpen(!stepsOpen)}
            hover={stepsHoverOf(rounds, held)}
            rows={jobRows(job, now, borrow)}
          />
        </>
      );
    } else {
      chip = <Chip tone="red">Stopped</Chip>;
      const busy = resume.isPending || abandon.isPending;
      body = (
        <>
          <div role="alert" className="alert-red">
            <p className="num text-xs font-semibold text-guava">
              {round === null ? 'Stopped at Convert.' : `Stopped in round ${num(round, 0)} of ${num(rounds, 0)}.`}
            </p>
            {job.haltReason && <p className="text-xs text-ink-300">{job.haltReason}</p>}
          </div>
          <BalanceBars caption={WHERE_CAPTION} rows={rows} scale={scaleOf(rows)} />
          {transfer?.spot === null && <NoSpotReadLine />}
          <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
          <div className="flex flex-wrap items-center gap-3 border-t border-ink-800 pt-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => resume.mutate(job.id, { onError })}
            >
              {resume.isPending ? 'Resuming' : MODAL_RESUME}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => abandon.mutate(job.id, { onError })}>
              {MODAL_ABANDON}
            </button>
            <span className="num text-xs text-ink-400">{abandonNote(job, transfer)}</span>
          </div>
        </>
      );
    }
  } else if (finished) {
    const landed = landedOf(job);
    const short = landed < job.amount - (job.costUsd ?? 0) - Math.max(SHORT_FLOOR_USD, SHORT_SHARE * job.amount);
    // "Balanced" is the even goal's promise; a repaid borrow or a custom move
    // is simply done.
    chip = short || job.goal !== 'even' ? <Chip>Done</Chip> : <Chip tone="green">Balanced</Chip>;
    const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
    body = (
      <>
        <p className="text-xs text-ink-400">{FINISHED_LEAD}</p>
        <Facts
          items={[
            { key: 'goal', label: FOR_LABEL, value: CARD_LABEL[job.goal] },
            { key: 'route', label: 'Route', value: ROUTE_LABEL[job.route] },
            { key: 'moved', label: 'Moved', value: fmtUsd(landed) },
            { key: 'took', label: 'Took', value: fmtAge(took) },
            ...(job.costUsd === null ? [] : [{ key: 'cost', label: 'Cost', value: fmtUsd(job.costUsd) }]),
          ]}
        />
        <BalanceBars caption={<Term label={NOW_CAPTION} text={HOVER.now} />} rows={nowRows} scale={scale} />
        <StepsFold
          open={stepsOpen}
          onToggle={() => setStepsOpen(!stepsOpen)}
          hover={stepsHoverOf(roundCountOf(job), held)}
          rows={jobRows(job, now, borrow)}
        />
        {/* The run finished under the dialog; one button puts it away (his ask 2026-09-19). */}
        <div className="border-t border-ink-800 pt-3">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {CLOSE}
          </button>
        </div>
      </>
    );
  } else {
    const poolOptions = walletPools.map((pool) => (
      <option key={pool} value={pool}>
        {WALLET_LABEL[poolKey(pool)]}
      </option>
    ));
    // One row of presets, and the custom move a link away. A preset says
    // nothing more here — its amount is on the route rows and the bars below;
    // Custom amount opens fields seeded from the preset's own move.
    const header = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Term
            wrapsControl
            label={
              <SegmentedToggle<PresetPick>
                ariaLabel={PRESET_LABEL}
                value={goal === 'custom' ? 'none' : goal}
                options={presetOptions}
                onChange={pickPreset}
              />
            }
            text={HOVER.presets}
          />
          <button type="button" className="btn-link" onClick={goal === 'custom' ? leaveCustom : enterCustom}>
            {goal === 'custom' ? USE_PRESET : GOAL_LABEL.custom}
          </button>
        </div>
        {goal === 'custom' && (
          <div className="num flex flex-wrap items-center gap-2 text-sm text-ink-300">
            <span className="text-ink-400">{MOVE}</span>
            <input
              aria-label={AMOUNT_LABEL}
              className="input num h-[30px] w-28 !py-0 text-xs"
              inputMode="decimal"
              value={customText}
              onChange={(e) => editCustom(() => setCustomText(e.target.value))}
            />
            <span className="text-ink-400">{MOVE_FROM}</span>
            <select aria-label={FROM_LABEL} className="input num h-[30px] !w-44 !py-0 text-xs" value={customFrom} onChange={(e) => editCustom(() => setCustomFrom(e.target.value as Pool))}>
              {poolOptions}
            </select>
            <span className="text-ink-400">{MOVE_TO}</span>
            <select aria-label={TO_LABEL} className="input num h-[30px] !w-44 !py-0 text-xs" value={customTo} onChange={(e) => editCustom(() => setCustomTo(e.target.value as Pool))}>
              {poolOptions}
            </select>
          </div>
        )}
      </div>
    );
    if (customPending) {
      const hint = customMove === null ? TYPE_AN_AMOUNT : customQuery.isError ? customQuery.error.message : PRICING;
      body = (
        <>
          {header}
          <p className="text-xs text-ink-400">{hint}</p>
        </>
      );
    } else if (goal === 'custom' && plan.balanced) {
      body = (
        <>
          {header}
          <p className="text-xs text-ink-400">{isCashLimitedEven(plan) ? `${fmtUsd(plan.shortOfEven)} ${SHORT_OF_CASH}` : NOTHING_TO_MOVE}</p>
        </>
      );
    } else body = (
      <>
        {header}
        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <div className={microLabelClass}>
            <Term label="Route" text={HOVER.route} />
          </div>
          {/* Every route, always, recommended first (his call 2026-09-19):
              the time and fee side by side are the choice. */}
          <div role="radiogroup" aria-label="Route" className="flex flex-col gap-1.5">
            {routeOrder(plan).map((name) => (
              <RouteRow key={name} route={name} plan={plan} checked={chosen === name} onPick={() => choose(name)} />
            ))}
          </div>
        </div>
        {route.steps.length > 0 && (
          <StepsFold
            open={stepsOpen}
            onToggle={() => setStepsOpen(!stepsOpen)}
            hover={stepsHoverOf(route.rounds, held)}
            rows={planRows(route, borrow)}
          />
        )}
        <div className="flex gap-3 border-t border-ink-800 pt-3">
          <div className="min-w-0 flex-1">
            <BalanceBars caption={AFTER_LABEL[goal]} rows={afterRows} scale={scale} />
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <Facts items={quoteFactsOf(route, view)} />
          {/* The SAME component and sentence the Balances card shows, so the
              verdict a trader read before opening cannot disagree with the one
              inside the dialog. */}
          {worth && <VerdictAlert tone={worth.tone} text={worth.text} sub={worth.sub} />}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* A stale plan replaces the confirm outright rather than sitting as a
              warning above a disabled one: the only move available is to take
              the new route, so it is one button, not a sentence plus a button
              plus a dead control (his call 2026-09-18). */}
          {stale ? (
            <button type="button" className="btn btn-primary num" onClick={() => setAccepted(acceptedOf(plan, chosen))}>
              {MODAL_REFRESH_ROUTE}
            </button>
          ) : (
            <HoldToConfirmButton
              tone="cyan"
              holdMs={holdMs}
              disabled={lock !== null || chosen === null || start.isPending}
              onConfirm={() =>
                chosen &&
                start.mutate(
                  { goal, route: chosen, costUsd: route.costUsd, ...(goal === 'custom' && customMove ? customMove : {}) },
                  { onError: onStartError },
                )
              }
            >
              {HOLD_LABEL[goal]}
            </HoldToConfirmButton>
          )}
          {lock !== null && <span className="text-xs text-ink-500">{lock}</span>}
        </div>
        <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
      </>
    );
  }

  return (
    <Modal
      widthClass="w-[680px]"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {TITLE}
          {chip}
        </span>
      }
    >
      <div className="flex flex-col gap-4">{body}</div>
    </Modal>
  );
}
