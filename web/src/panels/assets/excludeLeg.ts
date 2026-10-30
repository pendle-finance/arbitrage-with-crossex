import { t } from '../../i18n';
import { prettyVenue } from '../../lib/fmt';
import { spreadPlatform, type SpreadVenues } from '../../lib/spread';
import type { AssetBorosOpen } from '../../api/types';
import {
  borosKey,
  exclusionAt,
  exclusionQty,
  type ExclusionEntry,
  type Exclusions,
  type ExclusionSlice,
} from './assetModel';

const WHOLE_TOLERANCE = 1e-9;

const isPartOf = (part: number, whole: number): boolean => part < whole * (1 - WHOLE_TOLERANCE);

export function exclusionAfter(
  prev: ExclusionEntry | undefined,
  rowToken: number,
  legToken: number,
  legEntry: number | null,
): ExclusionEntry {
  if (prev === 'all') return 'all';
  const prevQty = exclusionQty(prev) ?? 0;
  const qty = isPartOf(prevQty + rowToken, legToken) ? prevQty + rowToken : legToken;
  const prevAt = exclusionAt(prev);
  if (prevAt === null) return { qty };
  if (legEntry === null) return { qty, at: prevAt };
  return { qty, at: (prevQty * prevAt + (qty - prevQty) * legEntry) / qty };
}

export function sizesForWholeExclusions(
  exclusions: Exclusions,
  legs: readonly Pick<AssetBorosOpen, 'marketId' | 'sizeToken'>[],
): Record<string, ExclusionSlice> {
  const sized: Record<string, ExclusionSlice> = {};
  for (const [key, entry] of Object.entries(exclusions)) {
    if (entry !== 'all') continue;
    const leg = legs.find((l) => borosKey(l.marketId) === key);
    if (leg && Number.isFinite(leg.sizeToken) && leg.sizeToken > 0) sized[key] = { qty: leg.sizeToken };
  }
  return sized;
}

export const legVenueName = (leg: { venue: string; spreadVenues?: readonly string[] | null }): string =>
  leg.spreadVenues
    ? t('assets.spreadVenue', { platform: spreadPlatform(leg.spreadVenues as SpreadVenues) })
    : prettyVenue(leg.venue);
