import { type NormalizedBook, touchOf } from '../estimate/books';
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import { walkBook } from '../estimate/fill';
import { DEFAULT_STEP, parseSymbol, roundToStep } from '../numbers';
import { ceilCents, CONVERT_MAX, CONVERT_RATE, HYPERLIQUID_MIN_USDC, marginPerConvertUsdc, type Pool } from './plan';

export { marginPerConvertUsdc };

const REFUSE_IMPACT_BP = 25;
const REOPEN_MARGIN_SHARE = 0.15;
const REOPEN_MARGIN_FLOOR_USD = 20;
const MIN_ORDER_USD = 10;
const HYPERLIQUID_MARKET_CAPS: readonly { minLeverage: number; capUsd: number }[] = [
  { minLeverage: 25, capUsd: 30_000_000 },
  { minLeverage: 20, capUsd: 5_000_000 },
  { minLeverage: 10, capUsd: 2_000_000 },
  { minLeverage: 0, capUsd: 500_000 },
];

export type PerpSide = 'LONG' | 'SHORT';

export interface RealizePerp {
  symbol?: string;
  positionQty?: string;
  entryPrice?: string;
  markPrice?: string;
  initialMargin?: string;
  maxLeverage?: string;
}

export interface PerpRule {
  lotSize?: string;
  minSize?: string;
  minNotional?: string;
  maxMarketSize?: string;
}

export interface RealizeConvert {
  amount: number;
  count: number;
  feeUsd: number;
}

export interface RealizeLeg {
  pool: Pool;
  symbol: string;
  exchange: string;
  base: string;
  side: PerpSide;
  positionQty: number;
  qty: number;
  realizedUsd: number;
  convert: RealizeConvert | null;
  closeFeeUsd: number;
  reopenFeeUsd: number;
  closeImpactUsd: number;
  reopenImpactUsd: number;
  impactBp: number;
}

export type RealizeRefusalReason = 'too-thin' | 'no-margin' | 'past-book' | 'over-cap';

export interface RealizeRefusal {
  reason: RealizeRefusalReason;
  bp: number | null;
  maxBp: number;
  capUsd?: number;
}

export interface RealizePlan {
  legs: RealizeLeg[];
  refused: RealizeRefusal | null;
}

export interface RealizeInput {
  pool: Pool;
  moveUsd: number;
  cashUsd: number;
  borrowUsd: number;
  availableMargin: number;
  perps: RealizePerp[];
  books: Record<string, NormalizedBook | null>;
  feeRows: VenueFeeRow[];
  rules: Record<string, PerpRule>;
}

const PAYING_VENUE: Partial<Record<Pool, { exchange: string; quote: string }>> = {
  HYPERLIQUID: { exchange: 'HYPERLIQUID', quote: 'USDC' },
  CROSSEX: { exchange: 'GATE', quote: 'USDT' },
};

interface Paying {
  symbol: string;
  exchange: string;
  base: string;
  side: PerpSide;
  positionQty: number;
  mark: number;
  profitPerCoin: number;
  moved: number;
  marginPerCoin: number;
  lot: string;
  minQty: number;
  takerRate: number;
  book: NormalizedBook | null;
  capUsd: number;
}

interface Priced {
  closeFeeUsd: number;
  reopenFeeUsd: number;
  closeImpactUsd: number;
  reopenImpactUsd: number;
  impactBp: number;
  pastBook: boolean;
}

interface Order {
  qty: number;
  overCapUsd: number | null;
  priced: Priced;
  realizedUsd: number;
  convert: number;
  cashIn: number;
  net: number;
}

interface State {
  left: number;
  cash: number;
  available: number;
  borrowLeft: number;
}

export const positiveOf = (raw: string | undefined): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const isInProfit = (perp: RealizePerp): boolean => {
  const qty = Number(perp.positionQty);
  const entry = Number(perp.entryPrice);
  const mark = Number(perp.markPrice);
  if (!(entry > 0) || !(mark > 0) || !Number.isFinite(qty) || qty === 0) return false;
  return qty < 0 ? entry > mark : mark > entry;
};

export const legFeeUsd = (leg: RealizeLeg): number => leg.closeFeeUsd + leg.reopenFeeUsd + (leg.convert?.feeUsd ?? 0);

export const realizeCostUsd = (legs: RealizeLeg[]): number => {
  const fees = legs.reduce((total, leg) => total + legFeeUsd(leg), 0);
  const impact = legs.reduce((total, leg) => total + leg.closeImpactUsd + leg.reopenImpactUsd, 0);
  return fees + Math.max(0, impact);
};

function minQtyOf(rule: PerpRule, lot: string, mark: number): number {
  const notional = Math.max(MIN_ORDER_USD, positiveOf(rule.minNotional)) / mark;
  return Number(roundToStep(Math.max(positiveOf(rule.minSize), notional), lot, 'up'));
}

export function profitPoolOf(perp: RealizePerp): Pool | null {
  if (!isInProfit(perp)) return null;
  const { exchange, quote } = parseSymbol(perp.symbol ?? '');
  const pools = Object.keys(PAYING_VENUE) as Pool[];
  return pools.find((pool) => PAYING_VENUE[pool]?.exchange === exchange && PAYING_VENUE[pool]?.quote === quote) ?? null;
}

function marketCapUsd(perp: RealizePerp, rule: PerpRule, exchange: string, mark: number): number {
  const ruleCap = positiveOf(rule.maxMarketSize) * mark;
  const leverage = positiveOf(perp.maxLeverage);
  const venueCap =
    exchange === 'HYPERLIQUID' && leverage > 0
      ? (HYPERLIQUID_MARKET_CAPS.find((tier) => leverage >= tier.minLeverage)?.capUsd ?? Infinity)
      : Infinity;
  return Math.min(ruleCap > 0 ? ruleCap : Infinity, venueCap);
}

function payingLegs(input: RealizeInput): Paying[] {
  return input.perps.flatMap((perp): Paying[] => {
    if (profitPoolOf(perp) !== input.pool) return [];
    const symbol = perp.symbol ?? '';
    const { exchange, base } = parseSymbol(symbol);
    const takerRate = resolveFeeRates(input.feeRows, symbol)?.takerRate;
    if (takerRate === undefined) return [];
    const signed = Number(perp.positionQty);
    const entry = Number(perp.entryPrice);
    const mark = Number(perp.markPrice);
    const side: PerpSide = signed < 0 ? 'SHORT' : 'LONG';
    const profitPerCoin = side === 'SHORT' ? entry - mark : mark - entry;
    const positionQty = Math.abs(signed);
    const rule = input.rules[symbol] ?? {};
    const lot = rule.lotSize && positiveOf(rule.lotSize) > 0 ? rule.lotSize : DEFAULT_STEP;
    return [
      {
        symbol,
        exchange,
        base,
        side,
        positionQty,
        mark,
        profitPerCoin,
        moved: profitPerCoin / entry,
        marginPerCoin: Math.abs(Number(perp.initialMargin) || 0) / positionQty,
        lot,
        minQty: minQtyOf(rule, lot, mark),
        takerRate,
        book: input.books[symbol] ?? null,
        capUsd: marketCapUsd(perp, rule, exchange, mark),
      },
    ];
  });
}

function priceOrder(leg: Paying, qty: number): Priced {
  const fee = qty * leg.mark * leg.takerRate;
  const unpriced = { closeFeeUsd: fee, reopenFeeUsd: fee, closeImpactUsd: 0, reopenImpactUsd: 0, impactBp: 0, pastBook: true };
  const touch = touchOf(leg.book);
  if (!leg.book || !touch) return unpriced;
  const buys = leg.book.asks;
  const sells = leg.book.bids;
  const close = walkBook(leg.side === 'SHORT' ? buys : sells, qty);
  const reopen = walkBook(leg.side === 'SHORT' ? sells : buys, qty);
  if (!close || !reopen) return unpriced;
  const closeImpactUsd = Math.abs(close.avgPrice - touch.mid) * qty;
  const reopenImpactUsd = Math.abs(reopen.avgPrice - touch.mid) * qty;
  return {
    closeFeeUsd: fee,
    reopenFeeUsd: fee,
    closeImpactUsd,
    reopenImpactUsd,
    impactBp: ((closeImpactUsd + reopenImpactUsd) / (qty * touch.mid)) * 10_000,
    pastBook: close.exhausted || reopen.exhausted,
  };
}

export function convertFor(reopenMarginUsd: number, availableMargin: number): number {
  const short = REOPEN_MARGIN_SHARE * reopenMarginUsd + REOPEN_MARGIN_FLOOR_USD - availableMargin;
  return short > 0 ? Math.max(HYPERLIQUID_MIN_USDC, ceilCents(short / marginPerConvertUsdc)) : 0;
}

function orderOf(leg: Paying, qty: number, state: State): Order {
  const priced = priceOrder(leg, qty);
  const realizedUsd = qty * leg.profitPerCoin;
  const convert = convertFor(qty * leg.marginPerCoin, state.available);
  const cashIn = realizedUsd - priced.closeFeeUsd - priced.reopenFeeUsd - priced.closeImpactUsd;
  const overCapUsd = qty * leg.mark > leg.capUsd ? leg.capUsd : null;
  return { qty, overCapUsd, priced, realizedUsd, convert, cashIn, net: cashIn - priced.reopenImpactUsd - convert * CONVERT_RATE };
}

function sizeOrder(leg: Paying, state: State): Order {
  const whole = orderOf(leg, leg.positionQty, state);
  const lot = Number(leg.lot);
  const qtyAt = (lots: number): number => Number(roundToStep(lots * lot, leg.lot, 'nearest'));
  let lo = Math.round(leg.minQty / lot);
  let hi = Math.floor(leg.positionQty / lot + 1e-9);
  if (whole.net < state.left || lo >= hi) return whole;
  const first = orderOf(leg, qtyAt(lo), state);
  if (first.net >= state.left) return first;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (orderOf(leg, qtyAt(mid), state).net >= state.left) hi = mid;
    else lo = mid;
  }
  return orderOf(leg, Math.min(qtyAt(hi), leg.positionQty), state);
}

const canFund = (order: Order, state: State): boolean =>
  order.convert === 0 ||
  (order.convert <= state.cash + order.cashIn && order.convert * (1 - CONVERT_RATE) <= state.borrowLeft);

function legOf(pool: Pool, leg: Paying, order: Order): RealizeLeg {
  return {
    pool,
    symbol: leg.symbol,
    exchange: leg.exchange,
    base: leg.base,
    side: leg.side,
    positionQty: leg.positionQty,
    qty: order.qty,
    realizedUsd: order.realizedUsd,
    convert:
      order.convert > 0
        ? { amount: order.convert, count: Math.ceil(order.convert / CONVERT_MAX), feeUsd: order.convert * CONVERT_RATE }
        : null,
    closeFeeUsd: order.priced.closeFeeUsd,
    reopenFeeUsd: order.priced.reopenFeeUsd,
    closeImpactUsd: order.priced.closeImpactUsd,
    reopenImpactUsd: order.priced.reopenImpactUsd,
    impactBp: order.priced.impactBp,
  };
}

function refusalOf(orders: Order[], unfunded: boolean): RealizeRefusal | null {
  const capUsd = orders.find((order) => order.overCapUsd !== null)?.overCapUsd;
  if (capUsd != null) return { reason: 'over-cap', bp: null, maxBp: REFUSE_IMPACT_BP, capUsd };
  if (orders.some((order) => order.priced.pastBook)) return { reason: 'past-book', bp: null, maxBp: REFUSE_IMPACT_BP };
  const worst = Math.max(...orders.map((order) => order.priced.impactBp));
  if (worst > REFUSE_IMPACT_BP) return { reason: 'too-thin', bp: Math.round(worst * 10) / 10, maxBp: REFUSE_IMPACT_BP };
  return unfunded ? { reason: 'no-margin', bp: null, maxBp: REFUSE_IMPACT_BP } : null;
}

export function planRealize(input: RealizeInput): RealizePlan | null {
  const need = input.moveUsd - input.cashUsd;
  if (!(need > 0)) return null;
  const legs = payingLegs(input).sort((a, b) => b.moved - a.moved);
  if (legs.length === 0) return null;
  const start: State = {
    left: need,
    cash: Math.max(0, input.cashUsd),
    available: input.availableMargin,
    borrowLeft: Math.max(0, input.borrowUsd),
  };
  const first = legs.findIndex((leg) => canFund(sizeOrder(leg, start), start));
  const ordered = first > 0 ? [legs[first], ...legs.filter((_, index) => index !== first)] : legs;
  let state = start;
  let unfunded = first < 0;
  const orders: Order[] = [];
  const planned: RealizeLeg[] = [];
  for (const leg of ordered) {
    if (state.left <= 0) break;
    const order = sizeOrder(leg, state);
    unfunded ||= !canFund(order, state);
    orders.push(order);
    planned.push(legOf(input.pool, leg, order));
    state = {
      left: state.left - order.net,
      cash: state.cash + order.cashIn - order.convert,
      available: state.available + order.convert * marginPerConvertUsdc,
      borrowLeft: state.borrowLeft - order.convert * (1 - CONVERT_RATE),
    };
  }
  return { legs: planned, refused: refusalOf(orders, unfunded) };
}

export function realizedNetUsd(leg: RealizeLeg): number {
  return (
    leg.realizedUsd -
    leg.closeFeeUsd -
    leg.reopenFeeUsd -
    leg.closeImpactUsd -
    leg.reopenImpactUsd -
    (leg.convert?.feeUsd ?? 0)
  );
}
