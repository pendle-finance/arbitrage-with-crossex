import type { FastifyInstance } from 'fastify';
import { createShareShortLink, resolveBorosFetch } from '../../core/boros/client';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

/** Same cheap gate the backend applies — reject junk locally instead of
 * spending a round-trip on it. Real payloads are ~600-900 chars. */
const BASE64URL_RE = /^[A-Za-z0-9_-]{1,4096}$/;
/** Mirrors the terminal's own address gate (web HomeControls, routes/strategy). */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
 *
 * The optional `address` is the sharer's tracked wallet, forwarded RAW next to
 * the payload (never encoded into it — the wire format has no address field and
 * the resulting link is public). The backend stores it beside the code so a
 * shared position can later be checked against what that wallet held. It also
 * takes part in the code's content address, so it is part of the cache key.
 */
export function shareLinkRoutes(deps: AppDeps) {
  const fetchImpl = resolveBorosFetch(deps.borosFetch);
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.post('/share-link', async (req, reply) => {
      const body = req.body as Record<string, unknown> | null;
      const d = body?.d;
      if (typeof d !== 'string' || !BASE64URL_RE.test(d)) {
        throw new CoreError('share-link needs a base64url `d` payload', 'validation');
      }
      // A malformed address DROPS rather than fails: the backend would 400 the
      // whole request, the modal would silently fall back to the long link, and
      // the user would lose the short link over a field they never see. Losing
      // the attribution is the smaller harm — and the terminal only ever stores
      // an address that already passed the same regex.
      const rawAddress = body?.address;
      const address =
        typeof rawAddress === 'string' && EVM_ADDRESS_RE.test(rawAddress)
          ? rawAddress.toLowerCase()
          : undefined;
      const { value } = await deps.cache.get(`share-link:${address ?? ''}:${d}`, TTL.shareLink, () =>
        createShareShortLink(fetchImpl, d, address),
      );
      return reply.ok(value);
    });
  };
}
