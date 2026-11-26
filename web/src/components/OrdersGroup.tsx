import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtUsd } from '../lib/fmt';
import type { ExecMode } from '../trade/PairTicketBits';
import { ExecModeLabel } from './Approx';
import { HoverCard } from './HoverCard';
import { SegmentedToggle } from './SegmentedToggle';
import { microLabelClass } from './Th';

const ORDER: ExecMode[] = ['maker', 'market'];

export type PerMode<T> = Record<ExecMode, T>;

export const MARKET_ORDER_SEC = 2;

export const perMode = <T,>(of: (mode: ExecMode) => T): PerMode<T> => ({ maker: of('maker'), market: of('market') });

const costText = (usd: number | null) => (usd === null ? '—' : fmtUsd(usd, usd < 10 ? 2 : 0));

export function OrdersGroup({
  value,
  onChange,
  cost,
  seconds,
  whole,
  children,
}: {
  value: ExecMode;
  onChange: (m: ExecMode) => void;
  cost: PerMode<number | null>;
  seconds: PerMode<number | null>;
  whole: PerMode<boolean>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const label = t('pairTicket.orderType.label');
  return (
    <div className="flex flex-col gap-1.5">
      <span className={microLabelClass}>
        <HoverCard icon={false} widthPx={340} label={label}>
          <div className="flex flex-col gap-1.5 text-xs leading-snug">
            <p>
              <span className="text-ink-100">{t('pairTicket.orderType.limitHedge')}</span> · {t('pairTicket.orderType.hoverMaker')}
            </p>
            <p>
              <span className="text-ink-100">{t('pairTicket.orderType.market')}</span> · {t('pairTicket.orderType.hoverMarket')}
            </p>
            <p className="text-ink-400">{t('pairTicket.orderType.hoverFigures')}</p>
          </div>
        </HoverCard>
      </span>
      <div className="order-stack">
        <SegmentedToggle<ExecMode>
          ariaLabel={label}
          fill
          value={value}
          onChange={onChange}
          options={ORDER.map((mode) => ({
            value: mode,
            label: <ExecModeLabel mode={mode} usd={costText(cost[mode])} seconds={seconds[mode]} whole={whole[mode]} />,
          }))}
        />
        {children}
      </div>
    </div>
  );
}
