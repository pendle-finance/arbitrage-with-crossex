/**
 * Boros agent-key config (src/server/borosAgent.ts). The load-bearing property
 * is that absent config is SILENT (a watching install is the normal case) while
 * broken config is LOUD — a half-set key must not degrade into a 503 the user
 * reads as "not supported".
 */
import { describe, expect, it } from 'vitest';
import { readBorosAgentConfig } from '../../src/server/borosAgent';

const KEY = `0x${'a'.repeat(64)}`;
const ROOT = `0x${'1'.repeat(40)}`;

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  BOROS_AGENT_PRIVATE_KEY: KEY,
  BOROS_ROOT_ADDRESS: ROOT,
  ...over,
});

describe('readBorosAgentConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(readBorosAgentConfig({})).toBeNull();
  });

  it('reads a complete config and defaults the account', () => {
    expect(readBorosAgentConfig(env())).toEqual({
      root: ROOT,
      accountId: 0,
      agentPrivateKey: KEY,
    });
  });

  it('accepts an explicit account id', () => {
    expect(readBorosAgentConfig(env({ BOROS_ACCOUNT_ID: '3' }))).toMatchObject({ accountId: 3 });
  });

  it('throws — not returns null — when the key is set but malformed', () => {
    expect(() => readBorosAgentConfig(env({ BOROS_AGENT_PRIVATE_KEY: '0xnope' }))).toThrow(
      /32-byte hex key/,
    );
  });

  it('never echoes the key in an error', () => {
    const secret = `0x${'b'.repeat(63)}`; // one char short
    try {
      readBorosAgentConfig(env({ BOROS_AGENT_PRIVATE_KEY: secret }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
      expect((err as Error).message).not.toContain('bbbb');
    }
  });

  it('rejects a half-configured pair rather than guessing', () => {
    expect(() => readBorosAgentConfig({ BOROS_ROOT_ADDRESS: ROOT })).toThrow(/missing/);
    expect(() => readBorosAgentConfig({ BOROS_AGENT_PRIVATE_KEY: KEY })).toThrow(/0x address/);
  });

  it('rejects a malformed root address or account id', () => {
    expect(() => readBorosAgentConfig(env({ BOROS_ROOT_ADDRESS: '0x123' }))).toThrow(/0x address/);
    expect(() => readBorosAgentConfig(env({ BOROS_ACCOUNT_ID: '-1' }))).toThrow(/non-negative/);
  });

  it('ignores a leftover BOROS_RPC_URLS rather than failing on it', () => {
    // Orders go through the Boros relayer; nothing here opens a chain
    // connection. An .env written by an older build must still load — and a
    // stale `wss://` in it must not cost the user their Boros trading.
    expect(readBorosAgentConfig(env({ BOROS_RPC_URLS: 'wss://a.example' }))).toMatchObject({
      root: ROOT,
    });
  });
});
