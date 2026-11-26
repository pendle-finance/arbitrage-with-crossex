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
import { pairBorosCloseLegs, pairCanRoll, pairPerpCloseLegs, type PairEstimate } from './assetModel';
import { openPairKey, openPairOf, pairPickerRowOf, useOpenPairs, type PairEntry } from './pairs';

const borosLegsOf = (e: PairEntry) =>
  pairBorosCloseLegs(e.pair, e.group).map((l) => ({
    ...l,
    spreadVenues: e.group.borosOpen.find((b) => b.marketId === l.marketId)?.spreadVenues ?? null,
  }));

function usePairChoice(pair: PairEstimate, group: AssetGroup, keep: (e: PairEntry) => boolean): { picked: PairEntry; picker: ReactNode } {
  const { t } = useTranslation();
  const own: PairEntry = { open: openPairOf(group.base, pair), pair, group };
  const ownKey = openPairKey(group.base, pair);
  const [key, setKey] = useState(ownKey);
  const { entries } = useOpenPairs();
  const nowSec = Math.floor(useNow(60_000) / 1000);
  const all = entries.some((e) => e.open.key === ownKey) ? entries.map((e) => (e.open.key === ownKey ? own : e)) : [own, ...entries];
  const list = all.filter((e) => e === own || keep(e));
  const picked = list.find((e) => e.open.key === key) ?? own;
  const picker = (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{t('accounts.deleverTab.pair')}</FieldLabel>
      <PairPicker
        rows={list.map((e) => pairPickerRowOf(e.open, nowSec))}
        value={picked.open.key}
        onChange={setKey}
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
  const { picked, picker } = usePairChoice(pair, group, (e) =>
    kind === 'perps' ? pairPerpCloseLegs(e.pair).length > 0 : pairBorosCloseLegs(e.pair, e.group).length > 0,
  );
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
            borosUnhedged
          />
        ) : (
          <CloseBorosForm key={picked.open.key} legs={borosLegs} perpsUnhedged onDone={onClose} />
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
  );
  return (
    <RollOverModal key={picked.open.key} pair={picked.pair} base={picked.group.base} nowSec={nowSec} picker={picker} onClose={onClose} />
  );
}
