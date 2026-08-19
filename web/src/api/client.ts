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

/** Resolve /api paths against the page origin so requests work in the browser
 * (Vite dev proxy → localhost:6688) AND in jsdom/msw tests (absolute URLs). */
function apiUrl(path: string): string {
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost:6688';
  return new URL(`/api${path}`, origin).toString();
}

/** The per-install API token, injected into index.html by the backend that
 * serves it. Absent in dev (the Vite proxy attaches the header server-side);
 * the untouched placeholder means the same thing —
 * this page did not come from the terminal backend, so send nothing. */
function authHeader(): Record<string, string> {
  const t =
    typeof document === 'undefined'
      ? null
      : document.querySelector('meta[name="arb-token"]')?.getAttribute('content');
  return t && t !== '__ARB_TOKEN__' ? { 'x-arb-token': t } : {};
}

export async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl(path), {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...authHeader(),
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
