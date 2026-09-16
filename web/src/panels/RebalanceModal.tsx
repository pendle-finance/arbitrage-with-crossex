import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useAccount, usePositions, useRebalanceCommand, useStartRebalance, useTransfer } from '../api/queries';
import type { CrossexAccount, EvenPlan, GateAccount, PositionsResponse, RebalanceBucket, RebalanceJob } from '../api/types';
import type { RebalanceView, RouteName, RoutePlan, TransferCoin, TransferView, WalletAfter } from '../api/types';
import { Chip } from '../components/Chip';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { Modal } from '../components/Modal';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { borrowingBuckets } from '../lib/borrow';
import { fmtAbout, fmtAge, fmtUsd, num, WALLET_SHORT } from '../lib/fmt';
import { describeLine, fmtLinePrice, lineFor, liquidationLines } from '../lib/liquidation';
import { floorCents } from '../lib/ticks';
import { useNow } from '../lib/useNow';
import { BalanceBars, jobRows, jobSeconds, planRows, ProgressBar, ROUTE_ORDER, scaleOf, StepList } from './RebalanceBits';
import type { BarRow, StepRow } from './RebalanceBits';
import { FACT_LIQUIDATION, GATE_SPOT, HOVER, LIQUIDATION_NOT_KNOWN, MODAL_ABANDON, MODAL_AFTER, MODAL_CHANGE_ROUTE, MODAL_FREES } from './rebalanceCopy';
import { MODAL_HOLD, MODAL_KEEP_ROUTE, MODAL_RESUME, MODAL_SAVES, MODAL_STEPS, WAITS_FOR_DEAL, WAITS_FOR_TRANSFER } from './rebalanceCopy';
import { barRowsOf, chargedBorrow, Facts, fmtCoinOrUsd, keyOf, movesKey, pickedRoute, planSteps, receivingBorrow, receivingHeld } from './RebalanceHovers';
import { liquidationNow, repayOf, ROUTE_LABEL, roundCountOf, roundOf, RouteRow, sharedCoin, shownKeys, SpotLines, targetsOf, Term } from './RebalanceHovers';
import type { Fact, Repay } from './RebalanceHovers';
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
const REPAYS_NO_BORROW = 'repays no borrow';
const STOPS_NO_INTEREST = 'stops no interest';
const NOT_MARGIN_UNTIL_LANDS = 'It is not margin until it lands.';
const NO_SPOT_READ = 'This key cannot read Gate spot.';

const leadText = (plan: EvenPlan, repay: Repay): string => {
  const moved = fmtUsd(plan.moves);
  const { wallets } = repay;
  if (wallets.length === 0) return `Moves ${moved} so each wallet matches its position share.`;
  const repaid = fmtCoinOrUsd(repay.amount, sharedCoin(wallets));
  const where =
    wallets.length === 1
      ? `on ${WALLET_SHORT[keyOf(wallets[0])]}`
      : `across ${COUNT_WORD[wallets.length] ?? num(wallets.length, 0)} wallets`;
  return `Moves ${moved} and repays ${repaid} ${where}.`;
};

function stampOf(plan: EvenPlan, name: RouteName | null): string {
  const route = name === null ? null : plan.routes[name];
  return [plan.recommended, name, movesKey(route?.steps ?? []), route ? fmtUsd(route.costUsd) : ''].join(':');
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

function abandonNote(job: RebalanceJob, transfer: TransferView | undefined): string {
  const transit = job.inTransit;
  if (!transit) return HOVER.abandon;
  if (transit.at !== 'SPOT') return `${MODAL_ABANDON} leaves ${num(transit.qty)} ${transit.coin} in transit. ${NOT_MARGIN_UNTIL_LANDS}`;
  const inSpot = `${MODAL_ABANDON} leaves the ${num(transit.qty)} ${transit.coin} in ${GATE_SPOT}.`;
  return transfer?.spot === null ? `${inSpot} ${NO_SPOT_READ}` : inSpot;
}

interface Book {
  account: CrossexAccount | undefined;
  positions: PositionsResponse | undefined;
}

function liquidationFact(route: RoutePlan, view: RebalanceView, book: Book): Fact {
  const { account: acc, positions: pos } = book;
  const before = liquidationNow(acc, pos);
  if (before === 'unknown' || !acc || !pos) return { key: 'liquidation', label: FACT_LIQUIDATION, value: LIQUIDATION_NOT_KNOWN };
  if (before === null) return { key: 'liquidation', label: FACT_LIQUIDATION, value: 'none' };
  const equityOf = (wallets: (WalletAfter | RebalanceBucket)[], key: string) =>
    wallets.find((w) => keyOf(w) === key)?.equity ?? 0;
  const shiftOf = (key: string) => equityOf(route.after, key) - equityOf(view.buckets, key);
  const moved = liquidationLines(acc, pos, {
    'USDT/CROSSEX': shiftOf('USDT/CROSSEX'),
    'USDC/HYPERLIQUID': shiftOf('USDC/HYPERLIQUID'),
    'USDC/LIGHTER': shiftOf('USDC/LIGHTER'),
  });
  const after = moved ? lineFor(moved, before.base) : null;
  const afterText = after === 'far' ? 'none' : after ? fmtLinePrice(after.price) : LIQUIDATION_NOT_KNOWN;
  return {
    key: 'liquidation',
    label: <Term label={FACT_LIQUIDATION} text={describeLine(before)} />,
    value: `${fmtLinePrice(before.price)} → ${afterText}`,
    sub: [`${before.base}, if only ${before.base} moves`],
  };
}

const walletNames = (wallets: { bucket: RebalanceBucket }[]) => wallets.map((w) => WALLET_SHORT[keyOf(w.bucket)]).join(' and ');

function repaySubs(buckets: RebalanceBucket[], route: RoutePlan): { frees: string; saves: string } {
  const repay = repayOf(buckets, route);
  const borrowing = borrowingBuckets(buckets);
  const stops = repay.charged.filter((w) => floorCents(w.before) > 0 && floorCents(w.after) === 0);
  const falls = repay.charged.filter((w) => floorCents(w.after) > 0 && w.after < w.before);
  const named = [
    ...(stops.length > 0 ? [`${walletNames(stops)} interest stops`] : []),
    ...(falls.length > 0 ? [`${walletNames(falls)} interest falls`] : []),
  ];
  const paysInterest = borrowing.some((b) => floorCents(chargedBorrow(b, b.borrow)) > 0);
  const saves = named.length > 0 ? named.join(' · ') : paysInterest ? STOPS_NO_INTEREST : NO_INTEREST_TO_STOP;
  if (repay.wallets.length > 0) return { frees: MARGIN_RETURNED, saves };
  return { frees: borrowing.length > 0 ? REPAYS_NO_BORROW : NO_BORROW_TO_REPAY, saves };
}

function quoteFactsOf(route: RoutePlan, view: RebalanceView, book: Book): Fact[] {
  const subs = repaySubs(view.buckets, route);
  return [
    {
      key: 'frees',
      label: <Term label={MODAL_FREES} text={HOVER.frees} />,
      value: fmtUsd(route.marginFreedUsd),
      sub: [subs.frees],
    },
    {
      key: 'saves',
      label: <Term label={MODAL_SAVES} text={HOVER.saves} />,
      value: `${fmtUsd(route.savesPerDayUsd)} a day`,
      sub: [subs.saves],
    },
    liquidationFact(route, view, book),
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
  const [accepted, setAccepted] = useState(() => stampOf(plan, pickedRoute(plan, null).name));
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

  const { name: chosen, route } = pickedRoute(plan, pick);
  const choose = (name: RouteName | null) => {
    setPick(name);
    setAccepted(stampOf(plan, pickedRoute(plan, name).name));
  };
  const finished = job?.status === 'done' && (job.id === ranId || start.isSuccess);
  const moveSteps = running || halted ? job.steps : planSteps(plan);
  const keys = shownKeys(view, moveSteps);
  const target = targetsOf(view);
  const borrow = receivingBorrow(buckets, moveSteps);
  const held = receivingHeld(buckets, moveSteps);
  const stale = accepted !== stampOf(plan, chosen);
  const others = ROUTE_ORDER.filter((name) => name !== chosen && plan.routes[name] !== null);
  let lock: string | null = null;
  if (transfer?.lock === 'deal') lock = WAITS_FOR_DEAL;
  if (transfer?.transfer?.status === 'moving') lock = WAITS_FOR_TRANSFER;
  const nowRows = barRowsOf(buckets, keys, target);
  const afterRows = barRowsOf(route.after, keys, target);
  const scale = scaleOf(nowRows, afterRows);
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
        <BalanceBars caption={<Term label={NOW_CAPTION} text={HOVER.now} />} rows={nowRows} scale={scale} />
        <StepsFold
          open={stepsOpen}
          onToggle={() => setStepsOpen(!stepsOpen)}
          hover={stepsHoverOf(roundCountOf(job), held)}
          rows={jobRows(job, now, borrow)}
        />
      </>
    );
  } else {
    body = (
      <>
        <p className="text-xs text-ink-400">{leadText(plan, repayOf(buckets, route))}</p>
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
                {routeOrder(plan).map((name) => (
                  <RouteRow key={name} route={name} plan={plan} checked={chosen === name} onPick={() => choose(name)} />
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost-xs self-start"
                onClick={() => {
                  choose(null);
                  setRoutesOpen(false);
                }}
              >
                {MODAL_KEEP_ROUTE}
              </button>
            </>
          )}
        </div>
        {route.steps.length > 0 && (
          <StepsFold
            open={stepsOpen}
            onToggle={() => setStepsOpen(!stepsOpen)}
            hover={stepsHoverOf(route.rounds, held)}
            rows={planRows(route, borrow)}
          />
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
            <button type="button" className="btn-ghost-xs" onClick={() => setAccepted(stampOf(plan, chosen))}>
              {USE_NEW_PLAN}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <HoldToConfirmButton
            tone="cyan"
            holdMs={holdMs}
            disabled={stale || lock !== null || chosen === null || start.isPending}
            onConfirm={() => chosen && start.mutate({ route: chosen }, { onError })}
          >
            {MODAL_HOLD}
          </HoldToConfirmButton>
          <span className="text-xs text-ink-500">{lock ?? PRESS_AND_HOLD}</span>
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
