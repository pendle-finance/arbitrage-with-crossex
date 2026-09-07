import { roundToStep } from '../numbers';

export const DEFICIT = { coin: 'USDC', venue: 'HYPERLIQUID' } as const;
export const SURPLUS = { coin: 'USDT', venue: 'CROSSEX' } as const;
export const SPOT_SYMBOL = 'GATE_SPOT_USDC_USDT';
export const INTEREST_THRESHOLD = -10000;
export const LOOP_WAIT_SECONDS = 150;
export const CONVERT_RATE = 0.002;
export const DEPOSIT_FEE_USD = 0.05;

export interface AssetLike {
  coin?: string;
  exchangeType?: string;
  balance?: string;
  upnl?: string;
  equity?: string;
  liability?: string;
  borrowingInitialMargin: string;
}

export interface AccountLike {
  availableMargin: string;
  assets: AssetLike[];
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
  amount: number;
  deficit: number;
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
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function floorCents(value: number): number {
  return Number(roundToStep(value, '0.01', 'down'));
}

export function bucketsFrom(account: AccountLike, rates: RateLike[], interestRows: InterestRowLike[]): Bucket[] {
  return account.assets.map((asset) => {
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
      interestPaid30dUsd,
      interestPerDayUsd: equity < INTEREST_THRESHOLD ? borrow * hourly * 24 : 0,
    };
  });
}

export function planFor(buckets: Bucket[], account: AccountLike, inputs: PlanInputs): Plan {
  const deficitBucket = buckets.find((b) => b.coin === DEFICIT.coin && b.venue === DEFICIT.venue);
  const surplusBucket = buckets.find((b) => b.coin === SURPLUS.coin && b.venue === SURPLUS.venue);
  const deficit = Math.max(0, -(deficitBucket?.equity ?? 0));
  const surplusCash = surplusBucket?.cash ?? 0;
  const availableMargin = num(account.availableMargin);
  const amount = Math.max(0, floorCents(Math.min(deficit, surplusCash, availableMargin)));

  const shortfall: Plan['shortfall'] =
    deficit === 0 || (deficit <= surplusCash && deficit <= availableMargin)
      ? null
      : { reason: surplusCash <= availableMargin ? 'cash' : 'margin', remaining: floorCents(deficit - amount) };

  const convert: RouteQuote = {
    costUsd: amount * CONVERT_RATE,
    waitSeconds: 0,
    available: amount > 0,
    reason: amount > 0 ? null : 'nothing to move',
  };

  const ask = inputs.ask !== null && inputs.ask > 0 ? inputs.ask : null;
  let loopReason: string | null = null;
  if (!(amount > 0)) {
    loopReason = 'nothing to move';
  } else if (!inputs.usdcTransfer || inputs.usdcTransfer.isDisabled === 1) {
    loopReason = 'USDC transfers are disabled on CrossEx';
  } else if (!inputs.spotRule || inputs.spotRule.state !== 'live') {
    loopReason = `${SPOT_SYMBOL} is not live`;
  } else if (ask === null) {
    loopReason = 'no spot price for USDC_USDT';
  } else {
    const bought = floorCents(amount / ask);
    const min = inputs.usdcTransfer.minTransAmount;
    if (bought < min) loopReason = `loop buys ${bought} USDC, below the ${min} USDC transfer minimum`;
  }
  const spread = ask === null ? 0 : Math.max(ask - 1, 0);
  const loop: RouteQuote = {
    costUsd: amount * spread + amount * inputs.spotTakerRate + DEPOSIT_FEE_USD,
    waitSeconds: LOOP_WAIT_SECONDS,
    available: loopReason === null,
    reason: loopReason,
  };

  const route: Plan['route'] =
    loop.available && convert.available
      ? loop.costUsd < convert.costUsd
        ? 'loop'
        : 'convert'
      : loop.available
        ? 'loop'
        : convert.available
          ? 'convert'
          : null;

  const savesPerDayUsd =
    deficitBucket && deficitBucket.borrow > 0 ? (deficitBucket.interestPerDayUsd * amount) / deficitBucket.borrow : 0;
  const deficitAsset = account.assets.find((a) => a.coin === DEFICIT.coin && a.exchangeType === DEFICIT.venue);
  const liability = num(deficitAsset?.liability);
  const marginFreedUsd = liability > 0 ? (amount * num(deficitAsset?.borrowingInitialMargin)) / liability : 0;

  return { amount, deficit, shortfall, routes: { loop, convert }, route, savesPerDayUsd, marginFreedUsd };
}
