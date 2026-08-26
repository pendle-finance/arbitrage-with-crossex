/**
 * /api/boros/agent — the browser-provisioned agent key.
 *
 * The properties worth pinning are all safety ones: a root PRIVATE key is
 * refused outright, the key is never echoed back or exposed by GET, the file it
 * lands in is 0600, provisioning hot-swaps the live client without a restart,
 * and DELETE is honest that it has not revoked anything on-chain.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BorosOrderClient } from '../../src/core/boros/orders';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const ROOT = `0x${'1'.repeat(40)}`;
const AGENT_KEY = `0x${'a'.repeat(64)}`;

let app: FastifyInstance | null = null;
let envPath = '';
let installed: BorosOrderClient | undefined;

const ENV_KEYS = [
  'BOROS_ROOT_ADDRESS',
  'BOROS_ACCOUNT_ID',
  'BOROS_AGENT_PRIVATE_KEY',
  'BOROS_RPC_URLS',
  'BOROS_AGENT_EXPIRY',
];

beforeEach(() => {
  envPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boros-agent-')), '.env');
  installed = undefined;
  for (const k of ENV_KEYS) delete process.env[k];
  app = makeTestApp({
    borosFetch: borosStub({ '/core/v1/markets': { results: [] } }),
    getBorosOrders: () => installed,
    borosAgent: {
      envPath,
      hardenConfigDir: true,
      setOrderClient: (c) => {
        installed = c;
      },
    },
  });
});

afterEach(async () => {
  await app?.close();
  app = null;
  for (const k of ENV_KEYS) delete process.env[k];
});

const put = (payload: unknown) =>
  app!.inject({ method: 'PUT', url: '/api/boros/agent', headers: HOST, payload: payload as object });

const good = { root: ROOT, accountId: 0, agentPrivateKey: AGENT_KEY };

describe('PUT /api/boros/agent', () => {
  it('installs a live order client without a restart', async () => {
    expect(installed).toBeUndefined();
    const res = await put(good);
    expect(res.statusCode).toBe(200);
    expect(installed).toBeDefined();
    expect(res.json().data).toMatchObject({ configured: true, root: ROOT, accountId: 0 });
  });

  it('refuses a root PRIVATE key outright', async () => {
    const res = await put({ ...good, root: `0x${'b'.repeat(64)}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/never accepts a root wallet key/i);
    expect(installed).toBeUndefined();
  });

  it('never echoes the agent key back', async () => {
    const res = await put(good);
    expect(res.payload).not.toContain(AGENT_KEY);
    expect(res.payload).not.toContain('aaaa');
  });

  it('does not quote a malformed key in the error', async () => {
    const bad = `0x${'c'.repeat(40)}`;
    const res = await put({ ...good, agentPrivateKey: bad });
    expect(res.statusCode).toBe(400);
    expect(res.payload).not.toContain(bad);
  });

  it('writes the .env 0600 and its directory 0700', async () => {
    await put(good);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(envPath)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`BOROS_AGENT_PRIVATE_KEY=${AGENT_KEY}`);
  });

  it.each([
    ['a bad root address', { root: '0xnope' }],
    ['a missing key', { agentPrivateKey: undefined }],
    ['a negative accountId', { accountId: -1 }],
  ])('rejects %s', async (_label, over) => {
    const res = await put({ ...good, ...over });
    expect(res.statusCode).toBe(400);
    expect(installed).toBeUndefined();
  });

  it('refuses an expiry that is a DURATION rather than a timestamp', async () => {
    // 31,536,000 ("a year in seconds") is 1971 as a unix timestamp. Accepting it
    // stores an agent that is already expired and fails every order.
    const res = await put({ ...good, expiry: 365 * 24 * 3600 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/ABSOLUTE unix timestamp, not a duration/);
    expect(installed).toBeUndefined();
  });

  it('stores a valid absolute expiry and reports it back', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const res = await put({ ...good, expiry });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.expiry).toBe(expiry);
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`BOROS_AGENT_EXPIRY=${expiry}`);

    const status = await app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST });
    expect(status.json().data).toMatchObject({ expiry, expired: false });
  });

  it('reports a lapsed approval as expired instead of leaving it to fail at order time', async () => {
    const past = Math.floor(Date.now() / 1000) + 60;
    await put({ ...good, expiry: past });
    process.env.BOROS_AGENT_EXPIRY = String(Math.floor(Date.now() / 1000) - 1);
    const status = await app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST });
    expect(status.json().data.expired).toBe(true);
  });

  it('writes no RPC list — orders go through the relayer, not a node', async () => {
    await put(good);
    expect(fs.readFileSync(envPath, 'utf8')).not.toContain('BOROS_RPC_URLS=http');
  });
});

describe('GET /api/boros/agent', () => {
  it('reports unconfigured before provisioning, and never leaks the key after', async () => {
    const before = await app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST });
    expect(before.json().data).toMatchObject({ configured: false, canProvision: true });

    await put(good);
    const after = await app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST });
    expect(after.json().data).toMatchObject({ configured: true, root: ROOT });
    expect(after.json().data.rootMasked).toBe('0x1111…1111');
    expect(after.payload).not.toContain(AGENT_KEY);
    // No field carries the key under any name.
    expect(JSON.stringify(after.json())).not.toMatch(/aaaaaaaa/);
  });
});

describe('DELETE /api/boros/agent', () => {
  it('drops the client and clears the file, and says it has NOT revoked on-chain', async () => {
    await put(good);
    expect(installed).toBeDefined();

    const res = await app!.inject({ method: 'DELETE', url: '/api/boros/agent', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(installed).toBeUndefined();
    expect(fs.readFileSync(envPath, 'utf8')).not.toContain(AGENT_KEY);
    // Implying this revoked the approval would be a dangerous overstatement.
    expect(res.json().data.note).toMatch(/still live until you revoke it/i);
  });
});

describe('GET /api/boros/agent — the prepaid gas balance', () => {
  const configure = () => {
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
  };
  const get = () => app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST });
  const gasStub = (impl: () => Promise<number | null>) => {
    installed = { getGasBalance: impl } as unknown as BorosOrderClient;
  };

  it('reports the balance, so "trading enabled" is not the only claim on the line', async () => {
    configure();
    gasStub(async () => 4.2);
    expect((await get()).json().data.gasBalanceUsd).toBe(4.2);
  });

  it('reports null when the read fails, never a zero that would read as empty', async () => {
    configure();
    gasStub(async () => {
      throw new Error('boros unreachable');
    });
    expect((await get()).json().data.gasBalanceUsd).toBeNull();
  });

  it('omits it on an install that cannot place orders at all', async () => {
    configure();
    installed = undefined;
    expect((await get()).json().data.gasBalanceUsd).toBeUndefined();
  });

  it('reads no gas for an unconfigured account', async () => {
    let reads = 0;
    gasStub(async () => {
      reads += 1;
      return 4.2;
    });
    expect((await get()).json().data).toMatchObject({ configured: false });
    expect(reads).toBe(0);
  });

  it('serves repeated polls from one Boros read', async () => {
    configure();
    let reads = 0;
    gasStub(async () => {
      reads += 1;
      return 4.2;
    });
    await get();
    await get();
    await get();
    expect(reads).toBe(1);
  });
});
