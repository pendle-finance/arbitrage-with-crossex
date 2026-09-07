import { roundToStep } from '../numbers';

export const DEFICIT = { coin: 'USDC', venue: 'HYPERLIQUID' } as const;
export const SURPLUS = { coin: 'USDT', venue: 'CROSSEX' } as const;
export const SPOT_SYMBOL = 'GATE_SPOT_USDC_USDT';
const INTEREST_THRESHOLD = -10000;
export const LOOP_WAIT_SECONDS = 150;
export const PULL_WAIT_SECONDS = 400;
const CONVERT_RATE = 0.002;
const DEPOSIT_FEE_USD = 0.05;
export const PULL_FEE_USD = 1;

export type Direction = 'payDown' | 'pull';

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

export interface InterestRowLike {
  liabilityCoin: string;
  exchangeType: string;
  interest: string;
}

export interface Bucket {
  coin: string;
  venue: string;
  cash: number;
  upnl: number;
  equity: number;
  borrow: number;
  imHeldUsd: number;
  mmHeldUsd: number;
  interestPaid30dUsd: number;
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
  shortfall: { reason: 'cash' | 'margin'; remaining: number } | null;
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

export function bucketsFrom(account: AccountLike, rates: RateLike[], interestRows: InterestRowLike[]): Bucket[] {
  return (account.assets ?? []).map((asset) => {
    const coin = asset.coin ?? '';
    const venue = asset.exchangeType ?? '';
    const equity = num(asset.equity);
    const borrow = num(asset.liability);
    const rate = rates.find((r) => r.coin === coin && r.exchangeType === venue);
    const hourly = rate ? num(rate.hourInterestRate) : 0;
    const interestPaid30dUsd = interestRows
      .filter((r) => r.liabilityCoin === coin && r.exchangeType === venue)
      .reduce((sum, r) => sum + num(r.interest), 0);
    return {
      coin,
      venue,
      cash: num(asset.balance),
      upnl: num(asset.upnl),
      equity,
      borrow,
      imHeldUsd: num(asset.borrowingInitialMargin),
      mmHeldUsd: num(asset.borrowingMaintenanceMargin),
      interestPaid30dUsd,
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

export function planFor(
  buckets: Bucket[],
  account: AccountLike,
  inputs: PlanInputs,
  { direction = 'payDown', requested = Infinity }: PlanRequest = {},
): Plan {
  const usdcBucket = buckets.find((b) => b.coin === DEFICIT.coin && b.venue === DEFICIT.venue);
  const deficit = Math.max(0, -(usdcBucket?.equity ?? 0));

  if (direction === 'pull') {
    const usdcAsset = (account.assets ?? []).find((a) => a.coin === DEFICIT.coin && a.exchangeType === DEFICIT.venue);
    const equity = usdcBucket?.equity ?? 0;
    const amount = equity > 0 ? Math.max(0, floorCents(Math.min(requested, num(usdcAsset?.availableBalance), equity))) : 0;
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
      borrowAfterUsd: deficit,
      shortfall: null,
      routes: { loop, convert },
      route,
      savesPerDayUsd: 0,
      marginFreedUsd: 0,
    };
  }

  const surplusBucket = buckets.find((b) => b.coin === SURPLUS.coin && b.venue === SURPLUS.venue);
  const surplusCash = surplusBucket?.cash ?? 0;
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

  const savesPerDayUsd =
    usdcBucket && usdcBucket.borrow > 0 ? (usdcBucket.interestPerDayUsd * amount) / usdcBucket.borrow : 0;
  const marginFreedUsd = usdcBucket && usdcBucket.borrow > 0 ? (amount * usdcBucket.imHeldUsd) / usdcBucket.borrow : 0;

  return {
    direction,
    amount,
    receives,
    price,
    borrowAfterUsd: Math.max(0, deficit - receives),
    shortfall,
    routes: { loop, convert },
    route,
    savesPerDayUsd,
    marginFreedUsd,
  };
}
