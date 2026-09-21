import type { FastifyInstance } from 'fastify';
import type { MarginTiers } from '../../../web/src/lib/liquidation';
import { loadMarginTiers } from '../../core/marginTiers';
import { rememberMarks } from '../../core/marks';
import { computeExposure } from '../../core/positions';
import type { AppDeps } from '../app';
import { TTL, type TtlCache } from '../cache';

export async function marginTiersFor(
  cache: TtlCache,
  symbols: readonly string[],
  fresh: boolean,
): Promise<MarginTiers> {
  const wanted = [...new Set(symbols)].filter((s) => s.length > 0).sort();
  if (wanted.length === 0) return {};
  try {
    const { value } = await cache.get(`marginTiers:${wanted.join(',')}`, TTL.static, () => loadMarginTiers(wanted), {
      fresh,
    });
    return value;
  } catch {
    return {};
  }
}

export function positionsRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/positions', async (req, reply) => {
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      const { value, stale } = await deps.cache.get(
        'positions',
        TTL.live,
        async () => (await deps.getClients().crossEx.listCrossexPositions()).body,
        { fresh },
      );
      const { rows } = rememberMarks(value ?? []);
      const marginTiers = await marginTiersFor(
        deps.cache,
        rows.map((r) => r.symbol ?? ''),
        fresh,
      );
      return reply.ok({ positions: rows, exposure: computeExposure(rows), marginTiers }, { stale });
    });
  };
}
