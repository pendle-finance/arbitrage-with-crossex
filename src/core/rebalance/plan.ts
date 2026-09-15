import { roundToStep } from '../numbers';

export const USDC_WALLET = { coin: 'USDC', venue: 'HYPERLIQUID' } as const;
export const USDT_WALLET = { coin: 'USDT', venue: 'CROSSEX' } as const;
export type Wallet = typeof USDC_WALLET | typeof USDT_WALLET;
export const SPOT_SYMBOL = 'GATE_SPOT_USDC_USDT';
export const SPOT_PAIR = 'USDC_USDT';
const HYPERLIQUID_FREE_BORROW_USDC = 10000;
export const TO_USDC_WAIT_SECONDS = 130;
export const TO_USDT_WAIT_SECONDS = 400;
export const CONVERT_RATE = 0.002;
export const HYPERLIQUID_DEPOSIT_FEE_USD = 0.05;
export const HYPERLIQUID_WITHDRAW_FEE_USD = 1;
export const HYPERLIQUID_MIN_USDC = 11;
const APP_FLOOR = 1.12;
const BORROW_INITIAL_MARGIN = 0.2;
export const MIN_TRANSFER = 0.00001;
export const SPOT_MIN_QUOTE_USDT = 3;
const RECOMMENDED_MAX_SECONDS = 900;
export const DUST_USDC = 1;

export type Direction = 'toUsdc' | 'toUsdt';

const ROUND_CAP: Record<Direction, number> = { toUsdc: 6, toUsdt: 2 };

/** Where the cash lands. A move repays that wallet's borrow first. */
export const TARGET: Record<Direction, Wallet> = { toUsdc: USDC_WALLET, toUsdt: USDT_WALLET };

/** `USDC/HYPERLIQUID`: the key the interest ledger and the buckets share. */
export const walletKey = (coin: string, venue: string): string => `${coin}/${venue}`;

export const GATE_WALLET = { coin: 'USDC', venue: 'GATE' } as const;

const PAUSED_REASON = 'Gate paused USDC transfers.';
const CLOSED_REASON = 'The spot market for USDC is closed.';
const NO_ROUND_REASON = 'Free margin is too low for an 11 USDC round.';
const NO_CASH_REASON = 'Not enough cash for an 11 USDC round.';
const underMinimumReason = (minimum: number): string => `The move is under the ${minimum} USDC minimum.`;

export type GateAccount = 'SPOT' | 'CROSSEX' | 'CROSSEX_GATE' | 'CROSSEX_HYPERLIQUID';
export type TransferCoin = 'USDT' | 'USDC';
export type RouteName = 'mix' | 'loop' | 'convert';

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

export interface PlannedStep {
  round: number | null;
  kind: 'round' | 'convert';
  buy: number;
  move: number;
  arrives: number;
  borrowLeft: number;
  seconds: number;
}

export interface RoutePlan {
  available: boolean;
  reason: string | null;
  costUsd: number;
  seconds: number;
  rounds: number;
  oneMoreRoundCostUsd: number | null;
  marginFreedUsd: number;
  savesPerDayUsd: number;
  after: WalletAfter[];
  steps: PlannedStep[];
}

export interface EvenPlan {
  direction: Direction | null;
  balanced: boolean;
  moves: number;
  shortOfEven: number;
  roundCap: number;
  routes: { mix: RoutePlan | null; loop: RoutePlan; convert: RoutePlan };
  recommended: RouteName | null;
}

export interface PlanInputs {
  coins: CoinRuleLike[];
  spotRule: { state: string } | null;
  spotTakerRate: number;
  ask: number | null;
  bid: number | null;
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
];

const CROSSEX_VENUE: Record<Exclude<GateAccount, 'SPOT'>, string> = {
  CROSSEX: USDT_WALLET.venue,
  CROSSEX_GATE: GATE_WALLET.venue,
  CROSSEX_HYPERLIQUID: USDC_WALLET.venue,
};

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
  return floorCents(Math.max(0, Math.min(cash, room)));
}

export function arrivesFor(direction: Direction, move: number): number {
  const fee = direction === 'toUsdc' ? HYPERLIQUID_DEPOSIT_FEE_USD : HYPERLIQUID_WITHDRAW_FEE_USD;
  return floorCents(move - fee);
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

interface Book {
  direction: Direction;
  usdt: Holding;
  usdc: Holding;
  gate: Holding;
  gateMovable: number;
  marginBalance: number;
  initialMargin: number;
  receiving: Bucket | undefined;
  ask: number;
  bid: number;
  takerRate: number;
  minimum: number;
}

interface Run {
  usdt: Holding;
  usdc: Holding;
  gate: Holding;
  gateMovable: number;
  received: number;
  costUsd: number;
  steps: PlannedStep[];
  cashLimited: boolean;
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

function sendingCash(book: Book, run: Run): number {
  if (book.direction === 'toUsdt') return Math.max(0, run.usdc.cash);
  return Math.max(0, run.usdt.cash) + run.gateMovable;
}

function sendingEquity(book: Book, run: Run): number {
  if (book.direction === 'toUsdt') return run.usdc.equity;
  return Math.max(0, run.usdt.equity) + run.gateMovable;
}

const borrowOf = (holding: Holding): number => Math.max(0, -holding.equity);

function marginsOf(book: Book, run: Run): { marginBalance: number; initialMargin: number } {
  const moved =
    run.usdt.equity - book.usdt.equity + (run.usdc.equity - book.usdc.equity) + (run.gate.equity - book.gate.equity);
  const borrowed =
    Math.max(0, borrowOf(run.usdt) - borrowOf(book.usdt)) + Math.max(0, borrowOf(run.usdc) - borrowOf(book.usdc));
  return {
    marginBalance: book.marginBalance + moved,
    initialMargin:
      book.initialMargin -
      repayment(book.receiving, run.received).marginFreedUsd +
      borrowed * BORROW_INITIAL_MARGIN,
  };
}

const borrowLeftOf = (book: Book, run: Run): number =>
  floorCents(Math.max(0, (book.receiving?.borrow ?? 0) - run.received));

function roundToUsdc(book: Book, run: Run, move: number): void {
  const fromGate = Math.min(run.gateMovable, move);
  const buy = floorCents(move - fromGate);
  const arrives = arrivesFor('toUsdc', move);
  run.usdt = shifted(run.usdt, -buy * book.ask * (1 + book.takerRate));
  run.gate = shifted(run.gate, -fromGate);
  run.gateMovable -= fromGate;
  run.usdc = shifted(run.usdc, arrives);
  run.received += arrives;
  run.costUsd += HYPERLIQUID_DEPOSIT_FEE_USD + buy * Math.max(0, book.ask - 1) + buy * book.ask * book.takerRate;
  run.steps.push({
    round: run.steps.length + 1,
    kind: 'round',
    buy,
    move,
    arrives,
    borrowLeft: borrowLeftOf(book, run),
    seconds: TO_USDC_WAIT_SECONDS,
  });
}

function sellUsdc(book: Book, run: Run, arrived: number): void {
  const sold = arrived + run.gateMovable;
  const gained = sold * book.bid * (1 - book.takerRate);
  run.usdt = shifted(run.usdt, gained);
  run.gate = shifted(run.gate, -run.gateMovable);
  run.gateMovable = 0;
  if (book.direction === 'toUsdt') run.received += gained;
  run.costUsd += sold * Math.max(0, 1 - book.bid) + sold * book.bid * book.takerRate;
}

function roundToUsdt(book: Book, run: Run, move: number): void {
  const arrives = arrivesFor('toUsdt', move);
  run.usdc = shifted(run.usdc, -move);
  run.costUsd += HYPERLIQUID_WITHDRAW_FEE_USD;
  sellUsdc(book, run, arrives);
  run.steps.push({
    round: run.steps.length + 1,
    kind: 'round',
    buy: 0,
    move,
    arrives,
    borrowLeft: borrowLeftOf(book, run),
    seconds: TO_USDT_WAIT_SECONDS,
  });
}

function convertRest(book: Book, run: Run, left: number): void {
  const toUsdc = book.direction === 'toUsdc';
  if (run.gateMovable * book.bid >= SPOT_MIN_QUOTE_USDT) sellUsdc(book, run, 0);
  const move = floorCents(Math.min(left, Math.max(0, toUsdc ? run.usdt.cash : run.usdc.cash)));
  if (move <= 0) return;
  const arrives = floorCents(move * (1 - CONVERT_RATE));
  run.usdt = shifted(run.usdt, toUsdc ? -move : arrives);
  run.usdc = shifted(run.usdc, toUsdc ? arrives : -move);
  run.received += arrives;
  run.costUsd += move * CONVERT_RATE;
  run.steps.push({ round: null, kind: 'convert', buy: 0, move, arrives, borrowLeft: borrowLeftOf(book, run), seconds: 0 });
}

function startRun(book: Book): Run {
  return {
    usdt: book.usdt,
    usdc: book.usdc,
    gate: book.gate,
    gateMovable: book.gateMovable,
    received: 0,
    costUsd: 0,
    steps: [],
    cashLimited: false,
  };
}

function simulate(book: Book, amount: number, maxRounds: number, size: Sizer): Run {
  const run = startRun(book);
  const round = book.direction === 'toUsdc' ? roundToUsdc : roundToUsdt;
  let left = amount;
  while (left > 0 && run.steps.length < maxRounds) {
    const move = size(fit(marginsOf(book, run), sendingCash(book, run), sendingEquity(book, run)), left, book.minimum);
    if (move <= 0 || move < book.minimum) break;
    round(book, run, move);
    left = floorCents(left - move);
  }
  if (left > 0) convertRest(book, run, left);
  return run;
}

function stillShort(book: Book, run: Run): boolean {
  const usdtSide = floorCents(run.usdt.equity + run.gate.cash);
  const usdcSide = floorCents(run.usdc.equity);
  return book.direction === 'toUsdc' ? usdcSide < usdtSide : usdtSide < usdcSide;
}

function solve(book: Book, maxRounds: number, size: Sizer): Run {
  const attempt = (cents: number): Run => simulate(book, cents / 100, maxRounds, size);
  let lo = 0;
  let hi = Math.round(floorCents(sendingCash(book, startRun(book))) * 100);
  const all = attempt(hi);
  if (stillShort(book, all)) return { ...all, cashLimited: true };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (stillShort(book, attempt(mid))) lo = mid;
    else hi = mid;
  }
  return attempt(lo);
}

function afterOf(run: Pick<Run, 'usdt' | 'usdc' | 'gate'>): WalletAfter[] {
  const wallet = (w: { coin: string; venue: string }, holding: Holding): WalletAfter => ({
    coin: w.coin,
    venue: w.venue,
    cash: floorCents(holding.cash),
    equity: floorCents(holding.equity),
  });
  return [wallet(USDT_WALLET, run.usdt), wallet(USDC_WALLET, run.usdc), wallet(GATE_WALLET, run.gate)];
}

function routePlan(book: Book, run: Run, reason: string | null): RoutePlan {
  const freed = repayment(book.receiving, run.received);
  return {
    available: reason === null,
    reason,
    costUsd: nearestCents(run.costUsd),
    seconds: run.steps.reduce((total, step) => total + step.seconds, 0),
    rounds: run.steps.filter((step) => step.kind === 'round').length,
    oneMoreRoundCostUsd: null,
    marginFreedUsd: nearestCents(freed.marginFreedUsd),
    savesPerDayUsd: nearestCents(freed.savesPerDayUsd),
    after: afterOf(run),
    steps: run.steps,
  };
}

const cheaper = (best: RoutePlan, next: RoutePlan): RoutePlan =>
  next.costUsd < best.costUsd || (next.costUsd === best.costUsd && next.seconds < best.seconds) ? next : best;

function blockedReason(inputs: PlanInputs): string | null {
  if (coinRule(inputs.coins, 'USDC')?.isDisabled) return PAUSED_REASON;
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

function loopReason(book: Book, loopRun: Run): string | null {
  if (loopRun.steps.some((step) => step.kind === 'round')) return null;
  const start = startRun(book);
  const cash = sendingCash(book, start);
  if (fit(marginsOf(book, start), cash, sendingEquity(book, start)) >= book.minimum) {
    return underMinimumReason(book.minimum);
  }
  if (cash < book.minimum) return NO_CASH_REASON;
  return NO_ROUND_REASON;
}

const idleRoute = (book: Book): RoutePlan => ({ ...routePlan(book, startRun(book), null), available: false });

const balancedPlan = (book: Book, direction: Direction | null, shortOfEven: number): EvenPlan => ({
  direction,
  balanced: true,
  moves: 0,
  shortOfEven,
  roundCap: 0,
  routes: { mix: null, loop: idleRoute(book), convert: idleRoute(book) },
  recommended: null,
});

export function planFor(buckets: Bucket[], account: AccountLike, inputs: PlanInputs): EvenPlan {
  const usdtBucket = buckets.find(isWallet(USDT_WALLET));
  const usdcBucket = buckets.find(isWallet(USDC_WALLET));
  const gateBucket = buckets.find(isWallet(GATE_WALLET));
  const usdtSide = (usdtBucket?.equity ?? 0) + (gateBucket?.cash ?? 0);
  const usdcSide = usdcBucket?.equity ?? 0;
  const direction: Direction = usdtSide > usdcSide ? 'toUsdc' : 'toUsdt';
  const halfGap = Math.abs(usdtSide - usdcSide) / 2;
  const gateCash = gateBucket?.cash ?? 0;
  const book: Book = {
    direction,
    usdt: holdingOf(usdtBucket),
    usdc: holdingOf(usdcBucket),
    gate: holdingOf(gateBucket),
    gateMovable: gateCash >= DUST_USDC ? gateCash : 0,
    marginBalance: num(account.marginBalance),
    initialMargin: num(account.initialMargin),
    receiving: buckets.find(isWallet(TARGET[direction])),
    ask: positive(inputs.ask) ?? 1,
    bid: positive(inputs.bid) ?? 1,
    takerRate: inputs.spotTakerRate,
    minimum: coinRule(inputs.coins, 'USDC')?.min ?? HYPERLIQUID_MIN_USDC,
  };

  if (halfGap < 1) return balancedPlan(book, null, 0);

  const blocked = blockedReason(inputs);
  const roundCap = ROUND_CAP[direction];
  const mixRuns = Array.from({ length: roundCap + 1 }, (_, rounds) => solve(book, rounds, fillCap));
  const mixPlans = mixRuns.map((run) => routePlan(book, run, blocked));
  const bestMix = mixPlans.reduce(cheaper);
  const mixConverts = bestMix.steps.some((step) => step.kind === 'convert');
  const mix =
    bestMix.rounds === 0 || !mixConverts
      ? null
      : {
          ...bestMix,
          oneMoreRoundCostUsd: bestMix.rounds < roundCap ? mixPlans[bestMix.rounds + 1].costUsd : null,
        };

  const loopRun = solve(book, Infinity, leaveMinimum);
  const loop = routePlan(book, loopRun, blocked ?? loopReason(book, loopRun));
  const convert = routePlan(book, mixRuns[0], null);

  const routes = { mix, loop, convert };
  const runs: Record<RouteName, Run> = { mix: mixRuns[mixPlans.indexOf(bestMix)], loop: loopRun, convert: mixRuns[0] };
  const recommended = recommend(routes);
  const picked = recommended ? runs[recommended] : null;
  const moves = floorCents((picked?.steps ?? []).reduce((total, step) => total + step.move, 0));
  if (moves < DUST_USDC) return balancedPlan(book, direction, picked?.cashLimited ? floorCents(halfGap) : 0);
  return {
    direction,
    balanced: false,
    moves,
    shortOfEven: picked?.cashLimited ? floorCents(Math.max(0, halfGap - moves)) : 0,
    roundCap,
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
    return fit({ marginBalance, initialMargin }, num(asset?.balance), num(asset?.equity));
  }
  if (spot === null) return null;
  return floorCents(Math.max(0, spot.find((row) => row.coin === path.coin)?.available ?? 0));
}

function pathMin(path: PathRule, coins: CoinRuleLike[]): number {
  const touchesHyperliquid = path.from === 'CROSSEX_HYPERLIQUID' || path.to === 'CROSSEX_HYPERLIQUID';
  if (path.coin === 'USDC' && !touchesHyperliquid) return path.min;
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
