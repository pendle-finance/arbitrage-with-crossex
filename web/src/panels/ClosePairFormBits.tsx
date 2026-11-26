import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewResult } from '../api/types';
import { VenueIcon } from '../components/AssetIcon';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { SignedNumber } from '../components/SignedNumber';
import { AmountPresets } from '../components/AmountPresets';
import { fieldValue, fmtDateLocal, fmtUsd, prettyVenue, qtyGrouped } from '../lib/fmt';
import { decimalsOf, stripZeros } from '../lib/ticks';
import { EstimateAge, EstimateRow, LegTable, SummaryCard } from '../trade/PairTicketBits';
import { PreviewFallback } from '../trade/previewBits';
import { FieldLabel } from '../trade/SymbolCombobox';
import { fmtTradeCost } from '../trade/TicketEstimateBits';

const UNKNOWN_LOT_DECIMALS = 8;

const CLOSE_SHARES = ['25', '50', '75', '100'] as const;

type CloseShare = (typeof CLOSE_SHARES)[number];

const shareText = (max: number, share: number) => fieldValue((max * share) / 100);

export function CloseSizePresets({
  label,
  inputLabel,
  coin,
  max,
  value,
  invalid,
  onChange,
  children,
}: {
  label: string;
  inputLabel: string;
  coin: string;
  max: number;
  value: string;
  invalid: boolean;
  onChange: (text: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const typed = Number(value);
  const typedOk = value.trim() !== '' && Number.isFinite(typed);
  const lit: CloseShare | null = typedOk ? (CLOSE_SHARES.find((share) => Number(shareText(max, Number(share))) === typed) ?? null) : null;
  const pct = typedOk && !invalid && max > 0 ? Math.round((typed / max) * 100) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <AmountPresets<CloseShare>
        value={value}
        onChange={onChange}
        inputLabel={inputLabel}
        suffix={pct === null ? coin : t('accounts.deleverTab.sizeSuffix', { coin, pct })}
        bad={invalid}
        boxClassName="w-48"
        presetsLabel={t('assetCard.roll.shareShortcuts')}
        preset={lit}
        onPreset={(share) => onChange(shareText(max, Number(share)))}
        presets={CLOSE_SHARES.map((share) => ({ value: share, label: `${share}%` }))}
        custom={{
          label: t('accounts.deleverTab.custom'),
          unit: '%',
          inputLabel: t('accounts.deleverTab.customPctAria'),
          max: 100,
          onApply: (share) => onChange(shareText(max, share)),
        }}
      />
      {children}
    </div>
  );
}

function decimalText(units: bigint, decimals: number): string {
  if (decimals === 0) return String(units);
  const scale = 10n ** BigInt(decimals);
  return stripZeros(`${units / scale}.${(units % scale).toString().padStart(decimals, '0')}`);
}

export function matchedCloseOf(
  legQtys: number[],
  typedQty: number | null,
  lots: Array<string | undefined>,
): { qty: string; whole: boolean[]; rests: string[] } {
  const known = lots.every((lot) => lot !== undefined && Number(lot) > 0);
  const decimals = known ? Math.max(...lots.map((lot) => decimalsOf(lot as string))) : UNKNOWN_LOT_DECIMALS;
  const scale = 10 ** decimals;
  const lotUnits = known
    ? lots.reduce((most, lot) => {
        const units = BigInt(Math.round(Number(lot) * scale));
        return units > most ? units : most;
      }, 1n)
    : 1n;
  const held = legQtys.map((qty) => BigInt(Math.round(qty * scale)));
  const least = held.reduce((min, units) => (units < min ? units : min));
  const cap = typedQty === null ? least : BigInt(Math.floor(typedQty * scale + 1e-6));
  const target = cap < least ? cap : least;
  const floored = (target / lotUnits) * lotUnits;
  const matched = floored > 0n ? floored : target;
  return {
    qty: decimalText(matched, decimals),
    whole: held.map((units) => units === matched),
    rests: held.map((units) => decimalText(units - matched, decimals)),
  };
}

export type CloseAfterRow = { symbol: string; venue: string; side: 'LONG' | 'SHORT'; before: string; after: string };

export function ClosePairCost({
  previews,
  isError,
  error,
  estimating,
  dataUpdatedAt,
  twapOn,
  rows,
  tradeCost,
  slippage,
}: {
  previews: PreviewResult[] | undefined;
  isError: boolean;
  error: unknown;
  estimating: boolean;
  dataUpdatedAt: number;
  twapOn: boolean;
  rows: Array<{ side: 'LONG' | 'SHORT'; p: PreviewResult | undefined; rests: boolean }>;
  tradeCost: number | null;
  slippage: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SummaryCard
      title={t('accounts.moveCash.cost')}
      sub={twapOn ? t('trade.twap.area.wholeRun') : undefined}
      aside={<EstimateAge dataUpdatedAt={dataUpdatedAt} estimating={estimating} isError={isError} />}
    >
      {previews && previews.length > 0 ? (
        <LegTable rows={rows} />
      ) : (
        <div className="text-[11px]">
          <PreviewFallback isError={isError} error={error} />
        </div>
      )}
      {slippage}
      <div className="mt-0.5 border-t border-ink-800 pt-1.5">
        <EstimateRow label={t('pairTicket.bits.tradeCost')} value={fmtTradeCost(tradeCost)} strong />
      </div>
    </SummaryCard>
  );
}

function LegName({ side, venue }: { side: 'LONG' | 'SHORT'; venue: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5">
      <Chip sm tone={side === 'LONG' ? 'green' : 'red'} className="font-semibold">
        {t(side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}
      </Chip>
      <VenueIcon venue={venue} size={16} />
      {prettyVenue(venue)}
    </span>
  );
}

export type ClosePairLegPnl = { venue: string; side: 'LONG' | 'SHORT'; pnl: number | null };

export function ClosePairAfter({
  base,
  twapOn,
  totalPnl,
  legPnl,
  rows,
  borosUnhedged,
  bookedBefore,
}: {
  base: string;
  twapOn: boolean;
  totalPnl: number | null;
  legPnl: ClosePairLegPnl[];
  rows: CloseAfterRow[];
  borosUnhedged: { qty: number; coin: string } | null;
  bookedBefore: { usd: number; sinceSec: number } | null;
}) {
  const { t } = useTranslation();
  const before = bookedBefore !== null && Math.abs(bookedBefore.usd) >= 0.005 ? bookedBefore : null;
  const total = totalPnl !== null ? totalPnl + (before?.usd ?? 0) : null;
  return (
    <SummaryCard title={t('accounts.moveCash.after')}>
      <EstimateRow
        label={
          <HoverCard label={t('accounts.closePair.priceBooked')} widthPx={300}>
            <span className="flex flex-col gap-1">
              <span>
                {bookedBefore !== null
                  ? t('accounts.closePair.priceBookedSince', { date: fmtDateLocal(bookedBefore.sinceSec) })
                  : t('accounts.closePair.priceBookedHover')}
              </span>
              {legPnl.map((l) => (
                <span key={`${l.venue}-${l.side}`} className="flex justify-between gap-4">
                  <span>{`${prettyVenue(l.venue)} ${t(l.side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}`}</span>
                  <span className="num">
                    {l.pnl !== null ? <SignedNumber value={l.pnl} format={(n) => fmtUsd(n)} /> : '—'}
                  </span>
                </span>
              ))}
              {before !== null && (
                <span className="flex justify-between gap-4">
                  <span>{t('accounts.closePair.bookedBefore')}</span>
                  <span className="num">
                    <SignedNumber value={before.usd} format={(n) => fmtUsd(n)} />
                  </span>
                </span>
              )}
            </span>
          </HoverCard>
        }
        sub={twapOn ? t('accounts.closePair.twap.headlineSub') : undefined}
        value={total !== null ? <SignedNumber value={total} format={(n) => fmtUsd(n)} /> : '—'}
        strong
      />
      {(rows.length > 0 || borosUnhedged) && (
        <div className="flex flex-col gap-1.5 border-t border-ink-800 pt-1.5">
          {rows.map((r) => (
            <EstimateRow
              key={r.symbol}
              label={<LegName side={r.side} venue={r.venue} />}
              value={`${qtyGrouped(r.before)} ${base} → ${qtyGrouped(r.after)} ${base}`}
            />
          ))}
          {borosUnhedged && (
            <EstimateRow
              label={t('accounts.closePair.after.boros')}
              value={
                <span className="text-amber-300">
                  {t('accounts.closePair.after.borosUnhedged', { qty: qtyGrouped(borosUnhedged.qty), coin: borosUnhedged.coin })}
                </span>
              }
            />
          )}
        </div>
      )}
    </SummaryCard>
  );
}
