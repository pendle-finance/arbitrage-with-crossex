import type { AppDeps } from './app';
import { resolveCollateralPricesUsd, type BorosMarket } from '../core/boros/client';
import { normalizeUnderlying } from '../core/boros/opportunities';
import {
  classifyLegFailure,
  describeLegFailure,
  submitBorosPair,
  type BorosMarketOrderRequest,
  type BorosOrderClient,
  type BorosPairResult,
} from '../core/boros/orders';
import {
  chooseGasTopUpZone,
  legMarginNeed,
  reducingOrderSize,
  type BorosLegDirection,
  type BorosPairSimulation,
  type PairBlocker,
} from '../core/boros/pair';
import { normalizeVenue } from '../core/boros/venue';
import { COIN_NOT_SUPPORTED_TEXT, isSupportedCoin } from '../core/coins';
import { CoreError } from '../core/errors';
import type { AccountView, PairBody, PairPricer } from './routes/borosPair';

export const BOROS_CLOSE_FALLBACK_SLIPPAGE_PCT = 1;

export const CLOSE_RUNNING = 'A close on this market is already running.';
export const ORDER_RUNNING = 'An order on this market is already running.';
export const MAY_HAVE_FILLED = ' — Boros gave no answer, so the orders may have filled. Check your positions on Boros before sending again.';

export const EXECUTION_MEMO_MS = 10 * 60_000;

export interface ExecutionPayload {
  result: BorosPairResult;
  estimate: BorosPairSimulation;
  warnings: string[];
}

const recentExecutions = new Map<string, { at: number; result: Promise<ExecutionPayload> }>();

const sweepExecutions = (): void => {
  const now = Date.now();
  for (const [k, v] of recentExecutions) {
    if (now - v.at > EXECUTION_MEMO_MS) recentExecutions.delete(k);
  }
};

export function pendingBorosExecutions(): number {
  sweepExecutions();
  return recentExecutions.size;
}

export function forgetBorosExecutions(): void {
  recentExecutions.clear();
}

function rememberExecution(key: string, pending: Promise<ExecutionPayload>): void {
  recentExecutions.set(key, { at: Date.now(), result: pending });
  pending
    .then(({ result }) => {
      const { legs } = result;
      const anyFailed = legs.some((l) => l.failure !== null);
      const mayHaveFilled = legs.some((l) => l.filledSize > 0 || l.failure?.code === 'unknown');
      if (anyFailed && !mayHaveFilled) recentExecutions.delete(key);
    })
    .catch(() => recentExecutions.delete(key));
}

const lockedMarkets = new Set<number>();

export function lockBorosMarkets(marketIds: readonly number[]): ((keep?: readonly number[]) => void) | null {
  if (marketIds.some((id) => lockedMarkets.has(id))) return null;
  const held = new Set(marketIds);
  for (const id of held) lockedMarkets.add(id);
  return (keep = []) => {
    for (const id of held) {
      if (keep.includes(id)) continue;
      held.delete(id);
      lockedMarkets.delete(id);
    }
  };
}

export const freeCrossOf = (account: AccountView): Map<number, number> => new Map(account.crossFreeWithOrdersByToken);

export function gasTopUpMarketFor(markets: BorosMarket[], account: AccountView, tradedFreeAfter?: number | null) {
  return (amountUsd: number, tradedMarketId: number): number => {
    const freeCrossByToken = freeCrossOf(account);
    const tokenId = markets.find((m) => m.marketId === tradedMarketId)?.tokenId;
    const tradedFree = typeof tradedFreeAfter === 'number' ? tradedFreeAfter : account.crossByToken.get(tokenId ?? -1)?.available;
    if (tokenId !== undefined && tradedFree !== undefined) freeCrossByToken.set(tokenId, tradedFree);
    const zone = chooseGasTopUpZone({
      amountUsd,
      markets,
      freeCrossByToken,
      pricesUsd: resolveCollateralPricesUsd(markets),
      preferMarketId: tradedMarketId,
    });
    return zone.ok ? zone.marketId : tradedMarketId;
  };
}

export interface BorosCloseDeps {
  getBorosOrders: AppDeps['getBorosOrders'];
  checkCanTrade: () => Promise<void>;
  parseTradableAddress: (raw: unknown) => string;
  pricer: Pick<PairPricer, 'loadAccount' | 'priceRequest' | 'settleAfterWrite'>;
}

export interface BorosSendRequest {
  body: PairBody;
  address: string;
  marketIds: readonly number[];
  clientOrderIds: readonly string[];
}

export type BorosSendOutcome =
  | { kind: 'replayed'; payload: ExecutionPayload }
  | { kind: 'busy' }
  | { kind: 'refused'; message: string }
  | { kind: 'blocked'; blockers: PairBlocker[] }
  | { kind: 'sent'; payload: ExecutionPayload; thrown: unknown[] };

export async function sendBorosPair(deps: BorosCloseDeps, request: BorosSendRequest): Promise<BorosSendOutcome> {
  const { body, address, marketIds, clientOrderIds } = request;
  if (new Set(clientOrderIds).size !== clientOrderIds.length) {
    throw new CoreError('every leg needs its own clientOrderId', 'validation');
  }
  const orders = deps.getBorosOrders?.();
  if (!orders) {
    throw new CoreError('Boros order placement is not configured on this install.', 'not-configured');
  }
  await deps.checkCanTrade();

  const memoKey = [...clientOrderIds].sort().join('|');
  sweepExecutions();
  const replay = recentExecutions.get(memoKey);
  if (replay) return { kind: 'replayed', payload: await replay.result };

  const unlock = lockBorosMarkets(marketIds);
  if (!unlock) return { kind: 'busy' };
  try {
    const { simulation, gate, intent, account, markets, legs: pricedLegs } = await deps.pricer.priceRequest(body, true);
    const legs = pricedLegs.map((leg, i) => ({ market: leg.market, sizing: simulation.legs[i].sizing }));
    unlock(legs.filter((l) => l.sizing.opposing).map((l) => l.market.marketId));
    const addsToUnsupportedCoin = legs.some(
      (l) =>
        l.sizing.deltaSize !== 0 &&
        !isSupportedCoin(normalizeUnderlying(l.market.base)) &&
        (intent === 'open' || !l.sizing.opposing),
    );
    const mixed = gate.blockers.find((b) => b.code === 'mixed-open');
    if (mixed) throw new CoreError(mixed.message, 'validation');
    if (addsToUnsupportedCoin) return { kind: 'refused', message: COIN_NOT_SUPPORTED_TEXT };
    if (gate.blockers.length > 0) return { kind: 'blocked', blockers: gate.blockers };
    if (simulation.legs.length === 2 && simulation.receiveLeg === null) {
      throw new CoreError('The two legs do not offset — no spread to trade', 'validation');
    }

    const orderFor = (leg: (typeof simulation.legs)[number], clientOrderId: string): BorosMarketOrderRequest | null => {
      const size = Math.abs(leg.sizing.deltaSize);
      if (size === 0 || leg.execApr === null) return null;
      const raw = account.positionRawByMarket.get(leg.marketId);
      const reducing =
        leg.sizing.opposing && !leg.sizing.flips && raw !== undefined ? reducingOrderSize(raw, size) : null;
      const { orderSide } = leg.sizing;
      return {
        marketId: leg.marketId,
        direction: orderSide,
        size: reducing?.size ?? size,
        limitApr: leg.limitApr as number,
        clientOrderId,
        ...(reducing?.sizeWei !== undefined ? { sizeWei: reducing.sizeWei } : {}),
      };
    };

    const legOrders = simulation.legs.map((leg, i) => orderFor(leg, clientOrderIds[i]));
    if (legOrders.every((o) => o === null)) {
      throw new CoreError('No leg has anything to trade', 'validation');
    }

    const raced = recentExecutions.get(memoKey);
    if (raced) return { kind: 'replayed', payload: await raced.result };
    const thrown: unknown[] = [];
    const client: BorosOrderClient = {
      ...orders,
      placeMarketOrders: (reqs, opts) =>
        orders.placeMarketOrders(reqs, opts).catch((err: unknown) => {
          thrown.push(err);
          throw err;
        }),
    };
    const pending: Promise<ExecutionPayload> = submitBorosPair({
      client,
      legs: legOrders,
      venues: legs.map((l) => l.market.spreadVenues ?? [normalizeVenue(l.market.venue)]),
      feeDragApr: simulation.feeDragApr,
      receiveLeg: simulation.receiveLeg,
      reducing: intent === 'close',
      sendFirst: simulation.legs.flatMap((leg, i) =>
        (legMarginNeed(leg, pricedLegs[i].committedMargin) ?? 0) < 0 ? [i] : [],
      ),
      cancelOrdersOn:
        intent === 'close'
          ? legOrders.flatMap((o) => (o && account.restingOrderMarkets.has(o.marketId) ? [o.marketId] : []))
          : undefined,
      gasTopUpMarket: gasTopUpMarketFor(markets, account, intent !== 'close' && gate.gasTopUpFromFallback ? 0 : undefined),
    }).then((result) => ({ result, estimate: simulation, warnings: gate.warnings }));
    rememberExecution(memoKey, pending);
    const payload = await pending;

    await deps.pricer.settleAfterWrite(address, account, simulation.legs.map((l) => l.marketId));
    return { kind: 'sent', payload, thrown };
  } finally {
    unlock();
  }
}

export interface BorosCloseLeg {
  marketId: number;
  size: number;
}

export interface BorosCloseInput {
  address: string;
  legs: (BorosCloseLeg & { keep?: number })[];
  slippagePct: number;
  clientOrderId: string;
}

export interface BorosCloseResult {
  filled: BorosCloseLeg[];
  rest: BorosCloseLeg[];
  held: BorosCloseLeg[];
}

export async function closeBorosLegs(deps: BorosCloseDeps, input: BorosCloseInput): Promise<BorosCloseResult> {
  const address = deps.parseTradableAddress(input.address);
  const account = await deps.pricer.loadAccount(address, true);
  const sent = input.legs.flatMap((leg) => {
    const current = account.positionByMarket.get(leg.marketId) ?? 0;
    const size = Math.min(Math.abs(leg.size), Math.max(0, Math.abs(current) - (leg.keep ?? 0)));
    if (current === 0 || !(size > 0)) return [];
    const direction: BorosLegDirection = current > 0 ? 'short' : 'long';
    return [
      {
        marketId: leg.marketId,
        direction,
        slippageApr: input.slippagePct / 100,
        size,
        clientOrderId: `${input.clientOrderId}-${leg.marketId}`,
      },
    ];
  });
  const report = (fills: BorosPairResult['legs']): BorosCloseResult => {
    const fillOf = (marketId: number) => {
      const i = sent.findIndex((l) => l.marketId === marketId);
      return i < 0 ? null : fills[i];
    };
    return {
      filled: input.legs.map((l) => ({ marketId: l.marketId, size: Math.abs(fillOf(l.marketId)?.filledSize ?? 0) })),
      rest: input.legs.map((l) => ({ marketId: l.marketId, size: fillOf(l.marketId)?.shortfallSize ?? 0 })),
      held: input.legs.map((l) => ({ marketId: l.marketId, size: Math.abs(account.positionByMarket.get(l.marketId) ?? 0) })),
    };
  };
  if (sent.length === 0) return report([]);

  const outcome = await sendBorosPair(deps, {
    body: { address, legs: sent, intent: 'close', opposingAcknowledged: true },
    address,
    marketIds: sent.map((l) => l.marketId),
    clientOrderIds: sent.map((l) => l.clientOrderId),
  });
  if (outcome.kind === 'busy') throw new CoreError(CLOSE_RUNNING, 'validation');
  if (outcome.kind === 'refused') throw new CoreError(outcome.message, 'validation');
  if (outcome.kind === 'blocked') throw new CoreError(outcome.blockers[0].message, 'validation');
  if (outcome.kind === 'sent' && outcome.thrown.length > 0 && classifyLegFailure(outcome.thrown[0]) === 'unknown') {
    throw new CoreError(`${describeLegFailure(outcome.thrown[0])}${MAY_HAVE_FILLED}`, 'network');
  }
  return report(outcome.payload.result.legs);
}
