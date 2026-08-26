/**
 * The two-leg Boros market-order panel's backend.
 *
 *   GET  /api/boros/pair/context   — the pairable universe + this account's
 *                                    netted positions and margin buckets
 *   POST /api/boros/pair/simulate  — price a pair at a size (fresh books)
 *   POST /api/boros/pair/execute   — send both legs as ONE atomic batch
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
import { USD_TOKEN_ID } from '../../core/boros/borosApi';
import { isUpdating } from '../updater';
import {
  limitAprFor,
  submitBorosPair,
  type BorosMarketOrderRequest,
} from '../../core/boros/orders';
import {
  evaluatePairGate,
  pairEligibility,
  simulateBorosPair,
  DEFAULT_SLIPPAGE_APR,
  MAX_SLIPPAGE_APR,
  type BorosLegDirection,
  type BorosMarginBucket,
  type BorosPairAccountState,
  type BorosPairLegInput,
  type PairIntent,
} from '../../core/boros/pair';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Rate tolerance a §6A force-close carries, as an APR fraction. Wider than a
 * normal entry (100 ticks vs the default 25): the user is unblocking a pair,
 * not hunting a rate, and a close that keeps missing its bound leaves them
 * stuck behind the same blocker. Still bounded, and still reported.
 */
const CLOSE_SLIPPAGE_APR = 0.01;

/**
 * How long a completed execution is remembered for replay protection.
 *
 * Boros's order DTO has NO client-order-id field, so the venue cannot dedupe
 * for us: the same batch sent twice fills twice. The panel's own failure mode
 * is narrow and specific — a response lost in flight, and the user pressing
 * Confirm again with the SAME ids, because the ticket only re-mints ids when
 * the intent changes — so remembering recent executions here closes it.
 *
 * Deliberately not sold as more than it is: this is per-process and does not
 * survive a restart, and it cannot stop a second client. It removes the retry
 * double-fill, not every double-fill.
 */
const EXECUTION_MEMO_MS = 10 * 60_000;

/**
 * Bounds on one gas top-up, in USD. Enforced here and not only in the field:
 * under the low bound the venue's $1 ops-fee sweep eats the top-up and blocks
 * the user again, and the pot has no withdrawal path, so the high bound is the
 * only thing standing between a typo and money nobody can get back.
 */
const MIN_TOP_UP_USD = 2;
const MAX_TOP_UP_USD = 100;

/** Wire shape of one leg, as the panel sends it. */
interface LegBody {
  marketId?: unknown;
  direction?: unknown;
  slippageApr?: unknown;
}

interface PairBody {
  address?: unknown;
  legA?: LegBody;
  legB?: LegBody;
  size?: unknown;
  intent?: unknown;
  /** §4 acknowledgement, required whenever a leg opposes an existing position. */
  opposingAcknowledged?: unknown;
  /** Trade one leg only — what "complete now at market" needs after a partial
   * fill. The other leg is sized to zero and never submitted. */
  onlyLeg?: unknown;
  /**
   * Replay keys, one per leg.
   *
   * ⚠ NOT venue-enforced. Boros's order DTO carries no client order id, so
   * these are deduped HERE (see `recentExecutions`) — a resend of the same pair
   * of ids returns the first result instead of trading again. That covers the
   * lost-response retry this panel actually produces; it cannot protect against
   * a different process or a restart.
   */
  clientOrderIdA?: unknown;
  clientOrderIdB?: unknown;
}

function parseOnlyLeg(raw: unknown): 'A' | 'B' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'A' || raw === 'B') return raw;
  throw new CoreError('onlyLeg must be "A" or "B"', 'validation');
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
function configuredRoot(): string | null {
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

function parseLeg(raw: LegBody | undefined, which: string): {
  marketId: number;
  direction: BorosLegDirection;
  slippageApr: number;
} {
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
  return { marketId, direction, slippageApr };
}

function parseSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CoreError('size must be a positive number of collateral units', 'validation');
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
interface AccountView {
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
  /** marketId → that market's own isolated bucket. */
  isolatedByMarket: Map<number, BorosMarginBucket>;
}

/**
 * A market row "holds something" when it has a netted position OR resting
 * orders. The collaterals summary carries no order list, but it does carry
 * the signal: per-market `initialMargin` includes order margin while
 * `positionInitialMargin` is the position alone, so a gap between them means
 * an order is resting. (Partial by construction — the venue's IM is
 * max(long side, short side), so an opposite-side order smaller than the
 * position's own margin stays invisible — but the case §6A exists for, an
 * order with NO position, always shows.)
 */
function holdsPositionOrOrders(p: {
  notionalSize: string;
  initialMargin?: string;
  positionInitialMargin: string;
}): boolean {
  return (
    norm18(p.notionalSize) !== 0 ||
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
  };
  for (const zone of zones) {
    if (zone.cross) {
      const used = zone.cross.marketPositions.reduce(
        (s, p) => s + norm18(p.positionInitialMargin ?? p.initialMargin),
        0,
      );
      view.crossByToken.set(zone.tokenId, {
        available: norm18(zone.cross.netBalance) - used,
        hasPositionOrOrders: zone.cross.marketPositions.some(holdsPositionOrOrders),
      });
      for (const p of zone.cross.marketPositions) {
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

/**
 * clientOrderId pair → the full response payload the execution produced (or
 * is producing).
 *
 * Keyed on BOTH ids so a resend of the same intent coalesces, while a
 * genuinely new order (fresh ids) never does. In-flight entries store the
 * PROMISE, so two rapid clicks await the same submission instead of racing
 * into two batches. The whole payload (fills + the estimate they were priced
 * against) is memoized so a replay can answer WITHOUT re-pricing — the first
 * execution changed the very account state a re-run of the gate would judge.
 *
 * Module-scoped so the update route can ask whether a Boros order may still be
 * unsettled, and cleared when the routes are built so a second app in the same
 * process (only tests build two) never inherits the first's memo.
 */
interface ExecutionPayload {
  result: Awaited<ReturnType<typeof submitBorosPair>>;
  estimate: ReturnType<typeof simulateBorosPair>;
  warnings: string[];
}
const recentExecutions = new Map<string, { at: number; result: Promise<ExecutionPayload> }>();
const sweepExecutions = (): void => {
  const now = Date.now();
  for (const [k, v] of recentExecutions) {
    if (now - v.at > EXECUTION_MEMO_MS) recentExecutions.delete(k);
  }
};

/**
 * How many executions are recent enough that a resend could still double-fill.
 * The update route refuses to restart the app over any of them, because a
 * restart empties the memo above and the venue has no id of its own to dedupe
 * on. Stale entries are swept first — past the memo window they guard nothing.
 */
export function borosExecutionsPending(): number {
  sweepExecutions();
  return recentExecutions.size;
}

export function borosPairRoutes(deps: AppDeps) {
  recentExecutions.clear();
  const rememberExecution = (key: string, pending: Promise<ExecutionPayload>): void => {
    recentExecutions.set(key, { at: Date.now(), result: pending });
    // A submission that provably left NO position — every submitted leg failed
    // outright with nothing filled and none 'unknown' — is dropped, so an
    // honest retry is not refused a second attempt. `submitBorosPair` folds
    // errors into resolved fills rather than rejecting, so this has to be
    // judged from the RESULT; an 'unknown' leg may have filled, which is
    // exactly what the memo exists to protect.
    pending
      .then(({ result }) => {
        const legs = [result.legA, result.legB];
        const anyFailed = legs.some((l) => l.failure !== null);
        const mayHaveFilled = legs.some((l) => l.filledSize > 0 || l.failure?.code === 'unknown');
        if (anyFailed && !mayHaveFilled) recentExecutions.delete(key);
      })
      .catch(() => recentExecutions.delete(key));
  };

  /**
   * BOROS_AGENT_EXPIRY is absolute unix seconds (see routes/borosAgent.ts).
   * An expired approval otherwise fails at the venue as AuthAgentExpired —
   * AFTER a confirm the user already committed to — so the write routes
   * refuse up front instead.
   */
  /**
   * Refuse a Boros write once the installer is running.
   *
   * The install runs for minutes before it kills this server, and the update
   * route's own "wait for the deal to finish" guard only reads the instant of
   * the click. Without this, an order sent during that window is SIGKILLed
   * mid-flight and its replay memo dies with the process.
   */
  const assertNotUpdating = (): void => {
    if (isUpdating()) {
      throw new CoreError(
        'the app is updating — it will restart shortly, then you can send this again',
        'validation',
      );
    }
  };

  const assertAgentNotExpired = (): void => {
    const raw = Number(process.env.BOROS_AGENT_EXPIRY);
    if (Number.isFinite(raw) && raw > 0 && raw <= Math.floor(Date.now() / 1000)) {
      throw new CoreError(
        'the Boros agent approval has expired — approve a new agent key before trading.',
        'auth',
      );
    }
  };

  const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);
  const envTakerFee = Number(process.env.BOROS_TAKER_FEE_OVERRIDE);
  const takerFeeOverride = Number.isFinite(envTakerFee) ? envTakerFee : undefined;

  const loadMarkets = async (fresh: boolean): Promise<BorosMarket[]> =>
    (await deps.cache.get('boros:markets', TTL.boros, () => fetchBorosMarkets(fetchImpl), { fresh }))
      .value;

  const loadAccount = async (address: string, fresh: boolean): Promise<AccountView> => {
    const { value } = await deps.cache.get(
      `boros:collaterals:${address}`,
      TTL.boros,
      () => fetchBorosCollaterals(fetchImpl, address),
      { fresh },
    );
    return readAccount(value);
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
    if (!m) throw new CoreError(`unknown Boros market ${marketId}`, 'symbol-invalid');
    return m;
  };

  /**
   * Everything from a validated body up to (but not including) submission —
   * shared verbatim by /simulate and /execute so the two can never price the
   * same request differently.
   */
  const priceRequest = async (body: PairBody, fresh: boolean) => {
    const address = parseAddress(body.address);
    const a = parseLeg(body.legA, 'legA');
    const b = parseLeg(body.legB, 'legB');
    const size = parseSize(body.size);
    const intent = parseIntent(body.intent);
    const onlyLeg = parseOnlyLeg(body.onlyLeg);

    const [markets, account] = await Promise.all([loadMarkets(fresh), loadAccount(address, fresh)]);
    const marketA = marketOr404(markets, a.marketId);
    const marketB = marketOr404(markets, b.marketId);
    const nowSec = Math.floor(Date.now() / 1000);
    const eligibility = pairEligibility(marketA, marketB, nowSec);

    // Only walk books once the pair is worth pricing — an ineligible pair has a
    // reason to show, not a quote.
    const [bookA, bookB] = eligibility.eligible
      ? await Promise.all([loadTradeBook(marketA.marketId), loadTradeBook(marketB.marketId)])
      : [null, null];

    const legInput = (
      market: BorosMarket,
      parsed: { direction: BorosLegDirection; slippageApr: number },
      book: BorosOrderBook | null,
    ): BorosPairLegInput => ({
      market,
      book,
      direction: parsed.direction,
      slippageApr: parsed.slippageApr,
      currentSize: account.positionByMarket.get(market.marketId) ?? 0,
      committedMargin: account.committedMarginByMarket.get(market.marketId) ?? 0,
      isolatedOnly: market.isolatedOnly,
      onIsolatedMargin: account.isolatedMarkets.has(market.marketId),
      isolatedHasPositionOrOrders: account.isolatedOccupied.has(market.marketId),
    });

    const legA = legInput(marketA, a, bookA);
    const legB = legInput(marketB, b, bookB);
    const collateralPriceUsd = resolveCollateralPricesUsd(markets).get(marketA.tokenId) ?? null;

    const simulation = simulateBorosPair({
      legA,
      legB,
      size,
      intent,
      onlyLeg,
      collateralPriceUsd,
      nowSec,
      takerFeeOverride,
    });

    // Gas is prepaid to a treasury, separate from trading collateral, so a
    // funded account can still be unable to send. A failed READ is `null` and
    // absent means no read was attempted: the gate blocks on the first and not
    // the second, so an account we could not read never presents as a funded
    // one.
    let gasBalanceUsd: number | null | undefined;
    const ordersForGas = deps.getBorosOrders?.();
    if (ordersForGas?.getGasBalance) {
      try {
        gasBalanceUsd = await ordersForGas.getGasBalance();
      } catch {
        gasBalanceUsd = null;
      }
    }

    const accountState: BorosPairAccountState = {
      cross: account.crossByToken.get(marketA.tokenId) ?? null,
      isolatedByMarket: account.isolatedByMarket,
      gasBalanceUsd,
    };
    const simulatedAtMs = Date.now();
    const gate = evaluatePairGate({
      simulation,
      legA,
      legB,
      account: accountState,
      eligibility,
      opposingAcknowledged: body.opposingAcknowledged === true,
      simulatedAtMs,
      nowMs: simulatedAtMs,
    });

    return {
      simulation,
      gate,
      eligibility,
      legA,
      legB,
      simulatedAtMs,
      size,
      intent,
      gasBalanceUsd,
    };
  };

  return async function plugin(app: FastifyInstance): Promise<void> {
    /** The pairable universe for one account, plus its per-market state. */
    app.get('/boros/pair/context', async (req, reply) => {
      const query = req.query as { address?: string; fresh?: string };
      const address = parseAddress(query.address);
      const fresh = query.fresh === '1';
      const [markets, account] = await Promise.all([loadMarkets(fresh), loadAccount(address, fresh)]);
      const nowSec = Math.floor(Date.now() / 1000);
      const prices = resolveCollateralPricesUsd(markets);

      const rows = markets
        .filter((m) => m.state === 'Normal' && m.maturity > nowSec)
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
        .filter((m, _i, all) =>
          all.some(
            (o) =>
              o.marketId !== m.marketId &&
              o.tokenId === m.tokenId &&
              o.maturity === m.maturity &&
              o.base.toLowerCase() === m.base.toLowerCase(),
          ),
        )
        .map((m) => ({
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
          onIsolatedMargin: account.isolatedMarkets.has(m.marketId),
          isolatedHasPositionOrOrders: account.isolatedOccupied.has(m.marketId),
          currentSize: account.positionByMarket.get(m.marketId) ?? 0,
          collateralPriceUsd: prices.get(m.tokenId) ?? null,
        }))
        .sort((x, y) => x.name.localeCompare(y.name));

      return reply.ok({
        markets: rows,
        crossByToken: [...account.crossByToken.entries()].map(([tokenId, b]) => ({
          tokenId,
          available: b.available,
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
      // Echoed so the panel knows whether to OFFER a top-up: it only offers one
      // on a number it could actually read. Boros keeps prepaid gas in a pot
      // separate from collateral, so a gas refusal and a margin problem look
      // alike and need different fixes.
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
      // Bound BEFORE pricing: the gate below is only a failsafe if it reasons
      // over the account the orders will actually hit.
      assertTradableAddress(parseAddress(body.address));
      const clientOrderIdA = parseClientOrderId(body.clientOrderIdA, 'clientOrderIdA');
      const clientOrderIdB = parseClientOrderId(body.clientOrderIdB, 'clientOrderIdB');
      if (clientOrderIdA === clientOrderIdB) {
        throw new CoreError('the two legs need distinct clientOrderIds', 'validation');
      }
      const orders = deps.getBorosOrders?.();
      if (!orders) {
        throw new CoreError(
          'Boros order placement is not configured on this install.',
          'not-configured',
        );
      }
      assertNotUpdating();
      assertAgentNotExpired();

      // The memo is consulted BEFORE re-pricing. A lost-response retry must
      // get the ORIGINAL outcome, and the first execution changed the very
      // account state the gate would now re-judge — its margin is spent, its
      // position is open — so re-running the gate first could 409 the exact
      // retry the memo exists to answer, hiding that the trade happened.
      const memoKey = `${clientOrderIdA}|${clientOrderIdB}`;
      sweepExecutions();
      const replay = recentExecutions.get(memoKey);
      if (replay) {
        const payload = await replay.result;
        // `replayed` says the fills below are the ORIGINAL submission's, not a
        // second one — the panel says so rather than implying a fresh trade.
        return reply.ok({ ...payload, replayed: true });
      }

      // Fresh account read: margin and positions decide the gate, and a cached
      // copy could be up to TTL.boros old — far too stale to authorise an order.
      const { simulation, gate, intent } = await priceRequest(body, true);
      if (gate.blockers.length > 0) {
        return reply.code(409).send({
          ok: false,
          error: {
            category: 'validation',
            message: gate.blockers[0].message,
            retryable: false,
          },
          data: { blockers: gate.blockers },
        });
      }
      if (simulation.receiveLeg === null) {
        throw new CoreError('the two legs do not offset — no spread to trade', 'validation');
      }

      /**
       * null for a leg with nothing to trade.
       *
       * A zero-delta leg has no execution rate either (the book was never
       * walked), so building an order for it produced `null - slippage` — a
       * NEGATIVE rate bound on a zero-size order. Both legs share one batch, so
       * that entry's rejection could take the legitimate leg with it.
       */
      const orderFor = (
        leg: typeof simulation.legA,
        clientOrderId: string,
      ): BorosMarketOrderRequest | null => {
        const size = Math.abs(leg.sizing.deltaSize);
        if (size === 0 || leg.execApr === null) return null;
        return {
          marketId: leg.marketId,
          direction: leg.direction,
          size,
          limitApr: limitAprFor(leg.direction, leg.execApr, leg.slippageApr),
          clientOrderId,
        };
      };

      const legAOrder = orderFor(simulation.legA, clientOrderIdA);
      const legBOrder = orderFor(simulation.legB, clientOrderIdB);
      if (!legAOrder && !legBOrder) {
        throw new CoreError('neither leg has anything to trade', 'validation');
      }

      // A second request that priced concurrently with this one lands here
      // too — re-check so the two coalesce onto ONE submission instead of
      // racing into two batches. (No await between this check and the set.)
      const raced = recentExecutions.get(memoKey);
      if (raced) {
        const payload = await raced.result;
        return reply.ok({ ...payload, replayed: true });
      }
      const pending: Promise<ExecutionPayload> = submitBorosPair({
        client: orders,
        legA: legAOrder,
        legB: legBOrder,
        feeDragApr: simulation.feeDragApr,
        receiveLeg: simulation.receiveLeg!,
      }).then((result) => ({ result, estimate: simulation, warnings: gate.warnings }));
      rememberExecution(memoKey, pending);
      const payload = await pending;

      /**
       * ⚠ Bust the Boros reads this OPEN just invalidated.
       *
       * The close route has always done this; the open route never did, and
       * the asymmetry IS the bug: /strategy serves boros:collaterals from a
       * 30s cache (TTL.boros), so a freshly opened leg could be invalidated
       * client-side, refetched at once, and still come back from the PRE-TRADE
       * snapshot. The position then appeared only when the TTL happened to
       * lapse — "it takes a while, and sometimes I have to refresh by hand".
       */
      deps.cache.bust('boros:collaterals');
      deps.cache.bust('boros:txns');

      return reply.ok({ ...payload, replayed: false });
    });

    /**
     * Refill the prepaid gas pot, out of this account's own Boros margin.
     *
     * Signed with the agent key the server already holds — `payTreasury` names
     * no token and no recipient, so it can only move the caller's own margin
     * into their own pot, and the key still cannot move a token out.
     *
     * The amount is bounded HERE. The panel bounds the field too, but that is
     * UX: this spend has no way back, so the server is what decides how much of
     * it is possible.
     */
    app.post('/boros/pair/top-up-gas', async (req, reply) => {
      const amountUsd = Number((req.body as { amountUsd?: unknown } | undefined)?.amountUsd);
      if (!Number.isFinite(amountUsd) || amountUsd < MIN_TOP_UP_USD || amountUsd > MAX_TOP_UP_USD) {
        throw new CoreError(
          `amountUsd must be between $${MIN_TOP_UP_USD} and $${MAX_TOP_UP_USD}`,
          'validation',
        );
      }
      const orders = deps.getBorosOrders?.();
      if (!orders?.payTreasury) {
        throw new CoreError(
          'Boros gas top-up is not configured on this install.',
          'not-configured',
        );
      }
      assertNotUpdating();
      assertAgentNotExpired();
      // The marketId only names the COLLATERAL TOKEN to spend: on a cross
      // account the router discards it and keys off the token alone. So any
      // USD-zone market works, and it does NOT have to be one this account has
      // entered — a fresh account with an empty gas pot has entered none, and
      // that is the exact user this route exists for.
      const usdMarket = (await loadMarkets(false)).find((m) => m.tokenId === USD_TOKEN_ID);
      if (!usdMarket) {
        throw new CoreError(
          'Boros lists no USD-collateral market to route a dollar top-up through.',
          'venue-rejected',
        );
      }
      await orders.payTreasury(amountUsd, usdMarket.marketId);

      // Report the amount SENT, not a re-read balance. The credit lands only
      // when the indexer processes the PayTreasury event, so a read taken now
      // still returns the old figure — stating it would tell the user the
      // top-up did nothing and invite a second, unrecoverable one.
      return reply.ok({ sentUsd: amountUsd });
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
      const slippageOverride =
        body.slippageApr === undefined ? null : Number(body.slippageApr);
      if (
        slippageOverride !== null &&
        (!Number.isFinite(slippageOverride) || slippageOverride <= 0 || slippageOverride > 0.5)
      ) {
        throw new CoreError('slippageApr must be in (0, 0.5]', 'validation');
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
          'no Boros root address is configured on this install.',
          'not-configured',
        );
      }

      assertNotUpdating();
      assertAgentNotExpired();

      // Orders first, and BEFORE the position is read: closing while an order
      // still rests could have it re-open the position behind the close — and
      // an order that fills between a read and the cancel would leave the
      // close sized to a stale position, overshooting past flat into a fresh
      // one (Boros has no reduce-only flag to stop it).
      await orders.cancelOrders(marketId);

      // Fresh reads AFTER the cancel: the size we close is the size that is
      // actually there once nothing can fill any more.
      const [markets, account] = await Promise.all([loadMarkets(true), loadAccount(address, true)]);
      const market = marketOr404(markets, marketId);
      const current = account.positionByMarket.get(marketId) ?? 0;

      if (current === 0) {
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
      const size = sizeOverride === null ? openSize : Math.min(sizeOverride, openSize);
      const slippageApr = slippageOverride ?? CLOSE_SLIPPAGE_APR;
      const fill = await orders.closePosition({
        marketId,
        size,
        // The venue's own integer, never re-derived from `size`.
        openSizeWei: account.positionRawByMarket.get(marketId) ?? '0',
        direction,
        limitApr: limitAprFor(direction, market.markApr, slippageApr),
        clientOrderId,
      });
      /**
       * ⚠ Bust the Boros reads this close just invalidated.
       *
       * `/strategy` serves `boros:collaterals:${address}` from a 30s cache
       * (TTL.boros), so without this the client could invalidate, refetch
       * immediately, and still be handed the PRE-CLOSE position — the card sat
       * on a stale size for up to 30s after saying "closed". Same contract as
       * the CrossEx writes: a write busts what it changed (deals.ts busts
       * `account`, leverage.ts busts `positions`).
       */
      deps.cache.bust('boros:collaterals');
      deps.cache.bust('boros:txns');

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
    });
  };
}
