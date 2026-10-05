/**
 * GET /api/opportunities-ltp — the forward-looking scan with the perp legs
 * executed through LTP (RapidX on BINANCE/OKX, DMA elsewhere) instead of Gate
 * CrossEx. Same doctrine as /api/opportunities: Boros /markets is the only
 * hard dependency; everything LTP degrades per item with a warning.
 *
 * LTP traffic budget: LTP's public market endpoints are throttled 3 req/10s,
 * so this route NEVER fans out per symbol. Per scan it makes at most one bulk
 * sym/info read (10-min TTL) plus one account fee-schedule read when keys are
 * configured — perp slippage books come from the venues' own public depth
 * endpoints (fetchVenueBook), exactly like the CrossEx route, and Boros books
 * are shared cache keys with it.
 *
 * The VIP fee ladder is account-confidential (LTP publishes no schedule), so
 * it is NOT committed: the operator drops it into a gitignored JSON
 * (LTP_FEE_TIERS_PATH, default scripts/ltp/fee-tiers.local.json) and the
 * committed fallback prices VIP1 only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  fetchBorosMarkets,
  fetchBorosOrderBook,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
  type BorosOrderBook,
  type FetchLike,
} from '../../core/boros/client';
import {
  groupBorosMarkets,
  type BorosEntryMode,
  type EntryMode,
  type ExitMode,
} from '../../core/boros/opportunities';
import { normalizeVenue } from '../../core/boros/venue';
import { fetchVenueBook, type NormalizedBook } from '../../core/estimate/books';
import { CoreError } from '../../core/errors';
import {
  ltpFeeRatesForTier,
  ltpFeeTierLabel,
  parseLtpFeeTier,
  parseLtpLadder,
  LTP_FEE_TIERS,
  type LtpFeeTier,
  type LtpLadder,
} from '../../core/ltp/feeTiers';
import { fetchHyperliquidMaxLeverage } from '../../core/ltp/hlCaps';
import {
  BOROS_VENUE_TO_LTP,
  buildLtpOpportunities,
  type LtpPerpFeeRates,
} from '../../core/ltp/opportunities';
import { TTL, type TtlCache } from '../cache';
import { fallbackQuote, parseMode, parseNotionalUsd } from './opportunities';

/** Optional host-supplied read adapter; no trading methods or credentials. */
export interface LtpReadClient {
  getSymbolInfo(): Promise<Array<{ sym: string; state: string }>>;
  getUserFeeRate(): Promise<LtpFeeRate[]>;
}

export interface LtpFeeRate {
  exchangeType: string;
  businessType: string;
  makerFeeRate: string;
  takerFeeRate: string;
  level?: string;
}

export interface LtpOpportunitiesDeps {
  cache: TtlCache;
  borosFetch?: FetchLike;
  getLtpClient?: () => LtpReadClient | null;
  /** Private reference fees, supplied by the host instead of a local file. */
  ltpLadder?: LtpLadder;
}

const DEFAULT_PERP_LEVERAGE = 5;
const MIN_PERP_LEVERAGE = 1;
const MAX_PERP_LEVERAGE = 50;
const DEFAULT_BORROW_LEVERAGE = 2;
const MIN_BORROW_LEVERAGE = 1;
const MAX_BORROW_LEVERAGE = 5;
const DEFAULT_LOAN_RATE_APR = 0.095;

interface LtpOpportunitiesQuery {
  notionalUsd?: string;
  borosEntry?: string;
  entryMode?: string;
  exitMode?: string;
  ltpTier?: string;
  perpLeverage?: string;
  borrowLeverage?: string;
  loanRateApr?: string;
  fresh?: string;
}

function parseBoundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new CoreError(`invalid ${name} (expected ${min}–${max})`, 'validation');
  }
  return n;
}

function parseTierParam(raw: string | undefined): LtpFeeTier | undefined {
  if (raw === undefined || raw === '') return undefined;
  const tier = parseLtpFeeTier(raw);
  if (tier === undefined) {
    throw new CoreError(`invalid ltpTier (expected ${LTP_FEE_TIERS.join(' or ')})`, 'validation');
  }
  return tier;
}

/** The operator-supplied ladder, read once at plugin init. Missing or
 * malformed file → empty ladder (VIP1 committed fallback still applies). */
function loadLadderFile(): LtpLadder {
  const file =
    process.env.LTP_FEE_TIERS_PATH ??
    path.join(fileURLToPath(new URL('../../..', import.meta.url)), 'scripts/ltp/fee-tiers.local.json');
  try {
    return parseLtpLadder(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** Account fee level ("1".."5") → the matching ladder tier. */
function tierFromLevel(rows: LtpFeeRate[]): LtpFeeTier | undefined {
  for (const row of rows) {
    if (row.businessType !== 'PERP') continue;
    const tier = parseLtpFeeTier(`vip${row.level ?? ''}`);
    if (tier) return tier;
  }
  return undefined;
}

/** Every LTP venue a Boros market can map onto — priced from the ladder unless
 * the account's own schedule covers it. */
const LTP_VENUES = Object.keys(BOROS_VENUE_TO_LTP);

function tierFees(ladder: LtpLadder, tier: LtpFeeTier): Map<string, LtpPerpFeeRates> | null {
  const rates = ltpFeeRatesForTier(ladder, tier);
  if (!rates) return null;
  return new Map(
    LTP_VENUES.map((venue) => [
      venue,
      { makerRate: rates.makerRate, takerRate: rates.takerRate, source: 'tier' as const },
    ]),
  );
}

export function opportunitiesLtpRoutes(deps: LtpOpportunitiesDeps) {
  const fetchImpl: FetchLike = resolveBorosFetch(deps.borosFetch);
  const envTakerFee = Number(process.env.BOROS_TAKER_FEE_OVERRIDE);
  const takerFeeOverride = Number.isFinite(envTakerFee) ? envTakerFee : undefined;
  const ladder = deps.ltpLadder ?? loadLadderFile();

  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/opportunities-ltp', async (req, reply) => {
      const query = req.query as LtpOpportunitiesQuery;
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
      const requestedTier = parseTierParam(query.ltpTier);
      const perpLeverage = parseBoundedNumber(
        query.perpLeverage,
        DEFAULT_PERP_LEVERAGE,
        MIN_PERP_LEVERAGE,
        MAX_PERP_LEVERAGE,
        'perpLeverage',
      );
      const borrowLeverage = parseBoundedNumber(
        query.borrowLeverage,
        DEFAULT_BORROW_LEVERAGE,
        MIN_BORROW_LEVERAGE,
        MAX_BORROW_LEVERAGE,
        'borrowLeverage',
      );
      const loanRateApr = parseBoundedNumber(
        query.loanRateApr,
        DEFAULT_LOAN_RATE_APR,
        0,
        1,
        'loanRateApr',
      );
      const fresh = query.fresh === '1';

      const { value: markets, stale } = await deps.cache.get(
        'boros:markets',
        TTL.boros,
        () => fetchBorosMarkets(fetchImpl),
        { fresh, staleWhileRevalidate: true },
      );

      const warnings: string[] = [];
      const ltp: LtpReadClient | null = deps.getLtpClient?.() ?? null;

      // --- LTP symbol universe (one bulk read; LTP's ONLY throttled call here) --
      let ltpSyms: Set<string> | null = null;
      if (ltp) {
        try {
          const { value } = await deps.cache.get(
            'ltp:syminfo',
            TTL.static,
            async () =>
              (await ltp.getSymbolInfo())
                .filter((r) => r.state === 'live')
                .map((r) => r.sym),
            { fresh },
          );
          ltpSyms = new Set(value);
        } catch {
          warnings.push(
            "Couldn't load LTP's symbol universe right now — perp listings are assumed, not confirmed; they return on the next refresh.",
          );
        }
      }

      // --- Hyperliquid leverage caps (public meta): HL legs run over a DMA
      // rail that passes HL's own per-asset limits through, so the leverage
      // knob is clamped per HL leg. Kicked off HERE and awaited after the book
      // fan-out, so an HL outage overlaps the book fetches instead of stalling
      // the scan serially. Degrades to no clamping with a warning. -------------
      const hlMaxLeveragePromise: Promise<Map<string, number> | null> = deps.cache
        .get('hl:maxLeverage', TTL.static, async () => [...(await fetchHyperliquidMaxLeverage())], {
          fresh,
          staleWhileRevalidate: true,
        })
        .then(({ value }) => new Map(value))
        .catch(() => {
          warnings.push(
            "Couldn't load Hyperliquid's leverage caps right now — Hyperliquid legs assume the requested leverage; they return on the next refresh.",
          );
          return null;
        });

      // --- Fees: explicit tier is a what-if and always wins; otherwise the
      // account's own schedule; otherwise the VIP1 fallback with a warning. ----
      let perpFees: Map<string, LtpPerpFeeRates> | null = null;
      let ltpTier: LtpFeeTier = requestedTier ?? 'vip1';
      let tierSource: 'param' | 'account' | 'default' = requestedTier ? 'param' : 'default';
      if (requestedTier) {
        perpFees = tierFees(ladder, requestedTier);
        if (!perpFees) {
          warnings.push(
            `The ${ltpFeeTierLabel(requestedTier)} LTP fee ladder isn't configured on this server (LTP doesn't publish its schedule) — perp fees can't be priced at that tier.`,
          );
        }
      } else {
        let accountRows: LtpFeeRate[] | null = null;
        if (ltp) {
          try {
            const { value } = await deps.cache.get(
              'ltp:userFeeRate',
              TTL.static,
              () => ltp.getUserFeeRate(),
              { fresh },
            );
            accountRows = value;
          } catch {
            // Fall through to the ladder default below.
          }
        }
        // Venue-level rates only: per-symbol fee groups (A–D) exist on the
        // account schedule, but the engine prices per venue — group-B/C
        // exceptions misprice by fractions of a bp and are accepted for now.
        const fees = new Map<string, LtpPerpFeeRates>();
        for (const row of accountRows ?? []) {
          if (row.businessType !== 'PERP') continue;
          const maker = Number(row.makerFeeRate);
          const taker = Number(row.takerFeeRate);
          if (!Number.isFinite(maker) || !Number.isFinite(taker)) continue;
          fees.set(row.exchangeType, { makerRate: maker, takerRate: taker, source: 'account' });
        }
        // A schedule with no usable PERP row is NOT account pricing — falling
        // into the account branch here would stamp tierSource 'account' on
        // ladder-priced fees and suppress the assumption warning.
        if (fees.size) {
          const detected = tierFromLevel(accountRows ?? []);
          if (detected) ltpTier = detected;
          tierSource = 'account';
          // DMA venues the account schedule doesn't cover price from the ladder
          // at the detected tier (the DMA caveat on the pair flags the guess).
          const ladderRates = ltpFeeRatesForTier(ladder, ltpTier);
          if (ladderRates) {
            for (const venue of LTP_VENUES) {
              if (!fees.has(venue)) {
                fees.set(venue, {
                  makerRate: ladderRates.makerRate,
                  takerRate: ladderRates.takerRate,
                  source: 'tier',
                });
              }
            }
          }
          perpFees = fees;
        } else {
          perpFees = tierFees(ladder, ltpTier);
          warnings.push(
            `Perp fees assume the ${ltpFeeTierLabel(ltpTier)} LTP schedule — connect LTP keys to price from your account's own rates.`,
          );
        }
      }

      // --- Fetch plan straight off the grouping the math will redo -------------
      const nowSec = Math.floor(Date.now() / 1000);
      const bookMarketIds: number[] = [];
      const venueBookKeys = new Set<string>();
      for (const plan of groupBorosMarkets(markets, nowSec)) {
        for (const market of plan.markets) {
          bookMarketIds.push(market.marketId);
          venueBookKeys.add(`${normalizeVenue(market.venue)}:${market.base.toUpperCase()}`);
        }
      }

      const borosBooks = new Map<number, BorosOrderBook | null>();
      const venueBooks = new Map<string, NormalizedBook | null>();
      await Promise.all([
        ...(borosEntry === 'market' ? bookMarketIds : []).map(async (marketId) => {
          try {
            const { value } = await deps.cache.get(
              `boros:book:${marketId}`,
              30_000,
              () => fetchBorosOrderBook(fetchImpl, marketId),
              { fresh, staleWhileRevalidate: true },
            );
            borosBooks.set(marketId, value);
          } catch {
            borosBooks.set(marketId, null);
          }
        }),
        // Same `fullbook:VENUE:BASE` namespace as the CrossEx route's fallback
        // books — same fetcher, same data, deliberately shared.
        ...[...venueBookKeys].map(async (key) => {
          // 30 seconds, not TTL.book: this is a SCAN's slippage estimate
          // (settlement cadence is hourly), not the re-peg UI's live price
          // touch — at 2s every 12s poll re-fetched every venue's book and
          // waited on the slowest one.
          const { value } = await deps.cache.get(
            `fullbook:${key}`,
            30_000,
            () => {
              const [venue, base] = key.split(':');
              return fetchVenueBook(venue, base, fallbackQuote(venue));
            },
            { fresh, staleWhileRevalidate: true },
          );
          venueBooks.set(key, value);
        }),
      ]);
      const hlMaxLeverage = await hlMaxLeveragePromise;

      const result = buildLtpOpportunities(
        {
          markets,
          collateralPricesUsd: resolveCollateralPricesUsd(markets),
          borosBooks,
          venueBooks,
          ltpSyms,
          perpFees,
          hlMaxLeverage,
          nowSec,
        },
        {
          notionalUsd,
          borosEntry,
          entryMode,
          exitMode,
          perpLeverage,
          borrowLeverage,
          loanRateApr,
          takerFeeOverride,
        },
      );
      return reply.ok(
        {
          ...result,
          meta: { ...result.meta, ltpTier, tierSource },
          warnings: [...new Set([...warnings, ...result.warnings])],
        },
        { stale },
      );
    });
  };
}
