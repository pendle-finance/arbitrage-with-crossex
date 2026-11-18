import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { usePositions } from '../api/queries';
import type { CrossexPosition, EvenPlan, GateAccount, PerpSide, PerpSize, Pool, RealizeJobLeg, RealizeLeg, RealizePlan, RebalanceBucket, RebalanceJob, RebalanceStep } from '../api/types';
import type { RebalanceView, RoutePlan, TransferCoin, TransferView } from '../api/types';
import { Chip } from '../components/Chip';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtAbout, fmtAge, fmtUsd, num, parseSymbol, prettyVenue } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { EstimateRow } from '../trade/PairTicketBits';
import { lots, RebalanceBeforeAfter, receiptChanges } from './RebalanceBeforeAfter';
import { BalanceBars, jobRows, jobSeconds, markPriceOf, planActionLeg, ProgressBar, RealizeActions, RealizeRow, scaleOf, StepList } from './RebalanceBits';
import type { ActionCost, ActionLeg, BarRow, StepRow, StepState } from './RebalanceBits';
import { CARD_LABEL, CONVERT_TO, gateSpot, HOVER, modalFeeLabel, modalImpactLabel, modalResume, modalSteps, PLATFORM } from './rebalanceCopy';
import { poolCoin, poolKey, sideText, sizeText, WALLET_LABEL } from './rebalanceCopy';
import { barRowsOf, daysText, Facts, paybackDays, planSteps, totalCostUsd, WORTH_IT_DAYS, worthChip } from './RebalanceHovers';
import { realizeFeeUsd, realizeImpactUsd, receivingBorrow, receivingHeld, roundCountOf, roundOf } from './RebalanceHovers';
import { ROUTE_LABEL, routeFeeUsd, routeImpactUsd, shownKeys, SpotLines, targetsOf, Term } from './RebalanceHovers';
import { NoSpotReadLine } from './TransferBits';

const LANDING_STEPS: readonly string[] = ['To Hyperliquid', 'To Lighter', 'Convert', 'Convert to USDC'];
const SHORT_FLOOR_USD = 1;
const SHORT_SHARE = 0.005;

export interface Pressed {
  view: RebalanceView;
  plan: EvenPlan;
  route: RoutePlan;
}

export const realizeText = (key: string, values?: Record<string, string | number>): string =>
  t(`accounts.rebalanceRealize.${key}` as 'accounts.rebalanceRealize.howItRuns', values);

const rk = realizeText;

export function refusalOf(plan: EvenPlan): { title: string; body: string } | null {
  const refused = plan.realize?.refused;
  if (!refused) return null;
  const wallet = WALLET_LABEL['USDT/CROSSEX'];
  if (refused.reason === 'no-margin') return { title: rk('marginTitle'), body: rk('marginBody', { wallet }) };
  if (refused.reason === 'past-book') return { title: rk('bookTitle'), body: rk('bookBody') };
  if (refused.reason === 'over-cap') {
    return { title: rk('capTitle', { cap: fmtUsd(refused.capUsd ?? 0, 0) }), body: rk('capBody') };
  }
  const legs = plan.realize?.legs ?? [];
  const worst = legs.reduce<RealizeLeg | null>((top, leg) => (top === null || leg.impactBp > top.impactBp ? leg : top), null);
  const bp = refused.bp ?? worst?.impactBp ?? 0;
  const values = { size: sizeText(worst?.qty ?? 0), base: worst?.base ?? '', bp: num(bp, 1), max: num(refused.maxBp, 0), wallet };
  return { title: rk('impactTitle'), body: rk('impactBody', values) };
}

export function TotalCost({ plan, route, buckets }: { plan: EvenPlan; route: RoutePlan; buckets: RebalanceBucket[] }) {
  const chip = worthChip(plan, route, buckets);
  const days = paybackDays(plan, route, buckets);
  const impact = realizeImpactUsd(plan) + routeImpactUsd(route);
  return (
    <div className="card flex flex-col gap-1.5 p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold text-ink-50">
          {rk('totalCost')}
          {chip === 'worth' && <Chip tone="green" sm>{rk('worthIt')}</Chip>}
          {chip === 'notYet' && <Chip tone="amber" sm>{rk('notWorthItYet')}</Chip>}
        </span>
        <span className="num font-semibold text-ink-50">{fmtUsd(totalCostUsd(plan, route))}</span>
      </div>
      {chip !== null && days !== null && (
        <span className="num text-ink-400">{rk('daysLine', { days: daysText(days), max: num(WORTH_IT_DAYS, 0) })}</span>
      )}
      <div className="flex flex-col gap-1 pl-3">
        <EstimateRow label={modalFeeLabel()} value={fmtUsd(realizeFeeUsd(plan) + routeFeeUsd(route))} />
        {impact > 0 && <EstimateRow label={modalImpactLabel()} value={fmtUsd(impact)} />}
      </div>
    </div>
  );
}

const STEPS_HEAD = 'text-xs font-semibold text-ink-50';

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

const walletOf = (pool: Pool): string => WALLET_LABEL[poolKey(pool)] ?? pool;

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

export const lastRealizeIndex = (job: RebalanceJob): number => job.steps.map((step) => step.name).lastIndexOf('Reopen');

function landedOf(job: RebalanceJob): number {
  const done = job.steps.slice(lastRealizeIndex(job) + 1).filter((step) => step.status === 'done');
  return qtyOf(done.filter((step) => LANDING_STEPS.includes(step.name))) + soldOf(done);
}

export function isShortDone(job: RebalanceJob): boolean {
  const routeAmount = job.amount;
  const routeCost = (job.costUsd ?? 0) - (job.realize?.costUsd ?? 0);
  return landedOf(job) < routeAmount - routeCost - Math.max(SHORT_FLOOR_USD, SHORT_SHARE * routeAmount);
}

function abandonNote(job: RebalanceJob, transfer: TransferView | undefined): string {
  const transit = job.inTransit;
  if (!transit) return HOVER.abandon;
  const values = { qty: num(transit.qty), coin: transit.coin };
  if (transit.at !== 'SPOT') return t('accounts.rebalanceModal.abandonTransit', values);
  return t(transfer?.spot === null ? 'accounts.rebalanceModal.abandonSpotNoRead' : 'accounts.rebalanceModal.abandonSpot', values);
}

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

const legStep = (job: RebalanceJob, leg: RealizeJobLeg, name: string): RebalanceStep | undefined =>
  job.steps.find((step) => step.name === name && step.perp?.symbol === leg.symbol);

function legSteps(job: RebalanceJob, leg: RealizeJobLeg): RebalanceStep[] {
  const close = legStep(job, leg, 'Close');
  const reopen = legStep(job, leg, 'Reopen');
  if (!close || !reopen) return [];
  return job.steps.slice(job.steps.indexOf(close), job.steps.indexOf(reopen) + 1);
}

const convertsOf = (job: RebalanceJob, leg: RealizeJobLeg): RebalanceStep[] =>
  legSteps(job, leg).filter((step) => step.name.startsWith('Convert'));

const restOf = (job: RebalanceJob, leg: RealizeJobLeg): number => lots(leg.filledQty - (legStep(job, leg, 'Reopen')?.qty ?? 0));

const hasRest = (job: RebalanceJob): boolean => (job.realize?.legs ?? []).some((leg) => restOf(job, leg) > 0);

function stateOf(job: RebalanceJob, steps: RebalanceStep[]): StepState {
  if (steps.length > 0 && steps.every((step) => step.status === 'done')) return 'done';
  const current = job.steps[job.stepIndex];
  if (!current || !steps.includes(current)) return 'pending';
  return job.status === 'running' ? 'running' : 'stopped';
}

export interface Gap {
  leg: RealizeJobLeg;
  qty: number;
}

export function gapsOf(job: RebalanceJob): Gap[] {
  return (job.realize?.legs ?? []).flatMap((leg) => {
    const reopen = legStep(job, leg, 'Reopen');
    if (!reopen || reopen.status === 'done') return [];
    const qty = restOf(job, leg);
    return qty > 0 ? [{ leg, qty }] : [];
  });
}

function legSizes(job: RebalanceJob, leg: RealizeJobLeg): { closeQty: number; reopenQty: number } {
  const reopen = legStep(job, leg, 'Reopen');
  const closeQty = leg.filledQty > 0 ? leg.filledQty : leg.qty;
  return { closeQty, reopenQty: reopen?.status === 'done' ? (reopen.qty ?? closeQty) : closeQty };
}

const plannedOf = (plan: RealizePlan | null, leg: RealizeJobLeg): RealizeLeg | undefined => plan?.legs.find((p) => p.symbol === leg.symbol);

function sameSize(job: RebalanceJob, leg: RealizeJobLeg, planned: RealizeLeg | undefined): planned is RealizeLeg {
  const { closeQty, reopenQty } = legSizes(job, leg);
  return planned !== undefined && lots(closeQty) === lots(planned.qty) && lots(reopenQty) === lots(planned.qty);
}

function jobCost(leg: RealizeJobLeg, closeQty: number, reopenQty: number, convertAmount: number): ActionCost | null {
  const { closeFeeUsd, reopenFeeUsd, closeImpactUsd, reopenImpactUsd, convert } = leg;
  if (closeFeeUsd === undefined || reopenFeeUsd === undefined || closeImpactUsd === undefined || reopenImpactUsd === undefined) return null;
  const close = leg.qty > 0 ? closeQty / leg.qty : 0;
  const reopen = leg.qty > 0 ? reopenQty / leg.qty : 0;
  return {
    closeFee: closeFeeUsd * close,
    closeImpact: closeImpactUsd * close,
    convertFee: convert && convert.amount > 0 ? (convert.feeUsd * convertAmount) / convert.amount : 0,
    reopenFee: reopenFeeUsd * reopen,
    reopenImpact: reopenImpactUsd * reopen,
  };
}

function jobActionLegs(job: RebalanceJob, legs: RealizeJobLeg[], plan: RealizePlan | null): ActionLeg[] {
  return legs.map((leg) => {
    const planned = plannedOf(plan, leg);
    const converts = convertsOf(job, leg);
    const convertAmount = converts.reduce((total, step) => total + (step.planned ?? 0), 0);
    const { closeQty, reopenQty } = legSizes(job, leg);
    return {
      symbol: leg.symbol,
      base: leg.base,
      side: leg.side,
      pool: leg.pool,
      positionQty: leg.positionQty,
      closeQty,
      reopenQty,
      convert: converts.length > 0 ? { amount: convertAmount, count: converts.length } : null,
      cost: jobCost(leg, closeQty, reopenQty, convertAmount) ?? (sameSize(job, leg, planned) ? planActionLeg(planned).cost : null),
    };
  });
}

const ROUTE_MOVES: readonly string[] = ['To spot', 'From Hyperliquid', 'From Lighter', 'Convert', 'Convert to USDT'];

const routeMoveOf = (steps: RebalanceStep[]): number =>
  steps.filter((step) => ROUTE_MOVES.includes(step.name)).reduce((total, step) => total + (step.planned ?? 0), 0);

export function perpsOf(positions: readonly CrossexPosition[]): PerpSize[] {
  return positions.flatMap((position) => {
    const signed = Number(position.positionQty);
    const qty = Math.abs(signed);
    if (!(qty > 0)) return [];
    const side = position.positionSide === 'LONG' || position.positionSide === 'SHORT' ? position.positionSide : signed < 0 ? 'SHORT' : 'LONG';
    return [{ symbol: position.symbol, exchange: parseSymbol(position.symbol).exchange, side, qty }];
  });
}

type PerpRow = Pick<PerpSize, 'symbol' | 'side' | 'qty'>;

export const isOtherLeg = (row: PerpRow, leg: RealizeJobLeg): boolean =>
  row.symbol !== leg.symbol && row.side !== leg.side && parseSymbol(row.symbol).base === leg.base;

export function otherLegText(leg: RealizeJobLeg, rows: readonly PerpRow[]): string {
  const side: PerpSide = leg.side === 'SHORT' ? 'LONG' : 'SHORT';
  const other = rows.find((row) => isOtherLeg(row, leg));
  return other ? `${prettyVenue(parseSymbol(other.symbol).exchange)} ${sideText(side)}` : sideText(side);
}

const haltLine = (reason: string | null): string[] => (reason ? [localizeServerText(reason)] : []);

const haltLines = (reason: string | null): string[] =>
  reason ? localizeServerText(reason).split(/(?<=\.)\s+(?=[A-Z])|(?<=。)(?=\S)/) : [];

function stopTitle(job: RebalanceJob): string {
  const round = roundOf(job);
  return round === null
    ? t('accounts.rebalanceModal.stoppedAtConvert')
    : t('accounts.rebalanceModal.stoppedInRound', { round: num(round, 0), rounds: num(roundCountOf(job), 0) });
}

function StopBox({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div role="alert" className="alert-red">
      <p className="num text-xs font-semibold text-guava">{title}</p>
      {lines.map((line) => (
        <p key={line} className="num text-xs text-ink-300">
          {line}
        </p>
      ))}
    </div>
  );
}

interface Props {
  job: RebalanceJob;
  view: RebalanceView;
  now: number;
  onResume: () => void;
  onAbandon: () => void;
  holdMs?: number;
  pressed?: Pressed | null;
  busy?: boolean;
  resuming?: boolean;
  transfer?: TransferView;
  onClose?: () => void;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
}

function Actions({ onResume, onAbandon, holdMs, busy, resuming, note }: Props & { note: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
      <span className="num text-xs text-ink-400">{note}</span>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary px-4 py-2 text-sm" disabled={busy} onClick={onResume}>
          {resuming ? t('accounts.rebalanceModal.resuming') : modalResume()}
        </button>
        <HoldToConfirmButton tone="outline" holdMs={holdMs} disabled={busy} onConfirm={onAbandon}>
          {rk('holdAbandon')}
        </HoldToConfirmButton>
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose?: () => void }) {
  return (
    <div className="border-t border-ink-800 pt-3">
      <button type="button" className="btn btn-primary" onClick={onClose}>
        {t('common.close')}
      </button>
    </div>
  );
}

export function RebalanceJobView(props: Props) {
  return props.job.realize?.legs.length ? <RealizeJobView {...props} /> : <MoveJobView {...props} />;
}

function MoveJobView(props: Props) {
  const { job, view, now, transfer, onTransfer, onClose } = props;
  const [stepsOpen, setStepsOpen] = useState(false);
  const plan = view.plans[job.goal] ?? view.plans.even;
  const keys = shownKeys(view, job.steps, plan);
  const nowRows = barRowsOf(view.buckets, keys, targetsOf(view, plan));
  const borrow = receivingBorrow(view.buckets, job.steps);
  const held = receivingHeld(view.buckets, job.steps);
  const rounds = roundCountOf(job);
  const fold = (
    <StepsFold open={stepsOpen} onToggle={() => setStepsOpen(!stepsOpen)} hover={stepsHoverOf(rounds, held)} rows={jobRows(job, now, borrow)} />
  );
  const spotRow = (label: string, text: string, qty: number): BarRow => ({
    key: 'spot', label: <Term label={label} text={text} />, name: label, cash: qty, upnl: 0, target: null, tone: 'spot',
  });
  if (job.status === 'done') {
    const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
    return (
      <>
        <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.finishedLead')}</p>
        <Facts
          items={[
            { key: 'goal', label: t('accounts.rebalanceModal.for'), value: CARD_LABEL[job.goal] },
            { key: 'route', label: t('accounts.rebalanceModal.route'), value: ROUTE_LABEL[job.route] },
            { key: 'moved', label: t('accounts.rebalanceModal.moved'), value: fmtUsd(landedOf(job)) },
            { key: 'took', label: t('accounts.rebalanceModal.took'), value: fmtAge(took) },
            ...(job.costUsd === null ? [] : [{ key: 'cost', label: t('accounts.rebalanceModal.cost'), value: fmtUsd(job.costUsd) }]),
          ]}
        />
        <BalanceBars caption={<Term label={t('accounts.rebalanceModal.now')} text={HOVER.now} />} rows={nowRows} scale={scaleOf(nowRows)} />
        {fold}
        <CloseButton onClose={onClose} />
      </>
    );
  }
  const running = job.status === 'running';
  const moving = running || job.inTransit?.at === 'MOVING';
  const rows = job.inTransit
    ? [...nowRows, spotRow(moving ? t('accounts.rebalanceModal.onTheWay') : gateSpot(), moving ? HOVER.onTheWay : HOVER.gateSpot, job.inTransit.qty)]
    : nowRows;
  const round = roundOf(job);
  const total = jobSeconds(job);
  const elapsed = Math.max(0, (running ? now : job.updatedAt) - job.createdAt);
  if (running) {
    const left = Math.max(0, total - elapsed / 1000);
    return (
      <>
        <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.started', { age: fmtAge(elapsed) })}</p>
        <Facts
          items={[
            { key: 'goal', label: t('accounts.rebalanceModal.for'), value: CARD_LABEL[job.goal] },
            { key: 'route', label: t('accounts.rebalanceModal.route'), value: ROUTE_LABEL[job.route] },
            ...(round === null
              ? []
              : [{ key: 'round', label: t('accounts.rebalanceModal.round'), value: t('accounts.rebalanceModal.roundOf', { round: num(round, 0), rounds: num(rounds, 0) }) }]),
            {
              key: 'time',
              label: total > 0 ? t('accounts.rebalanceModal.timeLeft') : t('accounts.rebalanceModal.time'),
              value: total > 0 ? fmtAbout(left) : fmtAge(elapsed),
              sub: total > 0 ? [t('accounts.rebalanceModal.passed', { age: fmtAge(elapsed) })] : [],
            },
          ]}
        />
        <ProgressBar ratio={total > 0 ? elapsed / 1000 / total : 0} tone="running" />
        <BalanceBars caption={<Term label={t('accounts.rebalanceModal.now')} text={HOVER.now} />} rows={rows} scale={scaleOf(rows)} />
        <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.waitsLine')}</p>
        {fold}
      </>
    );
  }
  return (
    <>
      <StopBox title={stopTitle(job)} lines={haltLine(job.haltReason)} />
      <BalanceBars caption={t('accounts.rebalanceModal.whereCaption')} rows={rows} scale={scaleOf(rows)} />
      {transfer?.spot === null && <NoSpotReadLine />}
      <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
      <Actions {...props} note={abandonNote(job, transfer)} />
    </>
  );
}

function RealizeJobView(props: Props) {
  const { job, view, now, pressed, transfer, onTransfer, onClose } = props;
  const [actionsOpen, setActionsOpen] = useState(false);
  const positionsRead = usePositions().data;
  const positions = positionsRead?.positions ?? [];
  const livePerps = positionsRead ? perpsOf(positions) : null;
  const pressedRealize = pressed?.plan.realize ?? null;
  const legs = job.realize?.legs ?? [];
  const split = lastRealizeIndex(job) + 1;
  const routeSteps = job.steps.slice(split);
  const routeState = stateOf(job, routeSteps);
  const gaps = gapsOf(job);
  const running = job.status === 'running';
  const done = job.status === 'done';
  const preClose = (pressed?.plan ?? view.plans[job.goal] ?? null)?.realize?.legs ?? [];
  const realizedOf = (leg: RealizeJobLeg): number =>
    leg.filledQty > 0 ? leg.realizedUsd : (preClose.find((p) => p.symbol === leg.symbol)?.realizedUsd ?? 0);
  const usdOf = (gap: Gap): string | null => {
    const mark = markPriceOf(positions, gap.leg.symbol);
    return mark === null ? null : fmtUsd(gap.qty * mark, 0);
  };
  const otherLeg = (leg: RealizeJobLeg): string => otherLegText(leg, [...(livePerps ?? []), ...(job.before?.perps ?? [])]);
  const gapWords = (gap: Gap) => ({ venue: prettyVenue(gap.leg.exchange), side: sideText(gap.leg.side), size: sizeText(gap.qty), base: gap.leg.base });
  const sameAsPressed = pressed !== null && pressed !== undefined && legs.every((leg) => sameSize(job, leg, plannedOf(pressedRealize, leg)));

  const realizeRows = realizePools(legs).map(({ pool, legs: poolLegs }, index): StepRow => {
    const state = stateOf(job, poolLegs.flatMap((leg) => legSteps(job, leg)));
    const total = poolLegs.reduce((sum, leg) => sum + realizedOf(leg), 0);
    const amount = { amount: num(total, 0), coin: poolCoin(pool) };
    const closed = poolLegs.filter((leg) => leg.filledQty > 0);
    const gap = gaps.find((g) => poolLegs.includes(g.leg));
    const unconfirmed = poolLegs.find((leg) => {
      const close = legStep(job, leg, 'Close');
      return leg.filledQty <= 0 && close !== undefined && close.status !== 'done' && (close.venueId !== null || close.text !== null);
    });
    const actionLegs = jobActionLegs(job, poolLegs, pressedRealize);
    const reason = job.haltReason ? <p key="why" className="text-xs text-ink-400">{localizeServerText(job.haltReason)}</p> : null;
    let text = rk(state === 'done' ? 'realizedTitle' : state === 'running' ? 'realizingTitle' : 'realizeTitle', amount);
    const body: ReactNode[] = [];
    if (state === 'stopped' && gap) {
      text = rk('stoppedTitle', { size: sizeText(gap.qty), base: gap.leg.base });
      const converts = convertsOf(job, gap.leg).filter((step) => step.status === 'done');
      if (converts.length > 0) {
        const landed = converts.reduce((sum, step) => sum + (step.qty ?? 0), 0);
        const sent = converts.reduce((sum, step) => sum + (step.planned ?? step.qty ?? 0), 0);
        const profit = realizedOf(gap.leg);
        body.push(
          <p key="cash" className="num text-xs text-ink-300">
            {rk('receiptCash', {
              profit: num(profit, 0), coin: poolCoin(pool), first: num(landed, 0), firstWallet: walletOf(CONVERT_TO[pool]),
              second: num(Math.max(0, profit - sent), 0), secondWallet: walletOf(pool),
            })}
          </p>,
        );
      }
    } else if (state === 'stopped' && unconfirmed) {
      text = rk('closeUnconfirmedTitle');
      const words = { platform: PLATFORM, side: sideText(unconfirmed.side), size: sizeText(unconfirmed.qty), base: unconfirmed.base };
      body.push(<p key="unconfirmed" className="num text-xs text-ink-300">{rk('closeUnconfirmedBody', words)}</p>, reason);
    } else if (state === 'stopped' && closed.length > 0) {
      text = rk('stoppedAfter', { done: num(closed.reduce((sum, leg) => sum + leg.realizedUsd, 0), 0), total: num(total, 0) });
      body.push(<RealizeRow key="row" legs={actionLegs} />, reason);
    } else if (state === 'stopped') {
      text = rk('stoppedBeforeClose');
      const leg = poolLegs[0]!;
      body.push(
        <p key="same" className="num text-xs text-ink-300">
          {rk('stoppedBeforeCloseBody', { venue: prettyVenue(leg.exchange), side: sideText(leg.side), size: sizeText(leg.positionQty), base: leg.base })}
        </p>,
        reason,
      );
    } else {
      if (gap) {
        const usd = usdOf(gap);
        body.push(
          <p key="gap" className="num text-xs text-gold">
            {usd === null ? rk('gapLineNoUsd', gapWords(gap)) : rk('gapLine', { ...gapWords(gap), usd })}
          </p>,
        );
      }
      body.push(<RealizeRow key="row" legs={actionLegs} />);
    }
    const retry = poolLegs.map((leg) => legStep(job, leg, 'Reopen')).find((step) => step?.retry && step.status !== 'done');
    if (retry?.retry && running) {
      const seconds = retry.nextTryAt ? Math.max(0, Math.ceil((retry.nextTryAt - now) / 1000)) : 0;
      body.push(
        <p key="retry" className="num text-xs text-gold">
          {rk('retryLine', { platform: PLATFORM, amount: num(retry.retry.convertAmount, 0), coin: poolCoin(pool), try: retry.attempt + 1, seconds })}
        </p>,
      );
    }
    if (state !== 'stopped' && !gap) {
      body.push(
        <RealizeActions key="actions" legs={actionLegs} open={actionsOpen} onToggle={() => setActionsOpen(!actionsOpen)} tense={state === 'done' ? 'past' : 'plan'} />,
      );
    }
    return { key: `realize:${pool}:${index}`, label: '', text, sub: walletOf(pool), right: '', state, progress: null, body: <div className="mt-1.5 flex flex-col gap-1.5">{body}</div> };
  });

  const converts = legs.some((leg) => convertsOf(job, leg).length > 0);
  const coin = poolCoin(routeSteps[0]?.from ?? 'HYPERLIQUID');
  const routeRow: StepRow[] = routeSteps.length === 0 ? [] : [{
    key: 'route',
    label: '',
    text: moveTitle(converts, routeState === 'running' ? 'running' : routeState === 'done' ? 'done' : 'plan', routeMoveOf(routeSteps), coin),
    sub: <MovePath {...routePools(routeSteps)} />,
    right: '',
    state: routeState,
    progress: null,
    body: <RouteBody job={job} now={now} state={routeState} />,
  }];

  const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
  const parts = sameAsPressed && pressed
    ? { fee: realizeFeeUsd(pressed.plan) + routeFeeUsd(pressed.route), impact: realizeImpactUsd(pressed.plan) + routeImpactUsd(pressed.route) }
    : null;
  const gap = job.status === 'halted' ? gaps[0] : undefined;
  const gapUsd = gap ? usdOf(gap) : null;
  const routeStopped = routeState === 'stopped';
  const plan = pressed?.plan ?? view.plans[job.goal] ?? view.plans.even;
  const rows = barRowsOf(view.buckets, shownKeys(view, routeSteps, plan), targetsOf(view, plan));

  return (
    <>
      {running && <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.started', { age: fmtAge(Math.max(0, now - job.createdAt)) })}</p>}
      {done && <RebalanceBeforeAfter rows={receiptChanges(job, pressed?.view.buckets ?? view.buckets, livePerps)} mode="now" />}
      {gap && (
        <StopBox
          title={rk('gapBox', { ...gapWords(gap), leg: otherLeg(gap.leg) })}
          lines={[...(gapUsd === null ? [] : [rk('notHedged', { usd: gapUsd })]), ...haltLines(job.haltReason)]}
        />
      )}
      {routeStopped && <StopBox title={stopTitle(job)} lines={haltLine(job.haltReason)} />}
      <div className="flex flex-col gap-3">
        <div className={STEPS_HEAD}>{rk(done ? 'howItRan' : 'howItRuns')}</div>
        <StepList rows={[...realizeRows, ...routeRow]} />
      </div>
      {routeStopped && <BalanceBars caption={t('accounts.rebalanceModal.whereCaption')} rows={rows} scale={scaleOf(rows)} />}
      {job.costUsd !== null && (
        <div className="card flex flex-col gap-1.5 p-3 text-xs">
          <EstimateRow
            label={rk('totalCost')}
            sub={done ? `${t('accounts.rebalanceModal.took')} ${fmtAge(took)}` : null}
            value={fmtUsd(job.costUsd)}
            strong
          />
          {parts && <EstimateRow label={modalFeeLabel()} value={fmtUsd(parts.fee)} />}
          {parts && parts.impact > 0 && <EstimateRow label={modalImpactLabel()} value={fmtUsd(parts.impact)} />}
        </div>
      )}
      {running && <p className="text-xs text-ink-400">{t('accounts.rebalanceModal.waitsLine')}</p>}
      {job.status === 'halted' && (
        <>
          {transfer?.spot === null && <NoSpotReadLine />}
          <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />
          <Actions
            {...props}
            note={gap ? rk('abandonNote', { side: sideText(gap.leg.side), size: sizeText(gap.qty), base: gap.leg.base }) : abandonNote(job, transfer)}
          />
        </>
      )}
      {done && <CloseButton onClose={onClose} />}
    </>
  );
}

function RouteBody({ job, now, state }: { job: RebalanceJob; now: number; state: StepState }) {
  if (state !== 'running') return null;
  const round = roundOf(job);
  const rounds = roundCountOf(job);
  const total = jobSeconds(job);
  const started = job.steps.slice(lastRealizeIndex(job) + 1).find((step) => step.startedAt !== null)?.startedAt ?? now;
  const elapsed = Math.max(0, now - started) / 1000;
  const left = Math.max(0, total - elapsed);
  const line =
    job.route === 'loop' && round !== null
      ? rk('spotLoopRound', { round: num(round, 0), rounds: num(rounds, 0), minutes: num(Math.ceil(left / 60), 0) })
      : ROUTE_LABEL[job.route];
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-xs text-ink-300">
      <span className="num">{line}</span>
      {job.inTransit && <span className="num">{rk('spotLoopWay', { amount: num(job.inTransit.qty, 0), coin: job.inTransit.coin })}</span>}
      <ProgressBar ratio={total > 0 ? elapsed / total : 0} tone="running" />
    </div>
  );
}

export function JobChip({ job }: { job: RebalanceJob }) {
  if (job.status === 'running') return <Chip tone="info">{t('common.running')}</Chip>;
  if (job.status === 'halted') return <Chip tone="red">{t('common.stopped')}</Chip>;
  if (isShortDone(job) || job.goal !== 'even' || hasRest(job)) return <Chip>{t('common.done')}</Chip>;
  return <Chip tone="green">{t('accounts.rebalanceModal.balanced')}</Chip>;
}
