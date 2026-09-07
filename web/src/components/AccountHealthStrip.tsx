import type { ReactNode } from 'react';
import { useAccount } from '../api/queries';
import { fmtUsd } from '../lib/fmt';
import { MarginBreakdown } from './MarginDonut';
import { SignedNumber } from './SignedNumber';
import { Skeleton } from './Skeleton';

/** Header strip: available/balance, signed uPnL (sum of asset uPnLs), margin
 * pies, then `children` (the borrow pill) once the account has loaded. */
export function AccountHealthStrip({ children }: { children?: ReactNode }) {
  const { data: acc } = useAccount();
  if (!acc) {
    return (
      <div className="flex items-center gap-6">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  const upnl = (acc.assets ?? []).reduce((sum, a) => sum + (Number(a.upnl) || 0), 0);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <div className="text-sm">
        <span className="text-ink-400">Avail </span>
        <span className="num font-medium text-ink-100">{fmtUsd(acc.availableMargin)}</span>
        <span className="text-ink-500"> / Balance </span>
        <span className="num font-medium text-ink-100">{fmtUsd(acc.marginBalance)}</span>
      </div>
      <div className="text-sm">
        <span className="text-ink-400">uPnL </span>
        <SignedNumber value={upnl} format={(n) => fmtUsd(n)} className="font-medium" />
      </div>
      <MarginBreakdown acc={acc} variant="compact" />
      {children}
      <span className="hidden text-[10px] uppercase tracking-wider text-ink-500 xl:inline">
        {acc.accountMode} · {acc.positionMode}
      </span>
    </div>
  );
}
