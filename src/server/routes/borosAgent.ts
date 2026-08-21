/**
 * Boros agent provisioning: the browser connects a wallet, generates a
 * delegated agent key, approves it on-chain with the ROOT wallet's own
 * signature, and hands only the agent key here.
 *
 *   GET    /api/boros/agent  — masked status
 *   PUT    /api/boros/agent  — install a generated agent key
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
import { fetchBorosMarkets, resolveBorosFetch } from '../../core/boros/client';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { rewriteEnvFile } from './credentials';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Show enough of the agent key's OWNER to recognise, never the key itself. */
const maskAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function borosAgentRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/boros/agent', async (_req, reply) => {
      const root = process.env.BOROS_ROOT_ADDRESS;
      const configured = Boolean(root && process.env.BOROS_AGENT_PRIVATE_KEY);
      const rawExpiry = Number(process.env.BOROS_AGENT_EXPIRY);
      const expiry = configured && Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : null;
      return reply.ok({
        configured,
        root: configured ? root : null,
        rootMasked: configured && root ? maskAddress(root) : null,
        accountId: configured ? Number(process.env.BOROS_ACCOUNT_ID ?? 0) : null,
        expiry,
        // Surfaced rather than left to show up as AuthAgentExpired() on a
        // confirm the user has already committed to.
        expired: expiry !== null && expiry <= Math.floor(Date.now() / 1000),
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

      const client = makeBorosApiOrderClient({
        root: root as `0x${string}`,
        accountId,
        agentPrivateKey: agentPrivateKey as `0x${string}`,
        tokenIdForMarket: async (marketId) => {
          const { value } = await deps.cache.get('boros:markets', TTL.boros, () =>
            fetchBorosMarkets(resolveBorosFetch(deps.borosFetch)),
          );
          return value.find((m) => m.marketId === marketId)?.tokenId;
        },
      });

      // Persisted the same way as the Gate secret: 0700 dir, 0600 temp file,
      // atomic rename. See rewriteEnvFile.
      rewriteEnvFile(
        svc.envPath,
        {
          BOROS_ROOT_ADDRESS: root,
          BOROS_ACCOUNT_ID: String(accountId),
          BOROS_AGENT_PRIVATE_KEY: agentPrivateKey,
          BOROS_AGENT_EXPIRY: expiry === undefined ? '' : String(expiry),
        },
        svc.hardenConfigDir,
      );
      process.env.BOROS_ROOT_ADDRESS = root;
      process.env.BOROS_ACCOUNT_ID = String(accountId);
      process.env.BOROS_AGENT_PRIVATE_KEY = agentPrivateKey;
      if (expiry === undefined) delete process.env.BOROS_AGENT_EXPIRY;
      else process.env.BOROS_AGENT_EXPIRY = String(expiry);
      svc.setOrderClient(client);

      return reply.ok({
        configured: true,
        root,
        rootMasked: maskAddress(root),
        accountId,
        expiry: expiry ?? null,
      });
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
        },
        svc.hardenConfigDir,
      );
      delete process.env.BOROS_ROOT_ADDRESS;
      delete process.env.BOROS_ACCOUNT_ID;
      delete process.env.BOROS_AGENT_PRIVATE_KEY;
      delete process.env.BOROS_RPC_URLS;
      delete process.env.BOROS_AGENT_EXPIRY;
      svc.setOrderClient(undefined);

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
