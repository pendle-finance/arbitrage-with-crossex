/**
 * Fastify app factory (no listen — tests drive it via app.inject()).
 * Owns the localhost-only origin guard, the {ok,data,meta}/{ok,error} envelope,
 * and the error-category → HTTP-status mapping; routes stay thin.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { FetchLike } from '../core/boros/client';
import type { Clients } from '../core/clients';
import { classifyGateError, CoreError, type ClassifiedError } from '../core/errors';
import type { Store } from '../engine/db';
import type { Clock, VenuePort } from '../engine/types';
import type { TtlCache } from './cache';
import { accountRoutes } from './routes/account';
import { booksRoutes } from './routes/books';
import { credentialsRoutes } from './routes/credentials';
import { dealsRoutes } from './routes/deals';
import { disclaimerRoutes } from './routes/disclaimer';
import { feesRoutes } from './routes/fees';
import { healthRoutes } from './routes/health';
import { leverageRoutes } from './routes/leverage';
import { opportunitiesRoutes } from './routes/opportunities';
import { registerPositionPage } from './position';
import { ordersRoutes } from './routes/orders';
import { positionsRoutes } from './routes/positions';
import { previewRoutes } from './routes/preview';
import { strategyRoutes } from './routes/strategy';
import { symbolsRoutes } from './routes/symbols';
import { versionRoutes } from './routes/version';
import { tradesRoutes } from './routes/trades';

export interface AppDeps {
  getClients(): Clients;
  cache: TtlCache;
  /**
   * Public read-only deployment (the landing site): register only the
   * credential-free market-view routes, accept non-localhost hosts (a reverse
   * proxy fronts the server), and ignore the fresh=1 cache bypass. Everything
   * that can read an account or move money is never registered — 404, not 401.
   */
  publicMode?: boolean;
  /** The execution engine's store + venue port + clock. Absent in public mode.
   * The route layer only writes intent rows / command levels; the reconcile loop
   * (started by the entry point, driven manually in tests) owns every venue
   * mutation. */
  engine?: {
    store: Store;
    venue: VenuePort;
    clock: Clock;
    /** Nudge the reconcile loop to run NOW (set by the entry point; absent in
     * tests, which drive tickPair manually). Commands and creates call it so
     * the user never waits out a tick sleep. */
    wake?: () => void;
  };
  /** Enables PUT /api/credentials (validate → rewrite .env → hot-swap the client). */
  credentials?: {
    envPath: string;
    /** Tighten the .env's PARENT directory too. False in a source checkout,
     * where that parent is the repo root (see the entry point). */
    hardenConfigDir?: boolean;
    setClients(clients: Clients): void;
  };
  /** The per-install API token every /api request must carry (except health).
   * Required unless publicMode — buildApp refuses to serve the trading API
   * unauthenticated rather than let a missing wire-up pass silently. */
  authToken?: string;
  /** Test seam for the Boros backend client (defaults to global fetch). */
  borosFetch?: FetchLike;
  /** Test seam for the GitHub update check (defaults to global fetch). */
  versionFetch?: FetchLike;
  /** What the installer recorded about this tree (null in a source checkout).
   * Echoed on GET /api/version so a user can see which commit they run. */
  install?: import('./version').InstallInfo | null;
  /** Update check, set by the entry point (never in public mode): the running
   * copy's version from <repoRoot>/version.json — null means "unknown", which
   * disables the remote read entirely — plus the UPDATE_CHECK=0 opt-out. */
  updateCheck?: { current: string | null; disabled?: boolean };
  /** The shared-position page (`/position?d=…` with server-injected OG meta).
   * Set by the entry point iff the dist contains position.html — the landing
   * build does, the terminal build doesn't. Credential-free by construction,
   * so it registers in BOTH modes (see src/server/position.ts). */
  positionPage?: { htmlPath: string };
}

declare module 'fastify' {
  interface FastifyReply {
    /** Success envelope: { ok: true, data, meta: { ts, stale? } }. */
    ok(data: unknown, opts?: { stale?: boolean }): FastifyReply;
  }
}

function statusFor(classified: ClassifiedError, err: unknown): number {
  switch (classified.category) {
    case 'validation':
    case 'symbol-invalid':
      return 400;
    case 'auth':
      // Preserve a genuine Gate 403 (permission/IP block) rather than flattening to 401.
      return classified.httpStatus === 403 ? 403 : 401;
    // Not the client's fault and not an auth rejection: the server has no keys yet.
    case 'not-configured':
      return 503;
    case 'rate-limited':
      return 429;
    case 'network':
      return 502;
    default: {
      const s = classified.httpStatus ?? (err as { statusCode?: number })?.statusCode;
      if (s && s >= 400 && s <= 599) return s;
      // CoreErrors are domain validation (e.g. 'leverage') — always the client's fault.
      return err instanceof CoreError ? 400 : 500;
    }
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  // Any localhost port is trusted (the Vite dev server proxies from its own port);
  // DNS-rebinding/CSRF attackers can reach 127.0.0.1 but can't forge a localhost
  // Host/Origin. No CORS headers are ever emitted.
  const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  // Public mode serves strangers by definition — the guard only protects a
  // credentialed localhost server from DNS-rebinding/CSRF, and no credentialed
  // route is registered in public mode.
  // Fail closed on a missing wire-up: an optional field that silently
  // disables authentication is exactly the regression this catches.
  if (!deps.publicMode && !deps.authToken) {
    throw new Error('authToken is required unless publicMode — refusing to serve the trading API unauthenticated');
  }
  const expectedTokenHash = deps.authToken
    ? createHash('sha256').update(deps.authToken).digest()
    : null;

  if (deps.publicMode) {
    // The public box serves strangers, but nothing on it is legitimately
    // framed either — and /position reflects (validated, escaped) stranger
    // input into HTML, so the browser-side walls cost nothing and stack:
    // no framing, no MIME sniffing, and no full-URL Referer (?d= carries the
    // shared numbers) on outbound navigation.
    app.addHook('onRequest', async (_req, reply) => {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    });
    // CDNs in front cache header-less responses; default everything to no-store.
    app.addHook('onSend', async (_req, reply, payload) => {
      if (!reply.getHeader('cache-control') && !reply.raw.getHeader('cache-control')) {
        reply.header('cache-control', 'no-store');
      }
      return payload;
    });
  } else {
    app.addHook('onRequest', async (req, reply) => {
      // The Host/Origin guard cannot stop framing: a page that iframes
      // http://localhost:6688 IS same-origin with /api, so its requests carry a
      // localhost Host and Origin and pass the check below. With no auth of any
      // kind, that leaves every single-click money action (Convert now, Stop)
      // clickjackable from any site the user happens to visit. Refuse to be
      // framed at all — the terminal is never legitimately embedded.
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");

      const host = req.headers.host;
      const origin = req.headers.origin;
      const hostOk = host !== undefined && LOCAL_HOST_RE.test(host);
      const originOk = origin === undefined || LOCAL_ORIGIN_RE.test(origin);
      if (!hostOk || !originOk) {
        return reply
          .code(403)
          .send({ ok: false, error: { category: 'auth', message: 'forbidden host/origin' } });
      }

      // The token gate. Scoped to /api DELIBERATELY: this hook runs before the
      // static plugin, and the page + assets are what DELIVER the token — a
      // broader check would 401 the very HTML that carries it.
      //
      // /api/health stays open: the installers poll it to decide whether the
      // service came up (install.sh hard-fails on it), and it exposes nothing.
      //
      // Hash both sides before timingSafeEqual: it throws on unequal lengths,
      // so comparing a raw attacker string would be a 500 — and hashing keeps
      // the comparison constant-time whatever length arrives.
      const pathname = req.url.split('?', 1)[0];
      if (expectedTokenHash && pathname.startsWith('/api/') && pathname !== '/api/health') {
        const given = req.headers['x-arb-token'];
        const ok =
          typeof given === 'string' &&
          timingSafeEqual(createHash('sha256').update(given).digest(), expectedTokenHash);
        if (!ok) {
          return reply.code(401).send({
            ok: false,
            error: {
              category: 'auth',
              message: 'missing or invalid API token',
              retryable: false,
              hint: 'Reload the page. Scripting the API? Send the x-arb-token header — see the README.',
            },
          });
        }
      }
    });
  }

  app.decorateReply('ok', function (this: FastifyReply, data: unknown, opts?: { stale?: boolean }) {
    const meta: { ts: number; stale?: boolean } = { ts: Date.now() };
    if (opts?.stale) meta.stale = true;
    return this.send({ ok: true, data, meta });
  });

  app.setErrorHandler((err, req, reply) => {
    const classified = classifyGateError(err);
    const status = statusFor(classified, err);
    // A true 500 is an unexpected internal exception (not a Gate/Core error) — don't
    // echo its raw message (paths/stack-ish text) to the client; log it server-side.
    if (status === 500) {
      req.log?.error?.(err);
      return reply.code(500).send({
        ok: false,
        error: { category: 'unknown', message: 'internal server error', retryable: false },
      });
    }
    reply.code(status).send({ ok: false, error: classified });
  });

  // The landing site needs exactly two routes; everything that can read an
  // account or move money stays unregistered (404, never 401/503).
  const routeModules = deps.publicMode
    ? [healthRoutes, opportunitiesRoutes]
    : [
        healthRoutes,
        credentialsRoutes,
        disclaimerRoutes,
        accountRoutes,
        feesRoutes,
        positionsRoutes,
        ordersRoutes,
        tradesRoutes,
        symbolsRoutes,
        strategyRoutes,
        opportunitiesRoutes,
        booksRoutes,
        leverageRoutes,
        previewRoutes,
        dealsRoutes,
        versionRoutes,
      ];
  for (const routes of routeModules) {
    app.register(routes(deps), { prefix: '/api' });
  }

  // Not under /api (it serves HTML, not the envelope) and therefore never
  // token-gated — the gate above is scoped to /api/ paths.
  if (deps.positionPage) registerPositionPage(app, deps.positionPage.htmlPath);

  return app;
}
