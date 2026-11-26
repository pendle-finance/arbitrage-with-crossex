import type { CrossexPosition, PerpSize, RebalanceJob, RebalanceOpenGap } from '../api/types';
import { t } from '../i18n';
import { fmtUsd } from '../lib/fmt';
import { markPriceOf } from './RebalanceBits';
import { sideText, sizeText } from './rebalanceCopy';
import { perpsOf } from './rebalanceJobSteps';

type PerpRow = Pick<PerpSize, 'symbol' | 'side' | 'qty'>;

const qtyOf = (rows: readonly PerpRow[], match: (row: PerpRow) => boolean): number =>
  rows.filter(match).reduce((total, row) => total + row.qty, 0);

export const hasLeftGap = (job: RebalanceJob): boolean => (job.openGaps?.length ?? 0) > 0;

function liveGapOf({ leg, qty, hedges }: RebalanceOpenGap, positions: readonly CrossexPosition[] | undefined): number {
  if (!positions) return qty;
  const live = perpsOf(positions);
  const stored = (row: PerpRow): boolean => hedges.some((hedge) => hedge.symbol === row.symbol && hedge.side === row.side);
  const otherShrink = qtyOf(hedges, () => true) - qtyOf(live, stored);
  const legShrink = leg.positionQty - qtyOf(live, (row) => row.symbol === leg.symbol && row.side === leg.side);
  return Math.min(qty, legShrink - otherShrink);
}

export function abandonedGapText(job: RebalanceJob, positions: readonly CrossexPosition[] | undefined): string | null {
  for (const found of job.openGaps ?? []) {
    const { leg } = found;
    const gap = liveGapOf(found, positions);
    if (gap <= leg.positionQty * 1e-9) continue;
    const mark = markPriceOf(positions ?? [], leg.symbol);
    const words = { size: sizeText(gap), base: leg.base, side: sideText(leg.side) };
    return mark === null
      ? t('accounts.rebalanceRealize.abandonedGapSize', words)
      : t('accounts.rebalanceRealize.abandonedGap', { ...words, usd: fmtUsd(gap * mark, 0) });
  }
  return null;
}
