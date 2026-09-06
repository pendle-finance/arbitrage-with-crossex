import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useOpenOrders, usePositions } from '../api/queries';
import { fmtAge } from '../lib/fmt';
import { useNow } from '../lib/useNow';

/** Shared "⟳ Ns ago" freshness button: a ticking age since `dataUpdatedAt`,
 * amber "stale Ns — retrying" while `staleError`, "⟳ —" before the first
 * data. `dense` = the tighter py-0.5 variant for inline header strips. */
export function FreshnessButton({
  dataUpdatedAt,
  staleError,
  title,
  onRefetch,
  dense,
  className,
}: {
  dataUpdatedAt: number;
  staleError: boolean;
  title: string;
  onRefetch: () => void;
  dense?: boolean;
  /** Replaces the default box — the header row passes `hdr-ctl` so this chip
   * is the same height as everything beside it. Colours stay below. */
  className?: string;
}) {
  const now = useNow(1000);
  if (!dataUpdatedAt) return <span className="num text-xs text-ink-500">⟳ —</span>;
  const age = fmtAge(now - dataUpdatedAt);
  return (
    <button
      type="button"
      onClick={onRefetch}
      title={title}
      className={`num ${className ?? `rounded-md border px-2 ${dense ? 'py-0.5' : 'py-1'} text-xs transition-colors`} ${
        staleError
          ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
          : 'border-ink-700 bg-ink-900 text-ink-400 hover:border-ink-500 hover:text-ink-200'
      }`}
    >
      {staleError ? `stale ${age} — retrying` : `⟳ ${age} ago`}
    </button>
  );
}

/** "⟳ 3s ago" ticking freshness for the monitoring queries; turns amber
 * ("stale Ns — retrying") when any of them errors while stale data is still
 * displayed. Click = refetch everything. */
export function FreshnessIndicator() {
  const account = useAccount();
  const positions = usePositions();
  const orders = useOpenOrders();
  const qc = useQueryClient();

  const queries = [account, positions, orders];
  const newest = Math.max(0, ...queries.map((q) => q.dataUpdatedAt || 0));
  const staleError = queries.some((q) => q.isError && q.data !== undefined);

  return (
    <FreshnessButton
      dataUpdatedAt={newest}
      staleError={staleError}
      title="Refetch all panels"
      className="hdr-ctl font-normal"
      onRefetch={() => void qc.invalidateQueries()}
    />
  );
}
