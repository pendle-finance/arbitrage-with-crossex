import { useAccount } from '../api/queries';
import { fmtUsd } from '../lib/fmt';
import { MarginBreakdown } from './MarginDonut';
import { Skeleton } from './Skeleton';

/** Header strip: available/balance and the margin meters. (Account uPnL used
 * to sit here; on a delta-neutral book it is noise — the asset cards carry
 * the PnL that means something.) */
export function AccountHealthStrip() {
  const { data: acc } = useAccount();
  if (!acc) {
    return (
      <div className="ml-auto flex items-center justify-end gap-4">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  // ml-auto: the account cluster belongs at the FAR RIGHT of the bar, against
  // the controls — beside the wordmark it read as part of the product name.
  // Whole dollars: cents in a 12px header are unreadable and never actionable;
  // the exact figures are one hover away on the Balances tab.
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs">
        <span className="text-ink-400">Avail</span>
        <span className="num font-medium text-ink-50">{fmtUsd(acc.availableMargin, 0)}</span>
        <span className="text-ink-600">/</span>
        <span className="text-ink-400">Balance</span>
        <span className="num font-medium text-ink-50">{fmtUsd(acc.marginBalance, 0)}</span>
      </span>
      <MarginBreakdown acc={acc} variant="compact" />
    </div>
  );
}
