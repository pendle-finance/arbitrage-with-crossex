import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CrossexTrade } from 'gate-api';
import { classifyPlain, CoreError, describeError } from '../../core/errors';
import { fetchBorosOrderBook, resolveBorosFetch, resolveCollateralPricesUsd } from '../../core/boros/client';
import { BOROS_API_BASE } from '../../core/boros/borosApi';
import { halfCapSeedPct } from '../../core/boros/rollProbe';
import { borosTimeToMaturitySec } from '../../core/boros/opportunities';
import type { NormalizedBook } from '../../core/estimate/books';
import { DEFAULT_STEP, parseSymbol } from '../../core/numbers';
import { type DeleverInput, type DeleverPlan, type DeleverRequest, planDelever } from '../../core/rebalance/delever';
import { computeExposure } from '../../core/positions';
import {
  capsUsdOf,
  isInProfit,
  positiveOf,
  type PerpRule,
  type PerpSide,
  twapEstimateOf,
  type RealizeEstimate,
  type RealizeExec,
  type RealizeLeg,
  type RealizePerp,
  type RealizePlan,
} from '../../core/rebalance/realize';
import type { SliceOption } from '../../core/rebalance/slices';
import {
  bookLevels,
  bucketsFrom,
  EVEN_GOAL,
  floorCents,
  fullPlanOf,
  imUsedOf,
  nearestCents,
  notionalByWallet,
  planFor,
  POOLS,
  realizeTabEstimateOf,
  realizeTabOf,
  REPAY_GOAL,
  SPOT_PAIR,
  SPOT_SYMBOL,
  type EvenPlan,
  type Goal,
  type GoalKind,
  type InterestPaidLike,
  type Pool,
  type RouteName,
} from '../../core/rebalance/plan';
import { touchOf } from '../../core/estimate/books';
import { depthOf, legsTwapDefaultOf, makerLegOf, priceImpactOf, TWAP_DEFAULT_INPUT, type TwapLegBook, twapRuleOf, type TwapRuleRow } from '../../core/preview';
import { planSlices, splitFixOf, type SplitLeg, splitPlans, splitSlices, takerAfterCapSec, type TwapInput, type TwapLegRule, type TwapPlan, type TwapPlanResult, type TwapRefusal } from '../../core/twap';
import type { Store } from '../../engine/db';
import { fx, FX_ZERO, type Fx } from '../../engine/fx';
import { type DealRequest, REPEG_CHOICES_BP, REPEG_DEFAULT_BP, takerAfterCapText, TIMEOUT_MAX_S, TIMEOUT_MIN_S, TIMEOUT_RANGE_TEXT } from '../../engine/create';
import { deepBookOf } from '../deepBook';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { accountFeeRowsOf, cachedTradesOf, feeReadWithin, feeRowsWithin } from '../dealFees';
import { DISCLAIMER_NOT_ACCEPTED, isDisclaimerAccepted } from '../disclaimer';
import { catchRateLimit, refuse, sendError } from '../errorReply';
import { isSlicedTwap, loadTwapChildren, markOpenGap, stopLiveChild, twapViewOf, type TwapRunDeps } from '../twapRun';
import { createDeal, type DealBody } from './deals';
import { INTEREST_OVERFLOW, INTEREST_PAGE_SIZE, InterestFile, syncInterest } from '../interestLedger';
import {
  ADD_BACK_FIRST,
  addBackAbandonText,
  addBackGapsOf,
  bannerFor,
  FIX_UNCONFIRMED,
  FOLLOW_MISSES_RED,
  gapsLeftBy,
  inTransitOf,
  isChildOf,
  LOCK_TEXT,
  MAKER_REST_MS,
  moneyLockFor,
  newJob,
  newTwapJob,
  requestPause,
  SLICE_STEP,
  type FixAction,
  type Job,
  type JobFile,
  type JobKind,
  type JobPerp,
  type MakerOpts,
  type MoneyLock,
  type StepName,
  twapLockText,
} from '../rebalanceJob';
import { applyFix, cancelRestingLead, receivedOf, runJob, settleAddBack, STEPS, transferRow, type QueuedFix, type RunnerDeps } from '../rebalanceRunner';
import { configuredRoot, createBorosCloseDeps, createPairPricer } from './borosPair';

const ROUTE_NAMES: readonly string[] = ['mix', 'loop', 'convert'];
const GOAL_KINDS: readonly string[] = ['even', 'repay', 'custom'];
const ALREADY_EVEN = 'Already even.';
const NO_LEGS = 'No open positions. Nothing to rebalance.';
const NO_BORROW = 'No borrow to repay.';
const NOTHING_TO_MOVE = 'Nothing to move.';
const CUSTOM_NEEDS = 'A custom move needs from, to and amount.';
const RELOAD_TEXT = 'This page is out of date. Reload it and check the plan before you rebalance.';
const PLAN_CHANGED_TEXT = 'The plan changed. Check the new route before you rebalance.';
const PLAN_CHANGED_LABEL = 'PLAN_CHANGED';
const TWAP_PLAN_CHANGED_TEXT = 'The TWAP plan changed. Check the new slices before you start.';
const JOB_KINDS: readonly string[] = ['move', 'realize', 'delever', 'twap'];
const EXECS: readonly string[] = ['maker', 'market'];
const FIX_ACTIONS: readonly string[] = ['market', 'limit', 'boros-retry', 'add-back', 'unwind'];
const NOTHING_TO_REALIZE = 'No perp in profit to realize.';
const NOTHING_TO_CLOSE = 'Nothing to close.';
const NOTHING_TO_FIX = 'Nothing is left to fix.';
const FIX_RUNNING = 'A fix is still running. Wait for it to finish.';
const NOT_SLICED = 'Only a sliced run can pause.';
const REALIZE_TARGET_NEEDED = 'Pick Clear debt, All or Custom before you realize.';
const CUSTOM_NEEDS_USD = 'Enter the Custom amount before you realize.';
const WALLET_HAS_NO_UPNL = 'This wallet has no uPnL to realize now. Pick another wallet.';
const DELEVER_NEEDS = 'A Delever needs perps, Boros legs and an order mode.';
const NO_BOROS_WALLET = 'The app has no Boros wallet to close the Boros share with.';
const YEAR_SEC = 365 * 86_400;

export const STALE_TEXT = 'Gate is limiting requests from this account. Try again in a few seconds.';

export const conflict = (reply: FastifyReply, message: string, label?: string): FastifyReply =>
  reply.code(409).send({ ok: false, error: { category: 'validation', label, message, retryable: true } });

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const workingDeal = (deps: AppDeps, skipJob: string | null = null): string | null =>
  deps.engine!.store.listPairs({ activeOnly: true }).find((pair) => skipJob === null || !isChildOf(skipJob, pair.id))?.id ?? null;

const childLiveOf = (deps: AppDeps, job: Job | null): boolean =>
  job !== null && deps.engine!.store.listPairs({ activeOnly: true }).some((pair) => isChildOf(job.id, pair.id));

export type TradeRow = Pick<CrossexTrade, 'orderId' | 'qty' | 'fee' | 'feeCoin'>;
export type TradePage = (query: { page: number; limit: number; from: number }) => Promise<TradeRow[]>;

const FEE_READ_PAGES = 10;
const FEE_READ_SLACK_MS = 60_000;
const USD_FEE_COINS: readonly string[] = ['', 'USDT', 'USDC'];

const fxOrZero = (raw: unknown): Fx => {
  try {
    return fx(String(raw ?? '0'));
  } catch {
    return FX_ZERO;
  }
};

export async function readChildFees(store: Pick<Store, 'listOrders'>, listTrades: TradePage, dealIds: string[]): Promise<Record<string, number>> {
  const deals = dealIds.map((id) => ({
    id,
    orders: store.listOrders(id).filter((order) => fxOrZero(order.cumQty) > FX_ZERO),
  }));
  const orders = deals.flatMap((deal) => deal.orders);
  if (orders.length === 0) return {};
  const from = Math.min(...orders.map((order) => order.createdAt)) - FEE_READ_SLACK_MS;
  const read = new Map<string, { qty: Fx; fee: number; usd: boolean }>();
  for (let page = 1; page <= FEE_READ_PAGES; page += 1) {
    const rows = await listTrades({ page, limit: INTEREST_PAGE_SIZE, from });
    for (const row of rows) {
      const id = String(row.orderId ?? '');
      if (id === '') continue;
      const seen = read.get(id) ?? { qty: FX_ZERO, fee: 0, usd: true };
      const fee = Number(row.fee);
      read.set(id, {
        qty: seen.qty + fxOrZero(row.qty),
        fee: seen.fee + (Number.isFinite(fee) ? Math.abs(fee) : 0),
        usd: seen.usd && Number.isFinite(fee) && USD_FEE_COINS.includes(String(row.feeCoin ?? '').toUpperCase()),
      });
    }
    if (rows.length < INTEREST_PAGE_SIZE) break;
  }
  const fees: Record<string, number> = {};
  for (const deal of deals) {
    const rows = deal.orders.map((order) => ({ order, got: order.venueOrderId === null ? undefined : read.get(order.venueOrderId) }));
    const whole = rows.length > 0 && rows.every(({ order, got }) => got !== undefined && got.usd && got.qty >= fxOrZero(order.cumQty));
    if (whole) fees[deal.id] = rows.reduce((sum, { got }) => sum + (got?.fee ?? 0), 0);
  }
  return fees;
}

export const moneyLockNow = (deps: AppDeps): MoneyLock | null => {
  const rebalance = deps.rebalance?.jobs.read() ?? null;
  return moneyLockFor({
    rebalance,
    transfer: deps.transfer?.jobs.read() ?? null,
    dealId: workingDeal(deps),
    childLive: childLiveOf(deps, rebalance),
  });
};

interface OrderLeg {
  symbol: string;
  side: 'BUY' | 'SELL';
}

const legBookOf = (leg: OrderLeg, book: NormalizedBook | null): TwapLegBook => ({ ...leg, book, mid: touchOf(book)?.mid ?? null });

export async function autoMakerLeg(deps: AppDeps, a: OrderLeg, b: OrderLeg, qty: string): Promise<'a' | 'b'> {
  const feeRows = await accountFeeRowsOf(deps);
  const sizedOf = async (leg: OrderLeg) => ({ ...legBookOf(leg, await deepBookOf(deps, leg.symbol)), qty: Number(qty) });
  const [legA, legB] = await Promise.all([sizedOf(a), sizedOf(b)]);
  return makerLegOf(feeRows, legA, legB).auto;
}

const qtyText = (qty: number): string => qty.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 });

function planOr400(totalQty: string, input: TwapInput, rules: TwapLegRule[], price: number, bookMaxQty: string | null): TwapPlanResult {
  try {
    return planSlices(totalQty, input, rules, price, bookMaxQty);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('twap:')) throw new CoreError(err.message, 'validation');
    throw err;
  }
}

function twapInputOf(value: unknown): TwapInput | null {
  if (value === undefined || value === null) return null;
  const raw = value as Partial<Record<keyof TwapInput, unknown>>;
  const num = (field: unknown): number | undefined => (typeof field === 'number' ? field : undefined);
  const input: TwapInput = {
    ...(raw.durationSec === undefined ? {} : { durationSec: num(raw.durationSec) }),
    ...(raw.intervalSec === undefined ? {} : { intervalSec: num(raw.intervalSec) }),
    ...(raw.slices === undefined ? {} : { slices: num(raw.slices) }),
    ...(typeof raw.sliceQty === 'string' ? { sliceQty: raw.sliceQty } : {}),
  };
  if (Object.values(input).some((field) => field === undefined)) throw new CoreError('twap needs numbers for durationSec, intervalSec and slices');
  return input;
}

function realizeTwapQueryOf(durationSec: unknown, slices: unknown): TwapInput | null {
  if (durationSec === undefined && slices === undefined) return null;
  const duration = Number(durationSec);
  const count = Number(slices);
  if (!Number.isInteger(duration) || !Number.isInteger(count) || duration <= 0 || count <= 0) {
    throw new CoreError('twapDurationSec and twapSlices must be whole numbers');
  }
  return { durationSec: duration, slices: count };
}

interface RealizeTwap {
  plan: TwapPlan | null;
  refusal: TwapRefusal | null;
  price: number;
  legs: { symbol: string; slices: number; plan: TwapPlan | null }[];
  estimates: Record<RealizeExec, RealizeEstimate> | null;
}

const isDecimalQty = (value: string): boolean => /^\d+(\.\d{1,12})?$/.test(value) && fx(value) > FX_ZERO;

interface ShownPlan {
  intervalSec: number;
  sliceQty: string;
}

function shownPlanOf(body: { intervalSec?: unknown; sliceQty?: unknown }): ShownPlan | null {
  if (body.intervalSec === undefined && body.sliceQty === undefined) return null;
  const { intervalSec, sliceQty } = body;
  if (!isPositive(intervalSec) || !Number.isInteger(intervalSec) || typeof sliceQty !== 'string' || !isDecimalQty(sliceQty)) {
    throw new CoreError(TWAP_NEEDS);
  }
  return { intervalSec, sliceQty };
}

const isShownPlan = (plan: TwapPlan | null, shown: ShownPlan, slices: number): boolean =>
  plan !== null && plan.slices === slices && plan.intervalSec === shown.intervalSec && fx(plan.sliceQty) === fx(shown.sliceQty);

const REPEG_OR_OFF: readonly unknown[] = [...REPEG_CHOICES_BP, null];
const TWAP_NEEDS = 'A TWAP needs a client id, a deal, a duration and a slice count.';

const orEmpty = <T>(read: Promise<{ value: T[]; stale: boolean }>): Promise<{ value: T[]; stale: boolean }> =>
  read.catch(() => ({ value: [], stale: true }));

const isRouteName = (value: unknown): value is RouteName => typeof value === 'string' && ROUTE_NAMES.includes(value);

const isGoalKind = (value: unknown): value is GoalKind => typeof value === 'string' && GOAL_KINDS.includes(value);

const isPool = (value: unknown): value is Pool => typeof value === 'string' && (POOLS as readonly string[]).includes(value);

const isShownCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const isExec = (value: unknown): value is RealizeExec => typeof value === 'string' && EXECS.includes(value);

const isJobKind = (value: unknown): value is JobKind => typeof value === 'string' && JOB_KINDS.includes(value);

const isFixAction = (value: unknown): value is FixAction => typeof value === 'string' && FIX_ACTIONS.includes(value);

function positiveQueryOf(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!isPositive(value)) throw new CoreError(`${name} must be a positive number`);
  return value;
}

function poolQueryOf(raw: unknown): Pool | undefined {
  if (raw === undefined) return undefined;
  if (!isPool(raw)) throw new CoreError(`realizePool must be one of ${POOLS.join(', ')}`);
  return raw;
}

function deleverRequestOf(value: unknown): DeleverRequest | null {
  const raw = (value ?? {}) as Partial<Record<keyof DeleverRequest, unknown>>;
  if (!Array.isArray(raw.perps) || !Array.isArray(raw.boros) || !isExec(raw.exec)) return null;
  if (raw.sliceUsd !== undefined && !isPositive(raw.sliceUsd)) return null;
  const perps = raw.perps.map((leg: unknown) => {
    const { symbol, qty } = (leg ?? {}) as { symbol?: unknown; qty?: unknown };
    return typeof symbol === 'string' && isPositive(qty) ? { symbol, qty } : null;
  });
  const boros = raw.boros.map((leg: unknown) => {
    const { marketId, size } = (leg ?? {}) as { marketId?: unknown; size?: unknown };
    return typeof marketId === 'number' && Number.isInteger(marketId) && isPositive(size) ? { marketId, size } : null;
  });
  if (perps.some((leg) => leg === null) || boros.some((leg) => leg === null)) return null;
  return {
    perps: perps.filter((leg) => leg !== null),
    boros: boros.filter((leg) => leg !== null),
    exec: raw.exec,
    ...(raw.sliceUsd === undefined ? {} : { sliceUsd: raw.sliceUsd }),
  };
}

const REALIZE_TARGETS = { 'clear-debt': 'clearDebt', all: 'all', custom: 'custom' } as const;
type RealizeTarget = keyof typeof REALIZE_TARGETS;
const isRealizeTarget = (value: unknown): value is RealizeTarget => typeof value === 'string' && Object.hasOwn(REALIZE_TARGETS, value);

const sliceCountOf = (options: SliceOption[], sliceUsd: number, notionalUsd: number): number =>
  options.find((option) => option.sizeUsd === sliceUsd)?.count ?? Math.max(1, Math.ceil(notionalUsd / sliceUsd));

const belowMinText = (refused: NonNullable<DeleverPlan['refused']>): string =>
  refused.reason === 'same-side'
    ? 'Both perps are on the same side, so a Delever would add to the position.'
    : `${refused.venue} takes at least ${refused.minQty} ${refused.coin}.`;

const cappedSliceOf = (options: SliceOption[], asked: number): number =>
  options.some((option) => !option.custom && option.sizeUsd === asked)
    ? asked
    : Math.min(asked, options.find((option) => option.custom)?.sizeUsd ?? asked);

const twapQtysOf = (plan: { slices: number; sliceQty: string; lastQty: string }): number[] =>
  plan.slices > 0 ? [...Array.from({ length: plan.slices - 1 }, () => Number(plan.sliceQty)), Number(plan.lastQty)] : [];

interface LivePerp extends JobPerp {
  base: string;
  markPrice: number;
  initialMargin: number;
  maxLeverage?: string;
}

const livePerpsOf = (perps: RealizePerp[]): LivePerp[] =>
  perps.flatMap((perp) => {
    const qty = Number(perp.positionQty);
    if (!perp.symbol || !Number.isFinite(qty) || qty === 0) return [];
    const { exchange, base } = parseSymbol(perp.symbol);
    const side: PerpSide = qty < 0 ? 'SHORT' : 'LONG';
    return [{ symbol: perp.symbol, exchange, base, side, qty: Math.abs(qty), markPrice: positiveOf(perp.markPrice), initialMargin: positiveOf(perp.initialMargin), maxLeverage: perp.maxLeverage }];
  });

const jobPerpsOf = (perps: RealizePerp[]): JobPerp[] =>
  livePerpsOf(perps).map(({ symbol, exchange, side, qty }) => ({ symbol, exchange, side, qty }));

/** The custom goal from a query or body: null when none of its three parts
 * is given, the goal when all three are, and an error in between. */
function customGoalOf(input: { from?: unknown; to?: unknown; amount?: unknown }): Goal | null {
  const { from, to, amount } = input;
  if (from === undefined && to === undefined && amount === undefined) return null;
  const usd = typeof amount === 'string' ? Number(amount) : amount;
  if (!isPool(from) || !isPool(to) || typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    throw new CoreError(CUSTOM_NEEDS);
  }
  if (from === to) throw new CoreError(`from and to are both ${from}`);
  return { kind: 'custom', from, to, amount: floorCents(usd) };
}

/** Why a plan has nothing to run, in the goal's own words. */
function nothingText(plan: EvenPlan): string {
  if (plan.goal.kind === 'repay') return NO_BORROW;
  if (plan.goal.kind === 'custom') return NOTHING_TO_MOVE;
  return plan.noLegs ? NO_LEGS : ALREADY_EVEN;
}

const cents = (usd: number): number => Math.round(usd * 100);

const costRoseTooMuch = (fresh: number, shown: number): boolean =>
  cents(fresh) - cents(shown) > Math.max(100, cents(shown) / 20);

interface ShownLeg {
  symbol: string;
  qty: number;
}

function shownLegsOf(value: unknown): ShownLeg[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const isShownLeg = (leg: unknown): leg is ShownLeg => {
    const { symbol, qty } = (leg ?? {}) as Partial<ShownLeg>;
    return typeof symbol === 'string' && typeof qty === 'number' && Number.isFinite(qty);
  };
  return value.every(isShownLeg) ? value : null;
}

const SHOWN_SIZE_GAP = 0.01;

export function isShownRealize(fresh: RealizeLeg[], shown: ShownLeg[], rules: Record<string, PerpRule>): boolean {
  if (fresh.length !== shown.length) return false;
  return fresh.every((leg) => {
    const seen = shown.find((candidate) => candidate.symbol === leg.symbol);
    const lot = Number(rules[leg.symbol]?.lotSize) || Number(DEFAULT_STEP);
    const allowedLots = Math.max(1, Math.floor((leg.qty * SHOWN_SIZE_GAP) / lot + 1e-9));
    return seen !== undefined && Math.abs(Math.round(seen.qty / lot) - Math.round(leg.qty / lot)) <= allowedLots;
  });
}

export function rebalanceRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, req, reply) => sendError(err, req, reply, classifyPlain));
    const jobs = deps.rebalance?.jobs ?? null;
    const now = (): number => deps.engine!.clock.now();
    const alert = (pairId: string | null, message: string): void => {
      console.error(message);
      const engine = deps.engine;
      if (engine) engine.store.alert('error', pairId, message, engine.clock.now(), { once: true });
    };
    const onHalt = (job: Job): void => alert(`rebalance:${job.id}`, bannerFor(job));
    let inflight: Promise<void> | null = null;

    const ackAlerts = (job: Job): void => {
      const store = deps.engine?.store;
      if (!store) return;
      for (const row of store.listAlerts({ unackedOnly: true })) {
        const pairId = 'pair_id' in row ? row.pair_id : row.pairId;
        if (pairId === `rebalance:${job.id}`) store.ackAlert(row.id);
      }
    };

    const requireJobs = (): JobFile => {
      if (!jobs) throw new CoreError('rebalance store not configured', 'not-configured');
      return jobs;
    };

    const pricer = createPairPricer(deps);
    const borosFetch = resolveBorosFetch(deps.borosFetch);
    const borosCloseDeps = createBorosCloseDeps(deps, pricer);
    const envTakerFee = Number(process.env.BOROS_TAKER_FEE_OVERRIDE);
    const takerFeeOverride = Number.isFinite(envTakerFee) ? envTakerFee : undefined;
    let fixing: Promise<Job> | null = null;
    let queuedFix: QueuedFix | null = null;
    const takeFix = (): QueuedFix | null => {
      const queued = queuedFix;
      queuedFix = null;
      return queued;
    };

    const borosSlippagePct = async (marketId: number): Promise<number | null> => {
      const market = (await pricer.loadMarkets(false)).find((m) => m.marketId === marketId);
      return halfCapSeedPct([market?.maxRateDeviationApr ?? 0]);
    };

    const borosCollateralUsd = async (marketId: number): Promise<number | null> => {
      const markets = await pricer.loadMarkets(false);
      const market = markets.find((m) => m.marketId === marketId);
      const price = market ? resolveCollateralPricesUsd(markets).get(market.tokenId) : undefined;
      return isPositive(price) ? price : null;
    };

    const runnerDeps = (store: JobFile, pollOnly = false): RunnerDeps => {
      const address = configuredRoot();
      return {
        clients: () => deps.getClients(),
        jobs: store,
        cache: deps.cache,
        now,
        sleep: deps.rebalance?.sleep ?? sleep,
        onHalt,
        onDone: deps.rebalance?.onDone,
        pollOnly,
        takeFix,
        ...(address ? { boros: { deps: borosCloseDeps, address, slippagePct: borosSlippagePct, collateralUsd: borosCollateralUsd } } : {}),
        ...(deps.engine ? { twap: twapDeps(store) } : {}),
      };
    };

    const start = (store: JobFile, pollOnly = false): void => {
      if (inflight) return;
      inflight = runJob(runnerDeps(store, pollOnly))
        .then(() => {
          const job = store.read();
          if (job?.status === 'done') ackAlerts(job);
        })
        .catch((err: unknown) => console.error(`rebalance stopped: ${describeError(err)}`))
        .finally(() => {
          inflight = null;
          const left = takeFix();
          if (left) fixStopped(store, left);
        });
    };

    const fixStopped = (store: JobFile, queued: QueuedFix): void => {
      const job = store.read();
      if (job?.status !== 'halted') return queued.fail(new CoreError(NOTHING_TO_FIX, 'validation'));
      applyFix(runnerDeps(store), job, queued.action).then((fixed) => {
        queued.done(fixed);
        if (fixed.status === 'running') start(store);
      }, queued.fail);
    };

    const twapPlanFor = async (legs: OrderLeg[], totalQty: string, input: TwapInput, fresh: boolean, markUsd: number | null) => {
      const [rules, books] = await Promise.all([readRules(fresh), perpBooks(legs.map((leg) => leg.symbol))]);
      const twapRules = legs.map((leg) => {
        const row = rules.value.find((rule) => rule.symbol === leg.symbol);
        if (!row) throw new CoreError(`No venue rule for ${leg.symbol}, so the TWAP is not planned.`);
        return twapRuleOf(row as TwapRuleRow, leg.symbol);
      });
      const lead = legs[0];
      const refPrice = touchOf(books[lead.symbol])?.mid ?? markUsd ?? Number(await deps.engine!.venue.refPrice(lead.symbol).catch(() => null));
      if (!(refPrice > 0)) throw new CoreError(`No price for ${lead.symbol}, so the TWAP is not planned. Try again.`);
      const legBooks = legs.map((leg) => legBookOf(leg, books[leg.symbol]));
      const depths = legBooks.map(depthOf).filter((depth): depth is number => depth !== null);
      const bookQty = depths.length ? qtyText(Math.min(...depths)) : null;
      const result = planOr400(totalQty, input, twapRules, refPrice, bookQty);
      const priceImpact = result.plan ? priceImpactOf(legBooks, Number(totalQty), result.plan) : null;
      return { result, price: refPrice, rules: twapRules, bookQty, priceImpact, twapDefault: legsTwapDefaultOf(legBooks, Number(totalQty)) };
    };

    const makerSymbolOf = (req: DealRequest): OrderLeg => (req.makerLeg === 'b' && req.b ? req.b : req.a);

    const createChild = async (req: DealRequest): Promise<void> => {
      let price = req.price;
      if (price === undefined) {
        const maker = makerSymbolOf(req);
        const rules = await readRules();
        const tick = (rules.value.find((rule) => rule.symbol === maker.symbol) as { tickSize?: string } | undefined)?.tickSize;
        if (!tick) throw new CoreError(`No venue rule for ${maker.symbol}, so the slice was not sent.`);
        price = (await deps.engine!.venue.best(maker.symbol, maker.side, tick)) ?? undefined;
        if (price === undefined) throw new CoreError(`No best price for ${maker.symbol}, so the slice was not sent.`);
      }
      const outcome = await createDeal(deps, { ...req, price });
      if ('refusal' in outcome) throw new CoreError(outcome.refusal.message, outcome.refusal.category);
    };

    const cachedTrades = cachedTradesOf(deps);

    const twapDeps = (store: JobFile): TwapRunDeps => ({
      store: deps.engine!.store,
      engineWake: () => deps.engine!.wake?.(),
      createChild,
      now,
      jobs: store,
      readFees: (dealIds) => readChildFees(deps.engine!.store, cachedTrades, dealIds),
    });

    const twapViewFor = async (store: JobFile, job: Job) => {
      const children = await loadTwapChildren(
        {
          store: deps.engine!.store,
          readFees: (dealIds) =>
            feeReadWithin(deps, { kind: 'read', work: () => readChildFees(deps.engine!.store, cachedTrades, dealIds), fallback: {} as Record<string, number> }),
        },
        job,
      );
      const withBest = await Promise.all(
        children.map(async (child) =>
          child.pair.mode === 'OPENING'
            ? { ...child, bestPrice: await deps.engine!.venue.best(child.pair.a.contract, child.pair.a.side, child.pair.a.tick).catch(() => null) }
            : child,
        ),
      );
      return twapViewOf(job, withBest, await feeRowsWithin(deps));
    };

    const bootJob = jobs?.read() ?? null;
    const bootStep = bootJob?.status === 'running' ? bootJob.steps[bootJob.stepIndex] : undefined;
    const resumesAtBoot =
      bootJob !== null &&
      bootStep !== undefined &&
      (bootStep.venueId !== null || bootStep.text !== null);
    if (jobs && deps.engine && bootJob && isSlicedTwap(bootJob) && bootJob.status === 'running') {
      void stopLiveChild(twapDeps(jobs), bootJob, true);
      if (jobs.haltIfRunning()) {
        const halted = jobs.read() ?? bootJob;
        markOpenGap(deps.engine.store, halted);
        jobs.write(halted);
        onHalt(halted);
      }
    } else if (jobs && bootJob && bootStep?.name === SLICE_STEP) {
      inflight = cancelRestingLead(runnerDeps(jobs), bootJob)
        .then(() => {
          if (!bootJob.paused) onHalt(bootJob);
        })
        .catch((err: unknown) => console.error(`rebalance boot: ${describeError(err)}`))
        .finally(() => {
          inflight = null;
          const left = takeFix();
          if (left) fixStopped(jobs, left);
        });
    } else if (jobs && bootStep && resumesAtBoot) {
      bootStep.startedAt = now();
      jobs.write(bootJob);
      start(jobs, true);
    } else if (bootJob && bootJob.kind !== 'twap' && jobs?.haltIfRunning()) {
      onHalt(bootJob);
    }

    // All-time interest, kept on disk and topped up with the rows since the
    // last sync. The account is read first because the ledger is per account.
    const interest = deps.rebalance?.interest ?? new InterestFile(null);
    const interestPaid = (userId: string | null): Promise<{ value: InterestPaidLike; stale: boolean }> =>
      deps.cache
        .get('interest:paid', TTL.fills, () =>
          syncInterest(
            interest,
            userId,
            async (q) => (await deps.getClients().crossEx.listCrossexHistoryMarginInterests(q)).body ?? [],
            now(),
          ),
        )
        .catch((e: unknown) => {
          if (e instanceof CoreError && e.details === INTEREST_OVERFLOW) alert(null, e.message);
          return { value: {}, stale: true };
        });

    const perpBooks = async (symbols: string[]): Promise<Record<string, NormalizedBook | null>> =>
      Object.fromEntries(await Promise.all(symbols.map(async (symbol) => [symbol, await deepBookOf(deps, symbol)] as const)));

    const crossEx = () => deps.getClients().crossEx;
    const readAccount = (fresh: boolean) =>
      deps.cache.get('account', TTL.live, async () => (await crossEx().getCrossexAccount()).body, { fresh });
    const readPositions = (fresh: boolean) =>
      deps.cache.get('positions', TTL.live, async () => (await crossEx().listCrossexPositions()).body, { fresh });
    const readRates = () => orEmpty(deps.cache.get('interest:rate', TTL.static, async () => (await crossEx().getCrossexInterestRate()).body));
    const readRules = (fresh = false) =>
      deps.cache.get('rules:all', TTL.static, async () => (await crossEx().listCrossexRuleSymbols()).body, { fresh });
    const readFees = () => deps.cache.get('fees', TTL.static, async () => (await crossEx().getCrossexFee()).body);
    const perpRulesOf = (rows: Awaited<ReturnType<typeof readRules>>['value']): Record<string, PerpRule> =>
      Object.fromEntries(
        rows.flatMap((rule) =>
          rule.symbol ? [[rule.symbol, { lotSize: rule.lotSize, minSize: rule.minSize, minNotional: rule.minNotional, maxMarketSize: rule.maxMarketSize }]] : [],
        ),
      );

    const loadView = async (fresh: boolean, custom: Goal | null, realizeUsd: number | null = null, sliceUsd?: number, realizePool?: Pool, twapSlices?: number) => {
      const account = await readAccount(fresh);
      const userId = account.value.userId ? String(account.value.userId) : null;
      const [positions, rates, paid, coins, rules, fees, tickers, depth] = await Promise.all([
        readPositions(fresh),
        readRates(),
        interestPaid(userId),
        deps.cache.get('transfer:coins', TTL.static, async () => (await crossEx().listCrossexTransferCoins()).body),
        readRules(),
        readFees(),
        deps.cache.get(
          'spot:usdc',
          TTL.live,
          async () => (await deps.getClients().spot.listTickers({ currencyPair: SPOT_PAIR })).body,
        ),
        deps.cache
          .get('spot:book', TTL.live, async () => (await deps.getClients().spot.listOrderBook(SPOT_PAIR, { limit: 100 })).body)
          .then(
            ({ value, stale }) => bookLevels(stale ? null : value),
            () => bookLevels(null),
          ),
      ]);
      const buckets = bucketsFrom(account.value, rates.value, paid.value);
      const perps: RealizePerp[] = positions.value ?? [];
      const books = await perpBooks(perps.filter(isInProfit).flatMap((perp) => (perp.symbol ? [perp.symbol] : [])));
      const perpRules = perpRulesOf(rules.value);
      const gateFees = fees.value.find((f) => f.exchangeType === 'GATE');
      const special = gateFees?.specialFeeList?.find((s) => s.symbol === SPOT_SYMBOL);
      const ask = Number(tickers.value[0]?.lowestAsk);
      const bid = Number(tickers.value[0]?.highestBid);
      const inputs = {
        coins: coins.value,
        spotRule: rules.value.find((r) => r.symbol === SPOT_SYMBOL) ?? null,
        spotTakerRate: Number(special?.takerFeeRate ?? gateFees?.spotTakerFee ?? 0),
        ask: Number.isFinite(ask) ? ask : null,
        bid: Number.isFinite(bid) ? bid : null,
        asks: depth.asks,
        bids: depth.bids,
        notional: notionalByWallet(computeExposure(positions.value ?? []).flatMap((group) => group.legs)),
        perps,
        books,
        feeRows: fees.value,
        perpRules,
        availableMargin: Number(account.value.availableMargin),
      };
      // Every goal is planned off the same read, so the presets a trader
      // compares are priced against one account picture.
      const plans = {
        even: planFor(buckets, account.value, inputs, EVEN_GOAL),
        repay: planFor(buckets, account.value, inputs, REPAY_GOAL),
        custom: custom ? planFor(buckets, account.value, inputs, custom) : null,
      };
      const realize = realizeTabOf(buckets, account.value, twapSlices === undefined ? inputs : { ...inputs, twapSlices }, realizeUsd, sliceUsd, realizePool);
      const fullPlan = fullPlanOf(buckets, account.value, inputs);
      const imUsed = imUsedOf(account.value);
      const stale = [account, positions, rates, paid, coins, rules, fees, tickers].some((r) => r.stale);
      return { buckets, plans, realize, fullPlan, imUsed, stale, userId, perpRules, perps, books };
    };

    const borosLegsOf = async (request: DeleverRequest, fresh: boolean): Promise<DeleverInput['boros']> => {
      if (request.boros.length === 0) return [];
      const address = configuredRoot();
      if (!address) throw new CoreError(NO_BOROS_WALLET);
      const [markets, account] = await Promise.all([pricer.loadMarkets(fresh), pricer.loadAccount(address, fresh)]);
      const prices = resolveCollateralPricesUsd(markets);
      const nowSec = Math.floor(now() / 1000);
      const legs = request.boros.flatMap(({ marketId }) => {
        const size = account.positionByMarket.get(marketId) ?? 0;
        const market = markets.find((m) => m.marketId === marketId);
        return size !== 0 && market ? [{ marketId, size, market }] : [];
      });
      return Promise.all(
        legs.map(async ({ marketId, size, market }) => {
          const collateralPriceUsd = prices.get(market.tokenId);
          if (!isPositive(collateralPriceUsd)) throw new CoreError(`No collateral price for Boros market ${marketId}.`);
          return {
            marketId,
            size,
            book: await fetchBorosOrderBook(borosFetch, marketId).catch(() => null),
            collateralPriceUsd,
            feeRate: takerFeeOverride ?? market.takerFeeRate,
            yearsToMaturity: borosTimeToMaturitySec(market, nowSec) / YEAR_SEC,
          };
        }),
      );
    };

    const borosOrderGasUsd = (): Promise<number | null> =>
      deps.cache
        .get('boros:gas-price', TTL.boros, async () => {
          const resp = await borosFetch(`${BOROS_API_BASE}/v1/gas-price/current`, { signal: AbortSignal.timeout(15_000) });
          if (!resp.ok) throw new CoreError(`Boros gas price read returned HTTP ${resp.status}`, 'network');
          return ((await resp.json()) as { estimatedOrderGasCostUsd?: unknown }).estimatedOrderGasCostUsd;
        })
        .then(
          ({ value }) => (isPositive(value) ? value : null),
          () => null,
        );

    const loadDelever = async (request: DeleverRequest, fresh: boolean) => {
      const [account, positions, rules, fees, books, boros] = await Promise.all([
        readAccount(fresh),
        readPositions(fresh),
        readRules(),
        readFees(),
        perpBooks(request.perps.map((leg) => leg.symbol)),
        borosLegsOf(request, fresh),
      ]);
      const input: DeleverInput = {
        request,
        positions: livePerpsOf(positions.value ?? []),
        boros,
        books,
        feeRows: fees.value,
        rules: perpRulesOf(rules.value),
        account: account.value,
      };
      return { input, plan: planDelever(input), userId: account.value.userId ? String(account.value.userId) : null, account: account.value, perps: positions.value ?? [] };
    };

    const loadInTransit = async (job: Job): Promise<ReturnType<typeof inTransitOf>> => {
      const inTransit = inTransitOf(job);
      const step = job.steps[job.stepIndex];
      const spec = step ? STEPS[step.name as StepName] : undefined;
      const venueId = step?.venueId;
      if (job.status !== 'halted' || inTransit?.at !== 'MOVING' || spec?.kind !== 'transfer' || !venueId) return inTransit;
      const row = await deps.cache
        .get(`rebalance:transfer:${venueId}`, TTL.live, () =>
          transferRow(deps.getClients().crossEx, spec.coin, (r) => String(r.id) === venueId),
        )
        .then(
          ({ value }) => value,
          () => null,
        );
      if (!row || String(row.status) !== 'SUCCESS') return inTransit;
      return spec.dest === 'SPOT' ? { coin: inTransit.coin, qty: receivedOf(row, spec), at: 'SPOT' } : null;
    };

    const lockText = (lock: MoneyLock | null): string | null => {
      if (lock === null) return null;
      if (lock.kind === 'moving') return LOCK_TEXT.rebalanceWaits;
      if (lock.kind === 'deal') return 'A deal is still running. Wait for it to finish.';
      return `rebalance ${lock.id} is ${lock.kind === 'halted' ? 'halted' : 'running'}`;
    };

    const findLock = (): string | null => {
      const job = deps.rebalance?.jobs.read() ?? null;
      return twapLockText(job, childLiveOf(deps, job)) ?? lockText(moneyLockNow(deps));
    };

    const resumeLock = (job: Job): string | null =>
      lockText(moneyLockFor({ rebalance: null, transfer: deps.transfer?.jobs.read() ?? null, dealId: workingDeal(deps, job.id) }));

    const currentUserId = async (): Promise<string | null> => {
      const { value } = await deps.cache.get(
        'account',
        TTL.live,
        async () => (await deps.getClients().crossEx.getCrossexAccount()).body,
      );
      return value.userId ? String(value.userId) : null;
    };

    const haltedOr409 = (store: JobFile, id: string, reply: FastifyReply): Job | null => {
      const job = store.read();
      if (!job || job.id !== id) throw new CoreError(`unknown rebalance ${id}`);
      if (job.status !== 'halted') {
        conflict(reply, `rebalance ${job.id} is ${job.status}`);
        return null;
      }
      return job;
    };

    app.get('/rebalance', async (req, reply) => {
      const query = (req.query ?? {}) as { from?: unknown; to?: unknown; amount?: unknown; realizeUsd?: unknown; sliceUsd?: unknown; realizePool?: unknown; twapDurationSec?: unknown; twapSlices?: unknown };
      const custom = customGoalOf(query);
      const realizeUsd = positiveQueryOf(query.realizeUsd, 'realizeUsd') ?? null;
      const sliceUsd = positiveQueryOf(query.sliceUsd, 'sliceUsd');
      const realizePool = poolQueryOf(query.realizePool);
      const twapInput = realizeTwapQueryOf(query.twapDurationSec, query.twapSlices);
      const { buckets, plans, realize, fullPlan, imUsed, stale, perps, books } = await loadView(false, custom, realizeUsd, sliceUsd, realizePool, twapInput?.slices);
      const twapOf = (plan: RealizePlan | null) => (twapInput ? realizeTwapOf(plan, perps, books, twapInput, false).catch(() => null) : null);
      const realizeTwap = twapInput && realize ? { clearDebt: await twapOf(realize.clearDebt), all: await twapOf(realize.all), custom: await twapOf(realize.custom) } : null;
      const job = jobs?.read() ?? null;
      const twapView = job && jobs && (job.kind === 'twap' || isSlicedTwap(job)) ? await twapViewFor(jobs, job) : {};
      return reply.ok(
        { buckets, plans, realize, realizeTwap, fullPlan, imUsed, job: job ? { ...job, inTransit: await loadInTransit(job), ...twapView } : null },
        { stale },
      );
    });

    const deleverTwapOf = async (plan: DeleverPlan, perps: RealizePerp[], input: TwapInput | null, fresh: boolean) => {
      const lead = plan.legs[plan.makerLeg];
      if (plan.refused || !lead || lead.closeQty <= 0) return { twap: null, priceImpact: null, twapDefault: null };
      const ordered = [lead, ...plan.legs.filter((leg) => leg !== lead)];
      const legs = ordered.map((leg): OrderLeg => ({ symbol: leg.symbol, side: leg.side === 'LONG' ? 'SELL' : 'BUY' }));
      const markUsd = livePerpsOf(perps).find((perp) => perp.symbol === lead.symbol)?.markPrice ?? null;
      const planned = await twapPlanFor(legs, qtyText(lead.closeQty), input ?? TWAP_DEFAULT_INPUT, fresh, markUsd);
      const { result } = planned;
      return {
        twap: input === null ? null : { plan: result.plan, refusal: result.ok ? null : result.refusal, price: planned.price },
        priceImpact: planned.priceImpact,
        twapDefault: planned.twapDefault,
      };
    };

    const realizeTwapOf = async (
      plan: RealizePlan | null,
      perps: RealizePerp[],
      books: Record<string, NormalizedBook | null>,
      input: TwapInput,
      fresh: boolean,
    ): Promise<RealizeTwap | null> => {
      const legs = (plan?.legs ?? []).filter((leg) => leg.qty > 0);
      if (!plan || plan.refused || legs.length === 0) return null;
      const live = livePerpsOf(perps);
      const markOf = (symbol: string): number | null => live.find((perp) => perp.symbol === symbol)?.markPrice ?? null;
      const orderLeg = (leg: RealizeLeg): OrderLeg => ({ symbol: leg.symbol, side: leg.side === 'LONG' ? 'SELL' : 'BUY' });
      const usd = legs.map((leg) => leg.qty * (markOf(leg.symbol) ?? 0));
      const lead = usd.indexOf(Math.max(...usd));
      const whole = await twapPlanFor([orderLeg(legs[lead])], qtyText(legs[lead].qty), input, fresh, markOf(legs[lead].symbol));
      const refusalOf = (result: TwapPlanResult): TwapRefusal | null => (result.ok ? null : result.refusal);
      const estimatesOf = (rows: RealizeTwap['legs']): RealizeTwap['estimates'] => {
        const qtys = Object.fromEntries(rows.flatMap((row) => (row.plan ? [[row.symbol, twapQtysOf(row.plan)]] : [])));
        return { maker: twapEstimateOf(plan, 'maker', books, qtys), market: twapEstimateOf(plan, 'market', books, qtys) };
      };
      if (legs.length === 1) {
        const { plan: one } = whole.result;
        const refusal = refusalOf(whole.result);
        const rows = [{ symbol: legs[0].symbol, slices: one?.slices ?? 0, plan: one }];
        return { plan: one, refusal, price: whole.price, legs: rows, estimates: one && !refusal ? estimatesOf(rows) : null };
      }
      const shape = whole.result.plan;
      const shapeRefusal = refusalOf(whole.result);
      if (!shape || (shapeRefusal && shapeRefusal.field !== 'sliceSize')) return { plan: null, refusal: shapeRefusal, price: whole.price, legs: [], estimates: null };
      if (legs.length > shape.slices) {
        const fix = { label: `Use ${legs.length} slices`, patch: { ...input, slices: legs.length } };
        return { plan: null, refusal: { field: 'sliceSize', text: `Use at least ${legs.length} slices, one for each perp.`, fix }, price: whole.price, legs: [], estimates: null };
      }
      const counts = splitSlices(shape.slices, usd);
      const split: SplitLeg[] = [];
      for (const [index, leg] of legs.entries()) {
        const reopen: OrderLeg = { symbol: leg.symbol, side: orderLeg(leg).side === 'BUY' ? 'SELL' : 'BUY' };
        const planned = await twapPlanFor([orderLeg(leg), reopen], qtyText(leg.qty), { intervalSec: shape.intervalSec, slices: Math.max(2, counts[index]) }, fresh, markOf(leg.symbol));
        split.push({ qty: qtyText(leg.qty), rules: planned.rules, mark: planned.price, bookQty: planned.bookQty });
      }
      const planned = splitPlans(shape.intervalSec, counts, split);
      const rows: RealizeTwap['legs'] = legs.map((leg, index) => ({ symbol: leg.symbol, slices: planned[index].plan?.slices ?? counts[index], plan: planned[index].plan }));
      const failed = planned.find((row) => row.refusal)?.refusal ?? null;
      const leadLeg: SplitLeg = { qty: qtyText(legs[lead].qty), rules: whole.rules, mark: whole.price, bookQty: whole.bookQty };
      const offFix = failed?.fix && Object.keys(failed.fix.patch).length === 0 ? failed.fix : null;
      const refusal: TwapRefusal | null = failed ? { ...failed, fix: splitFixOf(input, leadLeg, split, usd) ?? offFix } : null;
      const slices = rows.reduce((total, row) => total + row.slices, 0);
      const joined: TwapPlan = { ...shape, slices, durationSec: slices === shape.slices ? shape.durationSec : slices * shape.intervalSec };
      return { plan: refusal ? null : joined, refusal, price: whole.price, legs: rows, estimates: refusal ? null : estimatesOf(rows) };
    };

    app.post('/rebalance/delever/plan', async (req, reply) => {
      const request = deleverRequestOf(req.body);
      if (!request) throw new CoreError(DELEVER_NEEDS);
      const twapInput = twapInputOf((req.body as { twap?: unknown } | undefined)?.twap);
      const { input, plan: whole, perps } = await loadDelever(request, false);
      const twapped = await deleverTwapOf(whole, perps, twapInput, false);
      const plan = twapped.twap?.plan ? planDelever(input, twapQtysOf(twapped.twap.plan)) : whole;
      const borosCloses = twapped.twap?.plan ? twapped.twap.plan.slices * plan.boros.filter((row) => row.closeSize > 0).length : 0;
      const perCloseUsd = borosCloses > 0 ? await borosOrderGasUsd() : 0;
      return reply.ok({ ...plan, ...twapped, borosCloses, borosGasUsd: perCloseUsd === null ? null : borosCloses * perCloseUsd });
    });

    interface StartBody {
      kind?: unknown;
      goal?: unknown;
      route?: unknown;
      costUsd?: unknown;
      from?: unknown;
      to?: unknown;
      amount?: unknown;
      realizeQty?: unknown;
      exec?: unknown;
      sliceUsd?: unknown;
      realizeUsd?: unknown;
      realizeTarget?: unknown;
      realizePool?: unknown;
      delever?: unknown;
      clientId?: unknown;
      deal?: unknown;
      durationSec?: unknown;
      slices?: unknown;
      intervalSec?: unknown;
      sliceQty?: unknown;
      maker?: unknown;
      twap?: unknown;
    }

    const refuse400 = (reply: FastifyReply, message: string): FastifyReply =>
      refuse(reply, { code: 400, category: 'validation', message, retryable: false });

    const takerAfterOf = (deal: Partial<DealBody>, plan: TwapPlan): number | null => {
      if (deal.timeoutSec === null) return null;
      if (deal.timeoutSec === undefined) return plan.takerAfterSec;
      const sec = Number(deal.timeoutSec);
      const cap = takerAfterCapSec(plan.intervalSec);
      if (!Number.isFinite(sec) || sec < TIMEOUT_MIN_S || sec > cap) throw new CoreError(takerAfterCapText(cap));
      return sec;
    };

    const repegOf = (deal: Partial<DealBody>): 2 | 5 | 10 | null => {
      if (deal.repegBehindBp === undefined) return REPEG_DEFAULT_BP;
      if (!REPEG_OR_OFF.includes(deal.repegBehindBp)) throw new CoreError('repegBehindBp must be 2, 5, 10 or null');
      return deal.repegBehindBp;
    };

    const makerOf = (asked: unknown): MakerOpts => {
      const maker = (asked ?? {}) as { takerAfterSec?: unknown; repegBehindBp?: unknown };
      const sec = maker.takerAfterSec === undefined ? MAKER_REST_MS / 1000 : maker.takerAfterSec === null ? null : Number(maker.takerAfterSec);
      if (sec !== null && (!Number.isFinite(sec) || sec < TIMEOUT_MIN_S || sec > TIMEOUT_MAX_S)) throw new CoreError(TIMEOUT_RANGE_TEXT);
      return { takerAfterSec: sec, repegBehindBp: repegOf({ repegBehindBp: maker.repegBehindBp as DealBody['repegBehindBp'] }) };
    };

    const sameTwap = (store: JobFile, clientId: string): Job | null => {
      const job = store.read();
      return job?.kind === 'twap' && job.twap?.clientId === clientId ? job : null;
    };

    const startTwap = async (body: StartBody, reply: FastifyReply): Promise<FastifyReply> => {
      const { clientId, durationSec, slices } = body;
      const deal = (body.deal ?? null) as Partial<DealBody> | null;
      if (typeof clientId !== 'string' || clientId === '' || typeof durationSec !== 'number' || typeof slices !== 'number') {
        throw new CoreError(TWAP_NEEDS);
      }
      if (!deal?.a?.symbol || typeof deal.qty !== 'string' || (deal.execution !== 'maker' && deal.execution !== 'taker')) {
        throw new CoreError(TWAP_NEEDS);
      }
      if (!isDecimalQty(deal.qty)) throw new CoreError('qty must be a positive decimal string');
      const shown = shownPlanOf(body);
      if (deal.makerLeg !== undefined && !['auto', 'a', 'b'].includes(deal.makerLeg)) throw new CoreError(`unknown maker leg ${String(deal.makerLeg)}`);
      const store = requireJobs();
      const seen = sameTwap(store, clientId);
      if (seen) return reply.code(202).ok({ id: seen.id });
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const a = { symbol: deal.a.symbol, side: deal.a.side };
      const b = deal.b ? { symbol: deal.b.symbol, side: deal.b.side } : null;
      const legs = b ? [a, b] : [a];
      const planFor = (input: TwapInput) => catchRateLimit(twapPlanFor(legs, deal.qty as string, input, true, null));
      let planned = await planFor(shown ? { intervalSec: shown.intervalSec, slices } : { durationSec, slices });
      if (planned && shown && !isShownPlan(planned.result.plan, shown, slices)) {
        planned = await planFor({ intervalSec: shown.intervalSec, sliceQty: shown.sliceQty });
      }
      if (!planned) return conflict(reply, STALE_TEXT);
      const total = fx(deal.qty);
      const offLot = planned.rules.findIndex((rule) => fxOrZero(rule.lot) > FX_ZERO && total % fxOrZero(rule.lot) !== FX_ZERO);
      if (offLot >= 0) throw new CoreError(`Size ${deal.qty} is not a multiple of ${legs[offLot].symbol}'s lot ${planned.rules[offLot].lot}`);
      if (shown && !isShownPlan(planned.result.plan, shown, slices)) return conflict(reply, TWAP_PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      if (!planned.result.ok) return refuse400(reply, planned.result.refusal.text);
      const plan = planned.result.plan;
      const takerAfterSec = takerAfterOf(deal, plan);
      const repegBehindBp = repegOf(deal);
      const makerLeg = !b ? 'a' : deal.makerLeg === 'a' || deal.makerLeg === 'b' ? deal.makerLeg : await autoMakerLeg(deps, a, b, deal.qty);
      const userId = await currentUserId();
      const again = sameTwap(store, clientId);
      if (again) return reply.code(202).ok({ id: again.id });
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const { id: _id, qty, price: _price, pricePolicy: _policy, timeoutSec: _timeout, deadlineCapSec: _cap, repegBehindBp: _repeg, makerLeg: _leg, ...template } =
        deal as DealBody;
      const job = newTwapJob(
        {
          userId,
          deal: { ...template, totalQty: qty, coin: parseSymbol(a.symbol).base, rules: planned.rules },
          plan,
          makerLeg,
          repegBehindBp,
          takerAfterSec,
          clientId,
        },
        now(),
      );
      store.write(job);
      start(store);
      return reply.code(202).ok({ id: job.id });
    };

    const startRealize = async (body: StartBody, exec: RealizeExec, reply: FastifyReply): Promise<FastifyReply> => {
      const target = body.realizeTarget;
      if (!isRealizeTarget(target)) throw new CoreError(REALIZE_TARGET_NEEDED);
      if (target === 'custom' && body.realizeUsd === undefined) throw new CoreError(CUSTOM_NEEDS_USD);
      const realizeUsd = target !== 'custom' ? null : isPositive(body.realizeUsd) ? body.realizeUsd : undefined;
      if (realizeUsd === undefined) return conflict(reply, RELOAD_TEXT);
      const realizePool = poolQueryOf(body.realizePool);
      const askedTwap = body.twap as { takerAfterSec?: number | null; repegBehindBp?: 2 | 5 | 10 | null } | null | undefined;
      const twapInput = twapInputOf(askedTwap);
      const maker = exec === 'maker' && twapInput === null ? makerOf(body.maker) : null;
      const store = requireJobs();
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const shownSlice = isPositive(body.sliceUsd) ? body.sliceUsd : undefined;
      const view = await catchRateLimit(loadView(true, null, realizeUsd, shownSlice, realizePool, twapInput?.slices));
      if (!view) return conflict(reply, STALE_TEXT);
      const tab = view.realize;
      if (tab && realizePool !== undefined && tab.pool !== realizePool) return conflict(reply, WALLET_HAS_NO_UPNL, PLAN_CHANGED_LABEL);
      const plan = tab ? tab[REALIZE_TARGETS[target]] : null;
      if (!tab || !plan) return conflict(reply, NOTHING_TO_REALIZE);
      if (plan.refused) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      if (plan.legs.length === 0) return conflict(reply, NOTHING_TO_REALIZE);
      const twap = twapInput ? await realizeTwapOf(plan, view.perps, view.books, twapInput, true) : null;
      if (twap?.refusal) return refuse400(reply, twap.refusal.text);
      if (twapInput && !twap?.plan) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const sliceUsd = cappedSliceOf(tab.sliceOptions, shownSlice ?? tab.defaultSliceUsd);
      const takerAfterSec = twap?.plan ? takerAfterOf({ timeoutSec: askedTwap?.takerAfterSec }, twap.plan) : null;
      const repegBehindBp = repegOf({ repegBehindBp: askedTwap?.repegBehindBp });
      const estimate = twap?.estimates ? twap.estimates[exec] : realizeTabEstimateOf(tab, plan, exec, sliceUsd);
      if (costRoseTooMuch(estimate.totalUsd, body.costUsd as number)) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const live = livePerpsOf(view.perps);
      const notionalUsd = plan.legs.reduce((total, leg) => total + leg.qty * (live.find((perp) => perp.symbol === leg.symbol)?.markPrice ?? 0), 0);
      const livePerps = jobPerpsOf(view.perps);
      const job = newJob(
        {
          route: 'mix',
          steps: [],
          amount: nearestCents(plan.legs.reduce((total, leg) => total + leg.realizedUsd, 0)),
          costUsd: estimate.totalUsd,
          target: [],
          userId: view.userId,
          realize: plan,
          realizeCostUsd: estimate.totalUsd,
          before: { buckets: view.buckets, perps: livePerps },
          openGaps: gapsLeftBy(store.read(), livePerps),
          kind: 'realize',
          exec,
          sliceUsd: shownSlice === undefined ? 0 : sliceUsd,
          sliceCount: twap?.plan ? twap.plan.slices : sliceCountOf(tab.sliceOptions, sliceUsd, notionalUsd),
          capsUsd: capsUsdOf(view.perps, view.perpRules),
          estimate,
          twap: twap?.plan
            ? {
                durationSec: twap.plan.durationSec,
                intervalSec: twap.plan.intervalSec,
                slices: twap.plan.slices,
                takerAfterSec,
                repegBehindBp,
                legs: twap.legs.map(({ symbol, slices }) => ({ symbol, slices })),
              }
            : null,
          maker,
        },
        now(),
      );
      store.write(job);
      start(store);
      return reply.code(202).ok({ id: job.id });
    };

    const startDelever = async (body: StartBody, exec: RealizeExec, reply: FastifyReply): Promise<FastifyReply> => {
      const asked = deleverRequestOf(body.delever);
      if (!asked) throw new CoreError(DELEVER_NEEDS);
      const shownSlice = isPositive(body.sliceUsd) ? body.sliceUsd : asked.sliceUsd;
      const request: DeleverRequest = { ...asked, exec, ...(shownSlice === undefined ? {} : { sliceUsd: shownSlice }) };
      const store = requireJobs();
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const loaded = await catchRateLimit(loadDelever(request, true));
      if (!loaded) return conflict(reply, STALE_TEXT);
      const { userId, account } = loaded;
      if (loaded.plan.refused) return conflict(reply, belowMinText(loaded.plan.refused));
      if (loaded.plan.legs.every((leg) => leg.closeQty <= 0)) return conflict(reply, NOTHING_TO_CLOSE);
      const askedTwap = (body.delever as { twap?: { takerAfterSec?: number | null; repegBehindBp?: 2 | 5 | 10 | null } | null } | undefined)?.twap;
      const twapInput = twapInputOf(askedTwap);
      const twap = twapInput ? (await deleverTwapOf(loaded.plan, loaded.perps, twapInput, true)).twap : null;
      if (twap?.refusal) return refuse400(reply, twap.refusal.text);
      const plan = twap?.plan ? planDelever(loaded.input, twapQtysOf(twap.plan)) : loaded.plan;
      const takerAfterSec = twap?.plan ? takerAfterOf({ timeoutSec: askedTwap?.takerAfterSec }, twap.plan) : null;
      const repegBehindBp = repegOf({ repegBehindBp: askedTwap?.repegBehindBp });
      const maker = exec === 'maker' && !twap?.plan ? makerOf(body.maker) : null;
      const cost = plan.estimates[exec];
      if (costRoseTooMuch(cost.totalUsd, body.costUsd as number)) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const [rates, paid] = await Promise.all([readRates(), interestPaid(userId)]);
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const sliceUsd = cappedSliceOf(plan.sliceOptions, shownSlice ?? plan.defaultSliceUsd);
      if (!twap?.plan && plan.sliceOptions.find((option) => option.sizeUsd === sliceUsd)?.pastBook) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const lead = plan.legs[plan.makerLeg];
      const leadUsd = lead ? (lead.closeQty * plan.notHedgedMaxUsd) / Math.max(plan.notHedgedMaxQty, Number.EPSILON) : 0;
      const livePerps = jobPerpsOf(loaded.perps);
      const job = newJob(
        {
          route: 'mix',
          steps: [],
          amount: 0,
          costUsd: cost.totalUsd,
          target: [],
          userId,
          before: { buckets: bucketsFrom(account, rates.value, paid.value), perps: livePerps },
          openGaps: gapsLeftBy(store.read(), livePerps),
          kind: 'delever',
          exec,
          sliceUsd,
          sliceCount: sliceCountOf(plan.sliceOptions, sliceUsd, leadUsd),
          capsUsd: capsUsdOf(loaded.perps, loaded.input.rules),
          estimate: { feeUsd: cost.feePerpsUsd + cost.feeBorosUsd, impactUsd: cost.impactUsd, totalUsd: cost.totalUsd },
          delever: plan,
          imUsedStart: plan.imUsed.map((row) => ({ account: row.account, pct: row.before })),
          twap: twap?.plan
            ? { durationSec: twap.plan.durationSec, intervalSec: twap.plan.intervalSec, slices: twap.plan.slices, takerAfterSec, repegBehindBp }
            : null,
          maker,
        },
        now(),
      );
      job.imUsedEnd = plan.imUsed.map((row) => ({ account: row.account, pct: row.after }));
      store.write(job);
      start(store);
      return reply.code(202).ok({ id: job.id });
    };

    app.post('/rebalance', async (req, reply) => {
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) return reply.code(403).send(DISCLAIMER_NOT_ACCEPTED);
      const body = (req.body ?? {}) as StartBody;
      const kind: JobKind = body.kind === undefined ? 'move' : isJobKind(body.kind) ? body.kind : (() => {
        throw new CoreError(`unknown kind ${String(body.kind)}`);
      })();
      if (kind === 'twap') return startTwap(body, reply);
      if (kind !== 'move') {
        const exec: RealizeExec = body.exec === undefined ? 'maker' : isExec(body.exec) ? body.exec : (() => {
          throw new CoreError(`unknown order mode ${String(body.exec)}`);
        })();
        if (!isShownCost(body.costUsd)) return conflict(reply, RELOAD_TEXT);
        if (body.sliceUsd !== undefined && !isPositive(body.sliceUsd)) return conflict(reply, RELOAD_TEXT);
        return kind === 'realize' ? startRealize(body, exec, reply) : startDelever(body, exec, reply);
      }
      const { route, costUsd } = body;
      const goal: GoalKind = body.goal === undefined ? 'even' : isGoalKind(body.goal) ? body.goal : (() => {
        throw new CoreError(`unknown goal ${String(body.goal)}`);
      })();
      if (!isRouteName(route)) throw new CoreError(`unknown route ${String(route)}`);
      if (!isShownCost(costUsd)) return conflict(reply, RELOAD_TEXT);
      const shownLegs = shownLegsOf(body.realizeQty);
      if (shownLegs === null) return conflict(reply, RELOAD_TEXT);
      const custom = goal === 'custom' ? customGoalOf(body) : null;
      if (goal === 'custom' && custom === null) throw new CoreError(CUSTOM_NEEDS);
      const store = requireJobs();
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const view = await catchRateLimit(loadView(true, custom));
      if (!view) return conflict(reply, STALE_TEXT);
      const { plans, userId, perpRules, buckets, perps } = view;
      const plan = plans[goal];
      if (!plan) throw new CoreError(CUSTOM_NEEDS);
      if (plan.balanced) return conflict(reply, nothingText(plan));
      const picked = plan.routes[route];
      if (!picked) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      if (!picked.available) return conflict(reply, picked.reason ?? PLAN_CHANGED_TEXT);
      if (picked.steps.length === 0) return conflict(reply, nothingText(plan));
      if (!isShownRealize([], shownLegs, perpRules)) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      if (costRoseTooMuch(picked.costUsd, costUsd)) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const moved = picked.steps.reduce((total, step) => total + step.move, 0);
      const livePerps = jobPerpsOf(perps);
      const job = newJob(
        {
          goal,
          route,
          steps: picked.steps,
          amount: floorCents(moved),
          costUsd: picked.costUsd,
          target: picked.after,
          userId,
          before: { buckets, perps: livePerps },
          routeImpactUsd: picked.priceImpactUsd,
          openGaps: gapsLeftBy(store.read(), livePerps),
        },
        now(),
      );
      store.write(job);
      start(store);
      return reply.code(202).ok({ id: job.id });
    });

    const jobOr404 = (store: JobFile, id: string): Job => {
      const job = store.read();
      if (!job || job.id !== id) throw new CoreError(`unknown rebalance ${id}`);
      return job;
    };

    app.post('/rebalance/:id/pause', async (req, reply) => {
      const store = requireJobs();
      const job = jobOr404(store, (req.params as { id: string }).id);
      if (job.status !== 'running') return conflict(reply, `rebalance ${job.id} is ${job.status}`);
      if (job.kind === 'twap') {
        if (!job.pauseRequested) store.write(requestPause(job));
        await stopLiveChild(twapDeps(store), job);
        return reply.ok(job);
      }
      if (job.slice === null) return conflict(reply, NOT_SLICED);
      if (!job.pauseRequested) store.write(requestPause(job));
      return reply.ok(job);
    });

    app.post('/rebalance/:id/fix', async (req, reply) => {
      const { action } = (req.body ?? {}) as { action?: unknown };
      if (!isFixAction(action)) throw new CoreError(`unknown fix ${String(action)}`);
      const store = requireJobs();
      if (fixing) return reply.ok(await fixing);
      const job = jobOr404(store, (req.params as { id: string }).id);
      const follow = action === 'market' || action === 'limit';
      const missed = job.status === 'running' && job.followMisses >= FOLLOW_MISSES_RED;
      const fixable =
        job.status === 'halted' || (follow && missed) || (action === 'boros-retry' && job.status === 'abandoned' && job.delever !== null);
      if (!fixable) return conflict(reply, `rebalance ${job.id} is ${job.status}`);
      const hedgeRefused = job.status === 'halted' && (job.haltKind === 'hedge-margin' || job.notHedgedQty > 0);
      const open = action === 'unwind'
        ? hedgeRefused
        : follow
        ? hedgeRefused || (job.follow?.qty ?? 0) > 0
        : action === 'boros-retry'
          ? job.delever !== null && Math.max(job.borosLeftYu, job.borosGapYu) > 0
          : job.borosLeftYu > 0;
      if (!open) return conflict(reply, NOTHING_TO_FIX);
      if (action === 'boros-retry' && job.status === 'halted' && job.steps[job.stepIndex]?.addBack) return conflict(reply, ADD_BACK_FIRST);
      const working = resumeLock(job);
      if (working) return conflict(reply, working);
      if (job.userId !== null && (await currentUserId()) !== job.userId) {
        return conflict(reply, 'This rebalance was started on another Gate account. Abandon it.');
      }
      if (fixing) return reply.ok(await fixing);
      const run =
        job.status === 'running' && inflight
          ? new Promise<Job>((done, fail) => {
              queuedFix = { action, done, fail };
            })
          : applyFix(runnerDeps(store), job, action);
      fixing = run;
      try {
        const fixed = await run;
        if (fixed.status === 'running') start(store);
        return reply.ok(fixed);
      } finally {
        fixing = null;
      }
    });

    app.post('/rebalance/:id/resume', async (req, reply) => {
      const store = requireJobs();
      const job = haltedOr409(store, (req.params as { id: string }).id, reply);
      if (!job) return reply;
      if (job.sizeRefusal?.wholeRest && job.haltReason) return conflict(reply, job.haltReason);
      if (fixing) return conflict(reply, FIX_RUNNING);
      if (job.steps[job.stepIndex]?.addBack) return conflict(reply, ADD_BACK_FIRST);
      // The same rule as the start: the remaining steps move cash a working
      // deal may be counting on.
      const working = resumeLock(job);
      if (working) return conflict(reply, working);
      // The steps hold venue ids and amounts of the account they ran on. On
      // another account they would poll ids it does not know, or send from it.
      if (job.userId !== null && (await currentUserId()) !== job.userId) {
        return conflict(reply, 'This rebalance was started on another Gate account. Abandon it.');
      }
      const current = store.read();
      if (current?.id !== job.id || current.status !== 'halted') {
        return conflict(reply, 'This rebalance is no longer halted');
      }
      const lockedNow = resumeLock(current);
      if (lockedNow) return conflict(reply, lockedNow);
      current.status = 'running';
      current.haltReason = null;
      if (current.kind === 'twap') {
        current.paused = false;
        current.pauseRequested = false;
        current.haltKind = null;
        current.sizeRefusal = null;
        store.write(current);
        start(store);
        return reply.ok(current);
      }
      current.steps[current.stepIndex].startedAt = now();
      current.retryConverts = 0;
      store.write(current);
      start(store);
      return reply.ok(current);
    });

    app.post('/rebalance/:id/abandon', async (req, reply) => {
      const store = requireJobs();
      const id = (req.params as { id: string }).id;
      const live = jobOr404(store, id);
      if (live.kind === 'twap' && (live.status === 'running' || live.status === 'halted')) {
        if (fixing) return conflict(reply, FIX_RUNNING);
        await stopLiveChild(twapDeps(store), live);
        const ended = jobOr404(store, id);
        ended.status = 'abandoned';
        if (ended.twap) ended.twap.nextAt = null;
        store.write(ended);
        return reply.ok(ended);
      }
      const job = haltedOr409(store, id, reply);
      if (!job) return reply;
      if (fixing) return conflict(reply, FIX_RUNNING);
      const settle = settleAddBack(runnerDeps(store), job).then((unread) => {
        job.status = 'abandoned';
        job.haltReason = addBackAbandonText(job, unread) ?? job.haltReason;
        const gaps = addBackGapsOf(job, unread);
        if (gaps.length > 0) job.openGaps = [...(job.openGaps ?? []), ...gaps];
        store.write(job);
        return job;
      });
      fixing = settle;
      try {
        return reply.ok(await settle);
      } catch (err) {
        if (err instanceof Error && err.message === FIX_UNCONFIRMED) return conflict(reply, FIX_UNCONFIRMED);
        throw err;
      } finally {
        fixing = null;
      }
    });
  };
}
