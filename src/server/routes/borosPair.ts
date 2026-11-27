/**
 * The two-leg Boros market-order panel's backend.
 *
 *   GET  /api/boros/pair/context   — the pairable universe + this account's
 *                                    netted positions and margin buckets
 *   POST /api/boros/pair/simulate  — price a pair at a size (fresh books)
 *   POST /api/boros/pair/execute   — send both legs as ONE atomic batch
 *   POST /api/boros/roll/simulate  — price a roll: the old pair's close and
 *                                    the new pair's open, judged as one
 *   POST /api/boros/roll/execute   — send all four legs as ONE all-or-nothing
 *                                    batch (see core/boros/rollover.ts)
 *
 * ⚠ THE GATE IS RE-RUN SERVER-SIDE AT EXECUTE. The client's blockers are UX;
 * these are the failsafes. `/execute` re-fetches the books, re-simulates and
 * re-evaluates before anything is submitted, so a stale tab, a hand-rolled
 * request or a race against a margin change cannot get past §7.
 *
 * Book freshness matters more here than anywhere else in the app. Every other
 * Boros book read rides the shared 30s TTL because it only ever backs a
 * DISPLAYED quote; these back an ORDER, so they use their own short-TTL key
 * (`TTL.borosBookTrade`) and never share a cache entry with the scan.
 */
import type { FastifyInstance } from 'fastify';
import {
  BOROS_TOKEN_SYMBOLS,
  fetchBorosCollaterals,
  fetchBorosMarkets,
  fetchBorosOrderBook,
  norm18,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
  type BorosCollateralZone,
  type BorosMarket,
  type BorosOrderBook,
  type FetchLike,
} from '../../core/boros/client';
import { borosInitialMarginUsd, borosTimeToMaturitySec, normalizeUnderlying } from '../../core/boros/opportunities';
import { isSupportedCoin } from '../../core/coins';
import { isSpreadMarket, knownRateOf } from '../../core/boros/spread';
import { normalizeVenue } from '../../core/boros/venue';
import { readAgentApproval } from '../borosAgentApproval';
import { isUpdating } from '../updater';
import {
  classifyLegFailure,
  describeLegFailure,
  limitAprFor,
} from '../../core/boros/orders';
import {
  evaluateRollGate,
  rollFillKeys,
  rollPlanFor,
  submitBorosRoll,
  type BorosRollResult,
  type RollGate,
  type RollOrderIds,
} from '../../core/boros/rollover';
import {
  chooseGasTopUpZone,
  attachMaxFundedSize,
  evaluatePairGate,
  pairEligibility,
  reducingOrderSize,
  simulateBorosPair,
  DEFAULT_SLIPPAGE_APR,
  MAX_SLIPPAGE_APR,
  MIN_ORDER_VALUE_USD,
  type BorosLegDirection,
  type BorosMarginBucket,
  type BorosPairAccountState,
  type BorosPairLegInput,
  type BorosPairSimulation,
  type PairBlocker,
  type PairIntent,
  type RestingOrderMargin,
} from '../../core/boros/pair';
import { CoreError } from '../../core/errors';
import { PLAN_NOTE, PLAN_SHARE } from '../../core/positionLimit';
import type { AppDeps } from '../app';
import {
  CLOSE_RUNNING,
  EXECUTION_MEMO_MS,
  MAY_HAVE_FILLED,
  ORDER_RUNNING,
  forgetBorosExecutions,
  freeCrossOf,
  gasTopUpMarketFor,
  lockBorosMarkets,
  pendingBorosExecutions,
  sendBorosPair,
  type BorosCloseDeps,
} from '../borosClose';
import { TTL } from '../cache';
import { catchRateLimit, refuse } from '../errorReply';
import { perpLimitBreach } from '../perpLimit';
import { livePerps } from './symbols';

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const HEDGE_LIMIT_UNREAD = 'Could not check the hedge against the perp position limit. Try again.';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const CLOSE_ISOLATED = 'This position is on isolated margin. Close it on Boros.';
const READS_LIMITED_NOTHING_SENT = 'Boros is limiting requests. Nothing was sent. Try again in a minute.';
const READS_LIMITED_AFTER_CANCEL =
  'Boros is limiting requests. Your open orders on this market were cancelled. The close was not sent. Try again in a minute.';

/**
 * Rate tolerance a §6A force-close carries, as an APR fraction. Wider than a
 * normal entry (100 ticks vs the default 25): the user is unblocking a pair,
 * not hunting a rate, and a close that keeps missing its bound leaves them
 * stuck behind the same blocker. Still bounded, and still reported.
 */
const CLOSE_SLIPPAGE_APR = 0.01;

/** Wire shape of one leg, as the panel sends it. */
interface LegBody {
  marketId?: unknown;
  direction?: unknown;
  slippageApr?: unknown;
  size?: unknown;
  /**
   * Replay keys, one per leg.
   *
   * ⚠ NOT venue-enforced. Boros's order DTO carries no client order id, so
   * these are deduped HERE (see `recentExecutions`) — a resend of the same
   * ids returns the first result instead of trading again. That covers the
   * lost-response retry this panel actually produces; it cannot protect
   * against a different process or a restart.
   */
  clientOrderId?: unknown;
}

export interface PairBody {
  address?: unknown;
  legs?: unknown;
  intent?: unknown;
  /** §4 acknowledgement, required whenever a leg opposes an existing position. */
  opposingAcknowledged?: unknown;
  onlyLeg?: unknown;
  /** The perps the next step sends against this open. */
  hedge?: unknown;
}

interface HedgePlan {
  base: string;
  longVenue: string | null;
  shortVenue: string | null;
}

interface RollStepBody {
  legs?: unknown;
}

interface RollBody {
  address?: unknown;
  /** The pair being left. Priced as a close, acknowledged by construction —
   * a roll IS closing these legs. */
  exit?: RollStepBody;
  /** The pair being entered, at the same size. */
  entry?: RollStepBody;
  /** §4 acknowledgement for the ENTRY, when a new leg opposes something
   * already held at the new maturity. */
  opposingAcknowledged?: unknown;
  /** Replay keys, one per leg, deduped as one (see `recentRolls`). */
  clientOrderIds?: unknown;
}

function parseHedge(raw: unknown): HedgePlan | null {
  if (raw === undefined || raw === null) return null;
  const h = raw as Record<string, unknown>;
  const venue = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  if (typeof h.base !== 'string' || h.base === '') throw new CoreError('hedge.base must be a coin', 'validation');
  return { base: h.base.toUpperCase(), longVenue: venue(h.longVenue), shortVenue: venue(h.shortVenue) };
}

function parseOnlyLeg(raw: unknown, count: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < count) return raw;
  throw new CoreError('onlyLeg must be the index of a leg', 'validation');
}

/**
 * The account the agent key actually signs for, lower-cased; null when this
 * install cannot place orders.
 *
 * Every WRITE route must derive or verify its account against this. The gate in
 * `evaluatePairGate` reasons over one account's margin, positions and
 * acknowledgements while `submitBorosPair` signs for another unless they are
 * bound — a confused deputy in which the caller picks the state that authorises
 * a capability only the server holds, which is exactly what this module's
 * header claims a hand-rolled request cannot do.
 */
export function configuredRoot(): string | null {
  const root = process.env.BOROS_ROOT_ADDRESS?.trim();
  return root && EVM_ADDRESS_RE.test(root) ? root.toLowerCase() : null;
}

/**
 * Refuse to price a WRITE against any account but the one that will be traded.
 *
 * Rejected rather than silently substituted: a client asking about account A
 * while the server trades account B has a bug, and quietly redirecting it would
 * trade an account the caller never asked about.
 */
function assertTradableAddress(address: string): void {
  const root = configuredRoot();
  if (root && address !== root) {
    throw new CoreError(
      'address does not match the account this install signs for — refusing to trade a different account than the one priced.',
      'validation',
    );
  }
}

function parseAddress(raw: unknown): string {
  if (typeof raw !== 'string' || !EVM_ADDRESS_RE.test(raw)) {
    throw new CoreError('invalid EVM address (expected 0x + 40 hex chars)', 'validation');
  }
  return raw.toLowerCase();
}

interface ParsedLeg {
  marketId: number;
  direction: BorosLegDirection;
  slippageApr: number;
  size: number;
  clientOrderId: unknown;
}

function parseLeg(raw: LegBody | undefined, which: string): ParsedLeg {
  const marketId = Number(raw?.marketId);
  if (!Number.isInteger(marketId) || marketId <= 0) {
    throw new CoreError(`${which}.marketId must be a positive integer`, 'validation');
  }
  const direction = raw?.direction;
  if (direction !== 'long' && direction !== 'short') {
    throw new CoreError(`${which}.direction must be "long" or "short"`, 'validation');
  }
  // An absent tolerance takes the default; a present one must be a real number
  // in range. Silently coercing a bad value would set the rate bound the order
  // actually carries, so it is rejected instead.
  let slippageApr = DEFAULT_SLIPPAGE_APR;
  if (raw?.slippageApr !== undefined && raw.slippageApr !== null) {
    const n = Number(raw.slippageApr);
    if (!Number.isFinite(n) || n < 0 || n > MAX_SLIPPAGE_APR) {
      throw new CoreError(
        `${which}.slippageApr must be between 0 and ${MAX_SLIPPAGE_APR} (an APR fraction, not percent)`,
        'validation',
      );
    }
    slippageApr = n;
  }
  return { marketId, direction, slippageApr, size: parseSize(raw?.size, which), clientOrderId: raw?.clientOrderId };
}

function parseLegs(raw: unknown): ParsedLeg[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CoreError('legs must hold at least one leg', 'validation');
  }
  return raw.map((leg, i) => parseLeg(leg as LegBody, `legs[${i}]`));
}

function parseSize(raw: unknown, which: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CoreError(`${which}.size must be a positive number of collateral units`, 'validation');
  }
  return n;
}

function parseIntent(raw: unknown): PairIntent {
  if (raw === undefined || raw === null || raw === 'open') return 'open';
  if (raw === 'close') return 'close';
  throw new CoreError('intent must be "open" or "close"', 'validation');
}

function parseClientOrderId(raw: unknown, which: string): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(raw)) {
    throw new CoreError(`${which} must be 8-64 chars of [A-Za-z0-9_-]`, 'validation');
  }
  return raw;
}

/**
 * Per-(account, market) state the panel needs: the NETTED position, whether it
 * sits in an isolated bucket, and that bucket's free collateral.
 *
 * Available = netBalance − initial margin already committed. Bonds and pending
 * withdrawals are NOT part of the shape the Boros summary returns, so anything
 * of that kind is already excluded from `netBalance` upstream; if that ever
 * stops being true this is the one place to correct it (§6 requires they not
 * count as available).
 */
export interface AccountView {
  /** marketId → signed netted size, collateral units (+ long fixed). */
  positionByMarket: Map<number, number>;
  /**
   * marketId → the SAME position as the venue's own 18-decimal integer,
   * verbatim.
   *
   * ⚠ Kept beside the float rather than derived from it, because it cannot be
   * derived from it. `norm18` divides an 18-decimal integer into a double and
   * loses the low-order digits; converting back can land ABOVE where it
   * started. Everything that only displays or compares is happy with the
   * float — a close, which places an order in these units on a venue with no
   * reduce-only flag, is not. See `BorosClosePositionRequest.openSizeWei`.
   */
  positionRawByMarket: Map<number, string>;
  /** marketId → initial margin that position already posts, collateral units. */
  committedMarginByMarket: Map<number, number>;
  /** marketId → true when that market currently sits in an ISOLATED bucket. */
  isolatedMarkets: Set<number>;
  /** marketId → whether that isolated bucket holds anything at all. */
  isolatedOccupied: Set<number>;
  /** tokenId → the cross bucket for that collateral. */
  crossByToken: Map<number, BorosMarginBucket>;
  /** tokenId → free cross margin net of resting orders' margin too, which
   * `payTreasury`'s `_checkIMStrict` counts. Absent when a zone's order margin
   * is unknown. */
  crossFreeWithOrdersByToken: Map<number, number>;
  /** marketId → that market's own isolated bucket. */
  isolatedByMarket: Map<number, BorosMarginBucket>;
  /** Markets with a resting order in the cross account — what a close or roll cancels. */
  restingOrderMarkets: Set<number>;
  orderMarginByMarket: Map<number, RestingOrderMargin>;
}

function holdsPositionOrOrders(p: {
  notionalSize: string;
  initialMargin?: string;
  positionInitialMargin: string;
  hasRestingOrders?: boolean;
}): boolean {
  return (
    norm18(p.notionalSize) !== 0 ||
    p.hasRestingOrders === true ||
    (p.initialMargin !== undefined &&
      norm18(p.initialMargin) > norm18(p.positionInitialMargin) + 1e-9)
  );
}

function readAccount(zones: BorosCollateralZone[]): AccountView {
  const view: AccountView = {
    positionByMarket: new Map(),
    positionRawByMarket: new Map(),
    committedMarginByMarket: new Map(),
    isolatedMarkets: new Set(),
    isolatedOccupied: new Set(),
    crossByToken: new Map(),
    isolatedByMarket: new Map(),
    restingOrderMarkets: new Set(),
    crossFreeWithOrdersByToken: new Map(),
    orderMarginByMarket: new Map(),
  };
  for (const zone of zones) {
    // Cross only: that is the account a close's cancel is sent to.
    for (const p of zone.cross?.marketPositions ?? []) if (p.hasRestingOrders) view.restingOrderMarkets.add(p.marketId);
    if (zone.cross) {
      const used = zone.cross.marketPositions.reduce(
        (s, p) => s + norm18(p.positionInitialMargin ?? p.initialMargin),
        0,
      );
      view.crossByToken.set(zone.tokenId, {
        available: norm18(zone.cross.netBalance) - used,
        hasPositionOrOrders: zone.cross.marketPositions.some(holdsPositionOrOrders),
      });
      if (zone.cross.marketPositions.every((p) => !p.hasRestingOrders || p.initialMargin !== undefined)) {
        const usedWithOrders = zone.cross.marketPositions.reduce(
          (s, p) => s + Math.max(norm18(p.initialMargin ?? '0'), norm18(p.positionInitialMargin ?? p.initialMargin)),
          0,
        );
        view.crossFreeWithOrdersByToken.set(zone.tokenId, norm18(zone.cross.netBalance) - usedWithOrders);
        const bucket = view.crossByToken.get(zone.tokenId);
        if (bucket) bucket.availableWithOrders = norm18(zone.cross.netBalance) - usedWithOrders;
      }
      for (const p of zone.cross.marketPositions) {
        if (p.restingOrderMargin) {
          const o = p.restingOrderMargin;
          view.orderMarginByMarket.set(p.marketId, {
            long: norm18(o.long),
            short: norm18(o.short),
            longSize: norm18(o.longSize),
            shortSize: norm18(o.shortSize),
          });
        }
        view.positionByMarket.set(p.marketId, norm18(p.notionalSize));
        view.positionRawByMarket.set(p.marketId, String(p.notionalSize ?? '0'));
        view.committedMarginByMarket.set(
          p.marketId,
          norm18(p.positionInitialMargin ?? p.initialMargin),
        );
      }
    }
    for (const group of zone.isolated) {
      const used = group.marketPositions.reduce(
        (s, p) => s + norm18(p.positionInitialMargin ?? p.initialMargin),
        0,
      );
      const occupied = group.marketPositions.some(holdsPositionOrOrders);
      for (const p of group.marketPositions) {
        const size = norm18(p.notionalSize);
        view.positionByMarket.set(p.marketId, size);
        view.positionRawByMarket.set(p.marketId, String(p.notionalSize ?? '0'));
        view.committedMarginByMarket.set(
          p.marketId,
          norm18(p.positionInitialMargin ?? p.initialMargin),
        );
        view.isolatedMarkets.add(p.marketId);
        if (occupied) view.isolatedOccupied.add(p.marketId);
        view.isolatedByMarket.set(p.marketId, {
          available: norm18(group.netBalance) - used,
          hasPositionOrOrders: occupied,
        });
      }
    }
  }
  return view;
}

interface RollPayload {
  result: BorosRollResult;
  exit: { simulation: ReturnType<typeof simulateBorosPair>; gate: ReturnType<typeof evaluatePairGate> };
  entry: { simulation: ReturnType<typeof simulateBorosPair>; gate: ReturnType<typeof evaluatePairGate> };
  gate: RollGate;
}
const recentRolls = new Map<string, { at: number; result: Promise<RollPayload> }>();
const sweepRolls = (): void => {
  const now = Date.now();
  for (const [k, v] of recentRolls) {
    if (now - v.at > EXECUTION_MEMO_MS) recentRolls.delete(k);
  }
};

export function borosExecutionsPending(): number {
  const executions = pendingBorosExecutions();
  sweepRolls();
  return executions + recentRolls.size;
}

export type PairPricer = ReturnType<typeof createPairPricer>;

export function createPairPricer(deps: AppDeps) {
  const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);
  const envTakerFee = Number(process.env.BOROS_TAKER_FEE_OVERRIDE);
  const takerFeeOverride = Number.isFinite(envTakerFee) ? envTakerFee : undefined;

  const loadMarkets = async (fresh: boolean): Promise<BorosMarket[]> =>
    (await deps.cache.get('boros:markets', TTL.boros, () => fetchBorosMarkets(fetchImpl), { fresh }))
      .value;

  /**
   * The markets a QUOTE is priced from, on their own short TTL (see
   * TTL.borosQuote). A key of its own: the cache stamps an entry with the
   * TTL of whoever fetched it, so sharing `boros:markets` would hand a quote
   * the 30s copy the rest of the app is content with.
   */
  const loadQuoteMarkets = async (fresh: boolean): Promise<BorosMarket[]> =>
    (await deps.cache.get('boros:markets:quote', TTL.borosQuote, () => fetchBorosMarkets(fetchImpl), { fresh }))
      .value;

  const loadAccount = async (address: string, fresh: boolean): Promise<AccountView> => {
    // Market config only picks the IM branch; it never needs a fresh read.
    const markets = await loadMarkets(false);
    const { value } = await deps.cache.get(
      `boros:collaterals:${address}`,
      TTL.boros,
      () => fetchBorosCollaterals(fetchImpl, address, markets),
      { fresh },
    );
    return readAccount(value);
  };

  const settleMaxMs = deps.borosSettle?.maxMs ?? 6_000;
  const settleSleep = deps.borosSettle?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /**
   * After a Boros write: re-read the account until Boros shows the trade,
   * keep that read cached for the cards, then drop the fills it changed.
   * Boros shows a batch 1–2 s after the send returns, so the page's instant
   * re-read got the old position and the cache kept it for 30 s (2026-10-16).
   * A read that never shows the trade (nothing filled, or Boros is slow) is
   * not kept.
   */
  const settleAfterWrite = async (address: string, before: AccountView, traded: readonly number[]): Promise<void> => {
    const raw = (a: AccountView, id: number) => a.positionRawByMarket.get(id) ?? '0';
    const deadline = Date.now() + settleMaxMs;
    for (;;) {
      const after = await loadAccount(address, true).catch(() => null);
      if (after && traded.some((id) => raw(after, id) !== raw(before, id))) break;
      if (after === null || Date.now() + 1_000 > deadline) {
        deps.cache.bust(`boros:collaterals:${address}`);
        break;
      }
      await settleSleep(1_000);
    }
    // After the wait, not before it: a card poll during the wait would
    // re-read the fills before Boros shows the trade, and keep that read.
    bustBorosFills(deps.cache, traded);
    // A send spends gas, and a send at gas debt tops it up.
    deps.cache.bust('boros:gas-balance');
  };

  /** A book fresh enough to place an order against — never the scan's entry. */
  const loadTradeBook = async (marketId: number): Promise<BorosOrderBook | null> => {
    try {
      const { value } = await deps.cache.get(
        `boros:book:trade:${marketId}`,
        TTL.borosBookTrade,
        () => fetchBorosOrderBook(fetchImpl, marketId),
      );
      return value;
    } catch {
      // A book that will not load degrades to null: the math turns that into a
      // named blocker, which is far better than failing the whole request and
      // leaving the panel with nothing to explain.
      return null;
    }
  };

  const marketOr404 = (markets: BorosMarket[], marketId: number): BorosMarket => {
    const m = markets.find((x) => x.marketId === marketId);
    if (!m) throw new CoreError(`Unknown Boros market ${marketId}`, 'symbol-invalid');
    return m;
  };

  /** undefined = this install cannot read it; null = the read failed. */
  const readGasBalance = async (fresh: boolean): Promise<number | null | undefined> => {
    const ordersForGas = deps.getBorosOrders?.();
    const read = ordersForGas?.getGasBalance?.bind(ordersForGas);
    if (!read) return undefined;
    try {
      return (await deps.cache.get('boros:gas-balance', TTL.boros, read, { fresh })).value;
    } catch {
      return null;
    }
  };

  /**
   * A blocker when the perps that hedge this open would break their position
   * limit. CrossEx refuses those perps only after the Boros legs have filled,
   * which leaves the rate leg unhedged, so the open is refused before it.
   * The check uses PLAN_SHARE of the limit; the perps are checked again at
   * the full limit when they are sent.
   */
  const hedgeLimitBlocker = async (
    hedge: HedgePlan,
    simulation: BorosPairSimulation,
    collateralPriceUsd: number | null,
    fresh: boolean,
  ): Promise<PairBlocker | null> => {
    if (!deps.engine || !(Number(collateralPriceUsd) > 0)) return null;
    const growth = Math.max(
      0,
      ...simulation.legs.map((l) => Math.abs(l.sizing.resultingSize) - Math.abs(l.sizing.currentSize)),
    );
    if (!(growth > 0)) return null;
    const notionalUsd = growth * Number(collateralPriceUsd);
    try {
      const { list } = await livePerps(deps, false);
      const legs = (
        [
          [hedge.longVenue, 'BUY'],
          [hedge.shortVenue, 'SELL'],
        ] as const
      ).flatMap(([venue, side]) => {
        const contract = list.find((s) => s.base === hedge.base && s.exchange === venue)?.symbol;
        return contract ? [{ contract, side, notionalUsd }] : [];
      });
      const breach = await perpLimitBreach(deps, legs, { share: PLAN_SHARE, fresh });
      if (breach?.reason === 'over') {
        return {
          code: 'perp-limit',
          message: `The hedge takes ${breach.contract} to ${usd(breach.afterUsd)}, above ${usd(breach.maxUsd)} (${PLAN_NOTE}). The perps can add at most ${usd(breach.roomQty * breach.priceUsd)}.`,
        };
      }
      if (breach) return { code: 'perp-limit', message: HEDGE_LIMIT_UNREAD };
      return null;
    } catch {
      return { code: 'perp-limit', message: HEDGE_LIMIT_UNREAD };
    }
  };

  /**
   * Everything from a validated body up to (but not including) submission —
   * shared verbatim by /simulate and /execute so the two can never price the
   * same request differently.
   */
  const priceRequest = async (
    body: PairBody,
    fresh: boolean,
    /** A roll prices two steps off ONE read of the account and the gas
     * budget, so both are judged against the same state. */
    preloaded?: { markets: BorosMarket[]; account: AccountView; gasBalanceUsd: number | null | undefined },
  ) => {
    const address = parseAddress(body.address);
    const parsed = parseLegs(body.legs);
    const intent = parseIntent(body.intent);
    const onlyLeg = parseOnlyLeg(body.onlyLeg, parsed.length);
    const hedge = parseHedge(body.hedge);

    const [markets, account] = preloaded
      ? [preloaded.markets, preloaded.account]
      : await Promise.all([loadQuoteMarkets(fresh), loadAccount(address, fresh)]);
    const legMarkets = parsed.map((leg) => marketOr404(markets, leg.marketId));
    const nowSec = Math.floor(Date.now() / 1000);
    const eligibility = pairEligibility(legMarkets, nowSec, intent);

    // Only walk books once the pair is worth pricing — an ineligible pair has a
    // reason to show, not a quote. The gas read needs neither, so it runs
    // beside the books (both catch every error).
    const [books, gasBalanceUsd] = await Promise.all([
      eligibility.eligible ? Promise.all(legMarkets.map((m) => loadTradeBook(m.marketId))) : legMarkets.map(() => null),
      preloaded ? preloaded.gasBalanceUsd : readGasBalance(fresh),
    ]);

    const legs: BorosPairLegInput[] = legMarkets.map((market, i) => ({
      market,
      book: books[i],
      direction: parsed[i].direction,
      slippageApr: parsed[i].slippageApr,
      currentSize: account.positionByMarket.get(market.marketId) ?? 0,
      committedMargin: account.committedMarginByMarket.get(market.marketId) ?? 0,
      restingOrderMargin: account.orderMarginByMarket.get(market.marketId),
      isolatedOnly: market.isolatedOnly,
      onIsolatedMargin: account.isolatedMarkets.has(market.marketId),
      isolatedHasPositionOrOrders: account.isolatedOccupied.has(market.marketId),
    }));
    const tokenId = legMarkets[0].tokenId;
    const collateralPriceUsd = resolveCollateralPricesUsd(markets).get(tokenId) ?? null;

    const simInput = {
      legs: legs.map((leg, i) => ({ ...leg, size: parsed[i].size })),
      intent,
      onlyLeg,
      collateralPriceUsd,
      nowSec,
      takerFeeOverride,
    };
    const simulation = simulateBorosPair(simInput);

    // The best-funded OTHER coin, for an open whose own coin cannot spare the
    // gas top-up after its legs.
    const fallbackZone = chooseGasTopUpZone({
      amountUsd: 0,
      markets,
      freeCrossByToken: new Map([...freeCrossOf(account)].filter(([t]) => t !== tokenId)),
      pricesUsd: resolveCollateralPricesUsd(markets),
    });
    const accountState: BorosPairAccountState = {
      cross: account.crossByToken.get(tokenId) ?? null,
      isolatedByMarket: account.isolatedByMarket,
      gasBalanceUsd,
      gasFallbackFreeUsd: fallbackZone.ok ? fallbackZone.freeUsd : null,
    };
    const simulatedAtMs = Date.now();
    const gateInput = {
      legs,
      account: accountState,
      eligibility,
      opposingAcknowledged: body.opposingAcknowledged === true,
      simulatedAtMs,
      nowMs: simulatedAtMs,
    };
    const gate = evaluatePairGate({ ...gateInput, simulation });
    attachMaxFundedSize(gate, simInput, gateInput);
    if (intent === 'open' && hedge) {
      const blocker = await hedgeLimitBlocker(hedge, simulation, collateralPriceUsd, fresh);
      if (blocker) gate.blockers.push(blocker);
    }

    return {
      simulation,
      gate,
      eligibility,
      legs,
      parsed,
      simulatedAtMs,
      intent,
      gasBalanceUsd,
      account,
      markets,
    };
  };

  return { loadMarkets, loadQuoteMarkets, loadAccount, settleAfterWrite, marketOr404, readGasBalance, priceRequest };
}

/**
 * What opening ONE unit of size on this market takes out of its collateral
 * bucket, in collateral units: the initial margin plus the taker fee. Both are
 * linear in size (IM = N × max(|apr|, floor) × max(DTM, tThresh)/365 × kIM;
 * fee = takerFeeRate × N × years), so the ticket divides the bucket's
 * available by this to state the size it can fund. The rate is the larger of
 * mark and mid. The book is not read here, so the fill's cost against mark is
 * not in it: on a thin book the gate funds less than this, and its margin
 * blocker offers the size that fits. Null when the market carries no margin
 * inputs.
 */
function openCostPerSize(m: BorosMarket, nowSec: number): number | null {
  const rate = Math.max(Math.abs(m.markApr), Math.abs(m.midApr));
  const im = borosInitialMarginUsd(m, rate, 1, nowSec);
  if (im === null) return null;
  const years = borosTimeToMaturitySec(m, nowSec) / (365 * 86_400);
  const fee = Number.isFinite(m.takerFeeRate) && m.takerFeeRate > 0 ? m.takerFeeRate * years : 0;
  const cost = im + fee;
  return cost > 0 ? cost : null;
}

/**
 * Drop the cached Boros fills a write changed: the traded markets', held or
 * closed (closed, re-opened and closed again, the closed entry would miss the
 * new fills). No other market has a new fill from this write. Busting every
 * market re-read each one, paced under the venue's rate limit: the cards then
 * took about 50 s to show a trade (2026-10-16).
 */
function bustBorosFills(cache: AppDeps['cache'], marketIds: readonly number[]): void {
  const traded = new Set(marketIds.map(String));
  cache.bustWhere((key) => key.startsWith('boros:txns:') && traded.has(key.split(':')[3]));
}

function assertNotUpdating(): void {
  if (isUpdating()) {
    throw new CoreError(
      'The app is updating. It restarts shortly, then you can send this again.',
      'validation',
    );
  }
}

async function assertAgentNotExpired(deps: AppDeps): Promise<void> {
  const refuseExpired = (): never => {
    throw new CoreError(
      'Your Boros login has expired. Log in again before trading.',
      'auth',
    );
  };
  const raw = Number(process.env.BOROS_AGENT_EXPIRY);
  if (Number.isFinite(raw) && raw > 0 && raw <= Math.floor(Date.now() / 1000)) refuseExpired();
  const root = process.env.BOROS_ROOT_ADDRESS;
  const agentPrivateKey = process.env.BOROS_AGENT_PRIVATE_KEY;
  if (!root || !agentPrivateKey) return;
  const approval = await readAgentApproval(
    resolveBorosFetch(deps.borosFetch),
    { root, accountId: Number(process.env.BOROS_ACCOUNT_ID ?? 0) || 0, agentPrivateKey },
    { timeoutMs: 2_000 },
  );
  if (approval.state === 'expired') refuseExpired();
  if (approval.state === 'not-approved') {
    throw new CoreError(
      'Your Boros login was rejected or revoked. Log in again before trading.',
      'auth',
    );
  }
}

export function createBorosCloseDeps(deps: AppDeps, pricer: PairPricer = createPairPricer(deps)): BorosCloseDeps {
  return {
    getBorosOrders: deps.getBorosOrders,
    checkCanTrade: async () => {
      assertNotUpdating();
      await assertAgentNotExpired(deps);
    },
    parseTradableAddress: (raw) => {
      const address = parseAddress(raw);
      assertTradableAddress(address);
      return address;
    },
    pricer,
  };
}

export function borosPairRoutes(deps: AppDeps) {
  forgetBorosExecutions();
  recentRolls.clear();
  /** A roll the venue REFUSED provably traded nothing, so its ids may be
   * reused for an honest retry; one that rolled or was never confirmed is
   * remembered, so a lost response answers from here instead of trading. */
  const rememberRoll = (key: string, pending: Promise<RollPayload>): void => {
    recentRolls.set(key, { at: Date.now(), result: pending });
    pending
      .then(({ result }) => {
        if (result.status === 'refused') recentRolls.delete(key);
      })
      .catch(() => recentRolls.delete(key));
  };
  const pricer = createPairPricer(deps);
  const { loadMarkets, loadQuoteMarkets, loadAccount, settleAfterWrite, marketOr404, readGasBalance, priceRequest } = pricer;
  const closeDeps = createBorosCloseDeps(deps, pricer);


  return async function plugin(app: FastifyInstance): Promise<void> {
    /** The pairable universe for one account, plus its per-market state. */
    app.get('/boros/pair/context', async (req, reply) => {
      const query = req.query as { address?: string; fresh?: string };
      const address = parseAddress(query.address);
      const fresh = query.fresh === '1';
      const [markets, account] = await Promise.all([loadMarkets(fresh), loadAccount(address, fresh)]);
      const nowSec = Math.floor(Date.now() / 1000);
      const prices = resolveCollateralPricesUsd(markets);
      const holds = (m: BorosMarket): boolean => (account.positionByMarket.get(m.marketId) ?? 0) !== 0;

      const listed = markets.filter(
        (m) =>
          m.maturity > nowSec &&
          (m.state === 'Normal' || (m.state === 'CloseOnly' && holds(m))) &&
          (isSupportedCoin(normalizeUnderlying(m.base)) || holds(m)),
      );
      const toRow = (m: BorosMarket) => ({
        marketId: m.marketId,
        name: m.name,
        venue: m.venue,
        base: m.base,
        tokenId: m.tokenId,
        // The unit a size on this market is denominated in. Sent with the
        // market rather than left to the simulation, so the ticket can
        // label its size field the moment a leg is picked.
        collateral: BOROS_TOKEN_SYMBOLS[m.tokenId] ?? '',
        maturity: m.maturity,
        midApr: m.midApr,
        markApr: m.markApr,
        // The venue's own cap on how far a trade may move the rate. Sent per
        // market because it is per market: half of it is the natural default
        // close tolerance, and a bound wider than it can never fill.
        maxRateDeviationApr: m.maxRateDeviationApr,
        isolatedOnly: m.isolatedOnly === true,
        closeOnly: m.state === 'CloseOnly',
        paused: m.state === 'Paused',
        onIsolatedMargin: account.isolatedMarkets.has(m.marketId),
        isolatedHasPositionOrOrders: account.isolatedOccupied.has(m.marketId),
        currentSize: account.positionByMarket.get(m.marketId) ?? 0,
        collateralPriceUsd: prices.get(m.tokenId) ?? null,
        openCostPerSize: openCostPerSize(m, nowSec),
        settleFeeApr: m.settleFeeApr,
              spreadVenues: m.spreadVenues,
      });
      const byName = (x: { name: string }, y: { name: string }): number => x.name.localeCompare(y.name);
      const listedSpreads = markets.filter(
        (m) => isSpreadMarket(m) && m.maturity > nowSec && (isSupportedCoin(normalizeUnderlying(m.base)) || holds(m)),
      );
      const spreadMarkets = listedSpreads
        .map((m) => ({ ...toRow(m), closeOnly: m.state !== 'Normal' }))
        .sort(byName);

      const rows = listed
        .filter((m) => !isSpreadMarket(m))
        /**
         * Drop any market this ticket could never pair — one with no partner
         * sharing its maturity, its collateral AND its base.
         *
         * This replaces a narrower `xyz:` prefix filter that existed to hide
         * Hyperliquid's BRENTOIL synthetics. The prefix was only ever a proxy
         * for the real property: a market nothing can offset is dead on
         * arrival in every simulation it appears in. Stating the property
         * directly keeps the next synthetic out for the same reason, and it
         * also removes a market that IS eligible but has no sensible partner:
         * the lone USDT-collateral BTC market sitting in a cohort of HYPE
         * markets. Left in, it appeared in the picker with a label identical
         * to the BTC-collateral market of the same name and maturity — two
         * indistinguishable options that post margin in different assets —
         * and its only available partners were a different coin entirely.
         *
         * ⚠ This is deliberately STRICTER than `pairEligibility`, which does
         * not compare bases (see src/core/boros/pair.ts §2). Eligibility says
         * what the venue will accept; this says what is worth offering. A
         * cross-base "spread" is not a spread — the legs face unrelated
         * funding curves and no CrossEx perp pair can hedge the result.
         */
        // A listed spread over the market's venue is a partner too: the HL Jan
        // singles have no Gate Jan single, only the HL-GATE spread.
        .filter(
          (m, _i, all) =>
            all.some(
              (o) =>
                o.marketId !== m.marketId &&
                o.tokenId === m.tokenId &&
                o.maturity === m.maturity &&
                o.base.toLowerCase() === m.base.toLowerCase(),
            ) ||
            listedSpreads.some(
              (s) =>
                s.tokenId === m.tokenId &&
                s.maturity === m.maturity &&
                s.base.toLowerCase() === m.base.toLowerCase() &&
                (s.spreadVenues ?? []).some((v) => normalizeVenue(v) === normalizeVenue(m.venue)),
            ),
        )
        .map(toRow)
        .sort(byName);

      return reply.ok({
        markets: rows,
        spreadMarkets,
        crossByToken: [...account.crossByToken.entries()].map(([tokenId, b]) => ({
          tokenId,
          available: b.availableWithOrders ?? b.available,
        })),
        isolatedByMarket: [...account.isolatedByMarket.entries()].map(([marketId, b]) => ({
          marketId,
          available: b.available,
        })),
        defaultSlippageApr: DEFAULT_SLIPPAGE_APR,
        maxSlippageApr: MAX_SLIPPAGE_APR,
      });
    });

    /** Price the pair. Called on a short interval while the panel is open. */
    app.post('/boros/pair/simulate', async (req, reply) => {
      const { simulation, gate, eligibility, simulatedAtMs, gasBalanceUsd } = await priceRequest(
        req.body as PairBody,
        false,
      );
      return reply.ok({
        simulation,
        gate,
        eligibility,
        simulatedAtMs,
        gasBalanceUsd: gasBalanceUsd ?? null,
      });
    });

    /**
     * Send both legs. Re-prices from scratch first — see the header note: the
     * client's gate is UX, this one is the failsafe.
     */
    app.post('/boros/pair/execute', async (req, reply) => {
      const body = req.body as PairBody;
      const address = parseAddress(body.address);
      assertTradableAddress(address);
      const bodyLegs = parseLegs(body.legs);
      const clientOrderIds = bodyLegs.map((leg, i) => parseClientOrderId(leg.clientOrderId, `legs[${i}].clientOrderId`));
      const outcome = await sendBorosPair(closeDeps, {
        body,
        address,
        marketIds: bodyLegs.map((leg) => leg.marketId),
        clientOrderIds,
      });
      if (outcome.kind === 'replayed') return reply.ok({ ...outcome.payload, replayed: true });
      if (outcome.kind === 'busy') return refuse(reply, {
        code: 409,
        category: 'validation',
        message: parseIntent(body.intent) === 'close' ? CLOSE_RUNNING : ORDER_RUNNING,
        retryable: false,
      });
      if (outcome.kind === 'refused') return refuse(reply, {
        code: 409,
        category: 'validation',
        message: outcome.message,
        retryable: false,
      });
      if (outcome.kind === 'blocked') {
        return reply.code(409).send({
          ok: false,
          error: {
            category: 'validation',
            message: outcome.blockers[0].message,
            retryable: false,
          },
          data: { blockers: outcome.blockers },
        });
      }
      const { payload, thrown } = outcome;
      if (thrown.length > 0) {
        const unknown = classifyLegFailure(thrown[0]) === 'unknown';
        return reply.code(502).send({
          ok: false,
          error: {
            category: 'network',
            message: unknown ? `${describeLegFailure(thrown[0])}${MAY_HAVE_FILLED}` : describeLegFailure(thrown[0]),
            retryable: false,
          },
          data: { ...payload, replayed: false },
        });
      }
      return reply.ok({ ...payload, replayed: false });
    });

    /**
     * Price a roll: the old pair as a close and the new pair as an open, off
     * ONE read of the account, judged as one batch (core/boros/rollover.ts).
     */
    const priceRoll = async (body: RollBody, fresh: boolean) => {
      const address = parseAddress(body.address);
      const [markets, account, gasBalanceUsd] = await Promise.all([loadQuoteMarkets(fresh), loadAccount(address, fresh), readGasBalance(fresh)]);
      const step = (raw: RollStepBody | undefined, intent: 'close' | 'open', acknowledged: boolean) =>
        priceRequest(
          { address, legs: raw?.legs, intent, opposingAcknowledged: acknowledged },
          fresh,
          { markets, account, gasBalanceUsd },
        );
      const [exit, entry] = await Promise.all([
        step(body.exit, 'close', true),
        step(body.entry, 'open', body.opposingAcknowledged === true),
      ]);
      // The venue previews the batch as it would run it. A preview that
      // cannot be had is a blocker, not a guess — nothing else can vouch for
      // a FOK fill or for the margin after the closes.
      const openSizeWei = Object.fromEntries(
        exit.simulation.legs.flatMap((l) => {
          const raw = account.positionRawByMarket.get(l.marketId);
          return raw === undefined ? [] : [[l.marketId, raw]];
        }),
      );
      const plan = rollPlanFor(exit.simulation, entry.simulation, { openSizeWei });
      const orders = deps.getBorosOrders?.();
      // A preview that throws is still "no preview", but a refusal with a
      // status code is a fact worth showing (a position the venue no longer
      // finds, an input it rejects). A 429, a 5xx or a dropped connection is
      // the next poll's problem: for those "waiting for a quote" is the truth.
      let venueError: string | null = null;
      // The roll closes the short-dated legs, so their resting orders go in
      // the same batch: one left behind could re-open a leg the roll just moved.
      // The preview cancels the same ones, or an order in a close's path
      // (MarketSelfSwap) blocks a roll the send would pass.
      const cancelOrdersOn = plan ? [...new Set(plan.closes.map((o) => o.marketId))].filter((id) => account.restingOrderMarkets.has(id)) : [];
      const preview = plan ? orders?.simulateRollOver?.(plan.closes, plan.opens, { cancelOrdersOn, fresh }) : undefined;
      const venue = preview
        ? await preview.catch((err: unknown) => {
            const status = err instanceof CoreError ? (err.details as { status?: number } | undefined)?.status : undefined;
            venueError =
              status === 429
                ? 'Boros rate limit reached. It retries in 10 s.'
                : status !== undefined && status < 500
                  ? describeLegFailure(err)
                  : null;
            return null;
          })
        : null;
      const gate = evaluateRollGate({
        exit: { simulation: exit.simulation, gate: exit.gate, legs: exit.legs },
        entry: { simulation: entry.simulation, gate: entry.gate, legs: entry.legs },
        venue,
        venueError,
      });
      return { exit, entry, gate, venue, account, openSizeWei, plan, cancelOrdersOn, simulatedAtMs: Math.min(exit.simulatedAtMs, entry.simulatedAtMs) };
    };

    app.post('/boros/roll/simulate', async (req, reply) => {
      const { exit, entry, gate, venue, cancelOrdersOn, simulatedAtMs } = await priceRoll(req.body as RollBody, false);
      return reply.ok({
        exit: { simulation: exit.simulation, gate: exit.gate },
        entry: { simulation: entry.simulation, gate: entry.gate },
        gate,
        venue,
        cancelOrdersOn,
        simulatedAtMs,
        gasBalanceUsd: entry.gasBalanceUsd ?? null,
      });
    });

    /**
     * Send the four legs as ONE all-or-nothing batch. Re-priced from scratch
     * first, exactly as /pair/execute: the client's gate is UX, this one is
     * the failsafe.
     */
    app.post('/boros/roll/execute', async (req, reply) => {
      const body = req.body as RollBody;
      assertTradableAddress(parseAddress(body.address));
      const rawIds = body.clientOrderIds;
      if (typeof rawIds !== 'object' || rawIds === null || Array.isArray(rawIds)) {
        throw new CoreError('clientOrderIds must map each leg to its id', 'validation');
      }
      const ids: RollOrderIds = Object.fromEntries(
        Object.entries(rawIds).map(([k, v]) => [k, parseClientOrderId(v, `clientOrderIds.${k}`)]),
      );
      const idList = Object.values(ids);
      if (idList.length === 0 || new Set(idList).size !== idList.length) {
        throw new CoreError('every leg needs its own clientOrderId', 'validation');
      }
      const orders = deps.getBorosOrders?.();
      if (!orders) {
        throw new CoreError('Boros order placement is not configured on this install.', 'not-configured');
      }
      assertNotUpdating();
      await assertAgentNotExpired(deps);

      // Memo BEFORE re-pricing, for the same reason as /pair/execute: a
      // lost-response retry must get the original outcome, and a roll that
      // went through changed the very state the gate would now re-judge.
      const memoKey = [...idList].sort().join('|');
      sweepRolls();
      const replay = recentRolls.get(memoKey);
      if (replay) return reply.ok({ ...(await replay.result), replayed: true });

      const unlockRoll = lockBorosMarkets([...parseLegs(body.exit?.legs), ...parseLegs(body.entry?.legs)].map((leg) => leg.marketId));
      if (!unlockRoll) return refuse(reply, { code: 409, category: 'validation', message: ORDER_RUNNING, retryable: false });
      try {
        const { exit, entry, gate, venue, account, openSizeWei, cancelOrdersOn } = await priceRoll(body, true);
        if (!orders.simulateRollOver) {
          throw new CoreError('Boros roll-over is not configured on this install.', 'not-configured');
        }
        if (gate.blockers.length > 0) {
          return reply.code(409).send({
            ok: false,
            error: { category: 'validation', message: gate.blockers[0].message, retryable: false },
            data: { blockers: gate.blockers },
          });
        }
        const plan = rollPlanFor(exit.simulation, entry.simulation, { ids, openSizeWei });
        if (!plan) throw new CoreError('a leg of this roll has nothing to trade', 'validation');
        const fillKeys = rollFillKeys(plan);
        if (fillKeys.length !== idList.length || fillKeys.some((k) => ids[k] === undefined)) {
          throw new CoreError(`clientOrderIds must name exactly these legs: ${fillKeys.join(', ')}`, 'validation');
        }

        const raced = recentRolls.get(memoKey);
        if (raced) return reply.ok({ ...(await raced.result), replayed: true });
        const gasTopUpMarket = gasTopUpMarketFor(exit.markets, account, venue?.availableAfter);
        const pending: Promise<RollPayload> = submitBorosRoll(orders, plan, { cancelOrdersOn, gasTopUpMarket }).then((result) => ({
          result,
          exit: { simulation: exit.simulation, gate: exit.gate },
          entry: { simulation: entry.simulation, gate: entry.gate },
          gate,
        }));
        rememberRoll(memoKey, pending);
        const payload = await pending;
        await settleAfterWrite(
          parseAddress(body.address),
          account,
          [...exit.simulation.legs, ...entry.simulation.legs].map((l) => l.marketId),
        );
        return reply.ok({ ...payload, replayed: false });
      } finally {
        unlockRoll();
      }
    });

    /**
     * §6A remediation, both user-initiated from the panel.
     *
     * Boros has no close primitive and no reduce-only flag, so the "close" half
     * is an ordinary opposing market order. Its size, direction and rate bound
     * are derived HERE from the live netted position and the market's mark, and
     * echoed back — a force-close at a rate nobody chose would be exactly the
     * kind of silent money-moving action this panel exists to avoid.
     */
    app.post('/boros/pair/market/:marketId/cancel-and-close', async (req, reply) => {
      const marketId = Number((req.params as { marketId: string }).marketId);
      if (!Number.isInteger(marketId) || marketId <= 0) {
        throw new CoreError('invalid marketId', 'validation');
      }
      const body = (req.body ?? {}) as {
        clientOrderId?: unknown;
        size?: unknown;
        slippageApr?: unknown;
        address?: unknown;
      };
      const clientOrderId = parseClientOrderId(body.clientOrderId, 'clientOrderId');
      /**
       * Size and rate bound MAY come from the caller; the ACCOUNT may not.
       *
       * The account is the dangerous one — it decides whose position is read
       * and therefore how large an order this route places (see below). Size
       * and slippage only narrow what happens to the caller's own position:
       * a partial close is an ordinary thing to want, and a bound the user
       * chose is safer than one they did not. Both are clamped, and the size
       * is capped at the live position further down, so neither can be used to
       * overshoot past flat into a fresh opposing position.
       */
      const sizeOverride =
        body.size === undefined ? null : Number(body.size);
      if (sizeOverride !== null && (!Number.isFinite(sizeOverride) || sizeOverride <= 0)) {
        throw new CoreError('size must be a positive number', 'validation');
      }
      /**
       * The account the CALLER sized this close against. Never used to pick
       * the account (see below) — only to refuse when it is not the one this
       * install signs for: the close form shows the TRACKED address's legs,
       * and tracking someone else's book must not close the agent's own.
       */
      if (body.address !== undefined) assertTradableAddress(parseAddress(body.address));
      const slippageOverride =
        body.slippageApr === undefined ? null : Number(body.slippageApr);
      // The same cap the quote enforces (MAX_SLIPPAGE_APR): the form can only
      // show a bound it can quote, so it must not be able to SEND a wider one.
      if (
        slippageOverride !== null &&
        (!Number.isFinite(slippageOverride) || slippageOverride <= 0 || slippageOverride > MAX_SLIPPAGE_APR)
      ) {
        throw new CoreError(`slippageApr must be in (0, ${MAX_SLIPPAGE_APR}]`, 'validation');
      }
      const orders = deps.getBorosOrders?.();
      if (!orders) {
        throw new CoreError(
          'Boros order placement is not configured on this install.',
          'not-configured',
        );
      }
      /**
       * Derived, never accepted from the body.
       *
       * This route runs NO gate — no margin check, no acknowledgement — and it
       * takes the close SIZE straight from the position it reads. Letting the
       * caller name the account therefore let them name the size of a market
       * order on someone else's behalf: pass a whale's address and the server
       * opens an enormous opposing position on the configured account. There is
       * no legitimate use for a foreign account here.
       */
      const address = configuredRoot();
      if (!address) {
        throw new CoreError(
          'No Boros root address is configured on this install.',
          'not-configured',
        );
      }

      assertNotUpdating();
      await assertAgentNotExpired(deps);

      const unlockClose = lockBorosMarkets([marketId]);
      if (!unlockClose) return refuse(reply, {
        code: 409,
        category: 'validation',
        message: CLOSE_RUNNING,
        retryable: false,
      });
      try {
        const pre = await catchRateLimit(Promise.all([loadMarkets(false), loadAccount(address, true)]));
        if (pre === null) return refuse(reply, {
          code: 503,
          category: 'rate-limited',
          message: READS_LIMITED_NOTHING_SENT,
          retryable: true,
        });
        const [preMarkets, preAccount] = pre;
        if (preAccount.isolatedOccupied.has(marketId)) {
          return refuse(reply, { code: 409, category: 'validation', message: CLOSE_ISOLATED, retryable: false });
        }

        /** Refused BEFORE the cancel, which cannot be undone: Boros takes nothing
         * at or under $10 and only says so at its calldata builder, by which
         * point the orders are gone. Only a caller-named size can trip it —
         * closing everything flattens, and the venue exempts that. */
        if (sizeOverride !== null) {
          const preOpen = Math.abs(preAccount.positionByMarket.get(marketId) ?? 0);
          const price =
            resolveCollateralPricesUsd(preMarkets).get(marketOr404(preMarkets, marketId).tokenId) ??
            null;
          // No collateral price means no USD value to test. Let it through and
          // let the venue answer: refusing on an unknown would block valid sizes.
          const value = price === null ? null : Math.min(sizeOverride, preOpen) * price;
          const flattens = preOpen > 0 && sizeOverride >= preOpen;
          if (!flattens && value !== null && value <= MIN_ORDER_VALUE_USD) {
            throw new CoreError(
              `This close is worth $${value.toFixed(2)}. Boros takes no order of ` +
                `$${MIN_ORDER_VALUE_USD} or less. Close more of the position, or all of it.`,
              'size-too-small',
            );
          }
        }

        // Orders first, and BEFORE the position is read: closing while an order
        // still rests could have it re-open the position behind the close — and
        // an order that fills between a read and the cancel would leave the
        // close sized to a stale position, overshooting past flat into a fresh
        // one (Boros has no reduce-only flag to stop it).
        await orders.cancelOrders(marketId, gasTopUpMarketFor(preMarkets, preAccount));

        /** ⚠ THE CANCEL HAS LANDED and nothing below undoes it, so every failure
         * from here has to say so — reporting only the close error read as
         * "nothing happened" while the caller's resting orders were gone. */
        try {

          // Fresh reads AFTER the cancel: the size we close is the size that is
          // actually there once nothing can fill any more.
          const post = await catchRateLimit(Promise.all([loadMarkets(true), loadAccount(address, true)]));
          if (post === null) return refuse(reply, {
            code: 503,
            category: 'rate-limited',
            message: READS_LIMITED_AFTER_CANCEL,
            retryable: true,
          });
          const [markets, account] = post;
          const market = marketOr404(markets, marketId);
          const current = account.positionByMarket.get(marketId) ?? 0;

          if (current === 0) {
            // The read above came 0–2 s after the cancel, so it can still list the
            // cancelled orders. Do not keep it for the cards.
            deps.cache.bust(`boros:collaterals:${address}`);
            return reply.ok({ marketId, cancelled: true, closed: false, fill: null });
          }
          // Reduce = trade the opposite way to the position's sign.
          const direction: BorosLegDirection = current > 0 ? 'short' : 'long';
          /**
           * ⚠ CLAMPED to what is actually open. Boros has no reduce-only flag, so
           * a size larger than the position does not stop at flat — it crosses it
           * and opens a fresh one the other way. The cap is what makes accepting a
           * caller size safe at all.
           *
           * ⚠ AND THIS CLAMP IS NOT THE ONE THAT ENFORCES IT. Both operands are
           * doubles that already lost the position's low-order digits, so it can
           * only narrow what the CALLER asked for — it cannot bound the wei the
           * order is finally built from, and for a clean 0.05 that conversion
           * landed three units above the position. The binding cap is
           * `openSizeWei`, applied in the venue's own units in `closePosition`.
           * This one stays because it is still what decides a deliberate PARTIAL.
           */
          const openSize = Math.abs(current);
          const openSizeWei = account.positionRawByMarket.get(marketId) ?? '0';
          const { size } = reducingOrderSize(openSizeWei, sizeOverride ?? openSize);
          const slippageApr = slippageOverride ?? CLOSE_SLIPPAGE_APR;
          const fill = await orders.closePosition({
            marketId,
            size,
            // The venue's own integer, never re-derived from `size`.
            openSizeWei,
            direction,
            /**
             * Bound off the BOOK MID, never the mark. Slippage is the distance
             * between the executed implied rate and the book's mid (dapp-nitro's
             * definition, and what the close form's "worst" line states); the
             * mark is a 5-minute TWAP of trades that can sit anywhere relative to
             * the book, so a bound derived from it was looser or tighter than the
             * tolerance the user set without anything on screen saying so.
             */
            // A market with no mid (the feed's 0) falls back to the mark: a bound
            // of 0 ± tolerance would be nowhere near the book.
            limitApr: limitAprFor(direction, knownRateOf(market, market.midApr) ? market.midApr : market.markApr, slippageApr),
            clientOrderId,
            gasTopUpMarket: gasTopUpMarketFor(markets, account),
          });
          /**
           * ⚠ Bust the Boros reads this close just invalidated.
           *
           * `/asset-view` serves `boros:collaterals:${address}` from a 30s cache
           * (TTL.boros), so without this the client could invalidate, refetch
           * immediately, and still be handed the PRE-CLOSE position — the card sat
           * on a stale size for up to 30s after saying "closed". Same contract as
           * the CrossEx writes: a write busts what it changed (deals.ts busts
           * `account`, leverage.ts busts `positions`).
           */
          await settleAfterWrite(address, account, [marketId]);

          return reply.ok({
            marketId,
            cancelled: true,
            // A PARTIAL close by request is not a failed close: `closed` means the
            // position is flat, so a deliberate partial reports false and the
            // caller reads `fill` for what actually happened.
            closed: fill.shortfallSize === 0 && size >= openSize,
            fill,
            // Named so the panel can show what bound the close actually carried.
            slippageApr,
            /** What was open when the close was sized — the cap that was applied. */
            openSize,
          });
        } catch (err) {
          // The cancel landed, and a close that timed out may have filled: the
          // cards must not keep a read from before either.
          deps.cache.bust(`boros:collaterals:${address}`);
          bustBorosFills(deps.cache, [marketId]);
          const msg = err instanceof Error ? err.message : String(err);
          throw new CoreError(
            // "any", not "the": cancelOrders sends cancelAll and reports no
            // count, so the route cannot claim anything was actually resting.
            `${msg} — any resting orders on this market have already been cancelled, and that ` +
              `is not undone. Check your open orders before you send again.`,
            err instanceof CoreError ? err.category : 'venue-rejected',
          );
        }
      } finally {
        unlockClose();
      }
    });
  };
}
