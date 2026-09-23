import { ChevronRight } from 'lucide-react';
import { useRebalance } from '../api/queries';
import { borrowingBuckets, borrowTotalUsd } from '../lib/borrow';
import { FACT_BORROWING } from '../panels/rebalanceCopy';
import { borrowingFact, Facts, fmtCoinOrUsd, sharedCoin } from '../panels/RebalanceHovers';
import { HoverCard } from './HoverCard';

export function BorrowChip({ onOpen }: { onOpen: () => void }) {
  const { data } = useRebalance();
  const buckets = data?.buckets ?? [];
  const wallets = borrowingBuckets(buckets);
  if (wallets.length === 0) return null;

  return (
    <HoverCard
      icon={false}
      underline={false}
      label={
        <span
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-500/20"
        >
          {`${FACT_BORROWING} ${fmtCoinOrUsd(borrowTotalUsd(buckets), sharedCoin(wallets))}`}
        </span>
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        <Facts items={[borrowingFact(buckets)]} />
        <button type="button" onClick={onOpen} className="btn-link">
          Rebalance on Balances <ChevronRight size={12} aria-hidden className="inline" />
        </button>
      </div>
    </HoverCard>
  );
}
