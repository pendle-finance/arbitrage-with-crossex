import { type NormalizedBook, touchOf } from '../estimate/books';
import { walkBook } from '../estimate/fill';
import { DEFAULT_STEP, decimalsOf, floorToStep, roundToStep } from '../numbers';
import { TWAP_LIMITS } from '../twap';

export const DEFAULT_SLICE_CHOICES_USD = [25_000, 50_000, 100_000] as const;
export const SLICE_IMPACT_BP = 5;
export const MAKER_SLICE_SECONDS = 300;
export const MARKET_SLICE_SECONDS = 2;
export const ONE_ORDER_USD = 1e12;

const BP_NOISE = 1e-9;
const TWAP_MIN_SAVING_BP = 1;

export interface SliceOption {
  sizeUsd: number;
  custom: boolean;
  whole: boolean;
  count: number;
  impactBp: number;
  impactUsd: number;
  reopenImpactUsd: number;
  pastBook: boolean;
  notHedgedMaxQty: number;
  notHedgedMaxUsd: number;
  seconds: { maker: number; market: number };
}

type Side = 'BUY' | 'SELL';

interface Impact {
  usd: number;
  bp: number;
  pastBook: boolean;
}

export function impactOf(book: NormalizedBook, side: Side, mid: number, qty: number): Impact | null {
  const walk = walkBook(side === 'BUY' ? book.asks : book.bids, qty);
  if (!walk) return null;
  const usd = Math.abs(walk.avgPrice - mid) * qty;
  return { usd, bp: (usd / (qty * mid)) * 10_000, pastBook: walk.exhausted };
}

export interface WholeOrder {
  book: NormalizedBook | null;
  side: Side;
  mid: number | null;
  qty: number;
}

export interface TwapSpan {
  durationSec: number;
  intervalSec: number;
}

export interface TwapDefault {
  on: boolean;
  maker: TwapSpan;
  market: TwapSpan;
}

const TWAP_DEFAULT_INTERVAL_SEC = { maker: 300, market: 60 } as const;

export function needsTwap(order: WholeOrder): boolean {
  const mid = order.mid ?? 0;
  if (!order.book || !(mid > 0) || !(order.qty > 0)) return false;
  const whole = impactOf(order.book, order.side, mid, order.qty);
  if (whole === null || whole.pastBook) return true;
  if (!(whole.bp > SLICE_IMPACT_BP + BP_NOISE)) return false;
  const sliceUsd = sliceSizeOf({ book: order.book, side: order.side, mid, totalUsd: order.qty * mid });
  const slice = impactOf(order.book, order.side, mid, sliceUsd / mid);
  return slice !== null && slice.bp <= whole.bp - TWAP_MIN_SAVING_BP;
}

export function twapSlicesOf(order: WholeOrder): number {
  const mid = order.mid ?? 0;
  const totalUsd = order.qty * mid;
  if (!order.book || !(totalUsd > 0)) return 1;
  return Math.ceil(totalUsd / sliceSizeOf({ book: order.book, side: order.side, mid, totalUsd }) - BP_NOISE);
}

export const twapCountOf = (slices: number): number => Math.min(TWAP_LIMITS.maxSlices, Math.max(TWAP_LIMITS.minSlices, slices));

export function twapDefaultOf(on: boolean, slices: number): TwapDefault {
  const count = twapCountOf(slices);
  const span = (intervalSec: number): TwapSpan => {
    const durationSec = Math.min(TWAP_LIMITS.maxDurationSec, Math.max(TWAP_LIMITS.minDurationSec, count * intervalSec));
    return { durationSec, intervalSec: Math.floor(durationSec / count) };
  };
  return { on, maker: span(TWAP_DEFAULT_INTERVAL_SEC.maker), market: span(TWAP_DEFAULT_INTERVAL_SEC.market) };
}

export const pairTwapDefaultOf = (orders: WholeOrder[]): TwapDefault =>
  twapDefaultOf(orders.some(needsTwap), Math.max(1, ...orders.map(twapSlicesOf)));

export function sliceSizeOf(input: { book: NormalizedBook | null; side: Side; mid: number; totalUsd: number }): number {
  const { book, side, mid } = input;
  const totalUsd = Math.max(0, input.totalUsd);
  const fallback = Math.min(DEFAULT_SLICE_CHOICES_USD[0], totalUsd);
  if (!book || !(mid > 0) || !(totalUsd > 0)) return fallback;
  const largestFirst = [...DEFAULT_SLICE_CHOICES_USD].sort((a, b) => b - a);
  const inBook = largestFirst.flatMap((choice) => {
    const sizeUsd = Math.min(choice, totalUsd);
    const impact = impactOf(book, side, mid, sizeUsd / mid);
    return impact && !impact.pastBook ? [{ sizeUsd, bp: impact.bp }] : [];
  });
  const fit = inBook.find((row) => row.bp <= SLICE_IMPACT_BP + BP_NOISE);
  if (fit) return fit.sizeUsd;
  if (inBook.length > 0) {
    const cheapest = Math.min(...inBook.map((row) => row.bp));
    return inBook.find((row) => row.bp <= cheapest + TWAP_MIN_SAVING_BP)?.sizeUsd ?? fallback;
  }
  const levels = side === 'BUY' ? book.asks : book.bids;
  const depthUsd = levels.reduce((total, [, size]) => (size > 0 ? total + size : total), 0) * mid;
  return depthUsd > 0 ? Math.min(fallback, depthUsd / 2) : fallback;
}

export const oneOrderUsdOf = (maxUsd: number): number => (maxUsd > 0 ? Math.min(ONE_ORDER_USD, maxUsd) : ONE_ORDER_USD);

function lotsOf(qty: number, step: number, lot: string): number {
  return Math.round(Number(floorToStep(qty, lot)) / step);
}

export function sliceQtys(totalQty: number, sliceQty: number, minQty: number, lot: string, capQty = Infinity): number[] {
  const step = Number(lot) > 0 ? lot : DEFAULT_STEP;
  const stepSize = Number(step);
  const decimals = decimalsOf(step);
  const qtyOf = (lots: number): number => Number((lots * stepSize).toFixed(decimals));
  const totalLots = lotsOf(Math.max(0, totalQty), stepSize, step);
  if (totalLots <= 0) return [];
  const minLots = minQty > 0 ? Math.round(Number(roundToStep(minQty, step, 'up')) / stepSize) : 0;
  const capLots = Number.isFinite(capQty) && capQty > 0 ? lotsOf(capQty, stepSize, step) : Infinity;
  const asked = sliceQty > 0 ? lotsOf(sliceQty, stepSize, step) : totalLots;
  const sliceLots = Math.min(totalLots, Math.max(1, minLots, asked));
  const full = Math.floor(totalLots / sliceLots);
  const rest = totalLots - full * sliceLots;
  const lots = Array.from({ length: full }, () => sliceLots);
  const last = lots.length - 1;
  if (rest > 0 && rest < minLots && sliceLots + rest > capLots && sliceLots + rest - minLots >= minLots) {
    lots[last] = sliceLots + rest - minLots;
    lots.push(minLots);
  } else if (rest > 0 && rest < minLots) lots[last] += rest;
  else if (rest > 0) lots.push(rest);
  return lots.map(qtyOf);
}

export function twapSliceQty(leftQty: number, k: number, slices: number, lot: string, minQty: number, capQty: number): number {
  const step = Number(lot) > 0 ? lot : DEFAULT_STEP;
  const stepSize = Number(step);
  const leftLots = lotsOf(Math.max(0, leftQty), stepSize, step);
  const lots = k >= slices ? leftLots : Math.max(1, Math.floor(leftLots / (slices - k + 1)));
  const asked = Number((lots * stepSize).toFixed(decimalsOf(step)));
  return sliceQtys(leftQty, Math.min(asked, capQty), minQty, step, capQty)[0] ?? 0;
}

export function twapQtysFor(totalQty: number, slices: number, lot: string, minQty: number, capQty: number): number[] {
  const step = Number(lot) > 0 ? lot : DEFAULT_STEP;
  const stepSize = Number(step);
  const decimals = decimalsOf(step);
  const qtys: number[] = [];
  let leftLots = lotsOf(Math.max(0, totalQty), stepSize, step);
  for (let k = 1; leftLots > 0; k += 1) {
    const qty = twapSliceQty(Number((leftLots * stepSize).toFixed(decimals)), k, slices, step, minQty, capQty);
    const lots = Math.round(qty / stepSize);
    if (lots <= 0) break;
    qtys.push(qty);
    leftLots -= lots;
  }
  return qtys;
}

export function sliceOptions(input: {
  book: NormalizedBook | null;
  side: Side;
  mid: number;
  totalQty: number;
  minQty: number;
  lot: string;
  maxUsd?: number;
  reopenSide?: Side;
}): SliceOption[] {
  const { book, side, mid, totalQty, minQty, lot, reopenSide } = input;
  if (!book || !touchOf(book) || !(mid > 0) || !(totalQty > 0)) return [];
  const maxUsd = input.maxUsd !== undefined && input.maxUsd > 0 ? input.maxUsd : Infinity;
  const sizeUsd = oneOrderUsdOf(maxUsd);
  const qtys = sliceQtys(totalQty, Math.min(sizeUsd, maxUsd) / mid, minQty, lot, maxUsd / mid);
  if (qtys.length === 0) return [];
  const walksOf = (walkSide: Side): Impact[] | null => {
    const walked = new Map<number, Impact | null>();
    const impacts = qtys.map((qty) => {
      if (!walked.has(qty)) walked.set(qty, impactOf(book, walkSide, mid, qty));
      return walked.get(qty) ?? null;
    });
    return impacts.every((impact) => impact !== null) ? (impacts as Impact[]) : null;
  };
  const impacts = walksOf(side);
  const reopens = reopenSide ? walksOf(reopenSide) : [];
  const largest = qtys.reduce((max, qty) => Math.max(max, qty), 0);
  const largestImpact = impactOf(book, side, mid, largest);
  if (!impacts || !reopens || !largestImpact) return [];
  const usdOf = (walks: Impact[]): number => walks.reduce((total, impact) => total + impact.usd, 0);
  return [
    {
      sizeUsd,
      custom: false,
      whole: true,
      count: qtys.length,
      impactBp: largestImpact.bp,
      impactUsd: usdOf(impacts),
      reopenImpactUsd: usdOf(reopens),
      pastBook: [...impacts, ...reopens].some((impact) => impact.pastBook),
      notHedgedMaxQty: largest,
      notHedgedMaxUsd: largest * mid,
      seconds: { maker: qtys.length * MAKER_SLICE_SECONDS, market: qtys.length * MARKET_SLICE_SECONDS },
    },
  ];
}
