import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Pool } from '../api/types';
import { microLabelClass } from '../components/Th';
import { num } from '../lib/fmt';
import type { MoveFlow } from './moveCashPlan';
import { poolCoin } from './rebalanceCopy';
import { walletOf } from './RebalancePlanBits';
import { AffixedInput } from '../trade/PairTicketBits';

function WalletBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card flex min-w-0 flex-1 flex-col gap-1.5 p-3 text-xs">
      <span className={microLabelClass}>{label}</span>
      {children}
    </div>
  );
}

export function MoveCashWallets({
  custom,
  flow,
  pools,
  priced,
  from,
  to,
  text,
  fromCash,
  onFrom,
  onTo,
  onText,
}: {
  custom: boolean;
  flow: MoveFlow;
  pools: Pool[];
  priced: boolean;
  from: Pool;
  to: Pool;
  text: string;
  fromCash: number;
  onFrom: (pool: Pool) => void;
  onTo: (pool: Pool) => void;
  onText: (text: string) => void;
}) {
  const { t } = useTranslation();
  const options = pools.map((pool) => (
    <option key={pool} value={pool}>
      {walletOf(pool)}
    </option>
  ));
  const amountText = (amount: number, pool: Pool) => <span className="num text-sm font-semibold text-ink-50">{`${num(amount)} ${poolCoin(pool)}`}</span>;
  const fromBox = custom ? (
    <>
      <select aria-label={t('accounts.rebalanceModal.from')} className="input num h-8 !py-0 text-xs" value={from} onChange={(e) => onFrom(e.target.value as Pool)}>
        {options}
      </select>
      <AffixedInput affix={poolCoin(from)}>
        <input
          aria-label={t('accounts.rebalanceModal.amount')}
          className="input num h-8 w-full pr-12"
          inputMode="decimal"
          value={text}
          onChange={(e) => onText(e.target.value)}
        />
      </AffixedInput>
    </>
  ) : (
    flow.sent.map(({ pool, amount }) => (
      <div key={pool} className="flex flex-col gap-0.5">
        <span className="text-ink-300">{walletOf(pool)}</span>
        {amountText(amount, pool)}
      </div>
    ))
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-3">
        <WalletBox label={t('accounts.moveCash.from')}>{fromBox}</WalletBox>
        <span className="flex shrink-0 items-center text-ink-500">
          <ArrowRight size={16} aria-hidden />
        </span>
        <WalletBox label={t('accounts.moveCash.to')}>
          {custom && (
            <select aria-label={t('accounts.rebalanceModal.to')} className="input num h-8 !py-0 text-xs" value={to} onChange={(e) => onTo(e.target.value as Pool)}>
              {options}
            </select>
          )}
          {flow.arrives.map(({ pool, amount }) => (
            <div key={pool} className="flex flex-col gap-0.5">
              {!custom && <span className="text-ink-300">{walletOf(pool)}</span>}
              {flow.hasBorrow && !custom && <span className="text-ink-400">{t('accounts.moveCash.repays')}</span>}
              {priced && amountText(amount, pool)}
            </div>
          ))}
        </WalletBox>
      </div>
      {custom && (
        <div className="flex items-center justify-between gap-3 text-xs text-ink-400">
          <span className="num">{t('accounts.moveCash.upTo', { amount: num(fromCash), coin: poolCoin(from), wallet: walletOf(from) })}</span>
          <button type="button" className="btn-link" disabled={fromCash <= 0} onClick={() => onText(String(fromCash))}>
            {t('accounts.moveCash.max')}
          </button>
        </div>
      )}
    </div>
  );
}
