import type { FastifyInstance } from 'fastify';
import type { FetchLike } from '../../core/boros/client';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { refuse } from '../errorReply';
import { LOCK_TEXT } from '../rebalanceJob';
import { isUpdating, startUpdate, updateProgress } from '../updater';
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
const FORCED_GAP_MS = 5 * 60_000;

export function versionRoutes(deps: AppDeps) {
  const fetchImpl: FetchLike = deps.versionFetch ?? (globalThis.fetch as unknown as FetchLike);
  /** When `?fresh=1` last read GitHub. GitHub allows 60 unauthenticated API
   * reads an hour per IP, and its raw file server caches version.json for 5
   * minutes, so a forced read sooner than that would spend reads for nothing. */
  let forcedAt = 0;
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/version', async (req, reply) => {
      const current = deps.updateCheck?.current ?? null;
      const checkOn = current !== null && !deps.updateCheck?.disabled;
      let remote: RemoteVersion | null = null;
      let freshRead: 'ok' | 'failed' | 'skipped' | null = null;
      if (checkOn) {
        const fresh = (req.query as { fresh?: string } | undefined)?.fresh === '1';
        if (fresh && Date.now() - forcedAt < FORCED_GAP_MS) freshRead = 'skipped';
        else if (fresh) {
          forcedAt = Date.now();
          // A failed read throws, so the cache keeps its last good answer.
          // Caching the null would hide an available update for 6 hours.
          try {
            remote = (
              await deps.cache.get(
                'version:latest',
                TTL.version,
                async () => {
                  const read = await fetchLatestVersion(fetchImpl);
                  if (read === null) throw new Error('GitHub version read failed');
                  return read;
                },
                { fresh: true },
              )
            ).value;
            freshRead = 'ok';
          } catch {
            freshRead = 'failed';
          }
        }
        remote ??= (
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
        checkOn,
        freshRead,
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
      if (isUpdating()) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'An update is already running. Wait for it to finish.',
          retryable: true,
        });
      }
      if ((deps.engine?.store.listPairs({ activeOnly: true }).length ?? 0) > 0) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'A deal is still running. Wait for it to finish, then update.',
          retryable: true,
        });
      }
      if (deps.rebalance?.jobs.read()?.status === 'running') {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'A rebalance is still running. Wait for it to finish, then update.',
          retryable: true,
        });
      }
      if (deps.transfer?.jobs.read()?.status === 'moving') {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: `${LOCK_TEXT.moving} Wait for it to finish, then update.`,
          retryable: true,
        });
      }
      if (borosExecutionsPending() > 0) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'A Boros order may still be settling. Wait a few minutes, then update.',
          retryable: true,
        });
      }
      if (!deps.install) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'This is a source checkout, not an installed copy. Update it with git.',
          retryable: false,
        });
      }
      if (deps.updateCheck?.disabled) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: 'In-app update is off on this install (UPDATE_CHECK=0). Update with the install command.',
          retryable: false,
        });
      }

      let pin: string | null = null;
      if (deps.updateCheck?.current && !deps.updateCheck.disabled) {
        const readCommit = async (): Promise<string | null> => {
          const { value } = await deps.cache.get('version:latest', TTL.version, () =>
            fetchLatestVersion(fetchImpl),
          );
          return value?.commit ?? null;
        };
        pin = await readCommit();
        if (!pin) {
          deps.cache.bust('version:latest');
          pin = await readCommit();
        }
        if (!pin) {
          deps.cache.bust('version:latest');
          return refuse(reply, {
            code: 409,
            category: 'validation',
            message:
              'could not read the release commit from GitHub. Try again in a minute, or choose "Run it in my terminal".',
            retryable: true,
          });
        }
      }

      // Both platforms download the installer before the update starts, so
      // this can fail on a bad download — which belongs in the dialog the user
      // is looking at, not in a log they would have to go find.
      let logPath: string;
      try {
        logPath = await startUpdate(pin);
      } catch (err) {
        return refuse(reply, {
          code: 409,
          category: 'validation',
          message: `Could not start the update: ${(err as Error).message}`,
          retryable: true,
        });
      }
      return reply.ok({ started: true, logPath, ref: pin });
    });
  };
}
