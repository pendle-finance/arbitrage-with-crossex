import { type NormalizedBook, touchOf } from '../estimate/books';
import { walkBook } from '../estimate/fill';
import { DEFAULT_STEP, decimalsOf, floorToStep, roundToStep } from '../numbers';

export const SLICE_SIZES_USD = [25_000, 50_000, 100_000, 250_000] as const;
export const DEFAULT_SLICE_CHOICES_USD = [25_000, 50_000, 100_000] as const;
export const SLICE_IMPACT_BP = 5;
export const MAKER_SLICE_SECONDS = 300;
export const MARKET_SLICE_SECONDS = 2;
export const ONE_ORDER_USD = 1e12;

const BP_NOISE = 1e-9;

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

export function sliceSizeOf(input: { book: NormalizedBook | null; side: Side; mid: number; totalUsd: number }): number {
  const { book, side, mid } = input;
  const totalUsd = Math.max(0, input.totalUsd);
  const fallback = Math.min(DEFAULT_SLICE_CHOICES_USD[0], totalUsd);
  if (!book || !(mid > 0) || !(totalUsd > 0)) return fallback;
  const largestFirst = [...DEFAULT_SLICE_CHOICES_USD].sort((a, b) => b - a);
  for (const choice of largestFirst) {
    const sizeUsd = Math.min(choice, totalUsd);
    const impact = impactOf(book, side, mid, sizeUsd / mid);
    if (impact && !impact.pastBook && impact.bp <= SLICE_IMPACT_BP + BP_NOISE) return sizeUsd;
  }
  return fallback;
}

export const oneOrderUsdOf = (maxUsd: number): number => (maxUsd > 0 ? Math.min(ONE_ORDER_USD, maxUsd) : ONE_ORDER_USD);

function lotsOf(qty: number, step: number, lot: string): number {
  return Math.round(Number(floorToStep(qty, lot)) / step);
}

export function sliceQtys(totalQty: number, sliceQty: number, minQty: number, lot: string): number[] {
  const step = Number(lot) > 0 ? lot : DEFAULT_STEP;
  const stepSize = Number(step);
  const decimals = decimalsOf(step);
  const qtyOf = (lots: number): number => Number((lots * stepSize).toFixed(decimals));
  const totalLots = lotsOf(Math.max(0, totalQty), stepSize, step);
  if (totalLots <= 0) return [];
  const minLots = minQty > 0 ? Math.round(Number(roundToStep(minQty, step, 'up')) / stepSize) : 0;
  const asked = sliceQty > 0 ? lotsOf(sliceQty, stepSize, step) : totalLots;
  const sliceLots = Math.min(totalLots, Math.max(1, minLots, asked));
  const full = Math.floor(totalLots / sliceLots);
  const rest = totalLots - full * sliceLots;
  const lots = Array.from({ length: full }, () => sliceLots);
  if (rest > 0 && rest < minLots) lots[lots.length - 1] += rest;
  else if (rest > 0) lots.push(rest);
  return lots.map(qtyOf);
}

export function sliceOptions(input: {
  book: NormalizedBook | null;
  side: Side;
  mid: number;
  totalQty: number;
  minQty: number;
  lot: string;
  customUsd?: number;
  maxUsd?: number;
  reopenSide?: Side;
}): SliceOption[] {
  const { book, side, mid, totalQty, minQty, lot, customUsd, reopenSide } = input;
  if (!book || !touchOf(book) || !(mid > 0) || !(totalQty > 0)) return [];
  const maxUsd = input.maxUsd !== undefined && input.maxUsd > 0 ? input.maxUsd : Infinity;
  const optionFor = (sizeUsd: number, custom: boolean, whole = false): SliceOption | null => {
    const qtys = sliceQtys(totalQty, Math.min(sizeUsd, maxUsd) / mid, minQty, lot);
    if (qtys.length === 0) return null;
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
    if (!impacts || !reopens || !largestImpact) return null;
    const usdOf = (walks: Impact[]): number => walks.reduce((total, impact) => total + impact.usd, 0);
    return {
      sizeUsd,
      custom,
      whole,
      count: qtys.length,
      impactBp: largestImpact.bp,
      impactUsd: usdOf(impacts),
      reopenImpactUsd: usdOf(reopens),
      pastBook: [...impacts, ...reopens].some((impact) => impact.pastBook),
      notHedgedMaxQty: largest,
      notHedgedMaxUsd: largest * mid,
      seconds: { maker: qtys.length * MAKER_SLICE_SECONDS, market: qtys.length * MARKET_SLICE_SECONDS },
    };
  };
  const rows = SLICE_SIZES_USD.map((sizeUsd) => optionFor(sizeUsd, false));
  if (customUsd !== undefined && Number.isFinite(customUsd)) {
    const clamped = Math.min(Math.max(customUsd, Math.max(0, minQty) * mid), totalQty * mid, maxUsd);
    rows.push(optionFor(clamped, true));
  }
  rows.push(optionFor(oneOrderUsdOf(maxUsd), false, true));
  return rows.filter((row): row is SliceOption => row !== null);
}
