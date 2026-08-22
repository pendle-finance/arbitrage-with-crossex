/**
 * PUT /api/credentials: candidate-validated, .env-preserving, hot-swapping,
 * and refused (409) while a basket is executing.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients, type Clients } from '../../src/core/clients';
import { rewriteEnvFile } from '../../src/server/routes/credentials';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { fixture, gate, HOST, makeTestApp, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const NEW_KEY = 'newkey876543210';
const NEW_SECRET = 'newsecret';

let app: FastifyInstance;
let envPath: string;
let current: Clients;

beforeEach(() => {
  envPath = path.join(mkdtempSync(path.join(tmpdir(), 'env-')), '.env');
  writeFileSync(envPath, `# gate creds\nGATE_API_KEY=${TEST_KEY}\nGATE_API_SECRET=${TEST_SECRET}\nOTHER_VAR=keepme\n`);
  current = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  app = makeTestApp({
    getClients: () => current,
    credentials: {
      envPath,
      setClients: (c) => {
        current = c;
      },
    },
  });
});
afterEach(async () => {
  await app.close();
  nock.cleanAll();
});

const put = (payload: unknown) =>
  app.inject({ method: 'PUT', url: '/api/credentials', headers: HOST, payload: payload as Record<string, unknown> });

describe('PUT /api/credentials', () => {
  it('rejects bad credentials with 401 and leaves .env untouched', async () => {
    gate().get('/api/v4/crossex/accounts').query(true).reply(401, { label: 'INVALID_KEY', message: 'invalid key' });

    const res = await put({ key: NEW_KEY, secret: NEW_SECRET });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.category).toBe('auth');
    expect(readFileSync(envPath, 'utf8')).toContain(`GATE_API_KEY=${TEST_KEY}`);
    expect(process.env.GATE_API_KEY).toBe(TEST_KEY);
  });

  it('accepts working credentials: validates with a candidate client, rewrites .env preserving other lines, hot-swaps', async () => {
    let seenKey = '';
    gate()
      .get('/api/v4/crossex/accounts')
      .query(true)
      .reply(function () {
        seenKey = String(this.req.headers.key ?? '');
        return [200, fixture('account.json')];
      });

    const res = await put({ key: NEW_KEY, secret: NEW_SECRET });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.accountMode).toBeDefined();
    expect(seenKey).toBe(NEW_KEY); // the CANDIDATE client did the validation call

    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('# gate creds'); // comments survive
    expect(env).toContain('OTHER_VAR=keepme'); // unrelated vars survive
    expect(env).toContain(`GATE_API_KEY=${NEW_KEY}`);
    expect(env).toContain(`GATE_API_SECRET=${NEW_SECRET}`);
    expect(env).not.toContain(TEST_KEY);

    // Hot-swap: the next Gate call signs with the new key.
    let nextKey = '';
    gate()
      .get('/api/v4/crossex/accounts')
      .query(true)
      .reply(function () {
        nextKey = String(this.req.headers.key ?? '');
        return [200, fixture('account.json')];
      });
    await app.inject({ method: 'GET', url: '/api/account', headers: HOST });
    expect(nextKey).toBe(NEW_KEY);
  });

  it('refuses with 409 while a deal is still working', async () => {
    // Any non-DONE deal blocks a credential swap: the reconcile loop's next tick
    // would point venue calls for old-account orders at the new account.
    await app.close();
    const store = new Store(':memory:');
    store.createPair({
      id: 'busy-deal-409',
      mode: 'OPENING',
      a: { contract: 'GATE_FUTURE_ETH_USDT', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
      b: null,
      targetQty: '0.05',
      limitPrice: '2500',
      pricePolicy: 'fixed',
      deadlineAt: null,
      makerNotBefore: 0,
      hedgeNotBefore: 0,
      pocRejects: 0,
      hedgeRejectStreak: 0,
      maxClip: null,
      clipBandBp: null,
      hedgeBandBp: null,
      haltReason: null,
      reportJson: null,
      createdAt: Date.now(),
    });
    app = makeTestApp({
      getClients: () => current,
      credentials: { envPath, setClients: (c) => (current = c) },
      engine: { store, venue: gateVenue(() => current), clock: { now: () => Date.now() } },
    });

    const res = await put({ key: NEW_KEY, secret: NEW_SECRET });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/deal is still working/);

    // Once the deal settles, the swap goes through.
    store.updatePair('busy-deal-409', { mode: 'DONE' });
    gate().get('/api/v4/crossex/accounts').query(true).reply(200, fixture('account.json'));
    const ok = await put({ key: NEW_KEY, secret: NEW_SECRET });
    expect(ok.statusCode).toBe(200);
  });

  it('validates the body shape', async () => {
    const res = await put({ key: '', secret: 'x' });
    expect(res.statusCode).toBe(400);
  });
});

describe('rewriteEnvFile', () => {
  it('appends missing keys without disturbing content', () => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), 'env-')), '.env');
    writeFileSync(p, 'A=1\n');
    rewriteEnvFile(p, { GATE_API_KEY: 'k', GATE_API_SECRET: 's' });
    expect(readFileSync(p, 'utf8')).toBe('A=1\nGATE_API_KEY=k\nGATE_API_SECRET=s\n');
  });

  it('creates the file when absent', () => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), 'env-')), '.env');
    rewriteEnvFile(p, { GATE_API_KEY: 'k' });
    expect(readFileSync(p, 'utf8')).toBe('GATE_API_KEY=k\n');
  });

  it('writes the secret-bearing .env at mode 0600', () => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), 'env-')), '.env');
    rewriteEnvFile(p, { GATE_API_KEY: 'k', GATE_API_SECRET: 's' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // A pre-existing world-readable file is tightened on rewrite.
    chmodSync(p, 0o644);
    rewriteEnvFile(p, { GATE_API_KEY: 'k2' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
