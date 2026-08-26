/**
 * Deal routes — the app's ONLY execution surface (engine). The route layer
 * never touches venue-mutating endpoints itself: creation writes an intent row
 * the reconcile loop picks up on its next tick; commands are one-row intent
 * edits (levels, not events).
 */
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { formatRestPrice } from '../../core/numbers';
import { setLeverage } from '../../core/orders';
import { resolveDeal, type DealRequest } from '../../engine/create';
import { project } from '../../engine/decide';
import { commands } from '../../engine/loop';
import type { PairRow } from '../../engine/types';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { isDisclaimerAccepted } from '../disclaimer';
import { leverageMaxFor } from './leverage';

// deps.engine is non-null here: the deals routes are registered only when the
// engine exists (never in the credential-free public mode — see buildApp).
function dealView(deps: AppDeps, pair: PairRow) {
  const orders = deps.engine!.store.listOrders(pair.id);
  return { pair, orders, projection: project(pair, orders) };
}

export function dealsRoutes(deps: AppDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.post('/deals', async (req, reply) => {
      // First-run gate: no real order until the disclaimer is accepted. Tied to
      // the config-backed credentials service (always present in a real install;
      // absent in unit tests, which skip the gate). The UI shows the modal
      // proactively; this 403 is the backstop against a direct API call.
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
      const body = req.body as DealRequest & { leverage?: { a?: number; b?: number } };
      if (!body?.id) throw new CoreError('deal id is required');
      // Idempotency: the client id is the dedup key — a lost-response retry
      // must never create a second deal.
      if (deps.engine!.store.getPair(body.id)) {
        return reply.code(202).ok({ id: body.id, duplicate: true });
      }
      const clients = deps.getClients();
      const getAccount = async () =>
        (await deps.cache.get('account', TTL.live, async () => (await clients.crossEx.getCrossexAccount()).body)).value;
      // Shares the `positions` cache key with GET /positions (the UI polls it every 4s),
      // so the preflight's netting read is normally already warm.
      const getPositions = async () =>
        (await deps.cache.get('positions', TTL.live, async () => (await clients.crossEx.listCrossexPositions()).body)).value ?? [];
      const refPriceA =
        body.execution === 'taker' && body.a?.symbol
          ? await deps.engine!.venue.refPrice(body.a.symbol.toUpperCase()).catch(() => null)
          : null;
      const row = await resolveDeal(clients, body, deps.engine!.clock.now(), {
        preflight: { getAccount, getPositions },
        refPriceA,
      });

      // Leverage phase: applied BEFORE the intent exists — a failure aborts with
      // nothing created and nothing sent (mirrors the abort-pre-send semantics).
      const levs: Array<{ contract: string; lev: unknown }> = [];
      if (body.leverage?.a) levs.push({ contract: row.a.contract, lev: body.leverage.a });
      if (body.leverage?.b && row.b) levs.push({ contract: row.b.contract, lev: body.leverage.b });

      // Validate EVERY leg before touching the venue, with the same rules the
      // sibling PUT /leverage/:symbol enforces. These arrived as raw JSON: with
      // no checks, {a: true} silently set 1x and {a: '50'} set 50x (setLeverage
      // coerces with String(Number(...))), and an over-max value could be
      // CLAMPED by the venue while create.ts's preflight sized initial margin
      // against the number we asked for — under-reserving, which is exactly how
      // a hedge leg gets rejected for margin and leaves the other leg naked.
      for (const { contract, lev } of levs) {
        if (typeof lev !== 'number' || !Number.isFinite(lev)) {
          throw new CoreError(`leverage for ${contract} must be a number`, 'validation');
        }
        const leverageMax = await leverageMaxFor(deps, contract, false);
        if (lev < 1 || (leverageMax > 0 && lev > leverageMax)) {
          throw new CoreError(
            `leverage ${lev}x must be between 1 and ${leverageMax}x for ${contract}`,
            'leverage',
          );
        }
      }

      // Apply, remembering each leg's previous value so a partial application can
      // be undone. Without this, leg A's leverage stayed changed after leg B's
      // call failed and the request returned "nothing was created": a user with
      // an existing position would have had its liquidation price moved without
      // ever seeing it, on a deal that was never created.
      const applied: Array<{ contract: string; prev: number }> = [];
      try {
        for (const { contract, lev } of levs) {
          let prev = 0;
          try {
            const { body: cur } = await clients.crossEx.getCrossexPositionsLeverage({ symbols: contract });
            prev = Number((cur as Record<string, unknown> | undefined)?.[contract] ?? 0);
          } catch {
            /* can't read it → can't restore it; recorded as 0 and skipped below */
          }
          await setLeverage(clients.crossEx, contract, lev as number);
          applied.push({ contract, prev });
        }
      } catch (err) {
        for (const { contract, prev } of applied.reverse()) {
          if (!Number.isFinite(prev) || prev < 1) continue; // nothing trustworthy to restore
          try {
            await setLeverage(clients.crossEx, contract, prev);
          } catch {
            /* best-effort: the abort error below is the one the user must see */
          }
        }
        throw new CoreError(
          `aborted before creating the deal: leverage set failed — ${(err as Error).message}`,
        );
      }

      deps.engine!.store.createPair(row);
      deps.cache.bust('account');
      deps.engine!.wake?.(); // first placement happens now, not after the tick sleep
      return reply.code(202).ok({ id: row.id });
    });

    app.get('/deals', async (req, reply) => {
      const q = req.query as { active?: string; limit?: string };
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
      const rows = deps.engine!.store
        .listPairs(q.active === '1' ? { activeOnly: true } : undefined)
        .slice(-limit)
        .reverse();
      return reply.ok(rows.map((p) => dealView(deps, p)));
    });

    app.get('/deals/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const pair = deps.engine!.store.getPair(id);
      if (!pair) throw new CoreError(`unknown deal ${id}`);
      return reply.ok(dealView(deps, pair));
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
      let price: string | null;
      if (explicit) {
        const n = Number(body.price);
        if (!Number.isFinite(n) || n <= 0) {
          throw new CoreError(`re-peg price "${String(body.price)}" is not a positive number`, 'validation');
        }
        // Snap to the venue tick, away from crossing — this price is going to REST.
        price = formatRestPrice(n, pair.a.side, pair.a.contract, pair.a.tick);
      } else {
        price = await deps.engine!.venue.touch(pair.a.contract, pair.a.side, pair.a.tick);
      }
      if (!price) throw new CoreError('no fresh touch price available — re-peg aborted (book unavailable)');
      commands.repeg(deps.engine!.store, pair.id, price, explicit ? 'fixed' : 'touch');
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
