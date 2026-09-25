/**
 * Reads the CrossEx settlement-fee rebate the logged-in account earns, from the
 * pendle-backend-v3 USER endpoints, authenticated with the SAME delegated agent
 * key that places orders (secp256k1 EIP-712, server-side only — never the root
 * key, never the browser).
 *
 * The rebate is configured on the backend's ActorAddress record (one doc per
 * address, no rate history): a settlement-fee percentage the account keeps, in
 * either RELATIVE mode (a fraction of the fee) or ABSOLUTE mode (an APR cap on
 * the fee), scoped to a market set and a time window. The backend is the single
 * source of truth for the rebated AMOUNT: the terminal never multiplies a fee by
 * a rate for a REALIZED figure, it only sums the `rebateX18` the backend
 * attributes per settlement. The one client-side rate math is FORWARD (opportunity
 * APR, current fixed APR), and it lives in `web/src/lib/rebate.ts`, not here.
 *
 * Two reads, both agent-signed and both reached through the same public base as
 * `/v1/accounts/settlement-events` (api-gateway `/apis` → apps/open-api):
 *   GET /v1/crossex-rebate/status       — the account's rebate config + accrued
 *   GET /v1/crossex-rebate/settlements  — per-settlement rebate amounts, paged
 *
 * The guard (VerifyAgentSignatureGuardV2) verifies an EIP-712 `AgentMessage`
 * over a millisecond timestamp, and derives the root from the packed `account`
 * query param — a DIFFERENT message from the per-call `PendleSignTx` order
 * signature, so the two never share a signature.
 *
 * A non-rebated account is NOT an error: status returns `rebate: null` and
 * settlements returns no results. The caller degrades every failure to "no
 * rebate".
 */
import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BOROS_NETWORK } from '../../../web/src/lib/borosNetwork';
import { CoreError } from '../errors';
import { packAccount } from './borosApi';
import type { FetchLike } from './client';

const BOROS_GATEWAY_BASE_URL = BOROS_NETWORK.apiBase;

/** The EIP-712 message the USER guard verifies: a bare millisecond timestamp,
 * bound to the same domain as the order signature. */
const AGENT_MESSAGE_TYPES = {
  AgentMessage: [{ name: 'timestamp', type: 'uint256' }],
} as const;

const EIP712_DOMAIN = {
  name: 'Pendle Boros Router',
  version: '1.0',
  chainId: BOROS_NETWORK.chainId,
  verifyingContract: BOROS_NETWORK.routerAddress as Hex,
} as const;

export interface RebateClientConfig {
  /** The ROOT account's address — the rebate is keyed on it. */
  root: Hex;
  accountId: number;
  /** The delegated agent's private key, already approved on-chain. */
  agentPrivateKey: Hex;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** How the account's settlement-fee rebate is priced. RELATIVE keeps a fraction
 * of the fee (`settlementFeePercentage` = fee kept, e.g. 0.8 = pays 80%, rebates
 * 20%); ABSOLUTE caps the fee at an annualized rate (`settlementFeePercentage` =
 * the cap APR on notional). */
export type RebateMode = 'relative' | 'absolute';

/** The account's rebate configuration, read straight from its ActorAddress doc
 * (no history — one rate at a time). null on `RebateStatus` means "not rebated". */
export interface RebateConfig {
  mode: RebateMode;
  /** RELATIVE: the fraction of the settlement fee the account still PAYS, in
   * [0, 1). ABSOLUTE: the cap APR on notional (> 0). */
  settlementFeePercentage: number;
  /** RELATIVE only: the rebated share as integer basis points,
   * round((1 − settlementFeePercentage) × 1e4). Null in absolute mode. */
  rebateBps: number | null;
  /** Window start (unix sec), null = rebated from the beginning. */
  startTimestamp: number | null;
  /** Window end (unix sec), exclusive, null = still active. */
  endTimestamp: number | null;
  /** The markets the rebate covers, null = all markets. */
  marketIds: number[] | null;
  /** Whether the window contains now — the backend's own reading. */
  active: boolean;
}

export interface RebateStatus {
  root: string;
  accountId: number;
  /** The rebate config, or null when the account has no eligible rebate. */
  rebate: RebateConfig | null;
}

/** One rebated settlement, as the backend attributes it. Amounts are X18 raw
 * bigint decimal strings in the market's collateral token; timestamp is unix
 * seconds. Only rows with rebateX18 > 0 are returned. */
export interface RebateSettlement {
  marketId: number;
  tokenId: number;
  timestamp: number;
  eventIndex: number;
  settlementFeeX18: string;
  rebateX18: string;
}

export interface RebateClient {
  status(): Promise<RebateStatus>;
  /** Every rebated settlement at or after `fromTimestamp` (unix sec), paged
   * through to the end. */
  settlements(fromTimestamp: number): Promise<RebateSettlement[]>;
}

/** How many settlement pages one call will sweep before giving up — a guard
 * against an unbounded loop, generous enough to cover a rebated account's whole
 * history (the program is recent and only rebated rows are returned). */
const MAX_SETTLEMENT_PAGES = 100;
const PAGE_LIMIT = 1000;

interface SettlementsPage {
  results?: RebateSettlement[];
  resumeToken?: string | null;
}

/** Parses the wire `rebate` object, or null when the account is not rebated.
 * Tolerant of a missing/garbage field: anything unusable ⇒ no rebate. */
function parseRebate(raw: unknown): RebateConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === 'absolute' ? 'absolute' : r.mode === 'relative' ? 'relative' : null;
  const pct = Number(r.settlementFeePercentage);
  if (mode === null || !Number.isFinite(pct)) return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    mode,
    settlementFeePercentage: pct,
    rebateBps: mode === 'relative' ? num(r.rebateBps) : null,
    startTimestamp: num(r.startTimestamp),
    endTimestamp: num(r.endTimestamp),
    marketIds: Array.isArray(r.marketIds) ? r.marketIds.map(Number).filter(Number.isFinite) : null,
    active: r.active === true,
  };
}

export function makeRebateClient(config: RebateClientConfig): RebateClient {
  const base = (config.baseUrl ?? BOROS_GATEWAY_BASE_URL).replace(/\/$/, '');
  const fetchImpl: FetchLike = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const account = privateKeyToAccount(config.agentPrivateKey);
  const packed = packAccount(config.root, config.accountId);

  /** account + agent + signature + timestamp — the four query params the guard
   * checks. Signed fresh per request (the guard bounds the timestamp's age). */
  const authParams = async (): Promise<string> => {
    const timestamp = Date.now();
    const signature = await account.signTypedData({
      domain: EIP712_DOMAIN,
      types: AGENT_MESSAGE_TYPES,
      primaryType: 'AgentMessage',
      message: { timestamp: BigInt(timestamp) },
    });
    return (
      `account=${packed}&agent=${account.address}` +
      `&signature=${signature}&timestamp=${timestamp}`
    );
  };

  const get = async <T>(path: string, extra: string): Promise<T> => {
    const auth = await authParams();
    let resp: Awaited<ReturnType<FetchLike>>;
    try {
      resp = await fetchImpl(`${base}${path}?${extra}${extra ? '&' : ''}${auth}`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CoreError(
        `Boros API unreachable (${path}): ${(err as Error)?.message ?? String(err)}`,
        'network',
      );
    }
    if (!resp.ok) {
      throw new CoreError(
        `Boros API ${path} returned HTTP ${resp.status}`,
        resp.status === 429 ? 'rate-limited' : 'network',
      );
    }
    return (await resp.json()) as T;
  };

  return {
    async status(): Promise<RebateStatus> {
      const body = await get<Partial<RebateStatus> & { rebate?: unknown }>(
        '/v1/crossex-rebate/status',
        '',
      );
      return {
        root: String(body.root ?? config.root),
        accountId: Number(body.accountId ?? config.accountId),
        rebate: parseRebate(body.rebate),
      };
    },

    async settlements(fromTimestamp: number): Promise<RebateSettlement[]> {
      const out: RebateSettlement[] = [];
      let resumeToken: string | null = null;
      const from = Math.max(0, Math.floor(fromTimestamp));
      for (let page = 0; page < MAX_SETTLEMENT_PAGES; page += 1) {
        const query =
          `fromTimestamp=${from}&limit=${PAGE_LIMIT}` +
          (resumeToken ? `&resumeToken=${encodeURIComponent(resumeToken)}` : '');
        const body: SettlementsPage = await get('/v1/crossex-rebate/settlements', query);
        const results = Array.isArray(body?.results) ? body.results : [];
        out.push(...results);
        resumeToken = body?.resumeToken ?? null;
        if (!resumeToken || results.length === 0) break;
      }
      return out;
    },
  };
}
