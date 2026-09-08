import { roundToStep } from '../numbers';

/** The two wallets a rebalance moves cash between. Either can go negative:
 * Gate lends the coin, holds margin against it, and past the interest-free
 * line charges interest on it. Verified for both on 2026-09-08: Gate's rate
 * list carries USDT/CROSSEX and USDC/HYPERLIQUID. */
export const USDC_WALLET = { coin: 'USDC', venue: 'HYPERLIQUID' } as const;
export const USDT_WALLET = { coin: 'USDT', venue: 'CROSSEX' } as const;
export type Wallet = typeof USDC_WALLET | typeof USDT_WALLET;
export const SPOT_SYMBOL = 'GATE_SPOT_USDC_USDT';
/** Gate charges interest on a borrow only once the wallet's equity is below
 * this. Checked live for USDC on Hyperliquid; assumed the same for USDT. */
const INTEREST_THRESHOLD = -10000;
export const LOOP_WAIT_SECONDS = 150;
export const PULL_WAIT_SECONDS = 400;
const CONVERT_RATE = 0.002;
const DEPOSIT_FEE_USD = 0.05;
export const PULL_FEE_USD = 1;

export type Direction = 'payDown' | 'pull';

/** Where the cash lands. A move repays that wallet's borrow first. */
export const TARGET: Record<Direction, Wallet> = { payDown: USDC_WALLET, pull: USDT_WALLET };

/** `USDC/HYPERLIQUID`: the key the interest ledger and the buckets share. */
export const walletKey = (coin: string, venue: string): string => `${coin}/${venue}`;

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

export interface RouteQuote {
  costUsd: number;
  waitSeconds: number;
  available: boolean;
  reason: string | null;
}

export interface Plan {
  direction: Direction;
  amount: number;
  receives: number;
  price: number | null;
  borrowAfterUsd: number;
  /** Why less than the borrow can move: `cash` when profit is not yet cash,
   * `margin` when Gate's available margin caps it, `spare` when the other
   * wallet simply holds less than the borrow. */
  shortfall: { reason: 'cash' | 'margin' | 'spare'; remaining: number } | null;
  routes: { loop: RouteQuote; convert: RouteQuote };
  route: 'loop' | 'convert' | null;
  savesPerDayUsd: number;
  marginFreedUsd: number;
}

export interface PlanInputs {
  usdcTransfer: { isDisabled: number; minTransAmount: number } | null;
  spotRule: { state: string } | null;
  spotTakerRate: number;
  ask: number | null;
  bid: number | null;
}

export interface PlanRequest {
  direction?: Direction;
  requested?: number;
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function floorCents(value: number): number {
  return Number(roundToStep(value, '0.01', 'down'));
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
      interestPerDayUsd: equity < INTEREST_THRESHOLD ? borrow * hourly * 24 : 0,
    };
  });
}

function convertQuote(amount: number): RouteQuote {
  return {
    costUsd: amount * CONVERT_RATE,
    waitSeconds: 0,
    available: amount > 0,
    reason: amount > 0 ? null : 'nothing to move',
  };
}

function pickRoute(loop: RouteQuote, convert: RouteQuote): Plan['route'] {
  if (loop.available && convert.available) return loop.costUsd < convert.costUsd ? 'loop' : 'convert';
  if (loop.available) return 'loop';
  return convert.available ? 'convert' : null;
}

function loopQuote(
  amount: number,
  inputs: PlanInputs,
  price: number | null,
  spread: number,
  feeUsd: number,
  waitSeconds: number,
  belowMinimum: (min: number) => string | null,
): RouteQuote {
  let reason: string | null = null;
  if (!(amount > 0)) {
    reason = 'nothing to move';
  } else if (!inputs.usdcTransfer || inputs.usdcTransfer.isDisabled === 1) {
    reason = 'Gate has paused USDC transfers on CrossEx. Try again later.';
  } else if (!inputs.spotRule || inputs.spotRule.state !== 'live') {
    reason = 'The USDC/USDT spot market on Gate is not trading right now.';
  } else if (price === null) {
    reason = 'No price for USDC/USDT on Gate spot right now.';
  } else {
    reason = belowMinimum(inputs.usdcTransfer.minTransAmount);
  }
  return {
    costUsd: amount * spread + amount * inputs.spotTakerRate + feeUsd,
    waitSeconds,
    available: reason === null,
    reason,
  };
}

/** What `receives` landing in a wallet changes. Interest runs on the whole
 * borrow only past the threshold, so a repayment that crosses it stops the
 * whole charge, not its share. What lands repays, not what is sent. */
function repayment(
  bucket: Bucket | undefined,
  receives: number,
): Pick<Plan, 'borrowAfterUsd' | 'savesPerDayUsd' | 'marginFreedUsd'> {
  const deficit = Math.max(0, -(bucket?.equity ?? 0));
  const borrowAfterUsd = Math.max(0, deficit - receives);
  if (!bucket || bucket.borrow <= 0) return { borrowAfterUsd, savesPerDayUsd: 0, marginFreedUsd: 0 };
  const repaid = Math.min(receives, bucket.borrow);
  const chargedAfter =
    bucket.equity + receives < INTEREST_THRESHOLD
      ? (bucket.interestPerDayUsd * (bucket.borrow - repaid)) / bucket.borrow
      : 0;
  return {
    borrowAfterUsd,
    savesPerDayUsd: Math.max(0, bucket.interestPerDayUsd - chargedAfter),
    marginFreedUsd: (repaid * bucket.imHeldUsd) / bucket.borrow,
  };
}

const isWallet = (w: Wallet) => (b: { coin?: string; venue?: string; exchangeType?: string }) =>
  b.coin === w.coin && (b.venue ?? b.exchangeType) === w.venue;

export function planFor(
  buckets: Bucket[],
  account: AccountLike,
  inputs: PlanInputs,
  { direction = 'payDown', requested = Infinity }: PlanRequest = {},
): Plan {
  const usdcBucket = buckets.find(isWallet(USDC_WALLET));
  const usdtBucket = buckets.find(isWallet(USDT_WALLET));

  if (direction === 'pull') {
    // USDC → USDT. The USDC that can leave is what the wallet owns after open
    // losses, so a pull never opens a USDC borrow. With a USDT borrow the
    // prefilled amount repays it and no more; a typed amount may bring any
    // of the spare home, borrow or not.
    const usdcAsset = (account.assets ?? []).find(isWallet(USDC_WALLET));
    const equity = usdcBucket?.equity ?? 0;
    const available = num(usdcAsset?.availableBalance);
    const spare = equity > 0 ? Math.max(0, floorCents(Math.min(available, equity))) : 0;
    const deficit = Math.max(0, -(usdtBucket?.equity ?? 0));
    const wanted = requested === Infinity && deficit > 0 ? deficit : requested;
    const amount = Math.max(0, floorCents(Math.min(wanted, spare)));
    const shortfall: Plan['shortfall'] =
      deficit === 0 || deficit <= spare
        ? null
        : { reason: available < equity ? 'cash' : 'spare', remaining: floorCents(deficit - amount) };
    const bid = positive(inputs.bid);
    const lands = Math.max(0, floorCents(amount - PULL_FEE_USD));
    const loop = loopQuote(
      amount,
      inputs,
      bid,
      bid === null ? 0 : Math.max(1 - bid, 0),
      PULL_FEE_USD,
      PULL_WAIT_SECONDS,
      (min) =>
        lands < min
          ? `Too small to pull. Gate takes a flat $${PULL_FEE_USD} fee on the way out and needs at least ${min} USDC to arrive. Pull at least ${min + PULL_FEE_USD} USDC.`
          : null,
    );
    const convert = convertQuote(amount);
    const route = pickRoute(loop, convert);
    const receives =
      route === 'loop' && bid !== null
        ? Math.max(0, floorCents(lands * bid * (1 - inputs.spotTakerRate)))
        : route === 'convert'
          ? floorCents(amount * (1 - CONVERT_RATE))
          : 0;
    return {
      direction,
      amount,
      receives,
      price: route === 'loop' ? bid : route === 'convert' ? 1 - CONVERT_RATE : null,
      shortfall,
      routes: { loop, convert },
      route,
      ...repayment(usdtBucket, receives),
    };
  }

  // USDT → USDC. Capped at the USDC borrow: the wallet exists to serve the
  // Hyperliquid legs, and cash parked there earns nothing.
  const deficit = Math.max(0, -(usdcBucket?.equity ?? 0));
  const surplusCash = usdtBucket?.cash ?? 0;
  const availableMargin = num(account.availableMargin);
  const amount = Math.max(0, floorCents(Math.min(requested, deficit, surplusCash, availableMargin)));

  const shortfall: Plan['shortfall'] =
    deficit === 0 || (deficit <= surplusCash && deficit <= availableMargin)
      ? null
      : { reason: surplusCash <= availableMargin ? 'cash' : 'margin', remaining: floorCents(deficit - amount) };

  const convert = convertQuote(amount);

  const ask = positive(inputs.ask);
  const bought = ask === null ? 0 : floorCents(amount / ask);
  const loop = loopQuote(
    amount,
    inputs,
    ask,
    ask === null ? 0 : Math.max(ask - 1, 0),
    DEPOSIT_FEE_USD,
    LOOP_WAIT_SECONDS,
    (min) => (bought < min ? `Too small for the spot loop. Gate needs at least ${min} USDC per transfer.` : null),
  );

  const route = pickRoute(loop, convert);

  const receives =
    route === 'loop'
      ? Math.max(0, floorCents(bought - amount * inputs.spotTakerRate - DEPOSIT_FEE_USD))
      : route === 'convert'
        ? floorCents(amount * (1 - CONVERT_RATE))
        : 0;
  const price = route === 'loop' ? ask : route === 'convert' ? 1 - CONVERT_RATE : null;

  return {
    direction,
    amount,
    receives,
    price,
    shortfall,
    routes: { loop, convert },
    route,
    ...repayment(usdcBucket, receives),
  };
}
