import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { DISCLAIMER_VERSION, acceptedVersion, isDisclaimerAccepted, recordAcceptance } from '../disclaimer';
import type { AppDeps } from '../app';

/** GET /api/disclaimer — current version + whether it's been accepted.
 *  POST /api/disclaimer/accept { version } — records acceptance.
 *  Registered only off public mode (needs the config dir behind credentials). */
export function disclaimerRoutes(deps: AppDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const envPath = deps.credentials?.envPath;

    app.get('/disclaimer', async (_req, reply) =>
      reply.ok({
        version: DISCLAIMER_VERSION,
        // No config dir to persist to (shouldn't happen off public mode) ⇒
        // nothing to gate on, so report accepted.
        accepted: envPath ? isDisclaimerAccepted(envPath) : true,
        acceptedVersion: envPath ? acceptedVersion(envPath) : null,
      }),
    );

    app.post('/disclaimer/accept', async (req, reply) => {
      const { version } = (req.body ?? {}) as { version?: string };
      if (version !== DISCLAIMER_VERSION) {
        throw new CoreError('The disclaimer changed. Reload the page and accept it again.');
      }
      if (envPath) recordAcceptance(envPath);
      return reply.ok({ version: DISCLAIMER_VERSION, accepted: true, acceptedVersion: DISCLAIMER_VERSION });
    });
  };
}
