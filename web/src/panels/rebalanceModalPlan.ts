import type { EvenPlan, GoalKind, Goal, RebalanceView, RouteName } from '../api/types';
import { amountError } from '../lib/amount';
import { fmtUsd } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { ROUTE_ORDER, routeScore } from './RebalanceBits';
import { defaultGoal, isCashLimitedEven, movesKey, totalCostUsd } from './RebalanceHovers';
import { refusalOf } from './RebalancePlanBits';
import { PRESET_OFF, shortOfCash, verdictBalanced, verdictNoCashToMove } from './rebalanceCopy';

export type Preset = 'even' | 'repay';
export type PresetPick = Preset | 'none';

export const goalKey = (goal: Goal): string => (goal.kind === 'custom' ? `custom:${goal.from}>${goal.to}@${goal.amount}` : goal.kind);

export function initialGoal(view: RebalanceView): GoalKind {
  const lead = defaultGoal(view);
  const other: Preset = lead === 'even' ? 'repay' : 'even';
  if (!view.plans[lead].balanced) return lead;
  if (!view.plans[other].balanced) return other;
  return 'custom';
}

export const cashLimitedText = (plan: EvenPlan): string =>
  plan.noLegs ? `${fmtUsd(plan.shortOfEven)} ${shortOfCash()}` : verdictNoCashToMove();

export function presetOffText(preset: Preset, plan: EvenPlan): string | undefined {
  if (!plan.balanced) return undefined;
  if (preset === 'even' && plan.noLegs) return PRESET_OFF.even;
  if (isCashLimitedEven(plan)) return cashLimitedText(plan);
  return preset === 'even' ? verdictBalanced() : PRESET_OFF.repay;
}

export const parsedAmount = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === '' || amountError(trimmed) !== null) return null;
  return floorCents(Number(trimmed));
};
export const PLAN_CHANGED_LABEL = 'PLAN_CHANGED';

function stampOf(plan: EvenPlan, name: RouteName | null): string {
  const route = name === null ? null : plan.routes[name];
  return [goalKey(plan.goal), name, movesKey(route?.steps ?? [])].join(':');
}

export interface Accepted {
  stamp: string;
  costUsd: number;
  name: RouteName | null;
  order: RouteName[];
}

export const plainOf = (plan: EvenPlan): EvenPlan => (refusalOf(plan) ? { ...plan, realize: null } : plan);

export function acceptedOf(offered: EvenPlan, name: RouteName | null): Accepted {
  const plan = plainOf(offered);
  return {
    stamp: stampOf(plan, name),
    costUsd: name === null || !plan.routes[name] ? 0 : totalCostUsd(plan, plan.routes[name]),
    name,
    order: routeOrder(plan),
  };
}

export function shownOrder(plan: EvenPlan, accepted: Accepted | null): RouteName[] {
  const fresh = routeOrder(plan);
  if (accepted === null) return fresh;
  const kept = accepted.order.filter((name) => fresh.includes(name));
  return [...kept, ...fresh.filter((name) => !kept.includes(name))];
}

const cents = (usd: number): number => Math.round(usd * 100);

const costRoseTooMuch = (fresh: number, shown: number): boolean => cents(fresh) - cents(shown) > Math.max(100, cents(shown) / 20);

export function isStale(accepted: Accepted | null, plan: EvenPlan, name: RouteName | null): boolean {
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
