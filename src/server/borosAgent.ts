/**
 * Boros agent-key configuration, resolved once at boot.
 *
 * WHAT THIS KEY IS, AND IS NOT. Boros signs order placement with a DELEGATED
 * AGENT key that the root wallet approves on-chain once. Deposits, withdrawals
 * and cash transfers require the root wallet's own signature, and this install
 * never holds that. So the worst a leaked agent key can do is TRADE the account
 * — it cannot move a single token out. That is the whole reason this feature
 * can exist in a tool whose promise is that it never holds your funds, and it
 * is why no code path here ever accepts a root private key.
 *
 * The one-time setup (`Agent.create` → `approveAgent`, plus `payTreasury` for
 * gas) is deliberately NOT done here: it needs the root wallet, so the user
 * performs it in the Boros app and pastes only the resulting agent key.
 *
 * Config lives in the same `.env` as the Gate credentials and inherits its 0600
 * hardening. Absent or malformed config is not an error — it leaves
 * `deps.borosOrders` undefined, which keeps the panel fully usable for pricing
 * and answers 503 on execute.
 */
import { CoreError } from '../core/errors';

/** 0x + 64 hex chars. */
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface BorosAgentConfig {
  root: `0x${string}`;
  accountId: number;
  agentPrivateKey: `0x${string}`;
}

/**
 * Read the agent config from the environment.
 *
 * Returns null when it is simply absent — the normal state for an install that
 * only watches. THROWS when it is present but wrong, because a half-configured
 * key is a mistake the user needs told about, not something to silently ignore
 * into a 503 they will read as "not supported".
 *
 * Never logs, echoes or returns the key in any error message.
 */
export function readBorosAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): BorosAgentConfig | null {
  const key = env.BOROS_AGENT_PRIVATE_KEY?.trim();
  const root = env.BOROS_ROOT_ADDRESS?.trim();
  if (!key && !root) return null;

  if (!key) {
    throw new CoreError(
      'BOROS_ROOT_ADDRESS is set but BOROS_AGENT_PRIVATE_KEY is missing — Boros order placement stays disabled.',
      'not-configured',
    );
  }
  if (!PRIVATE_KEY_RE.test(key)) {
    // Deliberately does not quote the value.
    throw new CoreError(
      'BOROS_AGENT_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key.',
      'validation',
    );
  }
  if (!root || !ADDRESS_RE.test(root)) {
    throw new CoreError(
      'BOROS_ROOT_ADDRESS must be the 0x address of the account the agent trades for.',
      'validation',
    );
  }

  const rawAccountId = env.BOROS_ACCOUNT_ID?.trim();
  const accountId = rawAccountId ? Number(rawAccountId) : 0;
  if (!Number.isInteger(accountId) || accountId < 0) {
    throw new CoreError('BOROS_ACCOUNT_ID must be a non-negative integer.', 'validation');
  }

  return {
    root: root as `0x${string}`,
    accountId,
    agentPrivateKey: key as `0x${string}`,
  };
}
