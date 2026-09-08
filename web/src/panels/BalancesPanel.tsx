import { useAccount } from '../api/queries';
import type { CrossexAsset } from '../api/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';
import { MarginBreakdown } from '../components/MarginDonut';
import { SignedNumber } from '../components/SignedNumber';
import { TableSkeleton, TilesSkeleton } from '../components/Skeleton';
import { sig } from '../lib/fmt';
import { RebalanceSection } from './RebalanceSection';

const ASSET_COLUMNS: Column<CrossexAsset>[] = [
  {
    key: 'coin',
    header: 'Coin',
    render: (a) => (
      <span className="inline-flex items-baseline gap-2">
        <span className="font-mono font-semibold text-ink-100">{a.coin}</span>
        <span className="text-[10px] text-ink-500">{a.exchangeType}</span>
      </span>
    ),
  },
  { key: 'equity', header: 'Equity', align: 'right', render: (a) => <span className="num">{sig(a.equity)}</span> },
  { key: 'balance', header: 'Balance', align: 'right', render: (a) => <span className="num">{sig(a.balance)}</span> },
  {
    key: 'available',
    header: 'Available',
    align: 'right',
    render: (a) => <span className="num">{sig(a.availableBalance)}</span>,
  },
  {
    key: 'upnl',
    header: 'uPnL',
    align: 'right',
    render: (a) => <SignedNumber value={a.upnl} format={(n) => sig(n)} />,
  },
];

/** Balances tab: collateral stat tiles + non-zero per-coin assets. */
export function BalancesPanel() {
  const { data: acc, isPending, isError, error } = useAccount();

  if (isPending) {
    return (
      <div className="flex flex-col gap-6">
        <TilesSkeleton />
        <TableSkeleton rows={3} cols={5} />
      </div>
    );
  }
  if (isError && !acc) {
    return <QueryError title="Couldn't load account" error={error} />;
  }
  if (!acc) return null;

  const assets = (acc.assets ?? []).filter(
    (a) => Number(a.equity) !== 0 || Number(a.balance) !== 0 || Number(a.upnl) !== 0,
  );

  return (
    <div className="flex flex-col gap-6">
      <MarginBreakdown acc={acc} />

      <RebalanceSection />

      <section aria-label="Assets">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
          Assets <span className="normal-case text-ink-500">— non-zero only</span>
        </h2>
        <DataTable
          columns={ASSET_COLUMNS}
          rows={assets}
          rowKey={(a) => `${a.exchangeType}:${a.coin}`}
          emptyState={<EmptyState icon="○" title="No non-zero balances" hint="Deposit collateral to CrossEx to get started." />}
        />
      </section>
    </div>
  );
}
