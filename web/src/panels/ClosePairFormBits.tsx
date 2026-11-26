import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewResult } from '../api/types';
import { SignedNumber } from '../components/SignedNumber';
import { fmtUsd } from '../lib/fmt';
import { decimalsOf, stripZeros } from '../lib/ticks';
import { EstimateHeadline } from '../trade/EstimateHeadline';
import { EstimateCard, EstimateRow } from '../trade/PairTicketBits';
import { PreviewFallback, ViolationList } from '../trade/previewBits';
import { BookToggle, fmtTradeCost, PlanLine, type PlanRole } from '../trade/TicketEstimateBits';

const UNKNOWN_LOT_DECIMALS = 8;

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

export function ClosePairEstimate({
  previews,
  isError,
  error,
  estimating,
  dataUpdatedAt,
  twapOn,
  totalPnl,
  tradeCost,
  plan,
  book,
}: {
  previews: PreviewResult[] | undefined;
  isError: boolean;
  error: unknown;
  estimating: boolean;
  dataUpdatedAt: number;
  twapOn: boolean;
  totalPnl: number | null;
  tradeCost: number | null;
  plan: Array<{ symbol: string; side: 'LONG' | 'SHORT'; role: PlanRole; qty: string | undefined }>;
  book: ReactNode;
}) {
  const { t } = useTranslation();
  const [showBook, setShowBook] = useState(false);
  return (
    <EstimateCard
      dataUpdatedAt={dataUpdatedAt}
      estimating={estimating}
      isError={isError}
      sub={twapOn ? t('trade.twap.area.wholeRun') : undefined}
      aside={<BookToggle on={showBook} onToggle={() => setShowBook((v) => !v)} />}
    >
      {previews && previews.length > 0 ? (
        <>
          <EstimateHeadline
            label={t('accounts.closePair.pnlToRealise')}
            sub={t(twapOn ? 'accounts.closePair.twap.headlineSub' : 'accounts.closePair.pnlSub')}
            value={totalPnl !== null ? <SignedNumber value={totalPnl} format={(n) => fmtUsd(n)} /> : '—'}
          />
          {plan.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {plan.map((line) => (
                <PlanLine key={line.symbol} side={line.side} symbol={line.symbol} role={line.role} qty={line.qty} />
              ))}
            </div>
          )}
          {showBook && <div className="pt-1">{book}</div>}
          <div className="flex flex-col gap-1.5 border-t border-ink-800/80 pt-2">
            <EstimateRow label={t('pairTicket.bits.tradeCost')} value={fmtTradeCost(tradeCost)} />
          </div>
          <ViolationList
            violations={previews.flatMap((p) => p.violations ?? [])}
            warnings={previews.flatMap((p) => p.warnings ?? [])}
          />
        </>
      ) : (
        <div className="text-[11px]">
          <PreviewFallback isError={isError} error={error} />
        </div>
      )}
    </EstimateCard>
  );
}
