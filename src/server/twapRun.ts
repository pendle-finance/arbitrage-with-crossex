import { prettyVenue } from '../../web/src/lib/fmt';
import { classifyGateError, CoreError } from '../core/errors';
import { parseSymbol } from '../core/numbers';
import { dealSlippage } from '../../web/src/trade/dealSlippage';
import { resolveFeeRates, type VenueFeeRow } from '../core/estimate/fees';
import { restPlan, sliceBoundsOf, takerAfterCapSec, TWAP_LIMITS, type TwapLegRule, usdText } from '../core/twap';
import type { DealRequest } from '../engine/create';
import type { Store } from '../engine/db';
import { hasMarginRefusalLabel, project } from '../engine/decide';
import { type Fx, FX_DECIMALS, FX_ZERO, fx, fxFloorToStep, fxMax, fxMin, fxStr } from '../engine/fx';
import { commands, isOrderAllowanceRefusal, SLEEP_GAP_MS } from '../engine/loop';
import { type OrderRow, type PairMode, type PairRow, type Side } from '../engine/types';
import {
  childIdFor,
  HALT_TEXT,
  haltReasonFor,
  type HaltKind,
  hedgeBeforeOf,
  isChildOf,
  type Job,
  type JobFile,
  type JobFollow,
  type JobTwap,
  SLICE_STEP,
  type SizeRefusal,
  type Step,
} from './rebalanceJob';
import { haltWalled, isWalledStop } from './walledStop';

export interface TwapRunDeps {
  store: Store;
  engineWake: () => void;
  createChild: (req: DealRequest) => Promise<void>;
  now: () => number;
  jobs: JobFile;
  readFees: (dealIds: string[]) => Promise<Record<string, number>>;
}

export interface ChildDealView {
  pair: PairRow;
  orders: OrderRow[];
  feeUsd: number | null;
  bestPrice?: string | null;
}

export interface TwapView {
  slice: number;
  of: number;
  nextAt: number | null;
  durationSec: number;
  intervalSec: number;
  startedAt: number;
  carryQty: string;
  behindQty: string;
  makerLeg: 'a' | 'b';
  repegBehindBp: number | null;
  takerAfterSec: number | null;
}

export interface TwapChildView {
  id: string;
  mode: PairMode;
  slice: number;
  makerLeg: 'a' | 'b';
  side: Side;
  restPrice: string | null;
  bestPrice: string | null;
  behindPct: number | null;
  repegRefused: { kind: string; at: number } | null;
}

export interface RunLegView {
  name: string;
  exchange: string;
  symbol: string;
  reduceOnly: boolean;
  side: 'LONG' | 'SHORT';
  filledQty: string;
  plannedQty: string;
  avgPrice: string | null;
  beforeQty?: string;
  nowQty?: string;
}

export interface RunOrderView {
  venue: string;
  leg: 'A' | 'B';
  kind: 'maker' | 'taker';
  slice: number | null;
  price: string | null;
  qty: string;
  filledQty: string;
  state: OrderRow['state'];
  createdAt: number;
}

export interface TwapBorosView {
  refused: boolean;
  slice: number;
  leftYu: number;
  beforeYu: number;
  nowYu: number;
}

export interface TwapJobView {
  twap: TwapView | null;
  child: TwapChildView | null;
  legs: RunLegView[];
  fees: { readUsd: number; estUsd: number; totalUsd: number; est: boolean };
  slippage: { pct: number; usd: number } | null;
  orders: RunOrderView[];
  boros: TwapBorosView | null;
}

export const MAKER_FEE_BP = 2;
export const TAKER_FEE_BP = 5;

const SLEEP_TEXT = 'This Mac slept during the TWAP. Nothing was sent while it slept. Press Resume.';
const SLICE_NUMBER = /-[sf](\d+)(?:-\d+)?$/;
const ENDED: readonly PairMode[] = ['DONE', 'HALTED'];

const lastPass = new Map<string, number>();
const sliceMisses = new Map<string, number>();
const SLICE_MISS_HALT = 3;

const childOf = (store: Store, job: Job, slice: number): PairRow | null =>
  slice > 0 ? store.getPair(childIdFor(job.id, slice, 1)) : null;

const childrenOf = (store: Store, job: Job, opts?: { activeOnly?: boolean }): PairRow[] =>
  store.listPairs(opts).filter((pair) => isChildOf(job.id, pair.id));

const makerOf = (twap: JobTwap): { symbol: string; side: Side } => (twap.makerLeg === 'b' && twap.deal.b ? twap.deal.b : twap.deal.a);

const makerSymbolOf = (twap: JobTwap): string => makerOf(twap).symbol;

function netFilledOn(store: Store, pair: PairRow, leg: { symbol: string; side: Side }): Fx {
  return store.listOrders(pair.id).reduce((sum, order) => {
    const contract = order.leg === 'A' ? pair.a.contract : pair.b?.contract;
    if (contract !== leg.symbol) return sum;
    return order.side === leg.side ? sum + fx(order.cumQty) : sum - fx(order.cumQty);
  }, FX_ZERO);
}

const filledAll = (store: Store, job: Job & { twap: JobTwap }): Fx =>
  childrenOf(store, job).reduce((sum, pair) => sum + netFilledOn(store, pair, makerOf(job.twap)), FX_ZERO);

const exchangeOf = (symbol: string): string => parseSymbol(symbol).exchange;

export function twapHedgeOf(store: Store, job: Job): JobFollow | null {
  const child = job.kind === 'twap' && job.twap ? childOf(store, job, job.twap.sliceIndex) : null;
  if (!child?.b || !(job.notHedgedQty > 0)) return null;
  const { contract, side, reduceOnly } = child.b;
  return { symbol: contract, exchange: exchangeOf(contract), side, qty: job.notHedgedQty, reduceOnly: reduceOnly === true };
}

function markOf(store: Store, job: Job): number | null {
  const twap = job.twap;
  if (!twap) return null;
  for (let slice = twap.sliceIndex; slice > 0; slice -= 1) {
    const pair = childOf(store, job, slice);
    if (!pair) continue;
    const price = Number(store.avgFillPrice(pair.id, 'A') ?? pair.limitPrice ?? NaN);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

function isMarginRefusal(err: unknown): boolean {
  if (err instanceof CoreError) return err.category === 'insufficient-margin';
  return classifyGateError(err).category === 'insufficient-margin';
}

function isRetryable(err: unknown): boolean {
  if (err instanceof CoreError) return err.category === 'network' || err.category === 'rate-limited';
  return classifyGateError(err).retryable;
}

function isRefusedForMargin(orders: OrderRow[]): boolean {
  const legA = orders.filter((order) => order.leg === 'A');
  if (legA.some((order) => fx(order.cumQty) > FX_ZERO)) return false;
  return legA.some(hasMarginRefusalLabel);
}

interface Breach {
  line: string;
  venue: string;
  limit: string;
  bound: SizeRefusal['bound'];
}

const underOf = (slice: number, venue: string, limit: string): Breach => ({
  line: `Slice ${slice} is under ${venue}'s ${limit} minimum`,
  venue,
  limit,
  bound: 'min',
});

const MIN_REFUSAL = /is below (\S+?)'s minimum (?:size of ([\d.]+)|order value \(([\d.]+) at)/;

function minRefusalOf(err: unknown, slice: number, coin: string): Breach | null {
  const match = err instanceof Error ? MIN_REFUSAL.exec(err.message) : null;
  if (!match) return null;
  const venue = prettyVenue(exchangeOf(match[1]));
  return underOf(slice, venue, match[2] !== undefined ? `${match[2]} ${coin}` : usdText(Number(match[3])));
}

function limitBreachOf(qty: Fx, rules: TwapLegRule[], mark: number | null, slice: number): Breach | null {
  const amount = Number(fxStr(qty));
  for (const rule of rules) {
    const venue = prettyVenue(rule.venue);
    if (amount < Number(rule.minSize)) return underOf(slice, venue, `${rule.minSize} ${rule.coin}`);
    const minNotional = Number(rule.minNotional);
    if (mark !== null && minNotional > 0 && amount * mark < minNotional) return underOf(slice, venue, usdText(minNotional));
    const caps = [rule.maxMarketSize, rule.maxLimitSize].map(Number).filter((cap) => Number.isFinite(cap) && cap > 0);
    if (caps.length > 0 && amount > Math.min(...caps)) {
      const limit = `${Math.min(...caps).toLocaleString('en-US')} ${rule.coin}`;
      return { line: `Slice ${slice} is over ${venue}'s ${limit} maximum`, venue, limit, bound: 'max' };
    }
  }
  return null;
}

function haltTwap(deps: TwapRunDeps, job: Job, kind: HaltKind | null, reason: string | null, sizeRefusal: SizeRefusal | null = null): void {
  job.status = 'halted';
  job.haltKind = kind;
  job.haltReason = reason;
  job.sizeRefusal = sizeRefusal;
  if (job.kind === 'twap' && job.twap) {
    job.twap.nextAt = null;
    job.twap.replan = true;
    replanOf(deps, job as Job & { twap: JobTwap });
  }
  deps.jobs.write(job);
  lastPass.delete(job.id);
  sliceMisses.delete(job.id);
}

function haltSize(deps: TwapRunDeps, job: Job, breach: Breach, at: { slice: number; qty: Fx; rest: Fx; coin: string }): void {
  const wholeRest = breach.bound === 'min' && at.qty >= at.rest;
  const reason = wholeRest
    ? `Rest ${fxStr(at.qty)} ${at.coin} is under ${breach.venue}'s ${breach.limit} minimum. Resume cannot send it. Stop ends the run.`
    : breach.line;
  haltTwap(deps, job, 'refused', reason, { slice: at.slice, venue: breach.venue, limit: breach.limit, bound: breach.bound, wholeRest });
}

function finishTwap(deps: TwapRunDeps, job: Job): void {
  job.status = 'done';
  job.haltKind = null;
  job.haltReason = null;
  job.sizeRefusal = null;
  if (job.twap) {
    job.twap.nextAt = null;
    job.twap.carryQty = '0';
    job.twap.behindQty = '0';
  }
  deps.jobs.write(job);
  lastPass.delete(job.id);
  sliceMisses.delete(job.id);
}

function pauseTwap(deps: TwapRunDeps, job: Job): void {
  job.paused = true;
  job.pauseRequested = false;
  haltTwap(deps, job, null, null);
}

export function sliceStepBehind(job: Job): Step | null {
  const step = job.steps[job.stepIndex];
  if (!step || step.name === SLICE_STEP) return step ?? null;
  if (!step.retry) return null;
  const next = job.steps.slice(job.stepIndex + 1).find((later) => !later.name.startsWith('Convert'));
  return next?.name === SLICE_STEP ? next : null;
}

export function unwindTargetOf(job: Job, step: Step, child: PairRow, qty: number): JobFollow | null {
  if (job.kind !== 'realize') {
    return { symbol: child.a.contract, exchange: parseSymbol(child.a.contract).exchange, side: child.a.side === 'BUY' ? 'SELL' : 'BUY', qty, reduceOnly: child.a.reduceOnly !== true };
  }
  const leg = job.realize?.legs.find((row) => row.symbol === step.perp?.symbol);
  const hedge = leg ? hedgeBeforeOf(job, leg) : undefined;
  return hedge ? { symbol: hedge.symbol, exchange: hedge.exchange, side: hedge.side === 'LONG' ? 'SELL' : 'BUY', qty, reduceOnly: true } : null;
}

export function openGapOf(store: Store, job: Job): { qty: number; follow: JobFollow; unwind: JobFollow | null } | null {
  const step = sliceStepBehind(job);
  const child = step?.lead ? store.getPair(step.lead.text) : null;
  if (!step?.follow || child?.mode !== 'HALTED' || !child.b) return null;
  if (job.kind !== 'realize' && child.haltKind !== 'hedge-margin') return null;
  const proj = project(child, store.listOrders(child.id));
  const qty = Number(fxStr(fxMax(FX_ZERO, fx(proj.aFilled) - fx(proj.bFilled))));
  if (!(qty > 0)) return null;
  const { symbol, exchange, side, reduceOnly } = step.follow;
  return { qty, follow: { symbol, exchange, side, qty, reduceOnly }, unwind: unwindTargetOf(job, step, child, qty) };
}

export function markOpenGap(store: Store, job: Job): void {
  const gap = openGapOf(store, job);
  job.notHedgedQty = gap?.qty ?? 0;
  job.follow = gap?.follow ?? null;
  job.unwindTarget = gap?.unwind ?? null;
}

export async function stopLiveChild(deps: TwapRunDeps, job: Job, keepHalted = false): Promise<void> {
  const live = childrenOf(deps.store, job, { activeOnly: true }).filter((pair) => !keepHalted || pair.mode !== 'HALTED');
  for (const pair of live) commands.stop(deps.store, pair.id);
  if (live.length > 0) deps.engineWake();
}

function isLiveJob(job: Job | null): job is Job & { twap: JobTwap } {
  return job !== null && job.kind === 'twap' && job.twap !== null && job.twap !== undefined && job.status === 'running';
}

export async function bootHaltTwap(deps: TwapRunDeps, job: Job): Promise<Job> {
  if (!isLiveJob(job)) return job;
  void stopLiveChild(deps, job);
  job.pauseRequested = false;
  haltTwap(deps, job, 'restart', HALT_TEXT.restart);
  return job;
}

export const isSlicedTwap = (job: Job): boolean => (job.kind === 'delever' || job.kind === 'realize') && Boolean(job.deleverTwap);

const isLiveDeleverTwap = (job: Job): boolean => isSlicedTwap(job) && job.status === 'running';

export function sleepHaltTwap(deps: TwapRunDeps, job: Job, gap: { fromMs: number; toMs: number }): Job {
  if (!isLiveJob(job) && !isLiveDeleverTwap(job)) return job;
  const sliced = isSlicedTwap(job);
  void stopLiveChild(deps, job, sliced);
  if (sliced) markOpenGap(deps.store, job);
  job.sleptFrom = gap.fromMs;
  job.sleptTo = gap.toMs;
  job.pauseRequested = false;
  haltTwap(deps, job, 'sleep', SLEEP_TEXT);
  return job;
}

const restOf = (store: Store, job: Job & { twap: JobTwap }): Fx => fxMax(FX_ZERO, fx(job.twap.deal.totalQty) - filledAll(store, job));

function replanOf(deps: TwapRunDeps, job: Job & { twap: JobTwap }): void {
  const { twap } = job;
  const rest = restOf(deps.store, job);
  if (rest <= FX_ZERO) return;
  const left = Math.max(1, twap.slices - twap.sliceIndex);
  const mark = markOf(deps.store, job);
  const plan = mark === null ? null : restPlan(fxStr(rest), left, twap.intervalSec, twap.deal.rules, mark);
  twap.slices = twap.sliceIndex + (plan?.slices ?? left);
  if (plan) twap.sliceQty = plan.sliceQty;
  else if (left === 1) twap.sliceQty = fxStr(rest);
}

function childRequest(job: Job & { twap: JobTwap }, slice: number, qty: Fx): DealRequest {
  const { deal, makerLeg, repegBehindBp, takerAfterSec, intervalSec } = job.twap;
  return {
    a: deal.a,
    b: deal.b,
    execution: deal.execution,
    maxClip: deal.maxClip,
    clipBandPct: deal.clipBandPct,
    leverage: deal.leverage,
    id: childIdFor(job.id, slice, 1),
    qty: fxStr(qty),
    pricePolicy: 'touch',
    timeoutSec: takerAfterSec,
    deadlineCapSec: takerAfterCapSec(intervalSec),
    repegBehindBp,
    makerLeg,
  };
}

async function startSlice(deps: TwapRunDeps, job: Job & { twap: JobTwap }, now: number): Promise<void> {
  const { twap } = job;
  const slice = twap.sliceIndex + 1;
  if (twap.replan) {
    replanOf(deps, job);
    twap.carryQty = '0';
    twap.replan = false;
  }
  const { lot, maxQty } = sliceBoundsOf(twap.deal.rules);
  const rest = fxFloorToStep(restOf(deps.store, job), lot);
  if (slice >= twap.slices && slice < TWAP_LIMITS.maxSlices && maxQty !== null && rest > maxQty) twap.slices = slice + 1;
  const asked = slice >= twap.slices ? rest : fxMin(fxFloorToStep(fx(twap.sliceQty) + fx(twap.carryQty), lot), rest);
  const qty = maxQty === null ? asked : fxMin(asked, maxQty);
  if (qty <= FX_ZERO) return finishTwap(deps, job);
  const breach = limitBreachOf(qty, twap.deal.rules, markOf(deps.store, job), slice);
  const at = { slice, qty, rest, coin: twap.deal.coin };
  if (breach !== null) return haltSize(deps, job, breach, at);
  const before = { behindQty: twap.behindQty, carryQty: twap.carryQty, sliceIndex: twap.sliceIndex, nextAt: twap.nextAt };
  twap.behindQty = twap.carryQty;
  twap.carryQty = '0';
  twap.sliceIndex = slice;
  twap.nextAt = slice >= twap.slices ? null : now + twap.intervalSec * 1000;
  deps.jobs.write(job);
  try {
    await deps.createChild(childRequest(job, slice, qty));
  } catch (err) {
    const fresh = deps.jobs.read();
    const target = fresh?.id === job.id ? fresh : job;
    void stopLiveChild(deps, target);
    if (target.status !== 'running') return;
    const misses = (sliceMisses.get(job.id) ?? 0) + 1;
    if (isRetryable(err) && misses < SLICE_MISS_HALT && target.twap && !childOf(deps.store, target, slice)) {
      sliceMisses.set(job.id, misses);
      Object.assign(target.twap, before);
      deps.jobs.write(target);
      return;
    }
    if (isMarginRefusal(err)) {
      return haltTwap(deps, target, 'refused', `${prettyVenue(exchangeOf(makerSymbolOf(twap)))} refused slice ${slice}: not enough margin`);
    }
    const under = minRefusalOf(err, slice, twap.deal.coin);
    if (under !== null) return haltSize(deps, target, under, at);
    const reason = haltReasonFor(err);
    deps.store.alert('error', childIdFor(job.id, slice, 1), reason, deps.now());
    return haltTwap(deps, target, 'error', reason);
  }
  sliceMisses.delete(job.id);
  const after = deps.jobs.read();
  if (after?.id !== job.id || after.status !== 'running' || after.pauseRequested) await stopLiveChild(deps, job);
  deps.engineWake();
}

function haltOnHalted(deps: TwapRunDeps, job: Job & { twap: JobTwap }, child: PairRow): void {
  const slice = job.twap.sliceIndex;
  if (child.haltKind === 'hedge-margin') {
    const hedge = child.b ? prettyVenue(exchangeOf(child.b.contract)) : prettyVenue(exchangeOf(child.a.contract));
    return haltTwap(deps, job, 'hedge-margin', `${hedge} refused the hedge in slice ${slice}`);
  }
  const reason = `Slice ${slice} stopped on an error. Check the orders, then resume or stop.`;
  deps.store.alert('error', child.id, reason, deps.now());
  haltTwap(deps, job, 'error', reason);
}

function settleEnded(deps: TwapRunDeps, job: Job & { twap: JobTwap }, child: PairRow): 'next' | 'stop' {
  const { twap } = job;
  if (twap.replan) return 'next';
  const orders = deps.store.listOrders(child.id);
  if (isRefusedForMargin(orders)) {
    haltTwap(deps, job, 'refused', `${prettyVenue(exchangeOf(child.a.contract))} refused slice ${twap.sliceIndex}: not enough margin`);
    return 'stop';
  }
  const filled = fx(project(child, orders).aFilled);
  if (twap.sliceIndex >= twap.slices) {
    const left = restOf(deps.store, job);
    if (fxFloorToStep(left, sliceBoundsOf(twap.deal.rules).lot) <= FX_ZERO) {
      finishTwap(deps, job);
      return 'stop';
    }
    twap.carryQty = fxStr(left);
    twap.behindQty = fxStr(left);
    if (job.pauseRequested) return 'next';
    const word = child.a.reduceOnly ? 'closed' : 'opened';
    haltTwap(deps, job, 'capped-rest', `${fxStr(left)} ${twap.deal.coin} not ${word}`);
    return 'stop';
  }
  const carry = fxStr(fxMax(FX_ZERO, fx(twap.sliceQty) + fx(twap.behindQty) - filled));
  if (twap.carryQty !== carry) {
    twap.carryQty = carry;
    deps.jobs.write(job);
  }
  return 'next';
}

async function passTwap(deps: TwapRunDeps, job: Job & { twap: JobTwap }, now: number): Promise<void> {
  const { twap } = job;
  const child = childOf(deps.store, job, twap.sliceIndex);
  const live = child !== null && !ENDED.includes(child.mode);
  if (child !== null && isWalledStop(deps.store, child)) {
    haltWalled(deps.store, child);
    return haltOnHalted(deps, job, deps.store.getPair(child.id) ?? child);
  }
  if (job.pauseRequested) {
    if (child?.mode === 'OPENING' || child?.mode === 'CONVERTING') await stopLiveChild(deps, job);
    if (live) return;
    if (child?.mode === 'DONE' && settleEnded(deps, job, child) === 'stop') return;
    return pauseTwap(deps, job);
  }
  if (child?.mode === 'HALTED') {
    if (!twap.replan) return haltOnHalted(deps, job, child);
    commands.resumeAfterHalt(deps.store, child.id);
    deps.engineWake();
    return;
  }
  if (live) {
    if (twap.nextAt === null || now < twap.nextAt) return;
    const resting = twap.takerAfterSec === null && twap.sliceIndex < twap.slices;
    twap.nextAt = null;
    deps.jobs.write(job);
    if (resting) await stopLiveChild(deps, job);
    return;
  }
  if (child?.mode === 'DONE' && settleEnded(deps, job, child) === 'stop') return;
  if (twap.nextAt !== null && now < twap.nextAt) return;
  await startSlice(deps, job, now);
}

export async function runTwap(deps: TwapRunDeps, job: Job): Promise<void> {
  const current = deps.jobs.read();
  if (current?.id !== job.id || !isLiveJob(current)) {
    lastPass.delete(job.id);
    return;
  }
  const now = deps.now();
  const last = lastPass.get(current.id);
  if (last !== undefined && now - last > SLEEP_GAP_MS) {
    sleepHaltTwap(deps, current, { fromMs: last, toMs: now });
    return;
  }
  lastPass.set(current.id, now);
  if (current.notHedgedQty > 0 || current.unwindTarget || current.follow) {
    current.notHedgedQty = 0;
    current.unwindTarget = null;
    current.follow = null;
    deps.jobs.write(current);
  }
  await passTwap(deps, current, now);
  if (current.status === 'running') lastPass.set(current.id, deps.now());
}

export function borosShareOf(input: { closeSize: number; legFilled: [number, number]; legPlanned: [number, number] }): number {
  const { closeSize, legFilled, legPlanned } = input;
  if (!(closeSize > 0)) return 0;
  const legs = [0, 1].filter((leg) => legPlanned[leg] > 0 && Number.isFinite(legFilled[leg]));
  if (legs.length === 0) return 0;
  const smaller = legs.reduce((a, b) =>
    legPlanned[b] < legPlanned[a] || (legPlanned[b] === legPlanned[a] && legFilled[b] < legFilled[a]) ? b : a,
  );
  const ratio = Math.min(1, Math.max(0, legFilled[smaller] / legPlanned[smaller]));
  return closeSize * ratio;
}

export async function loadTwapChildren(deps: Pick<TwapRunDeps, 'store' | 'readFees'>, job: Job): Promise<ChildDealView[]> {
  const pairs = childrenOf(deps.store, job);
  const fees: Record<string, number> = pairs.length > 0 ? await deps.readFees(pairs.map((pair) => pair.id)).catch(() => ({}) as Record<string, number>) : {};
  return pairs.map((pair) => ({
    pair,
    orders: deps.store.listOrders(pair.id),
    feeUsd: Object.hasOwn(fees, pair.id) && Number.isFinite(fees[pair.id]) ? fees[pair.id] : null,
  }));
}

const sliceOfId = (id: string): number | null => {
  const match = SLICE_NUMBER.exec(id);
  return match ? Number(match[1]) : null;
};

function legOrders(view: ChildDealView, symbol: string): OrderRow[] {
  if (view.pair.a.contract === symbol) return view.orders.filter((order) => order.leg === 'A');
  if (view.pair.b?.contract === symbol) return view.orders.filter((order) => order.leg === 'B');
  return [];
}

function fillsOf(orders: OrderRow[]): { qty: Fx; usd: number } {
  return orders.reduce(
    (sum, order) => ({
      qty: sum.qty + fx(order.cumQty),
      usd: sum.usd + Number(order.cumQty) * Number(order.avgFillPrice),
    }),
    { qty: FX_ZERO, usd: 0 },
  );
}

const avgOf = (fills: { qty: Fx; usd: number }): number | null => {
  const qty = Number(fxStr(fills.qty));
  return qty > 0 && fills.usd > 0 ? fills.usd / qty : null;
};

function perpSideOf(side: Side, reduceOnly: boolean | undefined): 'LONG' | 'SHORT' {
  return (side === 'BUY') !== (reduceOnly === true) ? 'LONG' : 'SHORT';
}

interface LegPlan {
  symbol: string;
  side: Side;
  reduceOnly: boolean;
  plannedQty: string;
  beforeQty?: number;
}

function legsOf(plans: LegPlan[], children: ChildDealView[]): RunLegView[] {
  return plans.map((plan) => {
    const orders = children.flatMap((view) => legOrders(view, plan.symbol));
    const fills = fillsOf(orders.filter((order) => order.side === plan.side));
    const back = fillsOf(orders.filter((order) => order.side !== plan.side));
    const avg = avgOf(fills);
    const exchange = exchangeOf(plan.symbol);
    const filledQty = fxMax(FX_ZERO, fills.qty - back.qty);
    return {
      name: prettyVenue(exchange),
      exchange,
      symbol: plan.symbol,
      reduceOnly: plan.reduceOnly,
      side: perpSideOf(plan.side, plan.reduceOnly),
      filledQty: fxStr(filledQty),
      plannedQty: plan.plannedQty,
      avgPrice: avg === null ? null : String(avg),
      ...(plan.beforeQty === undefined
        ? {}
        : { beforeQty: qtyOf(plan.beforeQty), nowQty: qtyOf(plan.beforeQty - Number(fxStr(filledQty))) }),
    };
  });
}

const twapLegPlans = (twap: JobTwap): LegPlan[] =>
  [twap.deal.a, ...(twap.deal.b ? [twap.deal.b] : [])].map((leg) => ({
    symbol: leg.symbol,
    side: leg.side,
    reduceOnly: leg.reduceOnly === true,
    plannedQty: twap.deal.totalQty,
  }));

const qtyOf = (n: number): string => fxStr(fx(Math.max(0, n).toFixed(FX_DECIMALS)));

function deleverLegPlans(job: Job): LegPlan[] {
  const lead = job.realize?.legs[0];
  const legs = job.delever?.legs ?? [];
  const ordered = lead ? [...legs].sort((x, y) => Number(y.symbol === lead.symbol) - Number(x.symbol === lead.symbol)) : legs;
  return ordered.map((leg) => ({
    symbol: leg.symbol,
    side: leg.side === 'LONG' ? 'SELL' : 'BUY',
    reduceOnly: true,
    beforeQty: leg.before,
    plannedQty: qtyOf(lead && leg.symbol === lead.symbol ? lead.qty : leg.closeAll === true ? leg.before : leg.before - leg.after),
  }));
}

function feeRateOf(feeRows: VenueFeeRow[], contract: string | undefined, kind: OrderRow['kind']): number {
  const rates = contract === undefined ? null : resolveFeeRates(feeRows, contract);
  const rate = rates === null ? NaN : kind === 'maker' ? rates.makerRate : rates.takerRate;
  if (Number.isFinite(rate)) return rate;
  return (kind === 'maker' ? MAKER_FEE_BP : TAKER_FEE_BP) / 10_000;
}

export function feesOf(children: (Pick<ChildDealView, 'orders' | 'feeUsd'> & { pair?: PairRow })[], feeRows: VenueFeeRow[] = []): TwapJobView['fees'] {
  let readUsd = 0;
  let estUsd = 0;
  for (const view of children) {
    if (view.feeUsd !== null) {
      readUsd += view.feeUsd;
      continue;
    }
    for (const order of view.orders) {
      const contract = order.leg === 'A' ? view.pair?.a.contract : view.pair?.b?.contract;
      estUsd += Number(order.cumQty) * Number(order.avgFillPrice) * feeRateOf(feeRows, contract, order.kind);
    }
  }
  return { readUsd, estUsd, totalUsd: readUsd + estUsd, est: estUsd > 0 };
}

function slippageOf(legs: RunLegView[]): TwapJobView['slippage'] {
  const [first, second] = legs;
  if (!first || !second) return null;
  const [long, short] = first.side === 'LONG' ? [first, second] : [second, first];
  const slip = dealSlippage({
    longAvg: Number(long.avgPrice),
    shortAvg: Number(short.avgPrice),
    qty: Math.min(Number(first.filledQty), Number(second.filledQty)),
    close: first.reduceOnly,
  });
  return slip ? { usd: slip.usd, pct: slip.pct } : null;
}

function ordersOf(legA: string | null, children: ChildDealView[]): RunOrderView[] {
  return children
    .flatMap(({ pair, orders }) =>
      orders.map((order): RunOrderView => {
        const contract = order.leg === 'A' ? pair.a.contract : (pair.b?.contract ?? pair.a.contract);
        return {
          venue: prettyVenue(exchangeOf(contract)),
          leg: legA === null ? order.leg : contract === legA ? 'A' : 'B',
          kind: order.kind,
          slice: sliceOfId(pair.id),
          price: order.kind === 'maker' ? order.price : order.cumQty === '0' ? order.price : order.avgFillPrice,
          qty: order.qty,
          filledQty: order.cumQty,
          state: order.state,
          createdAt: order.createdAt,
        };
      }),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

function childViewOf(id: string | null, slice: number, makerLeg: 'a' | 'b', children: ChildDealView[]): TwapChildView | null {
  const view = id === null ? undefined : children.find((row) => row.pair.id === id);
  if (!view || view.pair.mode === 'DONE') return null;
  const { pair } = view;
  const maker = project(pair, view.orders).makerOrder;
  const restPrice = maker?.state === 'OPEN' ? maker.price : pair.limitPrice;
  const bestPrice = view.bestPrice ?? null;
  const best = Number(bestPrice);
  const rest = Number(restPrice);
  const gap = pair.a.side === 'BUY' ? best - rest : rest - best;
  const behindPct = bestPrice !== null && restPrice !== null && best > 0 && rest > 0 ? Math.max(0, gap / best) : null;
  return {
    id: pair.id,
    mode: pair.mode,
    slice,
    makerLeg,
    side: pair.a.side,
    restPrice,
    bestPrice,
    behindPct,
    repegRefused: repegRefusalOf(view.orders),
  };
}

export function repegRefusalOf(orders: OrderRow[]): TwapChildView['repegRefused'] {
  const last = orders
    .filter((order) => order.leg === 'A' && order.kind === 'maker' && order.state !== 'PENDING')
    .reduce<OrderRow | null>((top, order) => (top && top.seq > order.seq ? top : order), null);
  const label = last?.state === 'DEAD' && last.closeReason?.startsWith('rejected:') ? last.closeReason.slice('rejected:'.length) : null;
  if (!last || label === null || !isOrderAllowanceRefusal(label)) return null;
  return { kind: 'order-allowance', at: last.resolvedAt ?? last.createdAt };
}

function borosViewOf(job: Job, slice: number): TwapBorosView | null {
  const rows = job.delever?.boros ?? [];
  if (rows.length === 0) return null;
  const beforeYu = rows.reduce((sum, row) => sum + Math.abs(row.before), 0);
  const closedYu = rows.reduce((sum, row) => sum + row.closed, 0);
  return {
    refused: job.status === 'halted' && job.haltKind === 'boros',
    slice,
    leftYu: job.borosLeftYu,
    beforeYu,
    nowYu: Math.max(0, beforeYu - closedYu),
  };
}

const EMPTY_VIEW: TwapJobView = {
  twap: null,
  child: null,
  legs: [],
  fees: { readUsd: 0, estUsd: 0, totalUsd: 0, est: false },
  slippage: null,
  orders: [],
  boros: null,
};

function deleverViewOf(job: Job, own: ChildDealView[], feeRows: VenueFeeRow[]): TwapJobView {
  const plan = job.deleverTwap;
  if (!plan) return EMPTY_VIEW;
  const current = job.steps[job.stepIndex];
  const step = current?.name === SLICE_STEP ? current : job.steps.find((candidate) => candidate.name === SLICE_STEP);
  const slice = step && step.startedAt !== null ? (job.slice?.index ?? 0) : 0;
  const sliceLive = job.status === 'running' && step?.status !== 'done' && Boolean(step?.cut);
  const plans = deleverLegPlans(job);
  const latest = own.at(-1)?.pair ?? null;
  const legs = legsOf(plans, own);
  return {
    twap: {
      slice,
      of: Math.max(plan.slices, job.slice?.count ?? 0, slice),
      nextAt: sliceLive && step?.cut ? step.cut.at + plan.intervalSec * 1000 : null,
      durationSec: plan.durationSec,
      intervalSec: plan.intervalSec,
      startedAt: step?.startedAt ?? job.createdAt,
      carryQty: '0',
      behindQty: '0',
      makerLeg: 'a',
      repegBehindBp: latest?.repegBehindBp ?? null,
      takerAfterSec: job.exec === 'market' ? 0 : plan.takerAfterSec === undefined ? takerAfterCapSec(plan.intervalSec) : plan.takerAfterSec,
    },
    child: childViewOf(step?.status === 'done' ? null : (step?.lead?.text ?? null), slice, 'a', own),
    legs,
    fees: feesOf(own, feeRows),
    slippage: slippageOf(legs),
    orders: ordersOf(null, own),
    boros: borosViewOf(job, slice),
  };
}

export function twapViewOf(job: Job, children: ChildDealView[], feeRows: VenueFeeRow[] = []): TwapJobView {
  const own = children.filter((view) => isChildOf(job.id, view.pair.id));
  if (isSlicedTwap(job)) return deleverViewOf(job, own, feeRows);
  const twap = job.twap;
  if (job.kind !== 'twap' || !twap) return EMPTY_VIEW;
  const legs = legsOf(twapLegPlans(twap), own);
  return {
    twap: {
      slice: twap.sliceIndex,
      of: Math.max(twap.slices, twap.sliceIndex),
      nextAt: twap.nextAt,
      durationSec: twap.durationSec,
      intervalSec: twap.intervalSec,
      startedAt: twap.startedAt,
      carryQty: twap.carryQty,
      behindQty: twap.behindQty,
      makerLeg: twap.makerLeg,
      repegBehindBp: twap.repegBehindBp,
      takerAfterSec: twap.takerAfterSec,
    },
    child: childViewOf(childIdFor(job.id, twap.sliceIndex, 1), twap.sliceIndex, twap.makerLeg, own),
    legs,
    fees: feesOf(own, feeRows),
    slippage: slippageOf(legs),
    orders: ordersOf(twap.deal.a.symbol, own),
    boros: null,
  };
}
