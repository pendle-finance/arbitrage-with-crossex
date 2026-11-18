import type { CrossexPosition, PerpSize, RebalanceJob } from '../api/types';
import { t } from '../i18n';
import { fmtUsd, prettyVenue } from '../lib/fmt';
import { markPriceOf } from './RebalanceBits';
import { sideText, sizeText } from './rebalanceCopy';
import type { VerdictTone } from './RebalanceHovers';
import { gapsOf, isOtherLeg, otherLegText, perpsOf, type Gap } from './RebalanceJobView';

type PerpRow = Pick<PerpSize, 'symbol' | 'side' | 'qty'>;

const qtyOf = (rows: readonly PerpRow[], match: (row: PerpRow) => boolean): number =>
  rows.filter(match).reduce((total, row) => total + row.qty, 0);

export const openGapOf = (job: RebalanceJob): Gap | null => gapsOf(job)[0] ?? null;

export function gapVerdict(job: RebalanceJob, positions: readonly CrossexPosition[] | undefined): { text: string; sub: string | null; tone: VerdictTone } | null {
  const found = openGapOf(job);
  if (!found) return null;
  const { leg, qty } = found;
  const mark = markPriceOf(positions ?? [], leg.symbol);
  const usd = mark === null ? null : fmtUsd(qty * mark, 0);
  const words = { venue: prettyVenue(leg.exchange), side: sideText(leg.side), size: sizeText(qty), base: leg.base };
  if (job.status === 'halted') {
    const rows = [...perpsOf(positions ?? []), ...(job.before?.perps ?? [])];
    return {
      text: t('accounts.rebalanceRealize.gapBox', { ...words, leg: otherLegText(leg, rows) }),
      sub: usd === null ? null : t('accounts.rebalanceRealize.notHedged', { usd }),
      tone: 'act',
    };
  }
  return {
    text: usd === null ? t('accounts.rebalanceRealize.cardGapSize', words) : t('accounts.rebalanceRealize.cardGap', { ...words, usd }),
    sub: null,
    tone: 'warn',
  };
}

export function abandonedGapText(job: RebalanceJob, positions: readonly CrossexPosition[] | undefined): string | null {
  const found = job.status === 'abandoned' ? openGapOf(job) : null;
  if (!found) return null;
  const { leg } = found;
  let gap = found.qty;
  if (positions) {
    const live = perpsOf(positions);
    const before = job.before?.perps ?? null;
    const otherShrink = before ? qtyOf(before, (row) => isOtherLeg(row, leg)) - qtyOf(live, (row) => isOtherLeg(row, leg)) : 0;
    const legShrink = leg.positionQty - qtyOf(live, (row) => row.symbol === leg.symbol && row.side === leg.side);
    gap = Math.min(found.qty, legShrink - otherShrink);
  }
  if (gap <= leg.positionQty * 1e-9) return null;
  const mark = markPriceOf(positions ?? [], leg.symbol);
  const words = { size: sizeText(gap), base: leg.base, side: sideText(leg.side) };
  return mark === null
    ? t('accounts.rebalanceRealize.abandonedGapSize', words)
    : t('accounts.rebalanceRealize.abandonedGap', { ...words, usd: fmtUsd(gap * mark, 0) });
}
