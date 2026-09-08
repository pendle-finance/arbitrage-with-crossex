import { useRebalance } from '../api/queries';
import { borrowedBucket } from '../lib/borrow';
import { fmtUsd, num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';

/** Header pill: what Gate lent, on every tab. USDC for the Hyperliquid
 * legs, or USDT when the legs on the other venues drained that wallet. A
 * trader who never opens Balances still learns about the borrow. Click
 * opens Balances, where the Rebalance section pays it back. */
export function BorrowChip({ onOpen }: { onOpen: () => void }) {
  const { data } = useRebalance({ direction: 'toUsdc', amount: null });
  const borrowed = borrowedBucket(data?.buckets);
  if (!borrowed) return null;
  const borrow = floorCents(borrowed.borrow);
  const legs = borrowed.venue === 'HYPERLIQUID' ? 'the Hyperliquid legs' : 'the legs on the other venues';
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Gate lent you ${num(borrow, 2)} ${borrowed.coin} for ${legs}. It holds ${fmtUsd(borrowed.imHeldUsd)} of initial margin against it. Open Balances to pay it back.`}
      className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-500/20"
    >
      {`Borrowing ${num(borrow, 2)} ${borrowed.coin}`}
    </button>
  );
}
