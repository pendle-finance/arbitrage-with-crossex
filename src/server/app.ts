/**
 * Fastify app factory (no listen — tests drive it via app.inject()).
 * Owns the localhost-only origin guard, the {ok,data,meta}/{ok,error} envelope,
 * and the error-category → HTTP-status mapping; routes stay thin.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { FetchLike } from '../core/boros/client';
import type { BorosOrderClient } from '../core/boros/orders';
import type { Clients } from '../core/clients';
import { classifyGateError } from '../core/errors';
import type { Store } from '../engine/db';
import type { Clock, VenuePort } from '../engine/types';
import type { TtlCache } from './cache';
import { sendError } from './errorReply';
import type { InterestFile } from './interestLedger';
import type { JobFile, TransferFile } from './rebalanceJob';
import { accountRoutes } from './routes/account';
import { booksRoutes } from './routes/books';
import { credentialsRoutes } from './routes/credentials';
import { dealsRoutes } from './routes/deals';
import { disclaimerRoutes } from './routes/disclaimer';
import { feesRoutes } from './routes/fees';
import { healthRoutes } from './routes/health';
import { assetViewRoutes } from './routes/assetView';
import { borosAgentRoutes } from './routes/borosAgent';
import { borosPairRoutes } from './routes/borosPair';
import { opportunitiesRoutes } from './routes/opportunities';
import { ordersRoutes } from './routes/orders';
import { positionsRoutes } from './routes/positions';
import { previewRoutes } from './routes/preview';
import { rebateRoutes } from './routes/rebate';
import { rebalanceRoutes } from './routes/rebalance';
import { symbolsRoutes } from './routes/symbols';
import { shareLinkRoutes } from './routes/shareLink';
import { telegramRoutes } from './routes/telegram';
import { transferRoutes } from './routes/transfer';
import { versionRoutes } from './routes/version';
import { tradesRoutes } from './routes/trades';
import type { BotClient } from './telegram/botClient';
import type { TelegramLink } from './telegram/link';
import type { TelegramStatus } from './telegram/status';
import type { TelegramSync } from './telegram/sync';

export interface AppDeps {
  getClients(): Clients;
  cache: TtlCache;
  dataDir: string;
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
   * buildApp refuses to serve the trading API unauthenticated rather than let
   * a missing wire-up pass silently. */
  authToken?: string;
  /** Test seam for the Boros backend client (defaults to global fetch). */
  borosFetch?: FetchLike;
  /**
   * The Boros WRITE port, used by the two-leg market panel. A GETTER, not a
   * value: the agent can be provisioned from the browser at runtime, so routes
   * must read the CURRENT client rather than close over whatever existed at
   * boot. Returning undefined means the install cannot place Boros orders —
   * /api/boros/pair/execute answers 503 rather than pretending. Reads (context,
   * simulate) work without it, so the panel prices pairs on any install.
   */
  getBorosOrders?: () => BorosOrderClient | undefined;
  /** Enables PUT/DELETE /api/boros/agent (browser-provisioned agent key). */
  borosAgent?: {
    envPath: string;
    hardenConfigDir?: boolean;
    /** Install (or clear) the live order client after a successful write. */
    setOrderClient(client: BorosOrderClient | undefined): void;
    /** Called once per key, when the chain first shows it approved. The bot
     * checks the approval before it moves alerts, so this is the moment to sync. */
    onApproved?(): void;
  };
  /** Test seam for the GitHub update check (defaults to global fetch). */
  versionFetch?: FetchLike;
  /** What the installer recorded about this tree (null in a source checkout).
   * Echoed on GET /api/version so a user can see which commit they run. */
  install?: import('./version').InstallInfo | null;
  /** Update check, set by the entry point (never in public mode): the running
   * copy's version from <repoRoot>/version.json — null means "unknown", which
   * disables the remote read entirely — plus the UPDATE_CHECK=0 opt-out. */
  updateCheck?: { current: string | null; disabled?: boolean };
  /** `interest` absent keeps the all-time interest ledger in memory: tests only. */
  rebalance?: { jobs: JobFile; interest?: InterestFile; sleep?: (ms: number) => Promise<void>; onDone?: () => void };
  transfer?: { jobs: TransferFile; sleep?: (ms: number) => Promise<void>; onDone?: () => void };
  /** `wallet` is the Boros wallet the bot client names in x-terminal-wallet. */
  telegram?: { link: TelegramLink; sync: TelegramSync; status: TelegramStatus; bot: BotClient; wallet?: () => string | null };
}

declare module 'fastify' {
  interface FastifyReply {
    /** Success envelope: { ok: true, data, meta: { ts, stale? } }. */
    ok(data: unknown, opts?: { stale?: boolean }): FastifyReply;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  // Any localhost port is trusted (the Vite dev server proxies from its own port);
  // DNS-rebinding/CSRF attackers can reach 127.0.0.1 but can't forge a localhost
  // Host/Origin. No CORS headers are ever emitted.
  const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  // Fail closed on a missing wire-up: an optional field that silently
  // disables authentication is exactly the regression this catches.
  if (!deps.authToken) {
    throw new Error('authToken is required — refusing to serve the trading API unauthenticated');
  }
  const expectedTokenHash = deps.authToken
    ? createHash('sha256').update(deps.authToken).digest()
    : null;

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
    let pathname = req.url.split('?', 1)[0];
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
    }
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

  app.decorateReply('ok', function (this: FastifyReply, data: unknown, opts?: { stale?: boolean }) {
    const meta: { ts: number; stale?: boolean } = { ts: Date.now() };
    if (opts?.stale) meta.stale = true;
    return this.send({ ok: true, data, meta });
  });

  app.setErrorHandler((err, req, reply) => sendError(err, req, reply, classifyGateError));

  const routeModules = [
    healthRoutes,
    credentialsRoutes,
    disclaimerRoutes,
    accountRoutes,
    feesRoutes,
    positionsRoutes,
    ordersRoutes,
    tradesRoutes,
    symbolsRoutes,
    opportunitiesRoutes,
    borosPairRoutes,
    assetViewRoutes,
    borosAgentRoutes,
    rebateRoutes,
    booksRoutes,
    previewRoutes,
    dealsRoutes,
    rebalanceRoutes,
    transferRoutes,
    versionRoutes,
    shareLinkRoutes,
    telegramRoutes,
  ];
  for (const routes of routeModules) {
    app.register(routes(deps), { prefix: '/api' });
  }


  return app;
}
