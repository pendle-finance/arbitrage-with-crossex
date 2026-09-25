/**
 * GET /api/boros/rebate — the logged-in account's settlement-fee rebate config,
 * for the FORWARD numbers the terminal reprices client-side (opportunity APR,
 * current fixed APR). The realized amounts ride on the asset view instead,
 * joined per settlement.
 *
 * Returns null when this install holds no agent key, when the account is not
 * rebated, or when the backend read fails — the UI then hides every rebate
 * affordance and no math changes. Never throws: a rebate lookup must not break
 * the opportunities or asset views.
 */
import type { FastifyInstance } from 'fastify';
import type { RebateConfig } from '../../core/boros/rebateApi';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { currentRebateClient } from '../borosRebate';

/** The wire shape of GET /api/boros/rebate: the account's rebate config, or null
 * when there is none. Mirrors `RebateConfig`. */
export type RebateView = RebateConfig | null;

export function rebateRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/boros/rebate', async (req, reply) => {
      const client = currentRebateClient(deps);
      if (!client) return reply.ok(null);
      const fresh = (req.query as { fresh?: string } | undefined)?.fresh === '1';
      try {
        const { value } = await deps.cache.get(
          `boros:rebate:${process.env.BOROS_ROOT_ADDRESS?.toLowerCase() ?? ''}`,
          TTL.boros,
          async (): Promise<RebateView> => (await client.status()).rebate,
          { fresh },
        );
        return reply.ok(value);
      } catch {
        // Degrade to "no rebate" rather than surface an error the panel would
        // have to special-case — the account may simply not be rebated.
        return reply.ok(null);
      }
    });
  };
}
