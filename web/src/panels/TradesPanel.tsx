import { useMemo, useState } from 'react';
import { useTrades } from '../api/queries';
import type { Trade } from '../api/types';
import { Chip, type ChipTone } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { SignedNumber } from '../components/SignedNumber';
import { TableSkeleton } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { SideChip, SymbolCell } from '../components/VenueChip';
import { bps, fmtTime, sig, toDate } from '../lib/fmt';

type Mode = 'grouped' | 'flat';
type Role = 'maker' | 'taker' | 'mixed';

/* Maker blue / taker gold, per the mock. The same pair tones Open Orders'
 * state chips — one role palette across both tables, not one per table. */
const ROLE_TONE: Record<Role, ChipTone> = { maker: 'link', taker: 'amber', mixed: 'neutral' };

/** The venue reports MAKER/TAKER uppercase, so a lowercase lookup silently
 * missed and every role chip rendered untoned. Normalise at the boundary. */
export function asRole(v: string): Role {
  const k = v.toLowerCase();
  return k === 'maker' || k === 'taker' ? k : 'mixed';
}

function RoleChip({ role }: { role: Role }) {
  return <Chip sm tone={ROLE_TONE[role]}>{role}</Chip>;
}

/** "LMT IOC" / "LMT POC" / "MKT" from the joined order (join=1), when present. */
function orderTypeLabel(t: Trade): string | null {
  if (!t.orderType) return null;
  const type = t.orderType.toUpperCase();
  if (type === 'MARKET') return 'MKT';
  const base = type === 'LIMIT' ? 'LMT' : type;
  return t.orderTif ? `${base} ${t.orderTif.toUpperCase()}` : base;
}

interface OrderGroup {
  key: string;
  fills: Trade[];
  symbol: string;
  side: string;
  time: Date | null;
  totalQty: number;
  avgPrice: number;
  totalFee: number;
  feeCoin: string;
  /** Notional-weighted effective fee rate (fraction). */
  feeRate: number;
  role: Role;
  typeLabel: string | null;
}

/** Group fills client-side by orderId (qty-weighted avg price, summed fees). */
function groupByOrder(trades: Trade[]): OrderGroup[] {
  const byOrder = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.orderId || t.transactionId;
    const list = byOrder.get(key);
    if (list) list.push(t);
    else byOrder.set(key, [t]);
  }
  return [...byOrder.entries()].map(([key, fills]) => {
    let totalQty = 0;
    let notional = 0;
    let totalFee = 0;
    let weightedRate = 0;
    let earliest: Date | null = null;
    for (const f of fills) {
      const qty = Number(f.qty) || 0;
      const px = Number(f.price) || 0;
      totalQty += qty;
      notional += qty * px;
      totalFee += Number(f.fee) || 0;
      weightedRate += (Number(f.feeRate) || 0) * qty * px;
      const d = toDate(f.createTime);
      if (d && (!earliest || d < earliest)) earliest = d;
    }
    const roles = new Set(fills.map((f) => asRole(f.matchRole)));
    const withType = fills.find((f) => f.orderType);
    return {
      key,
      fills,
      symbol: fills[0].symbol,
      side: fills[0].side,
      time: earliest,
      totalQty,
      avgPrice: totalQty > 0 ? notional / totalQty : 0,
      totalFee,
      feeCoin: fills[0].feeCoin,
      feeRate: notional > 0 ? weightedRate / notional : 0,
      role: roles.size === 1 ? asRole(fills[0].matchRole) : 'mixed',
      typeLabel: withType ? orderTypeLabel(withType) : null,
    };
  });
}

const FILL_COLUMNS: Column<Trade>[] = [
  {
    key: 'txn',
    header: 'Transaction',
    render: (t) => <span className="num text-xs text-ink-400">{t.transactionId}</span>,
  },
  { key: 'qty', header: 'Qty', align: 'right', render: (t) => <span className="num">{sig(t.qty)}</span> },
  { key: 'price', header: 'Price', align: 'right', render: (t) => <span className="num">{sig(t.price)}</span> },
  {
    key: 'fee',
    header: 'Fee',
    align: 'right',
    render: (t) => <span className="num">{`${sig(t.fee)} ${t.feeCoin}`}</span>,
  },
  {
    key: 'rate',
    header: 'Rate',
    align: 'right',
    render: (t) => <span className="num text-ink-300">{bps(t.feeRate)}</span>,
  },
  { key: 'role', header: 'Role', render: (t) => <RoleChip role={asRole(t.matchRole)} /> },
  {
    key: 'rpnl',
    header: 'rPnL',
    align: 'right',
    render: (t) => <SignedNumber value={t.rpnl} format={(n) => sig(n)} />,
  },
];

const GROUP_COLUMNS: Column<OrderGroup>[] = [
  { key: 'time', header: 'Time', render: (g) => <span className="num text-xs text-ink-300">{fmtTime(g.time)}</span> },
  { key: 'symbol', header: 'Symbol', render: (g) => <SymbolCell symbol={g.symbol} /> },
  { key: 'side', header: 'Side', render: (g) => <SideChip side={g.side} /> },
  { key: 'qty', header: 'Qty', align: 'right', render: (g) => <span className="num">{sig(g.totalQty)}</span> },
  { key: 'avg', header: 'Avg price', align: 'right', render: (g) => <span className="num">{sig(g.avgPrice)}</span> },
  {
    key: 'fee',
    header: 'Fee',
    align: 'right',
    render: (g) => <span className="num">{`${sig(g.totalFee)} ${g.feeCoin}`}</span>,
  },
  {
    key: 'rate',
    header: 'Rate',
    align: 'right',
    render: (g) => <span className="num text-ink-300">{bps(g.feeRate)}</span>,
  },
  { key: 'role', header: 'Role', render: (g) => <RoleChip role={g.role} /> },
  {
    key: 'type',
    header: 'Type',
    render: (g) => (g.typeLabel ? <Chip sm className="num">{g.typeLabel}</Chip> : <span className="text-ink-500">—</span>),
  },
  {
    key: 'fills',
    header: 'Fills',
    align: 'right',
    render: (g) => <span className="num text-ink-300">{g.fills.length}</span>,
  },
];

const FLAT_COLUMNS: Column<Trade>[] = [
  {
    key: 'time',
    header: 'Time',
    render: (t) => <span className="num text-xs text-ink-300">{fmtTime(toDate(t.createTime))}</span>,
  },
  { key: 'symbol', header: 'Symbol', render: (t) => <SymbolCell symbol={t.symbol} /> },
  { key: 'side', header: 'Side', render: (t) => <SideChip side={t.side} /> },
  ...FILL_COLUMNS.filter((c) => c.key !== 'txn'),
];

/** Trades tab: fills joined to their orders, grouped by order by default. */
export function TradesPanel() {
  const [mode, setMode] = useState<Mode>('grouped');
  const [filter, setFilter] = useState('');
  const query = useTrades();

  const trades = useMemo(() => query.data?.pages?.flatMap((p) => p.trades) ?? [], [query.data]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? trades.filter((t) => t.symbol.toLowerCase().includes(q)) : trades;
  }, [trades, filter]);
  const groups = useMemo(() => (mode === 'grouped' ? groupByOrder(filtered) : []), [mode, filtered]);

  if (query.isPending) return <TableSkeleton rows={8} cols={8} />;
  if (query.isError && !query.data) {
    return <QueryError title="Couldn't load trades" error={query.error} />;
  }

  const empty = (
    <EmptyState icon="≋" title="No fills yet" hint="Executed trades land here, joined to the order they filled." />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedToggle<Mode>
          ariaLabel="Trade grouping"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'grouped', label: 'Group by order' },
            { value: 'flat', label: 'Flat fills' },
          ]}
        />
        <input
          className="input w-52"
          placeholder="Filter symbol…"
          aria-label="Filter symbol"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="num ml-auto text-xs text-ink-500">
          {filtered.length} fill{filtered.length === 1 ? '' : 's'} loaded
        </span>
      </div>

      {mode === 'grouped' ? (
        <DataTable
          columns={GROUP_COLUMNS}
          rows={groups}
          rowKey={(g) => g.key}
          emptyState={empty}
          renderExpanded={(g) => (
            <DataTable columns={FILL_COLUMNS} rows={g.fills} rowKey={(t) => t.transactionId} maxHeightClass="max-h-64" />
          )}
        />
      ) : (
        <DataTable columns={FLAT_COLUMNS} rows={filtered} rowKey={(t) => t.transactionId} emptyState={empty} />
      )}

      {query.hasNextPage && (
        <button
          type="button"
          className="btn self-center"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage && <Spinner />}
          Load more
        </button>
      )}
    </div>
  );
}
