/**
 * POST /api/share-link — the local proxy that turns a long share payload into
 * a short code via the public Boros backend. The browser can't make that call
 * itself (the backend's CORS allowlist has no localhost origin), and the modal
 * must never block on it — so the route is a thin, cached forward whose every
 * failure is an ordinary error envelope the modal silently ignores.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { HOST, makeTestApp } from './helpers/gate-nock';

const D = 'eyJ2IjoxfQ'; // base64url of {"v":1} — the route forwards, it doesn't decode
const ADDR = '0xAbC0000000000000000000000000000000000123';

type Call = { url: string; method?: string; body?: string };

function stub(
  body: unknown,
  opts: { status?: number; reject?: boolean; calls?: Call[] } = {},
): FetchLike {
  return async (url, init) => {
    opts.calls?.push({ url, method: init?.method, body: init?.body });
    if (opts.reject) throw new Error('network down');
    const status = opts.status ?? 200;
    return { ok: status < 400, status, json: async () => body };
  };
}

describe('POST /api/share-link', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/api/share-link', headers: HOST, payload });

  it('forwards the payload to the backend and returns the minted code', async () => {
    const calls: Call[] = [];
    app = makeTestApp({ borosFetch: stub({ code: 'Abc123_-xyz', expiresAt: 42 }, { calls }) });
    const res = await post({ d: D });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ code: 'Abc123_-xyz', expiresAt: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /^https:\/\/api-boros\.pendle\.finance\/apis\/v1\/crossex\/shared-positions\?pendle_client=boroscrossex/,
    );
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ d: D });
  });

  it('forwards the tracked address raw, lowercased, beside the payload', async () => {
    const calls: Call[] = [];
    app = makeTestApp({ borosFetch: stub({ code: 'Abc123_-xyz', expiresAt: 42 }, { calls }) });
    const res = await post({ d: D, address: ADDR });
    expect(res.statusCode).toBe(200);
    // Raw field, NOT folded into `d` — the payload the backend stores is
    // byte-identical to the address-less one, so the public link is unchanged.
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ d: D, address: ADDR.toLowerCase() });
  });

  it('caches per (address, payload) — one sharer\'s code is never served to another', async () => {
    const calls: Call[] = [];
    const other = '0x1111111111111111111111111111111111111111';
    app = makeTestApp({ borosFetch: stub({ code: 'Abc123_-xyz', expiresAt: 42 }, { calls }) });
    await post({ d: D, address: ADDR });
    await post({ d: D, address: ADDR });
    expect(calls).toHaveLength(1); // same sharer, same payload → cache hit
    await post({ d: D, address: other });
    await post({ d: D }); // no address at all is its own key too
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[1].body ?? '')).toEqual({ d: D, address: other });
    expect(JSON.parse(calls[2].body ?? '')).toEqual({ d: D });
  });

  it('drops an unusable address instead of failing the mint', async () => {
    const calls: Call[] = [];
    app = makeTestApp({ borosFetch: stub({ code: 'Abc123_-xyz', expiresAt: 42 }, { calls }) });
    for (const address of [42, '0xnope', `${ADDR}00`, '']) {
      const res = await post({ d: D, address });
      // The short link still mints — losing the attribution beats losing the
      // link over a field the user never sees.
      expect(res.statusCode).toBe(200);
      expect(res.json().data.code).toBe('Abc123_-xyz');
    }
    expect(calls).toHaveLength(1); // all four collapse onto the address-less key
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ d: D });
  });

  it('caches per payload — reopening the modal costs no second round-trip', async () => {
    const calls: Call[] = [];
    app = makeTestApp({ borosFetch: stub({ code: 'Abc123_-xyz', expiresAt: 42 }, { calls }) });
    await post({ d: D });
    const res = await post({ d: D });
    expect(res.json().data.code).toBe('Abc123_-xyz');
    expect(calls).toHaveLength(1);
  });

  it('rejects a non-base64url or missing payload without touching the network', async () => {
    const calls: Call[] = [];
    app = makeTestApp({ borosFetch: stub({}, { calls }) });
    for (const payload of [{}, { d: 42 }, { d: 'not base64!!' }, { d: 'a'.repeat(5000) }]) {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.category).toBe('validation');
    }
    expect(calls).toHaveLength(0);
  });

  it('maps an unreachable backend to a retryable network envelope', async () => {
    app = makeTestApp({ borosFetch: stub({}, { reject: true }) });
    const res = await post({ d: D });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.category).toBe('network');
  });

  it('treats a backend response without a usable code as a failure, not a success', async () => {
    app = makeTestApp({ borosFetch: stub({ nope: true }) });
    const res = await post({ d: D });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.category).toBe('network');
  });
});
