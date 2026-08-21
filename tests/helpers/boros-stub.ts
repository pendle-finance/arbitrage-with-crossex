/**
 * Route-by-pathname stub for the Boros backend, injected through the
 * AppDeps.borosFetch seam (global fetch is never touched) by
 * tests/server/{strategy,opportunities}.test.ts. Each request resolves its
 * pathname against `bodies` (404 on a miss); `calls` records pathname+search.
 * A FUNCTION value is called with the parsed URL — for gateway endpoints that
 * multiplex one pathname over query params (order-book by marketId,
 * position-update-events by marketAcc+marketId); returning undefined 404s.
 */
import type { FetchLike } from '../../src/core/boros/client';

export function borosStub(bodies: Record<string, unknown>, calls?: string[]): FetchLike {
  return async (url: string) => {
    const parsed = new URL(url);
    const { pathname, search } = parsed;
    calls?.push(pathname + search);
    const entry = bodies[pathname];
    const body = typeof entry === 'function' ? (entry as (u: URL) => unknown)(parsed) : entry;
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({ statusCode: 404 }) }
      : { ok: true, status: 200, json: async () => body };
  };
}
