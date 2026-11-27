import { ArrowRight } from 'lucide-react';
import type { RealizeConvert, RealizeLeg, RealizeTwap } from '../api/types';
import { t } from '../i18n';
import { fmtUsd, num } from '../lib/fmt';
import { EstimateRow } from '../trade/PairTicketBits';
import { VerdictAlert } from './RebalanceBits';
import { Term } from './RebalanceHovers';
import type { PlanStep } from './RebalancePlanBits';
import { CONVERT_TO, HOVER, poolCoin, poolKey, sizeText, WALLET_LABEL } from './rebalanceCopy';

const PART_TEXT = {
  legPart: 'accounts.realizeTab.legPart',
  closeFirst: 'accounts.realizeTab.closeFirst',
  closeFirstNever: 'accounts.realizeTab.closeFirstNever',
  reopenFirst: 'accounts.realizeTab.reopenFirst',
  restPart: 'accounts.realizeTab.restPart',
} as const;

const BIG_FIRST = { timed: 'accounts.realizeTab.bigFirst', never: 'accounts.realizeTab.bigFirstNever' } as const;
const GAP_FIRST = { timed: 'accounts.realizeTab.gapFirst', never: 'accounts.realizeTab.gapFirstNever' } as const;

function partRow(leg: RealizeLeg, part: keyof typeof PART_TEXT, size: number, usd: number | null): PlanStep {
  const side = t(leg.side === 'LONG' ? 'common.long' : 'common.short');
  return {
    key: part === 'legPart' ? leg.symbol : `${leg.symbol}:${part}`,
    icon: leg.base,
    text: <span className="num">{t(PART_TEXT[part], { coin: leg.base, side, size: sizeText(size), held: sizeText(leg.positionQty) })}</span>,
    usd,
  };
}

function convertRow(leg: RealizeLeg, convert: RealizeConvert, usd: number | null, key = 'convert'): PlanStep {
  return {
    key: `${leg.symbol}:${key}`,
    icon: poolCoin(leg.pool),
    text: (
      <span className="num inline-flex items-center gap-1.5">
        <Term label={t('accounts.rebalanceRealize.convertAction', { amount: num(convert.amount, 0), coin: poolCoin(leg.pool) })} text={HOVER.convert} />
        <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-500" />
        {WALLET_LABEL[poolKey(CONVERT_TO[leg.pool])]}
      </span>
    ),
    usd,
  };
}

export function realizeStepRows(legs: RealizeLeg[], legCosts: number[] | null, never = false): PlanStep[] {
  return legs.flatMap((leg, at) => {
    const usd = legCosts ? (legCosts[at] ?? null) : null;
    const whole = partRow(leg, 'legPart', leg.qty, usd);
    if (!leg.convert || !(leg.convert.feeUsd > 0)) return [whole];
    const total = leg.convert;
    const partOf = (amount: number, key?: string): PlanStep[] =>
      amount >= 0.01 ? [convertRow(leg, { ...total, amount, feeUsd: (total.feeUsd * amount) / total.amount }, legCosts ? (total.feeUsd * amount) / total.amount : null, key)] : [];
    if (!leg.margin) return [whole, ...partOf(total.amount)];
    const inSlice = Math.min(total.amount, leg.margin.amount);
    const after = partOf(total.amount - inSlice, 'convertRest');
    if (leg.margin.at === 'before') return [...partOf(inSlice), whole, ...after];
    const first = Math.min(leg.margin.firstQty, leg.qty);
    const rest = leg.qty - first;
    return [
      partRow(leg, never ? 'closeFirstNever' : 'closeFirst', first, null),
      ...partOf(inSlice),
      partRow(leg, 'reopenFirst', first, rest > 0 ? null : usd),
      ...(rest > 0 ? [partRow(leg, 'restPart', rest, usd)] : []),
      ...after,
    ];
  });
}

export function BigFirstSlice({ legs, twap, never = false }: { legs: RealizeLeg[]; twap: RealizeTwap | null; never?: boolean }) {
  const gaps = legs.flatMap((leg) => {
    const slice = Number(twap?.legs.find((row) => row.symbol === leg.symbol)?.plan?.sliceQty);
    return leg.margin?.at === 'gap' ? [{ leg, margin: leg.margin, slice: slice > 0 ? slice : null }] : [];
  });
  return gaps.map(({ leg, margin, slice }) => (
    <VerdictAlert
      key={leg.symbol}
      tone="warn"
      text={
        <span className="flex flex-col gap-1.5">
          <span>{t(slice !== null && margin.firstQty > slice ? BIG_FIRST[never ? 'never' : 'timed'] : GAP_FIRST[never ? 'never' : 'timed'], { coin: leg.base })}</span>
          <EstimateRow label={t('accounts.realizeTab.bigFirstSize')} value={<span className="num">{`${sizeText(margin.firstQty)} ${leg.base}`}</span>} />
          {slice !== null && <EstimateRow label={t('accounts.realizeTab.bigFirstTwap')} value={<span className="num">{`${sizeText(slice)} ${leg.base}`}</span>} />}
          <EstimateRow label={t('accounts.realizeTab.bigFirstImpact')} value={<span className="num">{`${fmtUsd(margin.impactUsd ?? 0)} · ${num(margin.impactBp ?? 0, 1)} bp`}</span>} />
        </span>
      }
    />
  ));
}
