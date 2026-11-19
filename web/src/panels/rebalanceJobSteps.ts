import type { CrossexPosition, PerpSide, PerpSize, Pool, RealizeJobLeg, RealizeLeg, RealizePlan, RebalanceBucket, RebalanceJob, RebalanceStep, WalletAfter } from '../api/types';
import { parseSymbol, prettyVenue } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import type { StepState } from './RebalanceBits';
import { CONVERT_TO, poolKey, sideText } from './rebalanceCopy';
import { keyOf } from './RebalanceHovers';
import { planActionLeg, type ActionCost, type ActionLeg } from './RebalanceRealizeBits';

const LANDING_STEPS: readonly string[] = ['To Hyperliquid', 'To Lighter', 'Convert', 'Convert to USDC'];
const ROUTE_MOVES: readonly string[] = ['To spot', 'From Hyperliquid', 'From Lighter', 'Convert', 'Convert to USDT'];
const SHORT_FLOOR_USD = 1;
const SHORT_SHARE = 0.005;

export const lots = (qty: number): number => Math.round(qty * 1e9) / 1e9;

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

const landedIn = (steps: RebalanceStep[]): number => qtyOf(steps.filter((step) => LANDING_STEPS.includes(step.name))) + soldOf(steps);

export const routeMoveOf = (steps: RebalanceStep[]): number =>
  steps.filter((step) => ROUTE_MOVES.includes(step.name)).reduce((total, step) => total + (step.planned ?? 0), 0);

const isRealizeConvert = (job: RebalanceJob, step: RebalanceStep): boolean =>
  step.name.startsWith('Convert') && (job.realize?.legs ?? []).some((leg) => leg.pool === step.from && CONVERT_TO[leg.pool] === step.to);

const hasPhases = (job: RebalanceJob): boolean => job.steps.every((step) => step.phase !== undefined);

function markedEnd(job: RebalanceJob, reopen: number): number {
  const later = job.steps.slice(reopen + 1);
  const count = later.findIndex((step) => step.phase !== 'realize' || step.name === 'Close');
  return reopen + (count < 0 ? later.length : count);
}

function realizeEnd(job: RebalanceJob, reopen: number): number {
  if (hasPhases(job)) return markedEnd(job, reopen);
  const later = job.steps.slice(reopen + 1);
  const moreLegs = later.some((step) => step.name === 'Close');
  const routeConverts = job.route !== 'loop';
  let end = reopen;
  for (const step of later) {
    if (!step.name.startsWith('Convert')) break;
    if (!moreLegs && !(isRealizeConvert(job, step) && (!routeConverts || (step.quoteId !== null && step.status !== 'done')))) break;
    end += 1;
  }
  return end;
}

export function lastRealizeIndex(job: RebalanceJob): number {
  if (hasPhases(job)) return job.steps.map((step) => step.phase).lastIndexOf('realize');
  const reopen = job.steps.map((step) => step.name).lastIndexOf('Reopen');
  return reopen < 0 ? reopen : realizeEnd(job, reopen);
}

const routeDone = (job: RebalanceJob): RebalanceStep[] => job.steps.slice(lastRealizeIndex(job) + 1).filter((step) => step.status === 'done');

export const landedOf = (job: RebalanceJob): number => landedIn(routeDone(job));

export function isShortDone(job: RebalanceJob): boolean {
  const routeAmount = job.amount;
  const routeCost = (job.costUsd ?? 0) - (job.realize?.costUsd ?? 0);
  return landedOf(job) < routeAmount - routeCost - Math.max(SHORT_FLOOR_USD, SHORT_SHARE * routeAmount);
}

export const legStep = (job: RebalanceJob, leg: RealizeJobLeg, name: string): RebalanceStep | undefined =>
  job.steps.find((step) => step.name === name && step.perp?.symbol === leg.symbol);

export function legSteps(job: RebalanceJob, leg: RealizeJobLeg): RebalanceStep[] {
  const close = legStep(job, leg, 'Close');
  const reopen = legStep(job, leg, 'Reopen');
  if (!close || !reopen) return [];
  return job.steps.slice(job.steps.indexOf(close), realizeEnd(job, job.steps.indexOf(reopen)) + 1);
}

export function isCloseSent(job: RebalanceJob, leg: RealizeJobLeg): boolean {
  const close = legStep(job, leg, 'Close');
  return leg.filledQty <= 0 && close !== undefined && close.status !== 'done' && (close.venueId !== null || close.text !== null);
}

export const convertsOf = (job: RebalanceJob, leg: RealizeJobLeg): RebalanceStep[] =>
  legSteps(job, leg).filter((step) => step.name.startsWith('Convert'));

const restOf = (job: RebalanceJob, leg: RealizeJobLeg): number => lots(leg.filledQty - (legStep(job, leg, 'Reopen')?.qty ?? 0));

export const hasRest = (job: RebalanceJob): boolean => (job.realize?.legs ?? []).some((leg) => restOf(job, leg) > 0);

export function stateOf(job: RebalanceJob, steps: RebalanceStep[]): StepState {
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

export function jobCostParts(job: RebalanceJob): { fee: number; impact: number } | null {
  const legs = job.realize?.legs ?? [];
  if (job.costUsd === null || legs.some((leg) => leg.closeImpactUsd === undefined || leg.reopenImpactUsd === undefined)) return null;
  const legsImpact = Math.max(0, legs.reduce((total, leg) => total + (leg.closeImpactUsd ?? 0) + (leg.reopenImpactUsd ?? 0), 0));
  const impact = legsImpact + Math.max(0, job.routeImpactUsd ?? 0);
  return { fee: job.costUsd - impact, impact };
}

export function jobActionLegs(job: RebalanceJob, legs: RealizeJobLeg[], plan: RealizePlan | null): ActionLeg[] {
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

export function walletsNow(job: RebalanceJob, before: readonly RebalanceBucket[]): WalletAfter[] {
  const change = new Map<string, { cash: number; equity: number }>();
  const add = (pool: Pool, cash: number, equity: number) => {
    const at = change.get(poolKey(pool)) ?? { cash: 0, equity: 0 };
    change.set(poolKey(pool), { cash: at.cash + cash, equity: at.equity + equity });
  };
  const move = (from: Pool, to: Pool, sent: number, landed: number) => {
    add(from, -sent, -sent);
    add(to, landed, landed);
  };
  for (const leg of job.realize?.legs ?? []) {
    if (leg.filledQty <= 0) continue;
    const { closeQty, reopenQty } = legSizes(job, leg);
    const cost = jobCost(leg, closeQty, reopenQty, 0);
    const spent = cost ? cost.closeFee + cost.closeImpact + cost.reopenFee + cost.reopenImpact : 0;
    add(leg.pool, leg.realizedUsd - (cost?.reopenFee ?? 0), -spent);
    for (const step of convertsOf(job, leg).filter((s) => s.status === 'done')) move(step.from, step.to, step.planned ?? 0, step.qty ?? 0);
  }
  const done = routeDone(job);
  for (const path of new Set(done.map((step) => `${step.from}:${step.to}`))) {
    const steps = done.filter((step) => `${step.from}:${step.to}` === path);
    move(steps[0]!.from, steps[0]!.to, routeMoveOf(steps), landedIn(steps));
  }
  return before.flatMap((bucket) => {
    const delta = change.get(keyOf(bucket));
    return delta ? [{ coin: bucket.coin, venue: bucket.venue, cash: bucket.cash + delta.cash, equity: bucket.equity + delta.equity }] : [];
  });
}

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

export const isOtherLeg = (row: PerpRow, leg: Pick<RealizeJobLeg, 'symbol' | 'side' | 'base'>): boolean =>
  row.symbol !== leg.symbol && row.side !== leg.side && parseSymbol(row.symbol).base === leg.base;

export function otherLegText(leg: RealizeJobLeg, rows: readonly PerpRow[]): string {
  const side: PerpSide = leg.side === 'SHORT' ? 'LONG' : 'SHORT';
  const other = rows.find((row) => isOtherLeg(row, leg));
  return other ? `${prettyVenue(parseSymbol(other.symbol).exchange)} ${sideText(side)}` : sideText(side);
}
