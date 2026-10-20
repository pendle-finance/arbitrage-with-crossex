/**
 * Boros agent provisioning: the browser connects a wallet, generates a
 * delegated agent key, has the ROOT wallet sign its approval, and hands the
 * agent key and the signed approval here. This server sends the approval to
 * Boros.
 *
 *   GET    /api/boros/agent  — masked status
 *   PUT    /api/boros/agent  — install a generated agent key, and send its approval
 *   DELETE /api/boros/agent  — forget it locally
 *
 * WHY THE KEY COMES HERE AT ALL, rather than the browser signing every order:
 * this terminal runs as a background service and its whole safety story is that
 * `/execute` re-runs the §7 gate server-side before anything is sent. If the
 * signer lived in the tab, that gate would degrade to advice — a hand-rolled
 * request could sign around it — and no follow-up (a retry, a §6A close) could
 * happen without someone watching. Handing over a SCOPED key keeps the gate
 * real. The wallet is connected once, for the approval, and never again.
 *
 * WHAT THIS KEY CAN DO: trade this account. Nothing else. Boros requires the
 * root wallet's own signature for deposits, withdrawals and cash transfers, and
 * this server has no verb for any of them. A leaked agent key cannot move a
 * token out — and DELETE here plus a revoke in the Boros app ends it entirely.
 *
 * The root PRIVATE key must never reach this process. The route rejects
 * anything that looks like one being passed as the root field.
 */
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { makeBorosApiOrderClient } from '../../core/boros/borosApi';
import {
  fetchBorosMarkets,
  relayAgentApproval,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
} from '../../core/boros/client';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { readAgentApproval, resetAgentApprovalCache } from '../borosAgentApproval';
import { rewriteEnvFile } from './credentials';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

/** Show enough of the agent key's OWNER to recognise, never the key itself. */
export const maskAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

type AgentService = NonNullable<AppDeps['borosAgent']>;
type AgentLogin = { root: string; accountId: number; agentPrivateKey: string; expiry?: number };

/** The login a PUT replaced. Kept until the chain shows the new key approved,
 * so a refused approval can put the working login back. */
const PREV_KEYS = [
  'BOROS_PREV_ROOT_ADDRESS',
  'BOROS_PREV_ACCOUNT_ID',
  'BOROS_PREV_AGENT_PRIVATE_KEY',
  'BOROS_PREV_AGENT_EXPIRY',
] as const;

const PREV_CLEARED: Record<string, string> = Object.fromEntries(PREV_KEYS.map((k) => [k, '']));

const loginEntries = (login: AgentLogin): Record<string, string> => ({
  BOROS_ROOT_ADDRESS: login.root,
  BOROS_ACCOUNT_ID: String(login.accountId),
  BOROS_AGENT_PRIVATE_KEY: login.agentPrivateKey,
  BOROS_AGENT_EXPIRY: login.expiry === undefined ? '' : String(login.expiry),
});

/** Apply .env entries to this process too. A blank value reads as absent. */
const applyToProcess = (entries: Record<string, string>): void => {
  for (const [k, v] of Object.entries(entries)) {
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
};

const hasPrev = (): boolean => Boolean(process.env.BOROS_PREV_ROOT_ADDRESS && process.env.BOROS_PREV_AGENT_PRIVATE_KEY);

const readPrev = (): AgentLogin => {
  const rawExpiry = Number(process.env.BOROS_PREV_AGENT_EXPIRY);
  return {
    root: process.env.BOROS_PREV_ROOT_ADDRESS ?? '',
    accountId: Number(process.env.BOROS_PREV_ACCOUNT_ID ?? 0) || 0,
    agentPrivateKey: process.env.BOROS_PREV_AGENT_PRIVATE_KEY ?? '',
    expiry: Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : undefined,
  };
};

const clearPrev = (svc: AgentService | undefined): void => {
  if (!PREV_KEYS.some((k) => process.env[k])) return;
  if (svc) rewriteEnvFile(svc.envPath, PREV_CLEARED, svc.hardenConfigDir);
  applyToProcess(PREV_CLEARED);
};

export function borosAgentRoutes(deps: AppDeps) {
  const loadMarkets = () =>
    deps.cache.get('boros:markets', TTL.boros, () => fetchBorosMarkets(resolveBorosFetch(deps.borosFetch)));

  /** Make `login` the live one: .env, this process, and the order client.
   * `extra` lands in the same atomic .env write. */
  const install = (svc: AgentService, login: AgentLogin, extra: Record<string, string>) => {
    const client = makeBorosApiOrderClient({
      root: login.root as `0x${string}`,
      accountId: login.accountId,
      agentPrivateKey: login.agentPrivateKey as `0x${string}`,
      tokenIdForMarket: async (marketId) =>
        (await loadMarkets()).value.find((m) => m.marketId === marketId)?.tokenId,
      collateralPriceUsd: async (tokenId) => resolveCollateralPricesUsd((await loadMarkets()).value).get(tokenId) ?? null,
    });
    const entries = { ...loginEntries(login), ...extra };
    // Persisted the same way as the Gate secret: 0700 dir, 0600 temp file,
    // atomic rename. See rewriteEnvFile.
    rewriteEnvFile(svc.envPath, entries, svc.hardenConfigDir);
    applyToProcess(entries);
    svc.setOrderClient(client);
    resetAgentApprovalCache();
    return {
      configured: true,
      root: login.root,
      rootMasked: maskAddress(login.root),
      accountId: login.accountId,
      expiry: login.expiry ?? null,
    };
  };

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/boros/agent', async (req, reply) => {
      const root = process.env.BOROS_ROOT_ADDRESS;
      const agentPrivateKey = process.env.BOROS_AGENT_PRIVATE_KEY;
      const configured = Boolean(root && agentPrivateKey);
      const accountId = Number(process.env.BOROS_ACCOUNT_ID ?? 0) || 0;
      const rawExpiry = Number(process.env.BOROS_AGENT_EXPIRY);
      const askedExpiry = configured && Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : null;
      const nowSec = Math.floor(Date.now() / 1000);

      // The .env expiry is what the terminal asked for, not what the chain
      // holds: a rejected approval or a revoke leaves it in place.
      const approval =
        configured && root && agentPrivateKey
          ? await readAgentApproval(
              resolveBorosFetch(deps.borosFetch),
              { root, accountId, agentPrivateKey },
              {
                fresh: (req.query as { fresh?: string } | undefined)?.fresh === '1',
                onApproved: () => {
                  // A PUT may have replaced this key while Boros answered. Its
                  // stash is then the login to put back: keep it.
                  if (process.env.BOROS_AGENT_PRIVATE_KEY === agentPrivateKey) clearPrev(deps.borosAgent);
                  deps.borosAgent?.onApproved?.();
                },
              },
            )
          : null;
      const expiry = approval?.expiry ?? askedExpiry;

      return reply.ok({
        configured,
        root: configured ? root : null,
        rootMasked: configured && root ? maskAddress(root) : null,
        accountId: configured ? accountId : null,
        expiry,
        // Surfaced rather than left to show up as AuthAgentExpired() on a
        // confirm the user has already committed to.
        expired:
          approval?.state === 'expired' ||
          (approval?.state === 'unknown' && askedExpiry !== null && askedExpiry <= nowSec),
        // null when no key is stored. 'unknown' when Boros could not be read.
        approval: approval?.state ?? null,
        // The panel needs to know whether provisioning is even possible here.
        canProvision: Boolean(deps.borosAgent),
      });
    });

    app.put('/boros/agent', async (req, reply) => {
      const svc = deps.borosAgent;
      if (!svc) throw new CoreError('Boros agent service not configured on this server');

      const body = req.body as
        | {
            root?: string;
            accountId?: number;
            agentPrivateKey?: string;
            expiry?: number;
            approveAgentCalldata?: string;
          }
        | undefined;
      const root = body?.root?.trim();
      const agentPrivateKey = body?.agentPrivateKey?.trim();

      // The private-key shape is checked FIRST and on its own: a 66-char key
      // also fails the address test, so the generic "must be an address" message
      // would otherwise be the only thing a user who pasted their root key ever
      // saw — and they need telling exactly what they just did.
      if (root && PRIVATE_KEY_RE.test(root)) {
        throw new CoreError(
          'root looks like a private key — send the ADDRESS. This tool never accepts a root wallet key.',
        );
      }
      if (!root || !ADDRESS_RE.test(root)) {
        throw new CoreError('root must be the 0x address of the account the agent trades for');
      }
      if (!agentPrivateKey || !PRIVATE_KEY_RE.test(agentPrivateKey)) {
        // Deliberately does not echo the value.
        throw new CoreError('agentPrivateKey must be a 0x-prefixed 32-byte hex key');
      }

      // Absolute unix seconds, not a duration — the contract stores it verbatim.
      const expiry = body?.expiry;
      if (expiry !== undefined) {
        if (!Number.isFinite(expiry) || !Number.isInteger(expiry) || expiry <= 0) {
          throw new CoreError('expiry must be a positive integer of unix seconds');
        }
        const now = Math.floor(Date.now() / 1000);
        if (expiry <= now) {
          throw new CoreError(
            `expiry ${expiry} is already in the past — it must be an ABSOLUTE unix timestamp, not a duration.`,
          );
        }
      }

      const accountId = body?.accountId ?? 0;
      if (!Number.isInteger(accountId) || accountId < 0) {
        throw new CoreError('accountId must be a non-negative integer');
      }

      // Optional: without it the PUT only installs the key, as it did before
      // the server sent approvals. Scripts that approve elsewhere rely on that.
      const approveAgentCalldata = body?.approveAgentCalldata;
      if (approveAgentCalldata !== undefined && (typeof approveAgentCalldata !== 'string' || !HEX_RE.test(approveAgentCalldata))) {
        throw new CoreError('approveAgentCalldata must be 0x hex');
      }

      // Keep the login this replaces until the new key is approved. When a
      // stash already exists, the current key was never seen approved, so
      // the stash is still the last working login: keep it.
      const prevRoot = process.env.BOROS_ROOT_ADDRESS;
      const prevKey = process.env.BOROS_AGENT_PRIVATE_KEY;
      let stash: Record<string, string> = {};
      if (!prevRoot || !prevKey) stash = PREV_CLEARED;
      else if (!hasPrev()) {
        stash = {
          BOROS_PREV_ROOT_ADDRESS: prevRoot,
          BOROS_PREV_ACCOUNT_ID: process.env.BOROS_ACCOUNT_ID ?? '',
          BOROS_PREV_AGENT_PRIVATE_KEY: prevKey,
          BOROS_PREV_AGENT_EXPIRY: process.env.BOROS_AGENT_EXPIRY ?? '',
        };
      }

      // The key is saved BEFORE the approval is sent. Approving first and then
      // failing to save would leave a live, year-long approval for a key
      // nobody holds. A saved key with no approval is inert: the status reads
      // the chain and shows it as not approved.
      let installed: ReturnType<typeof install>;
      try {
        installed = install(svc, { root, accountId, agentPrivateKey, expiry }, stash);
      } catch (err) {
        // A plain refusal, so the browser shows it instead of waiting on Boros.
        throw new CoreError(`Could not save the login on this machine: ${(err as Error)?.message ?? String(err)}`);
      }
      if (approveAgentCalldata === undefined) return reply.ok(installed);

      const outcome = await relayAgentApproval(resolveBorosFetch(deps.borosFetch), approveAgentCalldata);
      if (outcome.ok) return reply.ok(installed);

      // Keep the new key only when Boros approved it. Otherwise put the
      // replaced login back: if the approval still lands, it only leaves an
      // agent nobody holds, while a key that never lands leaves no way to
      // trade. Skipped when another login replaced this one meanwhile. A
      // first login has nothing to put back: its key stays and the status
      // shows whether it landed.
      let message = outcome.message.replace(/\.?$/, '.');
      if (process.env.BOROS_AGENT_PRIVATE_KEY === agentPrivateKey && hasPrev()) {
        const prev = readPrev();
        install(svc, prev, PREV_CLEARED);
        const back = await readAgentApproval(resolveBorosFetch(deps.borosFetch), prev, { fresh: true });
        if (back.state === 'approved') message += ` ${maskAddress(prev.root)} is still logged in.`;
      }
      throw new CoreError(message, outcome.rateLimited ? 'rate-limited' : 'venue-rejected');
    });

    app.delete('/boros/agent', async (_req, reply) => {
      const svc = deps.borosAgent;
      if (!svc) throw new CoreError('Boros agent service not configured on this server');

      // Empty strings, not deleted lines: rewriteEnvFile replaces in place, and
      // a blank value reads as absent everywhere that consumes it.
      rewriteEnvFile(
        svc.envPath,
        {
          BOROS_ROOT_ADDRESS: '',
          BOROS_ACCOUNT_ID: '',
          BOROS_AGENT_PRIVATE_KEY: '',
          // Nothing writes or reads this any more; cleared so an .env written
          // by an older build does not keep a dead key after a revoke.
          BOROS_RPC_URLS: '',
          BOROS_AGENT_EXPIRY: '',
          ...PREV_CLEARED,
        },
        svc.hardenConfigDir,
      );
      applyToProcess(PREV_CLEARED);
      delete process.env.BOROS_ROOT_ADDRESS;
      delete process.env.BOROS_ACCOUNT_ID;
      delete process.env.BOROS_AGENT_PRIVATE_KEY;
      delete process.env.BOROS_RPC_URLS;
      delete process.env.BOROS_AGENT_EXPIRY;
      svc.setOrderClient(undefined);
      resetAgentApprovalCache();

      // Forgetting the key locally does NOT revoke the on-chain approval — the
      // agent stays authorised until the user revokes it in the Boros app or it
      // expires. Say so rather than implying this was a revocation.
      return reply.ok({
        configured: false,
        note: 'The key is gone from this machine. The on-chain approval is still live until you revoke it in the Boros app or it expires.',
      });
    });
  };
}
