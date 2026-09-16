import { useRebalance } from '../api/queries';
import { borrowingBuckets, borrowTotalUsd, MIN_BORROW } from '../lib/borrow';
import { fmtUsd, num, prettyVenue } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { HoverCard } from './HoverCard';
import { microLabelClass, Th } from './Th';

const VENUE_LEGS: Readonly<Record<string, string>> = { HYPERLIQUID: 'Hyperliquid legs', LIGHTER: 'Lighter legs' };
const OTHER_VENUE_LEGS = 'Gate, Binance, OKX and Bybit legs';
const cell = 'whitespace-nowrap px-2 py-1';

const venueName = (venue: string): string => (venue === 'CROSSEX' ? 'CrossEx' : prettyVenue(venue));

export function BorrowChip({ onOpen }: { onOpen: () => void }) {
  const { data } = useRebalance();
  const wallets = borrowingBuckets(data?.buckets).filter((b) => floorCents(b.borrow) >= MIN_BORROW);
  if (wallets.length === 0) return null;
  const single = wallets.length === 1 ? wallets[0] : null;
  const oneCoin = new Set(wallets.map((b) => b.coin)).size === 1;
  const totalAmount = borrowTotalUsd(data?.buckets);
  const pillText = single
    ? `Borrowing ${num(floorCents(single.borrow), 2)} ${single.coin}`
    : oneCoin
      ? `Borrowing ${num(totalAmount, 2)} ${wallets[0].coin}`
      : `Borrowing ${fmtUsd(totalAmount)}`;
  const legs = single ? (VENUE_LEGS[single.venue] ?? OTHER_VENUE_LEGS) : null;

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
          {pillText}
        </span>
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        {single ? (
          <dl className="flex gap-6">
            <div className="flex flex-col gap-0.5">
              <dt className={`${microLabelClass} whitespace-nowrap`}>Lent by Gate</dt>
              <dd className="num whitespace-nowrap text-ink-100">{`${num(floorCents(single.borrow), 2)} ${single.coin}`}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className={`${microLabelClass} whitespace-nowrap`}>For</dt>
              <dd className="whitespace-nowrap text-ink-100">{legs}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className={`${microLabelClass} whitespace-nowrap`}>Held as margin</dt>
              <dd className="num whitespace-nowrap text-ink-100">{fmtUsd(single.imHeldUsd)}</dd>
            </div>
          </dl>
        ) : (
          <table className="w-full border border-ink-700">
            <thead>
              <tr>
                <Th className="text-left">Wallet</Th>
                <Th className="text-right">Borrowing</Th>
                <Th className="text-right">Held as margin</Th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((b) => (
                <tr key={`${b.coin}/${b.venue}`} className="border-t border-ink-700">
                  <td className={`${cell} text-ink-100`}>{`${b.coin} · ${venueName(b.venue)}`}</td>
                  <td className={`${cell} num text-right text-ink-100`}>{`${num(floorCents(b.borrow), 2)} ${b.coin}`}</td>
                  <td className={`${cell} num text-right text-ink-100`}>{fmtUsd(b.imHeldUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button type="button" onClick={onOpen} className="btn-link">
          Rebalance on Balances ▸
        </button>
      </div>
    </HoverCard>
  );
}
