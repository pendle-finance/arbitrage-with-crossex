import type { FastifyInstance, FastifyReply } from 'fastify';
import { CoreError } from '../../core/errors';
import {
  bucketsFrom,
  floorCents,
  planFor,
  SPOT_PAIR,
  SPOT_SYMBOL,
  type InterestPaidLike,
  type RouteName,
} from '../../core/rebalance/plan';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { DISCLAIMER_NOT_ACCEPTED, isDisclaimerAccepted } from '../disclaimer';
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
} from '../rebalanceJob';
import { runJob } from '../rebalanceRunner';

const ROUTE_NAMES: readonly string[] = ['mix', 'loop', 'convert'];

export const STALE_TEXT = 'Gate is rate-limiting the account read. Try again in a few seconds.';

export const conflict = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(409).send({ ok: false, error: { category: 'validation', message, retryable: true } });

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

export function rebalanceRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    const jobs = deps.rebalance?.jobs ?? null;
    const now = (): number => deps.engine!.clock.now();
    const alert = (pairId: string | null, message: string): void => {
      console.error(message);
      const engine = deps.engine;
      if (engine) engine.store.alert('error', pairId, message, engine.clock.now(), { once: true });
    };
    const onHalt = (job: Job): void => alert(`rebalance:${job.id}`, bannerFor(job));
    const haltedAtBoot = jobs?.haltIfRunning() ? jobs.read() : null;
    if (haltedAtBoot) onHalt(haltedAtBoot);
    let inflight: Promise<void> | null = null;

    const requireJobs = (): JobFile => {
      if (!jobs) throw new CoreError('rebalance store not configured', 'not-configured');
      return jobs;
    };

    const start = (store: JobFile): void => {
      if (inflight) return;
      inflight = runJob({
        clients: () => deps.getClients(),
        jobs: store,
        cache: deps.cache,
        now,
        sleep: deps.rebalance?.sleep ?? sleep,
        onHalt,
      }).finally(() => {
        inflight = null;
      });
    };

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

    const loadView = async (fresh: boolean) => {
      const crossEx = () => deps.getClients().crossEx;
      const account = await deps.cache.get('account', TTL.live, async () => (await crossEx().getCrossexAccount()).body, {
        fresh,
      });
      const userId = account.value.userId ? String(account.value.userId) : null;
      const [rates, paid, coins, rules, fees, tickers] = await Promise.all([
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
      ]);
      const buckets = bucketsFrom(account.value, rates.value, paid.value);
      const gateFees = fees.value.find((f) => f.exchangeType === 'GATE');
      const special = gateFees?.specialFeeList?.find((s) => s.symbol === SPOT_SYMBOL);
      const ask = Number(tickers.value[0]?.lowestAsk);
      const bid = Number(tickers.value[0]?.highestBid);
      const plan = planFor(buckets, account.value, {
        coins: coins.value,
        spotRule: rules.value.find((r) => r.symbol === SPOT_SYMBOL) ?? null,
        spotTakerRate: Number(special?.takerFeeRate ?? gateFees?.spotTakerFee ?? 0),
        ask: Number.isFinite(ask) ? ask : null,
        bid: Number.isFinite(bid) ? bid : null,
      });
      const stale = [account, rates, paid, coins, rules, fees, tickers].some((r) => r.stale);
      return { buckets, plan, stale, accountStale: account.stale, userId };
    };

    const findLock = (): string | null => {
      const lock = moneyLockNow(deps);
      if (lock === null) return null;
      if (lock.kind === 'moving') return LOCK_TEXT.rebalanceWaits;
      if (lock.kind === 'deal') return `deal ${lock.id} is still working`;
      return `rebalance ${lock.id} is ${lock.kind === 'halted' ? 'halted' : 'running'}`;
    };

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

    app.get('/rebalance', async (_req, reply) => {
      const { buckets, plan, stale } = await loadView(false);
      const job = jobs?.read() ?? null;
      return reply.ok({ buckets, plan, job: job ? { ...job, inTransit: inTransitOf(job) } : null }, { stale });
    });

    app.post('/rebalance', async (req, reply) => {
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) return reply.code(403).send(DISCLAIMER_NOT_ACCEPTED);
      const { route } = (req.body ?? {}) as { route?: unknown };
      if (!isRouteName(route)) throw new CoreError(`unknown route ${String(route)}`);
      const store = requireJobs();
      const locked = findLock();
      if (locked) return conflict(reply, locked);
      const { plan, accountStale, userId } = await loadView(true);
      // The amount is sized from this read. A read served from the cache
      // because Gate rate-limited the fresh one may be seconds old, and a
      // move to USDT sized on old equity can open the borrow it promises not to.
      if (accountStale) return conflict(reply, STALE_TEXT);
      if (plan.balanced || plan.direction === null) return conflict(reply, 'Already even.');
      const name = route === 'mix' && !plan.routes.mix ? plan.recommended : route;
      const picked = name ? plan.routes[name] : null;
      if (!name || !picked?.available) return conflict(reply, picked?.reason ?? 'no route');
      const lockedNow = findLock();
      if (lockedNow) return conflict(reply, lockedNow);
      const moved = picked.steps.reduce((total, step) => total + step.move, 0);
      const job = newJob(
        {
          direction: plan.direction,
          route: name,
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
      const working = workingDeal(deps);
      if (working) return conflict(reply, `deal ${working} is still working`);
      // The steps hold venue ids and amounts of the account they ran on. On
      // another account they would poll ids it does not know, or send from it.
      if (job.userId !== null && (await currentUserId()) !== job.userId) {
        return conflict(reply, `rebalance ${job.id} was started on another Gate account. Abandon it.`);
      }
      job.status = 'running';
      job.haltReason = null;
      job.steps[job.stepIndex].startedAt = now();
      store.write(job);
      start(store);
      return reply.ok(job);
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
