import type { FastifyInstance } from 'fastify';
import type { FetchLike } from '../../core/boros/client';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { refuse } from '../errorReply';
import { LOCK_TEXT } from '../rebalanceJob';
import { startUpdate, updateProgress } from '../updater';
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
        latestCommit: updateAvailable && remote ? remote.commit : null,
        updateAvailable,
        // Highlights only when they describe a version the user doesn't have.
        highlights: updateAvailable && remote ? remote.highlights : [],
      });
    });

    /**
     * GET /api/version/update/log — what the installer has printed so far.
     *
     * The dialog used to say "this takes a few minutes" and then show nothing
     * for those minutes, which is indistinguishable from a stuck update. The
     * installer names each step it starts, so the panel can name it too.
     */
    app.get('/version/update/log', async (_req, reply) => reply.ok(updateProgress()));

    app.post('/version/update', async (_req, reply) => {
      if ((deps.engine?.store.listPairs({ activeOnly: true }).length ?? 0) > 0) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'a deal is still working — wait for it to finish, then update',
          retryable: true,
        });
      }
      if (deps.rebalance?.jobs.read()?.status === 'running') {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'a rebalance is still running. Wait for it to finish, then update.',
          retryable: true,
        });
      }
      if (deps.transfer?.jobs.read()?.status === 'moving') {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: `${LOCK_TEXT.moving} Wait for it to end, then update.`,
          retryable: true,
        });
      }
      if (borosExecutionsPending() > 0) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'a Boros order may still be settling — wait a few minutes, then update',
          retryable: true,
        });
      }
      if (!deps.install) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'this is a source checkout, not an installed copy — update it with git',
          retryable: false,
        });
      }

      let pin: string | null = null;
      if (deps.updateCheck?.current && !deps.updateCheck.disabled) {
        const { value } = await deps.cache.get('version:latest', TTL.version, () =>
          fetchLatestVersion(fetchImpl),
        );
        pin = value?.commit ?? null;
      }

      // Windows stages the installer to disk before the task is created, so
      // this can fail on a bad download — which belongs in the dialog the user
      // is looking at, not in a log they would have to go find.
      let logPath: string;
      try {
        logPath = await startUpdate(pin);
      } catch (err) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: `could not start the update: ${(err as Error).message}`,
          retryable: true,
        });
      }
      return reply.ok({ started: true, logPath, ref: pin });
    });
  };
}
