import type { FastifyInstance, FastifyReply } from 'fastify';
import { CoreError } from '../../core/errors';
import { bucketsFrom, planFor, SPOT_SYMBOL, type Direction, type InterestPaidLike } from '../../core/rebalance/plan';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { isDisclaimerAccepted } from '../disclaimer';
import { INTEREST_OVERFLOW, InterestFile, syncInterest } from '../interestLedger';
import { haltMessage, newJob, type Job, type JobFile } from '../rebalanceJob';
import { runJob } from '../rebalanceRunner';

const SPOT_PAIR = 'USDC_USDT';

const conflict = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(409).send({ ok: false, error: { category: 'validation', message, retryable: true } });

const orEmpty = <T>(read: Promise<{ value: T[]; stale: boolean }>): Promise<{ value: T[]; stale: boolean }> =>
  read.catch(() => ({ value: [], stale: true }));

/** `pull` and `payDown` are the names before 1.5.1; a tab still running that
 * bundle for a moment after an update must not have its move flipped. */
const directionOf = (value: unknown): Direction => (value === 'toUsdt' || value === 'pull' ? 'toUsdt' : 'toUsdc');

const requestedOf = (value: unknown): number => {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};

export function rebalanceRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    const jobs = deps.rebalance?.jobs ?? null;
    const now = (): number => deps.engine!.clock.now();
    const log = (message: string): void => {
      console.error(message);
      const engine = deps.engine;
      if (engine) engine.store.alert('error', null, message, engine.clock.now(), { once: true });
    };
    if (jobs?.haltIfRunning('server restarted')) log(haltMessage(jobs.read()!));
    let inflight: Promise<void> | null = null;

    const requireJobs = (): JobFile => {
      if (!jobs) throw new CoreError('rebalance store not configured', 'not-configured');
      return jobs;
    };

    const busyJob = (store: JobFile): Job | null => {
      const current = store.read();
      return current && (current.status === 'running' || current.status === 'halted') ? current : null;
    };

    const start = (store: JobFile): void => {
      if (inflight) return;
      const sleep =
        deps.rebalance?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      inflight = runJob({ clients: () => deps.getClients(), jobs: store, cache: deps.cache, now, sleep, log }).finally(
        () => {
          inflight = null;
        },
      );
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
          if (e instanceof CoreError && e.details === INTEREST_OVERFLOW) log(e.message);
          return { value: {}, stale: true };
        });

    const loadView = async (fresh: boolean, direction: Direction, requested: number) => {
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
      // Gate sends min_trans_amount as a string although the SDK declares a
      // number. Coerce here so the plan's arithmetic never concatenates.
      const usdcCoin = coins.value.find((c) => c.coin === 'USDC');
      const plan = planFor(
        buckets,
        account.value,
        {
          usdcTransfer: usdcCoin
            ? { isDisabled: Number(usdcCoin.isDisabled), minTransAmount: Number(usdcCoin.minTransAmount) }
            : null,
          spotRule: rules.value.find((r) => r.symbol === SPOT_SYMBOL) ?? null,
          spotTakerRate: Number(special?.takerFeeRate ?? gateFees?.spotTakerFee ?? 0),
          ask: Number.isFinite(ask) ? ask : null,
          bid: Number.isFinite(bid) ? bid : null,
        },
        { direction, requested },
      );
      const stale = [account, rates, paid, coins, rules, fees, tickers].some((r) => r.stale);
      return { buckets, plan, job: jobs?.read() ?? null, stale, accountStale: account.stale, userId };
    };

    const workingDeal = (): string | null => deps.engine!.store.listPairs({ activeOnly: true })[0]?.id ?? null;

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
      const query = (req.query ?? {}) as { direction?: unknown; amount?: unknown };
      const { buckets, plan, job, stale } = await loadView(false, directionOf(query.direction), requestedOf(query.amount));
      return reply.ok({ buckets, plan, job }, { stale });
    });

    app.post('/rebalance', async (req, reply) => {
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) {
        return reply.code(403).send({
          ok: false,
          error: {
            category: 'validation',
            label: 'DISCLAIMER_NOT_ACCEPTED',
            message: 'You must accept the disclaimer before placing any order.',
            retryable: false,
          },
        });
      }
      const store = requireJobs();
      const busy = busyJob(store);
      if (busy) return conflict(reply, `rebalance ${busy.id} is ${busy.status}`);
      const working = workingDeal();
      if (working) return conflict(reply, `deal ${working} is still working`);
      const body = (req.body ?? {}) as { direction?: unknown; amount?: unknown; route?: unknown };
      const direction = directionOf(body.direction);
      const { plan, accountStale, userId } = await loadView(true, direction, requestedOf(body.amount));
      // The amount is sized from this read. A read served from the cache
      // because Gate rate-limited the fresh one may be seconds old, and a
      // move to USDT sized on old equity can open the borrow it promises not to.
      if (accountStale) return conflict(reply, 'Gate is rate-limiting the account read. Try again in a few seconds.');
      if (typeof body.route === 'string' && body.route !== plan.route) {
        return conflict(reply, `plan changed: now ${plan.route ?? 'no route'}`);
      }
      if (!plan.route) return conflict(reply, 'no route');
      if (!(plan.amount > 0)) return conflict(reply, 'nothing to move');
      // Both checks again: the reads above took time, and a second POST or a
      // deal can have started during them.
      const again = busyJob(store);
      if (again) return conflict(reply, `rebalance ${again.id} is ${again.status}`);
      const started = workingDeal();
      if (started) return conflict(reply, `deal ${started} is still working`);
      const job = newJob(direction, plan.route, plan.amount, now(), userId);
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
      const working = workingDeal();
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
