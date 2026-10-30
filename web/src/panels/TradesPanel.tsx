import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
import { t as tr } from '../i18n';
import { bps, fmtTime, num, sig, toDate } from '../lib/fmt';

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

const ROLE_LABEL = {
  maker: 'opportunities.trades.roleMaker',
  taker: 'opportunities.trades.roleTaker',
  mixed: 'opportunities.trades.roleMixed',
} as const satisfies Record<Role, string>;

function RoleChip({ role }: { role: Role }) {
  const { t } = useTranslation();
  return <Chip sm tone={ROLE_TONE[role]}>{t(ROLE_LABEL[role])}</Chip>;
}

/** "LMT IOC" / "Post-only" / "MKT" from the joined order (join=1), when present. */
function orderTypeLabel(t: Trade): string | null {
  if (!t.orderType) return null;
  const type = t.orderType.toUpperCase();
  if (type === 'MARKET') return tr('opportunities.trades.typeMarket');
  const tif = (t.orderTif ?? '').toUpperCase();
  if (tif === 'POC') return tr('opportunities.orders.postOnly');
  const base = type === 'LIMIT' ? tr('opportunities.trades.typeLimit') : type;
  return tif ? `${base} ${tif}` : base;
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
    header: <Trans i18nKey="opportunities.trades.transaction" />,
    render: (t) => <span className="num text-xs text-ink-400">{t.transactionId}</span>,
  },
  // Fixed dp per column (qty 4, fee 4, PnL 2) so the decimal points align.
  { key: 'qty', header: <Trans i18nKey="opportunities.trades.qty" />, align: 'right', render: (t) => <span className="num">{num(t.qty, 4)}</span> },
  { key: 'price', header: <Trans i18nKey="opportunities.trades.price" />, align: 'right', render: (t) => <span className="num">{sig(t.price)}</span> },
  {
    key: 'fee',
    header: <Trans i18nKey="common.fee" />,
    align: 'right',
    render: (t) => <span className="num">{`${num(t.fee, 4)} ${t.feeCoin}`}</span>,
  },
  {
    key: 'rate',
    header: <Trans i18nKey="opportunities.trades.rate" />,
    align: 'right',
    render: (t) => <span className="num text-ink-300">{bps(t.feeRate)}</span>,
  },
  { key: 'role', header: <Trans i18nKey="opportunities.trades.role" />, render: (t) => <RoleChip role={asRole(t.matchRole)} /> },
  {
    key: 'rpnl',
    header: <Trans i18nKey="opportunities.trades.rpnl" />,
    align: 'right',
    render: (t) => <SignedNumber value={t.rpnl} format={(n) => num(n, 2)} />,
  },
];

const GROUP_COLUMNS: Column<OrderGroup>[] = [
  { key: 'time', header: <Trans i18nKey="opportunities.trades.time" />, render: (g) => <span className="num text-xs text-ink-300">{fmtTime(g.time)}</span> },
  { key: 'symbol', header: <Trans i18nKey="opportunities.trades.symbol" />, render: (g) => <SymbolCell symbol={g.symbol} /> },
  { key: 'side', header: <Trans i18nKey="common.side" />, render: (g) => <SideChip side={g.side} /> },
  { key: 'qty', header: <Trans i18nKey="opportunities.trades.qty" />, align: 'right', render: (g) => <span className="num">{num(g.totalQty, 4)}</span> },
  { key: 'avg', header: <Trans i18nKey="opportunities.trades.avgPrice" />, align: 'right', render: (g) => <span className="num">{sig(g.avgPrice)}</span> },
  {
    key: 'fee',
    header: <Trans i18nKey="common.fee" />,
    align: 'right',
    render: (g) => <span className="num">{`${num(g.totalFee, 4)} ${g.feeCoin}`}</span>,
  },
  {
    key: 'rate',
    header: <Trans i18nKey="opportunities.trades.rate" />,
    align: 'right',
    render: (g) => <span className="num text-ink-300">{bps(g.feeRate)}</span>,
  },
  { key: 'role', header: <Trans i18nKey="opportunities.trades.role" />, render: (g) => <RoleChip role={g.role} /> },
  {
    key: 'type',
    header: <Trans i18nKey="opportunities.trades.type" />,
    render: (g) => (g.typeLabel ? <Chip sm className="num">{g.typeLabel}</Chip> : <span className="text-ink-500">—</span>),
  },
  {
    key: 'fills',
    header: <Trans i18nKey="opportunities.trades.fills" />,
    align: 'right',
    render: (g) => <span className="num text-ink-300">{g.fills.length}</span>,
  },
];

const FLAT_COLUMNS: Column<Trade>[] = [
  {
    key: 'time',
    header: <Trans i18nKey="opportunities.trades.time" />,
    render: (t) => <span className="num text-xs text-ink-300">{fmtTime(toDate(t.createTime))}</span>,
  },
  { key: 'symbol', header: <Trans i18nKey="opportunities.trades.symbol" />, render: (t) => <SymbolCell symbol={t.symbol} /> },
  { key: 'side', header: <Trans i18nKey="common.side" />, render: (t) => <SideChip side={t.side} /> },
  ...FILL_COLUMNS.filter((c) => c.key !== 'txn'),
];

/** Trades tab: fills joined to their orders, grouped by order by default. */
export function TradesPanel() {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<Mode>('grouped');
  const [filter, setFilter] = useState('');
  const query = useTrades();

  const trades = useMemo(() => query.data?.pages?.flatMap((p) => p.trades) ?? [], [query.data]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? trades.filter((t) => t.symbol.toLowerCase().includes(q)) : trades;
  }, [trades, filter]);
  const groups = useMemo(
    () => (mode === 'grouped' ? groupByOrder(filtered) : []),
    [mode, filtered, i18n.language],
  );

  if (query.isPending) return <TableSkeleton rows={8} cols={8} />;
  if (query.isError && !query.data) {
    return <QueryError title={t('opportunities.trades.loadError')} error={query.error} />;
  }

  const empty = (
    <EmptyState icon="≋" title={t('opportunities.trades.emptyTitle')} hint={t('opportunities.trades.emptyHint')} />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedToggle<Mode>
          ariaLabel={t('opportunities.trades.groupingAria')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'grouped', label: t('opportunities.trades.groupByOrder') },
            { value: 'flat', label: t('opportunities.trades.flatFills') },
          ]}
        />
        <input
          className="input w-52"
          placeholder={t('opportunities.trades.filterPlaceholder')}
          aria-label={t('opportunities.trades.filterAria')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="num ml-auto text-xs text-ink-500">
          {t('opportunities.trades.loaded', { count: filtered.length })}
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
          {t('opportunities.trades.loadMore')}
        </button>
      )}
    </div>
  );
}
