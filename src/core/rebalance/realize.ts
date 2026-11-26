import { type NormalizedBook, touchOf } from '../estimate/books';
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import { DEFAULT_STEP, parseSymbol, roundToStep } from '../numbers';
import { ceilCents, CONVERT_MAX, CONVERT_RATE, HYPERLIQUID_MIN_USDC, marginPerConvertUsdc, type Pool } from './plan';
import { impactOf, type SliceOption, sliceQtys, sliceSizeOf, twapQtysFor } from './slices';

export { marginPerConvertUsdc };

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
  closeMakerFeeUsd: number;
  reopenFeeUsd: number;
  closeImpactUsd: number;
  reopenImpactUsd: number;
  impactBp: number;
}

export type RealizeRefusalReason = 'no-fee-rate' | 'no-margin' | 'past-book' | 'over-cap';

export interface RealizeRefusal {
  reason: RealizeRefusalReason;
  bp: number | null;
  capUsd?: number;
}

export type RealizeExec = 'maker' | 'market';

export interface RealizeEstimate {
  feeUsd: number;
  impactUsd: number;
  totalUsd: number;
}

export interface RealizePlan {
  legs: RealizeLeg[];
  refused: RealizeRefusal | null;
  estimates: Record<RealizeExec, RealizeEstimate>;
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
  sliceUsd?: number;
  twapSlices?: number;
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
  makerRate: number;
  takerRate: number;
  book: NormalizedBook | null;
  capUsd: number;
  split: Pick<RealizeInput, 'sliceUsd' | 'twapSlices'>;
}

interface Priced {
  closeFeeUsd: number;
  closeMakerFeeUsd: number;
  reopenFeeUsd: number;
  closeImpactUsd: number;
  reopenImpactUsd: number;
  impactBp: number;
  pastBook: boolean;
}

interface Order {
  qty: number;
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

export const positiveOf = (raw: number | string | undefined): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const lotOf = (rule: PerpRule): string => (rule.lotSize && positiveOf(rule.lotSize) > 0 ? rule.lotSize : DEFAULT_STEP);

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

export function minQtyOf(rule: PerpRule, lot: string, mark: number): number {
  const notional = Math.max(MIN_ORDER_USD, positiveOf(rule.minNotional)) / mark;
  return Number(roundToStep(Math.max(positiveOf(rule.minSize), notional), lot, 'up'));
}

export function profitPoolOf(perp: RealizePerp): Pool | null {
  if (!isInProfit(perp)) return null;
  const { exchange, quote } = parseSymbol(perp.symbol ?? '');
  const pools = Object.keys(PAYING_VENUE) as Pool[];
  return pools.find((pool) => PAYING_VENUE[pool]?.exchange === exchange && PAYING_VENUE[pool]?.quote === quote) ?? null;
}

export function marketCapUsd(perp: RealizePerp, rule: PerpRule, exchange: string, mark: number): number {
  const ruleCap = positiveOf(rule.maxMarketSize) * mark;
  const leverage = positiveOf(perp.maxLeverage);
  const venueCap =
    exchange === 'HYPERLIQUID' && leverage > 0
      ? (HYPERLIQUID_MARKET_CAPS.find((tier) => leverage >= tier.minLeverage)?.capUsd ?? Infinity)
      : Infinity;
  return Math.min(ruleCap > 0 ? ruleCap : Infinity, venueCap);
}

const NO_FEE_RATE: RealizeRefusal = { reason: 'no-fee-rate', bp: null };

function payingLegs(input: RealizeInput): { legs: Paying[]; feeMissing: boolean } {
  const inProfit = input.perps.filter((perp) => profitPoolOf(perp) === input.pool);
  const legs = inProfit.flatMap((perp): Paying[] => {
    const symbol = perp.symbol ?? '';
    const { exchange, base } = parseSymbol(symbol);
    const rates = resolveFeeRates(input.feeRows, symbol);
    if (!rates) return [];
    const signed = Number(perp.positionQty);
    const entry = Number(perp.entryPrice);
    const mark = Number(perp.markPrice);
    const side: PerpSide = signed < 0 ? 'SHORT' : 'LONG';
    const profitPerCoin = side === 'SHORT' ? entry - mark : mark - entry;
    const positionQty = Math.abs(signed);
    const rule = input.rules[symbol] ?? {};
    const lot = lotOf(rule);
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
        makerRate: rates.makerRate,
        takerRate: rates.takerRate,
        book: input.books[symbol] ?? null,
        capUsd: marketCapUsd(perp, rule, exchange, mark),
        split: { sliceUsd: input.sliceUsd, twapSlices: input.twapSlices },
      },
    ];
  });
  return { legs, feeMissing: legs.length < inProfit.length };
}

function priceOrder(leg: Paying, qty: number): Priced {
  const fee = qty * leg.mark * leg.takerRate;
  const fees = { closeFeeUsd: fee, closeMakerFeeUsd: qty * leg.mark * leg.makerRate, reopenFeeUsd: fee };
  const unpriced = { ...fees, closeImpactUsd: 0, reopenImpactUsd: 0, impactBp: 0, pastBook: true };
  const touch = touchOf(leg.book);
  if (!leg.book || !touch) return unpriced;
  const close = impactOf(leg.book, leg.side === 'SHORT' ? 'BUY' : 'SELL', touch.mid, qty);
  const reopen = impactOf(leg.book, leg.side === 'SHORT' ? 'SELL' : 'BUY', touch.mid, qty);
  if (!close || !reopen) return unpriced;
  return {
    ...fees,
    closeImpactUsd: close.usd,
    reopenImpactUsd: reopen.usd,
    impactBp: ((close.usd + reopen.usd) / (qty * touch.mid)) * 10_000,
    pastBook: close.pastBook || reopen.pastBook,
  };
}

export function convertFor(reopenMarginUsd: number, availableMargin: number): number {
  const short = REOPEN_MARGIN_SHARE * reopenMarginUsd + REOPEN_MARGIN_FLOOR_USD - availableMargin;
  return short > 0 ? Math.max(HYPERLIQUID_MIN_USDC, ceilCents(short / marginPerConvertUsdc)) : 0;
}

export function averagedRealize(profitPerCoin: number, positionQty: number, qtys: number[], feePerCoin: number): { qty: number; realizedUsd: number } {
  let perCoin = profitPerCoin;
  let qty = 0;
  let realizedUsd = 0;
  for (const slice of qtys) {
    if (qty > 0 && perCoin <= feePerCoin) break;
    realizedUsd += slice * perCoin;
    qty += slice;
    perCoin *= positionQty > 0 ? Math.max(0, 1 - slice / positionQty) : 0;
  }
  return { qty, realizedUsd };
}

function slicesOf(leg: Paying, qty: number): number[] {
  const capQty = leg.capUsd / leg.mark;
  const { sliceUsd, twapSlices } = leg.split;
  if (twapSlices !== undefined && twapSlices > 0) return twapQtysFor(qty, twapSlices, leg.lot, leg.minQty, capQty);
  const mid = touchOf(leg.book)?.mid ?? leg.mark;
  const side = leg.side === 'SHORT' ? 'BUY' : 'SELL';
  const askedUsd = sliceUsd !== undefined && sliceUsd > 0 ? sliceUsd : sliceSizeOf({ book: leg.book, side, mid, totalUsd: qty * mid });
  return sliceQtys(qty, Math.min(askedUsd / mid, capQty), leg.minQty, leg.lot, capQty);
}

function orderOf(leg: Paying, qty: number, state: State): Order {
  const run = averagedRealize(leg.profitPerCoin, leg.positionQty, slicesOf(leg, qty), 2 * leg.mark * leg.takerRate);
  const closed = run.qty > 0 && run.qty < qty ? Number(roundToStep(run.qty, leg.lot, 'nearest')) : qty;
  const realizedUsd = run.qty > 0 ? run.realizedUsd : qty * leg.profitPerCoin;
  const priced = priceOrder(leg, closed);
  const convert = convertFor(closed * leg.marginPerCoin, state.available);
  const cashIn = realizedUsd - priced.closeFeeUsd - priced.reopenFeeUsd - priced.closeImpactUsd;
  return { qty: closed, priced, realizedUsd, convert, cashIn, net: cashIn - priced.reopenImpactUsd - convert * CONVERT_RATE };
}

/** Past the size whose reopen needs no Convert, each coin also pays for its
 * Convert. When that costs more than the coin frees, a bigger close sends less,
 * so the leg stops at that size. */
function topQty(leg: Paying, state: State): number {
  if (!(leg.marginPerCoin > 0)) return leg.positionQty;
  const free = (state.available - REOPEN_MARGIN_FLOOR_USD) / (REOPEN_MARGIN_SHARE * leg.marginPerCoin);
  const capped = Number(roundToStep(Math.min(free, leg.positionQty), leg.lot, 'down'));
  if (!(capped >= leg.minQty) || capped >= leg.positionQty) return leg.positionQty;
  return orderOf(leg, capped, state).net >= orderOf(leg, leg.positionQty, state).net ? capped : leg.positionQty;
}

function sizeOrder(leg: Paying, state: State): Order {
  const top = topQty(leg, state);
  const whole = orderOf(leg, top, state);
  const lot = Number(leg.lot);
  const qtyAt = (lots: number): number => Number(roundToStep(lots * lot, leg.lot, 'nearest'));
  let lo = Math.round(leg.minQty / lot);
  let hi = Math.floor(top / lot + 1e-9);
  if (whole.net < state.left || lo >= hi) return whole;
  const first = orderOf(leg, qtyAt(lo), state);
  if (first.net >= state.left) return first;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (orderOf(leg, qtyAt(mid), state).net >= state.left) hi = mid;
    else lo = mid;
  }
  return orderOf(leg, Math.min(qtyAt(hi), top), state);
}

const canFund = (order: Order, state: State): boolean =>
  order.net > 0 &&
  (order.convert === 0 ||
    (order.convert <= state.cash + order.cashIn && order.convert * (1 - CONVERT_RATE) <= state.borrowLeft));

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
    closeMakerFeeUsd: order.priced.closeMakerFeeUsd,
    reopenFeeUsd: order.priced.reopenFeeUsd,
    closeImpactUsd: order.priced.closeImpactUsd,
    reopenImpactUsd: order.priced.reopenImpactUsd,
    impactBp: order.priced.impactBp,
  };
}

interface SliceVerdict {
  pastBook: boolean;
  overCapUsd: number | null;
}

function sliceVerdictOf(leg: Paying, qty: number, sliceUsd: number | undefined): SliceVerdict {
  const touch = touchOf(leg.book);
  if (!leg.book || !touch) return { pastBook: true, overCapUsd: null };
  const side = leg.side === 'SHORT' ? 'BUY' : 'SELL';
  const askedUsd = sliceUsd !== undefined && sliceUsd > 0 ? sliceUsd : sliceSizeOf({ book: leg.book, side, mid: touch.mid, totalUsd: qty * touch.mid });
  const capQty = leg.capUsd / leg.mark;
  const sliceQty = Math.min(qty, Math.max(leg.minQty, Math.min(askedUsd / touch.mid, capQty)));
  return { pastBook: priceOrder(leg, sliceQty).pastBook, overCapUsd: Math.min(qty, leg.minQty) > capQty ? leg.capUsd : null };
}

function refusalOf(verdicts: SliceVerdict[], unfunded: boolean): RealizeRefusal | null {
  const capUsd = verdicts.find((verdict) => verdict.overCapUsd !== null)?.overCapUsd;
  if (capUsd != null) return { reason: 'over-cap', bp: null, capUsd };
  if (verdicts.some((verdict) => verdict.pastBook)) return { reason: 'past-book', bp: null };
  return unfunded ? { reason: 'no-margin', bp: null } : null;
}

export function realizeEstimateOf(plan: Pick<RealizePlan, 'legs'>, exec: RealizeExec): RealizeEstimate {
  const atMaker = exec === 'maker';
  const feeUsd = plan.legs.reduce(
    (total, leg) => total + (atMaker ? leg.closeMakerFeeUsd : leg.closeFeeUsd) + leg.reopenFeeUsd + (leg.convert?.feeUsd ?? 0),
    0,
  );
  const impactUsd = plan.legs.reduce((total, leg) => total + (atMaker ? 0 : leg.closeImpactUsd) + leg.reopenImpactUsd, 0);
  return { feeUsd, impactUsd, totalUsd: feeUsd + impactUsd };
}

export function slicedEstimateOf(
  plan: Pick<RealizePlan, 'legs' | 'estimates'>,
  exec: RealizeExec,
  slice: Pick<SliceOption, 'impactUsd' | 'reopenImpactUsd'> | null,
): RealizeEstimate {
  const estimate = plan.estimates[exec];
  const lead = plan.legs[0];
  if (!slice || !lead) return estimate;
  const leadWalkUsd = (exec === 'market' ? lead.closeImpactUsd : 0) + lead.reopenImpactUsd;
  const sliceWalkUsd = (exec === 'market' ? slice.impactUsd : 0) + slice.reopenImpactUsd;
  const impactUsd = Math.max(0, estimate.impactUsd - leadWalkUsd + sliceWalkUsd);
  return { feeUsd: estimate.feeUsd, impactUsd, totalUsd: estimate.feeUsd + impactUsd };
}

export function twapEstimateOf(
  plan: Pick<RealizePlan, 'legs' | 'estimates'>,
  exec: RealizeExec,
  books: Record<string, NormalizedBook | null>,
  qtysBySymbol: Record<string, number[]>,
): RealizeEstimate {
  const estimate = plan.estimates[exec];
  let impactUsd = estimate.impactUsd;
  for (const leg of plan.legs) {
    const qtys = qtysBySymbol[leg.symbol] ?? [];
    const book = books[leg.symbol] ?? null;
    const touch = touchOf(book);
    if (!book || !touch || qtys.length === 0) continue;
    const walkUsd = (side: 'BUY' | 'SELL'): number | null => {
      let usd = 0;
      for (const qty of qtys) {
        const impact = impactOf(book, side, touch.mid, qty);
        if (!impact) return null;
        usd += impact.usd;
      }
      return usd;
    };
    const close = exec === 'market' ? walkUsd(leg.side === 'SHORT' ? 'BUY' : 'SELL') : 0;
    const reopen = walkUsd(leg.side === 'SHORT' ? 'SELL' : 'BUY');
    if (close === null || reopen === null) continue;
    impactUsd += close + reopen - ((exec === 'market' ? leg.closeImpactUsd : 0) + leg.reopenImpactUsd);
  }
  impactUsd = Math.max(0, impactUsd);
  return { feeUsd: estimate.feeUsd, impactUsd, totalUsd: estimate.feeUsd + impactUsd };
}

export const realizePlanOf = (legs: RealizeLeg[], refused: RealizeRefusal | null): RealizePlan => ({
  legs,
  refused,
  estimates: { maker: realizeEstimateOf({ legs }, 'maker'), market: realizeEstimateOf({ legs }, 'market') },
});

export function planRealize(input: RealizeInput): RealizePlan | null {
  const need = input.moveUsd - input.cashUsd;
  if (!(need > 0)) return null;
  const paying = payingLegs(input);
  if (paying.feeMissing) return realizePlanOf([], NO_FEE_RATE);
  const legs = paying.legs.sort((a, b) => b.moved - a.moved);
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
  const verdicts: SliceVerdict[] = [];
  const shown: RealizeLeg[] = [];
  const planned: RealizeLeg[] = [];
  for (const leg of ordered) {
    if (state.left <= 0) break;
    const order = sizeOrder(leg, state);
    orders.push(order);
    verdicts.push(sliceVerdictOf(leg, order.qty, input.sliceUsd));
    shown.push(legOf(input.pool, leg, order));
    // A leg that frees no cash at any size only adds cost, so it is not planned.
    // A refusal still names and shows it, so a book it runs past says so.
    if (!(order.net > 0)) continue;
    unfunded ||= !canFund(order, state);
    planned.push(shown[shown.length - 1]);
    state = {
      left: state.left - order.net,
      cash: state.cash + order.cashIn - order.convert,
      available: state.available + order.convert * marginPerConvertUsdc,
      borrowLeft: state.borrowLeft - order.convert * (1 - CONVERT_RATE),
    };
  }
  const refused = refusalOf(verdicts, unfunded);
  // Every close loses money even with no Convert: there is nothing to realize,
  // and "no margin" would send the trader to add margin that does not help.
  if (planned.length === 0 && refused?.reason === 'no-margin' && orders.every((order) => order.convert === 0)) return null;
  return realizePlanOf(refused === null ? planned : shown, refused);
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
