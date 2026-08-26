/**
 * Per-venue PUBLIC orderbook fetch + normalization. CrossEx has no market-data
 * endpoints, so pre-trade fill estimation reads each venue's own public book.
 * Everything here degrades to `null` (never throws) — a missing book just moves
 * `estimateFill` down its fallback chain.
 */
import axios from 'axios';

export interface NormalizedBook {
  /** [price, baseQty], sorted best-first: bids desc, asks asc. */
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  ts: number;
}

type Level = [number, number];

const TIMEOUT_MS = 2500;

/** The venue's own instrument id for a CrossEx BASE/QUOTE; null = venue unsupported. */
export function nativeSymbol(exchange: string, base: string, quote: string): string | null {
  switch (exchange.toUpperCase()) {
    // Gate v4 futures only settle in USDT — always BASE_USDT regardless of the target quote.
    case 'GATE':
      return `${base}_USDT`;
    case 'BINANCE':
    case 'BYBIT':
      return `${base}${quote}`;
    case 'OKX':
      return `${base}-${quote}-SWAP`;
    case 'HYPERLIQUID':
      return base;
    // Kraken linear perps are PF_<BASE>USD regardless of the CrossEx quote label.
    case 'KRAKEN':
      return `PF_${base}USD`;
    default:
      return null;
  }
}

/** Coerce raw rows into positive [price, qty] levels, scaling qty by `mult`; bad rows dropped. */
function toLevels(rows: unknown, pick: (row: unknown) => [unknown, unknown] | null, mult: number): Level[] {
  if (!Array.isArray(rows)) return [];
  const out: Level[] = [];
  for (const row of rows) {
    const picked = pick(row);
    if (!picked) continue;
    const price = Number(picked[0]);
    const qty = Number(picked[1]) * mult;
    if (Number.isFinite(price) && price > 0 && Number.isFinite(qty) && qty > 0) out.push([price, qty]);
  }
  return out;
}

/** Sort best-first and reject books with no usable levels on either side. */
function assemble(bids: Level[], asks: Level[]): NormalizedBook | null {
  if (!bids.length && !asks.length) return null;
  return {
    bids: [...bids].sort((a, b) => b[0] - a[0]),
    asks: [...asks].sort((a, b) => a[0] - b[0]),
    ts: Date.now(),
  };
}

const pickTuple = (row: unknown): [unknown, unknown] | null =>
  Array.isArray(row) && row.length >= 2 ? [row[0], row[1]] : null;

/** Gate futures order_book: {bids:[{p,s}],asks:[...]}; s = CONTRACT count, so qty
 * must be scaled by the contract's quanto_multiplier (base per contract). */
export function parseGateBook(json: unknown, multiplier: number): NormalizedBook | null {
  const j = json as { bids?: unknown; asks?: unknown } | null;
  const pick = (row: unknown): [unknown, unknown] | null => {
    const o = row as { p?: unknown; s?: unknown } | null;
    return o && o.p != null && o.s != null ? [o.p, o.s] : null;
  };
  return assemble(toLevels(j?.bids, pick, multiplier), toLevels(j?.asks, pick, multiplier));
}

/** Binance fapi depth: {bids:[["px","qty"]],asks:[...]} — qty already in base. */
export function parseBinanceBook(json: unknown): NormalizedBook | null {
  const j = json as { bids?: unknown; asks?: unknown } | null;
  return assemble(toLevels(j?.bids, pickTuple, 1), toLevels(j?.asks, pickTuple, 1));
}

/** Bybit v5 orderbook: {result:{b:[[px,qty]],a:[...]}} — qty in base. */
export function parseBybitBook(json: unknown): NormalizedBook | null {
  const r = (json as { result?: { a?: unknown; b?: unknown } } | null)?.result;
  return assemble(toLevels(r?.b, pickTuple, 1), toLevels(r?.a, pickTuple, 1));
}

/** OKX books: {data:[{bids:[[px,qty,_,_]],asks:[...]}]}; qty = CONTRACTS, scaled by
 * the instrument's ctVal (base per contract). */
export function parseOkxBook(json: unknown, ctVal: number): NormalizedBook | null {
  const d = (json as { data?: Array<{ bids?: unknown; asks?: unknown }> } | null)?.data?.[0];
  return assemble(toLevels(d?.bids, pickTuple, ctVal), toLevels(d?.asks, pickTuple, ctVal));
}

/** Hyperliquid l2Book: {levels:[[{px,sz,n}],[...]]} — levels[0]=bids, levels[1]=asks, sz in base. */
export function parseHlBook(json: unknown): NormalizedBook | null {
  const levels = (json as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(levels) || levels.length < 2) return null;
  const pick = (row: unknown): [unknown, unknown] | null => {
    const o = row as { px?: unknown; sz?: unknown } | null;
    return o && o.px != null && o.sz != null ? [o.px, o.sz] : null;
  };
  return assemble(toLevels(levels[0], pick, 1), toLevels(levels[1], pick, 1));
}

/** Kraken futures orderbook: {orderBook:{bids:[[px,qty]],asks:[...]}} — qty in base. */
export function parseKrakenBook(json: unknown): NormalizedBook | null {
  const ob = (json as { orderBook?: { bids?: unknown; asks?: unknown } } | null)?.orderBook;
  return assemble(toLevels(ob?.bids, pickTuple, 1), toLevels(ob?.asks, pickTuple, 1));
}

/** Best bid/ask/mid of a normalized book; null unless BOTH sides have a level
 * (a one-sided book has no mid to quote — callers that can work from a single
 * side, like the POC same-side reprice, read the level directly instead). */
export function touchOf(book: NormalizedBook | null): { bestBid: number; bestAsk: number; mid: number } | null {
  const bestBid = book?.bids?.[0]?.[0];
  const bestAsk = book?.asks?.[0]?.[0];
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  return { bestBid: bestBid as number, bestAsk: bestAsk as number, mid: ((bestBid as number) + (bestAsk as number)) / 2 };
}

/** Midpoint suitable for execution guards. Unlike display/estimate callers, a
 * hedge must fail closed on one-sided, crossed, or absurdly wide books because
 * those shapes are not trustworthy slippage anchors. `maxRelativeSpread` is a
 * fraction of mid (0.05 = 5%). */
export function refMidOf(book: NormalizedBook | null, maxRelativeSpread: number): number | null {
  const touch = touchOf(book);
  if (!touch || touch.bestAsk <= touch.bestBid || touch.mid <= 0) return null;
  const relativeSpread = (touch.bestAsk - touch.bestBid) / touch.mid;
  if (!Number.isFinite(relativeSpread) || relativeSpread > maxRelativeSpread) return null;
  return touch.mid;
}

interface BookSource {
  method: 'GET' | 'POST';
  url: (base: string, quote: string) => string;
  body?: (base: string, quote: string) => unknown;
  /** sizeMult scales venue sizes to base qty (1 where sizes are already base). */
  parse: (json: unknown, sizeMult: number) => NormalizedBook | null;
  /** Instrument-metadata lookup yielding sizeMult (contract → base); memoized per symbol. */
  meta?: {
    url: (base: string, quote: string) => string;
    extract: (json: unknown) => number | null;
  };
}

/** Table-driven venue config — the venue set is open-ended; unknown venues just miss here. */
const BOOK_SOURCES: Record<string, BookSource> = {
  GATE: {
    method: 'GET',
    url: (base, quote) =>
      `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${nativeSymbol('GATE', base, quote)}&limit=50`,
    parse: parseGateBook,
    meta: {
      url: (base, quote) => `https://api.gateio.ws/api/v4/futures/usdt/contracts/${nativeSymbol('GATE', base, quote)}`,
      extract: (json) => {
        const m = Number((json as { quanto_multiplier?: string } | null)?.quanto_multiplier);
        return Number.isFinite(m) && m > 0 ? m : null;
      },
    },
  },
  BINANCE: {
    method: 'GET',
    url: (base, quote) => `https://fapi.binance.com/fapi/v1/depth?symbol=${nativeSymbol('BINANCE', base, quote)}&limit=100`,
    parse: parseBinanceBook,
  },
  BYBIT: {
    method: 'GET',
    url: (base, quote) =>
      `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${nativeSymbol('BYBIT', base, quote)}&limit=100`,
    parse: parseBybitBook,
  },
  OKX: {
    method: 'GET',
    url: (base, quote) => `https://www.okx.com/api/v5/market/books?instId=${nativeSymbol('OKX', base, quote)}&sz=100`,
    parse: parseOkxBook,
    meta: {
      url: (base, quote) =>
        `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${nativeSymbol('OKX', base, quote)}`,
      extract: (json) => {
        const m = Number((json as { data?: Array<{ ctVal?: string }> } | null)?.data?.[0]?.ctVal);
        return Number.isFinite(m) && m > 0 ? m : null;
      },
    },
  },
  HYPERLIQUID: {
    method: 'POST',
    url: () => 'https://api.hyperliquid.xyz/info',
    body: (base) => ({ type: 'l2Book', coin: base }),
    parse: parseHlBook,
  },
  KRAKEN: {
    method: 'GET',
    url: (base, quote) => `https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=${nativeSymbol('KRAKEN', base, quote)}`,
    parse: parseKrakenBook,
  },
};

/** Contract-size multipliers (gate quanto_multiplier, okx ctVal) — instrument specs
 * are effectively immutable, so a process-lifetime memo avoids a second call per fetch. */
const sizeMultCache = new Map<string, number>();

/**
 * Fetch + normalize a venue's public book. Unknown venue (e.g. DERIBIT), HTTP error,
 * missing instrument, or an unparseable/empty book all return null — NEVER throws.
 */
export async function fetchVenueBook(exchange: string, base: string, quote: string): Promise<NormalizedBook | null> {
  const src = BOOK_SOURCES[exchange.toUpperCase()];
  if (!src) return null;
  try {
    let sizeMult = 1;
    if (src.meta) {
      const key = `${exchange.toUpperCase()}:${nativeSymbol(exchange, base, quote)}`;
      const cached = sizeMultCache.get(key);
      if (cached != null) {
        sizeMult = cached;
      } else {
        const { data } = await axios.get(src.meta.url(base, quote), { timeout: TIMEOUT_MS });
        const m = src.meta.extract(data);
        // Without the multiplier the sizes would be off by orders of magnitude — bail.
        if (m == null) return null;
        sizeMultCache.set(key, m);
        sizeMult = m;
      }
    }
    const url = src.url(base, quote);
    const { data } =
      src.method === 'POST'
        ? await axios.post(url, src.body?.(base, quote), { timeout: TIMEOUT_MS })
        : await axios.get(url, { timeout: TIMEOUT_MS });
    return src.parse(data, sizeMult);
  } catch {
    return null;
  }
}
