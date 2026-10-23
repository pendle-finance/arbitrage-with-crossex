import { useCallback, useEffect, useRef } from 'react';
import { useToastOptional } from '../../components/Toast';
import { fmtDateShort, prettyVenue, sigGrouped } from '../../lib/fmt';
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

export const isPartOf = (part: number, whole: number): boolean => part < whole * (1 - WHOLE_TOLERANCE);

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
  leg.spreadVenues ? `Spread ${spreadPlatform(leg.spreadVenues as SpreadVenues)}` : prettyVenue(leg.venue);

export function excludeToastText(
  leg: { venue: string; side: 'LONG' | 'SHORT'; spreadVenues: readonly string[] | null; maturity: number },
  rowSize: number,
  legSize: number,
  unitLabel: string,
): string {
  const who = legVenueName(leg);
  const isPart = isPartOf(rowSize, legSize);
  const size = isPart ? `${sigGrouped(rowSize)} of ${sigGrouped(legSize)}` : sigGrouped(rowSize);
  const date = fmtDateShort(leg.maturity);
  return `${who} ${leg.side} ${size} ${unitLabel} · ${date} excluded.`;
}

export function useExcludeWithUndo(
  exclusions: Exclusions,
  onExclude: (key: string, value: ExclusionEntry | undefined) => void,
): (key: string, value: ExclusionEntry, text: string) => void {
  const toast = useToastOptional();
  const pending = useRef(new Map<string, ExclusionEntry | undefined>());

  useEffect(() => {
    pending.current.clear();
  }, [exclusions]);

  return useCallback(
    (key, value, text) => {
      const before = pending.current.has(key) ? pending.current.get(key) : exclusions[key];
      pending.current.set(key, value);
      onExclude(key, value);
      toast?.push('info', text, {
        key,
        action: { label: 'Undo', onClick: () => onExclude(key, before) },
      });
    },
    [exclusions, onExclude, toast],
  );
}
