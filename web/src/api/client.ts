/** Envelope-aware fetch helper. Unwraps { ok, data, meta } and throws a typed
 * ApiError (carrying category/message/hint/retryable) on { ok: false } or
 * transport-level failures. */
import type { ClassifiedError, Envelope } from './types';

export class ApiError extends Error {
  readonly category: ClassifiedError['category'];
  readonly label?: string;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly httpStatus?: number;

  constructor(err: ClassifiedError) {
    super(err.message);
    this.name = 'ApiError';
    this.category = err.category;
    this.label = err.label;
    this.retryable = err.retryable;
    this.hint = err.hint;
    this.httpStatus = err.httpStatus;
  }
}

const API_TOKEN_STORAGE_KEY = 'arb-api-token';
const API_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

type TokenStorage = Pick<Storage, 'getItem' | 'setItem'>;

function storedApiToken(storage: TokenStorage): string | null {
  try {
    const token = storage.getItem(API_TOKEN_STORAGE_KEY);
    return token && API_TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Resolve /api paths against the page origin so requests work in the browser
 * (Vite dev proxy → localhost:6688) AND in jsdom/msw tests (absolute URLs). */
function apiUrl(path: string): string {
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost:6688';
  return new URL(`/api${path}`, origin).toString();
}

/**
 * Consume a launcher fragment and return the token this page should use.
 * Clearing happens before validation starts, so the bearer does not linger in
 * the address bar or browser history. A failed candidate never overwrites a
 * token that was successfully bootstrapped earlier.
 */
export async function bootstrapApiToken(options: {
  hostname: string;
  hash: string;
  storage: TokenStorage;
  clearFragment: () => void;
  validate: (candidate: string) => Promise<boolean>;
}): Promise<string | null> {
  const local = options.hostname === 'localhost' || options.hostname === '127.0.0.1';
  const match = local ? /^#token=([0-9a-f]{64})$/.exec(options.hash) : null;

  // Scrub anything presented as a token even when malformed or on a foreign
  // origin. Only an exact local match is ever validated or persisted.
  if (options.hash.startsWith('#token=')) options.clearFragment();

  const previous = local ? storedApiToken(options.storage) : null;
  const candidate = match?.[1];
  if (!candidate) return previous;

  try {
    if (!(await options.validate(candidate))) return previous;
  } catch {
    return previous;
  }
  try {
    options.storage.setItem(API_TOKEN_STORAGE_KEY, candidate);
  } catch {
    // Storage can be unavailable in locked-down browsers. The validated token
    // still authenticates this page load; the launcher can bootstrap the next.
  }
  return candidate;
}

const browserToken = typeof window === 'undefined'
  ? Promise.resolve<string | null>(null)
  : bootstrapApiToken({
      hostname: window.location.hostname,
      hash: window.location.hash,
      storage: window.localStorage,
      clearFragment: () => {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
      },
      validate: async (candidate) => {
        try {
          const response = await fetch(apiUrl('/credentials'), {
            method: 'GET',
            credentials: 'omit',
            headers: { 'x-arb-token': candidate },
          });
          return response.ok;
        } catch {
          return false;
        }
      },
    });

async function authHeader(): Promise<Record<string, string>> {
  const bootstrapped = await browserToken;
  if (
    typeof window === 'undefined' ||
    (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1')
  ) {
    return {};
  }
  const token = bootstrapped ?? storedApiToken(window.localStorage);
  return token ? { 'x-arb-token': token } : {};
}

export async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl(path), {
      ...init,
      credentials: 'omit',
      headers: {
        ...(await authHeader()),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ApiError({
      category: 'network',
      message: `network error calling ${path}: ${(err as Error).message ?? String(err)}`,
      retryable: true,
      hint: 'Is the backend running on localhost:6688?',
    });
  }

  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* non-JSON body (proxy error page, empty 404, …) — handled below */
  }

  if (body !== null && typeof body === 'object' && 'ok' in (body as Record<string, unknown>)) {
    const env = body as Envelope<T>;
    if (env.ok) return env.data;
    throw new ApiError({ httpStatus: resp.status, ...env.error });
  }

  // No recognizable envelope — synthesize a transport error.
  throw new ApiError({
    category: resp.status === 401 || resp.status === 403 ? 'auth' : 'unknown',
    message: `${path} returned HTTP ${resp.status}${body ? ' with an unexpected body' : ''}`,
    httpStatus: resp.status,
    retryable: resp.status >= 500,
  });
}

export const del = <T>(path: string): Promise<T> => fetchJson<T>(path, { method: 'DELETE' });

export const putJson = <T>(path: string, body: unknown): Promise<T> =>
  fetchJson<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  fetchJson<T>(path, { method: 'POST', body: JSON.stringify(body) });
