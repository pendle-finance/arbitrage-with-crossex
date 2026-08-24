import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSpaShell } from '../../src/server/spa';
import { makeTestApp } from './helpers/gate-nock';

const webRoot = fileURLToPath(new URL('../../web', import.meta.url));
const BEARER = '0123456789abcdef'.repeat(4);

describe('public SPA shell', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it.each(['/', '/index.html'])('never discloses the API bearer from unauthenticated GET %s', async (url) => {
    app = Fastify();
    registerSpaShell(app, webRoot);

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(BEARER);
    expect(response.body).not.toContain('__ARB_TOKEN__');
    expect(response.body).not.toContain('name="arb-token"');
  });

  it('leaves the protected API at 401 after an unauthenticated page fetch', async () => {
    app = makeTestApp({ authToken: BEARER });
    registerSpaShell(app, webRoot);
    const headers = { host: 'localhost:6688' };

    const page = await app.inject({ method: 'GET', url: '/', headers });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(BEARER);

    const replay = await app.inject({ method: 'GET', url: '/api/credentials', headers });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toMatchObject({ category: 'auth', retryable: false });
  });
});
