import { parseBinanceBook } from '../estimate/books';
import { walkBook } from '../estimate/fill';
import { floorDecimalString, floorToStep, roundToStep } from '../numbers';

export const USDC_WALLET = { coin: 'USDC', venue: 'HYPERLIQUID' } as const;
export const LIGHTER_WALLET = { coin: 'USDC', venue: 'LIGHTER' } as const;
export const USDT_WALLET = { coin: 'USDT', venue: 'CROSSEX' } as const;
export const SPOT_SYMBOL = 'GATE_SPOT_USDC_USDT';
export const SPOT_PAIR = 'USDC_USDT';
export const HYPERLIQUID_FREE_BORROW_USDC = 10_000;
export const CONVERT_RATE = 0.002;
export const CONVERT_MAX = 500_000;
/** A pair's USDT half is its USDC half x bid x 0.998, so 495,000 keeps that half under Gate's 500,000 Convert cap while the USDC bid is at most 1.0121. */
export const PAIR_CONVERT_MAX = 495_000;
export const HYPERLIQUID_DEPOSIT_FEE_USD = 0.05;
export const HYPERLIQUID_WITHDRAW_FEE_USD = 1;
export const HYPERLIQUID_MIN_USDC = 11;
export const LIGHTER_DEPOSIT_FEE_USD = 1.03;
const APP_FLOOR = 1.12;
const BORROW_INITIAL_MARGIN = 0.2;
export const MIN_TRANSFER = 0.00001;
export const SPOT_MIN_QUOTE_USDT = 3;
export const SPOT_ORDER_MAX_USDC = 4_900_000;
export const SPOT_MARKET_MAX_USDT = 5_000_000;
const SPOT_ORDER_SHARE = 0.98;
const RECOMMENDED_MAX_SECONDS = 900;
/** Rounds a Spot loop may take before it stops being a route: 100 rounds is
 * over three hours at the fastest hop. Past it the row stays, closed, with
 * the reason, so the trader still sees what the loop would have cost. */
const LOOP_ROUND_CAP = 100;
const LOOP_CAP_REASON = `Spot loop would take more than ${LOOP_ROUND_CAP} rounds.`;
export const DUST_USDC = 1;
const GATE_HOP_SECONDS = 5;

export type Pool = 'CROSSEX' | 'HYPERLIQUID' | 'LIGHTER';
export type Venue = Exclude<Pool, 'CROSSEX'>;
export const POOLS: readonly Pool[] = ['CROSSEX', 'HYPERLIQUID', 'LIGHTER'];
const VENUES: readonly Venue[] = ['HYPERLIQUID', 'LIGHTER'];

interface VenueRule {
  inFeeUsd: number;
  outFeeUsd: number;
  inSeconds: number;
  outSeconds: number;
}

const VENUE: Record<Venue, VenueRule> = {
  HYPERLIQUID: {
    inFeeUsd: HYPERLIQUID_DEPOSIT_FEE_USD,
    outFeeUsd: HYPERLIQUID_WITHDRAW_FEE_USD,
    inSeconds: 125,
    outSeconds: 395,
  },
  LIGHTER: { inFeeUsd: LIGHTER_DEPOSIT_FEE_USD, outFeeUsd: 0, inSeconds: 230, outSeconds: 180 },
};

export const walletKey = (coin: string, venue: string): string => `${coin}/${venue}`;

export const GATE_WALLET = { coin: 'USDC', venue: 'GATE' } as const;

export const poolWallet = (pool: Pool): { coin: string; venue: string } =>
  pool === 'CROSSEX' ? USDT_WALLET : { coin: 'USDC', venue: pool };

export const isVenue = (value: string): value is Venue => (VENUES as readonly string[]).includes(value);

const PAUSED_REASON = 'Gate paused USDC transfers.';
const CLOSED_REASON = 'The spot market for USDC is closed.';
const NO_ROUND_REASON = 'Free margin is too low for an 11 USDC round.';
const NO_CASH_REASON = 'Not enough cash for an 11 USDC round.';
const USDT_SHORT_REASON = 'A Convert between Hyperliquid and Lighter needs USDT · CrossEx cash of -1 or more.';
const underMinimumReason = (minimum: number): string => `The move is under the ${minimum} USDC minimum.`;

export type GateAccount = 'SPOT' | 'CROSSEX' | 'CROSSEX_GATE' | 'CROSSEX_HYPERLIQUID' | 'CROSSEX_LIGHTER';
export type TransferCoin = 'USDT' | 'USDC';
export type RouteName = 'mix' | 'loop' | 'convert';

/**
 * What the plan is for. Every stage downstream — gaps, moves, the solve,
 * routes, costs, the after-picture — reads one thing: a target equity per
 * pool. The goal is how that target is chosen.
 * - `even`: each pool's share of total equity, by position size. Needs legs.
 * - `repay`: every negative pool to 0, funded by the largest positive pool
 *   first, each capped by its CASH (equity holds unrealised PnL that cannot
 *   move), then the next.
 * - `custom`: send exactly `amount` from one pool to another.
 */
export type Goal =
  | { kind: 'even' }
  | { kind: 'repay' }
  | { kind: 'custom'; from: Pool; to: Pool; amount: number };
export type GoalKind = Goal['kind'];
export const EVEN_GOAL: Goal = { kind: 'even' };
export const REPAY_GOAL: Goal = { kind: 'repay' };

export interface WalletTarget {
  coin: string;
  venue: string;
  equity: number;
}

export interface AssetLike {
  coin?: string;
  exchangeType?: string;
  balance?: string;
  availableBalance?: string;
  upnl?: string;
  equity?: string;
  liability?: string;
  borrowingInitialMargin: string;
  borrowingMaintenanceMargin: string;
}

export interface AccountLike {
  availableMargin: string;
  marginBalance: string;
  initialMargin: string;
  assets?: AssetLike[];
}

export interface RateLike {
  coin: string;
  exchangeType: string;
  hourInterestRate: string;
}

/** Interest paid since Gate's history floor, by wallet key. See interestLedger.ts. */
export type InterestPaidLike = Record<string, number>;

export interface Bucket {
  coin: string;
  venue: string;
  cash: number;
  upnl: number;
  equity: number;
  borrow: number;
  imHeldUsd: number;
  mmHeldUsd: number;
  /** All time, or as far back as Gate's history reaches (2025-01-01). */
  interestPaidUsd: number;
  interestPerDayUsd: number;
  ratePerYear: number | null;
}

export interface CoinRuleLike {
  coin: string;
  minTransAmount: number | string;
  estFee: number | string;
  isDisabled: number | string;
}

export interface WalletAfter {
  coin: string;
  venue: string;
  cash: number;
  equity: number;
}

export interface WalletShare {
  coin: string;
  venue: string;
  notionalUsd: number;
  share: number;
}

export interface PlannedStep {
  round: number | null;
  kind: 'round' | 'convert';
  buy: number;
  move: number;
  arrives: number;
  borrowLeft: number;
  seconds: number;
  from: Pool;
  to: Pool;
}

export interface RoutePlan {
  available: boolean;
  reason: string | null;
  costUsd: number;
  seconds: number;
  rounds: number;
  oneMoreRoundCostUsd: number | null;
  beyondBook: boolean;
  marginFreedUsd: number;
  savesPerDayUsd: number;
  after: WalletAfter[];
  steps: PlannedStep[];
}

export interface EvenPlan {
  goal: Goal;
  /** Nothing to do for this goal. */
  balanced: boolean;
  /** No open legs. Only the `even` goal has nothing to do because of it. */
  noLegs: boolean;
  moves: number;
  /** What the goal still wants after the plan, when cash or margin capped it. */
  shortOfEven: number;
  roundCap: number;
  split: WalletShare[];
  /** Equity per pool the goal aims at, before fees. */
  targets: WalletTarget[];
  routes: { mix: RoutePlan | null; loop: RoutePlan | null; convert: RoutePlan };
  recommended: RouteName | null;
}

export interface PlanInputs {
  coins: CoinRuleLike[];
  spotRule: { state: string; maxMarketSize?: string | null } | null;
  spotTakerRate: number;
  ask: number | null;
  bid: number | null;
  asks?: BookLevel[];
  bids?: BookLevel[];
  notional: Readonly<Record<string, number>>;
}

export type BookLevel = [price: number, size: number];

export interface SpotDepth {
  ask: number;
  bid: number;
  asks: BookLevel[];
  bids: BookLevel[];
}

export interface SpotBalance {
  coin: TransferCoin;
  available: number;
  locked: number;
}

export interface TransferPath {
  coin: TransferCoin;
  from: GateAccount;
  to: GateAccount;
  max: number | null;
  min: number;
  feeUsd: number;
  seconds: number;
}

type PathRule = Omit<TransferPath, 'max'>;

const PATHS: PathRule[] = [
  { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', min: MIN_TRANSFER, feeUsd: 0, seconds: 3 },
  { coin: 'USDT', from: 'CROSSEX', to: 'SPOT', min: MIN_TRANSFER, feeUsd: 0, seconds: 3 },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', min: MIN_TRANSFER, feeUsd: 0, seconds: 5 },
  { coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', min: MIN_TRANSFER, feeUsd: 0, seconds: 5 },
  {
    coin: 'USDC',
    from: 'SPOT',
    to: 'CROSSEX_HYPERLIQUID',
    min: HYPERLIQUID_MIN_USDC,
    feeUsd: HYPERLIQUID_DEPOSIT_FEE_USD,
    seconds: 120,
  },
  {
    coin: 'USDC',
    from: 'CROSSEX_HYPERLIQUID',
    to: 'SPOT',
    min: HYPERLIQUID_MIN_USDC,
    feeUsd: HYPERLIQUID_WITHDRAW_FEE_USD,
    seconds: 400,
  },
  { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_LIGHTER', min: HYPERLIQUID_MIN_USDC, feeUsd: LIGHTER_DEPOSIT_FEE_USD, seconds: 230 },
  { coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'SPOT', min: HYPERLIQUID_MIN_USDC, feeUsd: 0, seconds: 180 },
];

const CROSSEX_VENUE: Record<Exclude<GateAccount, 'SPOT'>, string> = {
  CROSSEX: USDT_WALLET.venue,
  CROSSEX_GATE: GATE_WALLET.venue,
  CROSSEX_HYPERLIQUID: USDC_WALLET.venue,
  CROSSEX_LIGHTER: LIGHTER_WALLET.venue,
};

const VENUE_WALLETS: readonly GateAccount[] = ['CROSSEX_HYPERLIQUID', 'CROSSEX_LIGHTER'];

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function floorCents(value: number): number {
  return Number(roundToStep(value, '0.01', 'down'));
}

export function nearestCents(value: number): number {
  return Number(roundToStep(value, '0.01', 'nearest'));
}

export function ceilCents(value: number): number {
  return Number(roundToStep(value, '0.01', 'up'));
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

export function spotOrderMax(price: number, maxMarketSize?: number | null): number {
  const quoted = Number.isFinite(price) && price > 0 ? price : 1;
  const ruled =
    typeof maxMarketSize === 'number' && Number.isFinite(maxMarketSize) && maxMarketSize > 0
      ? SPOT_ORDER_SHARE * maxMarketSize
      : Infinity;
  return floorCents(Math.min(SPOT_ORDER_MAX_USDC, (SPOT_ORDER_SHARE * SPOT_MARKET_MAX_USDT) / quoted, ruled));
}

export function bookLevels(body: unknown): Pick<SpotDepth, 'asks' | 'bids'> {
  const book = parseBinanceBook(body);
  return { asks: book?.asks ?? [], bids: book?.bids ?? [] };
}

function priced(levels: BookLevel[], usdc: number, top: number): { usdt: number; beyond: boolean } {
  const walked = levels.length > 0 ? walkBook(levels, usdc) : null;
  return walked ? { usdt: walked.avgPrice * usdc, beyond: walked.exhausted } : { usdt: usdc * top, beyond: false };
}

export const buyCostUsdt = (usdc: number, depth: Pick<SpotDepth, 'ask' | 'asks'>): number =>
  priced(depth.asks, usdc, depth.ask).usdt;

export const sellProceedsUsdt = (usdc: number, depth: Pick<SpotDepth, 'bid' | 'bids'>): number =>
  priced(depth.bids, usdc, depth.bid).usdt;

export function buyableUsdc(usdt: number, depth: Pick<SpotDepth, 'ask' | 'asks'>): number {
  let left = usdt;
  let usdc = 0;
  let last = 0;
  for (const [price, size] of depth.asks) {
    if (left <= 0) break;
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, left / price);
    usdc += take;
    left -= take * price;
    last = price;
  }
  if (last === 0) return usdt / depth.ask;
  return left > 0 ? usdc + left / last : usdc;
}

const outFee = (pool: Pool): number => (pool === 'CROSSEX' ? 0 : VENUE[pool].outFeeUsd);
const inFee = (pool: Pool): number => (pool === 'CROSSEX' ? 0 : VENUE[pool].inFeeUsd);

export const roundSeconds = (from: Pool, to: Pool): number =>
  (from === 'CROSSEX' ? GATE_HOP_SECONDS : VENUE[from].outSeconds) +
  (to === 'CROSSEX' ? GATE_HOP_SECONDS : VENUE[to].inSeconds);

export const spotArrivalFor = (from: Pool, move: number): number => floorCents(move - outFee(from));

export const arrivesFor = (from: Pool, to: Pool, move: number): number => floorCents(move - outFee(from) - inFee(to));

export const roundMinimum = (from: Pool, to: Pool, minimum = HYPERLIQUID_MIN_USDC): number =>
  from !== 'CROSSEX' && to !== 'CROSSEX' ? minimum + outFee(from) : minimum;

export function notionalByWallet(legs: readonly { exchange: string; value: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const leg of legs) {
    const wallet = isVenue(leg.exchange) ? poolWallet(leg.exchange) : USDT_WALLET;
    const key = walletKey(wallet.coin, wallet.venue);
    out[key] = (out[key] ?? 0) + Math.abs(leg.value);
  }
  return out;
}

export function bucketsFrom(account: AccountLike, rates: RateLike[], interestPaid: InterestPaidLike): Bucket[] {
  return (account.assets ?? []).map((asset) => {
    const coin = asset.coin ?? '';
    const venue = asset.exchangeType ?? '';
    const equity = num(asset.equity);
    const borrow = num(asset.liability);
    const rate = rates.find((r) => r.coin === coin && r.exchangeType === venue);
    const hourly = rate ? num(rate.hourInterestRate) : 0;
    const paid = interestPaid[walletKey(coin, venue)];
    const interestPaidUsd = Number.isFinite(paid) ? paid : 0;
    return {
      coin,
      venue,
      cash: num(asset.balance),
      upnl: num(asset.upnl),
      equity,
      borrow,
      imHeldUsd: num(asset.borrowingInitialMargin),
      mmHeldUsd: num(asset.borrowingMaintenanceMargin),
      interestPaidUsd,
      interestPerDayUsd: chargedBorrow({ coin, venue }, borrow) * hourly * 24,
      ratePerYear: rate ? hourly * 24 * 365 : null,
    };
  });
}

function chargedBorrow(wallet: { coin: string; venue: string }, borrow: number): number {
  const free = isWallet(USDC_WALLET)(wallet) ? HYPERLIQUID_FREE_BORROW_USDC : 0;
  return Math.max(0, borrow - free);
}

export function fit(account: { marginBalance: number; initialMargin: number }, cash: number, equity = Infinity): number {
  const free = account.marginBalance - APP_FLOOR * account.initialMargin;
  const unborrowed = Math.max(0, equity);
  const borrowFloor = APP_FLOOR * BORROW_INITIAL_MARGIN;
  const room = free <= unborrowed ? free : (free + borrowFloor * unborrowed) / (1 + borrowFloor);
  return Number(floorToStep(Math.max(0, Math.min(cash, room)), '0.01'));
}

function repayment(
  bucket: Bucket | undefined,
  receives: number,
): Pick<RoutePlan, 'savesPerDayUsd' | 'marginFreedUsd'> {
  if (!bucket || bucket.borrow <= 0) return { savesPerDayUsd: 0, marginFreedUsd: 0 };
  const repaid = Math.min(receives, bucket.borrow);
  const chargedBefore = chargedBorrow(bucket, bucket.borrow);
  const perDayAfter =
    chargedBefore > 0 ? (bucket.interestPerDayUsd * chargedBorrow(bucket, bucket.borrow - repaid)) / chargedBefore : 0;
  return {
    savesPerDayUsd: Math.max(0, bucket.interestPerDayUsd - perDayAfter),
    marginFreedUsd: (repaid * bucket.imHeldUsd) / bucket.borrow,
  };
}

const isWallet = (w: { coin: string; venue: string }) => (b: { coin?: string; venue?: string; exchangeType?: string }) =>
  b.coin === w.coin && (b.venue ?? b.exchangeType) === w.venue;

interface CoinRule {
  min: number | null;
  fee: number | null;
  isDisabled: boolean;
}

function finiteOrNull(value: number | string): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function coinRule(coins: CoinRuleLike[], coin: TransferCoin): CoinRule | null {
  const rule = coins.find((c) => c.coin === coin);
  if (!rule) return null;
  return {
    min: positive(finiteOrNull(rule.minTransAmount)),
    fee: finiteOrNull(rule.estFee),
    isDisabled: Number(rule.isDisabled) === 1,
  };
}

interface Holding {
  cash: number;
  equity: number;
}

interface Move {
  from: Pool;
  to: Pool;
  check: Pool;
}

interface Wallets {
  usdt: Holding;
  gate: Holding;
  venues: Record<Venue, Holding>;
}

interface Book extends Wallets, SpotDepth {
  gateMovable: number;
  buckets: Partial<Record<Pool, Bucket>>;
  pools: Pool[];
  notional: Record<Pool, number>;
  shares: Record<Pool, number>;
  goal: Goal;
  /** Fixed target equity per pool for `repay` and `custom`. The `even` goal
   * re-derives its target from the run, so fees are shared by position size. */
  targets: Record<Pool, number>;
  marginBalance: number;
  initialMargin: number;
  takerRate: number;
  minimum: number;
  buyMax: number;
  sellMax: number;
}

interface Run extends Wallets {
  gateMovable: number;
  received: Record<Pool, number>;
  costUsd: number;
  steps: PlannedStep[];
  cashLimited: boolean;
  usdtShort: boolean;
  beyondBook: boolean;
}

type Sizer = (cap: number, left: number, minimum: number) => number;

const holdingOf = (bucket: Bucket | undefined): Holding => ({ cash: bucket?.cash ?? 0, equity: bucket?.equity ?? 0 });

const shifted = (holding: Holding, delta: number): Holding => ({
  cash: holding.cash + delta,
  equity: holding.equity + delta,
});

const fillCap: Sizer = (cap, left) => floorCents(Math.min(cap, left));

const leaveMinimum: Sizer = (cap, left, minimum) => {
  const size = fillCap(cap, left, minimum);
  const rest = floorCents(left - size);
  const shrunk = floorCents(left - minimum);
  return rest > 0 && rest < minimum && shrunk >= minimum ? shrunk : size;
};

const equityOf = (wallets: Wallets, pool: Pool): number =>
  pool === 'CROSSEX' ? wallets.usdt.equity + wallets.gate.cash : wallets.venues[pool].equity;

function shiftPool(run: Run, pool: Pool, delta: number): void {
  if (pool === 'CROSSEX') run.usdt = shifted(run.usdt, delta);
  else run.venues[pool] = shifted(run.venues[pool], delta);
}

/** Cash a pool can send. Equity is not the limit: unrealised PnL cannot move. */
function sendableCash(wallets: Wallets & { gateMovable: number }, from: Pool): number {
  if (from === 'CROSSEX') return Math.max(0, wallets.usdt.cash) + wallets.gateMovable;
  return Math.max(0, wallets.venues[from].cash);
}

/** What a move may take from its sender. Repay stops at the sender's equity
 * as well: cash past it is cover for an open loss, and sending it would make
 * the sender the borrower, so the debt would only change wallets. */
function sendingCash(book: Book, run: Run, move: Move): number {
  const cash = sendableCash(run, move.from);
  return book.goal.kind === 'repay' ? Math.min(cash, Math.max(0, equityOf(run, move.from))) : cash;
}

function roundCash(book: Book, run: Run, move: Move): number {
  if (move.from !== 'CROSSEX') return sendingCash(book, run, move);
  const cash = Math.max(0, run.usdt.cash);
  const buyable =
    book.asks.length === 0
      ? cash / Math.max(1, book.ask * (1 + book.takerRate))
      : Math.min(cash, buyableUsdc(cash / (1 + book.takerRate), book));
  return Math.min(buyable + run.gateMovable, sendingCash(book, run, move));
}

const orderMaxOf = (book: Book, move: Move): number =>
  move.from === 'CROSSEX' ? book.buyMax : move.to === 'CROSSEX' ? book.sellMax : Infinity;

function sendingEquity(run: Run, move: Move): number {
  if (move.from === 'CROSSEX') return Math.max(0, run.usdt.equity) + run.gateMovable;
  return run.venues[move.from].equity;
}

const borrowOf = (holding: Holding): number => Math.max(0, -holding.equity);

function marginsOf(book: Book, run: Run): { marginBalance: number; initialMargin: number } {
  const moved =
    VENUES.reduce(
      (total, venue) => total + (run.venues[venue].equity - book.venues[venue].equity),
      run.usdt.equity - book.usdt.equity,
    ) +
    (run.gate.equity - book.gate.equity);
  const borrowed = VENUES.reduce(
    (total, venue) => total + Math.max(0, borrowOf(run.venues[venue]) - borrowOf(book.venues[venue])),
    Math.max(0, borrowOf(run.usdt) - borrowOf(book.usdt)),
  );
  const freed = POOLS.reduce(
    (total, pool) => total + repayment(book.buckets[pool], run.received[pool]).marginFreedUsd,
    0,
  );
  return {
    marginBalance: book.marginBalance + moved,
    initialMargin: book.initialMargin - freed + borrowed * BORROW_INITIAL_MARGIN,
  };
}

const borrowLeftOf = (book: Book, run: Run, pool: Pool): number =>
  floorCents(Math.max(0, (book.buckets[pool]?.borrow ?? 0) - run.received[pool]));

function pushRound(book: Book, run: Run, move: Move, figures: Pick<PlannedStep, 'buy' | 'move' | 'arrives'>): void {
  run.steps.push({
    round: run.steps.filter((step) => step.kind === 'round').length + 1,
    kind: 'round',
    ...figures,
    borrowLeft: borrowLeftOf(book, run, move.to),
    seconds: roundSeconds(move.from, move.to),
    from: move.from,
    to: move.to,
  });
}

function roundInto(book: Book, run: Run, move: Move, size: number): void {
  const venue = move.to as Venue;
  const fromGate = Math.min(run.gateMovable, size);
  const buy = floorCents(size - fromGate);
  const arrives = arrivesFor(move.from, venue, size);
  const paid = priced(book.asks, buy, book.ask);
  run.usdt = shifted(run.usdt, -paid.usdt * (1 + book.takerRate));
  run.gate = shifted(run.gate, -fromGate);
  run.gateMovable -= fromGate;
  run.venues[venue] = shifted(run.venues[venue], arrives);
  run.received[venue] += arrives;
  run.beyondBook ||= paid.beyond;
  run.costUsd +=
    VENUE[venue].inFeeUsd +
    buy * Math.max(0, book.ask - 1) +
    Math.max(0, paid.usdt - buy * book.ask) +
    paid.usdt * book.takerRate;
  pushRound(book, run, move, { buy, move: size, arrives });
}

function sellUsdc(book: Book, run: Run, move: Move, arrived: number): void {
  const sold = arrived + run.gateMovable;
  const sale = priced(book.bids, sold, book.bid);
  const gained = sale.usdt * (1 - book.takerRate);
  run.usdt = shifted(run.usdt, gained);
  run.gate = shifted(run.gate, -run.gateMovable);
  run.gateMovable = 0;
  if (move.to === 'CROSSEX') run.received.CROSSEX += gained;
  run.beyondBook ||= sale.beyond;
  run.costUsd +=
    sold * Math.max(0, 1 - book.bid) + Math.max(0, sold * book.bid - sale.usdt) + sale.usdt * book.takerRate;
}

function roundOut(book: Book, run: Run, move: Move, size: number): void {
  const venue = move.from as Venue;
  const arrives = arrivesFor(venue, move.to, size);
  run.venues[venue] = shifted(run.venues[venue], -size);
  run.costUsd += VENUE[venue].outFeeUsd;
  sellUsdc(book, run, move, arrives);
  pushRound(book, run, move, { buy: 0, move: size, arrives });
}

function roundAcross(book: Book, run: Run, move: Move, size: number): void {
  const from = move.from as Venue;
  const to = move.to as Venue;
  const arrives = arrivesFor(from, to, size);
  run.venues[from] = shifted(run.venues[from], -size);
  run.venues[to] = shifted(run.venues[to], arrives);
  run.received[to] += arrives;
  run.costUsd += VENUE[from].outFeeUsd + VENUE[to].inFeeUsd;
  pushRound(book, run, move, { buy: 0, move: size, arrives });
}

const touchesUsdt = (move: { from: Pool; to: Pool }): boolean => move.from === 'CROSSEX' || move.to === 'CROSSEX';

export const priceOrOne = (price: number | null | undefined): number =>
  typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : 1;

function convertPrice(move: Move, ask: number, bid: number): number {
  if (move.from === 'CROSSEX') return 1 / ask;
  return move.to === 'CROSSEX' ? bid : bid / ask;
}

function convertRest(book: Book, run: Run, move: Move, left: number): void {
  if (touchesUsdt(move) && run.gateMovable * book.bid >= SPOT_MIN_QUOTE_USDT) sellUsdc(book, run, move, 0);
  const holding = move.from === 'CROSSEX' ? run.usdt : run.venues[move.from];
  const room = book.goal.kind === 'repay' ? Math.min(holding.cash, holding.equity) : holding.cash;
  const size = floorCents(Math.min(left, Math.max(0, room)));
  if (size <= 0) return;
  if (!touchesUsdt(move) && run.usdt.cash < -DUST_USDC) run.usdtShort = true;
  const kept = touchesUsdt(move) ? 1 - CONVERT_RATE : (1 - CONVERT_RATE) ** 2;
  const ask = priceOrOne(book.ask);
  const bid = priceOrOne(book.bid);
  const arrives = floorCents(size * kept * convertPrice(move, ask, bid));
  const fee = touchesUsdt(move) ? size * CONVERT_RATE : size - size * kept;
  shiftPool(run, move.from, -size);
  shiftPool(run, move.to, arrives);
  run.received[move.to] += arrives;
  run.costUsd += fee + size * kept * (1 - convertPrice(move, Math.max(1, ask), Math.min(1, bid)));
  run.steps.push({
    round: null,
    kind: 'convert',
    buy: 0,
    move: size,
    arrives,
    borrowLeft: borrowLeftOf(book, run, move.to),
    seconds: 0,
    from: move.from,
    to: move.to,
  });
}

function startRun(book: Book): Run {
  return {
    usdt: book.usdt,
    gate: book.gate,
    venues: { ...book.venues },
    gateMovable: book.gateMovable,
    received: { CROSSEX: 0, HYPERLIQUID: 0, LIGHTER: 0 },
    costUsd: 0,
    steps: [],
    cashLimited: false,
    usdtShort: false,
    beyondBook: false,
  };
}

function simulate(book: Book, moves: Move[], amounts: number[], maxRounds: number[], size: Sizer): Run {
  const run = startRun(book);
  moves.forEach((move, index) => {
    const round = move.from === 'CROSSEX' ? roundInto : move.to === 'CROSSEX' ? roundOut : roundAcross;
    const minimum = roundMinimum(move.from, move.to, book.minimum);
    const orderMax = orderMaxOf(book, move);
    let left = amounts[index];
    let rounds = 0;
    while (left > 0 && rounds < maxRounds[index]) {
      const room = fit(marginsOf(book, run), roundCash(book, run, move), sendingEquity(run, move));
      const next = size(Math.min(room, orderMax), left, minimum);
      if (next <= 0 || next < minimum) break;
      round(book, run, move, next);
      rounds += 1;
      left = floorCents(left - next);
    }
    if (left > 0) convertRest(book, run, move, left);
  });
  return run;
}

function targetOf(book: Book, run: Run, pool: Pool): number {
  if (book.goal.kind !== 'even') return book.targets[pool];
  const total = book.pools.reduce((sum, pool) => sum + floorCents(equityOf(run, pool)), 0);
  return total * book.shares[pool];
}

function stillShort(book: Book, run: Run, move: Move): boolean {
  const own = floorCents(equityOf(run, move.check));
  const target = targetOf(book, run, move.check);
  return move.check === move.to ? own < target : own > target;
}

function solve(book: Book, moves: Move[], start: number[], maxRounds: number[], size: Sizer): Run {
  const amounts = [...start];
  const limited = moves.map(() => false);
  for (let pass = 0; pass < moves.length; pass += 1) {
    moves.forEach((move, index) => {
      const attempt = (cents: number): Run => {
        amounts[index] = cents / 100;
        return simulate(book, moves, amounts, maxRounds, size);
      };
      let lo = 0;
      let hi = Math.round(floorCents(sendingCash(book, startRun(book), move)) * 100);
      limited[index] = stillShort(book, attempt(hi), move);
      if (limited[index]) return;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (stillShort(book, attempt(mid), move)) lo = mid;
        else hi = mid;
      }
      // `lo` is the last cent still short of the target, `hi` the first at or
      // past it. Even stops short so no pool overshoots its share. Repay must
      // clear the borrow, and a cent left over is still a borrow, so it takes
      // the first cent that does.
      amounts[index] = (book.goal.kind === 'repay' ? hi : lo) / 100;
    });
  }
  return { ...simulate(book, moves, amounts, maxRounds, size), cashLimited: limited.some(Boolean) };
}

function afterOf(book: Book, run: Run): WalletAfter[] {
  const wallet = (w: { coin: string; venue: string }, holding: Holding): WalletAfter => ({
    coin: w.coin,
    venue: w.venue,
    cash: floorCents(holding.cash),
    equity: floorCents(holding.equity),
  });
  const venues = VENUES.filter((venue) => book.pools.includes(venue) || book.buckets[venue] !== undefined);
  return [
    wallet(USDT_WALLET, run.usdt),
    ...venues.map((venue) => wallet(poolWallet(venue), run.venues[venue])),
    wallet(GATE_WALLET, run.gate),
  ];
}

function routePlan(book: Book, run: Run, reason: string | null): RoutePlan {
  const freed = POOLS.reduce(
    (total, pool) => {
      const repaid = repayment(book.buckets[pool], run.received[pool]);
      return {
        savesPerDayUsd: total.savesPerDayUsd + repaid.savesPerDayUsd,
        marginFreedUsd: total.marginFreedUsd + repaid.marginFreedUsd,
      };
    },
    { savesPerDayUsd: 0, marginFreedUsd: 0 },
  );
  return {
    available: reason === null,
    reason,
    costUsd: nearestCents(run.costUsd),
    seconds: run.steps.reduce((total, step) => total + step.seconds, 0),
    rounds: run.steps.filter((step) => step.kind === 'round').length,
    oneMoreRoundCostUsd: null,
    beyondBook: run.beyondBook,
    marginFreedUsd: nearestCents(freed.marginFreedUsd),
    savesPerDayUsd: nearestCents(freed.savesPerDayUsd),
    after: afterOf(book, run),
    steps: run.steps,
  };
}

const cheaper = (best: RoutePlan, next: RoutePlan): RoutePlan =>
  next.costUsd < best.costUsd || (next.costUsd === best.costUsd && next.seconds < best.seconds) ? next : best;

function blockedReason(inputs: PlanInputs, moves: Move[]): string | null {
  if (coinRule(inputs.coins, 'USDC')?.isDisabled) return PAUSED_REASON;
  if (!moves.some(touchesUsdt)) return null;
  if (inputs.spotRule?.state !== 'live') return CLOSED_REASON;
  if (positive(inputs.ask) === null || positive(inputs.bid) === null) return CLOSED_REASON;
  return null;
}

function recommend(routes: EvenPlan['routes']): RouteName | null {
  const open = (['mix', 'loop', 'convert'] as const).flatMap((name) => {
    const route = routes[name];
    return route?.available && route.seconds <= RECOMMENDED_MAX_SECONDS ? [{ name, route }] : [];
  });
  if (open.length === 0) return null;
  return open.reduce((best, next) => (cheaper(best.route, next.route) === next.route ? next : best)).name;
}

function loopReason(book: Book, moves: Move[], loopRun: Run): string | null {
  const stepsOf = (move: Move) => loopRun.steps.filter((step) => step.from === move.from && step.to === move.to);
  const onlyConverts = (move: Move) => stepsOf(move).length > 0 && stepsOf(move).every((step) => step.kind === 'convert');
  const roundsOf = (move: Move) => stepsOf(move).filter((step) => step.kind === 'round').length;
  // A move that used every round it may take and still had cash to Convert
  // is not the route the row names.
  if (moves.some((move) => roundsOf(move) >= LOOP_ROUND_CAP)) return LOOP_CAP_REASON;
  const move = loopRun.steps.some((step) => step.kind === 'round') ? moves.find(onlyConverts) : moves[0];
  if (!move) return null;
  const start = startRun(book);
  const cash = sendingCash(book, start, move);
  const minimum = roundMinimum(move.from, move.to, book.minimum);
  if (fit(marginsOf(book, start), cash, sendingEquity(start, move)) >= minimum) {
    return underMinimumReason(minimum);
  }
  if (cash < minimum) return NO_CASH_REASON;
  return NO_ROUND_REASON;
}

function splitOf(book: Book): WalletShare[] {
  return book.pools.map((pool) => ({
    ...poolWallet(pool),
    notionalUsd: nearestCents(book.notional[pool]),
    share: book.shares[pool],
  }));
}

const idleRoute = (book: Book): RoutePlan => ({ ...routePlan(book, startRun(book), null), available: false });

const targetRows = (book: Book): WalletTarget[] =>
  book.pools.map((pool) => ({ ...poolWallet(pool), equity: nearestCents(book.targets[pool]) }));

const balancedPlan = (book: Book, shortOfEven: number, noLegs: boolean): EvenPlan => ({
  goal: book.goal,
  balanced: true,
  noLegs,
  moves: 0,
  shortOfEven,
  roundCap: 0,
  split: splitOf(book),
  targets: targetRows(book),
  routes: { mix: null, loop: idleRoute(book), convert: idleRoute(book) },
  recommended: null,
});

const equityTargets = (wallets: Wallets, pools: Pool[]): Record<Pool, number> => ({
  CROSSEX: pools.includes('CROSSEX') ? equityOf(wallets, 'CROSSEX') : 0,
  HYPERLIQUID: pools.includes('HYPERLIQUID') ? equityOf(wallets, 'HYPERLIQUID') : 0,
  LIGHTER: pools.includes('LIGHTER') ? equityOf(wallets, 'LIGHTER') : 0,
});

/** Every negative pool to 0. The largest positive pool pays first, up to its
 * cash and its equity (see `sendingCash`); what it cannot cover moves to the
 * next. Debt past that stays, and the solve reports it as the short. */
function repayTargets(wallets: Wallets & { gateMovable: number }, pools: Pool[]): Record<Pool, number> {
  const targets = equityTargets(wallets, pools);
  let debt = 0;
  for (const pool of pools) {
    if (targets[pool] < 0) {
      debt += -targets[pool];
      targets[pool] = 0;
    }
  }
  const senders = pools.filter((pool) => targets[pool] > 0).sort((a, b) => targets[b] - targets[a]);
  for (const pool of senders) {
    if (debt <= 0) break;
    const gives = floorCents(Math.min(debt, sendableCash(wallets, pool), targets[pool]));
    targets[pool] -= gives;
    debt -= gives;
  }
  return targets;
}

function customTargets(wallets: Wallets, pools: Pool[], goal: Extract<Goal, { kind: 'custom' }>): Record<Pool, number> {
  const targets = equityTargets(wallets, pools);
  targets[goal.from] -= goal.amount;
  targets[goal.to] += goal.amount;
  return targets;
}

function movesFor(pools: Pool[], gaps: Record<Pool, number>): Move[] {
  const bySize = (a: Pool, b: Pool): number => Math.abs(gaps[b]) - Math.abs(gaps[a]);
  const senders = pools.filter((pool) => gaps[pool] <= -DUST_USDC).sort(bySize);
  const receivers = pools.filter((pool) => gaps[pool] >= DUST_USDC).sort(bySize);
  if (senders.length === 0 || receivers.length === 0) return [];
  if (senders.length === 1) return receivers.map((to) => ({ from: senders[0], to, check: to }));
  return senders.map((from) => ({ from, to: receivers[0], check: from }));
}

function roundBudgets(moves: Move[]): number[][] {
  const seconds = moves.map((move) => roundSeconds(move.from, move.to));
  const budgets: number[][] = [];
  const walk = (index: number, used: number, picked: number[]): void => {
    if (index === moves.length) {
      budgets.push(picked);
      return;
    }
    for (let rounds = 0; used + rounds * seconds[index] <= RECOMMENDED_MAX_SECONDS; rounds += 1) {
      walk(index + 1, used + rounds * seconds[index], [...picked, rounds]);
    }
  };
  walk(0, 0, []);
  return budgets;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

export function planFor(buckets: Bucket[], account: AccountLike, inputs: PlanInputs, goal: Goal = EVEN_GOAL): EvenPlan {
  const bucketOf = (wallet: { coin: string; venue: string }) => buckets.find(isWallet(wallet));
  const poolBuckets: Partial<Record<Pool, Bucket>> = {
    CROSSEX: bucketOf(USDT_WALLET),
    HYPERLIQUID: bucketOf(USDC_WALLET),
    LIGHTER: bucketOf(LIGHTER_WALLET),
  };
  const gateBucket = bucketOf(GATE_WALLET);
  const gateCash = gateBucket?.cash ?? 0;
  const ask = positive(inputs.ask) ?? 1;
  const bid = positive(inputs.bid) ?? 1;
  const ruleMax = finiteOrNull(inputs.spotRule?.maxMarketSize ?? '');
  const wallets: Wallets = {
    usdt: holdingOf(poolBuckets.CROSSEX),
    gate: holdingOf(gateBucket),
    venues: { HYPERLIQUID: holdingOf(poolBuckets.HYPERLIQUID), LIGHTER: holdingOf(poolBuckets.LIGHTER) },
  };
  const notionalOf = (pool: Pool): number => {
    const wallet = poolWallet(pool);
    const value = Number(inputs.notional[walletKey(wallet.coin, wallet.venue)] ?? 0);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  const notional = { CROSSEX: notionalOf('CROSSEX'), HYPERLIQUID: notionalOf('HYPERLIQUID'), LIGHTER: notionalOf('LIGHTER') };
  // A custom move may open an empty wallet, so its two ends are always pools.
  const touched = (pool: Pool): boolean => goal.kind === 'custom' && (goal.from === pool || goal.to === pool);
  const pools = POOLS.filter((pool) => notional[pool] > 0 || Math.abs(equityOf(wallets, pool)) >= DUST_USDC || touched(pool));
  const totalNotional = sum(pools.map((pool) => notional[pool]));
  const noLegs = totalNotional <= 0;
  const shareOf = (pool: Pool): number => (totalNotional > 0 && pools.includes(pool) ? notional[pool] / totalNotional : 0);
  const shares = { CROSSEX: shareOf('CROSSEX'), HYPERLIQUID: shareOf('HYPERLIQUID'), LIGHTER: shareOf('LIGHTER') };
  const gateMovable = gateCash >= DUST_USDC ? gateCash : 0;
  const equity = sum(pools.map((pool) => equityOf(wallets, pool)));
  const targets: Record<Pool, number> =
    goal.kind === 'repay'
      ? repayTargets({ ...wallets, gateMovable }, pools)
      : goal.kind === 'custom'
        ? customTargets(wallets, pools, goal)
        : { CROSSEX: equity * shares.CROSSEX, HYPERLIQUID: equity * shares.HYPERLIQUID, LIGHTER: equity * shares.LIGHTER };
  const book: Book = {
    ...wallets,
    gateMovable,
    buckets: poolBuckets,
    pools,
    notional,
    shares,
    goal,
    targets,
    marginBalance: num(account.marginBalance),
    initialMargin: num(account.initialMargin),
    ask,
    bid,
    asks: inputs.asks ?? [],
    bids: inputs.bids ?? [],
    takerRate: inputs.spotTakerRate,
    minimum: coinRule(inputs.coins, 'USDC')?.min ?? HYPERLIQUID_MIN_USDC,
    buyMax: spotOrderMax(ask, ruleMax),
    sellMax: spotOrderMax(Math.max(ask, bid), ruleMax),
  };

  if (goal.kind === 'even' && noLegs) return balancedPlan(book, 0, true);
  if (goal.kind === 'custom' && (goal.from === goal.to || !(goal.amount >= DUST_USDC))) return balancedPlan(book, 0, noLegs);

  const gapOf = (pool: Pool): number => (pools.includes(pool) ? targets[pool] - equityOf(wallets, pool) : 0);
  const gaps = { CROSSEX: gapOf('CROSSEX'), HYPERLIQUID: gapOf('HYPERLIQUID'), LIGHTER: gapOf('LIGHTER') };
  const moves = movesFor(pools, gaps);
  if (moves.length === 0) return balancedPlan(book, 0, noLegs);

  const start = moves.map((move) => floorCents(Math.abs(gaps[move.check])));
  const need = sum(moves.map((move) => Math.abs(gaps[move.check])));
  // A custom amount is sent as given, not searched for: the run moves it, or
  // as much of it as cash allows, and the rest is the short.
  const run = (maxRounds: number[], size: Sizer): Run => {
    if (goal.kind !== 'custom') return solve(book, moves, start, maxRounds, size);
    const fixed = simulate(book, moves, start, maxRounds, size);
    const moved = floorCents(sum(fixed.steps.map((step) => step.move)));
    return { ...fixed, cashLimited: floorCents(start[0] - moved) >= DUST_USDC };
  };
  const blocked = blockedReason(inputs, moves);
  const budgets = roundBudgets(moves);
  const roundCap = Math.max(...budgets.map(sum));
  const mixRuns = budgets.map((budget) => run(budget, fillCap));
  const shortReason = (run: Run): string | null => (run.usdtShort ? USDT_SHORT_REASON : null);
  const mixPlans = mixRuns.map((run) => routePlan(book, run, blocked ?? shortReason(run)));
  const openMixes = mixPlans.filter((plan) => plan.available);
  const closedLoops = mixPlans.filter((plan) => plan.rounds > 0 && plan.steps.some((step) => step.kind === 'convert'));
  const bestMix = (openMixes.length > 0 ? openMixes : closedLoops.length > 0 ? closedLoops : mixPlans).reduce(cheaper);
  const mixConverts = bestMix.steps.some((step) => step.kind === 'convert');
  const oneMore = moves.length === 1 && bestMix.rounds < roundCap ? mixPlans[bestMix.rounds + 1].costUsd : null;
  const mix = { ...bestMix, oneMoreRoundCostUsd: oneMore };

  // The pure Spot loop runs to completion, however many rounds that takes
  // (his call 2026-09-19): the trader sees its time beside its fee and picks.
  // The cap only guards against a round that never shrinks the remainder.
  const loopRounds = moves.map(() => LOOP_ROUND_CAP);
  const loopRun = run(loopRounds, leaveMinimum);
  const loop = routePlan(book, loopRun, blocked ?? shortReason(loopRun) ?? loopReason(book, moves, loopRun));
  const convert = routePlan(book, mixRuns[0], shortReason(mixRuns[0]));

  // All three routes are offered. The mix drops out only when it is one of
  // the others in disguise: no rounds is Convert, no Convert is the loop.
  const routes = {
    mix: bestMix.rounds > 0 && mixConverts ? mix : null,
    loop,
    convert,
  };
  const runs: Record<RouteName, Run> = { mix: mixRuns[mixPlans.indexOf(bestMix)], loop: loopRun, convert: mixRuns[0] };
  const recommended = recommend(routes);
  const firstOpen = (['mix', 'loop', 'convert'] as const).find((name) => routes[name]?.available);
  const picked = runs[recommended ?? firstOpen ?? 'convert'];
  const moved = floorCents(sum(picked.steps.map((step) => step.move)));
  if (moved < DUST_USDC) return balancedPlan(book, picked.cashLimited ? floorCents(need) : 0, noLegs);
  return {
    goal,
    balanced: false,
    noLegs,
    moves: moved,
    shortOfEven: picked.cashLimited ? floorCents(Math.max(0, need - moved)) : 0,
    roundCap,
    split: splitOf(book),
    targets: targetRows(book),
    routes,
    recommended,
  };
}

export function pathRule(coin: string, from: string, to: string): PathRule | null {
  const rule = PATHS.find((path) => path.coin === coin && path.from === from && path.to === to);
  return rule ? { ...rule } : null;
}

function pathMax(path: PathRule, account: AccountLike, spot: SpotBalance[] | null): number | null {
  if (path.from !== 'SPOT') {
    const marginBalance = finiteOrNull(account.marginBalance);
    const initialMargin = finiteOrNull(account.initialMargin);
    if (marginBalance === null || initialMargin === null) return 0;
    const asset = (account.assets ?? []).find(isWallet({ coin: path.coin, venue: CROSSEX_VENUE[path.from] }));
    const cash = Number(floorDecimalString(asset?.balance, String(MIN_TRANSFER)));
    return fit({ marginBalance, initialMargin }, cash, num(asset?.equity));
  }
  if (spot === null) return null;
  return floorCents(Math.max(0, spot.find((row) => row.coin === path.coin)?.available ?? 0));
}

function pathMin(path: PathRule, coins: CoinRuleLike[]): number {
  const touchesVenueWallet = VENUE_WALLETS.includes(path.from) || VENUE_WALLETS.includes(path.to);
  if (path.coin === 'USDC' && !touchesVenueWallet) return path.min;
  return Math.max(MIN_TRANSFER, coinRule(coins, path.coin)?.min ?? path.min);
}

function pathFee(path: PathRule, coins: CoinRuleLike[]): number {
  if (path.from !== 'CROSSEX_HYPERLIQUID') return path.feeUsd;
  return coinRule(coins, path.coin)?.fee ?? path.feeUsd;
}

export function transferPaths(input: {
  account: AccountLike;
  spot: SpotBalance[] | null;
  coins: CoinRuleLike[];
}): TransferPath[] {
  return PATHS.map((path) => ({
    ...path,
    max: pathMax(path, input.account, input.spot),
    min: pathMin(path, input.coins),
    feeUsd: pathFee(path, input.coins),
  }));
}
