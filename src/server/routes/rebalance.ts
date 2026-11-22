import type { FastifyInstance, FastifyReply } from 'fastify';
import { classifyPlain, CoreError, describeError } from '../../core/errors';
import { fetchBorosOrderBook, resolveBorosFetch, resolveCollateralPricesUsd } from '../../core/boros/client';
import { halfCapSeedPct } from '../../core/boros/rollProbe';
import { borosTimeToMaturitySec } from '../../core/boros/opportunities';
import { fetchDeepBook, type NormalizedBook } from '../../core/estimate/books';
import { DEFAULT_STEP, parseSymbol } from '../../core/numbers';
import { type DeleverInput, type DeleverPlan, type DeleverRequest, planDelever } from '../../core/rebalance/delever';
import { computeExposure } from '../../core/positions';
import {
  isInProfit,
  positiveOf,
  type PerpRule,
  type PerpSide,
  type RealizeExec,
  type RealizeLeg,
  type RealizePerp,
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
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { DISCLAIMER_NOT_ACCEPTED, isDisclaimerAccepted } from '../disclaimer';
import { catchRateLimit, sendError } from '../errorReply';
import { INTEREST_OVERFLOW, InterestFile, syncInterest } from '../interestLedger';
import {
  bannerFor,
  FOLLOW_MISSES_RED,
  gapsLeftBy,
  inTransitOf,
  LOCK_TEXT,
  moneyLockFor,
  newJob,
  requestPause,
  SLICE_STEP,
  type FixAction,
  type Job,
  type JobFile,
  type JobKind,
  type JobPerp,
  type MoneyLock,
  type StepName,
} from '../rebalanceJob';
import { applyFix, cancelRestingLead, receivedOf, runJob, STEPS, transferRow, type QueuedFix, type RunnerDeps } from '../rebalanceRunner';
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
const JOB_KINDS: readonly string[] = ['move', 'realize', 'delever'];
const EXECS: readonly string[] = ['maker', 'market'];
const FIX_ACTIONS: readonly string[] = ['market', 'limit', 'boros-retry', 'add-back'];
const NOTHING_TO_REALIZE = 'No perp in profit to realize.';
const NOTHING_TO_CLOSE = 'Nothing to close.';
const NOTHING_TO_FIX = 'Nothing is left to fix.';
const FIX_RUNNING = 'A fix is still running. Wait for it to finish.';
const NOT_SLICED = 'Only a sliced run can pause.';
const REALIZE_TARGET_NEEDED = 'Pick Clear debt, All or Custom before you realize.';
const CUSTOM_NEEDS_USD = 'Enter the Custom amount before you realize.';
const DELEVER_NEEDS = 'A Delever needs perps, Boros legs and an order mode.';
const NO_BOROS_WALLET = 'The app has no Boros wallet to close the Boros share with.';
const YEAR_SEC = 365 * 86_400;

export const STALE_TEXT = 'Gate is limiting requests from this account. Try again in a few seconds.';

export const conflict = (reply: FastifyReply, message: string, label?: string): FastifyReply =>
  reply.code(409).send({ ok: false, error: { category: 'validation', label, message, retryable: true } });

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const workingDeal = (deps: AppDeps): string | null => deps.engine!.store.listPairs({ activeOnly: true })[0]?.id ?? null;

export const moneyLockNow = (deps: AppDeps): MoneyLock | null =>
  moneyLockFor({
    rebalance: deps.rebalance?.jobs.read() ?? null,
    transfer: deps.transfer?.jobs.read() ?? null,
    dealId: workingDeal(deps),
  });

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
  Math.min(asked, options.find((option) => option.custom)?.sizeUsd ?? asked);

interface LivePerp extends JobPerp {
  base: string;
  markPrice: number;
  initialMargin: number;
}

const livePerpsOf = (perps: RealizePerp[]): LivePerp[] =>
  perps.flatMap((perp) => {
    const qty = Number(perp.positionQty);
    if (!perp.symbol || !Number.isFinite(qty) || qty === 0) return [];
    const { exchange, base } = parseSymbol(perp.symbol);
    const side: PerpSide = qty < 0 ? 'SHORT' : 'LONG';
    return [{ symbol: perp.symbol, exchange, base, side, qty: Math.abs(qty), markPrice: positiveOf(perp.markPrice), initialMargin: positiveOf(perp.initialMargin) }];
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

const leadsToReopen = (job: Job): boolean =>
  job.steps.slice(job.stepIndex).find((step) => !step.name.startsWith('Convert'))?.name === 'Reopen';

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
        ...(address ? { boros: { deps: borosCloseDeps, address, slippagePct: borosSlippagePct } } : {}),
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

    const bootJob = jobs?.read() ?? null;
    const bootStep = bootJob?.status === 'running' ? bootJob.steps[bootJob.stepIndex] : undefined;
    const resumesAtBoot =
      bootJob !== null &&
      bootStep !== undefined &&
      (bootStep.venueId !== null || bootStep.text !== null || leadsToReopen(bootJob));
    if (jobs && bootJob && bootStep?.name === SLICE_STEP) {
      inflight = cancelRestingLead(runnerDeps(jobs), bootJob)
        .then(() => {
          if (!bootJob.paused) onHalt(bootJob);
        })
        .catch((err: unknown) => console.error(`rebalance boot: ${describeError(err)}`))
        .finally(() => {
          inflight = null;
        });
    } else if (jobs && bootStep && resumesAtBoot) {
      bootStep.startedAt = now();
      jobs.write(bootJob);
      start(jobs, true);
    } else if (bootJob && jobs?.haltIfRunning()) {
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

    const perpBooks = async (symbols: string[]): Promise<Record<string, NormalizedBook | null>> => {
      const read = (symbol: string): Promise<NormalizedBook | null> => {
        const { exchange, base, quote } = parseSymbol(symbol);
        return deps.cache.get(`book:deep:${symbol}`, TTL.live, () => fetchDeepBook(exchange, base, quote)).then(
          ({ value }) => value,
          () => null,
        );
      };
      return Object.fromEntries(await Promise.all(symbols.map(async (symbol) => [symbol, await read(symbol)] as const)));
    };

    const crossEx = () => deps.getClients().crossEx;
    const readAccount = (fresh: boolean) =>
      deps.cache.get('account', TTL.live, async () => (await crossEx().getCrossexAccount()).body, { fresh });
    const readPositions = (fresh: boolean) =>
      deps.cache.get('positions', TTL.live, async () => (await crossEx().listCrossexPositions()).body, { fresh });
    const readRules = () => deps.cache.get('rules:all', TTL.static, async () => (await crossEx().listCrossexRuleSymbols()).body);
    const readFees = () => deps.cache.get('fees', TTL.static, async () => (await crossEx().getCrossexFee()).body);
    const perpRulesOf = (rows: Awaited<ReturnType<typeof readRules>>['value']): Record<string, PerpRule> =>
      Object.fromEntries(
        rows.flatMap((rule) =>
          rule.symbol ? [[rule.symbol, { lotSize: rule.lotSize, minSize: rule.minSize, minNotional: rule.minNotional, maxMarketSize: rule.maxMarketSize }]] : [],
        ),
      );

    const loadView = async (fresh: boolean, custom: Goal | null, realizeUsd: number | null = null, sliceUsd?: number) => {
      const account = await readAccount(fresh);
      const userId = account.value.userId ? String(account.value.userId) : null;
      const [positions, rates, paid, coins, rules, fees, tickers, depth] = await Promise.all([
        readPositions(fresh),
        orEmpty(deps.cache.get('interest:rate', TTL.static, async () => (await crossEx().getCrossexInterestRate()).body)),
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
      const realize = realizeTabOf(buckets, account.value, inputs, realizeUsd, sliceUsd);
      const fullPlan = fullPlanOf(buckets, account.value, inputs);
      const imUsed = imUsedOf(account.value);
      const stale = [account, positions, rates, paid, coins, rules, fees, tickers].some((r) => r.stale);
      return { buckets, plans, realize, fullPlan, imUsed, stale, userId, perpRules, perps };
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
      return { plan: planDelever(input), userId: account.value.userId ? String(account.value.userId) : null };
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

    const findLock = (): string | null => lockText(moneyLockNow(deps));

    const resumeLock = (): string | null =>
      lockText(moneyLockFor({ rebalance: null, transfer: deps.transfer?.jobs.read() ?? null, dealId: workingDeal(deps) }));

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
      const query = (req.query ?? {}) as { from?: unknown; to?: unknown; amount?: unknown; realizeUsd?: unknown; sliceUsd?: unknown };
      const custom = customGoalOf(query);
      const realizeUsd = positiveQueryOf(query.realizeUsd, 'realizeUsd') ?? null;
      const sliceUsd = positiveQueryOf(query.sliceUsd, 'sliceUsd');
      const { buckets, plans, realize, fullPlan, imUsed, stale } = await loadView(false, custom, realizeUsd, sliceUsd);
      const job = jobs?.read() ?? null;
      return reply.ok(
        { buckets, plans, realize, fullPlan, imUsed, job: job ? { ...job, inTransit: await loadInTransit(job) } : null },
        { stale },
      );
    });

    app.post('/rebalance/delever/plan', async (req, reply) => {
      const request = deleverRequestOf(req.body);
      if (!request) throw new CoreError(DELEVER_NEEDS);
      return reply.ok((await loadDelever(request, false)).plan);
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
      delever?: unknown;
    }

    const startRealize = async (body: StartBody, exec: RealizeExec, reply: FastifyReply): Promise<FastifyReply> => {
      const target = body.realizeTarget;
      if (!isRealizeTarget(target)) throw new CoreError(REALIZE_TARGET_NEEDED);
      if (target === 'custom' && body.realizeUsd === undefined) throw new CoreError(CUSTOM_NEEDS_USD);
      const realizeUsd = target !== 'custom' ? null : isPositive(body.realizeUsd) ? body.realizeUsd : undefined;
      if (realizeUsd === undefined) return conflict(reply, RELOAD_TEXT);
      const store = requireJobs();
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const shownSlice = isPositive(body.sliceUsd) ? body.sliceUsd : undefined;
      const view = await catchRateLimit(loadView(true, null, realizeUsd, shownSlice));
      if (!view) return conflict(reply, STALE_TEXT);
      const tab = view.realize;
      const plan = tab ? tab[REALIZE_TARGETS[target]] : null;
      if (!tab || !plan) return conflict(reply, NOTHING_TO_REALIZE);
      if (plan.refused) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      if (plan.legs.length === 0) return conflict(reply, NOTHING_TO_REALIZE);
      const sliceUsd = cappedSliceOf(tab.sliceOptions, shownSlice ?? tab.defaultSliceUsd);
      const estimate = realizeTabEstimateOf(tab, plan, exec, sliceUsd);
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
          sliceUsd,
          sliceCount: sliceCountOf(tab.sliceOptions, sliceUsd, notionalUsd),
          estimate,
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
      const { plan, userId } = loaded;
      if (plan.refused) return conflict(reply, belowMinText(plan.refused));
      if (plan.legs.every((leg) => leg.closeQty <= 0)) return conflict(reply, NOTHING_TO_CLOSE);
      const cost = plan.estimates[exec];
      if (costRoseTooMuch(cost.totalUsd, body.costUsd as number)) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const sliceUsd = cappedSliceOf(plan.sliceOptions, shownSlice ?? plan.defaultSliceUsd);
      const lead = plan.legs[plan.makerLeg];
      const leadUsd = lead ? (lead.closeQty * plan.notHedgedMaxUsd) / Math.max(plan.notHedgedMaxQty, Number.EPSILON) : 0;
      const job = newJob(
        {
          route: 'mix',
          steps: [],
          amount: 0,
          costUsd: cost.totalUsd,
          target: [],
          userId,
          kind: 'delever',
          exec,
          sliceUsd,
          sliceCount: sliceCountOf(plan.sliceOptions, sliceUsd, leadUsd),
          estimate: { feeUsd: cost.feePerpsUsd + cost.feeBorosUsd, impactUsd: cost.impactUsd, totalUsd: cost.totalUsd },
          delever: plan,
          imUsedStart: plan.imUsed.map((row) => ({ account: row.account, pct: row.before })),
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
      const open = follow
        ? (job.follow?.qty ?? 0) > 0
        : action === 'boros-retry'
          ? job.delever !== null && Math.max(job.borosLeftYu, job.borosGapYu) > 0
          : job.borosLeftYu > 0;
      if (!open) return conflict(reply, NOTHING_TO_FIX);
      const working = resumeLock();
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
      if (fixing) return conflict(reply, FIX_RUNNING);
      // The same rule as the start: the remaining steps move cash a working
      // deal may be counting on.
      const working = resumeLock();
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
      const lockedNow = resumeLock();
      if (lockedNow) return conflict(reply, lockedNow);
      current.status = 'running';
      current.haltReason = null;
      current.steps[current.stepIndex].startedAt = now();
      store.write(current);
      start(store);
      return reply.ok(current);
    });

    app.post('/rebalance/:id/abandon', async (req, reply) => {
      const store = requireJobs();
      const job = haltedOr409(store, (req.params as { id: string }).id, reply);
      if (!job) return reply;
      if (fixing) return conflict(reply, FIX_RUNNING);
      job.status = 'abandoned';
      store.write(job);
      return reply.ok(job);
    });
  };
}
