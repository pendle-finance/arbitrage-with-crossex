import type { FastifyPluginCallback } from 'fastify';
import type { ActionInput } from '../../core/actions';
import { CoreError } from '../../core/errors';
const MAX_ACTIONS = 20;
import { previewActions, previewTwap, TWAP_DEFAULT_INPUT } from '../../core/preview';
import type { VenueFeeRow } from '../../core/estimate/fees';
import type { TwapInput } from '../../core/twap';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { deepBookOf } from '../deepBook';

const TWAP_NUMBER_KEYS = ['durationSec', 'intervalSec', 'slices'] as const;

function twapInputOf(raw: unknown): TwapInput {
  if (raw === undefined || raw === null) return TWAP_DEFAULT_INPUT;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new CoreError('twap must be an object');
  const body = raw as Record<string, unknown>;
  const input: TwapInput = {};
  for (const key of TWAP_NUMBER_KEYS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CoreError(`twap.${key} must be a number`);
    input[key] = value;
  }
  const sliceQty = body.sliceQty;
  if (sliceQty !== undefined && sliceQty !== null) {
    if (typeof sliceQty !== 'string') throw new CoreError('twap.sliceQty must be a decimal string');
    input.sliceQty = sliceQty;
  }
  return Object.keys(input).length ? input : TWAP_DEFAULT_INPUT;
}

export function previewRoutes(deps: AppDeps): FastifyPluginCallback {
  return (app, _opts, done) => {
    // Zero side effects: full validation + sizing + fill/fee estimates.
    app.post('/preview', async (req, reply) => {
      const body = req.body as { actions?: ActionInput[]; twap?: unknown } | undefined;
      const actions = body?.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        throw new CoreError('body must be { actions: ActionInput[] } with at least one action');
      }
      if (actions.length > MAX_ACTIONS) throw new CoreError(`too many actions (max ${MAX_ACTIONS})`);
      const twapInput = twapInputOf(body?.twap);
      const clients = deps.getClients();
      // Same cache key/TTL as GET /api/fees — one Gate call serves both.
      const feeRows = await deps.cache.get<VenueFeeRow[]>('fees', TTL.static, async () => {
        const { body: rows } = await clients.crossEx.getCrossexFee();
        return rows ?? [];
      });
      const previews = await previewActions({ clients, feeRows: feeRows.value }, actions);
      const extras = await previewTwap({ feeRows: feeRows.value, book: (symbol) => deepBookOf(deps, symbol) }, previews, twapInput).catch(
        (err: unknown) => {
          if (err instanceof Error && err.message.startsWith('twap:')) throw new CoreError(err.message);
          throw err;
        },
      );
      return reply.ok({ previews, ...extras });
    });
    done();
  };
}
