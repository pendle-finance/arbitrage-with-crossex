import type { FastifyInstance, FastifyReply } from 'fastify';
import { classifyGateError, classifyPlain, CoreError } from '../../core/errors';
import { computeExposure } from '../../core/positions';
import {
  bookLevels,
  bucketsFrom,
  EVEN_GOAL,
  floorCents,
  notionalByWallet,
  planFor,
  POOLS,
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
  inTransitOf,
  LOCK_TEXT,
  moneyLockFor,
  newJob,
  type Job,
  type JobFile,
  type MoneyLock,
  type StepName,
} from '../rebalanceJob';
import { receivedOf, runJob, STEPS, transferRow } from '../rebalanceRunner';

const ROUTE_NAMES: readonly string[] = ['mix', 'loop', 'convert'];
const GOAL_KINDS: readonly string[] = ['even', 'repay', 'custom'];
const ALREADY_EVEN = 'Already even.';
const NO_LEGS = 'No open positions. Nothing to rebalance.';
const NO_BORROW = 'No borrow to repay.';
const NOTHING_TO_MOVE = 'Nothing to move.';
const CUSTOM_NEEDS = 'A custom move needs from, to and amount.';
const LOOP_GONE = 'Spot loop is no longer offered. Pick a route again.';
const RELOAD_TEXT = 'This page is out of date. Reload it and check the plan before you rebalance.';
const PLAN_CHANGED_TEXT = 'The plan changed. Check the new route before you rebalance.';
const PLAN_CHANGED_LABEL = 'PLAN_CHANGED';

export const STALE_TEXT = 'Gate is rate-limiting the account read. Try again in a few seconds.';

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

    const start = (store: JobFile, pollOnly = false): void => {
      if (inflight) return;
      inflight = runJob({
        clients: () => deps.getClients(),
        jobs: store,
        cache: deps.cache,
        now,
        sleep: deps.rebalance?.sleep ?? sleep,
        onHalt,
        onDone: deps.rebalance?.onDone,
        pollOnly,
      })
        .then(() => {
          const job = store.read();
          if (job?.status === 'done') ackAlerts(job);
        })
        .catch((err: unknown) => console.error(`rebalance stopped: ${classifyGateError(err).message}`))
        .finally(() => {
          inflight = null;
        });
    };

    const bootJob = jobs?.read() ?? null;
    const bootStep = bootJob?.status === 'running' ? bootJob.steps[bootJob.stepIndex] : undefined;
    if (jobs && bootJob && bootStep && (bootStep.venueId !== null || bootStep.text !== null)) {
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

    const loadView = async (fresh: boolean, custom: Goal | null) => {
      const crossEx = () => deps.getClients().crossEx;
      const account = await deps.cache.get('account', TTL.live, async () => (await crossEx().getCrossexAccount()).body, {
        fresh,
      });
      const userId = account.value.userId ? String(account.value.userId) : null;
      const [positions, rates, paid, coins, rules, fees, tickers, depth] = await Promise.all([
        deps.cache.get('positions', TTL.live, async () => (await crossEx().listCrossexPositions()).body, { fresh }),
        orEmpty(deps.cache.get('interest:rate', TTL.static, async () => (await crossEx().getCrossexInterestRate()).body)),
        interestPaid(userId),
        deps.cache.get('transfer:coins', TTL.static, async () => (await crossEx().listCrossexTransferCoins()).body),
        deps.cache.get('rules:all', TTL.static, async () => (await crossEx().listCrossexRuleSymbols()).body),
        deps.cache.get('fees', TTL.static, async () => (await crossEx().getCrossexFee()).body),
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
      };
      // Every goal is planned off the same read, so the presets a trader
      // compares are priced against one account picture.
      const plans = {
        even: planFor(buckets, account.value, inputs, EVEN_GOAL),
        repay: planFor(buckets, account.value, inputs, REPAY_GOAL),
        custom: custom ? planFor(buckets, account.value, inputs, custom) : null,
      };
      const stale = [account, positions, rates, paid, coins, rules, fees, tickers].some((r) => r.stale);
      return { buckets, plans, stale, userId };
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
      if (lock.kind === 'deal') return `deal ${lock.id} is still working`;
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
      const custom = customGoalOf((req.query ?? {}) as { from?: unknown; to?: unknown; amount?: unknown });
      const { buckets, plans, stale } = await loadView(false, custom);
      const job = jobs?.read() ?? null;
      return reply.ok({ buckets, plans, job: job ? { ...job, inTransit: await loadInTransit(job) } : null }, { stale });
    });

    app.post('/rebalance', async (req, reply) => {
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) return reply.code(403).send(DISCLAIMER_NOT_ACCEPTED);
      const body = (req.body ?? {}) as { goal?: unknown; route?: unknown; costUsd?: unknown; from?: unknown; to?: unknown; amount?: unknown };
      const { route, costUsd } = body;
      const goal: GoalKind = body.goal === undefined ? 'even' : isGoalKind(body.goal) ? body.goal : (() => {
        throw new CoreError(`unknown goal ${String(body.goal)}`);
      })();
      if (!isRouteName(route)) throw new CoreError(`unknown route ${String(route)}`);
      if (!isShownCost(costUsd)) return conflict(reply, RELOAD_TEXT);
      const custom = goal === 'custom' ? customGoalOf(body) : null;
      if (goal === 'custom' && custom === null) throw new CoreError(CUSTOM_NEEDS);
      const store = requireJobs();
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const view = await catchRateLimit(loadView(true, custom));
      if (!view) return conflict(reply, STALE_TEXT);
      const { plans, userId } = view;
      const plan = plans[goal];
      if (!plan) throw new CoreError(CUSTOM_NEEDS);
      if (plan.balanced) return conflict(reply, nothingText(plan));
      const picked = plan.routes[route];
      const otherLoop = route === 'mix' ? plan.routes.loop : route === 'loop' ? plan.routes.mix : null;
      if (!picked && otherLoop) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      if (!picked?.available) return conflict(reply, picked?.reason ?? LOOP_GONE);
      if (picked.steps.length === 0) return conflict(reply, nothingText(plan));
      if (costRoseTooMuch(picked.costUsd, costUsd)) return conflict(reply, PLAN_CHANGED_TEXT, PLAN_CHANGED_LABEL);
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const moved = picked.steps.reduce((total, step) => total + step.move, 0);
      const job = newJob(
        {
          goal,
          route,
          steps: picked.steps,
          amount: floorCents(moved),
          costUsd: picked.costUsd,
          target: picked.after,
          userId,
        },
        now(),
      );
      store.write(job);
      start(store);
      return reply.code(202).ok({ id: job.id });
    });

    app.post('/rebalance/:id/resume', async (req, reply) => {
      const store = requireJobs();
      const job = haltedOr409(store, (req.params as { id: string }).id, reply);
      if (!job) return reply;
      // The same rule as the start: the remaining steps move cash a working
      // deal may be counting on.
      const working = resumeLock();
      if (working) return conflict(reply, working);
      // The steps hold venue ids and amounts of the account they ran on. On
      // another account they would poll ids it does not know, or send from it.
      if (job.userId !== null && (await currentUserId()) !== job.userId) {
        return conflict(reply, `rebalance ${job.id} was started on another Gate account. Abandon it.`);
      }
      const current = store.read();
      if (current?.id !== job.id || current.status !== 'halted') {
        return conflict(reply, `rebalance ${job.id} is no longer halted`);
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
      job.status = 'abandoned';
      store.write(job);
      return reply.ok(job);
    });
  };
}
