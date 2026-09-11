import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { commands } from '../../engine/loop';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

interface HistoryQuery {
  symbol?: string;
  page?: string;
  limit?: string;
  from?: string;
  to?: string;
  fresh?: string;
}

/**
 * Gate sends `reduceOnly` as the string "true"/"false" while `OpenOrder` types
 * it `boolean`, and this body reaches the web verbatim — so `"false"` was
 * truthy and every order wore the "RO" badge, opening ones included. Coerced
 * here because this is where venue JSON becomes our types. Gate's other
 * strings (`qty`, `price`, `leverage`) are declared as strings and only
 * rendered.
 */
export function normalizeOpenOrders(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  return body.map((o) => {
    if (o === null || typeof o !== 'object' || !('reduceOnly' in o)) return o;
    const raw = (o as { reduceOnly: unknown }).reduceOnly;
    // A real boolean passes through; anything else is read as the venue's text.
    const value = typeof raw === 'boolean' ? raw : String(raw).toLowerCase() === 'true';
    return { ...o, reduceOnly: value };
  });
}

/** Paging params with defaults; limit capped at Gate's 200. */
export function pageParams(q: { page?: string; limit?: string; from?: string; to?: string }): {
  page: number;
  limit: number;
  from?: number;
  to?: number;
} {
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit)) || 50));
  const from = q.from !== undefined ? Number(q.from) : undefined;
  const to = q.to !== undefined ? Number(q.to) : undefined;
  return { page, limit, from, to };
}

export function ordersRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/orders/open', async (req, reply) => {
      const q = req.query as { symbol?: string; fresh?: string };
      const { value, stale } = await deps.cache.get(
        `openOrders:${q.symbol ?? ''}`,
        TTL.live,
        async () =>
          normalizeOpenOrders(
            (
              await deps
                .getClients()
                .crossEx.listCrossexOpenOrders(q.symbol ? { symbol: q.symbol } : {})
            ).body,
          ),
        { fresh: q.fresh === '1' },
      );
      return reply.ok(value, { stale });
    });

    app.get('/orders/history', async (req, reply) => {
      const q = req.query as HistoryQuery;
      const { page, limit, from, to } = pageParams(q);
      const { body: orders } = await deps
        .getClients()
        .crossEx.listCrossexHistoryOrders({ page, limit, symbol: q.symbol, from, to });
      return reply.ok({ orders, page, limit, hasMore: orders.length === limit });
    });

    app.get('/orders/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { body } = await deps.getClients().crossEx.getCrossexOrder(id);
      return reply.ok(body);
    });

    app.delete('/orders/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      // Engine-owned orders are OFF LIMITS to the route layer. Two reasons, and
      // the second is the dangerous one:
      //
      //  1. The reconcile loop is the only writer of venue-mutating calls
      //     (docs/MAKER-HEDGE.md). A cancel from here happens outside the loop and
      //     outside the `orders` ledger, so cancel_requested is never set.
      //  2. Because cancel_requested stays 0, the venue reporting CANCELLED is
      //     decoded by decide() as "the user killed the maker on the exchange" =
      //     an explicit STOP, which by design outranks the deadline and
      //     PERMANENTLY relinquishes the remaining acquisition. A user tidying
      //     up the Open Orders table would silently abandon a half-filled
      //     two-leg entry, with no confirmation and no explanation.
      //
      // The deal's own Stop control does this properly, through the loop.
      //
      // ONE exception, added because the refusal was itself the bug for it: a
      // SINGLE resting limit order (no hedge leg) is a plain order in the
      // user's head — they placed it, they see it in this table, they cancel it
      // here. There is no second leg to strand, and "relinquish the rest" is
      // exactly what cancelling a limit order means. So instead of refusing, we
      // translate the hand-cancel into the deal's own Stop and let the loop do
      // the venue call — the single-writer rule holds, cancel_requested gets
      // set, and the deal finishes honestly with whatever had filled.
      const store = deps.engine?.store;
      /** A single-leg resting maker: no hedge to strand, so a hand cancel is safe. */
      const isPlainRestingOrder = (pairId: string): boolean => {
        const pair = store?.getPair(pairId);
        return !!pair && pair.b === null && pair.limitPrice !== null;
      };
      const refuse = (o: { pairId: string }): never => {
        throw new CoreError(
          `order ${id} belongs to deal ${o.pairId} and is managed by the engine — use that deal's Stop control instead of cancelling it by hand`,
          'validation',
        );
      };
      /** Refuse, UNLESS it is a plain resting order — then stop that deal. */
      const refuseOrStop = (o: { pairId: string }) => {
        if (!isPlainRestingOrder(o.pairId)) refuse(o);
        commands.stop(deps.engine!.store, o.pairId);
        deps.engine!.wake?.();
        deps.cache.bust('openOrders');
        return reply.ok({ id, dealId: o.pairId, cancelling: true });
      };
      // Matches EITHER identifier: the venue takes our client text on cancel
      // too, so a venue-id-only guard is bypassable by anyone reading it off
      // /api/deals or the venue's `text` on /api/orders/open.
      const owned = store?.findLiveEngineOrder(id);
      if (owned) return refuseOrStop(owned);
      // And the ledger can be blind: between a create whose outcome came back
      // 'unknown' and the read that confirms it, the order may be LIVE on the
      // venue while our row still has venue_order_id NULL. The engine cannot
      // shrink that window — on an 'unknown' create the id does not exist
      // client-side at all — so the guard has to cover it: ask the venue whose
      // order this id is, and refuse if the answer is one of ours. An
      // unreadable venue proves nothing, so that refuses too (fail closed);
      // it is also the moment a hand cancel would have failed anyway.
      if (store?.hasLiveOrderAwaitingVenueId()) {
        let text: string;
        try {
          const { body } = await deps.getClients().crossEx.getCrossexOrder(id);
          text = String((body as { text?: unknown })?.text ?? '');
        } catch {
          throw new CoreError(
            `cannot cancel ${id} right now: a running deal has an order awaiting venue confirmation, and the venue could not confirm ${id} is not that order — retry shortly, or stop the deal with its Stop control`,
            'validation',
          );
        }
        const byText = text ? store.findLiveEngineOrder(text) : null;
        if (byText) return refuseOrStop(byText);
      }
      const { body } = await deps.getClients().crossEx.cancelCrossexOrder(id);
      deps.cache.bust('openOrders');
      return reply.ok(body);
    });
  };
}
