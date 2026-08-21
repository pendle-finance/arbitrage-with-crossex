/**
 * Route-by-pathname stub for the Boros backend, injected through the
 * AppDeps.borosFetch seam (global fetch is never touched) by
 * tests/server/{strategy,opportunities}.test.ts. Each request resolves its
 * pathname against `bodies` (404 on a miss); `calls` records pathname+search.
 */
import type { FetchLike } from '../../src/core/boros/client';

export function borosStub(bodies: Record<string, unknown>, calls?: string[]): FetchLike {
  return async (url: string) => {
    const { pathname, search } = new URL(url);
    calls?.push(pathname + search);
    const body = bodies[pathname];
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({ statusCode: 404 }) }
      : { ok: true, status: 200, json: async () => body };
  };
}
