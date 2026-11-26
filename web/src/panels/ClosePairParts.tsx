import { Trans, useTranslation } from 'react-i18next';
import type { ActionInput, CrossexPosition, PreviewResult } from '../api/types';
import { fieldValue, parseSymbol, prettyVenue, sig } from '../lib/fmt';
import { AffixedInput, type ExecMode, LegCard } from '../trade/PairTicketBits';
import { estFeeOf } from '../trade/previewBits';
import { PairBookImpact } from '../trade/PriceImpactGraph';
import { FieldLabel } from '../trade/SymbolCombobox';
import type { matchedCloseOf } from './ClosePairFormBits';

export type CloseLeg = { symbol: string; qty: number; venue: string; partial?: boolean };
export type SideOf = (symbol: string) => 'LONG' | 'SHORT';

const CLOSE_CLIP_USD = 100_000;

export function CloseHeldLegs({
  base,
  legs,
  livePositions,
  sideOf,
}: {
  base: string;
  legs: CloseLeg[];
  livePositions?: Map<string, CrossexPosition>;
  sideOf: SideOf;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      {legs.map((l) => {
        const live = livePositions?.get(l.symbol);
        const held = live ? Math.abs(Number(live.positionQty)) : null;
        const { quote } = parseSymbol(l.symbol);
        const slice = l.partial === true;
        return (
          <LegCard
            key={l.symbol}
            kind="Perp"
            venue={prettyVenue(l.venue)}
            side={sideOf(l.symbol)}
            sub={`${base}-${quote || 'USDT'} · ${t(slice ? 'accounts.closePair.pairSlice' : 'accounts.closePair.wholePosition')}`}
            value={`${sig(l.qty)} ${base}`}
            valueSub={slice && held !== null ? t('accounts.closePair.ofHeld', { held: sig(held) }) : undefined}
          />
        );
      })}
    </div>
  );
}

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
      {qtyInvalid ? (
        <span className="text-[11px] text-rose-300">
          {t('accounts.closePair.sizeInvalid', { max: sig(maxCloseQty), base })}
        </span>
      ) : (
        <span className="text-[11px] text-ink-400">{t('accounts.closePair.sizeHint')}</span>
      )}
    </div>
  );
}

export function CloseSlipField({
  base,
  slipStr,
  slipInvalid,
  onChange,
}: {
  base: string;
  slipStr: string;
  slipInvalid: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={`close-pair-slip-${base}`}>{t('accounts.closePair.twap.marketSlippage')}</FieldLabel>
      <AffixedInput affix={<span>%</span>}>
        <input
          id={`close-pair-slip-${base}`}
          className={`input num pr-10 ${slipInvalid ? '!border-rose-500/60' : ''}`}
          inputMode="decimal"
          value={slipStr}
          onChange={(e) => onChange(e.target.value)}
        />
      </AffixedInput>
      {slipInvalid && <span className="text-[11px] text-rose-300">{t('accounts.closePair.slipInvalid')}</span>}
    </div>
  );
}

export function CloseRestNotes({
  base,
  restLegs,
  sideOf,
}: {
  base: string;
  restLegs: Array<{ leg: CloseLeg; qty: string }>;
  sideOf: SideOf;
}) {
  const { t } = useTranslation();
  return (
    <>
      {restLegs.map(({ leg, qty }) => (
        <p key={leg.symbol} className="text-[11px] text-ink-300">
          <Trans
            i18nKey="accounts.closePair.twap.restOpen"
            values={{
              qty,
              coin: base,
              venue: prettyVenue(leg.venue),
              side: t(sideOf(leg.symbol) === 'LONG' ? 'common.long' : 'common.short'),
            }}
            components={{ n: <span className="num" /> }}
          />
        </p>
      ))}
    </>
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

function notionalOf(p: PreviewResult): number | null {
  const mid = p.fillEstimate?.midPrice;
  const q = Number(p.qty);
  return mid && Number.isFinite(q) ? q * mid : (p.estNotional ?? null);
}

export function closeCosts(
  previews: PreviewResult[] | undefined,
  maker: boolean,
  makerIdx: number | null,
  twapOn: boolean,
): { tradeCost: number | null; makerSaving: number | null } {
  const legFee = (p: PreviewResult, i: number): number | null => {
    if (!p.fees) return null;
    if (!maker || i !== makerIdx) return estFeeOf(p);
    const n = notionalOf(p);
    return n === null ? null : n * p.fees.makerRate;
  };
  const mp = makerIdx === null ? undefined : previews?.[makerIdx];
  const n = mp ? notionalOf(mp) : null;
  const makerSaving = !twapOn && mp?.fees && n !== null ? n * (mp.fees.takerRate - mp.fees.makerRate) : null;
  const fees = previews?.length === 2 ? previews.map(legFee) : [];
  const tradeCost =
    fees.length === 2 && fees.every((f) => f !== null) ? (fees as number[]).reduce((s, f) => s + f, 0) : null;
  return { tradeCost, makerSaving };
}

export function closeBookOf({
  previews,
  makerIdx,
  maker,
  qtyStr,
  estimating,
  mode,
}: {
  previews: PreviewResult[] | undefined;
  makerIdx: number | null;
  maker: boolean;
  qtyStr: string;
  estimating: boolean;
  mode: ExecMode;
}) {
  const makerPreview = maker && makerIdx !== null ? previews?.[makerIdx] : undefined;
  const bookLegOf = (orderSide: 'BUY' | 'SELL'): PreviewResult | undefined => {
    const p = previews?.find((x) => x.side === orderSide);
    return p && p === makerPreview ? { ...p, fillEstimate: undefined } : p;
  };
  const buyLeg = bookLegOf('BUY');
  const sellLeg = bookLegOf('SELL');
  return buyLeg && sellLeg ? (
    <PairBookImpact
      longSym={buyLeg.symbol}
      shortSym={sellLeg.symbol}
      notional={qtyStr}
      legLong={buyLeg}
      legShort={sellLeg}
      estimating={estimating}
      mode={mode}
      makerLeg={makerPreview?.side === 'BUY' ? 'long' : 'short'}
      makerPriceStr={makerPreview ? String(makerPreview.fillEstimate?.midPrice ?? makerPreview.price ?? '') : ''}
      embedded
    />
  ) : null;
}
