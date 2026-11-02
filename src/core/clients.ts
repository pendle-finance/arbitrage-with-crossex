import 'dotenv/config';
import axios from 'axios';
import { ApiClient, CrossExApi, FuturesApi, SpotApi } from 'gate-api';
import { CoreError } from './errors';

/** Hard HTTP deadline on every Gate call. The SDK's default axios instance has
 * NO timeout — one hung request would stall the reconcile loop (and with it
 * every deal's convergence, e.g. a pending Stop) indefinitely. A timed-out call
 * surfaces as a network error → the engine's UNKNOWN/error paths, which are
 * safe by design (probe-and-resolve, never guess). */
const HTTP_TIMEOUT_MS = 15_000;

/** Gate Broker Program channel id, sent as X-Gate-Channel-Id on every signed
 * request so Gate can attribute this tool's order flow (the same mechanism
 * CCXT and Hummingbot use). Inert until Gate registers the id to us —
 * unregistered values are ignored server-side. */
const GATE_CHANNEL_ID = 'boros';

export interface Clients {
  api: ApiClient;
  crossEx: CrossExApi;
  spot: SpotApi;
  futures: FuturesApi;
}

export interface Credentials {
  key: string;
  secret: string;
}

/**
 * Build an authenticated official `gate-api` ApiClient and the typed API objects.
 * The official SDK (v7.2+) ships a native `CrossExApi`; we use it directly.
 * Credentials default to `.env` (GATE_API_KEY / GATE_API_SECRET); pass `creds`
 * to build a client for other keys (the server's hot-swap + candidate validation).
 */
export function makeClients(creds?: Credentials): Clients {
  const key = creds?.key ?? process.env.GATE_API_KEY;
  const secret = creds?.secret ?? process.env.GATE_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      'Missing GATE_API_KEY / GATE_API_SECRET. Add them to a .env file in the project root.',
    );
  }
  const api = new ApiClient(undefined, axios.create({ timeout: HTTP_TIMEOUT_MS }));
  api.setApiKeySecret(key, secret);
  // Mutate rather than assign: the SDK's defaultHeaders setter replaces the
  // whole object, which would drop its stock X-Gate-Size-Decimal header.
  api.defaultHeaders['X-Gate-Channel-Id'] = GATE_CHANNEL_ID;
  return {
    api,
    crossEx: new CrossExApi(api),
    spot: new SpotApi(api),
    futures: new FuturesApi(api),
  };
}

/**
 * Server-boot variant: null when no credentials are configured yet, so the app
 * can start and serve the first-run credentials UI. Other callers keep using
 * `makeClients` and its hard throw.
 */
export function makeClientsIfConfigured(): Clients | null {
  if (!process.env.GATE_API_KEY || !process.env.GATE_API_SECRET) return null;
  return makeClients();
}

/**
 * Unsigned CrossEx client for the endpoints Gate serves PUBLICLY — the SDK
 * declares `authSettings = []` for `/crossex/rule/symbols` and
 * `/crossex/rule/risk_limits`, and both answer an unsigned request. That is the
 * whole tradable universe plus every symbol's leverage cap, so the market view
 * never has to gate them behind credentials (only `/crossex/fee` and the
 * account/order endpoints are genuinely per-user).
 *
 * Memoized: one ApiClient, same base path and interceptors as the signed one.
 */
let publicClient: CrossExApi | undefined;
export function publicCrossEx(): CrossExApi {
  publicClient ??= new CrossExApi(new ApiClient(undefined, axios.create({ timeout: HTTP_TIMEOUT_MS })));
  return publicClient;
}

/** Gate for routes that need a live client while the server may be unconfigured. */
export function requireClients(clients: Clients | null): Clients {
  if (!clients) {
    throw new CoreError(
      'The Gate API key is not set. Add it in the setup guide.',
      'not-configured',
    );
  }
  return clients;
}
