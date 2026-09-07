import { useRebalance } from '../api/queries';
import { fmtUsd, num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';

/** Under this the borrow is noise: unrealised PnL flips it across zero by a
 * few cents on every poll. Same floor as the Rebalance section's pill. */
const MIN_BORROW = 1;

/** Header pill: the USDC that Gate lent for the Hyperliquid legs, on every
 * tab. A trader who never opens Balances still learns about the borrow.
 * Click opens Balances, where the Rebalance section pays it back. */
export function BorrowChip({ onOpen }: { onOpen: () => void }) {
  const { data } = useRebalance({ direction: 'payDown', amount: null });
  const usdc = data?.buckets.find((b) => b.coin === 'USDC' && b.venue === 'HYPERLIQUID');
  const borrow = floorCents(usdc?.borrow ?? 0);
  if (!usdc || borrow < MIN_BORROW) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Gate lent you ${num(borrow, 2)} USDC for the Hyperliquid legs. It holds ${fmtUsd(usdc.imHeldUsd)} of initial margin against it. Open Balances to pay it back.`}
      className="num rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-500/20"
    >
      {`Borrowing ${num(borrow, 2)} USDC`}
    </button>
  );
}
