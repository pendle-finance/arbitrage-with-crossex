/**
 * Deal routes — one of the app's two execution surfaces (engine). The other
 * is the rebalance runner (src/server/rebalanceRunner.ts). The route layer
 * never touches venue-mutating endpoints itself: creation writes an intent row
 * the reconcile loop picks up on its next tick; commands are one-row intent
 * edits (levels, not events).
 */
import type { FastifyInstance } from 'fastify';
import type { VenueFeeRow } from '../../core/estimate/fees';
import { COIN_NOT_SUPPORTED_TEXT, isSupportedCoin } from '../../core/coins';
import { CoreError, type ErrorCategory } from '../../core/errors';
import { formatRestPrice, parseSymbol } from '../../core/numbers';
import { setLeverage } from '../../core/orders';
import { LIMIT_NOTE } from '../../core/positionLimit';
import { takerAfterCapSec } from '../../core/twap';
import { resolveDeal, type DealRequest } from '../../engine/create';
import type { Store } from '../../engine/db';
import { project } from '../../engine/decide';
import { commands } from '../../engine/loop';
import type { PairRow } from '../../engine/types';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { DISCLAIMER_NOT_ACCEPTED, isDisclaimerAccepted } from '../disclaimer';
import { refuse } from '../errorReply';
import { perpLimitBreach } from '../perpLimit';
import { dealLockFor, isChildOf, isGapChildOf, type Job } from '../rebalanceJob';
import { cachedTradesOf, feeReadWithin, feeRowsWithin } from '../dealFees';
import { feesOf, repegRefusalOf } from '../twapRun';
import { positionLimitFor } from './leverage';
import { autoMakerLeg, readChildFees } from './rebalance';

const TRANSFER_SETTLE_MS = 5_000;
const TRANSFER_SETTLING_TEXT = 'Deals wait until Gate takes the transfer. Try again in a few seconds.';

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export type DealBody = Omit<DealRequest, 'makerLeg'> & {
  makerLeg?: 'auto' | 'a' | 'b';
  leverage?: { a?: number; b?: number };
};

export interface DealRefusal {
  code: number;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
}

export type DealOutcome = { id: string; duplicate?: true } | { refusal: DealRefusal };

const busyRefusal = (message: string): { refusal: DealRefusal } => ({
  refusal: { code: 409, category: 'validation', message, retryable: true },
});

const currentJob = (deps: AppDeps): Job | null => deps.rebalance?.jobs.read() ?? null;

function rebalanceLockFor(deps: AppDeps, dealId: string, what: string): string | null {
  const job = currentJob(deps);
  if (job?.kind === 'twap') {
    const childLive = deps.engine!.store.listPairs({ activeOnly: true }).some((pair) => isChildOf(job.id, pair.id));
    return dealLockFor({ rebalance: job, dealId, childLive });
  }
  if (!job || isChildOf(job.id, dealId) || isGapChildOf(job.id, dealId)) return null;
  const blocks = job.status === 'running' || (job.status === 'halted' && job.paused);
  return blocks ? `A rebalance is still running. Wait for it to finish, then ${what}.` : null;
}

function childCapped(deps: AppDeps, body: DealBody): DealBody {
  const job = currentJob(deps);
  if (job?.kind !== 'twap' || !job.twap || !isChildOf(job.id, body.id)) return body;
  const cap = takerAfterCapSec(job.twap.intervalSec);
  const asked = body.deadlineCapSec === undefined ? cap : Number(body.deadlineCapSec);
  return { ...body, deadlineCapSec: Number.isFinite(asked) ? Math.min(asked, cap) : cap };
}

async function withMakerLeg(deps: AppDeps, body: DealBody): Promise<DealRequest> {
  const { makerLeg, ...rest } = body;
  if (makerLeg !== 'auto') return { ...rest, ...(makerLeg === undefined ? {} : { makerLeg }) };
  if (!body.b) return rest;
  return { ...rest, makerLeg: await autoMakerLeg(deps, body.a, body.b, body.qty) };
}

function repegOnAgain(deps: AppDeps, pair: PairRow): number | null {
  const job = currentJob(deps);
  if (job?.kind === 'twap' && job.twap && isChildOf(job.id, pair.id)) return job.twap.repegBehindBp;
  return pair.repegAutoBp;
}

const transferMoving = (deps: AppDeps): boolean => deps.transfer?.jobs.read()?.status === 'moving';

function transferSettling(deps: AppDeps): boolean {
  const transfer = deps.transfer?.jobs.read() ?? null;
  if (transfer?.status !== 'moving') return false;
  return transfer.acceptedAt === null || deps.engine!.clock.now() - transfer.acceptedAt < TRANSFER_SETTLE_MS;
}

function liveCloseOn(deps: AppDeps, row: PairRow): string | null {
  const closing = (p: PairRow): string[] =>
    [p.a, p.b].filter((l): l is NonNullable<typeof l> => !!l && l.reduceOnly === true).map((l) => l.contract);
  const mine = closing(row);
  if (mine.length === 0) return null;
  const busy = new Set(deps.engine!.store.listPairs({ activeOnly: true }).flatMap(closing));
  return mine.find((c) => busy.has(c)) ?? null;
}

export async function createDeal(deps: AppDeps, raw: DealBody): Promise<DealOutcome> {
  if (!raw?.id) throw new CoreError('deal id is required');
  if (deps.engine!.store.getPair(raw.id)) return { id: raw.id, duplicate: true };
  const legSymbols = [raw.a?.symbol, raw.b?.symbol].filter((s): s is string => Boolean(s));
  if (legSymbols.some((s) => !isSupportedCoin(parseSymbol(s).base))) {
    return { refusal: { code: 400, category: 'symbol-invalid', message: COIN_NOT_SUPPORTED_TEXT, retryable: false } };
  }
  const locked = rebalanceLockFor(deps, raw.id, 'start the deal');
  if (locked) return busyRefusal(locked);
  if (transferSettling(deps)) return busyRefusal(TRANSFER_SETTLING_TEXT);
  const body = await withMakerLeg(deps, childCapped(deps, raw));
  const clients = deps.getClients();
  const getAccount = async () =>
    (
      await deps.cache.get('account', TTL.live, async () => (await clients.crossEx.getCrossexAccount()).body, {
        fresh: transferMoving(deps),
      })
    ).value;
  const getPositions = async (fresh = false) =>
    (
      await deps.cache.get('positions', TTL.live, async () => (await clients.crossEx.listCrossexPositions()).body, {
        fresh,
      })
    ).value ?? [];
  const refPriceA =
    body.execution === 'taker' && body.a?.symbol
      ? await deps.engine!.venue.refPrice(body.a.symbol.toUpperCase()).catch(() => null)
      : null;
  const row = await resolveDeal(clients, body, deps.engine!.clock.now(), {
    preflight: { getAccount, getPositions },
    refPriceA,
  });

  const legs = [
    { leg: row.a, lev: body.makerLeg === 'b' ? body.leverage?.b : body.leverage?.a },
    ...(row.b ? [{ leg: row.b, lev: body.makerLeg === 'b' ? body.leverage?.a : body.leverage?.b }] : []),
  ];
  const levs = legs.filter((l) => l.lev).map((l) => ({ contract: l.leg.contract, lev: l.lev }));

  for (const { contract, lev } of levs) {
    if (typeof lev !== 'number' || !Number.isFinite(lev)) {
      throw new CoreError(`leverage for ${contract} must be a number`, 'validation');
    }
    const limit = await positionLimitFor(deps, contract, false);
    if (lev < 1 || lev > limit.leverage) {
      throw new CoreError(`Leverage ${lev}x must be between 1 and ${limit.leverage}x for ${contract}`, 'leverage');
    }
  }

  const reopensClosedSize = row.b !== null && row.a.reduceOnly === true && row.a.contract === row.b.contract;
  const breach = await perpLimitBreach(
    deps,
    legs.filter(({ leg }) => !leg.reduceOnly && !reopensClosedSize).map(({ leg }) => ({ contract: leg.contract, side: leg.side, qty: Number(row.targetQty) })),
    { fresh: true },
  );
  if (breach?.reason === 'no-price') {
    throw new CoreError(`No price for ${breach.contract} to check the position size. Nothing was sent. Try again.`, 'leverage');
  }
  if (breach) {
    throw new CoreError(
      `This deal takes ${breach.contract} to ${usd(breach.afterUsd)}, above its limit of ${usd(breach.maxUsd)} (${LIMIT_NOTE}). Nothing was sent.`,
      'leverage',
    );
  }

  const applied: Array<{ contract: string; prev: number }> = [];
  const readLeverage = async (contract: string): Promise<number> => {
    const { body: cur } = await clients.crossEx.getCrossexPositionsLeverage({ symbols: contract });
    return Number((cur as Record<string, unknown> | undefined)?.[contract] ?? 0);
  };
  const restoreLeverage = async () => {
    for (const { contract, prev } of applied.reverse()) {
      if (!Number.isFinite(prev) || prev < 1) continue;
      await setLeverage(clients.crossEx, contract, prev).catch(() => undefined);
    }
  };
  try {
    for (const { contract, lev } of levs) {
      const prev = await readLeverage(contract).catch(() => 0);
      const set = await setLeverage(clients.crossEx, contract, lev as number);
      applied.push({ contract, prev });
      const replied = Number(set?.leverage);
      const confirmed = replied > 0 ? replied : await readLeverage(contract);
      if (!(confirmed >= (lev as number))) {
        throw new CoreError(`CrossEx set ${contract} to ${confirmed}x, not the ${lev}x asked`, 'leverage');
      }
    }
  } catch (err) {
    await restoreLeverage();
    throw new CoreError(`Couldn't set leverage, so nothing was sent: ${(err as Error).message}`);
  }

  const lockedNow = rebalanceLockFor(deps, raw.id, 'start the deal');
  if (lockedNow) {
    await restoreLeverage();
    return busyRefusal(lockedNow);
  }
  if (transferSettling(deps)) {
    await restoreLeverage();
    return busyRefusal(TRANSFER_SETTLING_TEXT);
  }
  const busy = liveCloseOn(deps, row);
  if (busy) {
    await restoreLeverage();
    return busyRefusal(`A close on ${busy} is still running. Wait for it to finish or stop it, then try again.`);
  }
  if (deps.engine!.store.getPair(row.id)) return { id: row.id, duplicate: true };
  deps.engine!.store.createPair(row);
  deps.cache.bust('account');
  deps.engine!.wake?.();
  return { id: row.id };
}

type DealFees = { rows: VenueFeeRow[]; read: Record<string, number> };

async function dealFeesFor(deps: AppDeps, pairs: PairRow[]): Promise<DealFees> {
  const [rows, read] = await Promise.all([
    feeRowsWithin(deps),
    feeReadWithin(deps, {
      kind: 'read',
      work: () => readChildFees(deps.engine!.store, cachedTradesOf(deps), pairs.map((pair) => pair.id)),
      fallback: {} as Record<string, number>,
    }),
  ]);
  return { rows, read };
}

function dealView(store: Store, pair: PairRow, fees: DealFees) {
  const orders = store.listOrders(pair.id);
  const resolved = orders.flatMap((order) => (order.resolvedAt === null ? [] : [order.resolvedAt]));
  return {
    pair,
    orders,
    projection: project(pair, orders),
    fees: feesOf(
      [{ pair, orders, feeUsd: Object.hasOwn(fees.read, pair.id) && Number.isFinite(fees.read[pair.id]) ? fees.read[pair.id] : null }],
      fees.rows,
    ),
    avgPrice: { a: store.avgFillPrice(pair.id, 'A'), b: store.avgFillPrice(pair.id, 'B') },
    endedAt: pair.mode === 'DONE' && resolved.length > 0 ? Math.max(...resolved) : null,
    repegRefused: pair.mode === 'OPENING' && repegRefusalOf(orders) ? parseSymbol(pair.a.contract).exchange : null,
  };
}

export function dealsRoutes(deps: AppDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.post('/deals', async (req, reply) => {
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) return reply.code(403).send(DISCLAIMER_NOT_ACCEPTED);
      const outcome = await createDeal(deps, req.body as DealBody);
      if ('refusal' in outcome) return refuse(reply, outcome.refusal);
      return reply.code(202).ok(outcome.duplicate ? { id: outcome.id, duplicate: true } : { id: outcome.id });
    });

    app.get('/deals', async (req, reply) => {
      const q = req.query as { active?: string; limit?: string };
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
      const rows = deps.engine!.store
        .listPairs(q.active === '1' ? { activeOnly: true } : undefined)
        .slice(-limit)
        .reverse();
      const fees = await dealFeesFor(deps, rows);
      return reply.ok(rows.map((p) => dealView(deps.engine!.store, p, fees)));
    });

    app.get('/deals/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const pair = deps.engine!.store.getPair(id);
      if (!pair) throw new CoreError(`unknown deal ${id}`);
      return reply.ok(dealView(deps.engine!.store, pair, await dealFeesFor(deps, [pair])));
    });

    const requireDeal = (id: string): PairRow => {
      const pair = deps.engine!.store.getPair(id);
      if (!pair) throw new CoreError(`unknown deal ${id}`);
      return pair;
    };

    app.post('/deals/:id/convert', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode !== 'OPENING') {
        throw new CoreError(`deal ${pair.id} is not awaiting a maker fill (mode: ${pair.mode})`);
      }
      commands.convertNow(deps.engine!.store, pair.id);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, mode: 'CONVERTING' });
    });

    app.post('/deals/:id/repeg', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode !== 'OPENING') {
        throw new CoreError(`deal ${pair.id} is not awaiting a maker fill (mode: ${pair.mode})`);
      }
      const body = (req.body ?? {}) as { price?: unknown };
      // An explicit price PINS the deal (pricePolicy 'fixed'). Without that, a
      // 'touch' pair — the default for every maker-hedge pair ticket — re-derives
      // its price from the live book on the next placement, so this route used to
      // return 200 echoing the user's number while the engine re-placed at
      // whatever the market had moved to. The UI's own two buttons say exactly
      // this: "at YOUR price" vs "at the fresh same-side touch".
      const explicit = body.price !== undefined && body.price !== null && String(body.price).trim() !== '';
      const repegBehindBp = explicit ? null : repegOnAgain(deps, pair);
      let price: string | null;
      if (explicit) {
        const n = Number(body.price);
        if (!Number.isFinite(n) || n <= 0) {
          throw new CoreError(`re-peg price "${String(body.price)}" is not a positive number`, 'validation');
        }
        // Snap to the venue tick, away from crossing — this price is going to REST.
        price = formatRestPrice(n, pair.a.side, pair.a.contract, pair.a.tick);
        if (!(Number(price) > 0)) {
          throw new CoreError(`re-peg price ${n} is below one tick (${pair.a.tick})`, 'validation');
        }
      } else {
        const { venue } = deps.engine!;
        const { contract, side, tick } = pair.a;
        price = repegBehindBp === null ? await venue.touch(contract, side, tick) : await venue.best(contract, side, tick);
      }
      if (!price) throw new CoreError('no fresh touch price available — re-peg aborted (book unavailable)');
      commands.repeg(deps.engine!.store, pair.id, price, explicit ? 'fixed' : 'touch');
      if (repegBehindBp !== pair.repegBehindBp) deps.engine!.store.updatePair(pair.id, { repegBehindBp });
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, price });
    });

    app.post('/deals/:id/stop', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode === 'DONE') throw new CoreError(`deal ${pair.id} is already done`);
      commands.stop(deps.engine!.store, pair.id);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, mode: 'STOPPING' });
    });

    app.post('/deals/:id/resume', async (req, reply) => {
      const pair = requireDeal((req.params as { id: string }).id);
      if (pair.mode !== 'HALTED') throw new CoreError(`deal ${pair.id} is not halted (mode: ${pair.mode})`);
      const locked = rebalanceLockFor(deps, pair.id, 'resume the deal');
      if (locked) return refuse(reply, busyRefusal(locked).refusal);
      commands.resumeAfterHalt(deps.engine!.store, pair.id);
      deps.engine!.wake?.();
      return reply.ok({ id: pair.id, mode: 'STOPPING' });
    });

    app.get('/alerts', async (req, reply) => {
      const q = req.query as { unacked?: string };
      return reply.ok(deps.engine!.store.listAlerts(q.unacked === '1' ? { unackedOnly: true } : undefined));
    });

    app.post('/alerts/:id/ack', async (req, reply) => {
      deps.engine!.store.ackAlert(Number((req.params as { id: string }).id));
      return reply.ok({ acked: true });
    });
  };
}
