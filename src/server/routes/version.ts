import type { FastifyInstance } from 'fastify';
import type { FetchLike } from '../../core/boros/client';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { startUpdate } from '../updater';
import { compareVersions, fetchLatestVersion, type RemoteVersion } from '../version';
import { borosExecutionsPending } from './borosPair';

/**
 * GET /api/version — is a newer release published on GitHub main?
 *
 * Always 200; never throws. The remote read happens lazily (first request),
 * only when the running copy KNOWS its own version and the check isn't
 * disabled — so an unconfigured `updateCheck` dep (every test app, public
 * mode) makes this route provably network-free. Failures are cached as null
 * for the full TTL: silent by design.
 *
 * POST /api/version/update — run the installer the pop-up shows. Refused (409)
 * while money is at stake or the tree is a source checkout; see the guards on
 * the handler.
 */
export function versionRoutes(deps: AppDeps) {
  const fetchImpl: FetchLike = deps.versionFetch ?? (globalThis.fetch as unknown as FetchLike);
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/version', async (_req, reply) => {
      const current = deps.updateCheck?.current ?? null;
      let remote: RemoteVersion | null = null;
      if (current !== null && !deps.updateCheck?.disabled) {
        remote = (
          await deps.cache.get('version:latest', TTL.version, () => fetchLatestVersion(fetchImpl))
        ).value;
      }
      const updateAvailable =
        remote !== null && current !== null && (compareVersions(remote.version, current) ?? 0) > 0;
      return reply.ok({
        current,
        install: deps.install ?? null,
        latest: remote?.version ?? null,
        updateAvailable,
        // Highlights only when they describe a version the user doesn't have.
        highlights: updateAvailable && remote ? remote.highlights : [],
      });
    });

    app.post('/version/update', async (_req, reply) => {
      const refuse = (message: string, retryable: boolean) =>
        reply.code(409).send({
          ok: false,
          error: { category: 'validation', message, retryable },
        });

      // The installer kills this server mid-flight, so anything the restart
      // cannot pick up again has to finish first.
      if ((deps.engine?.store.listPairs({ activeOnly: true }).length ?? 0) > 0) {
        return refuse('a deal is still working — wait for it to finish, then update', true);
      }
      // A restart empties the execution memo, and Boros has no venue-side client
      // order id, so a panel retry after one could double-fill a real order.
      if (borosExecutionsPending() > 0) {
        return refuse(
          'a Boros order may still be settling — wait a few minutes, then update',
          true,
        );
      }
      // install.sh has no checkout mode: it would lay a second copy down under
      // ~/.boros-crossex, and with BOROS_ROOT pointing here `swap_app` would
      // delete this tree, .git and uncommitted work included.
      if (!deps.install) {
        return refuse(
          'this is a source checkout, not an installed copy — update it with git',
          false,
        );
      }

      // No await above, so nothing can have started since the guards ran.
      return reply.ok({ started: true, logPath: startUpdate() });
    });
  };
}
