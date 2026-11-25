import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { num } from '../lib/fmt';
import { decimalsOf } from '../lib/ticks';
import { AffixedInput } from './PairTicketBits';
import { FieldLabel } from './SymbolCombobox';

export function LimitPriceBox({
  bookPrice,
  value,
  onChange,
  label,
  toBest,
  tick,
  unit = 'USDT',
}: {
  bookPrice: string | null;
  value: string | null;
  onChange: (price: string | null) => void;
  label?: ReactNode;
  toBest?: () => void;
  tick: string;
  unit?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const typed = value !== null;
  const book = bookPrice !== null && bookPrice !== '' && Number.isFinite(Number(bookPrice)) ? num(Number(bookPrice), decimalsOf(tick)) : '';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label ?? t('pairTicket.limitPrice.label')}</FieldLabel>
        {toBest && (
          <button type="button" className="btn-ghost-xs" onClick={toBest}>
            {t('trade.twap.run.toBest')}
          </button>
        )}
      </div>
      <AffixedInput
        affix={
          <span className="flex items-center gap-2">
            {typed ? (
              <button
                type="button"
                aria-label={t('pairTicket.limitPrice.resetAria')}
                title={t('pairTicket.limitPrice.typedHint')}
                onClick={() => onChange(null)}
                className="btn-ghost-xs h-5 gap-1 px-1.5"
              >
                <RotateCcw size={11} aria-hidden />
                {t('pairTicket.limitPrice.auto')}
              </button>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-ink-300"
                title={t('pairTicket.limitPrice.autoHint')}
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {t('pairTicket.limitPrice.auto')}
              </span>
            )}
            <span>{unit}</span>
          </span>
        }
      >
        <input
          id={id}
          className={`input num pr-28 ${typed ? 'text-ink-50' : 'text-ink-400'}`}
          inputMode="decimal"
          placeholder={t('pairTicket.bits.fetchingTouch')}
          value={typed ? value : book}
          onChange={(e) => onChange(e.target.value.replace(/,/g, ''))}
        />
      </AffixedInput>
    </div>
  );
}
