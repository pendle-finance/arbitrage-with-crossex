import type { RealizeEstimate, RealizeExec, RealizeLeg, RealizePlan, SliceOption } from '../api/types';

export interface Slice {
  count: number;
  qty: number;
  usd: number;
  impactUsd: number | null;
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
    return { count: option.count, qty: option.notHedgedMaxQty, usd: option.notHedgedMaxUsd, impactUsd: option.impactUsd, seconds: option.seconds };
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
    seconds: { maker: (ref.seconds.maker / ref.count) * count, market: (ref.seconds.market / ref.count) * count },
  };
}

export function costOf(plan: RealizePlan, exec: RealizeExec, slice: Slice | null): Cost {
  const estimate = estimateOf(plan, exec);
  const convertUsd = sum(plan.legs.map((leg) => leg.convert?.feeUsd ?? 0));
  const lead = plan.legs[0];
  const walks = exec === 'market' ? 2 : 1;
  const impactUsd =
    slice?.impactUsd != null && lead
      ? Math.max(0, estimate.impactUsd - leadWalkUsd(lead, exec) + slice.impactUsd * walks)
      : estimate.impactUsd;
  return { feeUsd: estimate.feeUsd - convertUsd, convertUsd, impactUsd, totalUsd: estimate.feeUsd + impactUsd };
}

export const netOf = (plan: RealizePlan, cost: Cost): number => sum(plan.legs.map((leg) => leg.realizedUsd)) - cost.totalUsd;

export const hasPlan = (plan: RealizePlan | null): plan is RealizePlan => plan !== null && (plan.legs.length > 0 || plan.refused !== null);
