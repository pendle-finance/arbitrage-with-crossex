/**
 * The local API token. Loopback binding + the Host/Origin guard stop a hostile
 * WEB PAGE; neither stops a local PROCESS — under any account on the machine —
 * from POSTing a deal. The token narrows the API to whoever can read the
 * 0600 file beside the .env.
 */
import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOrCreateApiToken } from '../../src/server/authToken';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import { makeClients } from '../../src/core/clients';
import { HOST, makeTestApp, TEST_TOKEN } from './helpers/gate-nock';

describe('API token gate', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const bareHost = { host: 'localhost:6688' };

  it.each(['/%61pi/credentials', '/ap%69/credentials', '/%61pi/version/update'])(
    'refuses a percent-encoded path that the router still matches: %s',
    async (url) => {
      app = makeTestApp();
      const res = await app.inject({ method: 'GET', url, headers: bareHost });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatchObject({ category: 'auth' });
    },
  );

  it('refuses an /api request with no token', async () => {
    app = makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/credentials', headers: bareHost });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ category: 'auth', retryable: false });
    expect(res.json().error.message).toMatch(/API token/);
  });

  it('refuses a wrong token — including one of a different length', async () => {
    app = makeTestApp();
    for (const token of ['nope', `${TEST_TOKEN}x`, '']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/credentials',
        headers: { ...bareHost, 'x-arb-token': token },
      });
      // A raw timingSafeEqual would THROW on a length mismatch (→ 500); the
      // hash-then-compare construction keeps every rejection a clean 401.
      expect(res.statusCode, token).toBe(401);
    }
  });

  it('accepts the right token', async () => {
    app = makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/credentials', headers: HOST });
    expect(res.statusCode).toBe(200);
  });

  it('creates nothing when a deal is POSTed without the token', async () => {
    const w = makeTestApp();
    app = w;
    const res = await app.inject({
      method: 'POST',
      url: '/api/deals',
      headers: bareHost,
      payload: { id: 'x', execution: 'taker', qty: '1', a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('leaves /api/health open — the installers poll it to decide if the app came up', async () => {
    app = makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: bareHost });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('ok');
  });

  it('checks the host FIRST: a foreign host is 403 even with a valid token', async () => {
    app = makeTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/credentials',
      headers: { host: 'evil.com', 'x-arb-token': TEST_TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to build a credentialed app with no token at all', () => {
    // An optional field that silently disables auth is the regression this
    // catches — the entry point cannot forget to pass one.
    expect(() =>
      buildApp({
        getClients: () => makeClients({ key: 'k', secret: 's' }),
        cache: new TtlCache(),
      }),
    ).toThrow(/authToken is required/);
  });
});

describe('readOrCreateApiToken', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));

  it('creates a 0600 token once, then returns the same one', () => {
    const dir = tmp();
    const first = readOrCreateApiToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'api-token')).mode & 0o777).toBe(0o600);
    }
    expect(readOrCreateApiToken(dir)).toBe(first); // stable across restarts
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('regenerates an empty file rather than authenticating with ""', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'api-token'), '   \n');
    expect(readOrCreateApiToken(dir)).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws rather than silently unauthenticating when the file is unreadable', () => {
    if (process.platform === 'win32') return; // mode bits are advisory there
    const dir = tmp();
    const f = path.join(dir, 'api-token');
    fs.writeFileSync(f, 'tok\n');
    fs.chmodSync(f, 0o000);
    expect(() => readOrCreateApiToken(dir)).toThrow(/cannot read the API token/);
    fs.chmodSync(f, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
