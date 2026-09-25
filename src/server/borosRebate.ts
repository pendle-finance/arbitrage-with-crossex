/**
 * Builds a rebate client from the CURRENT agent login, or null when none is
 * configured. Read from `process.env` per call, not closed over at boot, because
 * the agent can be provisioned from the browser at runtime (same discipline as
 * the /boros/agent route). The rebate is keyed on the ROOT, so it is offered
 * only for the account this install is logged in as.
 */
import { makeRebateClient, type RebateClient } from '../core/boros/rebateApi';
import { resolveBorosFetch } from '../core/boros/client';
import type { AppDeps } from './app';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** The rebate client for the logged-in root, or null when this install holds no
 * agent key (view-only / public mode) — in which case there is no rebate to show
 * and every UI stays hidden. */
export function currentRebateClient(deps: AppDeps): RebateClient | null {
  const root = process.env.BOROS_ROOT_ADDRESS?.trim();
  const agentPrivateKey = process.env.BOROS_AGENT_PRIVATE_KEY?.trim();
  if (!root || !agentPrivateKey || !ADDRESS_RE.test(root) || !PRIVATE_KEY_RE.test(agentPrivateKey)) {
    return null;
  }
  const accountId = Number(process.env.BOROS_ACCOUNT_ID ?? 0) || 0;
  return makeRebateClient({
    root: root as `0x${string}`,
    accountId,
    agentPrivateKey: agentPrivateKey as `0x${string}`,
    fetchImpl: resolveBorosFetch(deps.borosFetch),
  });
}

/** The lowercase root this install is logged in as, or null. Used to gate the
 * rebate join to the account the agent actually owns. */
export function loggedInRoot(): string | null {
  const root = process.env.BOROS_ROOT_ADDRESS?.trim();
  return root && ADDRESS_RE.test(root) ? root.toLowerCase() : null;
}
