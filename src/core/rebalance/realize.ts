import { type NormalizedBook, touchOf } from '../estimate/books';
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import { DEFAULT_STEP, parseSymbol, roundToStep } from '../numbers';
import { PREFLIGHT_MARGIN_BUFFER, TAKER_FEE_RESERVE } from '../preflight';
import { takerAfterCapSec } from '../twap';
import { BORROW_INITIAL_MARGIN, ceilCents, CONVERT_MAX, CONVERT_RATE, HYPERLIQUID_MIN_USDC, type Pool } from './plan';
import { impactOf, ONE_ORDER_USD, type SliceOption, sliceQtys, twapQtysFor } from './slices';


export const MARGIN_CONVERT_FEE = 0.0023;
export const MIN_CONVERT_RATIO = 1.03;
export const PLAN_CONVERT_RATIO = 1.05;
export const PLAN_CASH_HEADROOM = 1.1;
export const GAP_CONVERT_SEC = 30;
export const DRIFT_Z = 3;
export const DRIFT_SIGMA_PER_HOUR = 0.01;
export const DRIFT_DEFAULT_SEC = 300;
export const USDT_CONVERT_MIN = 11.04;
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

export interface RealizeMargin {
  at: 'before' | 'gap';
  amount: number;
  firstQty: number;
  impactUsd?: number;
  impactBp?: number;
  closeWalkUsd?: number;
  reopenWalkUsd?: number;
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
  margin?: RealizeMargin | null;
  hedgedFirstQty?: number;
  closeFeeUsd: number;
  closeMakerFeeUsd: number;
  reopenFeeUsd: number;
  closeImpactUsd: number;
  reopenImpactUsd: number;
  impactBp: number;
  takerRate?: number;
  makerRate?: number;
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
  equityUsd?: number;
  marginBalance?: number;
  initialMargin?: number;
  borrowImRate?: number;
  perps: RealizePerp[];
  books: Record<string, NormalizedBook | null>;
  feeRows: VenueFeeRow[];
  rules: Record<string, PerpRule>;
  twapSlices?: number;
  twapSliceSec?: number;
  convertCashUsd?: number;
  exec?: RealizeExec;
  takerAfterSec?: number | null;
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
  makerClose: boolean;
  book: NormalizedBook | null;
  capUsd: number;
  split: Pick<RealizeInput, 'twapSlices'>;
  sliceSec: number;
  nakedSec: number;
  exposureUsd: number;
  lift: number;
  minConvert: number;
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
  margin: RealizeMargin | null;
  hedgedFirstQty?: number;
  unfunded: boolean;
  cashIn: number;
  net: number;
}

interface State {
  left: number;
  cash: number;
  available: number;
  borrowLeft: number;
  equity: number;
  marginBalance: number;
  initialMargin: number;
}

interface MarginFit {
  margin: RealizeMargin | null;
  slices: number[];
  need: number;
  unfunded: boolean;
  hedgedFirstQty?: number;
}

export const borrowImRateOf = (imHeldUsd: number, liability: number): number =>
  liability > 0 ? Math.max(0, imHeldUsd) / liability : BORROW_INITIAL_MARGIN;

export const liftPerConvert = (imRate: number): number => imRate * (1 - MARGIN_CONVERT_FEE) - MARGIN_CONVERT_FEE;

export const convertMinOf = (from: Pool): number => (from === 'CROSSEX' ? USDT_CONVERT_MIN : HYPERLIQUID_MIN_USDC);

export const imRatioOf = (marginBalance: number, initialMargin: number): number => (initialMargin > 0 ? marginBalance / initialMargin : Infinity);

export interface SliceReserveInput {
  qty: number;
  price: number;
  marginPerCoin: number;
  impactUsd: number;
  seconds: number;
  exposureUsd: number;
  nakedUsd?: number;
  nakedSec?: number;
}

export interface BookExposure {
  legImUsd: number;
  hedgeImUsd: number;
  notionalUsd: number;
  debtRate: number;
}

export const exposureUsdOf = (book: BookExposure): number => book.legImUsd + book.hedgeImUsd + book.debtRate * book.notionalUsd;

export interface CloseTime {
  exec?: RealizeExec;
  takerAfterSec?: number | null;
  twapIntervalSec?: number;
}

export function closeSecondsOf(time: CloseTime): number {
  if (time.exec === 'market' || time.takerAfterSec === null) return time.twapIntervalSec ?? DRIFT_DEFAULT_SEC;
  if (time.twapIntervalSec !== undefined) return time.takerAfterSec ?? takerAfterCapSec(time.twapIntervalSec);
  return time.takerAfterSec ?? DRIFT_DEFAULT_SEC;
}

export const nakedSecondsOf = (time: CloseTime): number => (time.exec === 'market' ? 0 : closeSecondsOf(time)) + GAP_CONVERT_SEC;

export const driftShareOf = (seconds: number): number => DRIFT_Z * DRIFT_SIGMA_PER_HOUR * Math.sqrt(Math.max(0, seconds) / 3600);

export const sliceReserveUsd = (slice: SliceReserveInput): number =>
  slice.qty * (slice.price * 2 * TAKER_FEE_RESERVE + slice.marginPerCoin * (PREFLIGHT_MARGIN_BUFFER - 1)) +
  Math.max(0, slice.impactUsd) +
  slice.exposureUsd * driftShareOf(slice.seconds) +
  (slice.nakedUsd ?? 0) * driftShareOf(slice.nakedSec ?? slice.seconds + GAP_CONVERT_SEC);

export interface GapSizing {
  lot: string;
  wholeLots: number;
  topLots: number;
  minLots: number;
  ratio: number;
  headroom: number;
  marginBalance: number;
  initialMargin: number;
  marginPerCoin: number;
  costOf: (qty: number) => { closeUsd: number; shortUsd: number; convert: number };
  capOf: (qty: number, closeUsd: number) => number;
}

function smallestOf(lo: number, hi: number, passes: (lots: number) => boolean): number | null {
  if (lo > hi || !passes(hi)) return null;
  let bad = lo - 1;
  let good = hi;
  while (good - bad > 1) {
    const mid = Math.floor((bad + good) / 2);
    if (passes(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

function peakOf(lo: number, hi: number, value: (lots: number) => number): number {
  let a = lo;
  let b = hi;
  while (b - a > 2) {
    const third = Math.floor((b - a) / 3);
    const left = value(a + third);
    const right = value(b - third);
    if (left < right) a = a + third + 1;
    else if (left > right) b = b - third - 1;
    else {
      a += third;
      b -= third;
    }
  }
  let best = a;
  for (let lots = a + 1; lots <= b; lots += 1) if (value(lots) > value(best)) best = lots;
  return best;
}

export function gapLotsFor(sizing: GapSizing, fromLots: number): number | null {
  const { wholeLots, minLots } = sizing;
  const snapped = (lots: number): number => (wholeLots - lots > 0 && wholeLots - lots < minLots ? wholeLots : lots);
  const qtyAt = (lots: number): number => Number(roundToStep(snapped(lots) * Number(sizing.lot), sizing.lot, 'nearest'));
  const ratioFits = (lots: number): boolean => {
    const qty = qtyAt(lots);
    return imRatioOf(sizing.marginBalance - sizing.costOf(qty).closeUsd, sizing.initialMargin - qty * sizing.marginPerCoin) >= sizing.ratio;
  };
  const room = (lots: number): number => {
    const qty = qtyAt(lots);
    const cost = sizing.costOf(qty);
    return sizing.capOf(qty, cost.closeUsd) - sizing.headroom * cost.convert;
  };
  const fits = (lots: number): boolean => snapped(lots) <= sizing.topLots && room(lots) >= 0;
  const needed = smallestOf(Math.max(1, fromLots), sizing.topLots, (lots) => sizing.costOf(qtyAt(lots)).convert > 0);
  const low = needed === null ? null : smallestOf(needed, sizing.topLots, ratioFits);
  if (low === null) return null;
  const peak = peakOf(low, sizing.topLots, room);
  const first = smallestOf(low, peak, fits);
  return first === null ? null : snapped(first);
}

export const convertToLift = (shortUsd: number, lift: number, minimum: number): number => {
  if (!(shortUsd > 0)) return 0;
  return lift > 0 ? Math.max(minimum, ceilCents(shortUsd / lift)) : Infinity;
};

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

export const realizeFeePerCoin = (mark: number, takerRate: number): number => 2 * mark * takerRate;

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
    const marginPerCoin = Math.abs(Number(perp.initialMargin) || 0) / positionQty;
    const hedgeImUsd = input.perps
      .filter((other) => other !== perp && parseSymbol(other.symbol ?? '').base === base && Math.sign(Number(other.positionQty)) === -Math.sign(signed))
      .reduce((total, other) => total + Math.abs(Number(other.initialMargin) || 0), 0);
    const debtRate = input.borrowUsd > 0 ? (input.borrowImRate ?? BORROW_INITIAL_MARGIN) : 0;
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
        marginPerCoin,
        lot,
        minQty: minQtyOf(rule, lot, mark),
        makerRate: rates.makerRate,
        takerRate: rates.takerRate,
        makerClose: input.exec === 'maker',
        book: input.books[symbol] ?? null,
        capUsd: marketCapUsd(perp, rule, exchange, mark),
        split: { twapSlices: input.twapSlices },
        sliceSec: closeSecondsOf(closeTimeOf(input)),
        nakedSec: nakedSecondsOf(closeTimeOf(input)),
        exposureUsd: exposureUsdOf({ legImUsd: positionQty * marginPerCoin, hedgeImUsd, notionalUsd: positionQty * mark, debtRate }),
        lift: liftPerConvert(input.borrowImRate ?? BORROW_INITIAL_MARGIN),
        minConvert: convertMinOf(input.pool),
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

const closeTimeOf = (input: RealizeInput): CloseTime => ({
  exec: input.exec,
  takerAfterSec: input.takerAfterSec,
  ...(input.twapSliceSec !== undefined && input.twapSliceSec > 0 ? { twapIntervalSec: input.twapSliceSec } : {}),
});

function slicesOf(leg: Paying, qty: number, count = leg.split.twapSlices): number[] {
  const capQty = leg.capUsd / leg.mark;
  if (count !== undefined && count > 0) return twapQtysFor(qty, count, leg.lot, leg.minQty, capQty);
  const mid = touchOf(leg.book)?.mid ?? leg.mark;
  return sliceQtys(qty, Math.min(ONE_ORDER_USD / mid, capQty), leg.minQty, leg.lot, capQty);
}

const convertCapOf = (state: State, cashIn: number, costUsd: number): number =>
  Math.min(state.cash + cashIn, state.equity - costUsd, state.borrowLeft / (1 - CONVERT_RATE));

interface FirstCost {
  closeUsd: number;
  shortUsd: number;
  convert: number;
  priced: Priced;
}

function firstSliceCost(leg: Paying, qty: number, state: State, gap: boolean): FirstCost {
  const priced = priceOrder(leg, qty);
  const closeUsd = leg.makerClose ? priced.closeMakerFeeUsd : priced.closeFeeUsd + Math.max(0, priced.closeImpactUsd);
  const reserve = sliceReserveUsd({
    qty,
    price: leg.mark,
    marginPerCoin: leg.marginPerCoin,
    impactUsd: priced.reopenImpactUsd,
    seconds: leg.sliceSec,
    exposureUsd: leg.exposureUsd,
    nakedUsd: gap ? qty * leg.mark : 0,
    nakedSec: leg.nakedSec,
  });
  const shortUsd = reserve + closeUsd - state.available;
  return { closeUsd, shortUsd, convert: convertToLift(shortUsd, leg.lift, leg.minConvert), priced };
}

function gapLotsOf(leg: Paying, qty: number, state: State, fromLots: number): number | null {
  const lot = Number(leg.lot);
  return gapLotsFor(
    {
      lot: leg.lot,
      wholeLots: Math.round(qty / lot),
      topLots: Math.min(Math.round(qty / lot), Math.floor(leg.capUsd / leg.mark / lot + 1e-9)),
      minLots: Math.ceil(leg.minQty / lot - 1e-9),
      ratio: PLAN_CONVERT_RATIO,
      headroom: PLAN_CASH_HEADROOM,
      marginBalance: state.marginBalance,
      initialMargin: state.initialMargin,
      marginPerCoin: leg.marginPerCoin,
      costOf: (q1) => firstSliceCost(leg, q1, state, true),
      capOf: (q1, closeUsd) => convertCapOf(state, q1 * leg.profitPerCoin - closeUsd, closeUsd),
    },
    fromLots,
  );
}

function hedgedQtyOf(leg: Paying, qty: number, state: State, firstLots: number): number | null {
  const lot = Number(leg.lot);
  const qtyAt = (lots: number): number => Number(roundToStep(lots * lot, leg.lot, 'nearest'));
  const minLots = Math.max(1, Math.ceil(leg.minQty / lot - 1e-9));
  const gapNeeded = smallestOf(minLots, firstLots, (lots) => firstSliceCost(leg, qtyAt(lots), state, true).convert > 0);
  if (gapNeeded === null) return null;
  const lots = Math.max(minLots, gapNeeded - 1);
  return firstSliceCost(leg, qtyAt(lots), state, false).convert === 0 ? qtyAt(lots) : null;
}

type FitMode = 'largest' | 'small' | 'gap';

function largestHedgedOf(leg: Paying, state: State, firstLots: number): number | null {
  const lot = Number(leg.lot);
  const qtyAt = (lots: number): number => Number(roundToStep(lots * lot, leg.lot, 'nearest'));
  const minLots = Math.max(1, Math.ceil(leg.minQty / lot - 1e-9));
  const overLots = smallestOf(minLots, firstLots, (lots) => firstSliceCost(leg, qtyAt(lots), state, false).convert > 0);
  return overLots === null || overLots - 1 < minLots ? null : qtyAt(overLots - 1);
}

function fundsSecondOf(leg: Paying, sized: number, second: number | undefined, state: State): boolean {
  if (second === undefined || !(second > 0)) return true;
  const first = firstSliceCost(leg, sized, state, false);
  const next = firstSliceCost(leg, second, { ...state, available: state.available - first.closeUsd - first.priced.reopenFeeUsd - Math.max(0, first.priced.reopenImpactUsd) }, false).convert;
  if (next === 0) return true;
  if (imRatioOf(state.marginBalance, state.initialMargin) < MIN_CONVERT_RATIO || !Number.isFinite(next)) return false;
  const cash = state.cash + sized * leg.profitPerCoin - first.closeUsd - first.priced.reopenFeeUsd;
  return next <= Math.min(cash, state.equity, state.borrowLeft / (1 - CONVERT_RATE));
}

function marginFitOf(leg: Paying, qty: number, state: State, mode: FitMode): MarginFit {
  const slices = slicesOf(leg, qty);
  const first = Math.min(qty, slices[0] ?? qty);
  const start = firstSliceCost(leg, first, state, false);
  const need = Number.isFinite(start.convert) ? start.convert : 0;
  if (start.convert === 0) return { margin: null, slices, need: 0, unfunded: false };
  if (imRatioOf(state.marginBalance, state.initialMargin) >= MIN_CONVERT_RATIO && PLAN_CASH_HEADROOM * start.convert <= Math.min(state.cash, state.equity) && start.convert <= state.borrowLeft / (1 - CONVERT_RATE)) {
    return { margin: { at: 'before', amount: start.convert, firstQty: first }, slices, need, unfunded: false };
  }
  const lot = Number(leg.lot);
  const restCount = leg.split.twapSlices !== undefined && leg.split.twapSlices > 0 ? Math.max(1, leg.split.twapSlices - 1) : undefined;
  if (mode !== 'gap') {
    const sized = mode === 'largest' ? largestHedgedOf(leg, state, Math.round(first / lot)) : hedgedQtyOf(leg, qty, state, Math.round(first / lot));
    if (sized === null) return { margin: null, slices, need, unfunded: true };
    const rest = sized < qty ? slicesOf(leg, Number(roundToStep(qty - sized, leg.lot, 'nearest')), restCount) : [];
    if (!fundsSecondOf(leg, sized, rest[0], state)) return { margin: null, slices, need, unfunded: true };
    return { margin: null, slices: [sized, ...rest], need: 0, unfunded: false, hedgedFirstQty: sized };
  }
  const fromFirst = gapLotsOf(leg, qty, state, Math.round(first / lot));
  const hedged = fromFirst === null ? hedgedQtyOf(leg, qty, state, Math.round(first / lot)) : null;
  const hedgedRest = hedged !== null && hedged < qty ? slicesOf(leg, Number(roundToStep(qty - hedged, leg.lot, 'nearest')), restCount) : [];
  if (hedged !== null && fundsSecondOf(leg, hedged, hedgedRest[0], state)) {
    return { margin: null, slices: [hedged, ...hedgedRest], need: 0, unfunded: false, hedgedFirstQty: hedged };
  }
  const lots = fromFirst ?? gapLotsOf(leg, qty, state, Math.ceil(leg.minQty / lot - 1e-9));
  if (lots === null) return { margin: null, slices, need, unfunded: true };
  const q1 = Number(roundToStep(lots * lot, leg.lot, 'nearest'));
  const rest = q1 < qty ? slicesOf(leg, Number(roundToStep(qty - q1, leg.lot, 'nearest')), restCount) : [];
  const cost = firstSliceCost(leg, q1, state, true);
  const closeWalkUsd = Math.max(0, cost.priced.closeImpactUsd);
  const reopenWalkUsd = Math.max(0, cost.priced.reopenImpactUsd);
  const impactUsd = (leg.makerClose ? 0 : closeWalkUsd) + reopenWalkUsd;
  const walkedUsd = closeWalkUsd + reopenWalkUsd;
  const impactBp = walkedUsd > 0 ? (cost.priced.impactBp * impactUsd) / walkedUsd : 0;
  const margin: RealizeMargin = { at: 'gap', amount: cost.convert, firstQty: q1, impactUsd, impactBp, closeWalkUsd, reopenWalkUsd };
  return { margin, slices: [q1, ...rest], need: cost.convert, unfunded: false };
}

function orderOf(leg: Paying, qty: number, state: State, mode: FitMode): Order {
  const fit = marginFitOf(leg, qty, state, mode);
  const run = averagedRealize(leg.profitPerCoin, leg.positionQty, fit.slices, realizeFeePerCoin(leg.mark, leg.takerRate));
  const closed = run.qty > 0 && run.qty < qty ? Number(roundToStep(run.qty, leg.lot, 'nearest')) : qty;
  const realizedUsd = run.qty > 0 ? run.realizedUsd : qty * leg.profitPerCoin;
  const priced = priceOrder(leg, closed);
  const convert = fit.need;
  const cashIn = realizedUsd - priced.closeFeeUsd - priced.reopenFeeUsd - priced.closeImpactUsd;
  const margin = fit.margin && fit.margin.firstQty >= closed ? { ...fit.margin, firstQty: closed } : fit.margin;
  return { qty: closed, priced, realizedUsd, convert, margin, ...(fit.hedgedFirstQty === undefined ? {} : { hedgedFirstQty: Math.min(fit.hedgedFirstQty, closed) }), unfunded: fit.unfunded, cashIn, net: cashIn - priced.reopenImpactUsd - convert * MARGIN_CONVERT_FEE };
}

function sizeOrder(leg: Paying, state: State): Order {
  for (const mode of ['largest', 'small'] as const) {
    const hedged = sizeOrderBy(leg, state, mode);
    if (hedged.net >= state.left && !hedged.unfunded) return hedged;
  }
  return sizeOrderBy(leg, state, 'gap');
}

function sizeOrderBy(leg: Paying, state: State, mode: FitMode): Order {
  const top = leg.positionQty;
  const whole = orderOf(leg, top, state, mode);
  const lot = Number(leg.lot);
  const qtyAt = (lots: number): number => Number(roundToStep(lots * lot, leg.lot, 'nearest'));
  const enough = (order: Order): boolean => order.net >= state.left && (!order.unfunded || whole.unfunded);
  let lo = Math.round(leg.minQty / lot);
  let hi = Math.floor(top / lot + 1e-9);
  if (whole.net < state.left || lo >= hi) return whole;
  const first = orderOf(leg, qtyAt(lo), state, mode);
  if (enough(first)) return first;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (enough(orderOf(leg, qtyAt(mid), state, mode))) hi = mid;
    else lo = mid;
  }
  return orderOf(leg, Math.min(qtyAt(hi), top), state, mode);
}

const canFund = (order: Order): boolean => order.net > 0 && !order.unfunded;

function stateAfter(leg: Paying, order: Order, state: State): State {
  const costUsd = order.priced.closeFeeUsd + order.priced.reopenFeeUsd + order.priced.closeImpactUsd + order.priced.reopenImpactUsd;
  return {
    left: state.left - order.net,
    cash: state.cash + order.cashIn - order.convert,
    available: state.available + leg.lift * order.convert - costUsd,
    borrowLeft: state.borrowLeft - order.convert * (1 - CONVERT_RATE),
    equity: state.equity - order.convert - costUsd,
    marginBalance: state.marginBalance - costUsd - order.convert * MARGIN_CONVERT_FEE,
    initialMargin: state.initialMargin - (leg.lift + MARGIN_CONVERT_FEE) * order.convert,
  };
}

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
        ? { amount: order.convert, count: Math.ceil(order.convert / CONVERT_MAX), feeUsd: order.convert * MARGIN_CONVERT_FEE }
        : null,
    margin: order.margin,
    ...(order.hedgedFirstQty === undefined ? {} : { hedgedFirstQty: order.hedgedFirstQty }),
    closeFeeUsd: order.priced.closeFeeUsd,
    closeMakerFeeUsd: order.priced.closeMakerFeeUsd,
    reopenFeeUsd: order.priced.reopenFeeUsd,
    closeImpactUsd: order.priced.closeImpactUsd,
    reopenImpactUsd: order.priced.reopenImpactUsd,
    impactBp: order.priced.impactBp,
    takerRate: leg.takerRate,
    makerRate: leg.makerRate,
  };
}

interface SliceVerdict {
  pastBook: boolean;
  overCapUsd: number | null;
}

function sliceVerdictOf(leg: Paying, qty: number): SliceVerdict {
  if (!leg.book || !touchOf(leg.book)) return { pastBook: true, overCapUsd: null };
  const capQty = leg.capUsd / leg.mark;
  const sliceQty = Math.min(qty, Math.max(leg.minQty, ...slicesOf(leg, qty)));
  return { pastBook: priceOrder(leg, sliceQty).pastBook, overCapUsd: Math.min(qty, leg.minQty) > capQty ? leg.capUsd : null };
}

export function capsUsdOf(perps: RealizePerp[], rules: Record<string, PerpRule>): Record<string, number> {
  return Object.fromEntries(
    perps.flatMap((perp) => {
      const mark = positiveOf(perp.markPrice);
      if (!perp.symbol || !(mark > 0)) return [];
      const capUsd = marketCapUsd(perp, rules[perp.symbol] ?? {}, parseSymbol(perp.symbol).exchange, mark);
      return Number.isFinite(capUsd) ? [[perp.symbol, capUsd]] : [];
    }),
  );
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
  slice: Pick<SliceOption, 'impactUsd' | 'reopenImpactUsd' | 'count' | 'notHedgedMaxQty'> | null,
): RealizeEstimate {
  const estimate = plan.estimates[exec];
  const lead = plan.legs[0];
  if (!slice || !lead) return estimate;
  const leadWalkUsd = (exec === 'market' ? lead.closeImpactUsd : 0) + lead.reopenImpactUsd;
  const sliceWalkUsd = slicesWalkUsd(lead, exec, slice);
  const impactUsd = Math.max(0, estimate.impactUsd - leadWalkUsd + sliceWalkUsd);
  return { feeUsd: estimate.feeUsd, impactUsd, totalUsd: estimate.feeUsd + impactUsd };
}

function slicesWalkUsd(lead: RealizeLeg, exec: RealizeExec, slice: Pick<SliceOption, 'impactUsd' | 'reopenImpactUsd' | 'count' | 'notHedgedMaxQty'>): number {
  const evenUsd = (exec === 'market' ? slice.impactUsd : 0) + slice.reopenImpactUsd;
  const margin = lead.margin;
  if (margin?.at !== 'gap' || margin.reopenWalkUsd === undefined || !(slice.count > 0) || !(slice.notHedgedMaxQty > 0)) return evenUsd;
  const first = Math.min(margin.firstQty, lead.qty);
  const firstUsd = (exec === 'market' ? (margin.closeWalkUsd ?? 0) : 0) + margin.reopenWalkUsd;
  return firstUsd + (evenUsd / slice.count) * (Math.max(0, lead.qty - first) / slice.notHedgedMaxQty);
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
    const twapQtys = qtysBySymbol[leg.symbol] ?? [];
    const first = leg.margin?.at === 'gap' && leg.qty > 0 ? Math.min(leg.margin.firstQty, leg.qty) : 0;
    const book = books[leg.symbol] ?? null;
    const touch = touchOf(book);
    if (!book || !touch || twapQtys.length === 0) continue;
    const restCount = Math.max(1, twapQtys.length - 1);
    const rest = leg.qty - first;
    const qtys = first > 0 ? [first, ...(rest > 0 ? Array.from({ length: restCount }, () => rest / restCount) : [])] : twapQtys;
    const walkUsd = (side: 'BUY' | 'SELL', sizes: number[]): number | null => {
      let usd = 0;
      for (const qty of sizes) {
        const impact = impactOf(book, side, touch.mid, qty);
        if (!impact) return null;
        usd += impact.usd;
      }
      return usd;
    };
    const close = exec === 'market' ? walkUsd(leg.side === 'SHORT' ? 'BUY' : 'SELL', qtys) : 0;
    const reopen = walkUsd(leg.side === 'SHORT' ? 'SELL' : 'BUY', qtys);
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
  const known = (value: number | undefined, fallback: number): number => (value !== undefined && Number.isFinite(value) ? value : fallback);
  const start: State = {
    left: need,
    cash: input.convertCashUsd ?? input.cashUsd,
    available: input.availableMargin,
    borrowLeft: Math.max(0, input.borrowUsd),
    equity: known(input.equityUsd, Infinity),
    marginBalance: known(input.marginBalance, Infinity),
    initialMargin: known(input.initialMargin, 0),
  };
  const first = legs.findIndex((leg) => canFund(sizeOrder(leg, start)));
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
    verdicts.push(sliceVerdictOf(leg, order.qty));
    shown.push(legOf(input.pool, leg, order));
    // A leg that frees no cash at any size only adds cost, so it is not planned.
    // A refusal still names and shows it, so a book it runs past says so.
    if (!(order.net > 0)) continue;
    unfunded ||= !canFund(order);
    planned.push(shown[shown.length - 1]);
    state = stateAfter(leg, order, state);
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
