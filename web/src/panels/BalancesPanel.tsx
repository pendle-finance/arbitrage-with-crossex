import { useRef, useState, type ReactNode } from 'react';
import { useAccount, useRebalance, useTransfer } from '../api/queries';
import type { CrossexAsset, GateAccount, SpotBalance, TransferCoin } from '../api/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { HoverCard } from '../components/HoverCard';
import { QueryError } from '../components/QueryError';
import { MarginBreakdown } from '../components/MarginDonut';
import { SignedNumber } from '../components/SignedNumber';
import { TableSkeleton, TilesSkeleton } from '../components/Skeleton';
import { borrowingBuckets } from '../lib/borrow';
import { num } from '../lib/fmt';
import { HOVER } from './rebalanceCopy';
import { Term } from './RebalanceHovers';
import { RebalanceSection } from './RebalanceSection';
import { NoSpotReadHow } from './TransferBits';
import { TransferSection } from './TransferSection';
import type { TransferPick } from './TransferModal';

const NO_SPOT_READ_TEXT = 'Add Spot read permission to see spot balances.';

type AssetRow =
  | { kind: 'crossex'; asset: CrossexAsset }
  | { kind: 'spotGroup' }
  | { kind: 'noSpotRead' }
  | { kind: 'spot'; spot: SpotBalance };

function CoinCell({ coin, account }: { coin: string; account: string }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-semibold text-ink-100">{coin}</span>{' '}
      <span className="text-[10px] text-ink-500">{account}</span>
    </span>
  );
}

function NoSpotReadRow() {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-ink-200">{NO_SPOT_READ_TEXT}</span>
      <HoverCard label={<span className="text-link">How ▸</span>} icon={false} underline={false}>
        <NoSpotReadHow />
      </HoverCard>
    </span>
  );
}

function coinCell(row: AssetRow): ReactNode {
  if (row.kind === 'crossex') return <CoinCell coin={row.asset.coin} account={row.asset.exchangeType} />;
  if (row.kind === 'spot') return <CoinCell coin={row.spot.coin} account="SPOT" />;
  if (row.kind === 'noSpotRead') return <NoSpotReadRow />;
  const label = <span className="text-[10px] font-semibold uppercase tracking-wider text-gold">Gate spot</span>;
  return <Term label={label} text={HOVER.gateSpotAssets} />;
}

function amountCell(value: number | string | null): ReactNode {
  return value === null ? null : <span className="num">{num(value, 2)}</span>;
}

const ASSET_COLUMNS: Column<AssetRow>[] = [
  { key: 'coin', header: 'Coin', render: coinCell },
  // Fixed 2dp on every money column: tabular figures only line up when the
  // decimal point sits in the same place on every row.
  {
    key: 'equity',
    header: 'Equity',
    align: 'right',
    render: (row) => amountCell(row.kind === 'crossex' ? row.asset.equity : null),
  },
  {
    key: 'balance',
    header: 'Balance',
    align: 'right',
    render: (row) => {
      if (row.kind === 'crossex') return amountCell(row.asset.balance);
      return amountCell(row.kind === 'spot' ? row.spot.available + row.spot.locked : null);
    },
  },
  {
    key: 'available',
    header: 'Available',
    align: 'right',
    render: (row) => {
      if (row.kind === 'crossex') return amountCell(row.asset.availableBalance);
      return amountCell(row.kind === 'spot' ? row.spot.available : null);
    },
  },
  {
    key: 'upnl',
    header: 'uPnL',
    align: 'right',
    render: (row) =>
      row.kind === 'crossex' ? <SignedNumber value={row.asset.upnl} format={(n) => num(n, 2)} /> : null,
  },
];

function rowKeyOf(row: AssetRow): string {
  if (row.kind === 'crossex') return `${row.asset.exchangeType}:${row.asset.coin}`;
  if (row.kind === 'spot') return `spot:${row.spot.coin}`;
  return row.kind;
}

function spotRows(spot: SpotBalance[] | null | undefined): AssetRow[] {
  if (spot === undefined) return [];
  if (spot === null) return [{ kind: 'spotGroup' }, { kind: 'noSpotRead' }];
  const held = spot.filter((row) => row.available + row.locked > 0).map((row): AssetRow => ({ kind: 'spot', spot: row }));
  return held.length === 0 ? [] : [{ kind: 'spotGroup' }, ...held];
}

/** Balances tab: collateral stat tiles + non-zero per-coin assets. */
export function BalancesPanel() {
  const { data: acc, isPending, isError, error } = useAccount();
  const spot = useTransfer().data?.spot;
  const buckets = useRebalance().data?.buckets;
  const [pick, setPick] = useState<TransferPick | null>(null);
  const transferCard = useRef<HTMLDivElement>(null);

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

  const assets = (acc.assets ?? [])
    .filter((a) => Number(a.equity) !== 0 || Number(a.balance) !== 0 || Number(a.upnl) !== 0)
    .map((asset): AssetRow => ({ kind: 'crossex', asset }));
  const rows = assets.length === 0 && spot === null ? [] : [...assets, ...spotRows(spot)];
  const borrowing = borrowingBuckets(buckets);
  const borrowImUsd = borrowing.length === 0 ? null : borrowing.reduce((sum, b) => sum + b.imHeldUsd, 0);

  const openTransfer = (coin: TransferCoin, wallet: GateAccount) => {
    setPick((prev) => ({ coin, wallet, nonce: (prev?.nonce ?? 0) + 1 }));
    transferCard.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="balances-tabpanel">
      <MarginBreakdown acc={acc} borrowImUsd={borrowImUsd} />

      <RebalanceSection onTransfer={openTransfer} />

      <div ref={transferCard}>
        <TransferSection pick={pick} />
      </div>

      <section aria-label="Assets">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
          Assets <span className="normal-case text-ink-500">· non-zero only</span>
        </h2>
        <DataTable
          columns={ASSET_COLUMNS}
          rows={rows}
          rowKey={rowKeyOf}
          maxHeightClass="max-h-none"
          emptyState={<EmptyState icon="○" title="No non-zero balances" hint="Deposit collateral to CrossEx to get started." />}
        />
        {assets.length === 0 && spot === null && <NoSpotReadRow />}
      </section>
    </div>
  );
}
