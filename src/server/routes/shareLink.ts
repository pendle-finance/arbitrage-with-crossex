import type { FastifyInstance } from 'fastify';
import { createShareShortLink, resolveBorosFetch } from '../../core/boros/client';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

/** Same cheap gate the backend applies — reject junk locally instead of
 * spending a round-trip on it. Real payloads are ~600-900 chars. */
const BASE64URL_RE = /^[A-Za-z0-9_-]{1,4096}$/;

/**
 * POST /api/share-link — turn a long share payload into a short code.
 *
 * The browser cannot call the Boros backend itself (its CORS allowlist has no
 * localhost origin), so this server forwards the payload and hands the code
 * back. Content-addressed on the backend: re-sharing the same position is a
 * cache-friendly no-op, so the code rides the TTL cache — a modal reopened
 * within the window costs nothing. Any upstream failure surfaces as the usual
 * error envelope; the modal treats that as "no short link" and keeps the long
 * `?d=` URL, which always works.
 */
export function shareLinkRoutes(deps: AppDeps) {
  const fetchImpl = resolveBorosFetch(deps.borosFetch);
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.post('/share-link', async (req, reply) => {
      const d = (req.body as Record<string, unknown> | null)?.d;
      if (typeof d !== 'string' || !BASE64URL_RE.test(d)) {
        throw new CoreError('share-link needs a base64url `d` payload', 'validation');
      }
      const { value } = await deps.cache.get(`share-link:${d}`, TTL.shareLink, () =>
        createShareShortLink(fetchImpl, d),
      );
      return reply.ok(value);
    });
  };
}
