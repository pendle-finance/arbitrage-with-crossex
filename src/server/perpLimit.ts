/**
 * The perp position limit, judged for the legs a strategy is about to open.
 *
 * CrossEx refuses an order that takes a position past the symbol's largest
 * size, at any leverage, and it does so after the order call succeeds. Two
 * places ask: the deal that sends the perps, and the Boros step that commits
 * to them first — a Boros fill whose perps are then refused stands unhedged.
 */
import { heldQty } from '../core/orders';
import { breaksLimit } from '../core/positionLimit';
import { project } from '../engine/decide';
import type { AppDeps } from './app';
import { TTL } from './cache';
import { positionLimitFor } from './routes/leverage';

/** One perp order a plan will send: its size in base units, or in USD at the
 * reference price. */
export type PerpLegPlan = { contract: string; side: 'BUY' | 'SELL' } & ({ qty: number } | { notionalUsd: number });

export type PerpLimitBreach =
  | { contract: string; reason: 'no-price' }
  | {
      contract: string;
      reason: 'over';
      /** The position this plan leaves, in USD at the reference price. */
      afterUsd: number;
      /** The limit judged against: `share` of the terminal's max. */
      maxUsd: number;
      /** The most this leg can still add in its direction, in contracts' base units. */
      roomQty: number;
      priceUsd: number;
    };

/**
 * The first leg of `legs` that would break its limit, or null.
 *
 * It counts the position held, what active deals still mean to trade on the
 * contract, and any order resting there that no deal placed — CrossEx counts
 * resting orders. `share` scales the limit down for a plan that must leave
 * room for the price to move before the order goes out. `fresh` reads
 * positions and resting orders past their caches.
 */
export async function perpLimitBreach(
  deps: AppDeps,
  legs: readonly PerpLegPlan[],
  opts: { share?: number; fresh?: boolean } = {},
): Promise<PerpLimitBreach | null> {
  const share = opts.share ?? 1;
  const fresh = opts.fresh ?? false;
  const engine = deps.engine!;
  const clients = deps.getClients();
  const positions =
    (
      await deps.cache.get('positions', TTL.live, async () => (await clients.crossEx.listCrossexPositions()).body, {
        fresh,
      })
    ).value ?? [];
  const pendingQty = async (contract: string, side: 'BUY' | 'SELL'): Promise<number> => {
    let qty = 0;
    const ours = new Set<string>();
    for (const pair of engine.store.listPairs({ activeOnly: true })) {
      const orders = engine.store.listOrders(pair.id);
      for (const o of orders) ours.add(o.clientId);
      const p = project(pair, orders);
      const pursuing = pair.mode === 'OPENING' || pair.mode === 'CONVERTING';
      for (const [leg, filled, reserved] of [
        [pair.a, p.aFilled, p.aReserved],
        [pair.b, p.bFilled, p.bReserved],
      ] as const) {
        if (!leg || leg.reduceOnly || leg.contract !== contract || leg.side !== side) continue;
        qty += Math.max(0, Number(pursuing ? pair.targetQty : reserved) - Number(filled));
      }
    }
    const open =
      (
        await deps.cache.get(
          `openOrdersRaw:${contract}`,
          TTL.live,
          async () => (await clients.crossEx.listCrossexOpenOrders({ symbol: contract })).body,
          { fresh },
        )
      ).value ?? [];
    for (const o of open) {
      if (ours.has(String(o.text ?? '')) || o.side !== side || String(o.reduceOnly) === 'true') continue;
      qty += Math.max(0, Number(o.qty) - (Number(o.executedQty) || 0));
    }
    return qty;
  };
  for (const leg of legs) {
    const limit = await positionLimitFor(deps, leg.contract, false);
    const price = Number(await engine.venue.refPrice(leg.contract).catch(() => null));
    if (!(price > 0)) return { contract: leg.contract, reason: 'no-price' };
    const sign = leg.side === 'BUY' ? 1 : -1;
    const before = heldQty(positions, leg.contract) + sign * (await pendingQty(leg.contract, leg.side));
    const after = before + sign * ('qty' in leg ? leg.qty : leg.notionalUsd / price);
    const maxUsd = limit.maxUsd * share;
    const afterUsd = Math.abs(after) * price;
    if (breaksLimit(Math.abs(before) * price, afterUsd, { ...limit, maxUsd })) {
      return {
        contract: leg.contract,
        reason: 'over',
        afterUsd,
        maxUsd,
        roomQty: Math.max(0, maxUsd / price - sign * before),
        priceUsd: price,
      };
    }
  }
  return null;
}
