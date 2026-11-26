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

function WalletBox({ children }: { children: ReactNode }) {
  return <div className="card flex min-w-0 flex-1 flex-col gap-2 px-3 py-2 text-xs">{children}</div>;
}

function WalletLine({ label, wallet, children }: { label?: string; wallet: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className={microLabelClass}>{label}</span>
        {wallet}
      </div>
      {children && <div className="flex items-baseline gap-2">{children}</div>}
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
  const fromLabel = t('accounts.moveCash.from');
  const toLabel = t('accounts.moveCash.to');
  const fromBox = custom ? (
    <WalletLine
      label={fromLabel}
      wallet={
        <select aria-label={t('accounts.rebalanceModal.from')} className="input num h-8 !py-0 text-xs" value={from} onChange={(e) => onFrom(e.target.value as Pool)}>
          {options}
        </select>
      }
    >
      <AffixedInput affix={poolCoin(from)}>
        <input
          aria-label={t('accounts.rebalanceModal.amount')}
          className="input num h-8 w-full pr-12"
          inputMode="decimal"
          value={text}
          onChange={(e) => onText(e.target.value)}
        />
      </AffixedInput>
    </WalletLine>
  ) : (
    flow.sent.map(({ pool, amount }, i) => (
      <WalletLine key={pool} label={i === 0 ? fromLabel : undefined} wallet={<span className="text-ink-300">{walletOf(pool)}</span>}>
        {amountText(amount, pool)}
      </WalletLine>
    ))
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-3">
        <WalletBox>{fromBox}</WalletBox>
        <span className="flex shrink-0 items-center text-ink-500">
          <ArrowRight size={16} aria-hidden />
        </span>
        <WalletBox>
          {custom ? (
            <WalletLine
              label={toLabel}
              wallet={
                <select aria-label={t('accounts.rebalanceModal.to')} className="input num h-8 !py-0 text-xs" value={to} onChange={(e) => onTo(e.target.value as Pool)}>
                  {options}
                </select>
              }
            >
              {flow.arrives.map(({ pool, amount }) => priced && <span key={pool}>{amountText(amount, pool)}</span>)}
            </WalletLine>
          ) : (
            flow.arrives.map(({ pool, amount }, i) => (
              <WalletLine key={pool} label={i === 0 ? toLabel : undefined} wallet={<span className="text-ink-300">{walletOf(pool)}</span>}>
                {priced && amountText(amount, pool)}
                {flow.hasBorrow && <span className="text-ink-400">{t('accounts.moveCash.repays')}</span>}
              </WalletLine>
            ))
          )}
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
