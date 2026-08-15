import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setClientTagContext } from '../../core/boros/client';
import { makeClients } from '../../core/clients';
import { classifyGateError, CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { restrictToOwner } from '../secretFile';

/**
 * Credentials: read masked status; replace keys with validate-before-commit.
 * PUT builds a CANDIDATE client and calls getCrossexAccount first — only a key
 * that actually works touches .env or the live client. The secret NEVER leaves
 * the process. Swapping mid-execution is refused (409): the engine would keep
 * polling orders placed by a key that may just have been revoked.
 */
export function credentialsRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/credentials', async (_req, reply) => {
      const key = process.env.GATE_API_KEY;
      const keyMasked = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null;
      return reply.ok({ configured: Boolean(key), keyMasked });
    });

    app.put('/credentials', async (req, reply) => {
      const svc = deps.credentials;
      if (!svc) throw new CoreError('credentials service not configured on this server');
      const body = req.body as { key?: string; secret?: string } | undefined;
      const key = body?.key?.trim();
      const secret = body?.secret?.trim();
      if (!key || !secret) throw new CoreError('body must be { key, secret } (non-empty strings)');

      // Refuse while ANY basket is executing OR still reconciling non-terminal/unknown
      // legs — a swap would point those background polls at the new account and could
      // falsely mark an old-account order 'rejected' (hiding a live unhedged leg).
      if (deps.engine!.store.listPairs({ activeOnly: true }).length > 0) {
        return reply.code(409).send({
          ok: false,
          error: {
            category: 'validation',
            message: 'a deal is still working — wait for it to finish before changing credentials',
            retryable: true,
          },
        });
      }

      // Validate with a candidate client; nothing is persisted on failure.
      const candidate = makeClients({ key, secret });
      let accountMode: string | undefined;
      try {
        const { body: account } = await candidate.crossEx.getCrossexAccount();
        accountMode = account.accountMode;
      } catch (err) {
        const classified = classifyGateError(err);
        return reply.code(401).send({
          ok: false,
          error: { ...classified, category: 'auth', hint: 'Gate rejected these credentials — check key, secret, and CrossEx permission.' },
        });
      }

      // Re-check busy() AFTER the validation await: an /execute (which reserve()s
      // synchronously before its first await, so it counts into busy() immediately)
      // or a maker-hedge tick could have started during validation. Committing now
      // would point its in-flight background polls at the new account and could
      // falsely mark an old-account order 'rejected', hiding a live unhedged leg.
      if (deps.engine!.store.listPairs({ activeOnly: true }).length > 0) {
        return reply.code(409).send({
          ok: false,
          error: {
            category: 'validation',
            message: 'a basket started while validating the new credentials — wait for it to finish and retry',
            retryable: true,
          },
        });
      }

      rewriteEnvFile(svc.envPath, { GATE_API_KEY: key, GATE_API_SECRET: secret }, svc.hardenConfigDir);
      process.env.GATE_API_KEY = key;
      process.env.GATE_API_SECRET = secret;
      svc.setClients(candidate);
      // This user is now "active" — tag subsequent Boros API traffic accordingly.
      // Credentials can only be added/replaced here, never removed, so there is
      // no active:false path.
      setClientTagContext({ active: true });
      deps.cache.bust(''); // every cached read may belong to the old account

      return reply.ok({ ok: true, accountMode });
    });
  };
}

/**
 * Replace (or append) the given KEY=value lines, preserving everything else.
 * Holds a live-money secret, so: create the dir 0700, write to a temp sibling at
 * mode 0600 then atomically rename over the target (a torn write can never truncate
 * the real .env), and re-assert 0600 in case the target pre-existed world-readable.
 */
export function rewriteEnvFile(
  envPath: string,
  entries: Record<string, string>,
  /** Tighten the containing DIRECTORY too — only for a real config dir; in a
   * source checkout that directory is the repo root (see the entry point). */
  hardenConfigDir = false,
): void {
  const dir = path.dirname(envPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // first run: config dir may not exist
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing.split('\n');
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && entries[m[1]] !== undefined) {
      done.add(m[1]);
      return `${m[1]}=${entries[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(entries)) {
    if (!done.has(k)) {
      while (out.length && out[out.length - 1] === '') out.pop();
      out.push(`${k}=${v}`);
    }
  }
  const text = out.join('\n');
  const body = text.endsWith('\n') ? text : text + '\n';
  const tmp = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, envPath); // atomic on the same filesystem
  // The renamed file keeps tmp's 0600 on POSIX; on Windows neither the mkdir
  // nor the writeFile mode did anything, so set the ACL explicitly here.
  if (hardenConfigDir) restrictToOwner(dir);
  restrictToOwner(envPath);
}
