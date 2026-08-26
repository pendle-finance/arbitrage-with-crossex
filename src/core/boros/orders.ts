/**
 * Boros order placement: the write seam, and the orchestration of a two-leg
 * market entry (§5).
 *
 * ⚠ ATOMIC ACCEPTANCE, NOT ATOMIC FILL. Both legs ride one `tryAggregate`
 * submitted with `requireSuccess` (see `./borosApi`), so neither can be
 * REJECTED while the other trades — the pair stands or falls together. That
 * removes the worst outcome, not every one: an IOC that matches only part of
 * its size SUCCEEDS rather than reverting, so the two legs can still fill to
 * different sizes and leave a residual directional.
 *
 * Everything in this module therefore still exists to make a shortfall
 * *legible* rather than to hide it: each leg reports what it actually got, the
 * realised spread is computed from the fills rather than the estimate, and the
 * residual that is left directional is returned as its own number.
 *
 * No execution semantics are invented here. Each leg is an ordinary market
 * order carrying the rate bound the user's slippage setting implies; matching,
 * partial fills and the on-chain rate-deviation guard are the venue's, exactly
 * as they would be for a lone market order. Nothing in this module ever widens
 * a tolerance or re-sends on its own — "complete now at market" is the user
 * re-issuing an order at a tolerance they choose, which arrives back here as a
 * fresh call.
 *
 * The two ways a leg can come up short need different responses from the user,
 * so they are never collapsed into one error: `insufficient-depth` means the
 * book ran out (the size was too big for the market), `rate-deviation` means
 * the chain refused the rate (the trade was priced too far from mark). See
 * `BorosLegFailureCode`.
 */
import { CoreError } from '../errors';
import type { BorosLegDirection } from './pair';

/** One leg's order, as it goes to the venue. */
export interface BorosMarketOrderRequest {
  marketId: number;
  direction: BorosLegDirection;
  /** Size in collateral-token units, always POSITIVE — `direction` carries the sign. */
  size: number;
  /**
   * Worst rate this leg will accept, an APR fraction: the estimated execution
   * rate moved one full tolerance the wrong way. A receive-fixed ('short') leg
   * refuses anything BELOW it; a pay-fixed ('long') leg refuses anything ABOVE.
   * This is the only thing bounding the fill — and it bounds PRICE, not size:
   * a leg that cannot fill within it simply stops filling.
   */
  limitApr: number;
  /**
   * Replay key. ⚠ NOT sent to the venue and NOT venue-enforced: Boros's order
   * DTO carries no client order id, so the same batch submitted twice fills
   * twice. Deduping happens in the route (`recentExecutions`), which covers a
   * lost response resent by the same process and nothing wider.
   */
  clientOrderId: string;
  /**
   * The EXACT size to place, in the venue's own 18-decimal integer units.
   * Overrides `size` when present.
   *
   * ⚠ `size` is a float and an order is placed in WEI, and that conversion is
   * not order-preserving: `parseUnits(String(50000000000000000 / 1e18))` is
   * 50000000000000003 — three units ABOVE the position it was read from. On a
   * venue with no reduce-only flag that is not a rounding detail, it is a
   * close that crosses past flat and opens a fresh opposing position. This is
   * the channel that lets a close carry the venue's own integer instead of
   * re-deriving it through a double.
   */
  sizeWei?: string;
}

export type BorosLegFailureCode =
  /** The book ran out inside the rate bound — size too large for this market. */
  | 'insufficient-depth'
  /** The chain's rate-deviation guard refused the trade — priced too far from mark. */
  | 'rate-deviation'
  /** The bucket could not fund it. */
  | 'insufficient-margin'
  | 'no-gas'
  /** Anything the venue rejected for another reason. */
  | 'rejected'
  /** The submission never got a usable answer; the fill state is UNKNOWN. */
  | 'unknown';

export interface BorosLegFill {
  marketId: number;
  direction: BorosLegDirection;
  /** Collateral units actually filled (0 on a clean reject). */
  filledSize: number;
  /** Requested − filled. */
  shortfallSize: number;
  /** VWAP of the fills; null when nothing filled. */
  execApr: number | null;
  /** Fee actually charged, collateral units; null when the venue did not say. */
  feeSize: number | null;
  /** Set when the leg did not fill in full. */
  failure: { code: BorosLegFailureCode; message: string } | null;
}

/**
 * A force-close of one market's netted position (§6A remediation).
 *
 * Every field is explicit because Boros gives no close primitive and no
 * `reduceOnly` flag: a close IS an opposing market order, so it needs a size, a
 * direction and a rate bound like any other. Deriving those silently inside the
 * client would mean force-closing at a rate nobody chose — the caller computes
 * them from the live netted position and shows them.
 */
export interface BorosClosePositionRequest {
  marketId: number;
  /** Positive size to close — the whole netted position, in collateral units. */
  size: number;
  /**
   * What the venue says is open, in ITS OWN 18-decimal integer units — the
   * ceiling this close may never exceed.
   *
   * ⚠ REQUIRED, and required as a STRING, because the cap only works in the
   * units the order is placed in. `size` above is a double: clamping there
   * (`Math.min(asked, open)`) compares two numbers that both already lost the
   * position's low-order digits, and the wei the order is finally built from
   * can land above the position anyway. Boros has no reduce-only flag, so
   * that overshoot does not stop at flat — it opens a fresh position the
   * other way, too small to be closed again under the venue's minimum order
   * value, and the leg never goes away.
   *
   * Pass the venue's `notionalSize` verbatim; the sign is ignored.
   */
  openSizeWei: string;
  /** The direction that REDUCES: opposite the position's own side. */
  direction: BorosLegDirection;
  /** Worst rate this close will accept, an APR fraction. */
  limitApr: number;
  clientOrderId: string;
}

/**
 * The write port. Deliberately narrow: three verbs, all user-initiated. There
 * is no "switch margin mode" verb — §6 requires that the user does that
 * themselves after cancelling and closing, and a silent mode switch is exactly
 * the thing that must not be possible from this panel.
 */
export interface BorosOrderClient {
  /**
   * Place several legs as ONE signed batch, ATOMICALLY.
   *
   * Two guarantees, and they are different:
   *
   * 1. All-or-nothing ACCEPTANCE. The batch is one on-chain `tryAggregate`
   *    submitted with `requireSuccess`, so any leg the venue refuses reverts
   *    the whole thing. No implementation may fall back to per-leg submission:
   *    that is precisely how a user ends up unhedged believing they are hedged.
   * 2. No nonce race. Boros enforces strictly increasing nonces PER SIGNER and
   *    both legs share one agent key, so two concurrent single-leg calls would
   *    have the loser rejected outright. One batch also keeps the legs
   *    simultaneous rather than making the second wait behind the first's own
   *    market impact.
   *
   * ⚠ It does NOT guarantee a full fill: an IOC that matches part of its size
   * succeeds, so a leg can still come back short. Callers must keep reporting
   * the residual.
   *
   * Returns one fill per request, in the same order.
   */
  placeMarketOrders(reqs: BorosMarketOrderRequest[]): Promise<BorosLegFill[]>;
  /** Force-cancel every resting order on one market (§6A remediation). */
  cancelOrders(marketId: number): Promise<void>;
  /** Force-close the whole netted position on one market (§6A remediation). */
  closePosition(req: BorosClosePositionRequest): Promise<BorosLegFill>;
  getGasBalance?(): Promise<number | null>;
  payTreasury?(amountUsd: number, marketId: number): Promise<void>;
}

/** The rate bound one leg carries, from its estimate and its tolerance. */
export function limitAprFor(
  direction: BorosLegDirection,
  estimatedApr: number,
  slippageApr: number,
): number {
  const slip = Number.isFinite(slippageApr) && slippageApr > 0 ? slippageApr : 0;
  return direction === 'short' ? estimatedApr - slip : estimatedApr + slip;
}

export interface SubmitBorosPairInput {
  client: BorosOrderClient;
  /**
   * null = this leg is NOT submitted.
   *
   * A leg with nothing to trade — a close against a market the account is flat
   * on, or the untouched half of a single-leg completion — must never reach the
   * venue. Sending it as a zero-size order also sends a rate bound derived from
   * a null execution rate, and because both legs share one batch that entry's
   * rejection can take the legitimate leg down with it.
   */
  legA: BorosMarketOrderRequest | null;
  legB: BorosMarketOrderRequest | null;
  /** Fee drag already priced into the simulation's spread numbers, so the
   * realised spread is quoted on the same basis as the estimate it is compared
   * against. An APR fraction. */
  feeDragApr: number;
  /** Which leg receives fixed — fixes the sign of the realised spread. */
  receiveLeg: 'A' | 'B';
}

export interface BorosPairResult {
  legA: BorosLegFill;
  legB: BorosLegFill;
  /** min(|fill A|, |fill B|) — the part that actually ended up hedged. */
  hedgedSize: number;
  /** |fill A − fill B| — what is left directional, and on which leg. */
  unhedgedSize: number;
  /** The leg carrying the residual; null when the fills matched. */
  unhedgedLeg: 'A' | 'B' | null;
  /** Realised spread from the ACTUAL fills, net of the same fee drag as the
   * estimate. Null unless both legs got a fill to compute it from. */
  realisedSpreadApr: number | null;
  /** True when either leg fell short — the panel shows the residual and the
   * three follow-up actions rather than a clean success. */
  partial: boolean;
  /** False when only one leg was submitted (a completion). */
  bothLegsSubmitted: boolean;
}

/**
 * Fire both legs and report what came back.
 *
 * The legs go out in ONE atomic batch and on purpose: sequencing them would
 * leave the second exposed to whatever the first one's own impact did to the
 * market, which is the exact risk this panel exists to remove — and a refusal
 * of either would leave the other standing alone. A throw is folded into
 * failed `BorosLegFill`s rather than rejecting the pair, because the panel
 * still has to say what happened; with an atomic submission that throw covers
 * every leg, which is why all of them are reported failed together.
 */
export async function submitBorosPair(input: SubmitBorosPairInput): Promise<BorosPairResult> {
  const failed = (req: BorosMarketOrderRequest, err: unknown): BorosLegFill => ({
    marketId: req.marketId,
    direction: req.direction,
    filledSize: 0,
    shortfallSize: req.size,
    execApr: null,
    feeSize: null,
    failure: { code: classifyLegFailure(err), message: describeLegFailure(err) },
  });

  /** A leg that was never submitted: no fill, no shortfall, no failure. */
  const notSubmitted = (which: 'A' | 'B'): BorosLegFill => ({
    marketId: 0,
    direction: which === 'A' ? 'short' : 'long',
    filledSize: 0,
    shortfallSize: 0,
    execApr: null,
    feeSize: null,
    failure: null,
  });

  // ONE batch, not two concurrent sends — see `placeMarketOrders`. A throw here
  // covers every submitted leg, so all are reported failed rather than one
  // silently vanishing.
  const submitted: Array<{ key: 'A' | 'B'; req: BorosMarketOrderRequest }> = [];
  if (input.legA) submitted.push({ key: 'A', req: input.legA });
  if (input.legB) submitted.push({ key: 'B', req: input.legB });

  const byKey = new Map<'A' | 'B', BorosLegFill>();
  if (submitted.length > 0) {
    try {
      const fills = await input.client.placeMarketOrders(submitted.map((x) => x.req));
      submitted.forEach(({ key, req }, i) => {
        byKey.set(key, fills[i] ?? failed(req, new Error(`no result returned for leg ${key}`)));
      });
    } catch (err) {
      for (const { key, req } of submitted) byKey.set(key, failed(req, err));
    }
  }
  const legA = byKey.get('A') ?? notSubmitted('A');
  const legB = byKey.get('B') ?? notSubmitted('B');

  const fillA = Math.abs(legA.filledSize);
  const fillB = Math.abs(legB.filledSize);
  // Pair-level hedge accounting only means anything when BOTH legs were sent.
  // On a single-leg completion the one fill is CLOSING a gap, so reporting it
  // as an unhedged residual would state the exact opposite of what happened.
  const bothSubmitted = submitted.length === 2;
  const hedgedSize = bothSubmitted ? Math.min(fillA, fillB) : 0;
  const unhedgedSize = bothSubmitted ? Math.abs(fillA - fillB) : 0;

  const recv = input.receiveLeg === 'A' ? legA : legB;
  const pay = input.receiveLeg === 'A' ? legB : legA;
  const realisedSpreadApr =
    recv.execApr === null || pay.execApr === null
      ? null
      : recv.execApr - pay.execApr - input.feeDragApr;

  return {
    legA,
    legB,
    hedgedSize,
    unhedgedSize,
    unhedgedLeg: unhedgedSize === 0 ? null : fillA > fillB ? 'A' : 'B',
    /** False when only one leg was sent (a completion), so the report can drop
     * the pair-level framing rather than imply a half-done pair. */
    bothLegsSubmitted: bothSubmitted,
    realisedSpreadApr,
    partial: submitted.some(({ key }) => (byKey.get(key)?.shortfallSize ?? 0) > 0),
  };
}

/**
 * Map a venue/transport error onto the taxonomy the panel branches on. The
 * rate-deviation case is checked FIRST and on its own terms: it is the one
 * failure whose remedy ("your rate was too far from mark") is different from
 * every other, and a generic price/limit rule would otherwise swallow it.
 */
export function classifyLegFailure(err: unknown, marketEntered = false): BorosLegFailureCode {
  const text = describeLegFailure(err).toUpperCase();
  if (/RATE_DEVIATION|DEVIATION|RATE_OUT_OF_(RANGE|BOUND)|MARK_DEVIATION/.test(text)) {
    return 'rate-deviation';
  }
  if (/INSUFFICIENT_LIQUIDITY|NO_LIQUIDITY|NOT_ENOUGH_(DEPTH|LIQUIDITY)|BOOK_EMPTY|DEPTH/.test(text)) {
    return 'insufficient-depth';
  }
  if (/INSUFFICIENT[ _]GAS|GAS[ _]BALANCE/.test(text) || (marketEntered && /TOP UP/.test(text))) {
    return 'no-gas';
  }
  if (/INSUFFICIENT_(MARGIN|BALANCE|COLLATERAL)|NOT_ENOUGH_(MARGIN|BALANCE)|MARGIN/.test(text)) {
    return 'insufficient-margin';
  }
  // A classified CoreError beats message-sniffing: the category was set by
  // whoever raised it and does not depend on wording surviving a venue's copy
  // change.
  if (err instanceof CoreError) {
    if (err.category === 'insufficient-margin') return 'insufficient-margin';
    if (err.category === 'network' || err.category === 'rate-limited') return 'unknown';
  }
  if (/TIMEOUT|NETWORK|UNREACHABLE|ECONN|ABORT/.test(text)) return 'unknown';
  return 'rejected';
}

/**
 * A usable sentence out of whatever the SDK threw.
 *
 * The SDK talks to the Boros backend over axios, and an axios rejection's
 * `.message` is the useless "Request failed with status code 400" — the reason
 * lives in `response.data`. Reporting the bare message strands the user with a
 * status code and no cause, which is exactly what the catch-all `rejected`
 * classification then shows them. Mirrors `describeError`'s approach for Gate.
 */
export function describeLegFailure(err: unknown): string {
  const e = err as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };
  const status = e?.response?.status;
  const body = e?.response?.data;
  const detail = extractApiDetail(body);
  if (detail) return status ? `HTTP ${status}: ${detail}` : detail;
  if (status) return `HTTP ${status}${e?.message ? ` (${e.message})` : ''}`;
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

/** Pull the human part out of an error body, whatever shape it arrived in.
 *
 * Exported because `classifyLegFailure` below regex-matches the text this
 * produces: a second extractor with its own key list would put a leg in a
 * different failure CATEGORY for the same venue response. */
export function extractApiDetail(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === 'string') return body.trim() || null;
  if (typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'reason', 'msg', 'title']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // A validation gateway answers with a list of them.
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v.join('; ');
    // Some gateways nest one level: { error: { message } }.
    if (v && typeof v === 'object') {
      const nested = extractApiDetail(v);
      if (nested) return nested;
    }
  }
  // Nothing recognised: serialise it rather than drop it, capped so a stack or
  // an HTML error page cannot flood the panel.
  try {
    const json = JSON.stringify(body);
    if (json && json !== '{}') return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    /* circular or otherwise unserialisable */
  }
  return null;
}
