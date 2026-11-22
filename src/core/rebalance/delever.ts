import type { BorosOrderBook } from '../boros/client';
import { walkBorosBook } from '../boros/opportunities';
import { CoreError } from '../errors';
import { type NormalizedBook, touchOf } from '../estimate/books';
import { pickCloseMakerLeg } from '../estimate/closeMaker';
import { feeRowsForTier } from '../estimate/crossexFeeTiers';
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import { walkBook } from '../estimate/fill';
import { coarsestLot, DEFAULT_STEP, floorToStep, roundToStep } from '../numbers';
import { type AccountLike, imUsedOf, type Pool } from './plan';
import { lotOf, minQtyOf, type PerpRule, type PerpSide, positiveOf, type RealizeExec } from './realize';
import { impactOf, type SliceOption, sliceOptions, sliceQtys, sliceSizeOf } from './slices';

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
  legs: { symbol: string; exchange: string; base: string; side: PerpSide; before: number; after: number; closeQty: number }[];
  boros: { marketId: number; before: number; after: number; closeSize: number }[];
  imUsed: { account: Pool; before: number; after: number }[];
  makerLeg: 0 | 1;
  sliceOptions: SliceOption[];
  defaultSliceUsd: number;
  estimates: Record<RealizeExec, DeleverEstimate>;
  notHedgedMaxQty: number;
  notHedgedMaxUsd: number;
  refused: { reason: 'below-min'; venue: string; minQty: number; coin: string } | null;
}

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

function impactUsdOf(leg: Leg, qtys: number[]): number {
  return qtys.reduce((total, qty) => total + (impactOf(leg.book, closeSideOf(leg), leg.mid, qty)?.usd ?? 0), 0);
}

function slippagePctOf(leg: Leg, qty: number): number | null {
  const walk = walkBook(closeLevelsOf(leg), qty);
  return walk ? (Math.abs(walk.avgPrice - leg.mid) / leg.mid) * 100 : null;
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

function imUsedAfterOf(account: AccountLike, legs: Leg[], closeQty: number): DeleverPlan['imUsed'] {
  const marginBalance = Number(account.marginBalance);
  const initialMargin = Math.max(0, Number(account.initialMargin) || 0);
  const freed = legs.reduce((total, leg) => total + (leg.held > 0 ? leg.initialMargin * (closeQty / leg.held) : 0), 0);
  return imUsedOf(account).map((row) => ({
    account: row.account,
    before: row.pct,
    after: marginBalance > 0 ? Math.max(0, initialMargin - freed) / marginBalance : row.pct,
  }));
}

function refusalOf(legs: Leg[], closeQty: number): DeleverPlan['refused'] {
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

export function planDelever(input: DeleverInput): DeleverPlan {
  const { request } = input;
  assertDistinct(request);
  const legs = request.perps.map((asked) => legOf(input, asked));
  if (legs[0].base !== legs[1].base) throw new CoreError('Both perps of a Delever must be on the same coin.');
  const lot = coarsestLot(legs.map((leg) => leg.lot)) ?? DEFAULT_STEP;
  const closeQty = sameSizeOf(legs, lot);
  const makerLeg = pickCloseMakerLeg(
    { makerRate: legs[0].makerRate, takerRate: legs[0].takerRate, slippagePct: slippagePctOf(legs[0], closeQty) },
    { makerRate: legs[1].makerRate, takerRate: legs[1].takerRate, slippagePct: slippagePctOf(legs[1], closeQty) },
  );
  const lead = legs[makerLeg];
  const follow = legs[makerLeg === 0 ? 1 : 0];
  const minQty = Math.max(...legs.map((leg) => minQtyOf(leg.rule, lot, leg.mark)));
  const mid = follow.mid;
  const slice = { book: follow.book, side: closeSideOf(follow), mid };
  const defaultSliceUsd = sliceSizeOf({ ...slice, totalUsd: closeQty * mid });
  const customUsd = request.sliceUsd !== undefined && request.sliceUsd > 0 ? request.sliceUsd : undefined;
  const chosenUsd = customUsd ?? defaultSliceUsd;
  const qtys = sliceQtys(closeQty, chosenUsd > 0 ? chosenUsd / mid : 0, minQty, lot);
  const notHedgedMaxQty = qtys.length > 0 ? Math.max(...qtys) : 0;
  const boros = request.boros.map((asked) => borosLegOf(input, asked));
  const feeBorosUsd = boros.reduce((total, leg) => total + leg.feeUsd, 0);
  const borosImpactUsd = boros.reduce((total, leg) => total + leg.impactUsd, 0);
  const feeOf = (leg: Leg, rate: number): number => closeQty * leg.mark * rate;
  const estimateOf = (feePerpsUsd: number, perpImpactUsd: number): DeleverEstimate => {
    const impactUsd = perpImpactUsd + borosImpactUsd;
    return { feePerpsUsd, feeBorosUsd, impactUsd, totalUsd: feePerpsUsd + feeBorosUsd + impactUsd };
  };
  const followImpactUsd = impactUsdOf(follow, qtys);
  return {
    legs: legs.map((leg) => ({
      symbol: leg.symbol,
      exchange: leg.exchange,
      base: leg.base,
      side: leg.side,
      before: leg.held,
      after: Number(roundToStep(leg.held - closeQty, leg.lot, 'nearest')),
      closeQty,
    })),
    boros: boros.map(({ marketId, before, after, closeSize }) => ({ marketId, before, after, closeSize })),
    imUsed: imUsedAfterOf(input.account, legs, closeQty),
    makerLeg,
    sliceOptions: sliceOptions({ ...slice, totalQty: closeQty, minQty, lot, customUsd }),
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
