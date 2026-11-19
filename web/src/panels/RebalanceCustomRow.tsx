import { useTranslation } from 'react-i18next';
import type { Pool } from '../api/types';
import { moveFromText, moveText, moveToText, poolKey, WALLET_LABEL } from './rebalanceCopy';

export function RebalanceCustomRow({
  text, from, to, pools, onText, onFrom, onTo,
}: {
  text: string;
  from: Pool;
  to: Pool;
  pools: readonly Pool[];
  onText: (next: string) => void;
  onFrom: (next: Pool) => void;
  onTo: (next: Pool) => void;
}) {
  const { t } = useTranslation();
  const options = pools.map((pool) => (
    <option key={pool} value={pool}>
      {WALLET_LABEL[poolKey(pool)]}
    </option>
  ));
  return (
    <div className="num flex flex-wrap items-center gap-2 text-sm text-ink-300">
      <span className="text-ink-400">{moveText()}</span>
      <input
        aria-label={t('accounts.rebalanceModal.amount')}
        className="input num h-[30px] w-28 !py-0 text-xs"
        inputMode="decimal"
        value={text}
        onChange={(e) => onText(e.target.value)}
      />
      <span className="text-ink-400">{moveFromText()}</span>
      <select aria-label={t('accounts.rebalanceModal.from')} className="input num h-[30px] !w-44 !py-0 text-xs" value={from} onChange={(e) => onFrom(e.target.value as Pool)}>
        {options}
      </select>
      <span className="text-ink-400">{moveToText()}</span>
      <select aria-label={t('accounts.rebalanceModal.to')} className="input num h-[30px] !w-44 !py-0 text-xs" value={to} onChange={(e) => onTo(e.target.value as Pool)}>
        {options}
      </select>
    </div>
  );
}
