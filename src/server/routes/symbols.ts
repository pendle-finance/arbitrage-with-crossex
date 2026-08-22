import type { Symbol as RuleSymbol } from 'gate-api';
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { parseSymbol } from '../../core/numbers';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { leverageMaxFor } from './leverage';

interface SymbolInfo {
  symbol: string;
  exchange: string;
  base: string;
  quote: string;
  tickSize: string;
  lotSize: string;
  minSize: string;
  /** Live-API truth: Gate returns null on symbols without the limit (the SDK's
   * `string` typing lies) — null means "no limit" everywhere downstream. */
  minNotional: string | null;
  maxMarketSize: string | null;
  maxLimitSize: string | null;
  contractSize: string | null;
  state: string;
}

interface SymbolsQuery {
  q?: string;
  base?: string;
  exchange?: string;
  multiOnly?: string;
  fresh?: string;
}

function toInfo(rule: RuleSymbol): SymbolInfo {
  const { exchange, base, quote } = parseSymbol(rule.symbol);
  return {
    symbol: rule.symbol,
    exchange,
    base,
    quote,
    tickSize: rule.tickSize,
    lotSize: rule.lotSize,
    minSize: rule.minSize,
    minNotional: rule.minNotional,
    maxMarketSize: rule.maxMarketSize,
    maxLimitSize: rule.maxLimitSize,
    contractSize: rule.contractSize,
    state: rule.state,
  };
}

/**
 * USDC-margined twin contracts deliberately EXCLUDED from the terminal.
 * BINANCE / OKX / BYBIT list a USDC-quoted twin beside their primary USDT
 * contract — a separate book with its own independently-settled funding rate.
 * The Boros markets this terminal hedges reference the USDT contracts, and in
 * the tickets' venue pickers a twin reads as "the same venue, again" while
 * quietly being a different market. Dropped at the source list, so the
 * pickers, the venue chips, the multi-venue counts and the by-symbol detail
 * all agree. Hyperliquid is untouched: USDC is its ONLY quote, not a twin
 * (same for Deribit and Kraken's USD).
 */
const EXCLUDED_QUOTE_TWINS: Record<string, string> = {
  BINANCE: 'USDC',
  OKX: 'USDC',
  BYBIT: 'USDC',
};

/** Cached full rule list mapped to SymbolInfo, filtered to live FUTURE perps
 * (minus the excluded USDC twins). */
async function livePerps(
  deps: AppDeps,
  fresh: boolean,
): Promise<{ list: SymbolInfo[]; stale: boolean }> {
  const { value, stale } = await deps.cache.get(
    'rules:all',
    TTL.static,
    async () => (await deps.getClients().crossEx.listCrossexRuleSymbols()).body,
    { fresh },
  );
  const list = value
    .filter((r) => r.businessType === 'FUTURE' && r.state === 'live')
    .map(toInfo)
    .filter((s) => EXCLUDED_QUOTE_TWINS[s.exchange] !== s.quote);
  return { list, stale };
}

export function symbolsRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/symbols', async (req, reply) => {
      const q = req.query as SymbolsQuery;
      const fresh = q.fresh === '1';
      const { list, stale } = await livePerps(deps, fresh);

      // Venue counts come from the FULL live list so ?q= etc. don't skew multiOnly.
      const venuesByBase = new Map<string, Set<string>>();
      for (const s of list) {
        const set = venuesByBase.get(s.base) ?? new Set<string>();
        set.add(s.exchange);
        venuesByBase.set(s.base, set);
      }

      let out = list;
      if (q.q) {
        const needle = q.q.toUpperCase();
        out = out.filter((s) => s.base.includes(needle) || s.symbol.includes(needle));
      }
      if (q.base) {
        const base = q.base.toUpperCase();
        out = out.filter((s) => s.base === base);
      }
      if (q.exchange) {
        const exchange = q.exchange.toUpperCase();
        out = out.filter((s) => s.exchange === exchange);
      }
      if (q.multiOnly === '1') {
        out = out.filter((s) => (venuesByBase.get(s.base)?.size ?? 0) >= 2);
      }
      return reply.ok(out, { stale });
    });

    app.get('/symbols/:symbol', async (req, reply) => {
      const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      const { list, stale } = await livePerps(deps, fresh);
      const info = list.find((s) => s.symbol === symbol);
      if (!info) throw new CoreError(`symbol ${symbol} not found on CrossEx`, 'symbol-invalid');
      const leverageMax = await leverageMaxFor(deps, symbol, fresh).catch(() => 0);
      return reply.ok({ ...info, leverageMax }, { stale });
    });
  };
}
