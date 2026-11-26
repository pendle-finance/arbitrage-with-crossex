import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssetGroup, CrossexPosition } from '../../api/types';
import { Modal } from '../../components/Modal';
import { PairPicker } from '../../components/PairPicker';
import { useNow } from '../../lib/useNow';
import { CloseBorosForm } from '../../trade/CloseBorosForm';
import { FieldLabel } from '../../trade/SymbolCombobox';
import { ClosePairForm } from '../PerpOnlyBox';
import { RollOverModal } from './AssetCard';
import { pairBorosCloseLegs, pairCanRoll, pairPerpBookedUsd, pairPerpCloseLegs, type PairEstimate } from './assetModel';
import { openPairKey, openPairOf, pairPickerRowOf, useOpenPairs, type PairEntry } from './pairs';

const borosLegsOf = (e: PairEntry) =>
  pairBorosCloseLegs(e.pair, e.group).map((l) => ({
    ...l,
    spreadVenues: e.group.borosOpen.find((b) => b.marketId === l.marketId)?.spreadVenues ?? null,
  }));

const borosSizeOf = (e: PairEntry) => ({ qty: e.pair.size, coin: e.group.base });

const perpSizeOf = (e: PairEntry) => {
  const legs = pairPerpCloseLegs(e.pair);
  return legs.length > 0 ? { qty: Math.min(...legs.map((l) => l.qty)), coin: e.group.base } : null;
};

function usePairChoice(
  pair: PairEstimate,
  group: AssetGroup,
  keep: (e: PairEntry) => boolean,
  { follow, locked = false }: { follow: boolean; locked?: boolean },
): { picked: PairEntry; picker: ReactNode } {
  const { t } = useTranslation();
  const { entries } = useOpenPairs();
  const liveOf = (key: string) => (follow ? entries.find((e) => e.open.key === key) : undefined);
  const ownLive = liveOf(openPairKey(group.base, pair));
  const own: PairEntry = ownLive ? { ...ownLive, group } : { open: openPairOf(group.base, pair), pair, group };
  const [chosen, setChosen] = useState<PairEntry | null>(null);
  const picked = chosen ? (liveOf(chosen.open.key) ?? chosen) : own;
  const nowSec = Math.floor(useNow(60_000) / 1000);
  const live = entries.filter((e) => e.open.key !== own.open.key && e.open.key !== picked.open.key && keep(e));
  const list = picked === own ? [own, ...live] : [own, picked, ...live];
  const picker = (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{t('accounts.deleverTab.pair')}</FieldLabel>
      <PairPicker
        rows={list.map((e) => pairPickerRowOf(e.open, nowSec))}
        value={picked.open.key}
        onChange={(key) => setChosen(key === own.open.key ? null : (list.find((e) => e.open.key === key) ?? chosen))}
        disabled={locked}
        label={t('accounts.deleverTab.pair')}
        searchLabel={t('accounts.deleverTab.search')}
        columns={{ pair: t('accounts.deleverTab.pair'), size: t('accounts.deleverTab.size'), im: t('accounts.deleverTab.initialMargin') }}
        emptyText={t('accounts.deleverTab.noPairsMatch')}
      />
    </div>
  );
  return { picked, picker };
}

export function ClosePairModal({
  kind,
  pair,
  group,
  livePositions,
  onClose,
}: {
  kind: 'perps' | 'boros';
  pair: PairEstimate;
  group: AssetGroup;
  livePositions: Map<string, CrossexPosition>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const { picked, picker } = usePairChoice(
    pair,
    group,
    (e) =>
      kind === 'perps'
        ? e.pair.unit === 'base' && pairPerpCloseLegs(e.pair).length > 0
        : pairBorosCloseLegs(e.pair, e.group).length > 0,
    { follow: true, locked: sent },
  );
  const onSent = () => setSent(true);
  const borosLegs = kind === 'boros' ? borosLegsOf(picked) : [];
  const title =
    kind === 'perps'
      ? t('assetCard.actions.closePerps')
      : borosLegs.length === 1
        ? t('assetCard.borosOnly.closeLeg')
        : t('assetCard.borosOnly.closeLegs');

  return (
    <Modal title={title} onClose={onClose} widthClass="w-[620px]">
      <div className="flex flex-col gap-4">
        {picker}
        {kind === 'perps' ? (
          <ClosePairForm
            key={picked.open.key}
            base={picked.group.base}
            legs={pairPerpCloseLegs(picked.pair)}
            livePositions={livePositions}
            allowTwap
            borosUnhedged={borosSizeOf(picked)}
            bookedBefore={pairPerpBookedUsd(picked.pair, picked.group)}
            onSent={onSent}
          />
        ) : (
          <CloseBorosForm key={picked.open.key} legs={borosLegs} perpsUnhedged={perpSizeOf(picked)} underPicker onDone={onClose} onSent={onSent} />
        )}
      </div>
    </Modal>
  );
}

export function RollPairModal({
  pair,
  group,
  nowSec,
  onClose,
}: {
  pair: PairEstimate;
  group: AssetGroup;
  nowSec: number;
  onClose: () => void;
}) {
  const { picked, picker } = usePairChoice(
    pair,
    group,
    (e) => pairCanRoll(e.pair, nowSec) && pairBorosCloseLegs(e.pair, e.group).length > 0,
    { follow: false },
  );
  return (
    <RollOverModal key={picked.open.key} pair={picked.pair} base={picked.group.base} nowSec={nowSec} picker={picker} onClose={onClose} />
  );
}
