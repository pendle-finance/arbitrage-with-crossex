import { useRebalance } from '../api/queries';
import { borrowedBucket } from '../lib/borrow';
import { fmtUsd, num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { HoverCard } from './HoverCard';
import { microLabelClass } from './Th';

const HYPERLIQUID_LEGS = 'Hyperliquid legs';
const OTHER_VENUE_LEGS = 'Gate, Binance, OKX and Bybit legs';

export function BorrowChip({ onOpen }: { onOpen: () => void }) {
  const { data } = useRebalance();
  const borrowed = borrowedBucket(data?.buckets);
  if (!borrowed) return null;
  const borrow = floorCents(borrowed.borrow);
  const legs = borrowed.venue === 'HYPERLIQUID' ? HYPERLIQUID_LEGS : OTHER_VENUE_LEGS;

  return (
    <HoverCard
      icon={false}
      widthPx={500}
      label={
        <span className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-500/20">
          {`Borrowing ${num(borrow, 2)} ${borrowed.coin}`}
        </span>
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        <dl className="flex gap-6">
          <div className="flex flex-col gap-0.5">
            <dt className={`${microLabelClass} whitespace-nowrap`}>Lent by Gate</dt>
            <dd className="num whitespace-nowrap text-ink-100">{`${num(borrow, 2)} ${borrowed.coin}`}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className={`${microLabelClass} whitespace-nowrap`}>For</dt>
            <dd className="whitespace-nowrap text-ink-100">{legs}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className={`${microLabelClass} whitespace-nowrap`}>Held as margin</dt>
            <dd className="num whitespace-nowrap text-ink-100">{fmtUsd(borrowed.imHeldUsd)}</dd>
          </div>
        </dl>
        <button type="button" onClick={onOpen} className="btn-link">
          Rebalance on Balances ▸
        </button>
      </div>
    </HoverCard>
  );
}
