/**
 * `BorosOrderClient` implemented directly against the Boros REST API
 * (https://api-boros.pendle.finance/apis/docs) — no `@pendle/boros-sdk-public`.
 *
 * WHY DIRECT. The SDK's `bulkPlaceOrders` hardcodes `requireSuccess: false`
 * when it submits, so a two-leg batch is best-effort by construction: one leg
 * can revert while the other fills, and the user is left silently directional.
 * The endpoint underneath accepts the flag — `POST /v1/send-txs/bulk-calls`
 * documents `requireSuccess` as "the on-chain `tryAggregate` reverts the entire
 * batch when any inner call fails" — so going direct is what makes an ATOMIC
 * pair possible at all. Everything else here follows from removing that one
 * layer.
 *
 * ⚠ ATOMIC IS NOT THE SAME AS FULLY FILLED. `requireSuccess` guarantees the
 * legs stand or fall TOGETHER: no leg can be rejected while the other trades.
 * It does NOT make an IOC fill completely — an order that matches only part of
 * its size succeeds, it does not revert. So a pair can still come back with two
 * partial fills of different sizes, and the residual reporting downstream
 * stays exactly as necessary as it was.
 *
 * The flow is three calls, all unauthenticated — the agent signature IS the
 * authorisation:
 *
 *   1. POST /v1/calldata-builder/agent/place-order   → calldata per leg
 *   2. POST /v1/send-txs/bulk-calls                  → sign each, submit as ONE
 *                                                      tryAggregate
 *   3. POST /v1/send-txs/tx-status-with-events       → per-call fills
 *
 * Three things the SDK made harder and the API does not:
 *
 * - `rate` is just the rate. The SDK's generated DTO still calls it `rate`
 *   while the backend wanted `desiredRate`, so the old client sent both. The
 *   documented field here is `rate` (human-readable, e.g. 0.085), required for
 *   IOC, and the backend rounds it to the nearest tick in the direction that
 *   favours the user. No workaround needed.
 * - Fills come back as a plain size. `MarketOrderExecutedItem.size` is an
 *   "absolute filled size as a bigint string", already grouped by the
 *   tryAggregate call that emitted it — so there is no packed `Trade` word to
 *   unpack, no signed int128 in the high bits, and no way for a short leg to
 *   render as ~2^256.
 * - No RPC. The relayer submits and pays from the account's off-chain gas
 *   budget, so this module never opens a chain connection.
 *
 * Key handling is unchanged: a DELEGATED AGENT key signs, never the root
 * wallet. Deposits and withdrawals need root, and this module has no verb for
 * either, so the worst a leaked agent key can do is trade.
 */
import { keccak256, formatUnits, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CoreError } from '../errors';
import {
  classifyLegFailure,
  extractApiDetail,
  type BorosClosePositionRequest,
  type BorosLegFill,
  type BorosMarketOrderRequest,
  type BorosOrderClient,
} from './orders';

/** The documented production host (the spec's only `servers` entry). */
export const BOROS_API_BASE = 'https://api-boros.pendle.finance/apis';

/** Boros sizes and rates are 18-decimal fixed point on the wire. */
const DECIMALS = 18;

/** Arbitrum One, and the router the agent signature is bound to. Both are
 * part of the EIP-712 domain, so a wrong value produces a signature the
 * backend rejects rather than anything silently mis-sent. */
const CHAIN_ID = 42161;
const ROUTER_ADDRESS = '0x8080808080daB95eFED788a9214e400ba552DEf6';

/** `marketId` sentinel for a CROSS account — max uint24. */
export const CROSS_MARKET_ID = 0xff_ff_ff;

export const USD_TOKEN_ID = 3;

export { AUTO_TOP_UP_BELOW_USD, AUTO_TOP_UP_USD } from './client';
import { AUTO_TOP_UP_BELOW_USD, AUTO_TOP_UP_USD } from './client';

/** Side enum on the wire: 0 = LONG, 1 = SHORT. */
const SIDE_LONG = 0;
const SIDE_SHORT = 1;

/**
 * Time-in-force 1 = IOC: take what the book gives, cancel the rest. GTC would
 * leave a resting order nobody asked for; FOK turns every thin book into a
 * total miss rather than a partial fill the panel can report and complete.
 */
const TIF_IOC = 1;

/**
 * Orderbook-only routing, matching what the SDK sent (`ammId ?? 0`). Omitting
 * the field would let the builder also route through the market's active AMM —
 * a behaviour change, so it is opted out of explicitly rather than by default.
 */
const AMM_ORDERBOOK_ONLY = 0;

/** How long one submission may take before the fill state is UNKNOWN. */
const SUBMIT_TIMEOUT_MS = 60_000;

/** The EIP-712 message an agent signs to authorise one call. Field names and
 * types come from the router ABI's `agentExecute` message struct. */
const PENDLE_SIGN_TX_TYPES = {
  PendleSignTx: [
    { name: 'account', type: 'bytes21' },
    { name: 'connectionId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

const EIP712_DOMAIN = {
  name: 'Pendle Boros Router',
  version: '1.0',
  chainId: CHAIN_ID,
  verifyingContract: ROUTER_ADDRESS as Hex,
} as const;

/** Minimal fetch seam — POST with a JSON body, plus GET for the reads. */
export type ApiFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface BorosApiConfig {
  /** The ROOT account's address. This module never holds its key. */
  root: Hex;
  /** Boros sub-account id (0 for the default). */
  accountId: number;
  /** The delegated agent's private key, already approved on-chain by the root
   * wallet. Generating and approving it is a one-time setup step elsewhere. */
  agentPrivateKey: Hex;
  /** marketId → collateral tokenId, needed to pack a MarketAcc. Async so the
   * caller can serve it off the same TTL-cached markets read the routes use. */
  tokenIdForMarket: (marketId: number) => Promise<number | undefined> | number | undefined;
  /** A market in the USD collateral zone, which is where a gas top-up is
   * charged from. Without it an order cannot carry its own top-up and the
   * account has to be topped up by hand. Async for the same reason as
   * `tokenIdForMarket`: it comes off the routes' cached markets read. */
  usdMarketId?: () => Promise<number | undefined> | number | undefined;
  baseUrl?: string;
  fetchImpl?: ApiFetch;
  /** Receipt polling, exposed so tests need no timers. */
  statusAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const toHex = (v: bigint, bytes: number): Hex => `0x${v.toString(16).padStart(bytes * 2, '0')}`;

/**
 * The account an order is CHARGED against, as bytes26.
 *
 * ⚠ `marketAcc` and `marketId` are SEPARATE fields on an order: `marketId`
 * says which book to trade, `marketAcc` says which account pays. Packing the
 * traded marketId in here addresses a per-market account holding no cash, and
 * the venue answers "[SIMULATE] Top up at least ~$10 to trade" about an account
 * the user never funded and cannot see. Cross accounts use CROSS_MARKET_ID.
 *
 * Layout: root (20B) · accountId (1B) · tokenId (2B) · marketId (3B).
 */
export function packMarketAcc(
  root: Hex,
  accountId: number,
  tokenId: number,
  marketId: number,
): Hex {
  const packed =
    (BigInt(root) << 48n) |
    (BigInt(accountId) << 40n) |
    (BigInt(tokenId) << 24n) |
    BigInt(marketId);
  return toHex(packed, 26);
}

/** The signer's account handle, as bytes21: root (20B) · accountId (1B). */
export function packAccount(root: Hex, accountId: number): Hex {
  return toHex((BigInt(root) << 8n) | BigInt(accountId), 21);
}

/**
 * A JS number as a plain decimal string `parseUnits` will accept.
 *
 * `String(n)` switches to exponential notation at both ends (`1e-18`, `1e+21`)
 * and parseUnits rejects that outright, so a legitimately tiny or huge size
 * would throw at submit rather than trade.
 */
export function decimalString(n: number): string {
  if (!Number.isFinite(n)) throw new CoreError(`size ${n} is not a finite number`, 'validation');
  if (Math.abs(n) >= 1e21) {
    throw new CoreError(`size ${n} is out of range for an 18-decimal amount`, 'validation');
  }
  return n.toFixed(DECIMALS).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * The venue's own 18-decimal size as a magnitude, or null when it is not an
 * integer this can trust.
 *
 * Deliberately strict, and matched by a REGEX rather than left to `BigInt`:
 * `BigInt('')` is `0n`, not a throw, so an absent field would have become a
 * cap of ZERO and truncated the close to nothing — the opposite failure, and a
 * worse one. Anything that is not a plain integer literal (a decimal point,
 * exponent notation, an empty string) means the field is not the shape this
 * cap assumes, and inventing a ceiling out of it beats having none only if it
 * is right.
 */
export function absWei(raw: string): bigint | null {
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = BigInt(t);
  return n < 0n ? -n : n;
}

// ---------------------------------------------------------------------------
// Wire shapes (only the fields this module reads)
// ---------------------------------------------------------------------------

interface PlaceOrderCall {
  calldata: Hex;
  accountId?: number;
}
interface SignedCall {
  agent: string;
  message: { account: Hex; connectionId: Hex; nonce: string };
  signature: Hex;
  calldata: Hex;
}
interface TxResponse {
  txHash?: string;
  status?: string;
  index?: number;
  error?: string;
}
interface MarketOrderExecuted {
  marketId?: number;
  size?: string;
  side?: number;
}
interface TxStatusItem {
  status?: string;
  index?: number;
  error?: string;
  marketOrdersExecuted?: MarketOrderExecuted[];
}
interface TxStatusResponse {
  status?: string;
  statuses?: TxStatusItem[];
}

/**
 * A usable sentence out of an API error body, rather than a bare status code.
 *
 * Deliberately the SAME extractor `describeLegFailure` uses: `classifyLegFailure`
 * regex-matches the text produced here, so a second key list would sort the same
 * venue response into a different failure category.
 */
function describeApiError(status: number, body: unknown): string {
  const detail = extractApiDetail(body);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

export function makeBorosApiOrderClient(config: BorosApiConfig): BorosOrderClient {
  const base = (config.baseUrl ?? BOROS_API_BASE).replace(/\/$/, '');
  const fetchImpl: ApiFetch =
    config.fetchImpl ?? (globalThis.fetch as unknown as ApiFetch);
  const account = privateKeyToAccount(config.agentPrivateKey);
  const statusAttempts = config.statusAttempts ?? 5;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const call = async <T>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
    let resp: Awaited<ReturnType<ApiFetch>>;
    try {
      resp = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new CoreError(
        `Boros API ${path} is unreachable: ${(err as Error)?.message ?? err}`,
        'network',
      );
    }
    let json: unknown = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
    if (!resp.ok) {
      throw new CoreError(
        `Boros API ${path} — ${describeApiError(resp.status, json)}`,
        resp.status === 429 ? 'rate-limited' : 'venue-rejected',
      );
    }
    return json as T;
  };

  const withTimeout = async <T>(p: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CoreError(`Boros ${what} timed out`, 'network')),
            SUBMIT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const marketAccFor = async (marketId: number): Promise<Hex> => {
    const tokenId = await config.tokenIdForMarket(marketId);
    if (tokenId === undefined) {
      throw new CoreError(`unknown collateral token for Boros market ${marketId}`, 'symbol-invalid');
    }
    // Cross: this panel's pairs share one collateral pool.
    return packMarketAcc(config.root, config.accountId, tokenId, CROSS_MARKET_ID);
  };

  /**
   * Sign one calldata per entry.
   *
   * Nonces are per signer and the endpoint rejects "unsorted/used" ones, so
   * they are handed out strictly ascending from a single millisecond-derived
   * base — the same scheme the SDK used, kept so a mixed deployment cannot
   * collide.
   */
  const signCalls = async (calldatas: Hex[]): Promise<SignedCall[]> => {
    const packedAccount = packAccount(config.root, config.accountId);
    const baseNonce = Date.now() * 1000;
    return Promise.all(
      calldatas.map(async (calldata, i) => {
        const message = {
          account: packedAccount,
          connectionId: keccak256(calldata),
          nonce: BigInt(baseNonce + i),
        };
        const signature = await account.signTypedData({
          domain: EIP712_DOMAIN,
          types: PENDLE_SIGN_TX_TYPES,
          primaryType: 'PendleSignTx',
          message,
        });
        return {
          agent: account.address,
          // The wire wants the nonce as a string; everything else is hex.
          message: { ...message, nonce: message.nonce.toString() },
          signature,
          calldata,
        };
      }),
    );
  };

  /**
   * Submit signed calls as ONE tryAggregate.
   *
   * `requireSuccess` is the whole point of talking to this endpoint directly:
   * with several calls it is TRUE, so the batch is all-or-nothing. A single
   * call passes false — there is nothing to be atomic with, and true would
   * only turn a plain rejection into a less specific revert.
   */
  const submitCalls = async (datas: SignedCall[]): Promise<TxResponse[]> => {
    const out = await withTimeout(
      call<TxResponse[]>('/v1/send-txs/bulk-calls', {
        datas,
        requireSuccess: datas.length > 1,
      }),
      'order submission',
    );
    return Array.isArray(out) ? out : [];
  };

  /**
   * Per-call fills for a submitted transaction.
   *
   * Returns null when the status never resolves — which is a genuinely UNKNOWN
   * fill state, not a zero fill, and the caller must report it as such.
   */
  const fillsByIndex = async (txHash: string): Promise<Map<number, TxStatusItem> | null> => {
    for (let attempt = 0; attempt < statusAttempts; attempt += 1) {
      let res: TxStatusResponse | null = null;
      try {
        res = await call<TxStatusResponse>('/v1/send-txs/tx-status-with-events', { txHash });
      } catch {
        res = null;
      }
      const statuses = res?.statuses;
      if (Array.isArray(statuses) && statuses.length > 0) {
        return new Map(statuses.map((s, i) => [s.index ?? i, s]));
      }
      if (attempt < statusAttempts - 1) await sleep(1_000);
    }
    return null;
  };

  const readGasBalance = async (): Promise<number | null> => {
    const res = await call<{ balanceInUSD?: number }>(
      `/v1/accounts/gas-balance?root=${config.root}`,
      undefined,
      'GET',
    );
    return typeof res?.balanceInUSD === 'number' ? res.balanceInUSD : null;
  };

  /** `cents`, not dollars: the exact integer→wei step is the whole point, so
   * no float ever reaches the amount. */
  const buildPayTreasuryCalldata = async (cents: number, marketId: number): Promise<Hex[]> => {
    const { calls } = await call<{ calls: PlaceOrderCall[] }>(
      '/v1/calldata-builder/agent/pay-treasury',
      {
        accountId: config.accountId,
        isCross: true,
        marketId,
        amount: (BigInt(cents) * 10n ** BigInt(DECIMALS - 2)).toString(),
      },
    );
    if (!calls?.length) {
      throw new CoreError(
        `Boros returned no calldata for a $${cents / 100} gas top-up.`,
        'venue-rejected',
      );
    }
    return calls.map((c) => c.calldata as Hex);
  };

  /**
   * The top-up an order carries so it can pay its own gas — see
   * AUTO_TOP_UP_BELOW_USD. Empty when the budget is healthy, unreadable, or
   * there is no USD market to charge.
   *
   * Best effort ON PURPOSE. Every failure here returns [] and lets the order go
   * out: the budget may well be fine, and refusing to trade because a
   * supplementary read failed would reinstate exactly the dead end this
   * removes. If the balance really was too low the venue refuses the bundle and
   * `classifyLegFailure` reports that as a gas failure, which is the truth.
   */
  const autoTopUpCalldata = async (reducing: boolean): Promise<Hex[]> => {
    if (!config.usdMarketId) return [];
    try {
      const balance = await readGasBalance();
      // An EXIT is funded only when it genuinely cannot pay. The relayer's floor
      // is 0 and an order's gas is a couple of cents, so anything above zero
      // already covers a close — topping it up there would spend a dollar of
      // margin, and add a `_checkIMStrict` that can revert, to buy nothing. An
      // OPEN keeps the buffer: it is the order that should not stall next time.
      const floor = reducing ? 0 : AUTO_TOP_UP_BELOW_USD;
      if (balance === null || balance >= floor) return [];
      const marketId = await config.usdMarketId();
      if (marketId === undefined) return [];
      // A negative budget is debt. Clear it and leave the full amount on top,
      // which is what Boros charges its own users in the same state.
      //
      // Counted in CENTS, and the wei built from those, because `decimalString`
      // goes through `toFixed(18)`: $1.80 as a float is 1.80000000000000004…,
      // and formatting it to 18 places writes that tail into the amount. Round
      // rather than ceil — a sub-cent under-recovery of the debt is absorbed by
      // the whole dollar sitting on top of it.
      const owed = balance < 0 ? -balance : 0;
      const cents = Math.round(AUTO_TOP_UP_USD * 100) + Math.round(owed * 100);
      return await buildPayTreasuryCalldata(cents, marketId);
    } catch {
      return [];
    }
  };

  const buildOrderCalldata = async (req: BorosMarketOrderRequest): Promise<Hex> => {
    const { calls } = await call<{ calls: PlaceOrderCall[] }>(
      '/v1/calldata-builder/agent/place-order',
      {
        marketAcc: await marketAccFor(req.marketId),
        marketId: req.marketId,
        side: req.direction === 'long' ? SIDE_LONG : SIDE_SHORT,
        size: (req.sizeWei ?? parseUnits(decimalString(req.size), DECIMALS)).toString(),
        tif: TIF_IOC,
        // The worst rate this leg accepts. `slippage` is deliberately NOT sent
        // alongside: the backend derives its guard from mid ± slippage, which
        // would silently replace the bound the user's tolerance produced.
        rate: req.limitApr,
        ammId: AMM_ORDERBOOK_ONLY,
      },
    );
    const calldata = calls?.[0]?.calldata;
    if (!calldata) {
      throw new CoreError(
        `Boros returned no calldata for the ${req.marketId} order`,
        'venue-rejected',
      );
    }
    return calldata;
  };

  const emptyLeg = (req: BorosMarketOrderRequest) => ({
    marketId: req.marketId,
    direction: req.direction,
    filledSize: 0,
    shortfallSize: req.size,
    execApr: null,
    feeSize: null,
  });
  const failedLeg = (req: BorosMarketOrderRequest, message: string): BorosLegFill => ({
    ...emptyLeg(req),
    failure: {
      // Entered: every order carries `enterMarket` itself, so Boros's "Top up
      // at least ~$10 to trade" can only be about gas here, never about a
      // market the account never registered with.
      code: classifyLegFailure(new Error(message), true),
      message,
    },
  });
  /**
   * A leg whose outcome the venue never told us. NOT a zero fill: it may have
   * traded, so the message has to send the user to look rather than to retry.
   */
  const unknownLeg = (req: BorosMarketOrderRequest, message: string): BorosLegFill => ({
    ...emptyLeg(req),
    failure: { code: 'unknown', message },
  });

  const placeMarketOrders = async (
    reqs: BorosMarketOrderRequest[],
    opts?: { reducing?: boolean },
  ): Promise<BorosLegFill[]> => {
    if (reqs.length === 0) return [];

    // Prepended, which is what the backend's own builders do (payTreasury goes
    // first in getPositionTransferCallData and getCancelOrderCallData).
    //
    // Position does NOT decide whether the batch is funded: the relayer sums
    // the whole submission and checks it once, before anything executes
    // (gas-tracking.service), so the credit counts wherever the call sits.
    // What position does decide is when `payTreasury`'s own `_checkIMStrict`
    // runs (MarginManager.sol) — first means before the batch frees any margin.
    // That is only reachable on a close whose budget is already at or below
    // zero, because `autoTopUpCalldata` leaves any solvent close alone.
    const topUp = await autoTopUpCalldata(opts?.reducing === true);
    const calldatas = [...topUp, ...(await Promise.all(reqs.map(buildOrderCalldata)))];
    const signed = await signCalls(calldatas);
    const responses = await submitCalls(signed);
    // Everything below indexes BY LEG, and the top-up occupies the first
    // `topUp.length` slots of the submission. Read leg results off the shifted
    // view, and shift the positional fallback too, or leg 0 reads the top-up's
    // outcome as its own fill.
    const legResponses = responses.slice(topUp.length);

    // With `requireSuccess` the legs stand or fall together, so one error is
    // the whole batch's — the top-up's included: it is in the same submission,
    // so if it reverted nothing else traded either. Report every leg failed
    // rather than implying the others might have traded.
    const failure = responses.find((r) => r?.error);
    if (failure) return reqs.map((req) => failedLeg(req, failure.error as string));

    const txHash = responses.find((r) => r?.txHash)?.txHash;
    if (!txHash) {
      return reqs.map((req) =>
        unknownLeg(
          req,
          'Boros accepted the batch but returned no transaction hash, so the fill state is unknown. Check the position on Boros before re-issuing.',
        ),
      );
    }

    const byIndex = await fillsByIndex(txHash);
    return reqs.map((req, i) => {
      if (!byIndex) {
        return unknownLeg(
          req,
          `Submitted as ${txHash} but no status came back, so this leg may or may not have filled. Check the position on Boros before re-issuing.`,
        );
      }
      const status = byIndex.get(legResponses[i]?.index ?? i + topUp.length);
      // A status array that skips this call says nothing about it — exactly
      // the uncertainty the `!byIndex` branch above reports. Falling through
      // would compute `filled` as 0 and claim "nothing matched", telling the
      // user a leg definitively did not trade when it may have; re-issuing on
      // that would double the position.
      if (!status) {
        return unknownLeg(
          req,
          `Submitted as ${txHash} but no status came back for this leg, so it may or may not have filled. Check the position on Boros before re-issuing.`,
        );
      }
      if (status.error) return failedLeg(req, status.error);

      // Already grouped by the call that emitted them; filtered by market so a
      // merged submission cannot lend one leg another's fill.
      const filled = (status.marketOrdersExecuted ?? [])
        .filter((e) => e.marketId === undefined || e.marketId === req.marketId)
        .reduce((sum, e) => sum + Number(formatUnits(BigInt(e.size ?? '0'), DECIMALS)), 0);

      // An 18-decimal size cannot survive a float64 round-trip exactly: a full
      // 100,000 fill comes back as 99999.99999999999, and without a dust band
      // every complete fill would report a phantom residual.
      const dust = Math.max(1e-12, req.size * 1e-9);
      const shortfallRaw = req.size - filled;
      const shortfall = shortfallRaw > dust ? shortfallRaw : 0;
      return {
        marketId: req.marketId,
        direction: req.direction,
        filledSize: filled,
        shortfallSize: shortfall,
        // No event carries an execution rate, and inventing one from the
        // estimate would report a fill the user did not get.
        execApr: null,
        // The execution events carry no fee, so this is genuinely unsaid
        // rather than zero.
        feeSize: null,
        failure:
          shortfall > 0
            ? {
                code: 'insufficient-depth' as const,
                message:
                  filled === 0
                    ? 'Nothing matched inside the rate bound.'
                    : `Only ${filled} of ${req.size} matched inside the rate bound.`,
              }
            : null,
      };
    });
  };

  return {
    placeMarketOrders,

    async cancelOrders(marketId: number): Promise<void> {
      const marketAcc = await marketAccFor(marketId);
      const { calls } = await call<{ calls: PlaceOrderCall[] }>(
        '/v1/calldata-builder/agent/cancel-orders',
        { markets: [{ marketAcc, marketId, cancelAll: true, orderIds: [] }] },
      );
      if (!calls?.length) return;
      const res = await submitCalls(await signCalls(calls.map((c) => c.calldata)));
      // An empty result is "we cannot tell",
      // and reporting a cancel that may never have been submitted as done is
      // the one answer a remediation path must not give.
      if (!res.length) {
        throw new CoreError(
          `Boros returned no result for the cancel on market ${marketId} — cannot tell whether it landed.`,
          'venue-rejected',
        );
      }
      const refused = res.find((r) => r?.error);
      if (refused) {
        throw new CoreError(`Boros refused the cancel: ${refused.error}`, 'venue-rejected');
      }
    },

    getGasBalance: readGasBalance,

    async payTreasury(amountUsd: number, marketId: number): Promise<void> {
      const calldatas = await buildPayTreasuryCalldata(Math.round(amountUsd * 100), marketId);
      const res = await submitCalls(await signCalls(calldatas));
      if (!res.length) {
        throw new CoreError(
          `Boros returned no result for the $${amountUsd} gas top-up — cannot tell whether it landed.`,
          'venue-rejected',
        );
      }
      const refused = res.find((r) => r?.error);
      if (refused) {
        throw new CoreError(`Boros refused the gas top-up: ${refused.error}`, 'venue-rejected');
      }
    },

    /**
     * A close is an ordinary opposing market order — Boros has no close
     * primitive and no reduce-only flag — so it goes out on exactly the same
     * path as any other leg and reports its fill and shortfall the same way.
     *
     * ⚠ WHICH IS WHY THE CAP HAS TO BE APPLIED HERE, IN WEI.
     *
     * With no reduce-only flag, nothing at the venue stops a close at flat:
     * an order one unit larger than the position crosses it and opens a fresh
     * one the other way. The route already clamps the size to what is open,
     * but it clamps two DOUBLES — and the order is not built from a double.
     * `parseUnits(decimalString(50000000000000000 / 1e18))` is
     * 50000000000000003, so a clean 0.05 close asked for three units more
     * than existed and left a 3-unit opposing position behind. Too small to
     * see, too small to close again (the venue refuses orders under $10 of
     * notional), and reported as "closed" because in float space the two
     * numbers were equal.
     *
     * So the float is only ever allowed to make the order SMALLER here. The
     * venue's own integer is the ceiling, and it is never re-derived.
     */
    async closePosition(req: BorosClosePositionRequest): Promise<BorosLegFill> {
      const asked = parseUnits(decimalString(req.size), DECIMALS);
      const open = absWei(req.openSizeWei);
      const [fill] = await placeMarketOrders([
        {
          marketId: req.marketId,
          direction: req.direction,
          size: req.size,
          limitApr: req.limitApr,
          clientOrderId: req.clientOrderId,
          // A cap we could not read is no cap: fall back to the float the
          // route already clamped, which is exactly the old behaviour rather
          // than a new failure. `openSizeWei` is the venue's own field, so
          // this is a shape change on their side, not a routine case.
          ...(open === null ? {} : { sizeWei: (asked < open ? asked : open).toString() }),
        },
      ], { reducing: true });
      return fill;
    },
  };
}
