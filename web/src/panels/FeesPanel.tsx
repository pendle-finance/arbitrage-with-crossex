import { useFees } from '../api/queries';
import type { SpecialFee, VenueFees } from '../api/types';
import { Chip } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';
import { TableSkeleton } from '../components/Skeleton';
import { VENUE_QUOTE_NOTE, VenueChip } from '../components/VenueChip';
import { bps, feePct } from '../lib/fmt';

/** "0.0200% (2.0 bps)" — rebates (negative) render green. */
function FeeCell({ rate }: { rate: string }) {
  const n = Number(rate);
  const rebate = Number.isFinite(n) && n < 0;
  return (
    <span className={`num ${rebate ? 'text-emerald-400' : 'text-ink-100'}`}>
      {feePct(rate)} <span className={rebate ? 'text-emerald-500/70' : 'text-ink-500'}>({bps(rate)})</span>
    </span>
  );
}

const SPECIAL_COLUMNS: Column<SpecialFee>[] = [
  { key: 'symbol', header: 'Symbol', render: (s) => <span className="num text-[12px] text-ink-50">{s.symbol}</span> },
  { key: 'maker', header: 'Maker', align: 'right', render: (s) => <FeeCell rate={s.makerFeeRate} /> },
  { key: 'taker', header: 'Taker', align: 'right', render: (s) => <FeeCell rate={s.takerFeeRate} /> },
];

const COLUMNS: Column<VenueFees>[] = [
  {
    key: 'venue',
    header: 'Venue',
    render: (v) => (
      <span className="inline-flex items-center gap-2">
        {/* VenueChip already carries the venue's mark — a second one here read
            as two logos for one exchange. */}
        <VenueChip exchange={v.exchangeType} />
        {VENUE_QUOTE_NOTE[v.exchangeType] && (
          <span className="text-[11px] text-ink-500">{VENUE_QUOTE_NOTE[v.exchangeType]}</span>
        )}
      </span>
    ),
  },
  { key: 'pm', header: 'Perp maker', align: 'right', render: (v) => <FeeCell rate={v.futureMakerFee} /> },
  { key: 'pt', header: 'Perp taker', align: 'right', render: (v) => <FeeCell rate={v.futureTakerFee} /> },
  { key: 'sm', header: 'Spot maker', align: 'right', render: (v) => <FeeCell rate={v.spotMakerFee} /> },
  { key: 'st', header: 'Spot taker', align: 'right', render: (v) => <FeeCell rate={v.spotTakerFee} /> },
  {
    key: 'specials',
    header: 'Specials',
    align: 'right',
    render: (v) =>
      v.specialFeeList?.length ? (
        <Chip sm tone="amber" className="num" title="Per-symbol overrides — expand the row">
          {v.specialFeeList.length}
        </Chip>
      ) : (
        <span className="text-ink-600">—</span>
      ),
  },
];

/** Fees tab. Gate exposes no tier NAME — these are the account's effective rates. */
export function FeesPanel() {
  const { data, isPending, isError, error } = useFees();

  if (isPending) return <TableSkeleton rows={7} cols={6} />;
  if (isError && !data) {
    return <QueryError title="Couldn't load fees" error={error} />;
  }

  const venues = (data ?? []).slice().sort((a, b) => a.exchangeType.localeCompare(b.exchangeType));

  return (
    <section aria-label="Fee rates">
      <h2 className="mb-2 text-[14px] font-semibold text-ink-50">
        Your CrossEx fee rates{' '}
        <span className="normal-case text-ink-500">— per venue · negative maker = rebate</span>
      </h2>
      <DataTable
        columns={COLUMNS}
        rows={venues}
        rowKey={(v) => v.exchangeType}
        emptyState={<EmptyState icon="％" title="No fee data" />}
        renderExpanded={(v) =>
          v.specialFeeList?.length ? (
            <div>
              <div className="mb-2 text-[12px] font-normal leading-[14.52px] text-ink-300">
                Per-symbol overrides ({v.specialFeeList.length})
              </div>
              <DataTable
                columns={SPECIAL_COLUMNS}
                rows={v.specialFeeList}
                rowKey={(s) => s.symbol}
                maxHeightClass="max-h-64"
              />
            </div>
          ) : (
            <span className="text-xs text-ink-500">No per-symbol overrides on {v.exchangeType}.</span>
          )
        }
      />
    </section>
  );
}
