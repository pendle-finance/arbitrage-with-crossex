import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Pool } from '../api/types';
import { AmountBox } from '../components/AmountBox';
import { TokenIcon } from '../components/AssetIcon';
import { ListPicker } from '../components/ListPicker';
import { microLabelClass } from '../components/Th';
import { num } from '../lib/fmt';
import type { MoveFlow } from './moveCashPlan';
import { poolCoin } from './rebalanceCopy';
import { walletOf } from './RebalancePlanBits';

function WalletBox({ children }: { children: ReactNode }) {
  return <div className="card flex min-w-0 flex-1 flex-col gap-2 px-3 py-2 text-xs">{children}</div>;
}

function WalletLine({ label, wallet, children }: { label?: string; wallet?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex min-h-4 items-center justify-between gap-2">
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
  const rows = pools.map((pool) => ({ key: pool, icon: <TokenIcon symbol={poolCoin(pool)} size={16} />, name: walletOf(pool) }));
  const amountText = (amount: number, pool: Pool, size = 'text-sm') => <span className={`num ${size} font-semibold text-ink-50`}>{`${num(amount)} ${poolCoin(pool)}`}</span>;
  const walletName = (pool: Pool) => (
    <span className="flex items-center gap-1.5 font-medium text-ink-50">
      <TokenIcon symbol={poolCoin(pool)} size={16} />
      {walletOf(pool)}
    </span>
  );
  const fromLabel = t('accounts.moveCash.from');
  const toLabel = t('accounts.moveCash.to');
  const stacked = flow.sent.length > 1 || flow.arrives.length > 1;
  const walletRows = (label: string, legs: { pool: Pool; amount: number }[], shown: boolean) => (
    <>
      <span className={microLabelClass}>{label}</span>
      {legs.map(({ pool, amount }) => (
        <div key={pool} className="flex min-w-0 items-center justify-between gap-3">
          {walletName(pool)}
          {shown && amountText(amount, pool)}
        </div>
      ))}
    </>
  );
  const fromBox = custom ? (
    <>
      <WalletLine
        label={fromLabel}
        wallet={
          <button
            type="button"
            className="num text-[11px] text-link underline decoration-link/40 underline-offset-2 hover:text-ink-50 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
            title={t('accounts.moveCash.upTo', { amount: num(fromCash), coin: poolCoin(from), wallet: walletOf(from) })}
            disabled={fromCash <= 0}
            onClick={() => onText(String(fromCash))}
          >
            {t('accounts.moveCash.maxAmount', { amount: num(fromCash), coin: poolCoin(from) })}
          </button>
        }
      />
      <ListPicker label={t('accounts.rebalanceModal.from')} value={from} onChange={onFrom} rows={rows} />
      <AmountBox className="w-full" inputLabel={t('accounts.rebalanceModal.amount')} value={text} onChange={onText} suffix={poolCoin(from)} />
    </>
  ) : stacked ? (
    walletRows(fromLabel, flow.sent, true)
  ) : (
    flow.sent.map(({ pool, amount }, i) => (
      <WalletLine key={pool} label={i === 0 ? fromLabel : undefined} wallet={walletName(pool)}>
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
            <>
              <WalletLine label={toLabel} />
              <ListPicker label={t('accounts.rebalanceModal.to')} value={to} onChange={onTo} rows={rows} />
              <div className="flex h-[35px] items-center gap-2 pl-2.5">
                {priced ? flow.arrives.map(({ pool, amount }) => <span key={pool}>{amountText(amount, pool, 'text-xs')}</span>) : <span className="text-ink-500">–</span>}
              </div>
            </>
          ) : stacked ? (
            <>
              {walletRows(toLabel, flow.arrives, priced)}
              {flow.hasBorrow && <span className="text-ink-400">{t('accounts.moveCash.repays')}</span>}
            </>
          ) : (
            flow.arrives.map(({ pool, amount }, i) => (
              <WalletLine key={pool} label={i === 0 ? toLabel : undefined} wallet={walletName(pool)}>
                {priced && amountText(amount, pool)}
                {flow.hasBorrow && <span className="ml-auto text-ink-400">{t('accounts.moveCash.repays')}</span>}
              </WalletLine>
            ))
          )}
        </WalletBox>
      </div>
    </div>
  );
}
