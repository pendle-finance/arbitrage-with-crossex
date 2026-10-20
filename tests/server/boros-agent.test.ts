/**
 * /api/boros/agent — the browser-provisioned agent key.
 *
 * The properties worth pinning are all safety ones: a root PRIVATE key is
 * refused outright, the key is never echoed back or exposed by GET, the file it
 * lands in is 0600, provisioning hot-swaps the live client without a restart,
 * an approval Boros does not confirm puts the replaced login back, and
 * DELETE is honest that it has not revoked anything on-chain.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BorosOrderClient } from '../../src/core/boros/orders';
import { readAgentApproval, resetAgentApprovalCache } from '../../src/server/borosAgentApproval';
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
  'BOROS_PREV_ROOT_ADDRESS',
  'BOROS_PREV_ACCOUNT_ID',
  'BOROS_PREV_AGENT_PRIVATE_KEY',
  'BOROS_PREV_AGENT_EXPIRY',
];

beforeEach(() => {
  resetAgentApprovalCache();
  envPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boros-agent-')), '.env');
  installed = undefined;
  for (const k of ENV_KEYS) delete process.env[k];
  app = makeTestApp({
    borosFetch: borosStub({ '/apis/v1/markets': { results: [] } }),
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

describe('GET /api/boros/agent — no gas balance', () => {
  const get = () => app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST });

  it('touches no Boros read and answers no gas field — orders fund their own gas', async () => {
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
    let reads = 0;
    installed = {
      getGasBalance: async () => {
        reads += 1;
        return 4.2;
      },
    } as unknown as BorosOrderClient;

    const { data } = (await get()).json();
    expect(reads).toBe(0);
    expect('gasBalanceUsd' in data).toBe(false);
    expect(data.configured).toBe(true);
  });
});

describe('GET /api/boros/agent — the on-chain approval', () => {
  const withChainExpiry = async (expiryTime: number | undefined) => {
    await app?.close();
    resetAgentApprovalCache();
    const bodies: Record<string, unknown> = { '/apis/v1/markets': { results: [] } };
    if (expiryTime !== undefined) bodies['/apis/v1/agents/expiry-time'] = { expiryTime };
    app = makeTestApp({
      borosFetch: borosStub(bodies),
      getBorosOrders: () => installed,
      borosAgent: { envPath, hardenConfigDir: true, setOrderClient: (c) => (installed = c) },
    });
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
    // What the terminal asked for: a year out.
    process.env.BOROS_AGENT_EXPIRY = String(Math.floor(Date.now() / 1000) + 365 * 86400);
    return (await app.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST })).json().data;
  };

  it('says not-approved when the chain has no approval, though the .env expiry is a year out', async () => {
    // A rejected wallet prompt, or a revoke in the Boros app.
    const data = await withChainExpiry(0);
    expect(data).toMatchObject({ configured: true, approval: 'not-approved', expired: false });
  });

  it('reports the chain expiry, not the one the terminal asked for', async () => {
    const onChain = Math.floor(Date.now() / 1000) + 30 * 86400;
    expect(await withChainExpiry(onChain)).toMatchObject({ approval: 'approved', expiry: onChain, expired: false });
  });

  it('says expired when the chain expiry has passed', async () => {
    const onChain = Math.floor(Date.now() / 1000) - 60;
    expect(await withChainExpiry(onChain)).toMatchObject({ approval: 'expired', expiry: onChain, expired: true });
  });

  it('falls back to the .env expiry when Boros cannot be read', async () => {
    expect(await withChainExpiry(undefined)).toMatchObject({ approval: 'unknown', expired: false });
  });

  it('has no approval field when no key is stored', async () => {
    await withChainExpiry(0);
    delete process.env.BOROS_AGENT_PRIVATE_KEY;
    const data = (await app!.inject({ method: 'GET', url: '/api/boros/agent', headers: HOST })).json().data;
    expect(data).toMatchObject({ configured: false, approval: null });
  });
});

describe('GET /api/boros/agent — sync alerts when a login lands', () => {
  it('calls onApproved once, when the chain first shows the new key approved', async () => {
    await app?.close();
    resetAgentApprovalCache();
    let expiryTime = 0;
    let approvedCalls = 0;
    app = makeTestApp({
      borosFetch: async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes('/agents/expiry-time') ? { expiryTime } : { results: [] }),
      }),
      getBorosOrders: () => installed,
      borosAgent: {
        envPath,
        hardenConfigDir: true,
        setOrderClient: (c) => (installed = c),
        onApproved: () => (approvedCalls += 1),
      },
    });
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
    const get = () => app!.inject({ method: 'GET', url: '/api/boros/agent?fresh=1', headers: HOST });

    await get(); // the relay has not landed yet
    expect(approvedCalls).toBe(0);
    expiryTime = Math.floor(Date.now() / 1000) + 86400;
    await get();
    await get();
    expect(approvedCalls).toBe(1);
  });
});

describe('keep the previous login until the new one is approved', () => {
  const ROOT_B = `0x${'2'.repeat(40)}`;
  const KEY_B = `0x${'b'.repeat(64)}`;
  const EXPIRY_A = Math.floor(Date.now() / 1000) + 30 * 86400;
  const envFile = () => fs.readFileSync(envPath, 'utf8');

  it('PUT stashes the login it replaces, and the reply carries no key', async () => {
    await put({ ...good, accountId: 3, expiry: EXPIRY_A });
    const res = await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B });
    expect(res.statusCode).toBe(200);
    expect(envFile()).toContain(`BOROS_PREV_ROOT_ADDRESS=${ROOT}`);
    expect(envFile()).toContain('BOROS_PREV_ACCOUNT_ID=3');
    expect(envFile()).toContain(`BOROS_PREV_AGENT_PRIVATE_KEY=${AGENT_KEY}`);
    expect(envFile()).toContain(`BOROS_PREV_AGENT_EXPIRY=${EXPIRY_A}`);
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(KEY_B);
    expect(res.payload).not.toContain(AGENT_KEY);
    expect(res.payload).not.toContain(KEY_B);
  });

  it('PUT with no login in place stashes nothing', async () => {
    await put(good);
    expect(envFile()).toContain('BOROS_PREV_AGENT_PRIVATE_KEY=\n');
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBeUndefined();
  });

  it('a second PUT before any approval keeps the first stash, the last login that worked', async () => {
    await put(good);
    await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B });
    await put({ root: ROOT_B, accountId: 0, agentPrivateKey: `0x${'c'.repeat(64)}` });
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
  });

  it('DELETE clears the stash', async () => {
    await put(good);
    await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B });
    await app!.inject({ method: 'DELETE', url: '/api/boros/agent', headers: HOST });
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBeUndefined();
    expect(envFile()).not.toContain(AGENT_KEY);
  });

  it('clears the stash when the chain first shows the new key approved', async () => {
    await app?.close();
    resetAgentApprovalCache();
    let expiryTime = 0;
    let approvedCalls = 0;
    app = makeTestApp({
      borosFetch: async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes('/agents/expiry-time') ? { expiryTime } : { results: [] }),
      }),
      getBorosOrders: () => installed,
      borosAgent: {
        envPath,
        hardenConfigDir: true,
        setOrderClient: (c) => (installed = c),
        onApproved: () => (approvedCalls += 1),
      },
    });
    await put(good);
    await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B });
    const get = () => app!.inject({ method: 'GET', url: '/api/boros/agent?fresh=1', headers: HOST });

    const pending = await get();
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
    expect(pending.payload).not.toContain(AGENT_KEY);
    expect(pending.payload).not.toContain(KEY_B);

    expiryTime = Math.floor(Date.now() / 1000) + 86400;
    await get();
    expect(approvedCalls).toBe(1);
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBeUndefined();
    expect(envFile()).not.toContain(AGENT_KEY);
  });
});

describe('PUT with the signed approval: the server sends it to Boros', () => {
  const ROOT_B = `0x${'2'.repeat(40)}`;
  const KEY_B = `0x${'b'.repeat(64)}`;
  const CALLDATA = `0x${'ab'.repeat(40)}`;
  type Answer = { status: number; body?: unknown } | Error;
  let answer: Answer;
  let gate: Promise<void> | null;
  let expiryGate: Promise<void> | null;
  let chainExpiry: number;
  let relays: { url: string; body: unknown; liveKey?: string }[];

  beforeEach(async () => {
    await app?.close();
    answer = { status: 201, body: { approveAgentResult: { txHash: '0xtx', status: 'success' } } };
    gate = null;
    expiryGate = null;
    chainExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
    relays = [];
    app = makeTestApp({
      borosFetch: async (url, init) => {
        if (url.includes('/agents/expiry-time')) {
          if (expiryGate) await expiryGate;
          return { ok: true, status: 200, json: async () => ({ expiryTime: chainExpiry }) };
        }
        if (!url.includes('/send-txs/approve')) return { ok: true, status: 200, json: async () => ({ results: [] }) };
        relays.push({ url, body: JSON.parse(init?.body ?? 'null'), liveKey: process.env.BOROS_AGENT_PRIVATE_KEY });
        if (gate) await gate;
        if (answer instanceof Error) throw answer;
        const { status, body } = answer;
        return { ok: status < 400, status, json: async () => body ?? null };
      },
      getBorosOrders: () => installed,
      borosAgent: { envPath, hardenConfigDir: true, setOrderClient: (c) => (installed = c) },
    });
  });

  const login = (calldata: unknown = CALLDATA) =>
    put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B, approveAgentCalldata: calldata });

  it('saves the key first, then sends the exact calldata to Boros with the client tag', async () => {
    await put(good);
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ configured: true, root: ROOT_B });
    expect(relays).toHaveLength(1);
    expect(relays[0].url).toMatch(/\/apis\/v1\/send-txs\/approve\?pendle_client=boroscrossex/);
    expect(relays[0].body).toEqual({ approveAgentCalldata: CALLDATA });
    expect(relays[0].liveKey).toBe(KEY_B);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(KEY_B);
    // Cleared later, when the chain first shows KEY_B approved.
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
    expect(res.payload).not.toContain(KEY_B);
  });

  it('keeps the new key when Boros says success with an error it could not decode', async () => {
    await put(good);
    answer = { status: 201, body: { approveAgentResult: { status: 'success', error: '[EXECUTE] decode mismatch' } } };
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(KEY_B);
  });

  it.each<[string, Answer]>([
    ['a bad signature', { status: 400, body: { message: 'Invalid signature for approveAgent message' } }],
    ['a revert', { status: 201, body: { approveAgentResult: { status: 'reverted', error: '[SIMULATE] AuthInvalidNonce()' } } }],
    ['a 422: nothing was sent', { status: 422, body: { message: 'transaction rejected' } }],
    ['a 408: the tx is still in flight', { status: 408, body: { message: 'transaction is still being sent' } }],
    ['the catch-all 400', { status: 400, body: { message: 'Failed to approve agent: receipt timeout' } }],
    ['a 5xx', { status: 503, body: null }],
    ['no answer at all', new Error('socket hang up')],
  ])('on %s, puts the replaced login back and says so', async (_name, failure) => {
    await put({ ...good, accountId: 3 });
    const before = installed;
    answer = failure;
    const res = await login();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/^Boros .*\. 0x1111…1111 is still logged in\.$/);
    expect(res.json().error.retryable).toBe(false);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
    expect(process.env.BOROS_ACCOUNT_ID).toBe('3');
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBeUndefined();
    expect(installed).not.toBe(before);
    expect(fs.readFileSync(envPath, 'utf8')).not.toContain(KEY_B);
    expect(res.payload).not.toContain(AGENT_KEY);
  });

  it('keeps Boros text word for word', async () => {
    answer = { status: 400, body: { message: 'Invalid signature for approveAgent message' } };
    const res = await login();
    expect(res.json().error.message).toBe(
      'Boros /v1/send-txs/approve failed (HTTP 400): Invalid signature for approveAgent message.',
    );
    for (const k of ENV_KEYS) delete process.env[k];
    answer = { status: 201, body: { approveAgentResult: { status: 'reverted', error: '[SIMULATE] AuthInvalidNonce()' } } };
    expect((await login()).json().error.message).toBe('Boros refused the approval: [SIMULATE] AuthInvalidNonce().');
  });

  it('answers 429 when Boros rate-limits, and puts the login back', async () => {
    await put(good);
    answer = { status: 429, body: { message: 'Approving agents too frequently' } };
    const res = await login();
    expect(res.statusCode).toBe(429);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
  });

  it('does not call a login "still logged in" when the chain shows it dead', async () => {
    await put(good);
    chainExpiry = 0;
    answer = { status: 400, body: { message: 'Invalid signature for approveAgent message' } };
    const res = await login();
    expect(res.json().error.message).not.toMatch(/still logged in/);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
  });

  it('a failed first login has nothing to put back: the key stays and the status shows if it lands', async () => {
    answer = { status: 408, body: { message: 'transaction is still being sent' } };
    const res = await login();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).not.toMatch(/still logged in/);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(KEY_B);
  });

  it('does not undo a login that replaced this one while Boros was answering', async () => {
    await put(good);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    answer = { status: 400, body: { message: 'Invalid signature for approveAgent message' } };
    const pending = login();
    await vi.waitFor(() => expect(relays).toHaveLength(1));
    const KEY_C = `0x${'c'.repeat(64)}`;
    await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_C });
    release();
    const res = await pending;
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).not.toMatch(/still logged in/);
    expect(process.env.BOROS_AGENT_PRIVATE_KEY).toBe(KEY_C);
  });

  it('a status read of the old key that lands after a new PUT keeps the stash', async () => {
    await put(good);
    let release!: () => void;
    expiryGate = new Promise((r) => (release = r));
    const read = app!.inject({ method: 'GET', url: '/api/boros/agent?fresh=1', headers: HOST });
    await new Promise((r) => setTimeout(r, 20));
    await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B });
    release();
    await read;
    expect(process.env.BOROS_PREV_AGENT_PRIVATE_KEY).toBe(AGENT_KEY);
  });

  it('a key that cannot be saved is a plain refusal, and nothing goes to Boros', async () => {
    await app?.close();
    app = makeTestApp({
      borosFetch: async () => {
        relays.push({ url: 'called', body: null });
        return { ok: true, status: 200, json: async () => ({}) };
      },
      getBorosOrders: () => installed,
      borosAgent: { envPath: path.dirname(envPath), hardenConfigDir: true, setOrderClient: (c) => (installed = c) },
    });
    const res = await login();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/^Could not save the login on this machine: /);
    expect(res.json().error.retryable).toBe(false);
    expect(relays).toHaveLength(0);
  });

  it('refuses calldata that is not hex, before saving or sending anything', async () => {
    const res = await login('nope');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('approveAgentCalldata must be 0x hex');
    expect(relays).toHaveLength(0);
    expect(installed).toBeUndefined();
  });

  it('without calldata, only saves the key and sends nothing', async () => {
    const res = await put({ root: ROOT_B, accountId: 0, agentPrivateKey: KEY_B });
    expect(res.statusCode).toBe(200);
    expect(relays).toHaveLength(0);
  });
});

describe('readAgentApproval — a slow Boros', () => {
  it('answers unknown when the read passes its timeout', async () => {
    resetAgentApprovalCache();
    const started = Date.now();
    const approval = await readAgentApproval(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { root: ROOT, accountId: 0, agentPrivateKey: AGENT_KEY },
      { timeoutMs: 50 },
    );
    expect(approval).toEqual({ state: 'unknown', expiry: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not use up the approval announcement when read with no listener', async () => {
    resetAgentApprovalCache();
    const expiryTime = Math.floor(Date.now() / 1000) + 86400;
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ expiryTime }) });
    const input = { root: ROOT, accountId: 0, agentPrivateKey: AGENT_KEY };
    await readAgentApproval(fetchImpl, input, { fresh: true });
    let calls = 0;
    await readAgentApproval(fetchImpl, input, { fresh: true, onApproved: () => (calls += 1) });
    expect(calls).toBe(1);
  });
});
