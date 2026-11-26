import { Trans, useTranslation } from 'react-i18next';
import type { ActionInput, PreviewResult } from '../api/types';
import { fieldValue, sig } from '../lib/fmt';
import { AffixedInput } from '../trade/PairTicketBits';
import { estFeeOf, legNotional } from '../trade/previewBits';
import { FieldLabel } from '../trade/SymbolCombobox';
import type { matchedCloseOf } from './ClosePairFormBits';

export type CloseLeg = { symbol: string; qty: number; venue: string; partial?: boolean };
export type SideOf = (symbol: string) => 'LONG' | 'SHORT';

const CLOSE_CLIP_USD = 100_000;

export function CloseSizeField({
  base,
  qtyStr,
  qtyInvalid,
  maxCloseQty,
  onChange,
}: {
  base: string;
  qtyStr: string;
  qtyInvalid: boolean;
  maxCloseQty: number;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel htmlFor={`close-pair-qty-${base}`}>{t('accounts.closePair.sizeLabel')}</FieldLabel>
        <button
          type="button"
          className="num text-[11px] text-ink-400 transition-colors hover:text-ink-100"
          title={t('accounts.closePair.maxTitle')}
          onClick={() => onChange(fieldValue(maxCloseQty))}
        >
          {t('accounts.closePair.max')}{' '}
          <span className="text-link underline decoration-link/40 underline-offset-2">
            {sig(maxCloseQty)} {base}
          </span>
        </button>
      </div>
      <AffixedInput affix={<span>{base}</span>}>
        <input
          id={`close-pair-qty-${base}`}
          className={`input num pr-16 ${qtyInvalid ? '!border-rose-500/60' : ''}`}
          inputMode="decimal"
          value={qtyStr}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t('accounts.closePair.sizeAria')}
        />
      </AffixedInput>
      {qtyInvalid && (
        <span className="text-[11px] text-rose-300">
          {t('accounts.closePair.sizeInvalid', { max: sig(maxCloseQty), base })}
        </span>
      )}
    </div>
  );
}

export function CloseMechanics({ maker, twapOn }: { maker: boolean; twapOn: boolean }) {
  const { t } = useTranslation();
  return (
    <p
      className="text-[11px] leading-relaxed text-ink-400"
      title={t(maker ? 'accounts.closePair.pairNoteMaker' : 'accounts.closePair.pairNote')}
    >
      {twapOn ? (
        t('accounts.closePair.twap.reduceOnly')
      ) : (
        <Trans
          i18nKey={maker ? 'accounts.closePair.mechanicsMaker' : 'accounts.closePair.mechanics'}
          components={{ b: <span className="font-medium text-ink-200" /> }}
        />
      )}
    </p>
  );
}

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
