import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ApiMeta } from '../api/types';

/** Shared msw server — tests add handlers per-case with server.use(...). */
export const server = setupServer(
  http.get('/api/boros/agent', () =>
    HttpResponse.json(
      env({
        configured: false,
        root: null,
        rootMasked: null,
        accountId: null,
        expiry: null,
        expired: false,
        canProvision: true,
      }),
    ),
  ),
);

/** Wrap data in the backend's success envelope. */
export function env<T>(data: T, meta: Partial<ApiMeta> = {}): { ok: true; data: T; meta: ApiMeta } {
  return { ok: true, data, meta: { ts: Date.now(), ...meta } };
}
