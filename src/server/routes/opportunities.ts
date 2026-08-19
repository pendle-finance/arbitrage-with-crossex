/**
 * GET /api/opportunities — the forward-looking scan: every Boros arb group
 * (same collateral + maturity + underlying) priced at a chosen notional, with
 * the perp legs costed from the live CrossEx symbol universe, the venue fee
 * schedule and the venues' public books.
 *
 * Boros /markets is the only hard dependency. Gate being unconfigured or down
 * degrades to a Boros-only 200 — this is a market view, not an account view, so
 * it must never 503 behind credentials. Every other input (Boros books, perp
 * books, fee rows, risk-limit leverage caps) degrades per item to null, which
 * the math turns into a plain-language reason rather than a missing opportunity.
 */
import type { CrossExApi, Symbol as RuleSymbol } from 'gate-api';
import type { FastifyInstance } from 'fastify';
import { publicCrossEx } from '../../core/clients';
import {
  fetchBorosMarkets,
  fetchBorosOrderBook,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
  type BorosOrderBook,
  type FetchLike,
} from '../../core/boros/client';
import {
  BOROS_VENUE_TO_CROSSEX,
  buildOpportunities,
  groupBorosMarkets,
  type BorosEntryMode,
  type EntryMode,
  type ExitMode,
} from '../../core/boros/opportunities';
import { normalizeVenue } from '../../core/boros/returns';
import { fetchVenueBook, type NormalizedBook } from '../../core/estimate/books';
import {
  feeRowsForTier,
  feeTierLabel,
  parseFeeTier,
  type CrossexFeeTier,
} from '../../core/estimate/crossexFeeTiers';
import type { VenueFeeRow } from '../../core/estimate/fees';
import { classifyGateError, CoreError } from '../../core/errors';
import { parseSymbol } from '../../core/numbers';
import { getLeverageMax } from '../../core/orders';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

const DEFAULT_NOTIONAL_USD = 10_000;
const MIN_NOTIONAL_USD = 1_000;
const MAX_NOTIONAL_USD = 100_000_000;

/** Quote ranking for a hedge symbol. Venues list several quotes per base
 * (Hyperliquid is USDC-quoted) and the pick decides which fee row and book
 * apply, so an arbitrary one would make costs flip between refreshes. */
const QUOTE_PREFERENCE = ['USDT', 'USDC', 'USD'];

interface OpportunitiesQuery {
  notionalUsd?: string;
  borosEntry?: string;
  entryMode?: string;
  exitMode?: string;
  feeTier?: string;
  fresh?: string;
}

/** Default quote for a venue's PUBLIC book when no CrossEx symbol names one. */
function fallbackQuote(venue: string): string {
  if (venue === 'HYPERLIQUID') return 'USDC';
  if (venue === 'KRAKEN') return 'USD';
  return 'USDT';
}

function parseNotionalUsd(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_NOTIONAL_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_NOTIONAL_USD || n > MAX_NOTIONAL_USD) {
    throw new CoreError(
      `invalid notionalUsd (expected ${MIN_NOTIONAL_USD}–${MAX_NOTIONAL_USD})`,
      'validation',
    );
  }
  return n;
}

function parseMode<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new CoreError(`invalid ${name} (expected ${allowed.join(' or ')})`, 'validation');
  }
  return raw as T;
}

/** `VENUE:BASE` → the live FUTURE symbol a perp leg would trade there. */
function resolveHedgeSymbols(rules: RuleSymbol[]): Map<string, string> {
  const best = new Map<string, { symbol: string; rank: number }>();
  for (const rule of rules) {
    if (rule.businessType !== 'FUTURE' || rule.state !== 'live') continue;
    const { exchange, base, quote } = parseSymbol(rule.symbol);
    const quoteRank = QUOTE_PREFERENCE.indexOf(quote);
    const rank = quoteRank === -1 ? QUOTE_PREFERENCE.length : quoteRank;
    const key = `${exchange}:${base}`;
    const prev = best.get(key);
    if (!prev || rank < prev.rank) best.set(key, { symbol: rule.symbol, rank });
  }
  return new Map([...best].map(([key, { symbol }]) => [key, symbol]));
}

/**
 * The CrossEx client for the two PUBLIC rule endpoints. The account's own client
 * when there is one (same data, and its interceptors/rate budget already apply);
 * the unsigned public client when there isn't — `/crossex/rule/symbols` and
 * `/crossex/rule/risk_limits` need no credentials, so the market view serves the
 * real universe and the real leverage caps with or without keys.
 */
function ruleClient(deps: AppDeps): CrossExApi {
  try {
    return deps.getClients().crossEx;
  } catch {
    return publicCrossEx();
  }
}

/**
 * CrossEx symbol → venue max leverage, the divisor the capital model sizes each
 * perp leg's initial margin by. Cached on the same `risk:<symbol>` keys
 * `/api/leverage` and `/api/symbols` read (so a scan warms the ticket flow), but
 * filled from ONE comma-joined `getLeverageMax` rather than a call per symbol.
 *
 * A failed read or a symbol with no row leaves that symbol absent, which nulls
 * only that pair's capital — the notional-basis numbers still price.
 */
async function loadLeverageMax(
  deps: AppDeps,
  symbols: string[],
  fresh: boolean,
  out: Map<string, number>,
): Promise<void> {
  let batch: Promise<Map<string, number>> | undefined;
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const { value } = await deps.cache.get(
          `risk:${symbol}`,
          TTL.static,
          async () => {
            batch ??= getLeverageMax(ruleClient(deps), symbols);
            return (await batch).get(symbol) ?? 0;
          },
          { fresh },
        );
        if (value > 0) out.set(symbol, value);
      } catch {
        // Omit the symbol; the math turns that into a reason naming the venue.
      }
    }),
  );
}

export function opportunitiesRoutes(deps: AppDeps) {
  const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);
  // Ops knob: force the Boros taker-fee rate in the cost model. Resolved once
  // here — the opportunity math is a pure module and never reads the environment.
  const envTakerFee = Number(process.env.BOROS_TAKER_FEE_OVERRIDE);
  const takerFeeOverride = Number.isFinite(envTakerFee) ? envTakerFee : undefined;

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/opportunities', async (req, reply) => {
      const query = req.query as OpportunitiesQuery;
      const notionalUsd = parseNotionalUsd(query.notionalUsd);
      const borosEntry = parseMode<BorosEntryMode>(
        query.borosEntry,
        ['mark', 'market'],
        'market',
        'borosEntry',
      );
      const entryMode = parseMode<EntryMode>(
        query.entryMode,
        ['both-market', 'maker-hedge'],
        'both-market',
        'entryMode',
      );
      const exitMode = parseMode<ExitMode>(query.exitMode, ['close', 'roll'], 'close', 'exitMode');
      const feeTier: CrossexFeeTier | undefined = parseFeeTier(query.feeTier);
      // fresh=1 also busts the keys shared with /api/strategy, /api/symbols,
      // /api/leverage and /api/fees — deliberate: a manual refresh here means
      // "re-read upstream".
      const fresh = query.fresh === '1';

      const { value: markets, stale } = await deps.cache.get(
        'boros:markets',
        TTL.boros,
        () => fetchBorosMarkets(fetchImpl),
        { fresh },
      );

      // The CrossEx universe decides which Boros market can carry a perp leg.
      // Losing it (no keys, rate limit, outage) leaves the Boros spreads intact,
      // so it warns instead of failing — and without symbols the fee schedule
      // has nothing to price, so it isn't fetched either.
      // The symbol universe and the risk-limit table are public, so they load
      // with or without credentials — the market view's listings and leverage
      // caps are always the real ones.
      const warnings: string[] = [];
      let symbolsByVenueBase = new Map<string, string>();
      let rulesAvailable = false;
      let feeRows: VenueFeeRow[] | null = null;
      try {
        const { value } = await deps.cache.get(
          'rules:all',
          TTL.static,
          async () => (await ruleClient(deps).listCrossexRuleSymbols()).body,
          { fresh },
        );
        symbolsByVenueBase = resolveHedgeSymbols(value);
        rulesAvailable = true;
      } catch (err) {
        const { category } = classifyGateError(err);
        warnings.push(
          `Couldn't load the CrossEx symbol list right now (${category}) — pricing the perp legs from the venues' public books instead; listings and leverage return on the next refresh.`,
        );
      }

      // Fees are the ONE genuinely per-account input (/crossex/fee is auth-only).
      // An explicit tier is a deliberate what-if and always wins; otherwise read
      // the account's schedule and fall back to VIP 0 when there is no account.
      let assumedTier: CrossexFeeTier | undefined;
      if (feeTier !== undefined) {
        feeRows = feeRowsForTier(feeTier);
        assumedTier = feeTier;
      } else {
        try {
          const { value } = await deps.cache.get(
            'fees',
            TTL.static,
            async () => (await deps.getClients().crossEx.getCrossexFee()).body,
            { fresh },
          );
          feeRows = value as VenueFeeRow[];
        } catch {
          feeRows = feeRowsForTier('vip0');
          assumedTier = 'vip0';
        }
      }
      if (assumedTier !== undefined) {
        warnings.push(
          `Perp fees assume the ${feeTierLabel(assumedTier)} Gate CrossEx schedule — everything else here is live. Your real rates follow your Gate VIP tier; connect Gate keys to price from them.`,
        );
      }

      // Fetch plan straight off the grouping the math will redo — the two can't
      // disagree about membership. Under `mark` no Boros book is consulted at
      // all: the entry rate is each market's markApr.
      const nowSec = Math.floor(Date.now() / 1000);
      const bookMarketIds: number[] = [];
      const perpSymbols = new Set<string>();
      // `VENUE:BASE` keys with no live symbol — when the symbol universe itself
      // is unavailable (unconfigured/down), their PUBLIC books still price the
      // slippage; the core looks them up under this same fallback key.
      const fallbackBooks = new Set<string>();
      for (const plan of groupBorosMarkets(markets, nowSec)) {
        for (const market of plan.markets) {
          const crossexVenue = BOROS_VENUE_TO_CROSSEX[normalizeVenue(market.venue)];
          if (!crossexVenue) continue;
          bookMarketIds.push(market.marketId);
          const base = market.base.toUpperCase();
          const symbol = symbolsByVenueBase.get(`${crossexVenue}:${base}`);
          if (symbol) perpSymbols.add(symbol);
          else if (!rulesAvailable) fallbackBooks.add(`${crossexVenue}:${base}`);
        }
      }

      const borosBooks = new Map<number, BorosOrderBook | null>();
      const venueBooks = new Map<string, NormalizedBook | null>();
      const leverageMaxBySymbol = new Map<string, number>();
      await Promise.all([
        ...(borosEntry === 'market' ? bookMarketIds : []).map(async (marketId) => {
          try {
            const { value } = await deps.cache.get(
              `boros:book:${marketId}`,
              TTL.borosBook,
              () => fetchBorosOrderBook(fetchImpl, marketId),
              { fresh },
            );
            borosBooks.set(marketId, value);
          } catch {
            borosBooks.set(marketId, null);
          }
        }),
        // NOT the `books:` key — that one caches a BookTouch for /api/books/:symbol.
        ...[...perpSymbols].map(async (symbol) => {
          const { value } = await deps.cache.get(
            `fullbook:${symbol}`,
            TTL.book,
            () => {
              const { exchange, base, quote } = parseSymbol(symbol);
              return fetchVenueBook(exchange, base, quote);
            },
            { fresh },
          );
          venueBooks.set(symbol, value);
        }),
        // Fallback keys carry a colon, symbols carry underscores — the cache
        // namespace can't collide with the symbol-keyed entries above.
        ...[...fallbackBooks].map(async (key) => {
          const { value } = await deps.cache.get(
            `fullbook:${key}`,
            TTL.book,
            () => {
              const [venue, base] = key.split(':');
              return fetchVenueBook(venue, base, fallbackQuote(venue));
            },
            { fresh },
          );
          venueBooks.set(key, value);
        }),
        loadLeverageMax(deps, [...perpSymbols], fresh, leverageMaxBySymbol),
      ]);

      const result = buildOpportunities(
        {
          markets,
          collateralPricesUsd: resolveCollateralPricesUsd(markets),
          borosBooks,
          venueBooks,
          symbolsByVenueBase,
          leverageMaxBySymbol,
          feeRows,
          nowSec,
        },
        { notionalUsd, borosEntry, entryMode, exitMode, takerFeeOverride },
      );
      return reply.ok(
        { ...result, warnings: [...new Set([...warnings, ...result.warnings])] },
        { stale },
      );
    });
  };
}
