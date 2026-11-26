import type { CrossexPosition, PerpSize, RebalanceJob, RebalanceStep } from '../api/types';
import { parseSymbol } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import type { StepState } from './RebalanceBits';

const LANDING_STEPS: readonly string[] = ['To Hyperliquid', 'To Lighter', 'Convert', 'Convert to USDC'];
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

export const lastRealizeIndex = (job: RebalanceJob): number => job.steps.map((step) => step.phase).lastIndexOf('realize');

const routeDone = (job: RebalanceJob): RebalanceStep[] => job.steps.slice(lastRealizeIndex(job) + 1).filter((step) => step.status === 'done');

export const landedOf = (job: RebalanceJob): number => landedIn(routeDone(job));

export function isShortDone(job: RebalanceJob): boolean {
  const routeAmount = job.amount;
  const routeCost = (job.costUsd ?? 0) - (job.realize?.costUsd ?? 0);
  return landedOf(job) < routeAmount - routeCost - Math.max(SHORT_FLOOR_USD, SHORT_SHARE * routeAmount);
}

export function stateOf(job: RebalanceJob, steps: RebalanceStep[]): StepState {
  if (steps.length > 0 && steps.every((step) => step.status === 'done')) return 'done';
  const current = job.steps[job.stepIndex];
  if (!current || !steps.includes(current)) return 'pending';
  return job.status === 'running' ? 'running' : 'stopped';
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
