import { useMemo } from 'react';
import { useAssetPrefs, useAssetView } from '../../api/queries';
import type { AssetGroup } from '../../api/types';
import { t } from '../../i18n';
import { daysToMaturity } from '../../lib/boros';
import { parseSymbol } from '../../lib/fmt';
import { bookKey, useBookId } from '../bookId';
import { useTrackedAddress } from '../trackedAddress';
import { deriveAsset, type Exclusions, type PairEstimate } from './assetModel';
import { legacyExclusionsFor, legSinceParam } from './assetPrefsStore';

type PairKeyParts = Pick<PairEstimate, 'longVenue' | 'shortVenue' | 'soonestMaturitySec' | 'kind'>;

export const pairKey = (p: PairKeyParts): string =>
  `${p.longVenue}:${p.shortVenue}:${p.soonestMaturitySec}:${p.kind}`;

export const openPairKey = (base: string, p: PairKeyParts): string => `${base}:${pairKey(p)}`;

export interface OpenPair {
  key: string;
  base: string;
  longVenue: string;
  shortVenue: string;
  maturitySec: number;
  unit: 'base' | 'usd';
  size: number;
  imUsd: number;
  perps: { symbol: string; exchange: string; side: 'LONG' | 'SHORT'; qty: number }[];
  boros: { marketId: number; size: number }[];
}

export function openPairOf(base: string, pair: PairEstimate): OpenPair {
  return {
    key: openPairKey(base, pair),
    base,
    longVenue: pair.longVenue,
    shortVenue: pair.shortVenue,
    maturitySec: pair.soonestMaturitySec,
    unit: pair.unit,
    size: pair.size,
    imUsd: pair.capitalUsd,
    perps: pair.legs.flatMap((l) =>
      l.kind === 'perp' && l.symbol !== undefined
        ? [{ symbol: l.symbol, exchange: parseSymbol(l.symbol).exchange, side: l.side, qty: l.sizeToken }]
        : [],
    ),
    boros: pair.legs.flatMap((l) =>
      l.kind === 'yu' && l.marketId !== undefined ? [{ marketId: l.marketId, size: l.sizeToken }] : [],
    ),
  };
}

export function openPairsOf(
  groups: readonly AssetGroup[],
  view: { exclusions: Exclusions; sinceSec: number; nowSec: number },
): OpenPair[] {
  return groups.flatMap((group) =>
    deriveAsset(group, view.exclusions, view.sinceSec, view.nowSec).pairs.map((p) => openPairOf(group.base, p)),
  );
}

export const daysLeftText = (maturitySec: number, nowSec: number): string => {
  const days = daysToMaturity(maturitySec, nowSec);
  return days > 0 ? t('assetCard.daysLeft', { days }) : t('assetCard.matured');
};

export function useOpenPairs(): { pairs: OpenPair[]; loading: boolean; failed: boolean; retry: () => void } {
  const { address } = useTrackedAddress();
  const book = bookKey(useBookId(address));
  const prefsQuery = useAssetPrefs(book, address !== null);
  const saved = prefsQuery.data;
  const exclusions = useMemo(
    () => ({ ...legacyExclusionsFor(book), ...(saved?.exclusions ?? {}) }),
    [book, saved],
  );
  const query = useAssetView(address, undefined, legSinceParam(saved?.legSince ?? {}));
  const data = query.data;
  const pairs = useMemo(
    () => (data ? openPairsOf(data.assets, { exclusions, sinceSec: data.sinceSec, nowSec: data.nowSec }) : []),
    [data, exclusions],
  );
  const loading = address !== null && !query.isError && (prefsQuery.isPending || query.isPending);
  const failed = query.isError && data === undefined;
  return { pairs, loading, failed, retry: () => void query.refetch() };
}
