import { useId, type ReactNode } from 'react';
import type { PriceImpactPreview, SliceOption } from '../api/types';
import { HoverCard } from '../components/HoverCard';
import { RadioRow } from '../components/RadioRow';
import { Switch } from '../components/Switch';
import { microLabelClass } from '../components/Th';
import { t } from '../i18n';
import { fmtAbout, fmtPct, fmtUsd, fmtUsdCompact, num } from '../lib/fmt';
import type { ExecMode } from '../trade/PairTicketBits';
import { ImpactPair } from '../trade/TwapArea';

export const MAX_SLIPPAGE_RATIO = 0.0025;

const COLS = ['w-14', 'w-28', 'w-24'] as const;

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
  dedupe?: boolean;
}

export function SplitArea({
  on,
  onToggle,
  canSplit,
  hover,
  impact,
  table,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  canSplit: boolean;
  hover: string;
  impact: PriceImpactPreview | null;
  table: SliceTableProps;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-ink-700 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <HoverCard
          underline={false}
          wrapsControl
          widthPx={260}
          label={<Switch on={on} onChange={onToggle} disabled={!canSplit} label={t('accounts.realizeTab.split')} />}
        >
          {hover}
        </HoverCard>
        {impact && <ImpactPair impact={impact} on={false} />}
      </div>
      {on && <SliceTable {...table} />}
    </div>
  );
}

function shownRows(options: SliceOption[], value: number, dedupe: boolean): SliceOption[] {
  const presets = options.filter((o) => !o.custom && !o.whole).sort((a, b) => a.sizeUsd - b.sizeUsd);
  if (!dedupe) return presets;
  return presets.filter((o) => {
    const same = presets.filter((other) => other.count === o.count);
    const kept = same.find((other) => other.sizeUsd === value) ?? same[0];
    return kept === o;
  });
}

export function SliceTable({ options, value, exec, onPick, customText, onCustom, dedupe = true }: SliceTableProps) {
  const id = useId();
  const presets = shownRows(options, value, dedupe);
  const custom = options.find((o) => o.custom) ?? null;
  const presetPicked = options.some((o) => !o.custom && !o.whole && o.sizeUsd === value);
  const customPicked = !presetPicked && custom !== null && custom.sizeUsd === value;
  const valuesOf = (o: SliceOption): ReactNode[] => [
    num(o.count, 0),
    fmtAbout(o.seconds[exec]),
    fmtUsd((exec === 'market' ? o.impactUsd : 0) + o.reopenImpactUsd, 0),
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
        {[t('accounts.slices.count'), t('accounts.slices.estTime'), t('accounts.slices.priceImpact')].map(
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
          <Cells values={custom === null ? ['', '', ''] : valuesOf(custom)} />
        </RadioRow>
      </div>
    </div>
  );
}
