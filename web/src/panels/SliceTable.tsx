import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { SliceOption } from '../api/types';
import { RadioRow } from '../components/RadioRow';
import { microLabelClass } from '../components/Th';
import { t } from '../i18n';
import { fmtAbout, fmtNotionalShort, fmtPct, fmtUsd, fmtUsdCompact, num } from '../lib/fmt';
import type { ExecMode } from '../trade/PairTicketBits';
import { sizeText } from './rebalanceCopy';

export const MAX_SLIPPAGE_RATIO = 0.0025;

const COLS = ['w-14', 'w-28', 'w-24', 'w-28'] as const;

function presetLabel(sizeUsd: number): string {
  if (sizeUsd === 25_000) return t('accounts.slices.row25');
  if (sizeUsd === 50_000) return t('accounts.slices.row50');
  if (sizeUsd === 100_000) return t('accounts.slices.row100');
  if (sizeUsd === 250_000) return t('accounts.slices.row250');
  return fmtUsdCompact(sizeUsd);
}

function Cells({ values }: { values: ReactNode[] }) {
  return (
    <>
      {values.map((value, i) => (
        <span key={i} className={`num ${COLS[i]} shrink-0 text-right text-ink-100`}>
          {value}
        </span>
      ))}
    </>
  );
}

interface SliceTableProps {
  options: SliceOption[];
  value: number;
  exec: ExecMode;
  onPick: (sizeUsd: number) => void;
  customText: string;
  onCustom: (text: string) => void;
  coin?: string;
}

export function SliceSizeRow({
  sizeUsd,
  count,
  open,
  onToggle,
  table,
}: {
  sizeUsd: number;
  count: number;
  open: boolean;
  onToggle: () => void;
  table: SliceTableProps;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 rounded border border-ink-800 px-3 py-2 text-xs">
        <span className="num min-w-0 flex-1 text-ink-100">{t('accounts.realizeTab.sliceSize', { size: fmtNotionalShort(sizeUsd), count })}</span>
        <button type="button" className="btn-link inline-flex cursor-pointer items-center gap-1" aria-expanded={open} onClick={onToggle}>
          {t('accounts.slices.change')}
          {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        </button>
      </div>
      {open && <SliceTable {...table} />}
    </div>
  );
}

export function SliceTable({ options, value, exec, onPick, customText, onCustom, coin }: SliceTableProps) {
  const id = useId();
  const presets = options.filter((o) => !o.custom);
  const custom = options.find((o) => o.custom) ?? null;
  const presetPicked = presets.some((o) => o.sizeUsd === value);
  const customPicked = !presetPicked && custom !== null && custom.sizeUsd === value;
  const valuesOf = (o: SliceOption): ReactNode[] => [
    num(o.count, 0),
    fmtAbout(o.seconds[exec]),
    fmtUsd(o.impactUsd, 0),
    coin ? `${sizeText(o.notHedgedMaxQty)} ${coin}` : fmtUsd(o.notHedgedMaxUsd, 0),
  ];
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className={microLabelClass}>{t('accounts.slices.title')}</span>
        <span className={`num ${microLabelClass}`}>{t('accounts.slices.maxSlippage', { pct: fmtPct(MAX_SLIPPAGE_RATIO, 2) })}</span>
      </div>
      <div className="flex items-center gap-3 px-3 text-pp-sm2 text-ink-400">
        <span className="w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{t('accounts.slices.title')}</span>
        {[t('accounts.slices.count'), t('accounts.slices.estTime'), t('accounts.slices.priceImpact'), t('accounts.slices.maxNotHedged')].map(
          (head, i) => (
            <span key={head} className={`${COLS[i]} shrink-0 text-right`}>
              {head}
            </span>
          ),
        )}
      </div>
      <div role="radiogroup" aria-label={t('accounts.slices.title')} className="flex flex-col gap-1">
        {presets.map((o) => (
          <RadioRow
            key={o.sizeUsd}
            name={`${id}-slice`}
            labelledBy={`${id}-${o.sizeUsd}`}
            checked={o.sizeUsd === value}
            onPick={() => onPick(o.sizeUsd)}
          >
            <span id={`${id}-${o.sizeUsd}`} className="num min-w-0 flex-1 text-ink-50">
              {presetLabel(o.sizeUsd)}
            </span>
            <Cells values={valuesOf(o)} />
          </RadioRow>
        ))}
        <RadioRow
          name={`${id}-slice`}
          labelledBy={`${id}-custom`}
          checked={customPicked}
          onPick={() => {
            if (custom !== null) onPick(custom.sizeUsd);
          }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span id={`${id}-custom`} className="text-ink-50">
              {t('accounts.slices.rowCustom')}
            </span>
            <input
              className="input num h-7 w-24"
              inputMode="decimal"
              aria-label={t('accounts.slices.rowCustom')}
              value={customText}
              onChange={(e) => onCustom(e.target.value)}
            />
          </span>
          <Cells values={custom === null ? ['', '', '', ''] : valuesOf(custom)} />
        </RadioRow>
      </div>
    </div>
  );
}
