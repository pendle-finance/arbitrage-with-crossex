/**
 * The rebate client: how it authenticates (packed account + agent + a fresh
 * EIP-712 timestamp signature), how it parses a rebate config, and how it pages
 * the settlements feed. The Boros HTTP layer is a plain fetch stub — no network.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { FetchLike } from '../../src/core/boros/client';
import { makeRebateClient } from '../../src/core/boros/rebateApi';
import { packAccount } from '../../src/core/boros/borosApi';

const ROOT = '0x9dcf85824e024fea9e3ef583dccbea68edbc37b8' as const;
const AGENT_KEY = `0x${'11'.repeat(32)}` as const;
const AGENT_ADDR = privateKeyToAccount(AGENT_KEY).address;
const START = 1790294400;

/** Records every request and answers each pathname from `bodies`. */
function stub(bodies: Record<string, unknown>, calls: URL[] = []): FetchLike {
  return async (url: string) => {
    const u = new URL(url);
    calls.push(u);
    const body = bodies[u.pathname];
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => body };
  };
}

const client = (fetchImpl: FetchLike, accountId = 0) =>
  makeRebateClient({ root: ROOT, accountId, agentPrivateKey: AGENT_KEY, baseUrl: 'https://x/apis', fetchImpl });

const relative = {
  mode: 'relative',
  settlementFeePercentage: 0.8,
  rebateBps: 2000,
  startTimestamp: START,
  endTimestamp: null,
  marketIds: null,
  active: true,
};

describe('makeRebateClient — auth params', () => {
  it('signs with the agent and carries account/agent/signature/timestamp', async () => {
    const calls: URL[] = [];
    await client(stub({ '/apis/v1/crossex-rebate/status': { rebate: relative } }, calls), 3).status();
    expect(calls).toHaveLength(1);
    const q = calls[0].searchParams;
    expect(q.get('account')).toBe(packAccount(ROOT, 3));
    expect(q.get('agent')).toBe(AGENT_ADDR);
    expect(q.get('signature')).toMatch(/^0x[0-9a-f]+$/i);
    const ts = Number(q.get('timestamp'));
    // Milliseconds, recent.
    expect(ts).toBeGreaterThan(Date.now() - 60_000);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});

describe('makeRebateClient — status', () => {
  it('parses a relative rebate config', async () => {
    const s = await client(stub({ '/apis/v1/crossex-rebate/status': { root: ROOT, accountId: 0, rebate: relative } })).status();
    expect(s.rebate).not.toBeNull();
    expect(s.rebate?.mode).toBe('relative');
    expect(s.rebate?.settlementFeePercentage).toBe(0.8);
    expect(s.rebate?.rebateBps).toBe(2000);
    expect(s.rebate?.startTimestamp).toBe(START);
    expect(s.rebate?.marketIds).toBeNull();
    expect(s.rebate?.active).toBe(true);
  });

  it('parses an absolute rebate config with a market filter', async () => {
    const s = await client(
      stub({
        '/apis/v1/crossex-rebate/status': {
          rebate: { mode: 'absolute', settlementFeePercentage: 0.05, rebateBps: null, startTimestamp: START, endTimestamp: START + 1000, marketIds: [155, 158], active: true },
        },
      }),
    ).status();
    expect(s.rebate?.mode).toBe('absolute');
    expect(s.rebate?.settlementFeePercentage).toBe(0.05);
    expect(s.rebate?.rebateBps).toBeNull();
    expect(s.rebate?.marketIds).toEqual([155, 158]);
    expect(s.rebate?.endTimestamp).toBe(START + 1000);
  });

  it('normalises a non-rebated account to rebate null', async () => {
    const s = await client(stub({ '/apis/v1/crossex-rebate/status': { root: ROOT, accountId: 0, rebate: null } })).status();
    expect(s.rebate).toBeNull();
  });

  it('treats a garbage rebate field as no rebate', async () => {
    const s = await client(stub({ '/apis/v1/crossex-rebate/status': { rebate: { mode: 'weird' } } })).status();
    expect(s.rebate).toBeNull();
  });
});

describe('makeRebateClient — settlements paging', () => {
  it('follows resumeToken to the end and concatenates every page', async () => {
    const calls: URL[] = [];
    let page = 0;
    const fetchImpl: FetchLike = async (url: string) => {
      const u = new URL(url);
      calls.push(u);
      page += 1;
      const body =
        page === 1
          ? { results: [{ marketId: 1, tokenId: 3, timestamp: 1000, eventIndex: 0, settlementFeeX18: '10', rebateX18: '2' }], resumeToken: 'p2' }
          : { results: [{ marketId: 2, tokenId: 3, timestamp: 2000, eventIndex: 1, settlementFeeX18: '20', rebateX18: '4' }], resumeToken: null };
      return { ok: true, status: 200, json: async () => body };
    };
    const rows = await client(fetchImpl).settlements(START);
    expect(rows.map((r) => r.rebateX18)).toEqual(['2', '4']);
    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.get('fromTimestamp')).toBe(String(START));
    expect(calls[1].searchParams.get('resumeToken')).toBe('p2');
  });

  it('stops on an empty page even if a resumeToken is echoed', async () => {
    const rows = await client(
      stub({ '/apis/v1/crossex-rebate/settlements': { results: [], resumeToken: 'loop' } }),
    ).settlements(0);
    expect(rows).toEqual([]);
  });
});
