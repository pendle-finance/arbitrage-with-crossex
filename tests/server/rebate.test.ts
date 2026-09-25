/**
 * GET /api/boros/rebate — returns the logged-in account's rebate config, null
 * when no agent is configured, when the account is not rebated, and null (never
 * an error) when the backend read fails. The rebate lookup must never break the
 * panels it feeds.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const ROOT = '0x9dcf85824e024fea9e3ef583dccbea68edbc37b8';
const AGENT_KEY = `0x${'11'.repeat(32)}`;
const ENV_KEYS = ['BOROS_ROOT_ADDRESS', 'BOROS_ACCOUNT_ID', 'BOROS_AGENT_PRIVATE_KEY'] as const;

let app: FastifyInstance | undefined;
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const k of ENV_KEYS) delete process.env[k];
});

const get = () => app!.inject({ method: 'GET', url: '/api/boros/rebate', headers: HOST });

describe('GET /api/boros/rebate', () => {
  it('returns null when no agent is configured (public / view-only)', async () => {
    app = makeTestApp({ borosFetch: borosStub({}), cache: new TtlCache() });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });

  it('returns the rebate config for a rebated account', async () => {
    app = makeTestApp({
      cache: new TtlCache(),
      borosFetch: borosStub({
        '/apis/v1/crossex-rebate/status': {
          root: ROOT,
          accountId: 0,
          rebate: {
            mode: 'relative',
            settlementFeePercentage: 0.8,
            rebateBps: 2000,
            startTimestamp: 1790294400,
            endTimestamp: null,
            marketIds: null,
            active: true,
          },
        },
      }),
    });
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
    const res = await get();
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.mode).toBe('relative');
    expect(data.rebateBps).toBe(2000);
    expect(data.settlementFeePercentage).toBe(0.8);
    expect(data.startTimestamp).toBe(1790294400);
    expect(data.active).toBe(true);
  });

  it('returns null for a configured-but-not-rebated account', async () => {
    app = makeTestApp({
      cache: new TtlCache(),
      borosFetch: borosStub({
        '/apis/v1/crossex-rebate/status': { root: ROOT, accountId: 0, rebate: null },
      }),
    });
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });

  it('degrades to null when the backend read fails, never an error', async () => {
    app = makeTestApp({
      cache: new TtlCache(),
      // No handler for the status path ⇒ 404 ⇒ the client throws.
      borosFetch: borosStub({}),
    });
    process.env.BOROS_ROOT_ADDRESS = ROOT;
    process.env.BOROS_AGENT_PRIVATE_KEY = AGENT_KEY;
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().data).toBeNull();
  });
});
