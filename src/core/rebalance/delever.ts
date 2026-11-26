import type { BorosOrderBook } from '../boros/client';
import { walkBorosBook } from '../boros/opportunities';
import { CoreError } from '../errors';
import { type NormalizedBook, touchOf } from '../estimate/books';
import { type MakerLegInput, pickMakerLeg } from '../estimate/makerLeg';
import { feeRowsForTier } from '../estimate/crossexFeeTiers';
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import { walkBook } from '../estimate/fill';
import { coarsestLot, DEFAULT_STEP, floorToStep, roundToStep } from '../numbers';
import { type AccountLike, imUsedOf, type Pool } from './plan';
import { lotOf, marketCapUsd, minQtyOf, type PerpRule, type PerpSide, positiveOf, type RealizeExec } from './realize';
import { impactOf, oneOrderUsdOf, type SliceOption, sliceOptions, sliceQtys } from './slices';

export interface DeleverRequest {
  perps: { symbol: string; qty: number }[];
  boros: { marketId: number; size: number }[];
  exec: RealizeExec;
  sliceUsd?: number;
}

export interface DeleverEstimate {
  feePerpsUsd: number;
  feeBorosUsd: number;
  impactUsd: number;
  totalUsd: number;
}

export interface DeleverPlan {
  legs: { symbol: string; exchange: string; base: string; side: PerpSide; before: number; after: number; closeQty: number; closeAll: boolean }[];
  boros: { marketId: number; before: number; after: number; closeSize: number }[];
  imUsed: { account: Pool; before: number; after: number }[];
  makerLeg: 0 | 1;
  sliceOptions: SliceOption[];
  defaultSliceUsd: number;
  estimates: Record<RealizeExec, DeleverEstimate>;
  notHedgedMaxQty: number;
  notHedgedMaxUsd: number;
  refused: DeleverRefusal | null;
}

export type DeleverRefusal =
  | { reason: 'below-min'; venue: string; minQty: number; coin: string }
  | { reason: 'same-side'; coin: string };

export interface DeleverInput {
  request: DeleverRequest;
  positions: {
    symbol: string;
    exchange: string;
    base: string;
    side: PerpSide;
    qty: number;
    markPrice: number;
    initialMargin: number;
    maxLeverage?: string;
  }[];
  boros: {
    marketId: number;
    size: number;
    book: BorosOrderBook | null;
    collateralPriceUsd: number;
    feeRate: number;
    yearsToMaturity: number;
  }[];
  books: Record<string, NormalizedBook | null>;
  feeRows: VenueFeeRow[];
  rules: Record<string, PerpRule>;
  account: AccountLike;
}

interface Leg {
  symbol: string;
  exchange: string;
  base: string;
  side: PerpSide;
  held: number;
  asked: number;
  mark: number;
  maxLeverage?: string;
  initialMargin: number;
  rule: PerpRule;
  lot: string;
  makerRate: number;
  takerRate: number;
  book: NormalizedBook;
  mid: number;
}

interface BorosLeg {
  marketId: number;
  before: number;
  after: number;
  closeSize: number;
  feeUsd: number;
  impactUsd: number;
}

function ratesOf(feeRows: VenueFeeRow[], symbol: string, exchange: string): { makerRate: number; takerRate: number } {
  const rates = resolveFeeRates(feeRows, symbol) ?? resolveFeeRates(feeRowsForTier('vip0', [exchange]), symbol);
  return { makerRate: rates?.makerRate ?? 0, takerRate: rates?.takerRate ?? 0 };
}

function legOf(input: DeleverInput, asked: DeleverRequest['perps'][number]): Leg {
  const position = input.positions.find((row) => row.symbol === asked.symbol);
  if (!position) throw new CoreError(`No open position on ${asked.symbol}.`);
  if (!(position.markPrice > 0)) throw new CoreError(`No mark price for ${asked.symbol}.`);
  const book = input.books[asked.symbol] ?? null;
  const touch = touchOf(book);
  if (!book || !touch) throw new CoreError(`No order book for ${asked.symbol}.`);
  const rule = input.rules[asked.symbol] ?? {};
  return {
    symbol: position.symbol,
    exchange: position.exchange,
    base: position.base,
    side: position.side,
    held: positiveOf(Math.abs(position.qty)),
    asked: positiveOf(asked.qty),
    mark: position.markPrice,
    maxLeverage: position.maxLeverage,
    initialMargin: positiveOf(position.initialMargin),
    rule,
    lot: lotOf(rule),
    ...ratesOf(input.feeRows, position.symbol, position.exchange),
    book,
    mid: touch.mid,
  };
}

const closeLevelsOf = (leg: Leg): Array<[number, number]> => (leg.side === 'LONG' ? leg.book.bids : leg.book.asks);

const closeSideOf = (leg: Leg): 'BUY' | 'SELL' => (leg.side === 'LONG' ? 'SELL' : 'BUY');

function sameSizeOf(legs: Leg[], lot: string): number {
  const held = Math.min(...legs.map((leg) => leg.held));
  const want = Math.min(held, ...legs.map((leg) => leg.asked));
  const qty = Number(roundToStep(want, lot, 'down'));
  return qty > held ? Number(floorToStep(held, lot)) : qty;
}

function closesWhole(legs: Leg[], leg: Leg, closeQty: number, lot: string): boolean {
  const pair = Math.min(...legs.map((row) => row.held));
  const fine = legs.map((row) => row.lot).reduce((a, b) => (Number(b) < Number(a) ? b : a));
  const underLot = (qty: number): boolean => Number(roundToStep(qty, fine, 'nearest')) < Number(lot);
  return underLot(pair - closeQty) && underLot(leg.held - pair);
}

function impactUsdOf(leg: Leg, qtys: number[]): number {
  return qtys.reduce((total, qty) => total + (impactOf(leg.book, closeSideOf(leg), leg.mid, qty)?.usd ?? 0), 0);
}

function makerInputOf(leg: Leg, qty: number): MakerLegInput {
  const walk = walkBook(closeLevelsOf(leg), qty);
  return {
    makerRate: leg.makerRate,
    takerRate: leg.takerRate,
    slippagePct: walk ? (Math.abs(walk.avgPrice - leg.mid) / leg.mid) * 100 : null,
    pastBookDepth: walk?.exhausted ? walk.filledQty : null,
  };
}

function borosMidOf(book: BorosOrderBook): number | null {
  const bid = book.bids[0]?.[0];
  const ask = book.asks[0]?.[0];
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
}

function borosImpactAprOf(levels: Array<[number, number]>, size: number, mid: number | null): number {
  const walk = walkBorosBook(levels, size, 1);
  if (!walk) return 0;
  const valid = levels.filter(([apr, levelSize]) => Number.isFinite(apr) && levelSize > 0);
  const best = valid[0][0];
  const worst = valid[valid.length - 1][0];
  const avgApr = (walk.execApr * walk.filledUsd + worst * (size - walk.filledUsd)) / size;
  return Math.abs(avgApr - (mid ?? best));
}

function borosLegOf(input: DeleverInput, asked: DeleverRequest['boros'][number]): BorosLeg {
  const live = input.boros.find((row) => row.marketId === asked.marketId);
  if (!live) throw new CoreError(`No open Boros position on market ${asked.marketId}.`);
  const held = positiveOf(Math.abs(live.size));
  const closeSize = Math.min(held, positiveOf(asked.size));
  const sign = live.size < 0 ? -1 : 1;
  const notionalYears = closeSize * positiveOf(live.collateralPriceUsd) * positiveOf(live.yearsToMaturity);
  const levels = live.book ? (live.size < 0 ? live.book.asks : live.book.bids) : [];
  const impactApr = live.book && closeSize > 0 ? borosImpactAprOf(levels, closeSize, borosMidOf(live.book)) : 0;
  return {
    marketId: live.marketId,
    before: live.size,
    after: sign * (held - closeSize),
    closeSize,
    feeUsd: positiveOf(live.feeRate) * notionalYears,
    impactUsd: impactApr * notionalYears,
  };
}

function imUsedAfterOf(account: AccountLike, legs: Leg[], closeQtys: number[]): DeleverPlan['imUsed'] {
  const marginBalance = Number(account.marginBalance);
  const initialMargin = Math.max(0, Number(account.initialMargin) || 0);
  const freed = legs.reduce((total, leg, index) => total + (leg.held > 0 ? leg.initialMargin * (closeQtys[index] / leg.held) : 0), 0);
  return imUsedOf(account).map((row) => ({
    account: row.account,
    before: row.pct,
    after: marginBalance > 0 ? Math.max(0, initialMargin - freed) / marginBalance : row.pct,
  }));
}

function refusalOf(legs: Leg[], closeQty: number): DeleverRefusal | null {
  if (legs[0].side === legs[1].side) return { reason: 'same-side', coin: legs[0].base };
  const short = legs
    .map((leg) => ({ leg, minQty: minQtyOf(leg.rule, leg.lot, leg.mark) }))
    .filter(({ minQty }) => closeQty < minQty)
    .sort((a, b) => b.minQty - a.minQty)[0];
  return short ? { reason: 'below-min', venue: short.leg.exchange, minQty: short.minQty, coin: short.leg.base } : null;
}

function assertDistinct(request: DeleverRequest): void {
  const [a, b] = request.perps;
  if (!a || !b || request.perps.length !== 2 || a.symbol === b.symbol) throw new CoreError('A Delever closes two perps.');
  const markets = request.boros.map((leg) => leg.marketId);
  if (new Set(markets).size !== markets.length) throw new CoreError('A Boros market is listed twice.');
}

export function planDelever(input: DeleverInput, twapQtys?: number[]): DeleverPlan {
  const { request } = input;
  assertDistinct(request);
  const legs = request.perps.map((asked) => legOf(input, asked));
  if (legs[0].base !== legs[1].base) throw new CoreError('Both perps of a Delever must be on the same coin.');
  const lot = coarsestLot(legs.map((leg) => leg.lot)) ?? DEFAULT_STEP;
  const closeQty = sameSizeOf(legs, lot);
  const makerLeg = pickMakerLeg(makerInputOf(legs[0], closeQty), makerInputOf(legs[1], closeQty)).leg === 'a' ? 0 : 1;
  const lead = legs[makerLeg];
  const follow = legs[makerLeg === 0 ? 1 : 0];
  const minQty = Math.max(...legs.map((leg) => minQtyOf(leg.rule, lot, leg.mark)));
  const mid = follow.mid;
  const slice = { book: follow.book, side: closeSideOf(follow), mid };
  const maxUsd = Math.min(...legs.map((leg) => marketCapUsd({ maxLeverage: leg.maxLeverage }, leg.rule, leg.exchange, leg.mark)));
  const defaultSliceUsd = oneOrderUsdOf(maxUsd);
  const customUsd = request.sliceUsd !== undefined && request.sliceUsd > 0 ? Math.min(request.sliceUsd, maxUsd) : undefined;
  const chosenUsd = Math.min(customUsd ?? defaultSliceUsd, maxUsd);
  const qtys = twapQtys && twapQtys.length > 0 ? twapQtys : sliceQtys(closeQty, chosenUsd > 0 ? chosenUsd / mid : 0, minQty, lot);
  const notHedgedMaxQty = qtys.reduce((max, qty) => Math.max(max, qty), 0);
  const whole = legs.map((leg) => closeQty > 0 && closesWhole(legs, leg, closeQty, lot));
  const heldOf = (marketId: number): number => Math.abs(input.boros.find((row) => row.marketId === marketId)?.size ?? 0);
  const pairQty = Math.min(...legs.map((leg) => leg.held));
  const borosAsked = (asked: DeleverRequest['boros'][number]): DeleverRequest['boros'][number] => {
    const held = heldOf(asked.marketId);
    const sliver = pairQty > 0 ? ((held * Number(lot)) / pairQty) * (1 + 1e-9) : 0;
    return whole.every(Boolean) && asked.size > 0 && held - asked.size <= sliver ? { ...asked, size: held } : asked;
  };
  const boros = request.boros.map((asked) => borosLegOf(input, borosAsked(asked)));
  const feeBorosUsd = boros.reduce((total, leg) => total + leg.feeUsd, 0);
  const borosImpactUsd = boros.reduce((total, leg) => total + leg.impactUsd, 0);
  const feeOf = (leg: Leg, rate: number): number => closeQty * leg.mark * rate;
  const estimateOf = (feePerpsUsd: number, perpImpactUsd: number): DeleverEstimate => {
    const impactUsd = perpImpactUsd + borosImpactUsd;
    return { feePerpsUsd, feeBorosUsd, impactUsd, totalUsd: feePerpsUsd + feeBorosUsd + impactUsd };
  };
  const followImpactUsd = impactUsdOf(follow, qtys);
  return {
    legs: legs.map((leg, index) => ({
      symbol: leg.symbol,
      exchange: leg.exchange,
      base: leg.base,
      side: leg.side,
      before: leg.held,
      after: whole[index] ? 0 : Number(roundToStep(leg.held - closeQty, leg.lot, 'nearest')),
      closeQty,
      closeAll: whole[index],
    })),
    boros: boros.map(({ marketId, before, after, closeSize }) => ({ marketId, before, after, closeSize })),
    imUsed: imUsedAfterOf(input.account, legs, legs.map((leg, index) => (whole[index] ? leg.held : closeQty))),
    makerLeg,
    sliceOptions: sliceOptions({ ...slice, totalQty: closeQty, minQty, lot, customUsd, maxUsd }),
    defaultSliceUsd,
    estimates: {
      maker: estimateOf(feeOf(lead, lead.makerRate) + feeOf(follow, follow.takerRate), followImpactUsd),
      market: estimateOf(
        feeOf(lead, lead.takerRate) + feeOf(follow, follow.takerRate),
        impactUsdOf(lead, qtys) + followImpactUsd,
      ),
    },
    notHedgedMaxQty,
    notHedgedMaxUsd: notHedgedMaxQty * mid,
    refused: refusalOf(legs, closeQty),
  };
}
