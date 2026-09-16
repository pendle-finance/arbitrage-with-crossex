import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useAccount, usePositions, useRebalanceCommand, useStartRebalance, useTransfer } from '../api/queries';
import type { CrossexAccount, EvenPlan, GateAccount, Pool, PositionsResponse, RebalanceBucket } from '../api/types';
import type { RebalanceView, RouteName, RoutePlan, TransferCoin, WalletAfter } from '../api/types';
import { Chip } from '../components/Chip';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Modal } from '../components/Modal';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { borrowingBuckets, borrowTotalUsd } from '../lib/borrow';
import { fmtAbout, fmtAge, fmtUsd, num, WALLET_SHORT } from '../lib/fmt';
import { describeLine, fmtLinePrice, lineFor, liquidationLines, nearestLiquidation } from '../lib/liquidation';
import { useNow } from '../lib/useNow';
import { ALWAYS_SHOWN, BalanceBars, jobRows, jobSeconds, planRows, ProgressBar, ROUTE_ORDER, scaleOf, StepList, WALLET_TONE } from './RebalanceBits';
import type { BarRow, StepRow } from './RebalanceBits';
import { FACT_LIQUIDATION, GATE_SPOT, HOVER, MODAL_ABANDON, MODAL_AFTER, MODAL_CHANGE_ROUTE, MODAL_FREES } from './rebalanceCopy';
import { MODAL_HOLD, MODAL_KEEP_ROUTE, MODAL_RESUME, MODAL_SAVES, MODAL_STEPS, poolKey } from './rebalanceCopy';
import { BORROW_INITIAL_MARGIN, DUST, Facts, keyOf, movesKey, planSteps, receivingBorrow, ROUTE_LABEL, roundCountOf } from './RebalanceHovers';
import { RouteRow, SpotLines, targetsOf, Term, WalletTerm, type Fact } from './RebalanceHovers';
import { NoSpotReadLine } from './TransferBits';

const COUNT_WORD: Record<number, string> = { 2: 'two', 3: 'three' };

const TITLE = 'Rebalance';
const HIDE_STEPS = 'Hide the steps';
const PRESS_AND_HOLD = 'press and hold';
const NOW_CAPTION = 'Now';
const WHERE_CAPTION = 'Where your money is';
const ON_THE_WAY = 'On the way';
const WAITS_LINE = 'New deals and transfers wait until it ends.';
const KEEPS_GOING = 'You can close this. The run keeps going.';
const PLAN_CHANGED = 'The plan changed. Check the new route before you rebalance.';
const USE_NEW_PLAN = 'Use the new plan';
const FINISHED_LEAD = 'Done. This is what each wallet holds now.';
const NO_BORROW_TO_REPAY = 'no borrow to repay';
const MARGIN_RETURNED = 'margin the repay returns';
const NO_INTEREST_TO_STOP = 'no interest to stop';

const leadText = (plan: EvenPlan, buckets: RebalanceBucket[]): string => {
  const moved = fmtUsd(plan.moves);
  const borrowing = borrowingBuckets(buckets);
  if (borrowing.length === 0) return `Moves ${moved} so each wallet matches its position share.`;
  const coins = new Set(borrowing.map((b) => b.coin));
  const total = borrowTotalUsd(buckets);
  const repaid = coins.size === 1 ? `${num(total)} ${[...coins][0]}` : fmtUsd(total);
  const where =
    borrowing.length === 1
      ? `on ${WALLET_SHORT[keyOf(borrowing[0])]}`
      : `across ${COUNT_WORD[borrowing.length] ?? num(borrowing.length, 0)} wallets`;
  return `Moves ${moved} and repays ${repaid} ${where}.`;
};

const stampOf = (plan: EvenPlan): string =>
  [movesKey(planSteps(plan)), plan.recommended, ...ROUTE_ORDER.map((name) => plan.routes[name]?.costUsd ?? '')].join(':');

function shownKeys(view: RebalanceView, steps: readonly { from: Pool; to: Pool }[]): string[] {
  const touched = new Set(steps.flatMap((step) => [poolKey(step.from), poolKey(step.to)]));
  const shared = new Set(view.plan.split.map(keyOf));
  return Object.keys(WALLET_TONE).filter((key) => {
    const bucket = view.buckets.find((b) => keyOf(b) === key);
    if (!bucket) return false;
    if (ALWAYS_SHOWN.includes(key) || touched.has(key) || shared.has(key)) return true;
    return Math.abs(bucket.cash) >= DUST || Math.abs(bucket.equity) >= DUST;
  });
}

function barRows(wallets: (WalletAfter | RebalanceBucket)[], keys: string[], target: Map<string, number>): BarRow[] {
  return keys.flatMap((key): BarRow[] => {
    const wallet = wallets.find((w) => keyOf(w) === key);
    if (!wallet) return [];
    return [
      {
        key,
        label: <WalletTerm wallet={key} />,
        cash: wallet.cash,
        upnl: wallet.equity - wallet.cash,
        target: target.get(key) ?? null,
        tone: WALLET_TONE[key],
      },
    ];
  });
}

interface Book {
  account: CrossexAccount | undefined;
  positions: PositionsResponse | undefined;
}

function liquidationFact(route: RoutePlan, view: RebalanceView, book: Book): Fact {
  const { account: acc, positions: pos } = book;
  const before = nearestLiquidation(acc, pos);
  if (!before || !acc || !pos) return { key: 'liquidation', label: FACT_LIQUIDATION, value: 'none' };
  const equityOf = (wallets: (WalletAfter | RebalanceBucket)[], key: string) =>
    wallets.find((w) => keyOf(w) === key)?.equity ?? 0;
  const shiftOf = (key: string) => equityOf(route.after, key) - equityOf(view.buckets, key);
  const moved = liquidationLines(acc, pos, {
    'USDT/CROSSEX': shiftOf('USDT/CROSSEX'),
    'USDC/HYPERLIQUID': shiftOf('USDC/HYPERLIQUID'),
    'USDC/LIGHTER': shiftOf('USDC/LIGHTER'),
  });
  const after = moved ? lineFor(moved, before.base) : null;
  const afterText = after === 'far' ? 'none' : after ? fmtLinePrice(after.price) : 'unknown';
  return {
    key: 'liquidation',
    label: <Term label={FACT_LIQUIDATION} text={describeLine(before)} />,
    value: `${fmtLinePrice(before.price)} → ${afterText}`,
    sub: [`${before.base}, if only ${before.base} moves`],
  };
}

function quoteFactsOf(route: RoutePlan, view: RebalanceView, book: Book): Fact[] {
  const borrowing = borrowingBuckets(view.buckets);
  const paying = borrowing.filter((b) => b.interestPerDayUsd > 0).map((b) => WALLET_SHORT[keyOf(b)]);
  return [
    {
      key: 'frees',
      label: <Term label={MODAL_FREES} text={HOVER.frees} />,
      value: fmtUsd(route.marginFreedUsd),
      sub: [borrowing.length === 0 ? NO_BORROW_TO_REPAY : MARGIN_RETURNED],
    },
    {
      key: 'saves',
      label: <Term label={MODAL_SAVES} text={HOVER.saves} />,
      value: `${fmtUsd(route.savesPerDayUsd)} a day`,
      sub: [paying.length === 0 ? NO_INTEREST_TO_STOP : `${paying.join(' and ')} interest stops`],
    },
    liquidationFact(route, view, book),
  ];
}

function StepsFold({ open, onToggle, hover, rows }: { open: boolean; onToggle: () => void; hover: string; rows: StepRow[] }) {
  const toggle = (
    <button type="button" className="btn-link inline-flex items-center gap-1" aria-expanded={open} onClick={onToggle}>
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      {open ? HIDE_STEPS : MODAL_STEPS}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <span className="self-start">
        <Term wrapsControl label={toggle} text={hover} />
      </span>
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
  const account = useAccount().data;
  const positions = usePositions().data;
  const transfer = useTransfer().data;
  const start = useStartRebalance();
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const toast = useToast();
  const now = useNow();
  const { plan, job, buckets } = view;
  const [pick, setPick] = useState<RouteName | null>(null);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [accepted, setAccepted] = useState(() => stampOf(plan));
  const [ranId, setRanId] = useState<string | null>(null);
  const running = job?.status === 'running';
  const halted = job?.status === 'halted';

  useEffect(() => {
    if (job && (job.status === 'running' || job.status === 'halted')) setRanId(job.id);
  }, [job?.id, job?.status]);

  const onError = (error: Error) => {
    const hint = error instanceof ApiError ? error.hint : undefined;
    const period = error.message.endsWith('.') ? '' : '.';
    toast.push('error', hint ? `${error.message}${period} ${hint}` : error.message);
  };

  const isOpen = (name: RouteName | null): name is RouteName => name !== null && plan.routes[name]?.available === true;
  const chosen = [pick, plan.recommended, ...ROUTE_ORDER].find(isOpen) ?? null;
  const route = plan.routes[chosen ?? plan.recommended ?? 'convert'] ?? plan.routes.convert;
  const finished = job?.status === 'done' && (job.id === ranId || start.isSuccess);
  const moveSteps = running || halted ? job.steps : planSteps(plan);
  const keys = shownKeys(view, moveSteps);
  const target = targetsOf(view);
  const borrow = receivingBorrow(buckets, moveSteps);
  const stale = accepted !== stampOf(plan);
  const others = ROUTE_ORDER.filter((name) => name !== chosen && plan.routes[name] !== null);
  const stepsHover = [
    HOVER.rebalanceTitle.rounds,
    HOVER.whyMoreThanOne,
    ...(borrow === null ? [] : [HOVER.whyMoreThanOneBorrow(fmtUsd(borrow * BORROW_INITIAL_MARGIN))]),
  ].join(' ');
  const nowRows = barRows(buckets, keys, target);
  const spotRow = (label: string, text: string, qty: number): BarRow => ({
    key: 'spot',
    label: <Term label={label} text={text} />,
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
    const round = job.steps[job.stepIndex]?.round ?? null;
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
              { key: 'route', label: 'Route', value: ROUTE_LABEL[job.route] },
              ...(round === null ? [] : [{ key: 'round', label: 'Round', value: `${num(round, 0)} of ${num(rounds, 0)}` }]),
              {
                key: 'time',
                label: total > 0 ? 'Time left' : 'Time',
                value: total > 0 ? fmtAbout(left) : fmtAge(elapsed),
                sub: total > 0 ? [`${fmtAge(elapsed)} gone`] : [],
              },
            ]}
          />
          <ProgressBar ratio={total > 0 ? elapsed / 1000 / total : 0} tone="running" />
          <BalanceBars caption={<Term label={NOW_CAPTION} text={HOVER.now} />} rows={rows} scale={scaleOf(rows)} />
          <p className="text-xs text-ink-400">{WAITS_LINE}</p>
          <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHover} rows={jobRows(job, now, borrow)} />
        </>
      );
    } else {
      chip = <Chip tone="red">Stopped</Chip>;
      const busy = resume.isPending || abandon.isPending;
      const leaves = job.inTransit
        ? `${MODAL_ABANDON} leaves the ${num(job.inTransit.qty)} ${job.inTransit.coin} ${job.inTransit.at === 'SPOT' ? `in ${GATE_SPOT}` : 'on the way'}.`
        : HOVER.abandon;
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
            <span className="num text-xs text-ink-400">{leaves}</span>
          </div>
        </>
      );
    }
  } else if (finished) {
    chip = <Chip tone="green">Balanced</Chip>;
    const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
    body = (
      <>
        <p className="text-xs text-ink-400">{FINISHED_LEAD}</p>
        <Facts
          items={[
            { key: 'route', label: 'Route', value: ROUTE_LABEL[job.route] },
            { key: 'moved', label: 'Moved', value: fmtUsd(job.amount) },
            { key: 'took', label: 'Took', value: fmtAge(took) },
            ...(job.costUsd === null ? [] : [{ key: 'cost', label: 'Cost', value: fmtUsd(job.costUsd) }]),
          ]}
        />
        <BalanceBars caption={<Term label={NOW_CAPTION} text={HOVER.now} />} rows={nowRows} scale={scaleOf(nowRows)} />
        <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHover} rows={jobRows(job, now, borrow)} />
      </>
    );
  } else {
    const afterRows = barRows(route.after, keys, target);
    const scale = scaleOf(nowRows, afterRows);
    body = (
      <>
        <p className="text-xs text-ink-400">{leadText(plan, buckets)}</p>
        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <div className={microLabelClass}>
            <Term label="Route" text={HOVER.route} />
          </div>
          {!routesOpen && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold text-ink-100">{ROUTE_LABEL[chosen ?? 'convert']}</span>
              {plan.recommended === chosen && (
                <Term label={<Chip tone="green" sm>Recommended</Chip>} text={HOVER.recommended} />
              )}
              <span className="num text-ink-400">
                {`${route.seconds > 0 ? fmtAbout(route.seconds) : 'instant'} · ${fmtUsd(route.costUsd)}`}
              </span>
              {others.length > 0 && (
                <button type="button" className="btn-ghost-xs ml-auto" onClick={() => setRoutesOpen(true)}>
                  {MODAL_CHANGE_ROUTE} <span className="text-ink-500">{`· ${num(others.length, 0)} more`}</span>
                </button>
              )}
            </div>
          )}
          {routesOpen && (
            <>
              <div role="radiogroup" aria-label="Route" className="flex flex-col gap-1.5">
                {ROUTE_ORDER.filter((name) => plan.routes[name] !== null).map((name) => (
                  <RouteRow
                    key={name}
                    route={name}
                    plan={plan}
                    borrow={borrow}
                    checked={chosen === name}
                    onPick={() => setPick(name)}
                  />
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost-xs self-start"
                onClick={() => {
                  setPick(null);
                  setRoutesOpen(false);
                }}
              >
                {MODAL_KEEP_ROUTE}
              </button>
            </>
          )}
        </div>
        {route.steps.length > 0 && (
          <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHover} rows={planRows(route, borrow)} />
        )}
        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <BalanceBars caption={MODAL_AFTER} rows={afterRows} scale={scale} />
        </div>
        <div className="border-t border-ink-800 pt-3">
          <Facts items={quoteFactsOf(route, view, { account, positions })} />
        </div>
        {stale && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-xs text-gold">
              {PLAN_CHANGED}
            </p>
            <button type="button" className="btn-ghost-xs" onClick={() => setAccepted(stampOf(plan))}>
              {USE_NEW_PLAN}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <HoldToConfirmButton
            tone="cyan"
            holdMs={holdMs}
            disabled={stale || chosen === null || start.isPending}
            onConfirm={() => chosen && start.mutate({ route: chosen }, { onError })}
          >
            {MODAL_HOLD}
          </HoldToConfirmButton>
          <span className="text-xs text-ink-500">{PRESS_AND_HOLD}</span>
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
