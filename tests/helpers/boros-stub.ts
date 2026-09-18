/**
 * Route-by-pathname stub for the Boros backend, injected through the
 * AppDeps.borosFetch seam (global fetch is never touched) by
 * tests/server/{strategy,opportunities}.test.ts. Each request resolves its
 * pathname against `bodies` (404 on a miss); `calls` records pathname+search.
 */
import type { FetchLike } from '../../src/core/boros/client';

export function borosStub(bodies: Record<string, unknown>, calls?: string[]): FetchLike {
  return async (url: string) => {
    const { pathname, search, searchParams } = new URL(url);
    calls?.push(pathname + search);
    // The order book takes its marketId as a query param, so a bare pathname
    // can no longer tell two markets' books apart: try the marketId-qualified
    // key first, then the plain pathname.
    const marketId = searchParams.get('marketId');
    const body = (marketId !== null ? bodies[`${pathname}?marketId=${marketId}`] : undefined) ?? bodies[pathname];
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({ statusCode: 404 }) }
      : { ok: true, status: 200, json: async () => body };
  };
}
