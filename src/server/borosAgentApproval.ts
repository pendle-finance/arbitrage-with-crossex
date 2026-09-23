/**
 * Is the stored agent key approved on-chain right now?
 *
 * The .env expiry is only what the terminal ASKED for. It stays in place when
 * the trader rejects the approval, when the relay fails, and after a revoke in
 * the Boros app. Only the chain knows, so this reads it.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { fetchBorosAgentExpiry, type FetchLike } from '../core/boros/client';

export type AgentApproval =
  /** Approved and not expired. */
  | { state: 'approved'; expiry: number }
  /** Approved once, and the approval ended. */
  | { state: 'expired'; expiry: number }
  /** Never approved, or revoked. */
  | { state: 'not-approved'; expiry: null }
  /** The read failed. Fall back to the .env expiry. */
  | { state: 'unknown'; expiry: null };

/** A good answer is kept this long. A "not approved" answer is never kept,
 * so the check right after a login sees the approval land. */
const APPROVED_TTL_MS = 60_000;

let cached: { key: string; at: number; value: AgentApproval } | null = null;
/** The last key seen approved, so `onApproved` fires once per login. */
let announced: string | null = null;

/** For tests. */
export const resetAgentApprovalCache = (): void => {
  cached = null;
  announced = null;
};

export async function readAgentApproval(
  fetchImpl: FetchLike,
  input: { root: string; accountId: number; agentPrivateKey: string },
  opts: { fresh?: boolean; now?: number; onApproved?: () => void } = {},
): Promise<AgentApproval> {
  let agent: string;
  try {
    agent = privateKeyToAccount(input.agentPrivateKey as `0x${string}`).address;
  } catch {
    return { state: 'unknown', expiry: null };
  }
  const key = `${input.root.toLowerCase()}:${input.accountId}:${agent.toLowerCase()}`;
  const nowMs = opts.now ?? Date.now();
  if (!opts.fresh && cached?.key === key && nowMs - cached.at < APPROVED_TTL_MS) return cached.value;

  let value: AgentApproval;
  try {
    const expiry = await fetchBorosAgentExpiry(fetchImpl, { root: input.root, accountId: input.accountId, agent });
    if (expiry === 0) value = { state: 'not-approved', expiry: null };
    else if (expiry <= Math.floor(nowMs / 1000)) value = { state: 'expired', expiry };
    else value = { state: 'approved', expiry };
  } catch {
    return { state: 'unknown', expiry: null };
  }
  cached = value.state === 'not-approved' ? null : { key, at: nowMs, value };
  if (value.state === 'approved' && announced !== key) {
    // The first read of a new approval. On startup this fires once for the
    // key already in place, which is a harmless extra sync.
    announced = key;
    opts.onApproved?.();
  }
  return value;
}
