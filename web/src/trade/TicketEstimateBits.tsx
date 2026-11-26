import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVenueBook } from '../api/queries';
import type { FillEstimate, Side } from '../api/types';
import { Chip } from '../components/Chip';
import { num, parseSymbol, prettyVenue, qtyGrouped } from '../lib/fmt';
import { EstimateRow } from './PairTicketBits';
import { type LegImpact, PriceImpactGraph } from './PriceImpactGraph';

export type PlanRole = 'rests' | 'hedges' | 'market';

const SIDE_MARK = '\u0001';

export function fmtTradeCost(cost: number | null, quote = 'USDT'): string {
  return cost === null ? '—' : `≈ ${num(cost, 2)} ${quote}`;
}

export function PlanLine({
  side,
  symbol,
  role,
  qty,
}: {
  side: 'LONG' | 'SHORT';
  symbol: string;
  role: PlanRole;
  qty: string | undefined;
}) {
  const { t } = useTranslation();
  const { exchange, base } = parseSymbol(symbol);
  const values = { side: SIDE_MARK, venue: prettyVenue(exchange) };
  const text =
    role === 'market'
      ? t('trade.ticketEstimate.atMarket', values)
      : role === 'rests'
        ? t('pairTicket.estimate.legRole.rests', values)
        : t('pairTicket.estimate.legRole.hedges', values);
  const [before, after] = text.split(SIDE_MARK);
  return (
    <EstimateRow
      label={
        <>
          {before}
          <Chip sm tone={side === 'LONG' ? 'green' : 'red'} className="font-semibold">
            {t(side === 'LONG' ? 'common.longUpper' : 'common.shortUpper')}
          </Chip>
          {after}
        </>
      }
      value={qty ? `${qtyGrouped(qty)}${base ? ` ${base}` : ''}` : '—'}
    />
  );
}

export function BookToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={t('pairTicket.bits.bookHint')}
      className={`btn-ghost-xs ${on ? '!border-info/50 bg-info/[0.14] !text-pastel-blue' : ''}`}
    >
      <BookOpen size={12} aria-hidden /> {t('pairTicket.bits.book')}
    </button>
  );
}

export function OneLegBook({
  symbol,
  side,
  limitPx,
  fill,
  estimating,
}: {
  symbol: string;
  side: Side;
  limitPx: number | null;
  fill: FillEstimate | undefined;
  estimating: boolean;
}) {
  const book = useVenueBook(symbol, true);
  const leg: LegImpact = {
    venue: parseSymbol(symbol).exchange,
    side: side === 'BUY' ? 'LONG' : 'SHORT',
    bestBid: book.data?.bestBid ?? null,
    bestAsk: book.data?.bestAsk ?? null,
    mid: book.data?.mid ?? fill?.midPrice ?? null,
    avgFill: fill?.avgPrice ?? null,
    worst: fill?.worstPrice ?? null,
    partialDepth: Boolean(fill?.partialDepth),
    limitPx: limitPx !== null && limitPx > 0 ? limitPx : null,
  };
  return (
    <PriceImpactGraph
      long={leg}
      short={leg}
      oneLeg={side === 'BUY' ? 'long' : 'short'}
      updatedAt={book.dataUpdatedAt}
      staleError={book.isError && book.data !== undefined}
      readFailed={book.isError && book.data === undefined}
      dim={estimating}
      embedded
      onRefetch={() => void book.refetch()}
    />
  );
}
