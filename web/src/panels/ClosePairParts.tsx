import type { ActionInput, PreviewResult } from '../api/types';
import { fieldValue } from '../lib/fmt';
import { estFeeOf, legNotional } from '../trade/previewBits';
import type { matchedCloseOf } from './ClosePairFormBits';

export type CloseLeg = { symbol: string; qty: number; venue: string; partial?: boolean };
export type SideOf = (symbol: string) => 'LONG' | 'SHORT';

const CLOSE_CLIP_USD = 100_000;

export function buildCloseActions({
  legs,
  pairGroupId,
  slip,
  matched,
  closeQtyOf,
}: {
  legs: CloseLeg[];
  pairGroupId: string;
  slip: number;
  matched: ReturnType<typeof matchedCloseOf> | null;
  closeQtyOf: (legQty: number) => number;
}): ActionInput[] {
  return legs.map((l, i) => ({
    kind: 'close-position' as const,
    symbol: l.symbol,
    pairGroupId,
    slippagePct: slip,
    ...(matched
      ? l.partial || !matched.whole[i]
        ? { qty: matched.qty }
        : {}
      : l.partial || closeQtyOf(l.qty) < l.qty - Math.max(1e-9, l.qty * 1e-7)
        ? { qty: fieldValue(closeQtyOf(l.qty)) }
        : {}),
  }));
}

export function decorateClose(
  acts: ActionInput[],
  previews: PreviewResult[] | undefined,
  makerIdx: number | null,
  maker: boolean,
): ActionInput[] {
  if (!maker || !previews || previews.length !== 2 || makerIdx === null) return acts;
  const mp = previews[makerIdx];
  const mid = mp.fillEstimate?.midPrice ?? Number(mp.price);
  if (!(mid > 0)) return acts;
  const maxClip = fieldValue(CLOSE_CLIP_USD / mid);
  return acts.map((a, i) =>
    a.kind === 'close-position'
      ? {
          ...a,
          pairRole: i === makerIdx ? ('maker' as const) : ('hedge' as const),
          ...(i === makerIdx ? { makerPrice: String(mid) } : {}),
          maxClip,
        }
      : a,
  );
}

function legFeeOf(p: PreviewResult, rests: boolean): number | null {
  if (!p.fees) return null;
  if (!rests) return estFeeOf(p);
  const n = legNotional(p);
  return n === null ? null : n * p.fees.makerRate;
}

export function shownLegOf(p: PreviewResult, rests: boolean): PreviewResult {
  if (!rests) return p;
  const fee = legFeeOf(p, true);
  return {
    ...p,
    fillEstimate: undefined,
    price: String(p.fillEstimate?.midPrice ?? p.price ?? ''),
    fees: p.fees && fee !== null ? { ...p.fees, est: { maker: fee } } : undefined,
  };
}

export function closeCosts(
  previews: PreviewResult[] | undefined,
  maker: boolean,
  makerIdx: number | null,
  twapOn: boolean,
): { tradeCost: number | null; makerSaving: number | null } {
  const legFee = (p: PreviewResult, i: number): number | null => legFeeOf(p, maker && i === makerIdx);
  const mp = makerIdx === null ? undefined : previews?.[makerIdx];
  const n = mp ? legNotional(mp) : null;
  const makerSaving = !twapOn && mp?.fees && n !== null ? n * (mp.fees.takerRate - mp.fees.makerRate) : null;
  const fees = previews?.length === 2 ? previews.map(legFee) : [];
  const tradeCost =
    fees.length === 2 && fees.every((f) => f !== null) ? (fees as number[]).reduce((s, f) => s + f, 0) : null;
  return { tradeCost, makerSaving };
}
