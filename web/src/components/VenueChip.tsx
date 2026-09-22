import { parseSymbol, prettyVenue } from '../lib/fmt';
import { TokenIcon, VenueIcon } from './AssetIcon';
import { Chip } from './Chip';

/** USDT-quoted perp venues get the cyan house tone; USD/USDC venues stay neutral. */
const USDT_PERP_VENUES = new Set(['BINANCE', 'BYBIT', 'GATE', 'OKX']);

/** Quote currency note for non-USDT venues (Gate CrossEx conventions). */
export const VENUE_QUOTE_NOTE: Record<string, string> = {
  KRAKEN: 'quotes USD',
  HYPERLIQUID: 'quotes USDC',
  LIGHTER: 'quotes USDC',
  DERIBIT: 'quotes USDC',
};

export function VenueChip({ exchange, crossex }: { exchange: string; crossex?: boolean }) {
  // The CrossEx provenance marker overrides the quote-currency tint: colour +
  // a text suffix (never colour alone) mark a leg held via the connected
  // Gate CrossEx account.
  if (crossex) {
    return (
      <Chip sm tone="crossex" title="via CrossEx (connected Gate account)">
        <VenueIcon venue={exchange} size={12} />
        {exchange}
        <span className="ml-0.5 text-[9px] font-semibold text-crossex">·CX</span>
      </Chip>
    );
  }
  // USDT-quoted venues take the sky/link blue (dapp-nitro's `sky`), a
  // different hue from the CrossEx cyan above.
  return (
    <Chip sm tone={USDT_PERP_VENUES.has(exchange) ? 'link' : 'neutral'}>
      <VenueIcon venue={exchange} size={12} />
      {exchange}
    </Chip>
  );
}

/** Venue chip + base coin (+ dim non-USDT quote) for a full CrossEx symbol. */
export function SymbolCell({ symbol }: { symbol: string }) {
  const { exchange, base, quote } = parseSymbol(symbol);
  return (
    <span className="inline-flex items-center gap-2">
      <VenueChip exchange={exchange} />
      <span className="inline-flex items-center gap-1.5 font-medium text-ink-100">
        <TokenIcon symbol={base} size={14} />
        {base || symbol}
      </span>
      {quote && quote !== 'USDT' && <span className="text-[10px] text-ink-400">{quote}</span>}
    </span>
  );
}

/** One "SIDE · Venue" row of the stacked pair identity (short over long) —
 * the opportunity card's compact pair block, shared with the position page's
 * hero. Muted tones: it identifies, the side chips elsewhere emphasise. */
export function SideVenue({ side, venue }: { side: 'SHORT' | 'LONG'; venue: string }) {
  // The mock's leg capsule: an untinted outline holding the venue's mark, its
  // name at full contrast, and the direction as a small coloured word. The
  // direction is the only colour, so a row of these never competes with the
  // APR figure beside them.
  const dir = side === 'SHORT' ? 'text-guava' : 'text-grass';
  return (
    <span className="leg-cap self-start">
      <VenueIcon venue={venue} size={18} />
      <span className="min-w-0 truncate text-ink-50">{prettyVenue(venue)}</span>
      <b className={`text-[11px] font-semibold tracking-[0.04em] ${dir}`}>{side}</b>
    </span>
  );
}

/** LONG / SHORT (or BUY / SELL) side chip. */
export function SideChip({ side }: { side: string }) {
  const s = side.toUpperCase();
  const positive = s === 'LONG' || s === 'BUY';
  return (
    <Chip sm tone={positive ? 'green' : 'red'}>
      {s}
    </Chip>
  );
}
