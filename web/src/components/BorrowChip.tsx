import { useRebalance } from '../api/queries';
import { borrowingBuckets, borrowTotalUsd } from '../lib/borrow';
import { fmtUsd } from '../lib/fmt';
import { FACT_BORROWING, FACT_HELD } from '../panels/rebalanceCopy';
import { borrowingFact, Facts, fmtCoinOrUsd, heldLine, sharedCoin } from '../panels/RebalanceHovers';
import { HoverCard } from './HoverCard';

const VENUE_LEGS: Readonly<Record<string, string>> = { HYPERLIQUID: 'Hyperliquid legs', LIGHTER: 'Lighter legs' };
const OTHER_VENUE_LEGS = 'Gate, Binance, OKX and Bybit legs';

export function BorrowChip({ onOpen }: { onOpen: () => void }) {
  const { data } = useRebalance();
  const buckets = data?.buckets ?? [];
  const wallets = borrowingBuckets(buckets);
  if (wallets.length === 0) return null;
  const legs = [...new Set(wallets.map((b) => VENUE_LEGS[b.venue] ?? OTHER_VENUE_LEGS))];
  const legsFact = {
    key: 'legs',
    label: 'For',
    value: legs.map((line) => (
      <span key={line} className="block whitespace-nowrap">
        {line}
      </span>
    )),
  };
  const held = {
    key: 'held',
    label: FACT_HELD,
    value: fmtUsd(wallets.reduce((total, b) => total + b.imHeldUsd, 0)),
    sub: wallets.length === 1 ? [] : [heldLine(wallets)],
  };

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
        <Facts items={[borrowingFact(buckets), legsFact, held]} />
        <button type="button" onClick={onOpen} className="btn-link">
          Rebalance on Balances ▸
        </button>
      </div>
    </HoverCard>
  );
}
