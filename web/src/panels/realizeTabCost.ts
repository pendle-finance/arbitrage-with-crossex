import type { RealizeEstimate, RealizeExec, RealizeLeg, RealizePlan, SliceOption, TwapInput } from '../api/types';

export interface Slice {
  count: number;
  qty: number;
  usd: number;
  impactUsd: number | null;
  reopenImpactUsd: number | null;
  seconds: { maker: number; market: number };
}

export interface Cost {
  feeUsd: number;
  convertUsd: number;
  impactUsd: number;
  totalUsd: number;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

function estimateOf(plan: RealizePlan, exec: RealizeExec): RealizeEstimate {
  const shipped = plan.estimates?.[exec];
  if (shipped) return shipped;
  const feeUsd = sum(plan.legs.map((leg) => leg.closeFeeUsd + leg.reopenFeeUsd + (leg.convert?.feeUsd ?? 0)));
  const impactUsd = sum(plan.legs.map((leg) => leadWalkUsd(leg, exec)));
  return { feeUsd, impactUsd, totalUsd: feeUsd + impactUsd };
}

function leadWalkUsd(leg: RealizeLeg, exec: RealizeExec): number {
  return (exec === 'market' ? leg.closeImpactUsd : 0) + leg.reopenImpactUsd;
}

export function sliceOf(options: SliceOption[], sizeUsd: number, lead: RealizeLeg | undefined, priced: boolean): Slice | null {
  const option = options.find((o) => o.sizeUsd === sizeUsd) ?? null;
  if (option && priced) {
    return { count: option.count, qty: option.notHedgedMaxQty, usd: option.notHedgedMaxUsd, impactUsd: option.impactUsd, reopenImpactUsd: option.reopenImpactUsd, seconds: option.seconds };
  }
  const ref = option ?? options[0];
  if (!ref || !lead || !(ref.notHedgedMaxQty > 0) || !(ref.count > 0)) return null;
  const mid = ref.notHedgedMaxUsd / ref.notHedgedMaxQty;
  const qty = Math.min(lead.qty, sizeUsd / mid);
  if (!(qty > 0)) return null;
  const count = Math.ceil(lead.qty / qty);
  return {
    count,
    qty,
    usd: qty * mid,
    impactUsd: null,
    reopenImpactUsd: null,
    seconds: { maker: (ref.seconds.maker / ref.count) * count, market: (ref.seconds.market / ref.count) * count },
  };
}

export function costOf(plan: RealizePlan, exec: RealizeExec, slice: Slice | null): Cost {
  const estimate = estimateOf(plan, exec);
  const convertUsd = sum(plan.legs.map((leg) => leg.convert?.feeUsd ?? 0));
  const lead = plan.legs[0];
  const impactUsd =
    slice?.impactUsd != null && slice.reopenImpactUsd != null && lead
      ? Math.max(0, estimate.impactUsd - leadWalkUsd(lead, exec) + (exec === 'market' ? slice.impactUsd : 0) + slice.reopenImpactUsd)
      : estimate.impactUsd;
  return { feeUsd: estimate.feeUsd - convertUsd, convertUsd, impactUsd, totalUsd: estimate.feeUsd + impactUsd };
}

export const netOf = (plan: RealizePlan, cost: Cost): number => sum(plan.legs.map((leg) => leg.realizedUsd)) - cost.totalUsd;

export function legCostsOf(plan: RealizePlan, exec: RealizeExec, cost: Cost): number[] {
  const own = plan.legs.map((leg) => (exec === 'maker' ? (leg.closeMakerFeeUsd ?? leg.closeFeeUsd) : leg.closeFeeUsd) + leg.reopenFeeUsd + leadWalkUsd(leg, exec));
  const rest = sum(own.slice(1)) + sum(plan.legs.map((leg) => leg.convert?.feeUsd ?? 0));
  return [cost.totalUsd - rest, ...own.slice(1)];
}

export const hasPlan = (plan: RealizePlan | null): plan is RealizePlan => plan !== null && (plan.legs.length > 0 || plan.refused !== null);

export interface TwapQuery {
  durationSec: number;
  slices: number;
}

const countAtSize = (leadQty: number, sliceQty: string | undefined): number | undefined => {
  const size = Number(sliceQty);
  if (!(size > 0) || !(leadQty > 0)) return undefined;
  const ratio = leadQty / size;
  return Math.ceil(ratio - ratio * 1e-12);
};

export function twapQueryOf(input: TwapInput, leadQty: number): TwapQuery | null {
  const { durationSec, intervalSec } = input;
  const spanned = durationSec !== undefined && intervalSec !== undefined ? (intervalSec > 0 ? Math.floor(durationSec / intervalSec) : 0) : undefined;
  const slices = input.slices ?? spanned ?? countAtSize(leadQty, input.sliceQty);
  if (slices === undefined) return null;
  const duration = durationSec ?? (intervalSec !== undefined ? slices * intervalSec : undefined);
  if (duration === undefined) return null;
  return { durationSec: Math.max(1, Math.round(duration)), slices: Math.max(1, slices) };
}
