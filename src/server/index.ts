/** Server entry point: `tsx src/server/index.ts`. Binds to loopback only.
 *
 * This is the LOCAL terminal: it holds the user's Gate API keys, owns the
 * SQLite ledger, and runs the reconcile loop. The public marketing site and the
 * shared-position page live in a separate repo (arbitrage-landing) and share no
 * code with this one. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { fetchBorosMarkets, resolveBorosFetch, setClientTagContext } from '../core/boros/client';
import { makeClientsIfConfigured, requireClients, type Clients } from '../core/clients';
import { Store } from '../engine/db';
import { startLoop, type LoopDeps } from '../engine/loop';
import { gateVenue } from '../engine/venueGate';
import type { Clock, VenuePort } from '../engine/types';
import { buildApp } from './app';
import { readBorosAgentConfig } from './borosAgent';
import { makeBorosApiOrderClient } from '../core/boros/borosApi';
import type { BorosOrderClient } from '../core/boros/orders';
import { TtlCache, TTL } from './cache';
import { readOrCreateApiToken } from './authToken';
import { tokenizedIndexHtml } from './spa';
import { restrictToOwner } from './secretFile';
import { readInstallInfo, readLocalVersion } from './version';

const port = Number(process.env.PORT ?? 6688);
// Loopback only, always: this server exposes a credentialed trading API and
// must never be reachable off the machine that runs it.
const host = '127.0.0.1';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// Overridable so installed deployments can keep user data outside the app dir
// (which updates wipe). Defaults preserve the repo-rooted dev layout.
const dataDir = process.env.ARB_DATA_DIR
  ? path.resolve(process.env.ARB_DATA_DIR)
  : path.join(repoRoot, 'data');
const envPath = process.env.DOTENV_CONFIG_PATH
  ? path.resolve(process.env.DOTENV_CONFIG_PATH)
  : path.join(repoRoot, '.env');
/** True when the .env sits in a config dir an installer chose, so tightening
 * that DIRECTORY is hardening rather than clobbering someone's checkout. */
const hardenConfigDir = Boolean(process.env.DOTENV_CONFIG_PATH);

// The .env holds the live-money Gate secret. The credentials route writes it 0600,
// but an .env created another way (hand-edited, an older install, a permissive
// umask) can be group/world-readable — re-assert owner-only on every boot.
{
  // restrictToOwner, not chmod: on Windows the mode bits are ignored outright,
  // so the key file would just inherit its parent directory's ACL.
  //
  // The FILE always. Its PARENT only when the .env lives in a dedicated config
  // dir — i.e. when DOTENV_CONFIG_PATH is set, which only the installed
  // layouts do (the LaunchAgent plist / the generated Windows runner). In a
  // source checkout the .env's parent IS the repo root, and hardening that is
  // not protection, it is damage: chmod 0700 on the whole checkout, and on
  // Windows an inheritance strip plus a walk of every file in it.
  if (hardenConfigDir) restrictToOwner(path.dirname(envPath));
  restrictToOwner(envPath);
}

/** Mutable so the credentials service can hot-swap keys without a restart.
 * Null until the user configures keys (first-run setup guide in the web UI) —
 * a fresh install runs fine with no .env, and every credentialed code path
 * throws not-configured until the keys arrive. */
const clientsRef: { current: Clients | null } = {
  current: makeClientsIfConfigured(),
};
const getClients = () => requireClients(clientsRef.current);

// Stamp the version onto every Boros API request, and mark this user "active" when credentials are
// already configured. The credentials route flips active:true on a later
// hot-swap. Core reads neither fs nor env, so the server injects both here.
setClientTagContext({ version: readLocalVersion(repoRoot), active: Boolean(clientsRef.current) });

// The engine: SQLite ledger + reconcile loop.
let engine: { store: Store; venue: VenuePort; clock: Clock; wake?: () => void } | undefined;
let loopDeps: LoopDeps | undefined;
{
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // The store's EXCLUSIVE lock doubles as the single-instance guard: a second
  // process (e.g. a dev run beside the LaunchAgent service) fails here, BEFORE it
  // can touch the venue.
  const store = new Store(path.join(dataDir, 'deals.sqlite'));

  // One-time migration guard: a retired basket engine journaled to baskets.jsonl.
  // If that journal's last word on any basket was non-terminal, the process died
  // mid-execution before the upgrade — the venue may hold orders/exposure the
  // engine knows nothing about. Surface it loudly; never guess.
  try {
    const legacyJournal = path.join(dataDir, 'baskets.jsonl');
    if (fs.existsSync(legacyJournal)) {
      const status = new Map<string, string>();
      for (const line of fs.readFileSync(legacyJournal, 'utf8').split('\n')) {
        try {
          const ev = JSON.parse(line) as { basketId?: string; type?: string; payload?: { status?: string } };
          if (!ev.basketId) continue;
          if (ev.type === 'planned') status.set(ev.basketId, 'executing');
          if (ev.type === 'basket-status' && ev.payload?.status) status.set(ev.basketId, ev.payload.status);
        } catch {
          /* torn line */
        }
      }
      const inflight = [...status.entries()].filter(([, s]) => s === 'executing').map(([id]) => id);
      if (inflight.length) {
        const msg = `legacy basket(s) were mid-flight at upgrade: ${inflight.join(', ')} — check Gate open orders/positions manually (the retired engine cannot reconcile them)`;
        console.error(`⚠️  ${msg}`);
        store.alert('error', null, msg, Date.now(), { once: true });
      }
    }
  } catch {
    /* best-effort */
  }

  loopDeps = { store, venue: gateVenue(getClients), clock: { now: () => Date.now() } };
  engine = { store, venue: loopDeps.venue, clock: loopDeps.clock };
}

// Boros order placement. Absent config is the normal state (the panel still
// prices pairs and answers 503 on execute); malformed config is surfaced loudly
// at boot rather than at the moment someone tries to trade. The markets list is
// read through the same TTL cache the routes use, so resolving a market's
// collateral token costs nothing extra.
const cache = new TtlCache();
// Mutable so the browser's connect-wallet flow can provision an agent without a
// restart — same shape as the Gate credential hot-swap above.
const borosOrdersRef: { current: BorosOrderClient | undefined } = { current: undefined };
try {
  const agentConfig = readBorosAgentConfig();
  if (agentConfig) {
    borosOrdersRef.current = makeBorosApiOrderClient({
      ...agentConfig,
      // Shares the routes' cache key, so packing a MarketAcc costs no extra
      // upstream traffic and can never disagree with what the panel priced.
      tokenIdForMarket: async (marketId) => {
        const { value } = await cache.get('boros:markets', TTL.boros, () =>
          fetchBorosMarkets(resolveBorosFetch()),
        );
        return value.find((m) => m.marketId === marketId)?.tokenId;
      },
    });
    console.log(
      `Boros order placement enabled for ${agentConfig.root} (account ${agentConfig.accountId}) via a delegated agent key — this key can trade, but cannot deposit or withdraw.`,
    );
  }
} catch (err) {
  console.error(`⚠️  ${(err as Error).message}`);
}

const webDist = path.join(repoRoot, 'web', 'dist');

const appDeps = {
  getClients,
  // The same cache the Boros agent wiring above reads markets through, so a
  // MarketAcc pack and a priced panel can never disagree.
  cache,
  // Created on first boot beside the .env.
  authToken: readOrCreateApiToken(path.dirname(envPath)),
  engine,
  // UPDATE_CHECK=0 lets an install opt out of the GitHub read entirely.
  install: readInstallInfo(repoRoot),
  updateCheck: { current: readLocalVersion(repoRoot), disabled: process.env.UPDATE_CHECK === '0' },
  getBorosOrders: () => borosOrdersRef.current,
  borosAgent: {
    envPath,
    hardenConfigDir,
    setOrderClient: (client: BorosOrderClient | undefined) => {
      borosOrdersRef.current = client;
    },
  },
  credentials: {
    envPath,
    hardenConfigDir,
    setClients: (clients: Clients) => {
      clientsRef.current = clients;
    },
  },
};
const app = buildApp(appDeps);

// Serve the built SPA when present (`yarn start`); in dev, Vite proxies /api here.
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  // The HTML is served BY US so the token can be injected; the hashed assets
  // still go through the static plugin. no-store (and no ETag) because a
  // cached copy could otherwise revive a page carrying a stale token.
  // @fastify/static registers only a wildcard, so these explicit routes win.
  if (appDeps.authToken) {
    const token = appDeps.authToken;
    const serveIndex = async (_req: unknown, reply: { header: (k: string, v: string) => typeof reply; type: (t: string) => typeof reply; send: (b: string) => unknown }) =>
      reply
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(tokenizedIndexHtml(webDist, token));
    app.get('/', serveIndex);
    app.get('/index.html', serveIndex);
  }
  app.register(fastifyStatic, { root: webDist });
}

app
  .listen({ host, port })
  .then(() => {
    // The reconcile loop IS recovery: any deal that was mid-flight when the
    // server died just gets its next tick. Started after listen so a port
    // conflict (second instance) can never run venue mutations first.
    if (loopDeps && engine) engine.wake = startLoop(loopDeps).wake;
    const shown = host === '127.0.0.1' ? 'localhost' : host;
    console.log(`arb-tools server listening on http://${shown}:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
